// node --test ~/.claude/skills/lavish/tools/test/*.test.mjs — fake runners only: no tmux, no osascript, no CLI is spawned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, realpathSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const tmp = mkdtempSync(join(os.tmpdir(), "lavish-agent-test-"));
process.env.LAVISH_AXI_STATE_DIR = tmp;
const A = await import("../lavish-agent.mjs");

/** A fake run(bin, args): records calls, answers from a table of matchers. */
function fakeRun(table = []) {
  const calls = [];
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    for (const [match, reply] of table) if (match(bin, args)) return { code: 0, stdout: "", stderr: "", ...reply };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}
const has = (...words) => (bin, args) => words.every((w) => [bin, ...args].includes(w));

test("tmuxName / shellQuote / argv builders (model + effort, defaults dropped, unknown values ignored)", () => {
  assert.equal(A.tmuxName("claude", "0ddeea83-27b7-4f80"), "mm-claude-0ddeea83");
  assert.equal(A.tmuxName("codex", "01A065A9-e1ec"), "mm-codex-01a065a9");
  assert.equal(A.shellQuote("it's"), `'it'\\''s'`);
  assert.deepEqual(A.claudeResumeArgv("/c", "id1", { model: "fable", effort: "high" }), ["/c", "--resume", "id1", "--model", "fable", "--effort", "high"]);
  assert.deepEqual(A.claudeResumeArgv("/c", "id1", { model: "default", effort: "bogus" }), ["/c", "--resume", "id1"]);
  assert.deepEqual(A.claudeNewArgv("/c", { sessionId: "u1", model: "haiku", effort: "low", prompt: "-x go" }), ["/c", "--session-id", "u1", "--model", "haiku", "--effort", "low", "--", "-x go"]);
  assert.deepEqual(A.codexResumeArgv("/x", "t1", { model: "gpt-6", effort: "xhigh" }), ["/x", "resume", "t1", "-m", "gpt-6", "-c", 'model_reasoning_effort="xhigh"']);
  assert.deepEqual(A.codexResumeArgv("/x", "t1", { effort: "max" }), ["/x", "resume", "t1"]); // max is not a codex level
  assert.deepEqual(A.codexNewArgv("/x", { cwd: "/p", prompt: "hi" }), ["/x", "-C", "/p", "hi"]);
  assert.deepEqual(A.attachScript("mm-claude-abc", "/usr/local/bin/tmux").slice(4, 6), ["-e", `do script "/usr/local/bin/tmux attach -t '=mm-claude-abc'"`]);
  assert.throws(() => A.attachScript("bad name'"), /bad tmux session name/);
  const env = A.childEnv({ PATH: "/usr/bin", CLAUDE_CODE_SESSION_ID: "x", HOME: "/h" });
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined); assert.equal(env.HOME, "/h"); assert.ok(env.PATH.startsWith(join(os.homedir(), ".local/bin")));
});

test("liveClaudeSessions: dead pids and bad JSON skipped; liveCodexThreads from lock files", () => {
  const dir = join(tmp, "sessions"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "1.json"), JSON.stringify({ pid: 1, sessionId: "alive-1", name: "n1", entrypoint: "claude-vscode", cwd: "/a", tmux: "" }));
  writeFileSync(join(dir, "2.json"), JSON.stringify({ pid: 2, sessionId: "dead-2", name: "n2", entrypoint: "cli", cwd: "/b" }));
  writeFileSync(join(dir, "3.json"), "{oops");
  writeFileSync(join(dir, "4.json"), JSON.stringify({ pid: 4, sessionId: "alive-4", name: "n4", entrypoint: "cli", cwd: "/c", tmux: "mm-claude-alive4:@0.%0", status: "idle" }));
  const live = A.liveClaudeSessions(dir, (pid) => pid !== 2);
  assert.deepEqual(live.map((l) => l.sessionId).sort(), ["alive-1", "alive-4"]);
  assert.equal(live.find((l) => l.sessionId === "alive-4").tmux, "mm-claude-alive4:@0.%0");
  const home = join(tmp, "codex"); mkdirSync(join(home, "thread-writer-locks"), { recursive: true });
  writeFileSync(join(home, "thread-writer-locks", "t-1.lock"), ""); writeFileSync(join(home, "thread-writer-locks", "junk.txt"), "");
  assert.deepEqual([...A.liveCodexThreads(home)], ["t-1"]);
  assert.deepEqual([...A.liveCodexThreads(join(tmp, "nope"))], []);
});

test("agentState: none / active / ended, terminal detection through tmux names or the pid file's tmux field", () => {
  const live = { claude: [{ sessionId: "s-live", name: "sm-54", entrypoint: "claude-vscode", tmux: "", status: "idle" }, { sessionId: "s-term", name: "sm-e5", entrypoint: "cli", tmux: "mm-claude-sterm:@10.%10", status: "idle" }], codex: new Set(["c-live"]) };
  assert.equal(A.agentState({}, live).state, "none");
  const a = A.agentState({ agent: { provider: "claude", id: "s-live", name: "sm-54", cwd: "/p", source: "poll" } }, live, new Set());
  assert.equal(a.state, "active"); assert.equal(a.terminal, false); assert.equal(a.entrypointLabel, "VS Code"); assert.equal(a.tmuxName, "mm-claude-slive");
  assert.equal(A.agentState({ agent: { provider: "claude", id: "s-live", cwd: "/p", source: "scan" } }, live).name, "sm-54", "a live session's name comes from its pid file even when the stamp (a scan) had none");
  const t = A.agentState({ agent: { provider: "claude", id: "s-term", name: "sm-e5", cwd: "/p" } }, live, new Set(["mm-claude-sterm"]));
  assert.equal(t.state, "active"); assert.equal(t.terminal, true); assert.equal(t.tmuxName, "mm-claude-sterm");
  const e = A.agentState({ agent: { provider: "claude", id: "s-gone", cwd: "/p" } }, live, new Set());
  assert.equal(e.state, "ended"); assert.equal(e.terminal, false); assert.equal(e.name, "sgone");
  assert.equal(A.agentState({ agent: { provider: "codex", id: "c-live", cwd: "/p" } }, live).state, "active");
  assert.equal(A.agentState({ agent: { provider: "codex", id: "c-old", cwd: "/p" } }, live).state, "ended");
});

test("decideResume: every branch of section 4's tree is a value; a live editor session is refused, never resumed", () => {
  const st = (o) => ({ state: "active", provider: "claude", id: "x", name: "sm-54", entrypointLabel: "VS Code", terminal: false, cwd: "/p", tmuxName: "mm-claude-x", ...o });
  assert.match(A.decideResume(null).error, /No agent has polled/);
  const lv = A.decideResume(st({})); assert.equal(lv.action, "lavish"); assert.match(lv.note, /live in VS Code/);
  assert.equal(A.decideResume(st({ terminal: true }), { clients: ["/dev/ttys001"] }).action, "activate");
  assert.equal(A.decideResume(st({ terminal: true }), { clients: [] }).action, "attach");
  assert.match(A.decideResume(st({ provider: "codex", name: "01a065a9" })).error, /open in the Codex app/);
  assert.match(A.decideResume(st({ state: "ended" }), { cwdExists: false }).error, /Folder missing: \/p/);
  assert.equal(A.decideResume(st({ state: "ended" }), { cwdExists: true }).action, "resume");
});

test("paneIdle: the prompt row within the last lines, not a status bar or a running tool", () => {
  assert.equal(A.paneIdle("Brewed for 1m 27s · done\n─────\n❯ merge 548\n─────\n  auto mode on · 3 agents"), true);
  assert.equal(A.paneIdle("> \n? for shortcuts"), true);
  assert.equal(A.paneIdle("› type a message"), true);
  assert.equal(A.paneIdle("Running npm test…\n  ✓ 12 passed\n  Thinking"), false);
  assert.equal(A.paneIdle(null), false);
  assert.equal(A.paneIdle(""), false);
});

test("tmux helpers over a fake runner: scrub, new-session argv, list, clients, sendText, capture", async () => {
  const { run, calls } = fakeRun([
    [has("show-environment"), { stdout: "CLAUDE_CODE_SESSION_ID=abc\nPATH=/x\n-CLAUDE_GONE\nCLAUDECODE=1\n" }],
    [has("list-sessions"), { stdout: "mm-claude-aaaa\nmm-codex-bbbb\n" }],
    [has("list-clients"), { stdout: "/dev/ttys004\n" }],
    [has("capture-pane"), { stdout: "line1\n❯ \n" }],
  ]);
  const o = { run, bin: "/t", enterDelayMs: 1 };
  assert.deepEqual(await A.scrubClaudeEnv(o), ["CLAUDE_CODE_SESSION_ID", "CLAUDECODE"]);
  const r = await A.newTmuxSession("mm-claude-aaaa", "/p", ["/c", "--resume", "id 1"], o);
  assert.equal(r.ok, true);
  const ns = calls.find((c) => c.includes("new-session"));
  assert.deepEqual(ns, ["/t", "new-session", "-d", "-s", "mm-claude-aaaa", "-x", "160", "-y", "48", "-c", "/p", "'/c' '--resume' 'id 1'"]);
  assert.deepEqual([...await A.listTmux(o)], ["mm-claude-aaaa", "mm-codex-bbbb"]);
  assert.deepEqual(await A.listClients("mm-claude-aaaa", o), ["/dev/ttys004"]);
  assert.equal((await A.sendText("mm-claude-aaaa", "/effort high", o)).ok, true);
  const seq = calls.filter((c) => ["set-buffer", "paste-buffer", "send-keys"].includes(c[1]));
  assert.deepEqual(seq, [["/t", "set-buffer", "-b", "mm-claude-aaaa", "--", "/effort high"], ["/t", "paste-buffer", "-p", "-d", "-b", "mm-claude-aaaa", "-t", "=mm-claude-aaaa:"], ["/t", "send-keys", "-t", "=mm-claude-aaaa:", "Enter"]]);
  assert.equal(A.paneIdle(await A.capturePane("mm-claude-aaaa", 5, o)), true);
  // failures are values
  const bad = fakeRun([[has("new-session"), { code: 1, stderr: "duplicate session: mm-claude-aaaa\n" }]]);
  assert.deepEqual(await A.newTmuxSession("mm-claude-aaaa", "/p", ["/c"], { run: bad.run }), { ok: false, error: "duplicate session: mm-claude-aaaa" });
  const missing = fakeRun([[() => true, { code: -1, stderr: "/t not found" }]]);
  assert.equal(await A.hasTmux({ run: missing.run, bin: "/t" }), false);
  assert.deepEqual([...await A.listTmux({ run: missing.run })], []);
});

test("resumeAgent: live editor session → refused, nothing spawned; ended → exact new-session argv, attach, terminals.json; duplicate → activate", async () => {
  const bin = join(tmp, "claude"); writeFileSync(bin, "#!/bin/sh\n"); // exists
  const cwd = join(tmp, "proj"); mkdirSync(cwd, { recursive: true });
  const tpath = join(tmp, "terminals.json");
  const reg = { agent: { provider: "claude", id: "abcd1234-ffff", name: "sm-54", cwd, entrypoint: "claude-vscode", source: "poll" } };
  const liveEditor = { claude: [{ sessionId: "abcd1234-ffff", name: "sm-54", entrypoint: "claude-vscode", tmux: "" }], codex: new Set() };
  const f1 = fakeRun();
  const refused = await A.resumeAgent(reg, "k1", {}, { run: f1.run, live: liveEditor, tmuxNames: new Set(), claudeBin: bin, terminalsPath: tpath });
  assert.equal(refused.ok, true); assert.equal(refused.action, "lavish"); assert.match(refused.note, /live in VS Code/);
  assert.equal(f1.calls.filter((c) => c.includes("new-session")).length, 0, "nothing spawned for a live session");
  const f2 = fakeRun([[has("-V"), { stdout: "tmux 3.7" }]]);
  const ended = await A.resumeAgent(reg, "k1", { model: "fable", effort: "high" }, { run: f2.run, live: { claude: [], codex: new Set() }, tmuxNames: new Set(), claudeBin: bin, terminalsPath: tpath, osascriptBin: "/osa" });
  assert.equal(ended.ok, true); assert.equal(ended.action, "resume"); assert.equal(ended.tmuxName, "mm-claude-abcd1234");
  const ns = f2.calls.find((c) => c.includes("new-session"));
  assert.equal(ns.at(-1), `'${bin}' '--resume' 'abcd1234-ffff' '--model' 'fable' '--effort' 'high'`);
  assert.equal(ns[ns.indexOf("-c") + 1], realpathSync(cwd)); // /var → /private/var on macOS, as the CLI records it
  assert.ok(f2.calls.some((c) => c[0] === "/osa" && c.some((x) => String(x).includes("attach -t '=mm-claude-abcd1234'"))), "Terminal.app attach");
  const rows = A.readTerminals(tpath);
  assert.equal(rows[0].tmuxName, "mm-claude-abcd1234"); assert.equal(rows[0].sessionId, "abcd1234-ffff"); assert.equal(rows[0].model, "fable"); assert.equal(rows[0].planKey, "k1");
  const f3 = fakeRun([[has("-V"), { stdout: "tmux 3.7" }], [has("new-session"), { code: 1, stderr: "duplicate session: mm-claude-abcd1234" }]]);
  const dup = await A.resumeAgent(reg, "k1", {}, { run: f3.run, live: { claude: [], codex: new Set() }, tmuxNames: new Set(), claudeBin: bin, terminalsPath: tpath });
  assert.equal(dup.ok, true); assert.equal(dup.action, "activate"); assert.match(dup.note, /already running in terminal/);
  const gone = await A.resumeAgent({ agent: { ...reg.agent, cwd: join(tmp, "missing") } }, "k1", {}, { run: f2.run, live: { claude: [], codex: new Set() }, tmuxNames: new Set(), claudeBin: bin });
  assert.match(gone.error, /Folder missing/);
  const noBin = await A.resumeAgent(reg, "k1", {}, { run: f2.run, live: { claude: [], codex: new Set() }, tmuxNames: new Set(), claudeBin: join(tmp, "nope") });
  assert.match(noBin.error, /nope not found/);
  // live in tmux with a client: activate only
  const f4 = fakeRun();
  const act = await A.resumeAgent(reg, "k1", {}, { run: f4.run, live: { claude: [{ sessionId: "abcd1234-ffff", name: "sm-54", entrypoint: "cli", tmux: "mm-claude-abcd1234:@0.%0" }], codex: new Set() }, tmuxNames: new Set(["mm-claude-abcd1234"]), clients: async () => ["/dev/ttys1"], claudeBin: bin });
  assert.equal(act.action, "activate"); assert.equal(f4.calls.filter((c) => c.includes("new-session")).length, 0);
});

test("startNewAgent: Claude gets a chosen UUID and the plan prompt; Codex gets -C cwd; missing folder refused", async () => {
  const bin = join(tmp, "claude2"); writeFileSync(bin, "");
  const cwd = join(tmp, "proj2"); mkdirSync(cwd, { recursive: true });
  const f = fakeRun([[has("-V"), { stdout: "tmux" }]]);
  const r = await A.startNewAgent({ provider: "claude", cwd, planPath: "/p/plan.html", planKey: "k9", model: "sonnet", effort: "medium" }, { run: f.run, claudeBin: bin, sessionId: "11111111-2222", terminalsPath: join(tmp, "t2.json") });
  assert.equal(r.ok, true); assert.equal(r.tmuxName, "mm-claude-11111111"); assert.equal(r.agent.id, "11111111-2222"); assert.equal(r.agent.source, "home");
  const ns = f.calls.find((c) => c.includes("new-session"));
  assert.ok(ns.at(-1).startsWith(`'${bin}' '--session-id' '11111111-2222' '--model' 'sonnet' '--effort' 'medium' '--' 'Open the plan /p/plan.html in Lavish`));
  const cx = await A.startNewAgent({ provider: "codex", cwd, planPath: "/p/plan.html", prompt: "hello" }, { run: f.run, codexBin: bin, now: 0x1234abcd, terminalsPath: join(tmp, "t2.json") });
  assert.equal(cx.ok, true); assert.equal(cx.tmuxName, "mm-codex-1234abcd"); assert.equal(cx.agent, null);
  assert.ok(f.calls.find((c) => c.includes("new-session") && c.at(-1) === `'${bin}' '-C' '${realpathSync(cwd)}' 'hello'`));
  assert.match((await A.startNewAgent({ cwd: join(tmp, "zz"), planPath: "/p" }, { run: f.run })).error, /Folder missing/);
});

test("scan: a Read target counts, a Bash mention does not; bounded to the project folder and 7 days; grep prefilters; Codex by folder", async () => {
  const root = join(tmp, "projects"); const cwd = "/Users/me/Dev/Proj";
  const dir = A.claudeProjectDir(cwd, root); mkdirSync(dir, { recursive: true });
  assert.equal(dir, join(root, "-Users-me-Dev-Proj"));
  const plan = join(tmp, "docs", "plans", "2026-09-04-x.html"); mkdirSync(join(tmp, "docs", "plans"), { recursive: true }); writeFileSync(plan, "<p>");
  const line = (sessionId, tool, input, ts) => JSON.stringify({ sessionId, timestamp: ts, message: { content: [{ type: "tool_use", name: tool, input }] } });
  writeFileSync(join(dir, "s-read.jsonl"), [line("s-read", "Read", { file_path: plan }, "2026-09-04T10:00:00Z"), line("s-read", "Bash", { command: `cat ${plan}` }, "2026-09-04T11:00:00Z")].join("\n"));
  writeFileSync(join(dir, "s-bash.jsonl"), line("s-bash", "Bash", { command: `open ${plan}` }, "2026-09-04T12:00:00Z"));
  writeFileSync(join(dir, "s-edit.jsonl"), line("s-edit", "Edit", { file_path: "docs/plans/2026-09-04-x.html" }, "2026-09-04T13:00:00Z"));
  writeFileSync(join(dir, "s-other.jsonl"), line("s-other", "Read", { file_path: "/elsewhere/2026-09-04-y.html" }, "2026-09-04T14:00:00Z"));
  writeFileSync(join(dir, "s-old.jsonl"), line("s-old", "Read", { file_path: plan }, "2026-08-01T10:00:00Z"));
  const old = Date.now() - 30 * 864e5; utimesSync(join(dir, "s-old.jsonl"), old / 1000, old / 1000);
  // fake grep: real filtering on content, so the prefilter is exercised without /usr/bin/grep
  const grepped = [];
  const run = async (bin, args) => { const dd = args.indexOf("--"); const needles = args.includes("-e") ? args.slice(0, dd).filter((x, i, a) => a[i - 1] === "-e") : [args[dd + 1]]; const files = args.includes("-e") ? args.slice(dd + 1) : args.slice(dd + 2); grepped.push(files.length); return { code: 0, stdout: files.filter((f) => { try { const txt = await0(f); return needles.some((n) => txt.includes(n)); } catch { return false; } }).join("\n"), stderr: "" }; };
  const { readFileSync } = await import("node:fs"); const await0 = (f) => readFileSync(f, "utf8");
  const found = await A.scanTranscripts(plan, cwd, { run, projectsRoot: root, codexRoot: join(tmp, "no-codex") });
  assert.deepEqual(found.map((x) => x.id), ["s-edit", "s-read"], "newest first; Bash-only and other-file sessions excluded; 30-day-old file skipped");
  assert.equal(grepped[0], 4, "only files in the 7-day window reach grep");
  assert.equal(found[0].tool, "Edit");
  // Codex rollout in the same folder that mentions the file
  const codexRoot = join(tmp, "codex2"); const day = join(codexRoot, "sessions", "2026", "09", "04"); mkdirSync(day, { recursive: true });
  writeFileSync(join(day, "rollout-a.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "cx-1", cwd: cwd + "/sub" } }) + "\n" + JSON.stringify({ text: `sed -n 1,5p ${plan}` }) + "\n");
  writeFileSync(join(day, "rollout-b.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "cx-2", cwd: "/elsewhere" } }) + "\n" + plan + "\n");
  const withCodex = await A.scanTranscripts(plan, cwd, { run, projectsRoot: root, codexRoot });
  assert.ok(withCodex.some((x) => x.id === "cx-1" && x.provider === "codex" && x.guessed === true));
  assert.ok(!withCodex.some((x) => x.id === "cx-2"));
  assert.equal(A.scanLine("no mention here", plan), null);
  // the batch form: one pass for several plans of the same folder
  const plan2 = join(tmp, "docs", "plans", "2026-09-05-z.html"); writeFileSync(plan2, "<p>");
  writeFileSync(join(dir, "s-z.jsonl"), line("s-z", "Write", { file_path: plan2 }, "2026-09-05T09:00:00Z"));
  const many = await A.scanTranscriptsMany([{ key: "k1", path: plan }, { key: "k2", path: plan2 }], cwd, { run, projectsRoot: root, codexRoot });
  assert.deepEqual(many.k1.filter((x) => x.provider === "claude").map((x) => x.id), ["s-edit", "s-read"]); assert.ok(many.k1.some((x) => x.id === "cx-1"));
  assert.deepEqual(many.k2.map((x) => x.id), ["s-z"]);
});

test("recordTerminal: newest first, deduped by tmux name, Manager Marcus's row shape", () => {
  const p = join(tmp, "t3.json");
  A.recordTerminal({ tmuxName: "mm-claude-a", provider: "claude", sessionId: "a-1", cwd: "/p", createdAt: 1 }, p);
  A.recordTerminal({ tmuxName: "mm-codex-b", provider: "codex", sessionId: null, cwd: "/p", createdAt: 2, effort: "high" }, p);
  A.recordTerminal({ tmuxName: "mm-claude-a", provider: "claude", sessionId: "a-1", cwd: "/p", createdAt: 3 }, p);
  const rows = A.readTerminals(p);
  assert.deepEqual(rows.map((r) => r.tmuxName), ["mm-claude-a", "mm-codex-b"]);
  assert.equal(rows[0].createdAt, 3); assert.equal(rows[1].effort, "high"); assert.equal(rows[0].startedBy, "lavish-home");
});
