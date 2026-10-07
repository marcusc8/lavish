// node --test ~/.claude/skills/review-changes/tools/test/
// Runs the CLI against temp copies; LAVISH_AXI_STATE_DIR points at a throwaway dir so no real history is read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import os from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "review-checklist.mjs");
const tmp = mkdtempSync(join(os.tmpdir(), "review-cli-"));
const state = join(tmp, "state");
const run = (args, cwd = tmp) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, LAVISH_AXI_STATE_DIR: state } });

const MANIFEST = `route:  /history
base:   http://localhost:5173
branch: feat/phase-6

CHECKS
  C1  search   where: /#/history · do: type count(*) · expect: hits with snippets
  C2  notify   do: stall a session → expect: one notification

RESULT
  C1  search   PASS
`;
writeFileSync(join(tmp, "m.md"), MANIFEST);
copyFileSync(join(here, "fixtures/phase-6-polish.html"), join(tmp, "plan.html"));

test("build --plan: appends the section before the Feedback log, prints a summary, and is idempotent", () => {
  const before = readFileSync(join(tmp, "plan.html"), "utf8");
  const r = run(["build", "--plan", "plan.html", "--manifest", "m.md", "--group", "PR #7"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PR #7: 2 checks · 1 verified · 1 need you/);
  const after = readFileSync(join(tmp, "plan.html"), "utf8");
  assert.match(after, /<!-- review:begin -->/);
  assert.match(after, /id="rv-pr-7-C1"/);
  assert.ok(after.indexOf("<!-- review:end -->") < after.indexOf('data-sec="fb"'));
  assert.equal(after.length > before.length, true);
  const r2 = run(["build", "--plan", "plan.html", "--manifest", "m.md", "--group", "PR #7"]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readFileSync(join(tmp, "plan.html"), "utf8"), after);
});

test("build without --plan: writes a standalone page to --out", () => {
  const r = run(["build", "--manifest", "m.md", "--group", "PR #8", "--out", "review.html"]);
  assert.equal(r.status, 0, r.stderr);
  const html = readFileSync(join(tmp, "review.html"), "utf8");
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /id="rv-pr-8-C1"/);
  assert.match(r.stdout, /review\.html/);
});

test("build: --branch/--worktree/--session/--range flags land in the group header; git supplies the branch when the flag is absent", () => {
  const repo = join(tmp, "repo");
  spawnSync("git", ["init", "-q", "-b", "feat/from-git", repo]);
  writeFileSync(join(repo, "m.md"), MANIFEST.replace("branch: feat/phase-6\n", ""));
  const r = run(["build", "--manifest", "m.md", "--out", "r.html", "--group", "PR #9", "--worktree", "wt-9", "--session", "nine · implementer", "--range", "a1b2c3..HEAD"], repo);
  assert.equal(r.status, 0, r.stderr);
  const html = readFileSync(join(repo, "r.html"), "utf8");
  assert.match(html, /branch <code>feat\/from-git<\/code>/);
  assert.match(html, /worktree <code>wt-9<\/code>/);
  assert.match(html, /session <code>nine · implementer<\/code>/);
  assert.match(html, /range <code>a1b2c3\.\.HEAD<\/code>/);
});

test("build --plan: the plan's lavish history (by the file's key) supplies ticks, comments, outcomes and the grade; list prints the rows' state", () => {
  const plan = join(tmp, "plan-h.html");
  copyFileSync(join(here, "fixtures/phase-6-polish.html"), plan);
  const key = createHash("sha256").update(realpathSync(plan)).digest("hex").slice(0, 16);
  mkdirSync(join(state, "history"), { recursive: true });
  const u = (o) => JSON.stringify({ at: "2026-09-02T00:00:00Z", key, file: plan, role: "user", kind: "annotation", where: "", selector: "", uid: "", attachments: [], ...o });
  const a = (text, replyTo) => JSON.stringify({ at: "2026-09-02T00:00:00Z", key, file: plan, role: "agent", kind: "reply", ...(replyTo ? { replyTo } : {}), text });
  writeFileSync(join(state, "history", `${key}.jsonl`), [
    u({ tag: "p", text: "Nothing fired.", where: "C2 · stall a session", selector: "li#rv-pr-7-C2 > div > p" }),
    u({ tag: "review", text: `Review checks · PR #7: …\n\nContext data:\n${JSON.stringify({ kind: "checks", group: "PR #7", checks: [{ id: "C1", works: true, note: "" }, { id: "C2", works: false, note: "still grey" }], stars: 4 })}`, where: "Review checks · PR #7" }),
    a("↳ Re “Nothing fired.”: Fixed: the listener re-subscribes on the toggle.", 1),
    a("Got 2 items."),
  ].join("\n") + "\n");
  const r = run(["build", "--plan", "plan-h.html", "--manifest", "m.md", "--group", "PR #7"]);
  assert.equal(r.status, 0, r.stderr);
  const html = readFileSync(plan, "utf8");
  assert.match(html, /name="works-C1" value="C1" checked/);
  assert.match(html, /<span class="rv-who">you · r1<\/span>Nothing fired\./);
  assert.match(html, /<span class="rv-who">agent · r1<\/span>Fixed: the listener/);
  assert.match(html, /rv-chip fixed">fixed · r1/);
  assert.match(html, /still grey/);
  assert.match(html, /1 of 2 work · 1 verified · 1 need you/);
  assert.match(html, /class="rv-grade c"[^>]*>grade C</); // first pass 1/2 = 50 % → C, one round, 4 stars
  assert.match(r.stdout, /grade C/);
  const l = run(["list", "--plan", "plan-h.html"]);
  assert.equal(l.status, 0, l.stderr);
  assert.match(l.stdout, /PR #7 · grade C · round 1/);
  assert.match(l.stdout, /C1\s+works\s+verified/);
  assert.match(l.stdout, /C2\s+open\s+not-run\s+fixed r1/);
  assert.match(l.stdout, /Nothing fired\./);
});

test("build --plan twice with different groups keeps both; rebuilding one group re-derives the other from its stored manifest", () => {
  const plan = join(tmp, "plan-2.html");
  copyFileSync(join(here, "fixtures/phase-6-polish.html"), plan);
  writeFileSync(join(tmp, "m8.md"), "route: /board\n\nCHECKS\n  C1  board  do: open the board → expect: cards\n");
  assert.equal(run(["build", "--plan", "plan-2.html", "--manifest", "m.md", "--group", "PR #7", "--session", "seven"]).status, 0);
  assert.equal(run(["build", "--plan", "plan-2.html", "--manifest", "m8.md", "--group", "PR #8", "--session", "eight"]).status, 0);
  let html = readFileSync(plan, "utf8");
  assert.match(html, /id="rv-pr-7-C1"/);
  assert.match(html, /id="rv-pr-8-C1"/);
  assert.match(html, /3 checks in 2 groups/);
  assert.equal(run(["build", "--plan", "plan-2.html", "--manifest", "m.md", "--group", "PR #7", "--session", "seven again"]).status, 0);
  html = readFileSync(plan, "utf8");
  assert.equal((html.match(/<form class="rv-group"/g) || []).length, 2);
  assert.match(html, /session <code>seven again<\/code>/);
  assert.match(html, /session <code>eight<\/code>/);
  assert.ok(html.indexOf('data-group="PR #7"') < html.indexOf('data-group="PR #8"'), "group order is first-build order");
});

test("build: a missing manifest or plan fails with a clear message and touches nothing", () => {
  const r = run(["build", "--plan", "nope.html", "--manifest", "m.md"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /nope\.html/);
  assert.equal(existsSync(join(tmp, "nope.html")), false);
  const r2 = run(["build", "--manifest", "missing.md", "--out", "x.html"]);
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /missing\.md/);
  assert.equal(existsSync(join(tmp, "x.html")), false);
});

test("build --plan: a row's screenshot is copied beside the plan under assets/<plan>-review/<group>/ and the row points at the copy; a missing file is named, not broken", () => {
  const dir = join(tmp, "shots-case"); mkdirSync(join(dir, "verify", "shots"), { recursive: true });
  writeFileSync(join(dir, "verify", "shots", "c1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dir, "verify", "m.md"), `route: /x
base: http://localhost:5173

CHECKS
  C1  one  priority: High · area: A · test: Open it · where: /x · do: open · expect: a table · shot: shots/c1.png
  C2  two  priority: Low · area: A · test: Empty · where: /x · do: open · expect: nothing · shot: shots/nope.png

RESULT
  C1  one  PASS
`);
  copyFileSync(join(here, "fixtures/phase-6-polish.html"), join(dir, "plan.html"));
  const r = run(["build", "--plan", "plan.html", "--manifest", "verify/m.md", "--group", "PR #9"], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dir, "assets", "plan-review", "pr-9", "c1.png")), "the screenshot is copied beside the plan");
  const page = readFileSync(join(dir, "plan.html"), "utf8");
  assert.match(page, /<img src="assets\/plan-review\/pr-9\/c1\.png"/);
  assert.match(page, /screenshot not found: shots\/nope\.png/);
  assert.match(r.stderr, /C2: screenshot not found/);
  // a rebuild for another group keeps the first group's screenshot in place
  writeFileSync(join(dir, "verify", "n.md"), "route: /y\n\nCHECKS\n  C1  a  do: x → expect: y\n");
  const r2 = run(["build", "--plan", "plan.html", "--manifest", "verify/n.md", "--group", "PR #10"], dir);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(readFileSync(join(dir, "plan.html"), "utf8"), /<img src="assets\/plan-review\/pr-9\/c1\.png"/);
});
