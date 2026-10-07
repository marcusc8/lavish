// node --test ~/.claude/skills/review-changes/tools/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "review-checklist.mjs");
const tmp = mkdtempSync(join(os.tmpdir(), "review-handoff-"));
const state = join(tmp, "state");
const repo = join(tmp, "repo");
const git = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const run = (args, cwd = repo) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, LAVISH_AXI_STATE_DIR: state } });

// a repo: main with two commits, a feature branch with one more, one of them merged
mkdirSync(repo);
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "a.txt"), "a"); git("add", "a.txt"); git("commit", "-qm", "one");
const base = git("rev-parse", "HEAD").stdout.trim();
writeFileSync(join(repo, "b.txt"), "b"); git("add", "b.txt"); git("commit", "-qm", "two");
const onMain = git("rev-parse", "HEAD").stdout.trim();
git("checkout", "-qb", "feat/x");
writeFileSync(join(repo, "c.txt"), "c"); git("add", "c.txt"); git("commit", "-qm", "three");
const onBranch = git("rev-parse", "HEAD").stdout.trim();
git("checkout", "-q", "main");

test("landed: exit 0 and 'landed' when the range's end is on main; exit 3 and 'not landed' otherwise", () => {
  const yes = run(["landed", "--range", `${base}..${onMain}`]);
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /landed: yes .* is on main/);
  const no = run(["landed", "--range", `${base}..${onBranch}`]);
  assert.equal(no.status, 3);
  assert.match(no.stdout, /landed: no .* is not on main/);
  const bad = run(["landed", "--range", "nope..nope"]);
  assert.notEqual(bad.status, 0);
});

test("handoff: writes docs/reviews/<date>-<slug>-HANDOFF.md with the open rows, the plan path and a resume prompt", () => {
  mkdirSync(join(repo, ".lavish"));
  copyFileSync(join(here, "fixtures/phase-6-polish.html"), join(repo, ".lavish/plan.html"));
  writeFileSync(join(repo, "m.md"), "route: /history\nbase: http://localhost:5173\n\nCHECKS\n  C1  a  do: x → expect: y\n  C2  b  do: p → expect: q\n\nRESULT\n  C1  a  PASS\n");
  assert.equal(run(["build", "--plan", ".lavish/plan.html", "--manifest", "m.md", "--group", "PR #3", "--session", "three"]).status, 0);
  const key = createHash("sha256").update(realpathSync(join(repo, ".lavish/plan.html"))).digest("hex").slice(0, 16);
  mkdirSync(join(state, "history"), { recursive: true });
  writeFileSync(join(state, "history", `${key}.jsonl`), [
    JSON.stringify({ key, role: "user", kind: "annotation", tag: "p", text: "Nothing on C2.", where: "C2 · q", selector: "li#rv-pr-3-C2 > div > p" }),
    JSON.stringify({ key, role: "agent", kind: "reply", replyTo: 1, text: "↳ Re “Nothing on C2.”: Reproduced, still looking." }),
    JSON.stringify({ key, role: "agent", kind: "reply", text: "Got 1 item." }),
  ].join("\n") + "\n");
  const r = run(["handoff", "--plan", ".lavish/plan.html", "--date", "2026-09-02"]);
  assert.equal(r.status, 0, r.stderr);
  const out = join(repo, "docs/reviews/2026-09-02-plan-HANDOFF.md");
  assert.match(r.stdout, /docs\/reviews\/2026-09-02-plan-HANDOFF\.md/);
  assert.ok(existsSync(out));
  const md = readFileSync(out, "utf8");
  assert.match(md, /^# HANDOFF — review of \.lavish\/plan\.html \(2026-09-02\)/);
  assert.match(md, /## Open rows\n[\s\S]*- \*\*PR #3 · C2\*\* — q[\s\S]*you r1: Nothing on C2\.[\s\S]*agent r1: Reproduced, still looking\./);
  assert.doesNotMatch(md, /\*\*PR #3 · C1\*\*/);
  assert.match(md, /## Resume\n[\s\S]*review-checklist build --plan \.lavish\/plan\.html --manifest m\.md --group "PR #3"/);
  assert.match(md, /lavish-poll \.lavish\/plan\.html/);
  assert.match(md, /Round 1 so far/);
});

test("handoff --launch: posts the hand-off as the prompt to Manager Marcus's launch endpoint (mode terminal) and prints the terminal name", async () => {
  const { createServer } = await import("node:http");
  const seen = [];
  const srv = createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { seen.push({ url: req.url, body: JSON.parse(b) }); res.writeHead(202, { "content-type": "application/json" }); res.end(JSON.stringify({ provider: "claude", id: "abc", terminal: "mm-claude-abc12345", terminalOpened: true })); }); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  // spawnSync would block this process, and with it the fake server; run the CLI asynchronously
  const { spawn } = await import("node:child_process");
  const r = await new Promise((done) => {
    const c = spawn(process.execPath, [CLI, "handoff", "--plan", ".lavish/plan.html", "--date", "2026-09-02", "--launch", "--mm", `http://127.0.0.1:${port}`, "--model", "opus", "--effort", "high"], { cwd: repo, env: { ...process.env, LAVISH_AXI_STATE_DIR: state } });
    let stdout = "", stderr = ""; c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => done({ status, stdout, stderr }));
  });
  srv.close();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/api/sessions");
  assert.equal(seen[0].body.provider, "claude");
  assert.equal(seen[0].body.mode, "terminal");
  assert.equal(realpathSync(seen[0].body.cwd), realpathSync(repo));
  assert.equal(seen[0].body.model, "opus");
  assert.equal(seen[0].body.effort, "high");
  assert.match(seen[0].body.prompt, /^Resume the review of \.lavish\/plan\.html/);
  assert.match(seen[0].body.prompt, /docs\/reviews\/2026-09-02-plan-HANDOFF\.md/);
  assert.match(seen[0].body.prompt, /\*\*PR #3 · C2\*\*/);
  assert.match(seen[0].body.prompt, /review-changes skill/);
  assert.match(r.stdout, /launched claude in tmux mm-claude-abc12345 · Terminal window opened/);
});

test("handoff --launch: a refused or unreachable launch endpoint leaves the hand-off file and exits 1 with the reason", async () => {
  const { createServer } = await import("node:http");
  const s = createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const port = s.address().port; await new Promise((r) => s.close(r));
  const r = run(["handoff", "--plan", ".lavish/plan.html", "--date", "2026-09-02", "--launch", "--mm", `http://127.0.0.1:${port}`, "--timeout-ms", "3000"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /launch failed/);
  assert.ok(existsSync(join(repo, "docs/reviews/2026-09-02-plan-HANDOFF.md")));
});
