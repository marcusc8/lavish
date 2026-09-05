#!/usr/bin/env node
/* lavish-meta.mjs — record what happened to a plan, so the Lavish home page can show it.
 *
 * The home page table has a "Plan status" and a "PRs" column. Both read ~/.lavish-axi/registry.json,
 * which this CLI writes (the artifact's own <meta name="lavish:status|lavish:pr"> tags are read too,
 * but editing a live artifact risks a reload in the reviewer's tab; this writes a sidecar instead).
 *
 *   lavish-meta <html-file> --status in-progress --pr 536      # PR opened from this plan
 *   lavish-meta <html-file> --status merged                    # its PR(s) are on main
 *   lavish-meta <html-file> --status implemented               # verified live
 *   lavish-meta <html-file> --priority high                    # high · normal · low (home page sorts by it)
 *   lavish-meta <html-file> --retire                           # park or abandon it (status retired)
 *   lavish-meta <html-file> --progress "PR3 opened, 2 of 5 slices" [--pct 40]   # a progress note (who wrote it is recorded)
 *   lavish-meta <html-file> --progress "blocked on the GS1 prefix" --session "wt-ledger@mac"  # override the session label
 *   lavish-meta <html-file> --pr 540,541 --summary "one line"  # several PRs, override the summary
 *   lavish-meta <html-file> --unpr 999                         # remove a wrongly attached PR
 *   lavish-meta <html-file>                                    # show the record
 *
 * Statuses: not-started · in-review · approved · in-progress · merged · implemented · retired · superseded
 * (old names still accepted: draft → not-started, shipped → merged, parked → retired)
 * Stage (derived, shown on the plan page and in Lavish): Planning (not-started, in-review, approved) · Developing
 * (in-progress) · Review (merged, awaiting verification) · Done (implemented) · Parked (retired, superseded).
 * Status and PR changes log themselves; --progress adds a note. Required milestones: plan approved, each PR
 * opened, gates green, each PR merged, verified live, and any blocker.
 */
import { realpathSync } from "node:fs";
import { resolve, basename } from "node:path";
import { keyOf, readRegistry, updateRegistry, STATUSES, PRIORITIES, readHead, readVersionIndex, stageOf, subLabelOf, sessionInfo, progressSummary, agentInfo, agentLabel } from "./lavish-lib.mjs";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : String(args[i + 1] ?? ""); };
const VALUED = new Set(["--status", "--pr", "--unpr", "--summary", "--priority", "--progress", "--pct", "--session"]);
const file = args.find((a, i) => !a.startsWith("--") && !VALUED.has(args[i - 1]));
if (!file || args.includes("--help")) {
  console.log(`usage: lavish-meta <html-file> [--status <${STATUSES.join("|")}>] [--priority <${PRIORITIES.join("|")}>] [--retire] [--pr <n[,n]>] [--unpr <n[,n]>] [--summary "..."] [--progress "..."] [--pct <0-100>] [--session "<label>"]`);
  process.exit(file ? 0 : 1);
}
const absolute = realpathSync(resolve(file));
const key = keyOf(absolute);
const nums = (v) => (v || "").split(",").map((s) => Number(s.trim().replace(/^#/, ""))).filter((n) => Number.isInteger(n) && n > 0);

const patch = { file: absolute };
if (flag("--status") !== undefined) patch.status = flag("--status");
if (args.includes("--retire")) patch.status = "retired";
if (flag("--priority") !== undefined) patch.priority = flag("--priority");
if (flag("--summary") !== undefined) patch.summary = flag("--summary");
if (flag("--pr")) patch.addPrs = nums(flag("--pr"));
if (flag("--unpr")) patch.removePrs = nums(flag("--unpr"));
if (flag("--progress") !== undefined) patch.progress = flag("--progress");
if (flag("--pct") !== undefined) patch.pct = flag("--pct");
const changed = Object.keys(patch).length > 1;
if (changed) patch.session = sessionInfo(flag("--session"));
// The agent running this command (Claude session id from the environment, or the Codex thread matched by folder):
// stamped even on a read-only call, so a plan learns who is on it the first time a session touches it.
const agent = agentInfo();
if (agent) patch.agent = { ...agent, source: "meta" };
try { if (changed || agent) updateRegistry(key, patch); } catch (e) { console.error(e.message); process.exit(1); }

const rec = readRegistry()[key] || {};
const head = readHead(absolute);
const versions = readVersionIndex(key).versions.length;
console.log(`${basename(absolute)}  (session ${key})${changed ? "  — updated" : ""}`);
const prList = Object.values(rec.prs || {});
const stage = stageOf(rec.status || head.status || "");
const prog = progressSummary(rec, prList, 3);
console.log(`  stage:   ${stage.label} (${subLabelOf(rec.status || head.status || "", prList)})${prog.pct != null ? ` · ${prog.pct}%` : ""}${rec.session?.label ? ` · last writer ${rec.session.label}` : ""}`);
for (const e of prog.entries) console.log(`           ${String(e.at).slice(5, 16).replace("T", " ")}  ${(e.session?.label || "").padEnd(22).slice(0, 22)}  ${e.text}`);
console.log(`  agent:   ${rec.agent ? `${agentLabel(rec.agent)} · ${rec.agent.provider}${rec.agent.guessed ? " (guessed)" : ""} · ${rec.agent.source} · ${String(rec.agent.at).slice(0, 16).replace("T", " ")}${(rec.agents || []).length > 1 ? ` (+${rec.agents.length - 1} earlier)` : ""}` : "— (no session has polled this plan)"}`);
console.log(`  priority: ${rec.priority || "normal"}`);
console.log(`  status:  ${rec.status || (head.status ? `${head.status} (from <meta lavish:status>)` : "— (inferred on the home page)")}`);
const prs = Object.values(rec.prs || {}).map((p) => `#${p.n}${p.state ? ` ${p.state.toLowerCase()}` : ""}${p.source === "inferred" ? " (inferred)" : ""}`);
console.log(`  PRs:     ${prs.length ? prs.join(", ") : head.prs.length ? head.prs.map((n) => `#${n} (from <meta lavish:pr>)`).join(", ") : "—"}`);
console.log(`  summary: ${rec.summary || head.summary || "—"}`);
console.log(`  versions saved: ${versions}   home: http://127.0.0.1:${process.env.LAVISH_HOME_PORT || 4388}/session/${key}`);
