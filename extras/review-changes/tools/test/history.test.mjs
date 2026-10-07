// node --test ~/.claude/skills/review-changes/tools/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(os.tmpdir(), "review-history-"));
process.env.LAVISH_AXI_STATE_DIR = tmp;
const { parseManifest } = await import("../lib/manifest.mjs");
const { modelFromManifest } = await import("../lib/section.mjs");
const { readHistory, parseContextData, batchesOf, applyHistory, splitRevisions } = await import("../lib/history.mjs");
const { letterFor, computeGrade } = await import("../lib/grade.mjs");

const KEY = "0123456789abcdef";
const FILE = "/tmp/plan.html";
const u = (o) => ({ at: "2026-09-02T00:00:00Z", key: KEY, file: FILE, role: "user", kind: "annotation", where: "", selector: "", uid: "", attachments: [], ...o });
const a = (text, replyTo) => ({ at: "2026-09-02T00:00:00Z", key: KEY, file: FILE, role: "agent", kind: "reply", ...(replyTo ? { replyTo } : {}), text });
const ctx = (text, data) => `${text}\n\nContext data:\n${JSON.stringify(data, null, 2)}`;
const checks = (group, rows, stars) => u({ tag: "review", text: ctx(`Review checks · ${group}: …`, { kind: "checks", group, checks: rows, stars }), where: `Review checks · ${group}`, selector: "section#review-checklist > details > form:nth-of-type(1)" });

const THREE_ROUNDS = [
  // round 1
  u({ tag: "span", text: "The toggle went grey after I allowed notifications; nothing fired.", where: "WHERE Board → “Notify me” toggle …", selector: "li#rv-pr-7-C2 > div > p > span:nth-of-type(2)" }),
  checks("PR #7", [{ id: "C1", works: true, note: "" }, { id: "C2", works: false, note: "no notification" }, { id: "C3", works: false, note: "" }], 3),
  u({ tag: "review", text: ctx("Review revisions: three things", { kind: "revisions", text: "Three things: toggle state across reloads; a sound option; show the engine on History." }), where: "Review revisions", selector: "section#review-checklist > details > form:nth-of-type(2)" }),
  a("↳ Re “The toggle went grey after I allowed notifications; nothing …”: Reproduced: the permission is read once at mount. Fixing.", 1),
  a("↳ Re “Review checks · PR #7: …”: Recorded: C1 works, C2 and C3 not yet.", 2),
  a("↳ Re “Review revisions: three things”: Split:\nR1 → C2: toggle state across reloads\nR2: a sound option for the notification\nR3 → C1: show which engine answered on History", 3),
  a("Got 3 items: C2 comment, checks, revisions. Round 1: C2 diagnosed, revisions split into R1–R3."),
  // round 2
  u({ tag: "p", text: "Still nothing after the fix.", where: "C2 · A session that starts waiting on you raises one browser notification", selector: "li#rv-pr-7-C2 > div > p" }),
  checks("PR #7", [{ id: "C1", works: true, note: "" }, { id: "C2", works: false, note: "" }, { id: "C3", works: true, note: "" }], 4),
  a("↳ Re “Still nothing after the fix.”: Fixed: the listener was attached before the grant; it now re-subscribes on the toggle.", 1),
  a("↳ Re “Review checks · PR #7: …”: Recorded.", 2),
  a("Got 2 items: C2 again, checks. Round 2: C2 fixed for real.\nR2 done: a sound option is in the toggle menu."),
  // round 3
  checks("PR #7", [{ id: "C1", works: true, note: "" }, { id: "C2", works: true, note: "" }, { id: "C3", works: true, note: "" }], 5),
  a("↳ Re “Review checks · PR #7: …”: All green.", 1),
  a("Got 1 item: checks. Round 3: all green."),
];

const MANIFEST = `route: /history

CHECKS
  C1  search   where: /#/history · do: type count(*) · expect: hits
  C2  notify   do: stall a session → expect: one notification
  C3  fallback do: hide rg → expect: same hits

RESULT
  C1  search   PASS
  C3  fallback FAIL — ENOENT
`;
const freshModel = () => modelFromManifest(parseManifest(MANIFEST), { group: "PR #7" });

test("readHistory: reads the state dir's jsonl, skips bad lines, returns [] when missing", () => {
  mkdirSync(join(tmp, "history"), { recursive: true });
  writeFileSync(join(tmp, "history", `${KEY}.jsonl`), THREE_ROUNDS.map((e) => JSON.stringify(e)).join("\n") + "\n{bad json\n");
  assert.equal(readHistory(KEY).length, THREE_ROUNDS.length);
  assert.deepEqual(readHistory("ffffffffffffffff"), []);
});

test("parseContextData: splits the human text from the trailing JSON block; no block → data null", () => {
  assert.deepEqual(parseContextData("Review checks · X: C1 works\n\nContext data:\n{\n  \"kind\": \"checks\"\n}"), { text: "Review checks · X: C1 works", data: { kind: "checks" } });
  assert.deepEqual(parseContextData("plain comment"), { text: "plain comment", data: null });
  assert.deepEqual(parseContextData("x\n\nContext data:\n{not json"), { text: "x", data: null });
});

test("batchesOf: user runs become batches with their round, and each threaded reply resolves to its item", () => {
  const b = batchesOf(THREE_ROUNDS);
  assert.equal(b.length, 3);
  assert.deepEqual(b.map((x) => x.round), [1, 2, 3]);
  assert.deepEqual(b.map((x) => x.items.length), [3, 2, 1]);
  assert.equal(b[0].items[0].replies.length, 1);
  assert.match(b[0].items[0].replies[0].text, /^Reproduced/);
  assert.equal(b[1].items[0].replies[0].text, "Fixed: the listener was attached before the grant; it now re-subscribes on the toggle.");
  assert.deepEqual(b.map((x) => x.summary?.slice(0, 11)), ["Got 3 items", "Got 2 items", "Got 1 item:"]);
});

test("applyHistory: ticks and stars from the last batch, comments and outcomes per row (latest + history), fixed · rN, revisions as R rows", () => {
  const m = applyHistory(freshModel(), THREE_ROUNDS);
  const g = m.groups[0];
  assert.equal(m.rounds, 3);
  assert.deepEqual(g.rows.map((r) => r.works), [true, true, true]);
  assert.equal(g.stars, 5);
  const c2 = g.rows[1];
  assert.deepEqual(c2.comments.map((c) => [c.round, c.text]), [[1, "The toggle went grey after I allowed notifications; nothing fired."], [1, "no notification"], [2, "Still nothing after the fix."]]);
  assert.deepEqual(c2.outcomes.map((o) => [o.round, o.text.slice(0, 10)]), [[1, "Reproduced"], [2, "Fixed: the"]]);
  assert.equal(c2.fixedRound, 2);
  assert.equal(g.rows[0].fixedRound, null);
  assert.deepEqual(g.rows[0].comments, []);
  assert.deepEqual(m.revisions.map((r) => [r.id, r.linked, r.done]), [["R1", "C2", null], ["R2", "", 2], ["R3", "C1", null]]);
  assert.equal(m.revisions[1].outcomes[0].text, "a sound option is in the toggle menu.");
  assert.deepEqual(g.counters, { works: 3, total: 3, verified: 1, needYou: 0 });
});

test("applyHistory: a comment in a later round than the fix reopens the row (fixedRound cleared, reopenedRound set); a later Fixed closes it again", () => {
  const entries = [
    u({ tag: "p", text: "nothing fired", where: "C2 · x", selector: "li#rv-pr-7-C2 > div > p" }),
    a("↳ Re “nothing fired”: Fixed: permission re-read.", 1), a("Got 1 item."),
    u({ tag: "p", text: "still nothing", where: "C2 · x", selector: "li#rv-pr-7-C2 > div > p" }),
    a("↳ Re “still nothing”: Reproduced; the detector never runs when the tab is focused. Working on it.", 1), a("Got 1 item."),
  ];
  const m = applyHistory(freshModel(), entries);
  const c2 = m.groups[0].rows[1];
  assert.equal(c2.fixedRound, null);
  assert.equal(c2.reopenedRound, 2);
  const again = applyHistory(freshModel(), [...entries, u({ tag: "p", text: "third", where: "C2 · x", selector: "li#rv-pr-7-C2 > div > p" }), a("↳ Re “third”: Done: focus guard removed.", 1), a("Got 1 item.")]);
  assert.equal(again.groups[0].rows[1].fixedRound, 3);
  assert.equal(again.groups[0].rows[1].reopenedRound, null);
});

test("applyHistory: another group's batches and comments do not leak; an unknown row id is ignored", () => {
  const entries = [
    checks("PR #8", [{ id: "C1", works: true, note: "" }], 1),
    u({ tag: "p", text: "elsewhere", where: "C9 · nothing", selector: "li#rv-pr-8-C1 > p" }),
    a("Got 2 items."),
  ];
  const m = applyHistory(freshModel(), entries);
  assert.deepEqual(m.groups[0].rows.map((r) => r.works), [false, false, false]);
  assert.equal(m.groups[0].stars, null);
  assert.deepEqual(m.groups[0].rows.flatMap((r) => r.comments), []);
});

test("applyHistory: a comment matches by selector id first, then by the first C/R token in its text", () => {
  const entries = [
    u({ tag: "li", text: "by selector", where: "Works C3 · whatever", selector: "li#rv-pr-7-C1" }),
    u({ tag: "td", text: "by token", where: "C3 · Search still answers", selector: "table > tr > td" }),
    a("Got 2 items."),
  ];
  const m = applyHistory(freshModel(), entries);
  assert.deepEqual(m.groups[0].rows[0].comments.map((c) => c.text), ["by selector"]);
  assert.deepEqual(m.groups[0].rows[2].comments.map((c) => c.text), ["by token"]);
});

test("applyHistory on the real spike history: four items in one batch, the span comment lands on C2, ticks C1 and C3, 4 stars, verdict counted", () => {
  const entries = readFileSync(join(here, "fixtures/history-spike.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const model = modelFromManifest(parseManifest("route: /\n\nCHECKS\n  C1 a x\n  C2 b y\n  C3 c z\n"), { group: "Phase 6" });
  const m = applyHistory(model, entries);
  assert.equal(m.rounds, 1);
  assert.deepEqual(m.groups[0].rows.map((r) => r.works), [true, false, true]);
  assert.equal(m.groups[0].stars, 4);
  assert.equal(m.groups[0].rows[1].comments.length, 2);
  assert.match(m.groups[0].rows[1].outcomes[0].text, /^Reproduced/);
  assert.equal(m.verdict, "Approve");
  assert.deepEqual(m.revisions.map((r) => r.id), ["R1", "R2", "R3"]);
});

test("applyHistory: R-lines in the reply to any comment become tracked rows too (line form only; the inline form stays reserved for the revisions box)", () => {
  const entries = [
    u({ tag: "details", text: "I like a session search like Cursor's and sessions grouped per project like Codex.", where: "Notifications — pure web", selector: "html > body > div > details:nth-of-type(2)" }),
    a("↳ Re “I like a session search…”: Two ideas, tracked:\nR1: session search like Cursor's session manager\nR2: sessions grouped per project in a sidebar (plan P4)\nSee also R9 (not a row) in prose.", 1),
    a("Got 1 item."),
  ];
  const m = applyHistory(freshModel(), entries);
  assert.deepEqual(m.revisions.map((r) => [r.id, r.text]), [["R1", "session search like Cursor's session manager"], ["R2", "sessions grouped per project in a sidebar (plan P4)"]]);
});

test("splitRevisions: 'R1 → C2: text' and 'R2: text' lines from the agent's reply become tracked rows", () => {
  assert.deepEqual(splitRevisions("Split:\nR1 → C2: toggle state\nR2: sound option\nR3 - C1: engine shown\nnot a row"), [
    { id: "R1", linked: "C2", text: "toggle state" }, { id: "R2", linked: "", text: "sound option" }, { id: "R3", linked: "C1", text: "engine shown" },
  ]);
});

test("letterFor: the worse of the first-pass rate and the rounds decides; stars can only lower it", () => {
  assert.equal(letterFor({ rate: 1, rounds: 1 }), "A");
  assert.equal(letterFor({ rate: 0.9, rounds: 1 }), "A");
  assert.equal(letterFor({ rate: 0.95, rounds: 2 }), "B");
  assert.equal(letterFor({ rate: 0.75, rounds: 1 }), "B");
  assert.equal(letterFor({ rate: 0.6, rounds: 1 }), "C");
  assert.equal(letterFor({ rate: 1, rounds: 3 }), "C");
  assert.equal(letterFor({ rate: 0.4, rounds: 1 }), "D");
  assert.equal(letterFor({ rate: 1, rounds: 4 }), "D");
  assert.equal(letterFor({ rate: 1, rounds: 1, stars: 3 }), "B");
  assert.equal(letterFor({ rate: 1, rounds: 1, stars: 2 }), "C");
  assert.equal(letterFor({ rate: 0.4, rounds: 1, stars: 5 }), "D");
});

test("computeGrade: first pass from the first batch's ticks plus verify passes, rounds to green, stars from the last batch", () => {
  const m = applyHistory(freshModel(), THREE_ROUNDS);
  const g = computeGrade(m.groups[0], m);
  assert.deepEqual(g, { firstPass: { passed: 1, total: 3 }, rounds: 3, stars: 5, letter: "D", title: "first pass 1/3 · 3 rounds to green · 5 stars" });
  assert.equal(computeGrade(freshModel().groups[0], { rounds: 0 }), null);
  const oneRound = applyHistory(freshModel(), [checks("PR #7", [{ id: "C1", works: true, note: "" }, { id: "C2", works: true, note: "" }, { id: "C3", works: true, note: "" }], 5), a("Got 1 item.")]);
  assert.equal(computeGrade(oneRound.groups[0], oneRound).letter, "A");
});

test("applyHistory: a comment anchored on the group form or header is a group comment, never a row's (the form's text starts with the first row)", () => {
  const entries = [
    u({ tag: "form", text: "can't see the changes", where: "PR #7 localhost branch main C1 Works C1 · hits …", selector: "section#review-checklist > details > form:nth-of-type(1)" }),
    a("↳ Re “can't see the changes”: Phase 6 is on main; look for the bell in the top bar.", 1),
    a("Got 1 item."),
  ];
  const m = applyHistory(freshModel(), entries);
  const g = m.groups[0];
  assert.deepEqual(g.rows.flatMap((r) => r.comments), []);
  assert.deepEqual(g.comments.map((c) => [c.round, c.text]), [[1, "can't see the changes"]]);
  assert.deepEqual(g.outcomes.map((o) => o.text), ["Phase 6 is on main; look for the bell in the top bar."]);
});

test("renderSection: group comments and their outcomes render under the group header", async () => {
  const { renderSection } = await import("../lib/section.mjs");
  const m = applyHistory(freshModel(), [
    u({ tag: "form", text: "can't see the changes", where: "PR #7 …", selector: "section#review-checklist > details > form:nth-of-type(1)" }),
    a("↳ Re “can't see the changes”: Look for the bell.", 1), a("Got 1 item."),
  ]);
  const html = renderSection(m);
  assert.match(html, /<div class="rv-group-notes">[\s\S]*you · r1<\/span>can't see the changes[\s\S]*agent · r1<\/span>Look for the bell\./);
});
