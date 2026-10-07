// node --test ~/.claude/skills/review-changes/tools/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { parseManifest, phrase } = await import("../lib/manifest.mjs");

const MINIMAL = `route:  /purchasing/costing
branch: feat/purchasing/costing-page
mode:   read-only            # or: writes declared below
role:   admin                # role the run must hold
writes: (none)               # each declared write: what, ZZ-VERIFY- marker, cleanup path

CHECKS
  C1  page-loads      nav /purchasing/costing → heading "Costing" visible
                      AND zero console errors AND no error boundary
  C2  field-fob       label "FOB Cost" → numeric input, editable
  C5  computed-total  set FOB=10.00 → "Landed Cost" recomputes, not 0.00, not NaN
  C6  empty-state     a style with no HTS assignment shows the empty state,
                      NOT a silent blank panel

RESULT   (filled in by the run, never by hand)
`;

test("parseManifest: the verify-changes example — header, four checks, continuation lines joined, empty result", () => {
  const m = parseManifest(MINIMAL);
  assert.equal(m.header.route, "/purchasing/costing");
  assert.equal(m.header.branch, "feat/purchasing/costing-page");
  assert.equal(m.header.mode, "read-only");
  assert.equal(m.header.role, "admin");
  assert.equal(m.header.writes, "(none)");
  assert.deepEqual(m.checks.map((c) => c.id), ["C1", "C2", "C5", "C6"]);
  assert.equal(m.checks[0].slug, "page-loads");
  assert.equal(m.checks[0].text, 'nav /purchasing/costing → heading "Costing" visible AND zero console errors AND no error boundary');
  assert.equal(m.checks[3].text, "a style with no HTS assignment shows the empty state, NOT a silent blank panel");
  assert.equal(m.checks.every((c) => c.human === false), true);
  assert.deepEqual(m.result, {});
  assert.equal(m.grade, null);
});

test("parseManifest: a real StyleManager manifest — multi-line writes, six PASS results with notes, trailer lines kept", () => {
  const m = parseManifest(readFileSync(join(here, "fixtures/cart-approval.md"), "utf8"));
  assert.equal(m.header.route, "https://app.stylaos.com/samples/carts/catalog  (PROD — post-merge recovery check for PR #504)");
  assert.match(m.header.writes, /^submit_cart → reject_cart → reopen_cart roundtrip on cart 85df1fe7/);
  assert.match(m.header.writes, /NOT exercised: approve_cart/);
  assert.equal(m.checks.length, 6);
  assert.equal(m.checks[2].id, "C3");
  assert.equal(m.checks[2].slug, "request");
  assert.match(m.checks[2].text, /^"Request approval" on cart 85df1fe7 succeeds .* DB-confirmed$/);
  assert.deepEqual(Object.keys(m.result), ["C1", "C2", "C3", "C4", "C5", "C6"]);
  assert.equal(m.result.C1.status, "pass");
  assert.equal(m.result.C1.note, '"Dev Agent (local verification)" chip, full admin nav');
  assert.match(m.result.C3.note, /DB review row submitted 1→2 @ 05:43:19Z$/);
  assert.equal(m.resultNotes.length, 3);
  assert.match(m.resultNotes[0], /^console: 0 errors/);
  assert.match(m.resultNotes[2], /^NOT exercised: approve_cart/);
});

test("parseManifest: RESULT statuses normalise — pass, fail with reason, blocked-by-Cn, unknown word kept as note", () => {
  const m = parseManifest(`route: /x

CHECKS
  C1  a  one
  C2  b  two
  C3  c  three
  C4  d  four

RESULT
  C1  a  PASS
  C2  b  FAIL — Landed Cost shows NaN
  C3  c  blocked-by-C2
  C4  d  skipped: needs prod data
  C5  e  (not run) — needs a real approval prompt
  C6  f  not run
`);
  assert.deepEqual(m.result.C1, { status: "pass", note: "" });
  assert.deepEqual(m.result.C2, { status: "fail", note: "Landed Cost shows NaN" });
  assert.deepEqual(m.result.C3, { status: "blocked", blockedBy: "C2", note: "" });
  assert.deepEqual(m.result.C4, { status: "not-run", note: "skipped: needs prod data" });
  assert.deepEqual(m.result.C5, { status: "not-run", note: "needs a real approval prompt" });
  assert.deepEqual(m.result.C6, { status: "not-run", note: "" });
});

test("parseManifest: HUMAN-ONLY checks are checks the verifier cannot reach; GRADE block parsed", () => {
  const m = parseManifest(`route: /

CHECKS
  C1  a  where: /board · do: click Notify · expect: one notification

HUMAN-ONLY
  H1  perm  where: /board · do: allow notifications in the browser dialog · expect: the toggle turns blue

GRADE
  first-pass: 2/3 · rounds: 1 · stars: 4 · letter: B
`);
  assert.equal(m.checks.length, 2);
  assert.equal(m.checks[1].id, "H1");
  assert.equal(m.checks[1].human, true);
  assert.equal(m.checks[0].human, false);
  assert.deepEqual(m.grade, { firstPass: { passed: 2, total: 3 }, rounds: 1, stars: 4, letter: "B" });
});

test("parseManifest: header keys beyond the verify set (preview, session, range, worktree) and comments stripped", () => {
  const m = parseManifest(`route:    /history   # the page
preview:  https://mm-pr-12.vercel.app/#/history
session:  phase-6 · implementer
range:    b88401b..HEAD
worktree: wt-phase-6

CHECKS
  C1  x  y
`);
  assert.equal(m.header.route, "/history");
  assert.equal(m.header.preview, "https://mm-pr-12.vercel.app/#/history");
  assert.equal(m.header.session, "phase-6 · implementer");
  assert.equal(m.header.range, "b88401b..HEAD");
  assert.equal(m.header.worktree, "wt-phase-6");
});

test("parseManifest: tolerant — empty text, garbage, and a check line before any CHECKS heading", () => {
  assert.deepEqual(parseManifest(""), { header: {}, checks: [], result: {}, resultNotes: [], grade: null });
  const m = parseManifest("random words\n  C9  slug  text without a heading\n");
  assert.deepEqual(m.checks, []);
  assert.doesNotThrow(() => parseManifest("CHECKS\n  not a check\n  C1\n"));
});

test("parseManifest: markdown-style headings ('## CHECKS — title (#497)'), several CHECKS blocks, letter prefixes other than C", () => {
  const m = parseManifest(`route: /x

## CHECKS — data (#498)

  D3  elc-snapshot-lock    a confirmed line's elc snapshot cannot be
                           overwritten by a direct update

## CHECKS — public linesheet (#497)

  P1  no-qty-input         the public ModelCard renders NO quantity input

RESULT — run 2026-08-13, round 1
  D3  elc-snapshot-lock    PASS
  P1  no-qty-input         PASS
`);
  assert.deepEqual(m.checks.map((c) => c.id), ["D3", "P1"]);
  assert.equal(m.checks[0].text, "a confirmed line's elc snapshot cannot be overwritten by a direct update");
  assert.deepEqual(Object.keys(m.result), ["D3", "P1"]);
});

test("phrase: explicit where · do · expect labels win; otherwise 'do → expect' splits on the arrow and where falls back to preview, then route", () => {
  const header = { route: "/purchasing/costing", preview: "https://pr-5.vercel.app/purchasing/costing" };
  assert.deepEqual(phrase({ text: "where: /history · do: type count(*) · expect: hits with snippets" }, header), { where: "/history", do: "type count(*)", expect: "hits with snippets" });
  assert.deepEqual(phrase({ text: 'nav /purchasing/costing → heading "Costing" visible' }, header), { where: "https://pr-5.vercel.app/purchasing/costing", do: "nav /purchasing/costing", expect: 'heading "Costing" visible' });
  assert.deepEqual(phrase({ text: "the empty state shows, not a blank panel" }, { route: "/x" }), { where: "/x", do: "", expect: "the empty state shows, not a blank panel" });
  assert.deepEqual(phrase({ text: "WHERE: /a · DO: b · EXPECT: c" }, {}), { where: "/a", do: "b", expect: "c" });
});

test("phrase: the 2026-09-02 table labels (priority · area · test) are parsed and only present when given; AGENT-ONLY rows are flagged", () => {
  const p = phrase({ text: "priority: High · area: Replace photo · test: Replace an existing photo · where: /samples/carts/photos · do: Upload a different image into an occupied slot · expect: Only the new image is shown" }, {});
  assert.deepEqual(p, { where: "/samples/carts/photos", do: "Upload a different image into an occupied slot", expect: "Only the new image is shown", priority: "High", area: "Replace photo", test: "Replace an existing photo" });
  assert.deepEqual(Object.keys(phrase({ text: "do: a → expect: b" }, {})), ["where", "do", "expect"]);
  const m = parseManifest(`route: /x

CHECKS
  C1  a  priority: High · test: T · do: D · expect: E

AGENT-ONLY
  A1  ledger  where: SQL editor (main) · do: select 1 · expect: 1
`);
  assert.deepEqual(m.checks.map((c) => [c.id, c.human, c.agent]), [["C1", false, false], ["A1", false, true]]);
});

test("parseManifest: a check row's shot: label and a RESULT line's trailing shot: path are kept (the RESULT one wins in the model)", () => {
  const m = parseManifest(`route: /x

CHECKS
  C1  one  priority: High · area: A · test: Open it · where: /x · do: open · expect: a table · shot: shots/c1-row.png
  C2  two  priority: Low · area: A · test: Empty · where: /x · do: open · expect: nothing

RESULT
  C1  one  PASS — 11 rows · shot: shots/c1-run.png
  C2  two  FAIL — stayed empty | shot: shots/c2.png
`);
  assert.equal(phrase(m.checks[0]).shot, "shots/c1-row.png");
  assert.equal(phrase(m.checks[1]).shot, undefined);
  assert.deepEqual(m.result.C1, { status: "pass", note: "11 rows", shot: "shots/c1-run.png" });
  assert.deepEqual(m.result.C2, { status: "fail", note: "stayed empty", shot: "shots/c2.png" });
});

test("parseManifest: slice-prefixed and suffixed ids (Q-C1, I-C4a, Q-C7x, H1H2x, C13b) are rows, and RESULT lines find them", () => {
  const m = parseManifest(`route: /x

## CHECKS — slice Q
  Q-C1   one   priority: High · area: A · test: Open it · where: /x · do: open · expect: a table
  I-C4a  two   priority: Low · area: A · test: Add · where: /x · do: add · expect: a row
  C13b   three priority: Low · area: A · test: Role · where: /x · do: look · expect: no buttons

## AGENT-ONLY
  Q-C7x  broken  where: pgTAP · do: run · expect: fails
  H1H2x  broken2 where: pgTAP · do: run · expect: fails

RESULT
  Q-C1   one   PASS — 2 rows
  I-C4a  two   PASS
  Q-C7x  broken PASS
  H1H2x  broken2 PASS
`);
  assert.deepEqual(m.checks.map((c) => c.id), ["Q-C1", "I-C4a", "C13b", "Q-C7x", "H1H2x"]);
  assert.equal(m.result["Q-C1"].status, "pass");
  assert.equal(m.result["H1H2x"].status, "pass");
  assert.equal(m.checks[3].agent, true);
});
