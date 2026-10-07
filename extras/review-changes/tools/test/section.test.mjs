// node --test ~/.claude/skills/review-changes/tools/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(here, "fixtures", n), "utf8");
const { parseManifest } = await import("../lib/manifest.mjs");
const { modelFromManifest, renderSection, insertSection, extractSection, standalonePage, groupsInSection, BEGIN, END } = await import("../lib/section.mjs");

const MANIFEST = `route:  /history
base:   http://localhost:5173
branch: feat/phase-6
session: phase-6 · implementer
range:  b88401b..HEAD

CHECKS
  C1  search    where: /#/history · do: switch on "search inside sessions", type count(*) · expect: hits with a snippet each
  C2  notify    do: let a session stall on an approval → expect: exactly one notification
  C3  fallback  where: http://localhost:6161/api/search?q=count(*) · do: hide rg from PATH · expect: same hits, slower

HUMAN-ONLY
  H1  perm      do: allow notifications in the browser dialog → expect: the toggle turns blue

RESULT
  C1  search    PASS — 14 sessions matched
  C2  notify    (not run)
  C3  fallback  FAIL — spawn rg ENOENT <script>alert(1)</script>
`;

const model = () => modelFromManifest(parseManifest(MANIFEST), { group: "PR #12" });

test("modelFromManifest: one group, rows in manifest order, status from RESULT, human checks flagged", () => {
  const m = model();
  assert.equal(m.groups.length, 1);
  const g = m.groups[0];
  assert.equal(g.id, "PR #12");
  assert.equal(g.slug, "pr-12");
  assert.deepEqual(g.rows.map((r) => r.id), ["C1", "C2", "C3", "H1"]);
  assert.deepEqual(g.rows.map((r) => r.status), ["verified", "not-run", "failed", "not-run"]);
  assert.equal(g.rows[3].human, true);
  assert.equal(g.rows[0].where, "/#/history");
  assert.equal(g.rows[0].whereHref, "http://localhost:5173/#/history");
  assert.equal(g.rows[1].whereHref, "http://localhost:5173/history");
  assert.equal(g.rows[2].whereHref, "http://localhost:6161/api/search?q=count(*)");
  assert.equal(g.branch, "feat/phase-6");
  assert.equal(g.session, "phase-6 · implementer");
  assert.equal(g.range, "b88401b..HEAD");
  assert.deepEqual(g.counters, { works: 0, total: 4, verified: 1, needYou: 3 });
});

test("renderSection: every row has a where-to-test link, ids are unique and carry the group slug, chrome is data-lavish-ui, text is escaped", () => {
  const html = renderSection(model());
  const rowIds = [...html.matchAll(/<li class="rv-row"[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rowIds, ["rv-pr-12-C1", "rv-pr-12-C2", "rv-pr-12-C3", "rv-pr-12-H1"]);
  const rows = html.split('<li class="rv-row').slice(1);
  assert.equal(rows.length, 4);
  for (const r of rows) assert.match(r, /<a href="http[^"]+"[^>]*>/, "row without a where-to-test link");
  assert.match(html, /data-lavish-question="Review checks · PR #12"/);
  assert.match(html, /<div class="rv-send" data-lavish-ui=/);
  assert.match(html, /<div class="rv-foot" data-lavish-ui=/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)/);
  assert.match(html, /name="works-C1"/);
  assert.match(html, /name="stars-pr-12"/);
  assert.match(html, /rv-chip verified/);
  assert.match(html, /rv-chip failed/);
  assert.match(html, /Still needs a human check[\s\S]*H1/);
  assert.match(html, /0 of 4 work · 1 verified · 3 need you/);
});

test("renderSection: a where that is a bare path links against the group's base, a plain sentence keeps the route as the link", () => {
  const m = modelFromManifest(parseManifest("route: /x\n\nCHECKS\n  C1  a  the empty state shows\n"), { group: "PR #1" });
  assert.equal(m.groups[0].rows[0].whereHref, "/x");
  assert.match(renderSection(m), /<a href="\/x"/);
  // a one-character where ("/") would make an unreadable link: the link text is the full href then
  const root = modelFromManifest(parseManifest("route: /\nbase: http://localhost:5173\n\nCHECKS\n  C1  a  the board shows cards\n"), { group: "PR #1" });
  assert.match(renderSection(root), /<a href="http:\/\/localhost:5173\/"[^>]*>localhost:5173\/<\/a>/);
});

for (const [name, marker] of [["plan-template.html", 'data-sec="Feedback log"'], ["phase-6-polish.html", 'data-sec="fb"']]) {
  test(`insertSection: ${name} — inserted once before the Feedback log, idempotent, byte-identical outside the markers`, () => {
    const page = fixture(name);
    const sec = renderSection(model());
    const once = insertSection(page, sec);
    assert.equal(once.split(BEGIN).length, 2);
    assert.equal(once.split(END).length, 2);
    assert.ok(once.indexOf(BEGIN) < once.indexOf(marker), "section must precede the Feedback log");
    const twice = insertSection(once, sec);
    assert.equal(twice, once);
    // The block is BEGIN\n…\nEND\n; everything before BEGIN and after that trailing newline is the plan's own.
    const outside = (html) => [html.slice(0, html.indexOf(BEGIN)), html.slice(html.indexOf(END) + END.length + 1)];
    const [prefix, suffix] = outside(once);
    let ten = page;
    for (let i = 0; i < 10; i++) ten = insertSection(ten, renderSection(model()));
    assert.deepEqual(outside(ten), [prefix, suffix]);
    assert.equal(prefix + suffix, page, "outside the markers the page is byte-identical");
    assert.equal(extractSection(once), sec);
  });
}

test("insertSection: a rebuild replaces the old section in place; a page without a Feedback log gets it before </main> or </body>", () => {
  const page = "<html><body><main><h1>x</h1></main></body></html>";
  const a = insertSection(page, "<p>A</p>");
  assert.equal(a, `<html><body><main><h1>x</h1>${BEGIN}\n<p>A</p>\n${END}\n</main></body></html>`);
  const b = insertSection(a, "<p>B</p>");
  assert.equal(b, `<html><body><main><h1>x</h1>${BEGIN}\n<p>B</p>\n${END}\n</main></body></html>`);
  assert.equal(insertSection("<p>no main</p>", "<p>S</p>"), `<p>no main</p>${BEGIN}\n<p>S</p>\n${END}\n`);
  assert.equal(extractSection(page), null);
});

test("standalonePage: a full page around the section when there is no plan", () => {
  const html = standalonePage(renderSection(model()), { title: "PR #12 · review" });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>PR #12 · review<\/title>/);
  assert.match(html, /<meta name="lavish:project"/);
  assert.match(html, new RegExp(BEGIN.replace(/[-]/g, "\\-")));
  assert.match(html, /Feedback log/);
});

test("table style: a manifest with test: labels renders the header row and the five columns; agent-only rows sit collapsed without a Works box and never 'need you'", () => {
  const m = modelFromManifest(parseManifest(`route: /samples/carts/photos
base: https://app.stylaos.com

CHECKS
  C1  replace  priority: High · area: Replace photo · test: Replace an existing photo · do: Upload a different image into an occupied slot · expect: Only the new image is shown
  C2  clear    priority: Low · area: Clear photo · test: Remove a photo · do: Click Clear and confirm · expect: The photo disappears

AGENT-ONLY
  A1  ledger   where: SQL editor (main) · do: select 1 · expect: one row

RESULT
  A1  ledger   PASS — 1
`), { group: "PR #522" });
  const g = m.groups[0];
  assert.equal(g.table, true);
  assert.deepEqual(g.rows.map((r) => [r.id, r.text, r.priority, r.agent]), [["C1", "Replace an existing photo", "High", false], ["C2", "Remove a photo", "Low", false], ["A1", "one row", "", true]]);
  assert.deepEqual(g.counters, { works: 0, total: 3, verified: 1, needYou: 2 });
  const html = renderSection(m);
  assert.match(html, /<form class="rv-group rv-table"/);
  assert.match(html, /rv-hdr"><span>Works\?<\/span><span>Priority<\/span><span>What to test<\/span><span>Steps<\/span><span>Expected result<\/span>/);
  assert.match(html, /rv-pri high">High</);
  assert.match(html, /<p class="rv-steps">Upload a different image into an occupied slot<\/p>/);
  assert.match(html, /id="rv-pr-522-C1"[\s\S]*name="works-C1"/);
  assert.match(html, /<details class="rv-agent"><summary>Checked by the agent, not you · 1 · 1 verified<\/summary>/);
  const agent = html.slice(html.indexOf('<details class="rv-agent">'));
  assert.match(agent, /id="rv-pr-522-A1"/);
  assert.doesNotMatch(agent, /works-A1/);
  assert.match(agent, /<code>select 1<\/code>/);
  // the legacy layout is untouched for manifests without test: labels
  assert.doesNotMatch(renderSection(model()), /class="rv-group rv-table"|class="rv-row rv-hdr"/);
});

test("groupsInSection: a table-style group (class \"rv-group rv-table\") is found again at the next build, with its stored facts", () => {
  const m = modelFromManifest(parseManifest("route: /x\n\nCHECKS\n  C1  a  priority: High · test: T · do: D · expect: E\n"), { group: "PR #9", manifest: "../m9.md", range: "a..b" });
  const specs = groupsInSection(renderSection(m));
  assert.equal(specs.length, 1);
  assert.equal(specs[0].group, "PR #9");
  assert.equal(specs[0].manifest, "../m9.md");
  assert.equal(specs[0].range, "a..b");
});

test("renderSection: a row with a placed screenshot shows it as a thumbnail that opens the file; a missing one says so", () => {
  const model = modelFromManifest(parseManifest(`route: /x
base: http://localhost:5173

CHECKS
  C1  one  priority: High · area: A · test: Open it · where: /x · do: open · expect: a table · shot: shots/c1.png
  C2  two  priority: Low · area: A · test: Empty · where: /x · do: open · expect: nothing · shot: shots/missing.png

AGENT-ONLY
  A1  sql  where: SQL editor (main) · do: select 1 · expect: 1 · shot: shots/a1.png

RESULT
  C1  one  PASS
`), { group: "PR #1" });
  const [g] = model.groups;
  assert.equal(g.rows[0].shot, "shots/c1.png");
  g.rows[0].shotHref = "assets/plan-review/pr-1/c1.png";
  g.rows[1].shotMissing = true;
  g.rows[2].shotHref = "assets/plan-review/pr-1/a1.png";
  const html = renderSection(model);
  assert.match(html, /<a class="rv-shot" href="assets\/plan-review\/pr-1\/c1\.png" target="_blank"[^>]*><img src="assets\/plan-review\/pr-1\/c1\.png" alt="Screenshot for C1"/);
  assert.match(html, /rv-shot-missing">screenshot not found: shots\/missing\.png/);
  assert.match(html, /rv-agent-row[\s\S]*<img src="assets\/plan-review\/pr-1\/a1\.png"/);
  assert.doesNotMatch(html, /src="shots\/c1\.png"/, "the raw manifest path is never used as the page's src");
});
