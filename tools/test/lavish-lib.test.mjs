// node --test ~/.claude/skills/lavish/tools/test/
// Runs against a throwaway state dir, so it never touches ~/.lavish-axi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const tmp = mkdtempSync(join(os.tmpdir(), "lavish-lib-test-"));
process.env.LAVISH_AXI_STATE_DIR = tmp;
const lib = await import("../lavish-lib.mjs");

test("extractText: one line per block, scripts/styles/comments dropped, entities decoded", () => {
  const lines = lib.extractText(`<html><head><title>T</title><style>p{color:red}</style></head><body>
    <h1>Hello &amp; welcome</h1><!-- hidden --><p>one</p><p>two<br>three</p><script>x("</p>")</script>
    <table><tr><td>c1</td><td>c2 &mdash; d</td></tr></table></body></html>`);
  assert.deepEqual(lines, ["T", "Hello & welcome", "one", "two", "three", "c1", "c2 — d"]);
});

test("diffLines: aligned LCS diff with untouched prefix and suffix", () => {
  const ops = lib.diffLines(["a", "b", "c", "d", "e"], ["a", "x", "c", "e", "f"]);
  assert.equal(ops.map((o) => ({ same: " ", add: "+", del: "-" })[o.type] + o.text).join(" "), " a -b +x  c -d  e +f");
  assert.deepEqual(lib.diffLines(["same"], ["same"]), [{ type: "same", text: "same" }]);
  assert.deepEqual(lib.diffLines([], ["n"]), [{ type: "add", text: "n" }]);
});

test("extractPrMentions: GitHub numbers only, plan slice labels ignored", () => {
  const got = [...lib.extractPrMentions(["PR #529 and #530 landed; PR3 and PR 8 are plan slices; (#536) squash; see PR 540; docs/plans/#12"])].sort();
  assert.deepEqual(got, [529, 530, 536, 540]);
});

test("readHead: title, lavish meta, description fallback to the lede", () => {
  const f = join(tmp, "plan.html");
  writeFileSync(f, `<!doctype html><html><head><title>My &amp; Plan</title>
    <meta name="lavish:project" content="Proj"><meta name="lavish:status" content="shipped"><meta name="lavish:pr" content="#12, 34">
    </head><body><h1>Title</h1><p class="lede">The lede <b>paragraph</b> here.</p></body></html>`);
  const h = lib.readHead(f);
  assert.equal(h.title, "My & Plan");
  assert.equal(h.project, "Proj");
  assert.equal(h.status, "shipped");
  assert.deepEqual(h.prs, [12, 34]);
  assert.equal(h.summary, "The lede paragraph here.");
});

test("snapshotVersion: dedupes by content, numbers sequentially, labels the latest", () => {
  const f = join(tmp, "artifact.html");
  const key = lib.keyOf(f);
  writeFileSync(f, "<p>v1</p>");
  assert.deepEqual(lib.snapshotVersion(f, key, { reason: "baseline" }), { created: true, n: 1 });
  assert.deepEqual(lib.snapshotVersion(f, key, { reason: "poll" }), { created: false, n: 1 });
  writeFileSync(f, "<p>v2</p>");
  assert.deepEqual(lib.snapshotVersion(f, key, { reason: "agent-reply", label: "round 1", round: 1 }), { created: true, n: 2 });
  const idx = lib.readVersionIndex(key);
  assert.equal(idx.versions.length, 2);
  assert.equal(idx.versions[1].label, "round 1");
  assert.equal(idx.versions[1].round, 1);
  assert.ok(existsSync(lib.versionPath(key, 1)) && existsSync(lib.versionPath(key, 2)));
  assert.equal(readFileSync(lib.versionPath(key, 1), "utf8"), "<p>v1</p>");
});

test("registry: statuses validated, PRs declared and merged with lookups", () => {
  const key = "0123456789abcdef";
  lib.updateRegistry(key, { status: "in-progress", addPrs: [529, 530] });
  assert.throws(() => lib.updateRegistry(key, { status: "bogus" }), /unknown status/);
  lib.updateRegistry(key, { prs: { 529: { state: "MERGED", title: "x" } }, removePrs: [530] });
  const rec = lib.readRegistry()[key];
  assert.equal(rec.status, "in-progress");
  assert.deepEqual(Object.keys(rec.prs), ["529"]);
  assert.equal(rec.prs[529].state, "MERGED");
  assert.equal(rec.prs[529].source, "declared");
});

test("notes: round-trip through the notes file", () => {
  const key = "fedcba9876543210";
  assert.deepEqual(lib.readNotes(key).notes, []);
  lib.writeNotes(key, [{ id: "a", state: "private", body: "hi" }]);
  assert.equal(lib.readNotes(key).notes[0].body, "hi");
});

test("normalizeStatus: old names and loose spellings map onto the lifecycle", () => {
  assert.equal(lib.normalizeStatus("draft"), "not-started");
  assert.equal(lib.normalizeStatus("Shipped"), "merged");
  assert.equal(lib.normalizeStatus("parked"), "retired");
  assert.equal(lib.normalizeStatus("Not started"), "not-started");
  assert.equal(lib.normalizeStatus("in_progress"), "in-progress");
  assert.equal(lib.normalizeStatus(""), "");
  lib.updateRegistry("aaaaaaaaaaaaaaaa", { status: "shipped", priority: "high" });
  assert.equal(lib.readRegistry().aaaaaaaaaaaaaaaa.status, "merged");
  assert.equal(lib.readRegistry().aaaaaaaaaaaaaaaa.priority, "high");
  assert.throws(() => lib.updateRegistry("aaaaaaaaaaaaaaaa", { priority: "urgent" }), /unknown priority/);
});

test("queue mirror: round-trip, malformed file, idempotent delete", () => {
  const key = "1111111111111111";
  assert.deepEqual(lib.readQueue(key).items, []);
  lib.writeQueue(key, { items: [{ tag: "p", prompt: "x" }], files: { a: { id: "b", url: "u", name: "n" } }, draft: { card: { selector: "h1", text: "d" } }, sent: [{ sig: "s", at: "t" }] });
  const q = lib.readQueue(key);
  assert.equal(q.items.length, 1); assert.equal(q.files.a.id, "b"); assert.equal(q.draft.card.text, "d"); assert.equal(q.sent[0].sig, "s"); assert.ok(q.at);
  writeFileSync(lib.queuePath(key), "{not json");
  assert.deepEqual(lib.readQueue(key), { v: 1, at: "", by: "", items: [], files: {}, draft: null, sent: [] });
  lib.deleteQueue(key); lib.deleteQueue(key);
  assert.equal(existsSync(lib.queuePath(key)), false);
});

test("stageOf: every status maps onto a stage", () => {
  const map = Object.fromEntries(lib.STATUSES.map((s) => [s, lib.stageOf(s).stage]));
  assert.deepEqual(map, { "not-started": "planning", "in-review": "planning", approved: "planning", "in-progress": "developing", merged: "review", implemented: "done", retired: "parked", superseded: "parked" });
  assert.equal(lib.stageOf("shipped").stage, "review");
  assert.equal(lib.stageOf("").stage, "planning");
  assert.equal(lib.subLabelOf("in-progress", [{ state: "MERGED" }, { state: "OPEN" }, {}]), "1 of 3 PRs merged, 1 open");
});

test("updateRegistry: progress log gets automatic and explicit entries with the session", () => {
  const key = "2222222222222222";
  const session = { label: "feat/x@mac", branch: "feat/x", host: "mac", cwd: "/tmp" };
  lib.updateRegistry(key, { status: "in-progress", addPrs: [10], session });
  lib.updateRegistry(key, { status: "in-progress", session }); // unchanged: no entry
  lib.updateRegistry(key, { progress: "PR 10 opened", pct: 25, session });
  const rec = lib.readRegistry()[key];
  assert.deepEqual(rec.progress.map((e) => e.kind), ["status", "pr", "note"]);
  assert.equal(rec.progress[2].pct, 25);
  assert.equal(rec.progress[2].session.label, "feat/x@mac");
  assert.equal(rec.session.label, "feat/x@mac");
  const sum = lib.progressSummary(rec, [{ n: 10, source: "declared", state: "OPEN" }]);
  assert.equal(sum.pct, 25); assert.equal(sum.latest.text, "PR 10 opened"); assert.equal(sum.count, 3);
  for (let i = 0; i < 310; i++) lib.updateRegistry(key, { progress: "n" + i });
  assert.equal(lib.readRegistry()[key].progress.length, lib.MAX_PROGRESS);
});

test("sessionInfo: label falls back to branch@host and accepts an override", () => {
  const s = lib.sessionInfo("", os.tmpdir());
  assert.ok(s.label.includes("@")); assert.ok(s.host);
  assert.equal(lib.sessionInfo("custom", os.tmpdir()).label, "custom");
});

/* ── T1: agent stamp ─────────────────────────────────────────────────────── */
import { mkdirSync, utimesSync } from "node:fs";
test("agentInfo: Claude session from the environment, with its name from the pid file", () => {
  const dir = join(tmp, "claude-sessions"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "123.json"), JSON.stringify({ pid: 123, sessionId: "aaaa-1", name: "stylemanager-2-0-54", entrypoint: "claude-vscode", cwd: "/x" }));
  writeFileSync(join(dir, "bad.json"), "{not json");
  const a = lib.agentInfo({ CLAUDE_CODE_SESSION_ID: "aaaa-1", CLAUDE_CODE_ENTRYPOINT: "claude-vscode" }, tmp, { claudeSessionsDir: dir });
  assert.equal(a.provider, "claude"); assert.equal(a.id, "aaaa-1"); assert.equal(a.entrypoint, "claude-vscode"); assert.equal(a.name, "stylemanager-2-0-54");
  assert.equal(lib.agentInfo({ CLAUDE_CODE_SESSION_ID: "zzzz" }, tmp, { claudeSessionsDir: dir }).name, "");
});

test("resolveCodexThread: newest live rollout for the folder; guessed when several; none without a lock", () => {
  const home = join(tmp, "codex"); const cwd = join(tmp, "proj"); const other = join(tmp, "other");
  mkdirSync(cwd, { recursive: true }); mkdirSync(other, { recursive: true });
  const day = join(home, "sessions", "2026", "09", "04"); mkdirSync(day, { recursive: true });
  mkdirSync(join(home, "thread-writer-locks"), { recursive: true });
  const rollout = (name, id, dir, extra = "") => writeFileSync(join(day, name), JSON.stringify({ type: "session_meta", payload: { id, cwd: dir } }) + "\n" + extra);
  rollout("rollout-2026-09-04T10-00-00-old.jsonl", "id-old", cwd);
  rollout("rollout-2026-09-04T11-00-00-new.jsonl", "id-new", cwd);
  rollout("rollout-2026-09-04T12-00-00-other.jsonl", "id-other", other);
  rollout("rollout-2026-09-04T13-00-00-dead.jsonl", "id-dead", cwd); // no lock: not live
  writeFileSync(join(day, "rollout-2026-09-04T14-00-00-junk.jsonl"), "not json\n");
  const now = Date.parse("2026-09-05T00:00:00Z");
  assert.equal(lib.resolveCodexThread(cwd, { home, now }), null); // nothing locked yet
  writeFileSync(join(home, "thread-writer-locks", "id-new.lock"), "");
  const one = lib.resolveCodexThread(cwd, { home, now });
  assert.equal(one.id, "id-new"); assert.equal(one.provider, "codex"); assert.equal(one.guessed, undefined);
  writeFileSync(join(home, "thread-writer-locks", "id-old.lock"), "");
  const fut = Date.now() + 5000;
  utimesSync(join(day, "rollout-2026-09-04T11-00-00-new.jsonl"), fut / 1000, fut / 1000); // newest by mtime
  const two = lib.resolveCodexThread(cwd, { home, now });
  assert.equal(two.id, "id-new"); assert.equal(two.guessed, true);
  assert.equal(lib.resolveCodexThread(join(tmp, "nowhere"), { home, now }), null);
  const viaInfo = lib.agentInfo({}, cwd, { codex: { home, now } });
  assert.equal(viaInfo.provider, "codex"); assert.equal(viaInfo.id, "id-new");
  assert.equal(lib.agentInfo({}, cwd, { codex: { home: join(tmp, "no-codex"), now } }), null);
});

test("updateRegistry agent: latest + list (dedupe, newest first, cap), no updatedAt bump on an unchanged id, scan never displaces a stamp", async () => {
  const tick = () => new Promise((r) => setTimeout(r, 3)); // updatedAt has ms resolution
  const key = "3333333333333333";
  const stamp = (id, extra = {}) => lib.updateRegistry(key, { agent: { provider: "claude", id, cwd: "/p", entrypoint: "claude-vscode", source: "poll", ...extra } });
  lib.updateRegistry(key, { status: "in-review" });
  const before = lib.readRegistry()[key].updatedAt; await tick();
  const r1 = stamp("s1");
  assert.equal(r1.agent.id, "s1"); assert.equal(r1.agent.source, "poll"); assert.equal(r1.agents.length, 1);
  assert.notEqual(r1.updatedAt, before, "a NEW agent id bumps updatedAt");
  const at1 = r1.updatedAt; await tick();
  const r2 = stamp("s1");
  assert.equal(r2.updatedAt, at1, "the same id does not bump updatedAt");
  assert.equal(r2.progress.length, 1, "no progress entry for a stamp");
  stamp("s2"); stamp("s1");
  const r3 = lib.readRegistry()[key];
  assert.deepEqual(r3.agents.map((a) => a.id), ["s1", "s2"], "dedupe by id, newest first");
  for (let i = 0; i < 15; i++) stamp("x" + i);
  assert.equal(lib.readRegistry()[key].agents.length, lib.MAX_AGENTS);
  // a scan result joins the list but does not displace the stamped agent
  const r4 = lib.updateRegistry(key, { agent: { provider: "claude", id: "scanned", cwd: "/p", entrypoint: "", source: "scan" } });
  assert.equal(r4.agent.id, "x14"); assert.ok(r4.agents.some((a) => a.id === "scanned" && a.source === "scan"));
  // but a scan on a plan with no stamp becomes the agent, and a later poll replaces it
  const k2 = "4444444444444444";
  lib.updateRegistry(k2, { agent: { provider: "codex", id: "c1", cwd: "/p", source: "scan" } });
  assert.equal(lib.readRegistry()[k2].agent.source, "scan");
  lib.updateRegistry(k2, { agent: { provider: "claude", id: "s9", cwd: "/p", source: "poll" } });
  assert.equal(lib.readRegistry()[k2].agent.id, "s9");
  assert.equal(lib.agentLabel({ id: "0ddeea83-27b7", name: "" }), "0ddeea83"); assert.equal(lib.agentLabel({ id: "x", name: "mm-2a" }), "mm-2a");
});


/* ── T3: home layout (folders) ───────────────────────────────────────────── */
test("layout: create, rename, move with a cycle guard, file plans, delete re-parents children and plans, tree and path", () => {
  const p = join(tmp, "home-layout.json");
  assert.deepEqual(lib.readLayout(p), { folders: {}, plans: {}, updatedAt: "" });
  const { fid: samples } = lib.createFolder("  Samples ", "", p);
  const { fid: photo } = lib.createFolder("Photo tracks", samples, p);
  const { fid: deep } = lib.createFolder("Deep", photo, p);
  const { fid: repo } = lib.createFolder("Repo health", "", p);
  assert.throws(() => lib.createFolder("", "", p), /needs a name/);
  assert.throws(() => lib.createFolder("x", "nope", p), /no such parent/);
  let l = lib.readLayout(p);
  assert.equal(l.folders[samples].name, "Samples"); assert.equal(l.folders[photo].parent, samples);
  lib.renameFolder(repo, "Repo", p);
  assert.equal(lib.readLayout(p).folders[repo].name, "Repo");
  // cycle guard: Samples cannot move under Photo tracks (its child) or Deep (its grandchild) or itself
  assert.throws(() => lib.moveFolder(samples, photo, p), /own descendant/);
  assert.throws(() => lib.moveFolder(samples, deep, p), /own descendant/);
  assert.throws(() => lib.moveFolder(samples, samples, p), /own descendant/);
  lib.moveFolder(repo, samples, p); assert.equal(lib.readLayout(p).folders[repo].parent, samples);
  lib.moveFolder(repo, "", p); assert.equal(lib.readLayout(p).folders[repo].parent, "");
  // plans
  lib.filePlan("0123456789abcdef", samples, p); lib.filePlan("aaaaaaaaaaaaaaaa", photo, p); lib.filePlan("bbbbbbbbbbbbbbbb", deep, p);
  assert.throws(() => lib.filePlan("short", samples, p), /bad plan key/);
  assert.throws(() => lib.filePlan("0123456789abcdef", "zzz", p), /no such folder/);
  lib.filePlan("cccccccccccccccc", samples, p); lib.filePlan("cccccccccccccccc", "", p);
  l = lib.readLayout(p); assert.equal(l.plans.cccccccccccccccc, undefined); assert.equal(Object.keys(l.plans).length, 3);
  // tree + path
  const tree = lib.folderTree(l);
  assert.deepEqual(tree.map((n) => n.name), ["Repo", "Samples"]);
  assert.deepEqual(tree[1].children.map((n) => n.name), ["Photo tracks"]); assert.equal(tree[1].children[0].children[0].name, "Deep");
  assert.deepEqual(lib.folderPath(l, deep).map((x) => x.name), ["Samples", "Photo tracks", "Deep"]);
  assert.deepEqual(lib.folderPath(l, "nope"), []);
  assert.deepEqual([...lib.folderDescendants(l, samples)].sort(), [samples, photo, deep].sort());
  // delete the middle folder: Deep and the photo plan move up to Samples
  lib.deleteFolder(photo, p);
  l = lib.readLayout(p);
  assert.equal(l.folders[photo], undefined); assert.equal(l.folders[deep].parent, samples); assert.equal(l.plans.aaaaaaaaaaaaaaaa, samples); assert.equal(l.plans.bbbbbbbbbbbbbbbb, deep);
  // delete a root folder: its children and plans go to the root (plans become unfiled)
  lib.deleteFolder(samples, p);
  l = lib.readLayout(p);
  assert.equal(l.folders[deep].parent, ""); assert.equal(l.plans["0123456789abcdef"], undefined); assert.equal(l.plans.aaaaaaaaaaaaaaaa, undefined); assert.equal(l.plans.bbbbbbbbbbbbbbbb, deep);
  assert.throws(() => lib.deleteFolder(samples, p), /no such folder/);
  // a corrupt file reads as empty; dangling references are dropped on read
  writeFileSync(p, JSON.stringify({ folders: { abc123: { name: "Ok", parent: "missing" }, "bad id!": { name: "x" } }, plans: { "0123456789abcdef": "gone", "1111111111111111": "abc123" } }));
  l = lib.readLayout(p);
  assert.deepEqual(Object.keys(l.folders), ["abc123"]); assert.equal(l.folders.abc123.parent, ""); assert.deepEqual(l.plans, { "1111111111111111": "abc123" });
  writeFileSync(p, "{nope"); assert.deepEqual(lib.readLayout(p).folders, {});
});
