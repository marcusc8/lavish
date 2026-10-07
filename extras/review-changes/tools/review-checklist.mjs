#!/usr/bin/env node
/* review-checklist.mjs — the Review checklist on a plan's lavish page.
 *
 *   review-checklist build --manifest <file> [--plan <artifact.html> | --out <file>] [--group "PR #n"]
 *                          [--range a..b] [--session <name>] [--branch <b>] [--worktree <w>] [--title <t>] [--link <url>]
 *   review-checklist list --plan <artifact.html>            every group's rows with their state, for the agent
 *   review-checklist handoff --plan <artifact.html>         open rows + a resume prompt
 *   review-checklist landed --range a..b                    is the range an ancestor of main?
 *
 * build is a pure function of the manifests + the plan's lavish history (+ git for the facts): run it as often
 * as you like, it replaces only the block between <!-- review:begin --> and <!-- review:end -->. A plan holds
 * one group per PR (or per session); each group's form stores the path of its manifest and its facts, so a
 * later build for another group re-derives the earlier ones from their own manifests.
 */
import { readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, relative, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { parseManifest } from "./lib/manifest.mjs";
import { modelFromManifest, renderSection, insertSection, extractSection, groupsInSection, standalonePage, counters, GROUP_ATTRS } from "./lib/section.mjs";
import { keyOf, readHistory, applyHistory } from "./lib/history.mjs";
import { computeGrade } from "./lib/grade.mjs";

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith("--") ? args[0] : "";
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : String(args[i + 1] ?? ""); };
const die = (m) => { console.error(m); process.exit(1); };

const git = (cwd, ...a) => { const r = spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8", timeout: 5000 }); return r.status === 0 ? r.stdout.trim() : ""; };
/** Facts the group header shows, from flags first, then the manifest, then git (read-only). */
function gitFacts(cwd) {
  // symbolic-ref names the branch even before its first commit; rev-parse covers a detached HEAD (short sha)
  return { branch: git(cwd, "symbolic-ref", "--short", "HEAD") || git(cwd, "rev-parse", "--short", "HEAD"), worktree: (/\/worktrees\/([^/]+)/.exec(cwd) || [])[1] || "" };
}

/** One group's model from a stored or requested spec {group, manifest (relative to baseDir), …facts}. */
function groupModel(spec, baseDir) {
  const path = resolve(baseDir, spec.manifest);
  if (!existsSync(path)) return null;
  const manifest = parseManifest(readFileSync(path, "utf8"));
  const facts = gitFacts(process.cwd());
  return modelFromManifest(manifest, {
    ...spec,
    branch: spec.branch || manifest.header.branch || facts.branch,
    worktree: spec.worktree || manifest.header.worktree || facts.worktree,
  }).groups[0];
}

/** Copy every row's screenshot next to the page (Lavish serves only files beside the HTML) and point the row at the
 *  copy. Sources are relative to the group's manifest; copies live under <pageDir>/<shotsDir>/<group slug>/<file>. A
 *  source that is not there leaves the row marked shotMissing, so the page says so instead of showing a broken image. */
function placeShots(model, { pageDir, shotsDir, manifestDirOf }) {
  for (const g of model.groups) {
    const srcDir = manifestDirOf(g);
    for (const r of g.rows) {
      if (!r.shot) continue;
      const src = resolve(srcDir, r.shot);
      if (!existsSync(src)) { r.shotMissing = true; console.error(`warning: ${g.id} ${r.id}: screenshot not found: ${src}`); continue; }
      const rel = `${shotsDir}/${g.slug}/${basename(src)}`;
      const dst = resolve(pageDir, rel);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      r.shotHref = rel;
    }
  }
}

/** The whole model for a plan: every stored group (this one replaced or appended), history overlaid, graded. */
function planModel(plan, current) {
  const page = readFileSync(plan, "utf8");
  const baseDir = dirname(resolve(plan));
  const specs = groupsInSection(extractSection(page) || "");
  if (current) {
    const i = specs.findIndex((s) => s.group === current.group);
    if (i === -1) specs.push(current); else specs[i] = current;
  }
  const groups = [];
  for (const s of specs) {
    const g = groupModel(s, baseDir);
    if (g) groups.push(g); else console.error(`warning: manifest for ${s.group} not found (${s.manifest}); group dropped`);
  }
  const model = { groups, revisions: [] };
  applyHistory(model, readHistory(keyOf(realpathSync(plan))));
  for (const g of model.groups) g.grade = computeGrade(g, model);
  return { page, model };
}

const summarize = (g) => {
  const c = counters(g.rows);
  return `${g.id}: ${c.total} check${c.total === 1 ? "" : "s"} · ${c.verified} verified · ${c.needYou} need you${g.grade ? ` · grade ${g.grade.letter}` : ""}`;
};

if (cmd === "build") {
  const manifestPath = flag("--manifest");
  if (!manifestPath) die("build: --manifest <file> is required");
  if (!existsSync(manifestPath)) die(`build: manifest not found: ${manifestPath}`);
  const plan = flag("--plan");
  if (plan && !existsSync(plan)) die(`build: plan not found: ${plan}`);
  const spec = Object.fromEntries(GROUP_ATTRS.map((k) => [k, flag(`--${k}`) || ""]));
  spec.group = flag("--group") || parseManifest(readFileSync(manifestPath, "utf8")).header.group || "PR";
  if (plan) {
    spec.manifest = relative(dirname(resolve(plan)), resolve(manifestPath)) || manifestPath;
    const { page, model } = planModel(plan, spec);
    const pageDir = dirname(resolve(plan));
    placeShots(model, { pageDir, shotsDir: `assets/${basename(plan).replace(/\.html?$/i, "")}-review`, manifestDirOf: (g) => dirname(resolve(pageDir, g.manifest)) });
    writeFileSync(plan, insertSection(page, renderSection(model)));
    for (const g of model.groups) console.log(summarize(g));
    console.log(`section written into ${plan}`);
  } else {
    spec.manifest = manifestPath;
    const g = groupModel(spec, process.cwd());
    const model = { groups: [g], revisions: [] };
    const out = flag("--out") || `review-${g.slug}.html`;
    placeShots(model, { pageDir: dirname(resolve(out)), shotsDir: `${basename(out).replace(/\.html?$/i, "")}-shots`, manifestDirOf: () => dirname(resolve(manifestPath)) });
    writeFileSync(out, standalonePage(renderSection(model), { title: `${g.title} · review checklist` }));
    console.log(summarize(g));
    console.log(`standalone page written to ${out}`);
  }
} else if (cmd === "list") {
  const plan = flag("--plan");
  if (!plan || !existsSync(plan)) die(`list: --plan <artifact.html> is required${plan ? ` (not found: ${plan})` : ""}`);
  const { model } = planModel(plan, null);
  if (!model.groups.length) die("list: no Review checklist section in this plan yet (run build)");
  for (const g of model.groups) {
    console.log(`${g.id} · ${g.grade ? `grade ${g.grade.letter}` : "no grade yet"} · round ${model.rounds}${g.session ? ` · session ${g.session}` : ""}`);
    for (const r of g.rows) {
      const flags = [r.works ? "works" : "open", r.status, r.fixedRound ? `fixed r${r.fixedRound}` : ""].filter(Boolean);
      console.log(`  ${r.id.padEnd(4)} ${flags.map((f) => f.padEnd(9)).join("")} ${r.text}`);
      for (const c of r.comments) console.log(`       you r${c.round}: ${c.text}`);
      for (const o of r.outcomes) console.log(`       agent r${o.round}: ${o.text}`);
    }
  }
  for (const r of model.revisions) console.log(`  ${r.id.padEnd(4)} ${(r.done ? `done r${r.done}` : "open").padEnd(9)}${r.linked ? ` → ${r.linked}` : ""} ${r.text}`);
  if (model.verdict) console.log(`verdict: ${model.verdict}`);
} else if (cmd === "landed") {
  const range = flag("--range") || "";
  const end = range.includes("..") ? range.split("..").pop() : range;
  if (!end) die("landed: --range a..b is required");
  const base = flag("--base") || "main";
  const r = spawnSync("git", ["merge-base", "--is-ancestor", end, base], { encoding: "utf8" });
  if (r.status === 0) console.log(`landed: yes — ${end} is on ${base}`);
  else if (r.status === 1) { console.log(`landed: no — ${end} is not on ${base}`); process.exit(3); }
  else die(`landed: ${r.stderr.trim() || "git failed"}`);
} else if (cmd === "handoff") {
  const plan = flag("--plan");
  if (!plan || !existsSync(plan)) die(`handoff: --plan <artifact.html> is required${plan ? ` (not found: ${plan})` : ""}`);
  const date = flag("--date") || new Date().toISOString().slice(0, 10);
  const { model } = planModel(plan, null);
  if (!model.groups.length) die("handoff: no Review checklist section in this plan yet (run build)");
  const slug = basename(plan).replace(/\.html?$/, "");
  const out = flag("--out") || `docs/reviews/${date}-${slug}-HANDOFF.md`;
  const isOpen = (r) => !r.works && !(r.status === "verified" && !r.comments.length && !r.reopenedRound);
  const lines = [`# HANDOFF — review of ${plan} (${date})`, "", `Lavish session ${keyOf(realpathSync(plan))} · Round ${model.rounds} so far${model.verdict ? ` · verdict ${model.verdict}` : ""}.`, ""];
  lines.push("## Open rows", "");
  let open = 0;
  for (const g of model.groups) for (const r of g.rows) {
    if (!isOpen(r)) continue;
    open++;
    lines.push(`- **${g.id} · ${r.id}** — ${r.text}`, `  - where: ${r.whereHref || r.where}${r.do ? ` · do: ${r.do}` : ""}${r.expect && r.expect !== r.text ? ` · expect: ${r.expect}` : ""} · status: ${r.status}${r.reopenedRound ? ` · reopened r${r.reopenedRound}` : ""}`);
    for (const c of r.comments) lines.push(`  - you r${c.round}: ${c.text}`);
    for (const o of r.outcomes) lines.push(`  - agent r${o.round}: ${o.text}`);
  }
  if (!open) lines.push("- none: every row works or is verified");
  const openRevs = model.revisions.filter((r) => !r.done);
  if (openRevs.length) { lines.push("", "## Your revisions (open)", ""); for (const r of openRevs) lines.push(`- ${r.id}${r.linked ? ` → ${r.linked}` : ""}: ${r.text}`); }
  lines.push("", "## Resume", "", "Run the review-changes skill on the same plan (it reads this file's rows from the lavish history, not from here):", "", "```");
  for (const g of model.groups) lines.push(`review-checklist build --plan ${plan} --manifest ${relative(process.cwd(), resolve(dirname(resolve(plan)), g.manifest)) || g.manifest} --group "${g.id}"${g.session ? ` --session "${g.session}"` : ""}${g.range ? ` --range ${g.range}` : ""}`);
  lines.push(`review-checklist list --plan ${plan}`, `lavish-axi ${plan}`, `lavish-poll ${plan} --agent-reply "Resuming the review: ${open} row${open === 1 ? "" : "s"} open; start with …"`, "```", "", "Standing rules: the unit of review is the commit range; explicit-path staging only; `--reply n` under every delivered item; `lessons ingest` with every fix; hand off again with `review-checklist handoff` if you leave rows open.", "");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join("\n"));
  console.log(`${open} open row${open === 1 ? "" : "s"} · handoff written to ${out}`);
  if (args.includes("--launch")) {
    // Hand the review to a new session in a Terminal window: Manager Marcus's launch endpoint starts claude or
    // codex inside tmux in this repo with the hand-off as its first prompt, so nothing is pasted by hand.
    const provider = flag("--provider") || "claude";
    const mm = (flag("--mm") || process.env.MM_URL || "http://localhost:6161").replace(/\/$/, "");
    const prompt = `Resume the review of ${plan} (review-changes skill). Read the plan page and ${out}, then continue the loop: poll, fix per open row, reply under every item, rebuild. The hand-off follows.\n\n${lines.join("\n")}`;
    const body = { provider, cwd: process.cwd(), prompt, mode: "terminal" };
    for (const k of ["model", "effort", "permissionMode"]) if (flag(`--${k}`)) body[k] = flag(`--${k}`);
    try {
      const res = await fetch(`${mm}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(Number(flag("--timeout-ms")) || 90000) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) die(`launch failed: HTTP ${res.status} ${j.error || ""}`);
      console.log(`launched ${provider} in tmux ${j.terminal || "?"} · Terminal window ${j.terminalOpened ? "opened" : "NOT opened" + (j.terminalError ? ` (${j.terminalError})` : "")}${j.id ? ` · session ${j.id}` : ""}`);
    } catch (e) { die(`launch failed: ${e.message} (is Manager Marcus running at ${mm}?)`); }
  }
} else {
  console.log(`usage:
  review-checklist build --manifest <file> [--plan <artifact.html> | --out <file>] [--group "PR #n"] [--range a..b] [--session <name>] [--branch <b>] [--worktree <w>] [--title <t>] [--link <url>]
  review-checklist list --plan <artifact.html>
  review-checklist handoff --plan <artifact.html> [--date YYYY-MM-DD] [--out <file>] [--launch [--provider claude|codex] [--model m] [--effort e] [--mm http://localhost:6161]]
  review-checklist landed --range a..b [--base main]     exit 0 landed · 3 not landed`);
  process.exit(cmd ? 1 : 0);
}
