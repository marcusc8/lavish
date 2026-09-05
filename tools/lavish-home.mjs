#!/usr/bin/env node
/* lavish-home.mjs — a home page for every Lavish page (a local Drive of plans), plus the small APIs the Comments rail needs.
 *
 * Reads ~/.lavish-axi/state.json (the Lavish server's single store), the history files written by
 * lavish-poll, the private notes written by the Comments rail, the version snapshots, the plan
 * registry (lavish-meta; since 2026-09-04 also the AGENT link: which Claude / Codex session polled the plan)
 * and the reviewer's folders (home-layout.json), and serves:
 *
 *   /                         every plan (Drive-style, plan 2026-09-05): sidebar (All plans · Active now · projects with their plans nested ·
 *                             tags), filter popovers, one table per project (Plan · Plan status · Build · Session · Modified · Added · Actions,
 *                             more from the Columns button), 5 rows per project on the home view + Show more
 *   /?tag=<tid>|project=<p>|agent=…&stage=…&plan=…&prio=…&status=…   one tag, one project, or a filtered list
 *   /session/<key>            the plan page: stage line, Agent block + plan-status form, Resume + New session, Sessions, History,
 *                             versions (view / diff / continue from), commits, export, the conversation with private comments in place
 *   /session/<key>.md         the transcript as Markdown (download)
 *   /view/<key>/              the plan itself, read-only, no Lavish chrome, no state change; /view/<key>/<sibling asset> (siblings only)
 *   /version/<key>/<n>/       a saved version of the artifact, read-only, with its relative assets
 *   /diff/<key>/<a>/<b>       what changed between two versions (b may be "current")
 *   GET  /connect/<key>       redirects to the plan page's Resume + New session block
 *   POST /connect/<key>       Resume the plan's agent: live in tmux → bring Terminal forward · live in an editor → Lavish only ·
 *                             ended → tmux mm-<provider>-<8> running the CLI's own resume, Terminal.app attached, then Lavish.
 *                             Every refusal is a page naming the reason; a live session is never resumed twice.
 *   POST /connect/<key>?new=1 a NEW session in tmux with a prompt that opens and polls the plan (Claude or Codex)
 *   POST /effort/<key>        type /effort <level> into the plan's Claude terminal (only when idle), show the pane's reply
 *   POST /scan/<key>          Find sessions: the bounded transcript scan (D11) for this plan
 *   /version/<key>/<n>/       a saved version in an iframe + the comments, messages, replies and private notes of its window; /raw = the snapshot itself
 *   POST /restore/<key>/<n>[?then=resume|new]   put version n back onto disk (the replaced file is snapshotted first), then optionally Resume / New session
 *   POST /restart/<key>       D10: refuse if the agent is live; else end the Lavish session, mark its tabs to close, start a new agent on the plan
 *   POST /rename/<key>        rewrite the plan file's <title> (snapshotted before and after)
 *   PUT  /api/presence/<key>  {tab, title}: a Lavish tab's 10 s ping → {close: bool}; POST ?gone=1&tab= on unload; GET the open tabs
 *   POST /end/<key>?close=1   end the Lavish session and tell every tab of the plan to close itself; POST /tabs/<key>/close keeps the newest tab
 *   POST /open|end/<key>      resume / end the Lavish session
 *   POST /status/<key>        plan status · add PR · summary · progress (forms)
 *   POST /tags, /tags/<tid>, /tag/<key>   tag forms (create · rename/delete · toggle a tag on a plan)
 *   /api/layout               GET tags + counts · PUT {op: tag|untag|tag-create|tag-rename|tag-delete|order-projects|order-plans} (drag and drop)
 *   /api/notes/<key>          GET/PUT the reviewer's private comments (CORS for the Lavish chrome on :4387)
 *   /api/notes/<key>/files    PUT ?name= (raw image body) stores a private attachment; GET /:id serves it; DELETE /:id
 *   /api/registry/<key>       GET/POST plan status / PRs / summary · POST …/refresh-prs
 *   /api/versions/<key>       GET the version index · POST …/snapshot saves the file now if it changed
 *   /api/queue/<key>          GET/PUT/DELETE the rail's mirror of unsent comments, image copies and the card draft
 *   /api/export/<key>/plan.md PUT the page's own Markdown of the plan (text/plain), used by the md export
 *   /export/<key>?format=html|pdf|md&include=chat,comments,notes[&plan=0][&inline=1]
 *   /api/sessions             GET the plan list as JSON, with tags, tabs, build and agent {provider,id,state,name,model,terminal} per plan
 *   /health
 *
 * Background: every 20 s it snapshots changed artifacts (versions); every 30 min it refreshes PR states through `gh`;
 * at startup and hourly it runs the bounded transcript scan (D11). Port: LAVISH_HOME_PORT (4388). No dependencies.
 * `node lavish-home.mjs --check-contrast` runs the palette gate alone (every text/background token pair ≥ 4.5:1, both palettes).
 */
import http from "node:http";
import { existsSync, statSync, copyFileSync, readFileSync, createReadStream, mkdirSync, writeFileSync, readdirSync, unlinkSync, rmSync } from "node:fs";
import { join, basename, dirname, resolve, extname, normalize as normPath } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import os from "node:os";
import {
  stateDir, readJson, writeJsonAtomic, readHistory, appendHistory, roundOf, readNotes, writeNotes, readRegistry, updateRegistry, STATUSES, PRIORITIES, normalizeStatus,
  readVersionIndex, versionPath, snapshotVersion, extractText, diffLines, readHead, extractPrMentions,
  gitInfo, gitLogForFile, gitStatusForFile, ghPrView, sha,
  readQueue, writeQueue, deleteQueue, stageOf, subLabelOf, progressSummary, STAGES, STAGE_LABELS, decodeEntities,
  readLayout, createTag, renameTag, deleteTag, tagPlan, setProjectOrder, setPlanOrder, tagsOf, tagList, applyOrder, agentLabel,
} from "./lavish-lib.mjs";
import {
  liveClaudeSessions, liveCodexThreads, listTmux, listClients, agentState, resumeAgent, startNewAgent, sendText, capturePane, paneIdle,
  scanTranscriptsMany, scanTranscripts, readTerminals, LAUNCH_OPTIONS, defaultNewPrompt, tmuxName, CLAUDE_BIN, CODEX_BIN, TMUX_BIN, sessionInfoOf,
} from "./lavish-agent.mjs";

const PORT = Number(process.env.LAVISH_HOME_PORT || 4388);
const lavishBase = `http://127.0.0.1:${process.env.LAVISH_AXI_PORT || 4387}`;
const RENAMES = [["/Dropbox/", "/Dropbox-Personal/"]];
const STALE_DAYS = 14;
const SCAN_MS = 20_000;
const PR_REFRESH_MS = 30 * 60_000;
const PR_FRESH_MS = 6 * 3_600_000;
const AGENT_SCAN_MS = 60 * 60_000;
const LIVE_TTL_MS = 3_000;

/* ── palette: two token sets, one contrast gate ───────────────────────── */
/* Every colour the page uses is a token here. `PAIRS` lists every text/background combination the stylesheet makes;
   checkContrast() computes WCAG relative luminance for each pair in BOTH palettes and refuses to start below 4.5:1.
   Changing a colour therefore either passes the gate or stops the server with the failing pair named. */
export const PALETTES = {
  // Direction A ("Sheet", plan 2026-09-05): white ground, #f6f7f9 second surface, deep blue accent, white top bar.
  light: { paper: "#ffffff", surface: "#ffffff", tint: "#f6f7f9", hover: "#f2f4f7", ink: "#1a1d21", ink2: "#4b525a", ink3: "#626972", rule: "#e5e7eb", acc: "#1d4f91", accInk: "#ffffff", accSoft: "#e8eef7", good: "#1f7a44", goodInk: "#ffffff", goodSoft: "#e6f4ea", warn: "#8a5a00", warnSoft: "#fdf3d8", bad: "#b3261e", badSoft: "#fbe9e7", viol: "#5b3fa6", violSoft: "#ece7f8", bar: "#ffffff", barInk: "#1a1d21", barMute: "#626972", focus: "#1d4f91" },
  dark: { paper: "#15161a", surface: "#1e2026", tint: "#24262d", hover: "#282a32", ink: "#e8e6e1", ink2: "#c2beb6", ink3: "#9c988f", rule: "#2e3037", acc: "#6ea8ff", accInk: "#0b1220", accSoft: "#1f2b40", good: "#7fd69a", goodInk: "#0b1a10", goodSoft: "#1c2f24", warn: "#e2c06a", warnSoft: "#332b18", bad: "#f08a7a", badSoft: "#3a2220", viol: "#b9a8f5", violSoft: "#2a2440", bar: "#1e2026", barInk: "#e8e6e1", barMute: "#9c988f", focus: "#6ea8ff" },
};
const PAIRS = [["ink", "paper"], ["ink", "surface"], ["ink", "tint"], ["ink", "hover"], ["ink2", "paper"], ["ink2", "surface"], ["ink2", "tint"], ["ink2", "hover"], ["ink3", "paper"], ["ink3", "surface"], ["ink3", "tint"], ["ink3", "hover"],
  ["acc", "paper"], ["acc", "surface"], ["acc", "accSoft"], ["acc", "tint"], ["acc", "hover"], ["accInk", "acc"], ["good", "goodSoft"], ["good", "paper"], ["good", "surface"], ["good", "tint"], ["good", "hover"], ["goodInk", "good"], ["warn", "warnSoft"], ["warn", "paper"], ["warn", "surface"], ["warn", "tint"], ["warn", "hover"],
  ["bad", "badSoft"], ["bad", "paper"], ["bad", "surface"], ["bad", "tint"], ["bad", "hover"], ["viol", "violSoft"], ["viol", "paper"], ["viol", "surface"], ["barInk", "bar"], ["barMute", "bar"], ["barInk", "tint"], ["barMute", "tint"], ["ink3", "accSoft"], ["ink2", "accSoft"]];
const MONO = { light: { s: 45, lBg: 88, lFg: 26 }, dark: { s: 35, lBg: 24, lFg: 84 } }; // monogram discs: hsl(h s lBg) under hsl(h s lFg)
function hexRgb(h) { const s = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255); }
function hslRgb(h, s, l) { s /= 100; l /= 100; const k = (n) => (n + h / 30) % 12; const a = s * Math.min(l, 1 - l); const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return [f(0), f(8), f(4)]; }
const lum = (rgb) => rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
export const contrast = (fg, bg) => { const a = lum(fg), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
/** Every pair in both palettes, plus the monogram discs at six hues. Returns the failures (empty = pass). */
export function checkContrast(min = 4.5) {
  const fails = [];
  for (const [name, p] of Object.entries(PALETTES)) {
    for (const [fg, bg] of PAIRS) { if (!p[fg] || !p[bg]) { fails.push(`${name}: token ${p[fg] ? bg : fg} missing`); continue; } const c = contrast(hexRgb(p[fg]), hexRgb(p[bg])); if (c < min) fails.push(`${name}: ${fg} ${p[fg]} on ${bg} ${p[bg]} = ${c.toFixed(2)}:1`); }
    const m = MONO[name];
    for (const h of [0, 60, 120, 180, 240, 300]) { const c = contrast(hslRgb(h, m.s, m.lFg), hslRgb(h, m.s, m.lBg)); if (c < min) fails.push(`${name}: monogram hue ${h} = ${c.toFixed(2)}:1`); }
  }
  return fails;
}
const tokenCss = (p) => Object.entries(p).map(([k, v]) => `--${k}:${v}`).join(";");
const THEME_CSS = `:root{${tokenCss(PALETTES.light)}}:root[data-theme=dark]{${tokenCss(PALETTES.dark)}}@media(prefers-color-scheme:dark){:root:not([data-theme=light]){${tokenCss(PALETTES.dark)}}}`;
if (process.argv.includes("--check-contrast")) { const f = checkContrast(); console.log(f.length ? f.join("\n") : `contrast ok: ${PAIRS.length} pairs × ${Object.keys(PALETTES).length} palettes + monograms ≥ 4.5:1`); process.exit(f.length ? 1 : 0); }

/* ── live sessions cache (pid files, Codex locks, tmux names) ────────── */
let liveCache = { claude: [], codex: new Set(), tmux: new Set(), at: 0 };
async function refreshLive(force = false) {
  if (!force && Date.now() - liveCache.at < LIVE_TTL_MS) return liveCache;
  const tmux = await listTmux();
  liveCache = { claude: liveClaudeSessions(), codex: liveCodexThreads(), tmux, at: Date.now() };
  return liveCache;
}

/* ── presence: which Lavish tabs are open on each plan (the rail pings PUT /api/presence/<key> every 10 s; D6) ── */
const PRESENCE_TTL_MS = 30_000, PRESENCE_MARK_TTL_MS = 5 * 60_000;
const presence = new Map(); // key → Map(tab → { at: ms, title, close: "" | reason })
function presenceTabs(key) {
  const m = presence.get(key); if (!m) return [];
  const now = Date.now();
  for (const [tab, t] of m) if (now - t.at > (t.close ? PRESENCE_MARK_TTL_MS : PRESENCE_TTL_MS)) m.delete(tab);
  return [...m.entries()].map(([tab, t]) => ({ tab, ...t }));
}
const presenceCount = (key) => presenceTabs(key).filter((t) => !t.close).length;
/** Mark every tab of a plan (but `keep`) to close on its next ping. Returns how many were marked. */
function markTabs(key, reason, { keep = "" } = {}) {
  let n = 0;
  for (const t of presenceTabs(key)) if (t.tab !== keep && !t.close) { presence.get(key).get(t.tab).close = reason; n++; }
  return n;
}

/* ── data ─────────────────────────────────────────────────────────────── */
function loadSessions() {
  const state = readJson(join(stateDir, "state.json"), { sessions: {} });
  const registry = readRegistry();
  const layout = readLayout();
  return Object.entries(state.sessions || {}).map(([key, s]) => {
    const resolved = resolveFile(s.file);
    const head = resolved ? readHead(resolved) : { title: "", project: "", related: [], status: "", prs: [], summary: "", logo: "" };
    const history = readHistory(key);
    const chat = s.chat || [];
    const notes = readNotes(key).notes;
    const versions = readVersionIndex(key).versions;
    const reg = registry[key] || {};
    const unsent = readQueue(key);
    const unsentCount = unsent.items.filter((p) => !(p.tag === "message" && !p.selector) && p.tag !== "verdict").length;
    const m = /\/Development\/([^/]+)/.exec(s.file) || /\/\.codex\/(\w+)/.exec(s.file);
    const worktree = (/\/worktrees\/([^/]+)/.exec(s.file) || [])[1] || "";
    const updated = new Date(s.updated_at || 0);
    const userSent = history.filter((h) => h.role === "user").length || chat.filter((c) => c.role === "user").length;
    const agentMsgs = chat.filter((c) => c.role === "agent").length;
    const birth = (() => { try { return resolved ? statSync(resolved).birthtime.toISOString() : ""; } catch { return ""; } })();
    const added = [versions[0]?.at, history[0]?.at, birth].filter(Boolean).sort()[0] || "";
    const session = {
      key, file: s.file, resolved, exists: Boolean(resolved), moved: Boolean(resolved && resolved !== s.file),
      project: head.project || (m ? m[1] : "other"), worktree, related: head.related || [], logo: head.logo || "",
      title: head.title || basename(s.file, ".html"),
      status: s.status || "open", endedBy: s.ended_by || "", updated, url: s.url || "",
      pending: Number(s.pending_prompts || 0),
      userMsgs: chat.filter((c) => c.role === "user").length, agentMsgs, userSent,
      annotations: history.filter((h) => h.role === "user" && h.kind === "annotation").length,
      privateNotes: notes.filter((n) => n.state !== "resolved").length, notes,
      unsent, unsentCount, hasDraft: Boolean(unsent.draft && unsent.draft.card && unsent.draft.card.text),
      versions, versionCount: versions.length,
      stale: (s.status !== "ended") && (Date.now() - updated.getTime()) / 864e5 > STALE_DAYS,
      chat, history, head, reg,
      tags: tagsOf(layout, key), added, tabs: presenceCount(key),
      agent: agentState(reg, liveCache, liveCache.tmux),
      agents: Array.isArray(reg.agents) ? reg.agents : [],
    };
    const info = session.agent.state === "none" ? null : sessionInfoOf(reg.agent);
    session.agent.model = info ? info.model : ""; session.agent.startedAt = info ? info.startedAt : ""; session.agent.lastAt = info ? info.lastAt : "";
    session.plan = derivePlan(session);
    return session;
  }).sort((a, b) => b.updated - a.updated);
}
/** Plan status + PRs + summary: declared (registry, then <meta>) beats inferred (PR states, then review activity). */
function derivePlan(s) {
  const prs = {};
  for (const n of s.head.prs) prs[n] = { n, source: "declared" };
  for (const [n, rec] of Object.entries(s.reg.prs || {})) prs[n] = { ...(prs[n] || {}), ...rec, n: Number(n) };
  const agentTexts = [...s.chat.filter((c) => c.role === "agent").map((c) => c.text), ...s.history.filter((h) => h.role === "agent").map((h) => h.text)];
  for (const n of extractPrMentions(agentTexts)) if (!prs[n]) prs[n] = { n, source: "inferred" };
  const list = Object.values(prs).filter((p) => !(p.source === "inferred" && p.missing)).sort((a, b) => a.n - b.n);
  const declared = normalizeStatus(s.reg.status || s.head.status || "");
  let status = declared, inferred = false, note = "";
  if (!status) {
    inferred = true;
    if (list.length && list.every((p) => p.state === "MERGED")) status = "merged";
    else if (list.some((p) => p.state === "MERGED" || p.state === "OPEN")) status = "in-progress";
    else if (s.userSent > 0) status = "in-review";
    else status = "not-started";
  } else if (status === "in-progress" && list.length && list.every((p) => p.state === "MERGED")) {
    status = "merged"; inferred = true; note = "declared in progress; every PR is merged";
  }
  const priority = PRIORITIES.includes(s.reg.priority) ? s.reg.priority : "normal";
  const unworked = ["not-started", "in-review", "approved"].includes(status);
  const st = stageOf(status);
  const progress = progressSummary(s.reg, list, 20);
  const build = buildOf(status, list);
  const firstStatus = (want) => (s.reg.progress || []).find((e) => e.kind === "status" && e.status === want)?.at || "";
  return {
    status, inferred, note, priority, unworked, prs: list, build, completedAt: firstStatus("implemented"), retiredAt: firstStatus("retired"), summary: s.reg.summary || s.head.summary || "", webBase: s.resolved ? gitInfo(s.resolved).webBase : "",
    stage: st.stage, stageLabel: st.label, stageIndex: st.index, stageInferred: inferred, stageNote: note, subLabel: subLabelOf(status, list),
    session: s.reg.session || null, progress,
  };
}
/** Everyone who wrote progress in the last 7 days, newest first. */
function recentSessions(reg) {
  const seen = new Map();
  for (const e of (reg?.progress || []).slice().reverse()) {
    if (!e.session?.label || Date.now() - new Date(e.at).getTime() > 7 * 864e5) continue;
    if (!seen.has(e.session.label)) seen.set(e.session.label, { ...e.session, at: e.at });
  }
  return [...seen.values()];
}
function resolveFile(file) {
  if (existsSync(file)) return file;
  for (const [from, to] of RENAMES) { const c = file.replace(from, to); if (c !== file && existsSync(c)) return c; }
  return "";
}
/** The folder a New session starts in: the agent's cwd if it still exists, else the git root, else the file's folder. */
function projectCwd(s) {
  const a = s.reg?.agent?.cwd; if (a && existsSync(a)) return a;
  const root = s.resolved ? gitInfo(s.resolved).root : ""; if (root) return root;
  return dirname(s.resolved || s.file);
}
// One merged timeline: chat holds typed messages + agent replies (and, with the local server patch,
// annotation summaries); history holds everything lavish-poll delivered. Prefer history entries
// and drop chat entries that duplicate them within a minute. Each item carries the agent that was
// on the plan when it was written (history rows are stamped; chat entries adopt the current one).
function transcript(s) {
  const items = s.history.map((h) => ({ at: h.at, role: h.role, kind: h.kind, text: h.text, where: h.where, tag: h.tag, agent: h.agent || null }));
  for (const c of s.chat) {
    const twin = items.find((i) => i.role === c.role && (i.text === c.text || (c.kind === "annotation" && i.text && String(c.text).endsWith(i.text))) && (c.kind === "annotation" || Math.abs(new Date(i.at) - new Date(c.at)) < 60e3));
    if (twin) { if (String(c.at) < String(twin.at)) twin.at = c.at; continue; }
    items.push({ at: c.at, role: c.role, kind: c.kind || (c.role === "agent" ? "reply" : "message"), text: c.text, agent: null });
  }
  items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  let cur = null;
  for (const i of items) { if (i.agent && i.agent.id) cur = i.agent; else i.agent = cur; }
  return items;
}
/** The transcript cut into one group per agent session (a new group when the agent id changes), oldest first. */
function transcriptGroups(s) {
  const groups = [];
  for (const i of transcript(s)) {
    const id = i.agent?.id || "";
    const last = groups[groups.length - 1];
    if (last && last.id === id) { last.items.push(i); last.last = i.at; continue; }
    groups.push({ id, provider: i.agent?.provider || "", items: [i], first: i.at, last: i.at });
  }
  for (const g of groups) { const rec = s.agents.find((a) => a.id === g.id) || (s.reg.agent && s.reg.agent.id === g.id ? s.reg.agent : null); g.name = g.id ? (rec?.name || agentLabel({ id: g.id })) : "before the stamp existed"; g.rec = rec; }
  return groups;
}

/* ── background: version scanner + PR refresher + agent scan ─────────── */
const seenMtime = new Map();
function scanVersions() {
  try {
    const state = readJson(join(stateDir, "state.json"), { sessions: {} });
    for (const [key, s] of Object.entries(state.sessions || {})) {
      const file = resolveFile(s.file); if (!file) continue;
      let mtime; try { mtime = statSync(file).mtimeMs; } catch { continue; }
      if (seenMtime.get(key) === mtime) continue;
      seenMtime.set(key, mtime);
      const had = readVersionIndex(key).versions.length;
      snapshotVersion(file, key, { reason: had ? "scan" : "baseline", round: roundOf(key) });
    }
  } catch (e) { console.error("scanVersions:", e.message); }
}
let prRefreshRunning = false;
function refreshPrs(session, { force = false } = {}) {
  const slug = session.resolved ? gitInfo(session.resolved).slug : "";
  if (!slug) return { checked: 0, reason: "no GitHub remote for this file" };
  let checked = 0;
  const patch = { prs: {}, file: session.resolved };
  for (const p of session.plan.prs) {
    const final = p.state === "MERGED" || p.state === "CLOSED";
    const fresh = p.checkedAt && Date.now() - new Date(p.checkedAt).getTime() < PR_FRESH_MS;
    if (!force && (final || fresh)) continue;
    const r = ghPrView(slug, p.n);
    if (!r) return { checked, reason: "gh unavailable or not authenticated" };
    checked++;
    patch.prs[p.n] = r.missing
      ? { source: p.source, missing: true, checkedAt: new Date().toISOString() }
      : { source: p.source, state: r.state, title: r.title, url: r.url, mergedAt: r.mergedAt, missing: false, checkedAt: new Date().toISOString() };
  }
  if (checked) updateRegistry(session.key, patch);
  return { checked };
}
function refreshAllPrs() {
  if (prRefreshRunning) return; prRefreshRunning = true;
  try { for (const s of loadSessions()) if (s.plan.prs.length) refreshPrs(s); } catch (e) { console.error("refreshAllPrs:", e.message); } finally { prRefreshRunning = false; }
}
/** D11: link plans to the sessions that read or edited them in the last 7 days (source: scan; never displaces a real stamp). */
let agentScanRunning = false, lastAgentScan = null;
async function scanAgents({ only = null } = {}) {
  if (agentScanRunning) return lastAgentScan; agentScanRunning = true;
  const started = Date.now(); let linked = 0, plans = 0;
  try {
    const byRoot = new Map();
    for (const s of loadSessions()) { if (!s.exists || (only && s.key !== only)) continue; const root = projectCwd(s); if (!byRoot.has(root)) byRoot.set(root, []); byRoot.get(root).push({ key: s.key, path: s.resolved }); plans++; }
    for (const [root, list] of byRoot) {
      const found = await scanTranscriptsMany(list, root);
      for (const [key, hits] of Object.entries(found)) {
        if (!hits.length) continue;
        // newest first; the newest becomes the agent only when nothing real is stamped (updateRegistry enforces that)
        for (const h of hits.slice().reverse()) updateRegistry(key, { agent: { provider: h.provider, id: h.id, cwd: root, entrypoint: h.provider === "codex" ? "codex" : "", guessed: Boolean(h.guessed), source: "scan", at: h.at } });
        linked++;
      }
    }
  } catch (e) { console.error("scanAgents:", e.message); }
  finally { agentScanRunning = false; }
  lastAgentScan = { at: new Date().toISOString(), ms: Date.now() - started, plans, linked };
  console.log(`agent scan: ${plans} plans, ${linked} linked, ${lastAgentScan.ms} ms`);
  return lastAgentScan;
}

/* ── html ─────────────────────────────────────────────────────────────── */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (d) => { const t = new Date(d); if (isNaN(t)) return ""; const today = new Date().toDateString() === t.toDateString(); return today ? `today ${t.toTimeString().slice(0, 5)}` : t.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + t.toTimeString().slice(0, 5); };
const fmtDay = (d) => { const t = new Date(d); if (isNaN(t)) return ""; const today = new Date().toDateString() === t.toDateString(); return today ? `today ${t.toTimeString().slice(0, 5)}` : t.toLocaleDateString("en-US", { month: "short", day: "numeric" }); };
const ago = (d) => { const ms = Date.now() - new Date(d).getTime(); if (!Number.isFinite(ms) || ms < 0) return ""; const m = Math.round(ms / 60e3); if (m < 1) return "just now"; if (m < 60) return `${m} min ago`; const h = Math.round(m / 60); if (h < 36) return `${h} h ago`; return `${Math.round(h / 24)} d ago`; };
const kb = (b) => `${Math.round(b / 1024)} KB`;
const PRIO_RANK = { high: 0, normal: 1, low: 2 };
const glyph = (provider) => (provider === "codex" ? '<span class="pv" title="Codex">⌘</span>' : '<span class="pv" title="Claude">◆</span>');
/* Icons (inline SVG, currentColor): the sidebar's folder (closed / open), All plans, Active now, a tag. */
const ICON = {
  all: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  active: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/><path d="M4.9 4.9a10 10 0 0 1 14.2 0M7.8 7.8a6 6 0 0 1 8.4 0M4.9 19.1a10 10 0 0 0 14.2 0M7.8 16.2a6 6 0 0 0 8.4 0"/></svg>',
  folder: '<svg class="fc" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  folderOpen: '<svg class="fo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H7.5a2 2 0 0 0-1.9 1.4L3 18z"/><path d="M3 18l2.6-7.6A2 2 0 0 1 7.5 9H22l-2.7 8.1a2 2 0 0 1-1.9 1.4H5"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/></svg>',
  hide: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>',
};
/** Model ids → the names Marcus reads (CS3 moves this list to ~/.lavish-axi/models.json). */
const MODEL_NAMES = { fable: "Fable 5.1", "claude-fable-5-1": "Fable 5.1", opus: "Opus 5", "claude-opus-5": "Opus 5", sonnet: "Sonnet 5", "claude-sonnet-5": "Sonnet 5", haiku: "Haiku 4.5", "claude-haiku-4-5": "Haiku 4.5", "claude-haiku-4-5-20251001": "Haiku 4.5", "gpt-6-astra": "GPT-6 Astra", "gpt-6-sol": "GPT-6 Sol", "gpt-6-terra": "GPT-6 Terra", "gpt-6-luna": "GPT-6 Luna" };
const modelName = (id) => { const s = String(id || "").trim(); if (!s || s === "default") return ""; return MODEL_NAMES[s] || MODEL_NAMES[s.toLowerCase()] || s; };
/** The Build column (D4): what the PRs and the status say about the implementation, as a word with a rank for sorting. */
const BUILDS = [["not-started", "Not started", "mute"], ["developing", "Developing", "warn"], ["pr-open", "PR open", "acc"], ["merging", "Merging", "acc"], ["merged", "Merged", "good"], ["needs-review", "Needs review", "viol"], ["verified", "Verified", "good"]];
function buildOf(status, prs) {
  const merged = prs.filter((p) => p.state === "MERGED").length, open = prs.filter((p) => p.state === "OPEN").length;
  let key, why;
  if (status === "implemented") { key = "verified"; why = "status implemented (verified live)"; }
  else if (status === "merged") { key = "needs-review"; why = "status merged: on main, awaiting verification"; }
  else if (prs.length && merged === prs.length) { key = "merged"; why = `every PR merged (${merged})`; }
  else if (merged && open) { key = "merging"; why = `${merged} merged, ${open} open`; }
  else if (merged) { key = "merged"; why = `${merged} merged, the rest closed`; }
  else if (open) { key = "pr-open"; why = `${open} PR${open === 1 ? "" : "s"} open, none merged`; }
  else if (status === "in-progress") { key = "developing"; why = "status in progress, no PR yet"; }
  else { key = "not-started"; why = prs.length ? "PRs recorded but none open or merged" : "no PR and not in progress"; }
  const i = BUILDS.findIndex((b) => b[0] === key);
  return { key, label: BUILDS[i][1], tone: BUILDS[i][2], rank: i, why };
}
const STATUS_WORDS = { "not-started": ["Not started", "mute"], "in-review": ["In review", "acc"], approved: ["Approved", "good"], "in-progress": ["In progress", "warn"], merged: ["Merged", "good"], implemented: ["Implemented", "good"], retired: ["Retired", "mute"], superseded: ["Superseded", "mute"] };
const dotWord = (tone, label, title = "", inferred = false) => `<span class="dw ${esc(tone)}${inferred ? " inferred" : ""}" title="${esc(title)}"><i></i>${esc(label)}</span>`;
/** The columns of the plan table. `on` = shown by default; the rest are recorded and available from the Columns button. */
const COLUMNS = [
  { k: "plan", label: "Plan", w: "27%", on: true, fixed: true },
  { k: "status", label: "Plan status", w: "11%", on: true },
  { k: "build", label: "Build", w: "11%", on: true },
  { k: "session", label: "Session", w: "17%", on: true },
  { k: "modified", label: "Modified", w: "11%", on: true },
  { k: "added", label: "Added", w: "9%", on: true },
  { k: "actions", label: "Actions", w: "14%", on: true, fixed: true, nosort: true },
  { k: "tags", label: "Tags", w: "12%", on: false },
  { k: "priority", label: "Priority", w: "8%", on: false },
  { k: "project", label: "Project", w: "12%", on: false },
  { k: "completed", label: "Completed", w: "9%", on: false },
  { k: "retired", label: "Retired", w: "9%", on: false },
  { k: "versions", label: "Versions", w: "8%", on: false },
  { k: "reviews", label: "Reviews", w: "12%", on: false },
];
const CSS = `
${THEME_CSS}
*{box-sizing:border-box;min-width:0}html{color-scheme:light dark}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.45 "Schibsted Grotesk",system-ui,sans-serif}
a{color:var(--acc)}button{font:inherit}.mono{font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all}
.top{display:flex;align-items:center;gap:14px;padding:0 18px;height:48px;background:var(--bar);color:var(--barInk);border-bottom:1px solid var(--rule);position:sticky;top:0;z-index:6}.top a{color:inherit;text-decoration:none}.logo{font-weight:700;font-size:17px;letter-spacing:-.01em}.crumb{font-size:12.5px;color:var(--barMute);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sp{flex:1}
.pill{font-size:11.5px;padding:2px 9px;border-radius:999px;background:var(--tint);color:var(--ink2);white-space:nowrap}.top .lv-pill{display:inline-flex;align-items:center;gap:6px;background:transparent;color:var(--barMute);padding:0}.ld{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--good)}.lv-pill.off .ld{background:var(--bad)}
.search{flex:0 1 300px;display:flex;align-items:center;gap:6px;background:var(--tint);border-radius:8px;padding:5px 10px;color:var(--ink3)}.search input{flex:1;background:transparent;border:0;color:var(--ink);font:inherit;font-size:13px;outline:0}.search input::placeholder{color:var(--ink3)}
.tbtn{background:transparent;border:1px solid var(--rule);color:var(--barInk);border-radius:8px;padding:3px 9px;cursor:pointer;font-size:13px;line-height:1.4}.tbtn:hover{background:var(--tint)}#sideShow{display:none}html.nos #sideShow{display:inline-block}
.shell{display:grid;grid-template-columns:var(--sidew,220px) minmax(0,1fr);min-height:calc(100vh - 48px)}html.nos .shell{grid-template-columns:minmax(0,1fr)}html.nos .side{display:none}@media(max-width:900px){.shell{grid-template-columns:minmax(0,1fr)}.side{display:none}}
.side{position:sticky;top:48px;align-self:start;max-height:calc(100vh - 48px);overflow:auto;border-right:1px solid var(--rule);padding:8px 8px 40px;background:var(--surface)}.side .rzs{position:absolute;top:0;right:0;width:6px;height:100%;cursor:col-resize;z-index:2}.side .rzs:hover,.side .rzs.on{background:var(--acc);opacity:.4}
.shead{display:flex;align-items:center;gap:2px;padding:0 4px 6px}.shead button{background:none;border:0;color:var(--ink3);cursor:pointer;padding:4px 7px;border-radius:6px;font-size:14px;line-height:1;display:inline-flex;align-items:center}.shead button svg{width:15px;height:15px}.shead button:hover{background:var(--hover);color:var(--ink)}.shead .sp{flex:1}
.side h4{margin:14px 10px 4px;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);font-weight:600}
.nav{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;color:var(--ink2);text-decoration:none;font-size:13px;cursor:pointer;border:1px dashed transparent;list-style:none;min-width:0}.nav::-webkit-details-marker{display:none}.nav:hover{background:var(--hover)}.nav.on{background:var(--accSoft);color:var(--acc);font-weight:600}.nav .n{margin-left:auto;font-size:11px;color:var(--ink3);font-variant-numeric:tabular-nums;flex:0 0 auto}.nav.on .n{color:var(--acc)}.nav svg{width:16px;height:16px;flex:0 0 auto;color:var(--ink3)}.nav.on svg{color:var(--acc)}.nav .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav.over{border-color:var(--acc);background:var(--accSoft)}.nav.nodrop{opacity:.35}
.proj>summary .fo{display:none}.proj[open]>summary .fo{display:block}.proj[open]>summary .fc{display:none}.proj[draggable] summary{cursor:pointer}
.navwrap{position:relative}.nav.plan{padding:4px 10px 4px 34px;font-size:12.5px;color:var(--ink2);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nav.plan.on{font-weight:600}.hid{display:none!important}
button.more{background:none;border:0;color:var(--acc);font-size:12.5px;padding:8px 12px;cursor:pointer;text-align:left}button.more:hover{text-decoration:underline}.side button.more{padding:3px 10px 3px 34px;font-size:12px}
.newf{display:flex;gap:6px;margin:6px 10px 0}.newf input{flex:1;font:inherit;font-size:12.5px;padding:4px 7px;border:1px solid var(--rule);border-radius:7px;background:var(--paper);color:var(--ink)}.newf button{font-size:12px;padding:4px 9px;border:1px solid var(--rule);border-radius:7px;background:var(--surface);color:var(--ink2);cursor:pointer}
main{padding:16px 22px 80px;min-width:0}
.crumbs{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--ink3);margin:0 0 6px}.crumbs a{color:var(--ink2);text-decoration:none}.crumbs a:hover{text-decoration:underline}.crumbs b{color:var(--ink)}
h1{font-weight:600;font-size:22px;letter-spacing:-.01em;margin:0 0 4px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}h2{font-weight:600;font-size:16px;margin:28px 0 8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}h2 .meta{font-weight:400}.meta{color:var(--ink3);font-size:12.5px}.empty{color:var(--ink3);padding:24px 0}
.fbar{display:flex;gap:6px;align-items:center;margin:10px 0 12px;flex-wrap:wrap;position:relative;z-index:3}.fbtn{position:relative}.fbtn>summary{list-style:none;display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border:1px solid var(--rule);border-radius:999px;background:var(--surface);color:var(--ink2);font-size:12.5px;cursor:pointer;white-space:nowrap}.fbtn>summary::-webkit-details-marker{display:none}.fbtn>summary:hover{background:var(--hover)}.fbtn.on>summary{border-color:var(--acc);color:var(--acc);background:var(--accSoft)}.fbtn[open]>summary{border-color:var(--ink3)}.fbtn .ch{font-size:10px;opacity:.8}
.pop{position:absolute;left:0;top:calc(100% + 6px);min-width:220px;max-width:340px;background:var(--surface);border:1px solid var(--rule);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.14);padding:8px;display:flex;flex-direction:column;gap:2px;z-index:7}.pop.right{left:auto;right:0}.pop a{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 9px;border-radius:7px;color:var(--ink2);text-decoration:none;font-size:13px}.pop a:hover{background:var(--hover)}.pop a.on{background:var(--accSoft);color:var(--acc);font-weight:600}.pop .n{font-size:11px;color:var(--ink3);font-variant-numeric:tabular-nums}.pop .h{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);padding:4px 9px 2px}
.pop label{display:flex;align-items:center;gap:8px;padding:5px 9px;font-size:13px;color:var(--ink2);cursor:pointer;border-radius:7px}.pop label:hover{background:var(--hover)}.pop label.fixed{opacity:.55;cursor:default}
.grp{margin:22px 0 6px;font-size:13px;color:var(--ink);font-weight:600;display:flex;align-items:center;gap:8px}.grp a{color:inherit;text-decoration:none}.grp a:hover{text-decoration:underline}.grp span{color:var(--ink3);font-weight:400;font-size:12px}
.tw{overflow-x:auto}table{width:100%;border-collapse:separate;border-spacing:0;background:var(--surface);border:1px solid var(--rule);border-radius:10px;table-layout:fixed}th{position:relative;text-align:left;font-size:11px;color:var(--ink3);font-weight:600;padding:8px 12px;border-bottom:1px solid var(--rule);text-transform:uppercase;letter-spacing:.05em;white-space:nowrap;overflow:hidden;user-select:none}th .rz{position:absolute;top:0;right:-3px;width:7px;height:100%;cursor:col-resize;user-select:none}th .rz:hover,th .rz.on{background:var(--acc);opacity:.5}th .sa{margin-left:4px;color:var(--acc)}
td{padding:0 12px;height:44px;border-bottom:1px solid var(--rule);vertical-align:middle;font-size:13px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}tr:last-child td{border-bottom:none}tbody tr:hover{background:var(--hover)}tbody tr.drag{opacity:.5}tr.retired td{opacity:.6}tr.hit td{box-shadow:inset 3px 0 var(--acc)}tbody tr:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.off{display:none}
td.name{font-weight:600}td.name .t{display:flex;align-items:center;gap:8px;min-width:0}td.name .t a{color:var(--ink);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}td.name .t a:hover{text-decoration:underline}.vn{font-size:11px;color:var(--ink3);font-weight:500;font-family:"IBM Plex Mono",ui-monospace,monospace;flex:0 0 auto}
.hc{position:relative;min-width:0}.card{display:none;z-index:8;width:400px;max-width:70vw;background:var(--surface);border:1px solid var(--rule);border-radius:10px;padding:10px 12px;box-shadow:0 8px 28px rgba(0,0,0,.14);font-weight:400;font-size:12.5px;color:var(--ink2);white-space:normal;line-height:1.45;text-align:left;font-family:"Schibsted Grotesk",system-ui,sans-serif}.hc .card{position:absolute;left:0;top:calc(100% + 6px)}.hc:hover .card,.hc:focus-within .card{display:block}.card.portal{display:block;position:fixed}.card p{margin:0 0 6px}.card .k{color:var(--ink3);font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-right:4px}
.dw{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;max-width:100%}.dw i{width:8px;height:8px;border-radius:50%;background:var(--ink3);flex:0 0 auto}.dw.acc i{background:var(--acc)}.dw.good i{background:var(--good)}.dw.warn i{background:var(--warn)}.dw.bad i{background:var(--bad)}.dw.viol i{background:var(--viol)}.dw.inferred i{background:transparent;border:1.5px dashed currentColor}.dw.mute{color:var(--ink3)}
.sw{position:relative;display:block}.sw select.inline{position:absolute;left:-6px;top:50%;transform:translateY(-50%);opacity:0;width:calc(100% + 12px);max-width:none}.sw:hover select.inline,.sw select.inline:focus{opacity:1;background:var(--surface);border-color:var(--rule);color:var(--ink)}
select.inline{font:inherit;font-size:12.5px;padding:2px 4px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--ink2);cursor:pointer;max-width:150px}
.prio{display:inline-block;font-size:10.5px;padding:0 6px;border-radius:999px;font-weight:600;white-space:nowrap;border:1px solid var(--rule);color:var(--ink3);flex:0 0 auto}.prio.high{border-color:var(--bad);color:var(--bad)}.prio.low{opacity:.7}
.pr{display:inline-block;font-size:11.5px;font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;padding:0 6px;border-radius:4px;border:1px solid var(--rule);margin:0 4px 3px 0;text-decoration:none;color:var(--acc);white-space:nowrap;background:var(--surface)}.pr.MERGED{border-color:var(--good);color:var(--good)}.pr.OPEN{border-color:var(--warn);color:var(--warn)}.pr.CLOSED{border-color:var(--bad);color:var(--bad);text-decoration:line-through}.pr.inferred{border-style:dashed}
.num{font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--ink2)}
.a,button.a{color:var(--acc);text-decoration:none;text-underline-offset:2px;cursor:pointer;margin-right:10px;white-space:nowrap;background:none;border:0;font:inherit;font-size:13px;padding:0}.a:hover{text-decoration:underline}form.inline{display:inline}
td.acts{overflow:visible}button.dots{background:none;border:0;cursor:pointer;color:var(--ink2);padding:0 6px;border-radius:6px;font-weight:700;letter-spacing:.08em;font-size:14px;line-height:1.2}button.dots:hover{background:var(--tint)}.menu.src{display:none}
.menu{min-width:230px;background:var(--surface);border:1px solid var(--rule);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.16);padding:6px;font-weight:400;text-align:left;white-space:nowrap;font-size:13px}.menu a,.menu button,.menu summary{display:flex;width:100%;align-items:center;justify-content:space-between;gap:12px;padding:6px 10px;border-radius:7px;color:var(--ink);background:none;border:0;font:inherit;font-size:13px;text-decoration:none;cursor:pointer;text-align:left;margin:0;list-style:none}.menu a:hover,.menu button:hover,.menu summary:hover{background:var(--hover)}.menu summary::-webkit-details-marker{display:none}.menu hr{border:0;border-top:1px solid var(--rule);margin:5px 4px}.menu .danger{color:var(--bad)}.menu form{display:block}.menu details{position:relative}.menu details .sub{position:absolute;left:100%;top:-6px;margin-left:2px;min-width:180px;max-height:300px;overflow:auto;background:var(--surface);border:1px solid var(--rule);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.16);padding:6px;z-index:1}.menu .sub button.on::after{content:"\\2713";color:var(--acc)}.menu .k{color:var(--ink3);font-size:11px}
.cmenu{position:fixed;z-index:20}
.ag{display:flex;align-items:center;gap:6px;white-space:nowrap;font-size:13px;min-width:0}.ag .pv{color:var(--ink3);font-size:11px;flex:0 0 auto}.ag.active{color:var(--ink);font-weight:600}.ag.ended{color:var(--ink2)}.ag.none{color:var(--ink3)}.ag .name{font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis}.ag.guessed .name{border-bottom:1px dotted currentColor}.ag.scan .name{border:1px dotted currentColor;border-radius:4px;padding:0 3px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--good);box-shadow:0 0 0 0 var(--good);animation:pulse 1.8s infinite;flex:0 0 auto}@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--good) 60%,transparent)}70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}
.lv{display:block;font-size:11.5px;color:var(--ink3);margin-top:1px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;font-weight:400}
.st{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;font-weight:600;white-space:nowrap}.st.open{background:var(--accSoft);color:var(--acc)}.st.ended{background:var(--tint);color:var(--ink3)}.st.orphan{background:var(--badSoft);color:var(--bad)}.st.stale{background:var(--warnSoft);color:var(--warn)}
.tags .tg1{display:inline-block;font-size:11px;padding:1px 8px;border-radius:999px;background:var(--tint);color:var(--ink2);margin-right:4px;text-decoration:none}.tags .tg1:hover{background:var(--accSoft);color:var(--acc)}
.stageline{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:10px 0 18px;font-size:12.5px;color:var(--ink3)}.stage-steps{display:flex;gap:4px;margin:0}.stage-steps span{padding:4px 12px;border-radius:999px;background:var(--tint);color:var(--ink3);font-size:12px;white-space:nowrap}.stage-steps span.past{background:var(--accSoft);color:var(--acc)}.stage-steps span.now{background:var(--acc);color:var(--accInk);font-weight:600}.stage-steps span.now.inferred{outline:2px dashed var(--acc);outline-offset:-2px;background:var(--surface);color:var(--acc)}
.twoCol{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start}@media(max-width:1000px){.twoCol{grid-template-columns:minmax(0,1fr)}}
.box{background:var(--surface);border:1px solid var(--rule);border-radius:10px;padding:14px 16px;font-size:13px;min-width:0}.box h3{margin:0 0 10px;font-size:13.5px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}.box h3 .meta{font-weight:400}
.kv{display:grid;grid-template-columns:96px minmax(0,1fr);gap:6px 10px;font-size:13px;margin:6px 0 10px}.kv .k{color:var(--ink3)}.kv>span{min-width:0;overflow-wrap:anywhere}
.xform{display:grid;gap:8px;font-size:13px}.xform .row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.xform label{display:inline-flex;align-items:center;gap:6px}.xform input,.xform select,.xform textarea,.box select,.box input[type=text],.box input[type=number]{font:inherit;font-size:12.5px;padding:4px 7px;border:1px solid var(--rule);border-radius:7px;background:var(--paper);color:var(--ink)}.xform textarea{width:100%;min-height:64px;resize:vertical}.xform+.xform{margin-top:14px;padding-top:14px;border-top:1px solid var(--rule)}
button.b{font:inherit;font-size:12.5px;padding:5px 11px;border:1px solid var(--acc);border-radius:7px;background:var(--acc);color:var(--accInk);cursor:pointer}button.b.q{background:var(--surface);color:var(--acc)}button.b:disabled{opacity:.5;cursor:default}
.notice{background:var(--goodSoft);border:1px solid var(--good);color:var(--good);padding:8px 12px;border-radius:8px;margin:12px 0;font-size:13px}.notice.warn{background:var(--warnSoft);border-color:var(--warn);color:var(--warn)}.notice.bad{background:var(--badSoft);border-color:var(--bad);color:var(--bad)}
.msg{margin:0 0 10px;padding:8px 11px;border-radius:8px;background:var(--tint);max-width:72ch;white-space:pre-wrap}.msg.agent{background:var(--accSoft)}.msg.ann{background:var(--warnSoft)}.msg.sys{background:var(--tint);color:var(--ink2)}.msg.priv{background:var(--surface);border:1px dashed var(--rule)}.msg small{display:block;font-size:10.5px;color:var(--ink3);margin-bottom:2px;white-space:normal}
.tg{border:1px solid var(--rule);border-radius:10px;background:var(--surface);margin:0 0 12px}.tg summary{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;list-style:none;font-size:13px}.tg summary::-webkit-details-marker{display:none}.tg summary .who{font-weight:600;font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:12px}.tg summary .when{color:var(--ink3);font-size:12px;margin-left:auto;white-space:nowrap}.tg .body{padding:6px 12px 10px;border-top:1px solid var(--rule)}
.note{border-left:3px solid var(--rule);background:var(--surface);border-radius:0 8px 8px 0;padding:8px 11px;margin:0 0 8px;font-size:13px;white-space:normal}.note .anc{color:var(--ink3);font-size:12px;font-style:italic}.note.sent{border-left-color:var(--good)}.note.resolved{opacity:.6}.note .reply{margin-top:5px;padding:4px 8px;background:var(--tint);border-radius:6px;color:var(--ink2);font-size:12.5px}
.diff{font:12.5px/1.5 "IBM Plex Mono",ui-monospace,Menlo,monospace;background:var(--surface);border:1px solid var(--rule);border-radius:8px;overflow:hidden}.diff div{padding:1px 12px;white-space:pre-wrap;word-break:break-word}.diff .add{background:var(--goodSoft);color:var(--good)}.diff .del{background:var(--badSoft);color:var(--bad);text-decoration:line-through}.diff details{border-top:1px solid var(--rule);border-bottom:1px solid var(--rule)}.diff summary{padding:3px 12px;color:var(--ink3);cursor:pointer;background:var(--paper);font-size:12px}
.legend{font-size:12px;color:var(--ink2);margin:6px 0 12px}.legend b{font-weight:600}
.tl td{height:auto;padding:8px 12px;white-space:normal;vertical-align:top}.tl td.sess .ag{display:inline-flex;max-width:100%}.tl td.num{color:var(--ink3)}.tl .sess{font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--ink2)}
.vt table{min-width:760px}.vt td{white-space:normal;height:auto;padding:8px 12px}
.thumbs{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}.thumbs img{width:64px;height:64px;object-fit:cover;border-radius:6px;border:1px solid var(--rule);display:block}
.vcomments summary{cursor:pointer;color:var(--acc);font-size:12.5px;white-space:nowrap}.vcomments .note{margin:6px 0 0;max-width:520px;font-size:12.5px}.vcomments .note .anc{font-size:11.5px}
pre.pane{background:#1a1d21;color:#e8e6e1;padding:10px 12px;border-radius:8px;font:12px/1.4 "IBM Plex Mono",ui-monospace,Menlo,monospace;overflow-x:auto;max-width:900px;white-space:pre-wrap}
details.fold{margin:8px 0}details.fold>summary{cursor:pointer;color:var(--acc);font-size:13px;list-style:none}details.fold>summary::-webkit-details-marker{display:none}details.fold>summary::before{content:"\\203A";display:inline-block;margin-right:6px;transition:transform .12s}details.fold[open]>summary::before{transform:rotate(90deg)}details.fold .in{margin:8px 0 0}
.errpage{max-width:640px;margin:60px auto;padding:0 20px}.errpage h1{font-size:22px}.errpage p{font-size:15px}
`;
const CLIENT_JS = `
(function(){
  var KEY="lavish-home:theme",W="lavish-home:cols",COLK="lavish-home:columns",SORTK="lavish-home:sort",SIDEW="lavish-home:side",SIDEH="lavish-home:side-hidden",PROJK="lavish-home:proj";
  function ls(k,d){try{var v=localStorage.getItem(k);return v===null?d:JSON.parse(v);}catch(e){return d;}}function lsSet(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}}
  function apply(t){if(t)document.documentElement.setAttribute("data-theme",t);else document.documentElement.removeAttribute("data-theme");}
  try{apply(localStorage.getItem(KEY)||"");}catch(e){}
  var tb=document.getElementById("themeToggle");
  if(tb)tb.addEventListener("click",function(){var cur=document.documentElement.getAttribute("data-theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");var next=cur==="dark"?"light":"dark";apply(next);try{localStorage.setItem(KEY,next);}catch(e){}});
  var isHome=document.body.dataset.view==="all";
  /* show more: on the home view each project shows 5 rows; the button reveals 10 more (rows keep their sorted order) */
  var shown={};
  function applyMore(t){if(!isHome||!t.dataset.grp)return;var n=shown[t.dataset.grp]||5;var rows=[].slice.call(t.querySelectorAll("tbody tr[data-key]"));rows.forEach(function(r,i){r.classList.toggle("hid",i>=n);});var b=t.parentNode.nextElementSibling;if(b&&b.matches("button.more")){var left=rows.length-n;b.classList.toggle("hid",left<=0);b.textContent="Show "+Math.min(10,left)+" more";}}
  document.querySelectorAll("button.more[data-grp]").forEach(function(b){b.addEventListener("click",function(){var t=document.querySelector('table[data-grp="'+b.dataset.grp+'"]');if(!t)return;shown[b.dataset.grp]=(shown[b.dataset.grp]||5)+10;applyMore(t);});});
  /* search: filter rows by their text; a search shows every match regardless of Show more */
  var q=document.getElementById("q");
  if(q)q.addEventListener("input",function(){var s=q.value.trim().toLowerCase();document.querySelectorAll("tbody tr[data-key]").forEach(function(tr){tr.style.display=!s||tr.textContent.toLowerCase().indexOf(s)!==-1?"":"none";if(s)tr.classList.remove("hid");});document.querySelectorAll("table[data-cols]").forEach(function(t){if(!s)applyMore(t);var any=[].some.call(t.querySelectorAll("tbody tr[data-key]"),function(r){return r.style.display!=="none"&&!r.classList.contains("hid")});var g=t.parentNode.previousElementSibling;if(g&&g.classList.contains("grp"))g.style.display=any?"":"none";t.parentNode.style.display=any?"":"none";var b=t.parentNode.nextElementSibling;if(b&&b.matches("button.more"))b.style.display=s?"none":"";});});
  /* columns: which are shown (localStorage) + widths per column (localStorage) */
  var COLS=window.__COLS||[],colPref=ls(COLK,{})||{},saved=ls(W,{})||{};
  function colOn(c){return colPref[c.k]!==undefined?!!colPref[c.k]:!!c.on;}
  function applyCols(){document.querySelectorAll("table[data-cols]").forEach(function(t){COLS.forEach(function(c){var on=colOn(c);t.querySelectorAll('[data-col="'+c.k+'"]').forEach(function(el){if(el.tagName==="COL"){el.style.width=on?(saved[c.k]?saved[c.k]+"px":el.dataset.w||""):"0";}else el.classList.toggle("off",!on);});});});document.querySelectorAll("#colsPop input").forEach(function(i){var c=COLS.filter(function(x){return x.k===i.value})[0];if(c)i.checked=colOn(c);});}
  applyCols();
  document.querySelectorAll("#colsPop input").forEach(function(i){i.addEventListener("change",function(){colPref[i.value]=i.checked;lsSet(COLK,colPref);applyCols();});});
  document.querySelectorAll("table[data-cols]").forEach(function(t){
    t.querySelectorAll("th .rz").forEach(function(h){h.addEventListener("mousedown",function(e){e.preventDefault();e.stopPropagation();var th=h.parentNode,name=th.dataset.col,col=t.querySelector('col[data-col="'+name+'"]'),x0=e.clientX,w0=th.getBoundingClientRect().width;h.classList.add("on");
      function mv(ev){var w=Math.max(70,w0+ev.clientX-x0);if(col)col.style.width=w+"px";saved[name]=Math.round(w);}
      function up(){document.removeEventListener("mousemove",mv);document.removeEventListener("mouseup",up);h.classList.remove("on");lsSet(W,saved);}
      document.addEventListener("mousemove",mv);document.addEventListener("mouseup",up);});});});
  /* sort: double-click a header (asc, desc, then back to newest-first); remembered per browser; status columns sort by their stage order */
  var SORT=ls(SORTK,{col:"",dir:""})||{col:"",dir:""};
  var NUM=/^-?[0-9]+([.][0-9]+)?$/;
  function sortTable(t){var tb=t.tBodies[0];if(!tb)return;var rows=[].slice.call(tb.querySelectorAll("tr[data-key]"));rows.sort(function(a,b){var d=(+a.dataset.i)-(+b.dataset.i);if(!SORT.col)return d;var x=a.getAttribute("data-s-"+SORT.col)||"",y=b.getAttribute("data-s-"+SORT.col)||"";var c=NUM.test(x)&&NUM.test(y)?parseFloat(x)-parseFloat(y):x.localeCompare(y);if(!c)return d;return SORT.dir==="desc"?-c:c;});rows.forEach(function(r){tb.appendChild(r);});t.querySelectorAll("th .sa").forEach(function(s){s.remove();});if(SORT.col){var th=t.querySelector('th[data-col="'+SORT.col+'"]');if(th)th.insertAdjacentHTML("beforeend",'<span class="sa" aria-hidden="true">'+(SORT.dir==="desc"?"\\u2193":"\\u2191")+'</span>');}applyMore(t);}
  function sortAll(){document.querySelectorAll("table[data-cols]").forEach(sortTable);}
  document.querySelectorAll("table[data-cols] th[data-col]").forEach(function(th){if(th.dataset.nosort!==undefined)return;th.title=(th.title?th.title+" · ":"")+"Double-click to sort";th.addEventListener("dblclick",function(e){if(e.target.classList.contains("rz"))return;var k=th.dataset.col;if(SORT.col!==k)SORT={col:k,dir:"asc"};else if(SORT.dir==="asc")SORT={col:k,dir:"desc"};else SORT={col:"",dir:""};lsSet(SORTK,SORT);sortAll();});});
  sortAll();
  /* hover card as a portal: on hover the card moves to <body> with fixed coordinates, so no table wrapper clips it */
  var portal=null,portalHome=null,hideT=null;
  function cancelHide(){if(hideT){clearTimeout(hideT);hideT=null;}}
  function hideCard(){if(!portal)return;portal.classList.remove("portal");portal.style.left=portal.style.top=portal.style.width="";portalHome.parent.insertBefore(portal,portalHome.next);portal=null;portalHome=null;}
  function scheduleHide(){cancelHide();hideT=setTimeout(hideCard,140);}
  function showCard(hc){var card=hc.querySelector(".card");if(!card)return;if(portal===card)return;hideCard();var r=hc.getBoundingClientRect();portalHome={parent:card.parentNode,next:card.nextSibling};document.body.appendChild(card);card.classList.add("portal");var w=Math.min(400,Math.floor(innerWidth*0.7));card.style.width=w+"px";var inSide=!!hc.closest(".side");card.style.left=Math.max(8,Math.min(inSide?r.right+12:r.left,innerWidth-w-12))+"px";card.style.top=(inSide?r.top:r.bottom+6)+"px";var ch=card.getBoundingClientRect().height;if(parseFloat(card.style.top)+ch>innerHeight-8)card.style.top=Math.max(8,(inSide?r.bottom:r.top-6)-ch)+"px";portal=card;
    if(!card.dataset.wired){card.dataset.wired="1";card.addEventListener("mouseenter",cancelHide);card.addEventListener("mouseleave",scheduleHide);}}
  document.querySelectorAll(".hc").forEach(function(hc){hc.addEventListener("mouseenter",function(){cancelHide();showCard(hc);});hc.addEventListener("mouseleave",scheduleHide);hc.addEventListener("focusin",function(){cancelHide();showCard(hc);});hc.addEventListener("focusout",scheduleHide);});
  addEventListener("scroll",hideCard,true);
  /* context menu: right-click a row (or Shift+F10 / the ⋯ button) opens the row's menu at the pointer */
  var cm=null;function closeCm(){if(cm){cm.remove();cm=null;}}
  function openCm(tr,x,y){closeCm();var src=tr.querySelector(".menu.src");if(!src)return;cm=document.createElement("div");cm.className="cmenu";var m=src.cloneNode(true);m.classList.remove("src");cm.appendChild(m);document.body.appendChild(cm);var r=m.getBoundingClientRect();cm.style.left=Math.max(4,Math.min(x,innerWidth-r.width-8))+"px";cm.style.top=Math.max(4,Math.min(y,innerHeight-r.height-8))+"px";var f=m.querySelector("a,button");if(f)f.focus();}
  document.querySelectorAll("tr[data-key]").forEach(function(tr){tr.addEventListener("contextmenu",function(e){if(e.target.closest("a,button,select,input,textarea"))return;e.preventDefault();openCm(tr,e.clientX,e.clientY);});
    tr.addEventListener("keydown",function(e){if((e.key==="F10"&&e.shiftKey)||e.key==="ContextMenu"){e.preventDefault();var r=tr.getBoundingClientRect();openCm(tr,r.left+60,r.bottom-4);}});
    var d=tr.querySelector("button.dots");if(d)d.addEventListener("click",function(e){e.stopPropagation();if(cm){closeCm();return;}var r=d.getBoundingClientRect();openCm(tr,r.right-230,r.bottom+4);});});
  document.addEventListener("click",function(e){if(cm&&!cm.contains(e.target))closeCm();document.querySelectorAll("details.fbtn[open]").forEach(function(d){if(!d.contains(e.target))d.open=false;});});
  document.addEventListener("keydown",function(e){if(e.key==="Escape"){closeCm();document.querySelectorAll("details.fbtn[open]").forEach(function(d){d.open=false;});hideCard();}});
  /* sidebar: hide/show, resize, project collapse (remembered), Show more per project, ← → between plans */
  var html=document.documentElement,side=document.querySelector(".side"),shell=document.querySelector(".shell");
  var sw=ls(SIDEW,0);if(sw&&shell)shell.style.setProperty("--sidew",sw+"px");
  function setHidden(h){html.classList.toggle("nos",h);lsSet(SIDEH,h?"1":"0");try{localStorage.setItem(SIDEH,h?"1":"0");}catch(e){}}
  var hb=document.getElementById("sideHide");if(hb)hb.addEventListener("click",function(){setHidden(true);});
  var sb=document.getElementById("sideShow");if(sb)sb.addEventListener("click",function(){setHidden(false);});
  var rz=document.querySelector(".side .rzs");if(rz&&shell)rz.addEventListener("mousedown",function(e){e.preventDefault();var x0=e.clientX,w0=side.getBoundingClientRect().width;rz.classList.add("on");
    function mv(ev){var w=Math.max(180,Math.min(420,w0+ev.clientX-x0));shell.style.setProperty("--sidew",w+"px");sw=Math.round(w);}
    function up(){document.removeEventListener("mousemove",mv);document.removeEventListener("mouseup",up);rz.classList.remove("on");lsSet(SIDEW,sw);}
    document.addEventListener("mousemove",mv);document.addEventListener("mouseup",up);});
  var projPref=ls(PROJK,{})||{};
  document.querySelectorAll("details.proj").forEach(function(d){var n=d.dataset.proj;if(projPref[n]===false)d.open=false;d.addEventListener("toggle",function(){projPref[n]=d.open;lsSet(PROJK,projPref);});
    var plans=[].slice.call(d.querySelectorAll(".navwrap")),more=d.querySelector("button.more"),n5=5;function show(){plans.forEach(function(p,i){p.classList.toggle("hid",i>=n5);});if(more){more.classList.toggle("hid",plans.length<=n5);more.textContent="Show "+Math.min(10,plans.length-n5)+" more";}}
    if(more)more.addEventListener("click",function(e){e.preventDefault();n5+=10;show();});show();});
  function planLinks(){return [].slice.call(document.querySelectorAll(".side a.plan"));}
  function step(dir){var links=planLinks();if(!links.length)return;var cur=document.body.dataset.key||"";var i=-1;links.forEach(function(a,j){if(a.dataset.key===cur)i=j;});var j=i<0?(dir>0?0:links.length-1):(i+dir+links.length)%links.length;location.href=links[j].getAttribute("href");}
  var pb=document.getElementById("prevPlan"),nb=document.getElementById("nextPlan");if(pb)pb.addEventListener("click",function(){step(-1);});if(nb)nb.addEventListener("click",function(){step(1);});
  document.addEventListener("keydown",function(e){if(e.metaKey||e.ctrlKey||e.altKey)return;var t=e.target;if(t&&(t.tagName==="INPUT"||t.tagName==="TEXTAREA"||t.tagName==="SELECT"||t.isContentEditable))return;if(e.key==="ArrowLeft")step(-1);else if(e.key==="ArrowRight")step(1);});
  /* drag and drop (PUT /api/layout): a plan (row or sidebar) onto a tag = tag it; a sidebar plan onto another plan of the same project = reorder; a project onto a project = reorder */
  var dragging=null;
  document.querySelectorAll("[data-drag]").forEach(function(el){el.addEventListener("dragstart",function(e){dragging=el.dataset.drag;e.dataTransfer.setData("text/plain",dragging);e.dataTransfer.effectAllowed="move";el.classList.add("drag");e.stopPropagation();});
    el.addEventListener("dragend",function(){el.classList.remove("drag");dragging=null;document.querySelectorAll(".over").forEach(function(t){t.classList.remove("over");});});});
  function canDrop(src,target){if(!src||!target)return false;if(src.indexOf("plan:")===0)return target.indexOf("tag:")===0||(target.indexOf("planslot:")===0&&target.slice(9)!==src.slice(5));if(src.indexOf("project:")===0)return target.indexOf("project:")===0&&target!==src;return false;}
  document.querySelectorAll("[data-drop]").forEach(function(t){t.addEventListener("dragover",function(e){if(!canDrop(dragging,t.dataset.drop))return;e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect="move";t.classList.add("over");});
    t.addEventListener("dragleave",function(){t.classList.remove("over");});
    t.addEventListener("drop",function(e){e.preventDefault();e.stopPropagation();t.classList.remove("over");var src=e.dataTransfer.getData("text/plain")||dragging;var target=t.dataset.drop;if(!canDrop(src,target))return;var body=null;
      if(src.indexOf("plan:")===0&&target.indexOf("tag:")===0)body={op:"tag",key:src.slice(5),tid:target.slice(4)};
      else if(src.indexOf("plan:")===0){var wa=document.querySelector('.side .navwrap[data-drop="planslot:'+src.slice(5)+'"]'),wb=t;if(!wa||wa.parentNode!==wb.parentNode)return;wa.parentNode.insertBefore(wa,wb);body={op:"order-plans",project:wa.parentNode.dataset.proj,keys:[].map.call(wa.parentNode.querySelectorAll(".navwrap"),function(w){return w.dataset.drop.slice(9);})};}
      else{var pa=document.querySelector('details.proj[data-proj="'+CSS.escape(src.slice(8))+'"]'),pb=t.closest("details.proj");if(!pa||!pb||pa===pb)return;pb.parentNode.insertBefore(pa,pb);body={op:"order-projects",names:[].map.call(document.querySelectorAll("details.proj"),function(d){return d.dataset.proj;})};}
      fetch("/api/layout",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(function(j){if(j.error){alert(j.error);return;}
        Object.keys(j.counts||{}).forEach(function(id){document.querySelectorAll('[data-count="'+id+'"]').forEach(function(n){n.textContent=j.counts[id];});});
        if(body.op==="tag"){var tr=document.querySelector('tr[data-key="'+body.key+'"]');if(tr){var cell=tr.querySelector('td[data-col="tags"]');if(cell)cell.innerHTML=j.tagsHtml||"";}}
        else location.reload();
      }).catch(function(){alert("Could not save: the home page did not answer.");});});});
})();`;
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">`;
const page = (title, crumb, body, serverUp, { pills = "", sidebar = "", layout = null, view = "", key = "", wide = false } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${FONTS}<style>${CSS}</style><script>try{var t=localStorage.getItem("lavish-home:theme");if(t)document.documentElement.setAttribute("data-theme",t);if(localStorage.getItem("lavish-home:side-hidden")==="1"||localStorage.getItem("lavish-home:side-hidden")==='"1"')document.documentElement.classList.add("nos");}catch(e){}</script></head><body${view ? ` data-view="${esc(view)}"` : ""}${key ? ` data-key="${esc(key)}"` : ""}>
<div class="top">${sidebar ? `<button class="tbtn" id="sideShow" type="button" title="Show the sidebar">☰</button>` : ""}<a class="logo" href="/">Lavish</a><span class="crumb">${esc(crumb)}</span><span class="sp"></span>${sidebar && view ? '<div class="search"><span aria-hidden="true">⌕</span><input id="q" type="search" placeholder="Search plans" autocomplete="off"></div>' : ""}${pills}<button class="tbtn" id="themeToggle" type="button" title="Light / dark (follows the system until you pick; saved in this browser)" aria-label="Toggle theme">◐</button><span class="pill lv-pill ${serverUp ? "on" : "off"}" title="The Lavish server on :${process.env.LAVISH_AXI_PORT || 4387}"><span class="ld"></span>lavish ${serverUp ? "up" : "down"}</span></div>
${sidebar ? `<div class="shell"><aside class="side">${sidebar}<div class="rzs" title="Drag to resize the sidebar"></div></aside><main>${body}</main></div>` : `<main style="${wide ? "padding:0" : "max-width:1280px;margin:0 auto"}">${body}</main>`}
<script>window.__LAYOUT=${JSON.stringify(layout ? { tags: layout.tags } : { tags: {} }).replace(/<\//g, "<\\/")};window.__COLS=${JSON.stringify(COLUMNS.map((c) => ({ k: c.k, on: c.on })))};${CLIENT_JS}</script></body></html>`;
const errorPage = (title, message, { back = "/", extra = "" } = {}, serverUp = true) => page(title, title, `<div class="errpage"><h1>${esc(title)}</h1><p>${esc(message)}</p>${extra}<p class="meta"><a class="a" href="${esc(back)}">← Back</a></p></div>`, serverUp);

function planChip(plan) {
  const [label, tone] = STATUS_WORDS[plan.status] || [plan.status.replace("-", " "), "mute"];
  const title = plan.note ? plan.note : plan.inferred ? "Inferred from PR states and review activity. Set it with lavish-meta, in the row, or on the plan page." : "Declared with lavish-meta or <meta name=lavish:status>";
  return dotWord(tone, label, title, plan.inferred);
}
function prChips(plan) {
  if (!plan.prs.length) return `<span class="num">–</span>`;
  return plan.prs.map((p) => {
    const href = p.url || (plan.webBase ? `${plan.webBase}/pull/${p.n}` : "");
    const title = [p.title, p.state ? p.state.toLowerCase() + (p.mergedAt ? ` ${fmtDay(p.mergedAt)}` : "") : "state unknown", p.source === "inferred" ? "mentioned in an agent reply (inferred)" : "declared"].filter(Boolean).join(" · ");
    const inner = `#${p.n}${p.state ? ` <span style="font-weight:400">${esc(p.state === "MERGED" ? "merged" : p.state.toLowerCase())}</span>` : ""}`;
    return href ? `<a class="pr ${esc(p.state || "")}${p.source === "inferred" ? " inferred" : ""}" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(title)}">${inner}</a>` : `<span class="pr ${p.source === "inferred" ? "inferred" : ""}" title="${esc(title)}">${inner}</span>`;
  }).join("");
}
/** Where the agent lives right now, as a word: VS Code · terminal · Desktop · ended 2 d ago. */
function agentPlace(a) {
  if (a.state === "none") return "";
  if (a.state === "active") return a.terminal ? "terminal" : a.entrypointLabel || "editor";
  return `ended ${ago(a.at)}`.trim();
}
/** The Session cell: the agent's name, then a small line with Model · place · Lavish's review state. */
function agentCell(s) {
  const a = s.agent;
  let top;
  if (a.state === "none") top = `<span class="ag none">not connected</span>`;
  else {
    const dot = a.state === "active" ? '<span class="dot"></span>' : "";
    const title = `${a.provider} ${a.id}${a.cwd ? ` · ${a.cwd}` : ""}${a.source === "scan" ? " · linked by the transcript scan (dotted): a real poll replaces it" : ""}${a.guessed ? " · guessed: several live Codex threads in this folder" : ""}`;
    top = `<span class="ag ${a.state}${a.source === "scan" ? " scan" : ""}${a.guessed ? " guessed" : ""}" title="${esc(title)}">${dot}${glyph(a.provider)}<span class="name">${esc(a.name)}</span></span>`;
  }
  const bits = [];
  const model = agentModel(s);
  if (a.state !== "none" && model) bits.push(model);
  if (a.state !== "none") bits.push(agentPlace(a));
  if (s.tabs) bits.push(`${s.tabs} tab${s.tabs === 1 ? "" : "s"}`);
  if (!s.exists) bits.push(`<span class="st orphan">orphaned</span>`);
  else if (s.status === "ended") bits.push("lavish ended");
  else if (s.stale) bits.push("lavish stale");
  else if (s.pending) bits.push(`${s.pending} pending`);
  return `<div class="two">${top}${bits.length ? `<span class="lv">${bits.map((b) => (b.startsWith("<") ? b : esc(b))).join(" · ")}</span>` : ""}</div>`;
}
const tagsCellHtml = (s) => (s.tags.length ? `<span class="tags">${s.tags.map((t) => `<a class="tg1" href="/?tag=${esc(t.id)}">${esc(t.name)}</a>`).join("")}</span>` : `<span class="num">–</span>`);
/** The model a session is on, for display: the transcript's, else the remembered launch choice. */
const agentModel = (s) => modelName(s.agent.model) || modelName((s.reg.launch || {}).model);
/** The sidebar shared by the index and the plan page: All plans · Active now · projects with their plans nested · tags. */
/** Projects in sidebar order: the dragged order first, then by latest activity (sessions are newest first). */
const orderedProjects = (sessions, layout) => applyOrder([...new Set(sessions.map((s) => s.project))], layout.projectOrder);
const orderedPlans = (list, layout, project) => applyOrder(list, layout.planOrder[project] || [], (s) => s.key);
function renderSidebar(sessions, layout, { view = "", agent = "", current = "" } = {}) {
  const live = sessions.filter((s) => !["retired", "superseded"].includes(s.plan.status));
  const projNav = orderedProjects(sessions, layout).map((p) => {
    const plans = orderedPlans(live.filter((s) => s.project === p), layout, p);
    return `<details class="proj" open data-proj="${esc(p)}"><summary class="nav ${view === `project:${p}` ? "on" : ""}" data-drag="project:${esc(p)}" data-drop="project:${esc(p)}" draggable="true" title="${esc(p)}: click to collapse; drag onto another project to reorder">${ICON.folder}${ICON.folderOpen}<span class="t">${esc(p)}</span><span class="n">${plans.length}</span></summary>
      ${plans.map((s) => `<div class="navwrap hc" data-drop="planslot:${s.key}"><a class="nav plan ${current === s.key ? "on" : ""}" href="/session/${s.key}" data-key="${s.key}" data-drag="plan:${s.key}" draggable="true">${esc(s.title)}</a>${hoverCard(s)}</div>`).join("")}
      ${plans.length > 5 ? `<button class="more" type="button">Show more</button>` : ""}</details>`;
  }).join("");
  const tags = tagList(layout, new Set(sessions.map((s) => s.key)));
  return `<div class="shead"><button id="sideHide" type="button" title="Hide the sidebar">${ICON.hide}</button><span class="sp"></span><button id="prevPlan" type="button" title="Previous plan (←)">←</button><button id="nextPlan" type="button" title="Next plan (→)">→</button></div>
  <a class="nav ${view === "all" ? "on" : ""}" href="/">${ICON.all}<span class="t">All plans</span><span class="n">${sessions.length}</span></a>
  <a class="nav ${agent === "any-active" ? "on" : ""}" href="/?agent=any-active">${ICON.active}<span class="t">Active now</span><span class="n">${sessions.filter((s) => s.agent.state === "active").length}</span></a>
  <h4>Projects</h4>${projNav}
  <h4>Tags</h4>${tags.map((t) => `<a class="nav ${view === `tag:${t.id}` ? "on" : ""}" href="/?tag=${esc(t.id)}" data-drop="tag:${esc(t.id)}" title="Drop a plan here to tag it">${ICON.tag}<span class="t">${esc(t.name)}</span><span class="n" data-count="${esc(t.id)}">${t.count}</span></a>`).join("") || '<p class="meta" style="margin:2px 10px 6px">None yet. Create one below, then drag plans onto it.</p>'}
  <form class="newf" method="post" action="/tags"><input name="name" placeholder="New tag" required maxlength="80" aria-label="New tag"><button type="submit" title="Create the tag">+</button></form>`;
}

function renderIndex(sessions, q, serverUp, layout) {
  const tag = q.get("tag") || "", project = q.get("project") || "";
  const status = q.get("status") || "", plan = q.get("plan") || "", prio = q.get("prio") || "", stage = q.get("stage") || "", agent = q.get("agent") || "";
  const showRetired = plan === "retired" || plan === "superseded" || stage === "parked";
  const tags = tagList(layout, new Set(sessions.map((s) => s.key)));
  const tagName = tag ? layout.tags[tag]?.name || "Tag" : "";
  const shown = sessions.filter((s) => (!tag || s.tags.some((t) => t.id === tag))
    && (!project || s.project === project)
    && (!status || (status === "orphan" ? !s.exists : status === "stale" ? s.stale : s.status === status))
    && (!agent || (agent === "terminal" ? s.agent.state === "active" && s.agent.terminal : agent === "active" ? s.agent.state === "active" && !s.agent.terminal : agent === "any-active" ? s.agent.state === "active" : s.agent.state === agent))
    && (!plan || (plan === "unworked" ? s.plan.unworked : s.plan.status === plan))
    && (!prio || s.plan.priority === prio)
    && (!stage || s.plan.stage === stage)
    && (showRetired || !["retired", "superseded"].includes(s.plan.status)));
  const current = { ...(tag ? { tag } : {}), ...(project ? { project } : {}), ...(status ? { status } : {}), ...(agent ? { agent } : {}), ...(plan ? { plan } : {}), ...(prio ? { prio } : {}), ...(stage ? { stage } : {}) };
  const keep = (k, v, drop = []) => { const c = { ...current, [k]: v }; for (const d of drop) delete c[d]; return new URLSearchParams(c).toString().replace(/[^=&]+=(&|$)/g, "").replace(/&$/, ""); };
  const filtered = Boolean(status || agent || plan || prio || stage);
  const home = !tag && !project && !filtered;
  const view = tag ? `tag:${tag}` : project ? `project:${project}` : filtered ? "filtered" : "all";
  // Drive-style filter buttons: each opens a popover of today's chips with the same query keys; nothing moves when one opens.
  const FILTERS = [
    { k: "agent", label: "Agent", cur: agent, opts: [["", "any"], ["none", "not connected"], ["active", "active in an editor"], ["terminal", "in a terminal"], ["any-active", "any active"], ["ended", "ended"]] },
    { k: "stage", label: "Stage", cur: stage, opts: [["", "any"], ...[...STAGES, "parked"].map((x) => [x, STAGE_LABELS[x]])] },
    { k: "plan", label: "Plan", cur: plan, opts: [["", "any"], ["unworked", "unworked"], ...STATUSES.map((p) => [p, (STATUS_WORDS[p] || [p])[0]])] },
    { k: "prio", label: "Priority", cur: prio, opts: [["", "any"], ...PRIORITIES.map((p) => [p, p])] },
    { k: "status", label: "Lavish", cur: status, opts: [["", "any"], ["open", "open"], ["ended", "ended"], ["stale", "stale"], ["orphan", "orphaned"]] },
    { k: "tag", label: "Tags", cur: tag, opts: [["", "any"], ...tags.map((t) => [t.id, t.name])] },
  ];
  const fbtn = (f) => { const curLabel = (f.opts.find((o) => o[0] === f.cur) || [])[1] || ""; return `<details class="fbtn ${f.cur ? "on" : ""}"><summary>${esc(f.label)}${f.cur ? ` · ${esc(curLabel)}` : ""} <span class="ch">▾</span></summary><div class="pop">${f.opts.map(([v, label]) => `<a class="${f.cur === v ? "on" : ""}" href="/?${keep(f.k, v)}">${esc(label)}</a>`).join("")}</div></details>`; };
  const colsBtn = `<details class="fbtn" style="margin-left:auto"><summary>Columns <span class="ch">▾</span></summary><div class="pop right" id="colsPop"><div class="h">Shown</div>${COLUMNS.map((c) => `<label class="${c.fixed ? "fixed" : ""}"><input type="checkbox" value="${c.k}"${c.on ? " checked" : ""}${c.fixed ? " disabled" : ""}> ${esc(c.label)}</label>`).join("")}</div></details>`;
  const fbar = `<div class="fbar">${FILTERS.map(fbtn).join("")}${Object.keys(current).length ? `<a class="a" href="/" style="font-size:12.5px">Clear</a>` : ""}${colsBtn}</div>`;
  const back = encodeURIComponent("/?" + new URLSearchParams(current).toString());
  const sidebar = renderSidebar(sessions, layout, { view, agent });
  const crumbs = tag ? `<div class="crumbs"><a href="/">All plans</a> › <b>${esc(tagName)}</b></div>` : project ? `<div class="crumbs"><a href="/">All plans</a> › <b>${esc(project)}</b></div>` : `<div class="crumbs"><b>All plans</b>${filtered ? " <span>· filtered</span>" : ""}</div>`;
  const tagRow = tag ? `<p class="meta" style="margin:0 0 8px">${shown.length} plan${shown.length === 1 ? "" : "s"} · <form class="inline" method="post" action="/tags/${esc(tag)}" onsubmit="var v=prompt('Rename tag',this.name.value);if(v===null)return false;this.name.value=v;return true"><input type="hidden" name="op" value="rename"><input type="hidden" name="name" value="${esc(tagName)}"><button class="a" type="submit">Rename</button></form><form class="inline" method="post" action="/tags/${esc(tag)}" onsubmit="return confirm('Delete this tag? It comes off every plan; nothing else changes.')"><input type="hidden" name="op" value="delete"><button class="a" type="submit">Delete tag</button></form></p>` : "";
  // one table per project in sidebar order; inside a project the dragged order first, then newest first
  const groups = new Map();
  for (const g of orderedProjects(shown, layout)) groups.set(g, orderedPlans(shown.filter((s) => s.project === g), layout, g));
  const cols = `<colgroup>${COLUMNS.map((c) => `<col data-col="${c.k}" data-w="${c.w}" style="width:${c.on ? c.w : "0"}">`).join("")}</colgroup>`;
  const head = `<thead><tr>${COLUMNS.map((c) => `<th data-col="${c.k}"${c.nosort ? " data-nosort" : ""} class="${c.on ? "" : "off"}">${esc(c.label)}${c.k !== "actions" ? '<span class="rz"></span>' : ""}</th>`).join("")}</tr></thead>`;
  const pills = `<span class="pill">${sessions.length} plans · ${sessions.filter((s) => s.agent.state === "active").length} active</span>`;
  let body = `${crumbs}<h1>${tag ? `${ICON.tag.replace('<svg ', '<svg style="width:18px;height:18px;color:var(--ink3)" ')} ${esc(tagName)}` : project ? esc(project) : "All plans"}</h1>${tagRow}${fbar}`;
  if (!shown.length) body += `<p class="empty">Nothing here.</p>`;
  for (const [g, list] of groups) {
    const gid = g.replace(/[^a-z0-9]/gi, "-").toLowerCase();
    body += `${!project ? `<div class="grp"><a href="/?project=${encodeURIComponent(g)}" title="Open the project: every plan, no Show more">${esc(g)}</a><span>${list.length} plan${list.length === 1 ? "" : "s"}${home && list.length > 5 ? " · newest 5" : ""}</span></div>` : ""}<div class="tw"><table data-cols="1" data-grp="${esc(gid)}">${cols}${head}<tbody>`;
    list.forEach((s, i) => { body += row(s, back, layout, { i, hide: home && i >= 5 }); });
    body += `</tbody></table></div>${home && list.length > 5 ? `<button class="more" type="button" data-grp="${esc(gid)}">Show ${Math.min(10, list.length - 5)} more</button>` : ""}`;
  }
  return page(tag ? `${tagName} · Lavish` : project ? `${project} · Lavish` : "Lavish home", tag ? tagName : project || "all plans", body, serverUp, { pills, sidebar, layout, view });
}
/** Plan status cell: the word in effect, and a select that appears on hover or focus. */
function statusCell(s, back) {
  const opts = STATUSES.map((x) => `<option value="${x}"${(s.reg.status ? normalizeStatus(s.reg.status) : "") === x ? " selected" : ""}>${(STATUS_WORDS[x] || [x])[0]}</option>`).join("");
  return `<div class="sw">${planChip(s.plan)}<form class="inline" method="post" action="/status/${s.key}?back=${back}"><select class="inline" name="status" onchange="this.form.submit()" title="Set the plan status (the word shows what is in effect)" aria-label="Plan status"><option value="">— infer</option>${opts}</select></form></div>`;
}
function hoverCard(s) {
  const latest = s.plan.progress.latest;
  const a = s.agent;
  return `<div class="card"><p>${esc(s.plan.summary || "No summary (add <meta name=description> to the plan or set one on its page).")}</p>
  <p><span class="k">Plan</span>${planChip(s.plan)} &nbsp; <span class="k">Build</span>${dotWord(s.plan.build.tone, s.plan.build.label, s.plan.build.why)} <span class="meta">· ${esc(s.plan.build.why)}</span></p>
  <p><span class="k">PRs</span>${prChips(s.plan)}</p>
  <p><span class="k">Review</span>${s.agentMsgs} ${s.agentMsgs === 1 ? "reply" : "replies"} · ${s.userSent} sent${s.privateNotes ? ` · ${s.privateNotes} private` : ""}${s.unsentCount ? ` · ${s.unsentCount} unsent` : ""} &nbsp; <span class="k">Versions</span>${s.versionCount || 0} &nbsp; <span class="k">Priority</span>${esc(s.plan.priority)}</p>
  ${latest ? `<p><span class="k">Latest</span>${esc(latest.text)} · ${esc(latest.session?.label || "")} · ${fmtDay(latest.at)}</p>` : ""}
  <p><span class="k">Agent</span>${a.state === "none" ? "not connected" : `${esc(a.name)} · ${esc(a.provider === "codex" ? "Codex" : "Claude")}${agentModel(s) ? ` · ${esc(agentModel(s))}` : ""} · ${esc(a.state)}${agentPlace(a) ? ` · ${esc(agentPlace(a))}` : ""}`}${s.tabs ? ` · ${s.tabs} tab${s.tabs === 1 ? "" : "s"} open` : ""}${s.tags.length ? ` &nbsp; <span class="k">Tags</span>${s.tags.map((t) => esc(t.name)).join(", ")}` : ""}</p>
  <p class="mono" style="color:var(--ink3)">${esc(shortPath(s.resolved || s.file))}${s.moved ? " · path moved, re-linked" : ""}${s.worktree ? ` · worktree ${esc(s.worktree)}` : ""}</p></div>`;
}
/** The row's menu (the ⋯ button and the right-click menu clone it). */
function rowMenu(s, back, layout) {
  const tags = tagList(layout);
  const has = new Set(s.tags.map((t) => t.id));
  const tagItems = tags.length ? tags.map((t) => `<form method="post" action="/tag/${s.key}?back=${back}"><input type="hidden" name="tid" value="${esc(t.id)}"><input type="hidden" name="on" value="${has.has(t.id) ? "0" : "1"}"><button type="submit" class="${has.has(t.id) ? "on" : ""}">${esc(t.name)}</button></form>`).join("") : `<span class="k" style="display:block;padding:6px 10px">No tags yet. Create one in the sidebar.</span>`;
  const live = s.agent.state === "active";
  return [
    s.exists ? `<form method="post" action="/open/${s.key}"><button type="submit">${s.status === "ended" ? "Reopen in Lavish" : "Open in Lavish"}</button></form>` : "",
    s.exists ? `<a href="/session/${s.key}#launch">New session…</a>` : "",
    s.exists ? `<form method="post" action="/restart/${s.key}" onsubmit="return confirm('Restart: end the Lavish session, close its tabs, and start a NEW agent session on this plan (${esc((s.reg.launch || {}).provider || s.agent.provider || "claude")}, ${esc(agentModel(s) || "default model")})?')"><button type="submit" title="${live ? `Refused while ${esc(s.agent.name)} is live: end it first` : "End the Lavish session and its tabs, then start a fresh agent session that reopens this plan"}">Restart${live ? ' <span class="k">live: refuses</span>' : ""}</button></form>` : "",
    `<a href="/session/${s.key}">Log</a>`,
    `<details><summary>Tag <span class="k">›</span></summary><div class="sub">${tagItems}</div></details>`,
    "<hr>",
    s.exists && s.status !== "ended" ? `<form method="post" action="/end/${s.key}?close=1&back=${back}" onsubmit="return confirm('End this Lavish session and close its browser tabs? The plan is not retired.')"><button type="submit">End session and close tabs${s.tabs ? ` <span class="k">${s.tabs} tab${s.tabs === 1 ? "" : "s"}</span>` : ""}</button></form>` : "",
    s.tabs > 1 ? `<form method="post" action="/tabs/${s.key}/close?back=${back}"><button type="submit" title="Every tab but the one that pinged last closes itself">Close other tabs <span class="k">${s.tabs - 1}</span></button></form>` : "",
    s.plan.status !== "retired" ? `<form method="post" action="/status/${s.key}?back=${back}"><input type="hidden" name="status" value="retired"><button type="submit" class="danger" title="Park or abandon this plan (hidden from the default view)">Retire</button></form>` : `<form method="post" action="/status/${s.key}?back=${back}"><input type="hidden" name="status" value=""><button type="submit">Unretire (infer status)</button></form>`,
  ].join("");
}
function row(s, back = "", layout, { i = 0, hide = false } = {}) {
  const p = s.plan, b = p.build, launch = s.reg.launch || {};
  const resume = s.exists && s.agent.state !== "none" ? `<form class="inline" method="post" action="/connect/${s.key}" title="${esc(s.agent.state === "active" ? (s.agent.terminal ? "Bring its terminal forward and open the plan in Lavish" : `Live in ${s.agent.entrypointLabel}: opens the plan in Lavish only`) : `Resume ${s.agent.name} in a terminal (${agentModel(s) || "default model"}, ${launch.effort || "default effort"}) and open the plan in Lavish`)}"><input type="hidden" name="model" value="${esc(launch.model || "")}"><input type="hidden" name="effort" value="${esc(launch.effort || "")}"><button class="a" type="submit">Resume</button></form>` : "";
  const view = s.exists ? `<a class="a" href="/view/${s.key}/" target="_blank" rel="noopener" title="Read the plan as it is on disk: no Lavish chrome, no session change">View</a>` : "";
  const reviews = `${s.agentMsgs} ${s.agentMsgs === 1 ? "reply" : "replies"} · ${s.userSent} sent${s.privateNotes ? ` · ${s.privateNotes} private` : ""}`;
  const cells = {
    plan: `<div class="hc"><div class="t"><a href="/session/${s.key}">${esc(s.title)}</a><span class="vn" title="${s.versionCount || 0} saved versions">v${s.versionCount || 0}</span>${p.priority === "high" ? '<span class="prio high">high</span>' : ""}${!s.exists ? '<span class="st orphan">missing</span>' : ""}</div>${hoverCard(s)}</div>`,
    status: statusCell(s, back),
    build: dotWord(b.tone, b.label, b.why, false),
    session: agentCell(s),
    modified: `<span class="num" title="${esc(fmt(s.updated))}">${fmtDay(s.updated)}</span>`,
    added: `<span class="num" title="${esc(s.added ? fmt(s.added) : "unknown")}">${s.added ? fmtDay(s.added).replace(/^today .*/, "today") : "–"}</span>`,
    actions: `${view}${resume}<button class="dots" type="button" title="More actions (right-click the row does the same)" aria-label="More actions">⋯</button><div class="menu src">${rowMenu(s, back, layout)}</div>`,
    tags: tagsCellHtml(s),
    priority: `<span class="prio ${esc(p.priority)}">${esc(p.priority)}</span>`,
    project: `<a class="a" style="color:var(--ink2)" href="/?project=${encodeURIComponent(s.project)}">${esc(s.project)}</a>`,
    completed: `<span class="num">${p.completedAt ? fmtDay(p.completedAt) : "–"}</span>`,
    retired: `<span class="num">${p.retiredAt ? fmtDay(p.retiredAt) : "–"}</span>`,
    versions: `<span class="num">${s.versionCount || 0}</span>`,
    reviews: `<span class="num">${esc(reviews)}</span>`,
  };
  const sortv = { plan: s.title.toLowerCase(), status: STATUSES.indexOf(p.status), build: b.rank, session: s.agent.state === "none" ? "~" : s.agent.name, modified: s.updated.toISOString(), added: s.added ? new Date(s.added).toISOString() : "", tags: s.tags.map((t) => t.name).join(" ").toLowerCase(), priority: PRIO_RANK[p.priority], project: s.project.toLowerCase(), completed: p.completedAt || "", retired: p.retiredAt || "", versions: s.versionCount || 0, reviews: s.agentMsgs + s.userSent };
  const sortAttrs = Object.entries(sortv).map(([k, v]) => `data-s-${k}="${esc(v)}"`).join(" ");
  return `<tr id="row-${s.key}" class="${p.status === "retired" ? "retired" : ""}${hide ? " hid" : ""}" data-key="${s.key}" data-drag="plan:${s.key}" draggable="true" data-i="${i}" tabindex="0" ${sortAttrs}>${COLUMNS.map((c) => `<td data-col="${c.k}" class="${c.k === "plan" ? "name" : c.k === "actions" ? "acts" : ""}${c.on ? "" : " off"}">${cells[c.k]}</td>`).join("")}</tr>`;
}
function shortPath(p) { return p.replace(os.homedir(), "~").replace("/Library/CloudStorage/Dropbox-Personal/Development/", "/…/"); }

/* ── launch forms + agent block (plan page) ──────────────────────────────── */
const opts = (list, sel) => list.map((x) => `<option value="${esc(x)}"${x === (sel || "default") ? " selected" : ""}>${esc(x)}</option>`).join("");
function launchForms(s, { cwd = "" } = {}) {
  const l = s.reg.launch || {};
  const a = s.agent;
  const provider = l.provider || a.provider || "claude";
  const resumeForm = a.state === "none" ? `<p class="meta" style="margin:0 0 4px">No agent has polled this plan yet, so there is nothing to resume. Start a new session below, or run <span class="mono">lavish-poll</span> from the session that is on it.</p>` :
    `<form class="xform" method="post" action="/connect/${s.key}"><div class="row"><button class="b" type="submit">${a.state === "active" ? (a.terminal ? "Bring the terminal forward" : "Open in Lavish") : "Resume"}</button> ${glyph(a.provider)} <span class="mono">${esc(a.name)}</span>
    <label>Model <select name="model">${a.provider === "codex" ? `<option value="">default</option>` : opts(LAUNCH_OPTIONS.claude.models, l.model)}</select></label>${a.provider === "codex" ? `<label>or <input type="text" name="model_free" value="${esc(l.model && !LAUNCH_OPTIONS.codex.models.includes(l.model) ? l.model : "")}" placeholder="codex model (free text)" style="width:160px"></label>` : ""}<label>Effort <select name="effort">${opts(LAUNCH_OPTIONS[a.provider === "codex" ? "codex" : "claude"].efforts, l.effort)}</select></label></div>
    <p class="meta" style="margin:0">${a.state === "active" ? (a.terminal ? `Already running in tmux ${esc(a.tmuxName)}: nothing new is started. Model and effort apply at the next resume.` : `Live in ${esc(a.entrypointLabel)}: nothing is spawned (a second writer would corrupt its transcript); the plan opens in Lavish.`) : `Ended ${esc(ago(a.lastAt || a.at))}. Starts <span class="mono">tmux new-session -s ${esc(a.tmuxName)}</span> in <span class="mono">${esc(shortPath(a.cwd || ""))}</span> running <span class="mono">${a.provider === "codex" ? "codex resume" : "claude --resume"} ${esc(String(a.id).slice(0, 8))}…</span>, opens Terminal.app on it, then the plan in Lavish. Remembered per plan.`}</p></form>
    <form class="xform" method="post" action="/restart/${s.key}" onsubmit="return confirm('Restart: end the Lavish session, close its tabs, and start a NEW ${esc(provider)} session on this plan?')"><div class="row"><button class="b q" type="submit"${a.state === "active" ? " disabled" : ""}>Restart</button><span class="meta">${a.state === "active" ? `refused while ${esc(a.name)} is live in ${a.terminal ? "terminal " + esc(a.tmuxName) : esc(a.entrypointLabel)}: end it there first (a second agent on one plan would fight the first)` : `ends the Lavish session and its tabs, then starts a fresh ${esc(provider === "codex" ? "Codex" : "Claude")} session (${esc(modelName(l.model) || "default model")}, ${esc(l.effort || "default effort")}) whose first prompt reopens this plan; the old session is never resumed`}</span></div></form>`;
  const newForm = `<form class="xform" method="post" action="/connect/${s.key}?new=1"><div class="row"><b>New</b> <label>Provider <select name="provider" onchange="this.form.querySelector('[name=model]').innerHTML=this.value==='codex'?'<option value=\\'\\'>default</option>':'${LAUNCH_OPTIONS.claude.models.map((m) => `<option value=${m}>${m}</option>`).join("")}';this.form.querySelector('[name=effort]').innerHTML=(this.value==='codex'?${JSON.stringify(LAUNCH_OPTIONS.codex.efforts)}:${JSON.stringify(LAUNCH_OPTIONS.claude.efforts)}).map(function(e){return '<option value='+e+'>'+e+'</option>'}).join('')"><option value="claude"${provider !== "codex" ? " selected" : ""}>Claude</option><option value="codex"${provider === "codex" ? " selected" : ""}>Codex</option></select></label>
    <label>Model <select name="model">${provider === "codex" ? `<option value="">default</option>` : opts(LAUNCH_OPTIONS.claude.models, l.model)}</select></label><label>or <input type="text" name="model_free" placeholder="codex model (free text)" style="width:150px"></label><label>Effort <select name="effort">${opts(LAUNCH_OPTIONS[provider === "codex" ? "codex" : "claude"].efforts, l.effort)}</select></label></div>
    <div class="row"><label style="flex:1">Folder <input type="text" name="cwd" value="${esc(cwd || projectCwd(s))}" style="flex:1"></label></div>
    <label style="display:block">Prompt<textarea name="prompt">${esc(l.prompt || defaultNewPrompt(s.resolved || s.file))}</textarea></label>
    <div class="row"><button class="b" type="submit">Start in a terminal</button><span class="meta">Claude: <span class="mono">claude --session-id &lt;new uuid&gt; …</span> (stamped on the plan at once). Codex: <span class="mono">codex -C &lt;folder&gt; …</span> (its thread is matched by folder on the first poll).</span></div></form>`;
  return resumeForm + newForm;
}
/** The Agent block: state, session (name · provider · model), folder, stamped; Change effort for owned Claude terminals. */
function agentBlock(s, { effortResult = "", scanResult = "" } = {}) {
  const a = s.agent;
  const owned = a.state === "active" && a.terminal && a.provider === "claude";
  const model = agentModel(s);
  return `<div class="kv"><span class="k">State</span><span>${a.state === "none" ? '<span class="ag none">not connected</span>' : `<span class="ag ${a.state}${a.source === "scan" ? " scan" : ""}">${a.state === "active" ? '<span class="dot"></span>' : ""}${esc(a.state)}${a.state === "active" ? ` · ${a.terminal ? "terminal " + esc(a.tmuxName) : esc(a.entrypointLabel)}${a.status ? ` · ${esc(a.status)}` : ""}` : ` · ${esc(ago(a.lastAt || a.at))}`}${s.tabs ? ` · ${s.tabs} tab${s.tabs === 1 ? "" : "s"} open` : ""}</span>`}</span>
  ${a.state !== "none" ? `<span class="k">Session</span><span>${glyph(a.provider)} <span class="mono" title="${esc(a.id)}">${esc(a.name)}</span> · ${esc(a.provider === "codex" ? "Codex" : "Claude")}${model ? ` · ${esc(model)}` : ""}${a.model ? "" : model ? ' <span class="meta" title="the transcript was not found; this is the launch choice remembered for the plan">(remembered)</span>' : ""}${a.guessed ? " · guessed (several live Codex threads in this folder)" : ""}</span><span class="k">Folder</span><span class="mono">${esc(shortPath(a.cwd || ""))}${a.cwd && !existsSync(a.cwd) ? ' <span class="st orphan">missing</span>' : ""}</span><span class="k">Started</span><span>${a.startedAt ? fmt(a.startedAt) : "–"} · stamped by ${esc(a.source)} ${fmt(a.at)}${a.state === "ended" ? ` · would resume as <span class="mono">${esc(a.tmuxName)}</span>` : ""}</span>` : ""}</div>
  ${effortResult ? `<div class="notice">${esc(effortResult)}</div>` : ""}${scanResult ? `<div class="notice">${esc(scanResult)}</div>` : ""}
  ${owned ? `<form class="inline" method="post" action="/effort/${s.key}" style="display:block;margin:0 0 10px"><label>Change effort <select name="level">${LAUNCH_OPTIONS.claude.efforts.filter((e) => e !== "default").map((e) => `<option value="${e}">${e}</option>`).join("")}</select></label> <button class="b q" type="submit" title="Types /effort <level> into the terminal ${esc(a.tmuxName)}, only while it is idle at its prompt, then shows the pane's reply">Type /effort into the terminal</button></form>` : ""}`;
}
const ENTRYPOINT_WORD = { "claude-vscode": "VS Code", "claude-cursor": "Cursor", "claude-desktop": "Desktop", cli: "terminal", codex: "Codex" };
/** Sessions table: every agent that has been on this plan (the current one first). */
function sessionsTable(s) {
  const list = [];
  const seen = new Set();
  for (const x of [s.reg.agent, ...s.agents]) { if (!x || !x.id || seen.has(x.id)) continue; seen.add(x.id); list.push(x); }
  if (!list.length) return `<p class="empty">No session has polled this plan yet.</p>`;
  const rows = list.map((x) => {
    const live = s.agent.id === x.id ? s.agent : null;
    const info = sessionInfoOf(x);
    const model = modelName(info.model) || (live ? modelName((s.reg.launch || {}).model) : "");
    const active = live && live.state === "active";
    const where = active ? (live.terminal ? "terminal" : live.entrypointLabel || "editor") : (ENTRYPOINT_WORD[x.entrypoint] || (x.provider === "codex" ? "Codex" : "ended"));
    const acts = active ? `<form class="inline" method="post" action="/open/${s.key}"><button class="a" type="submit">Open in Lavish</button></form>` : `<form class="inline" method="post" action="/connect/${s.key}?agent=${encodeURIComponent(x.id)}"><button class="a" type="submit" title="Resume this particular session in a terminal">Resume</button></form>`;
    return `<tr><td class="sess">${glyph(x.provider)} <span class="ag ${x.source === "scan" ? "scan" : ""}" style="display:inline-flex" title="${esc(x.provider)} ${esc(x.id)} · ${esc(x.source || "poll")}${info.file ? ` · ${esc(shortPath(info.file))}` : " · no transcript found"}"><span class="name">${esc(agentLabel(x))}</span></span>${active ? ' <span class="dot"></span>' : ""}</td><td>${model ? esc(model) : '<span class="num" title="no transcript found for this id">–</span>'}</td><td>${esc(where)}</td><td class="num">${info.startedAt ? fmt(info.startedAt) : `<span title="stamped ${esc(fmt(x.at))}">–</span>`}</td><td class="num">${active ? "–" : info.lastAt ? fmt(info.lastAt) : "–"}</td><td class="num">${live && s.tabs ? `${s.tabs} tab${s.tabs === 1 ? "" : "s"}` : "–"}</td><td>${acts}</td></tr>`;
  }).join("");
  return `<div class="tw"><table class="tl"><colgroup><col style="width:24%"><col style="width:11%"><col style="width:11%"><col style="width:14%"><col style="width:14%"><col style="width:10%"><col style="width:16%"></colgroup><thead><tr><th>Session</th><th>Model</th><th>Where</th><th title="first line of the transcript">Started</th><th title="last line of the transcript, when not live">Last ended</th><th title="Lavish tabs open on this plan (pinged in the last 30 s)">Browsers</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderSession(s, all, serverUp, q, layout) {
  const groups = transcriptGroups(s);
  // private comments join the conversation by time: each lands in the session group that was on the plan when it was written
  const priv = s.notes.filter((n) => n.created).map((n) => ({ at: n.created, role: "private", kind: n.state || "private", text: n.body, where: n.anchor?.text || "" }));
  for (const n of priv) { let g = groups[0]; for (const x of groups) if (String(x.first) <= String(n.at)) g = x; if (g) { g.items.push(n); g.items.sort((a, b) => String(a.at).localeCompare(String(b.at))); } }
  groups.reverse();
  const msgHtml = (i) => `<div class="msg ${i.role === "agent" ? "agent" : i.role === "system" ? "sys" : i.role === "private" ? "priv" : i.kind === "annotation" ? "ann" : ""}"><small>${i.role === "agent" ? "agent" : i.role === "system" ? "system" : i.role === "private" ? "private" : "you"} · ${esc(i.kind || "")}${i.tag && i.kind === "annotation" ? ` on &lt;${esc(i.tag)}&gt;` : ""}${i.where ? ` · “${esc(String(i.where).slice(0, 80))}”` : ""} · ${fmt(i.at)}</small>${esc(i.text)}</div>`;
  const msgs = groups.length ? groups.map((g, gi) => {
    const live = s.agent.id && g.id === s.agent.id ? s.agent : null;
    const resumeBtn = g.id && !(live && live.state === "active") && g.rec ? `<form class="inline" method="post" action="/connect/${s.key}?agent=${encodeURIComponent(g.id)}" style="margin-left:8px"><button class="a" type="submit" title="Resume this particular session in a terminal">Resume</button></form>` : "";
    return `<details class="tg"${gi === 0 ? " open" : ""}><summary>${g.id ? glyph(g.provider) : ""}<span class="who">${esc(g.name)}</span>${live ? `<span class="ag ${live.state}" style="font-size:11.5px">${live.state === "active" ? '<span class="dot"></span>' : ""}${esc(live.state)}</span>` : ""}${resumeBtn}<span class="when">${g.items.length} message${g.items.length === 1 ? "" : "s"} · ${fmtDay(g.first)}${g.last !== g.first ? ` → ${fmtDay(g.last)}` : ""}</span></summary><div class="body">${g.items.map(msgHtml).join("")}</div></details>`;
  }).join("") : (priv.length ? priv.map(msgHtml).join("") : `<p class="empty">No transcript yet. Typed messages and agent replies appear here from state.json; annotations appear once lavish-poll has delivered a round.</p>`);
  const related = s.related.map((r) => { const t = all.find((x) => x.resolved && (x.resolved.endsWith(r) || basename(x.resolved) === r)); return t ? `<a class="a" href="/session/${t.key}">${esc(t.title)}</a>` : esc(r); }).join(" ");
  const restored = q.get("restored"), prRefreshed = q.get("prs"), notice = q.get("notice"), effortResult = q.get("effort") || "", scanResult = q.get("scan") || "";
  const p = s.plan;
  const statusForm = `<form method="post" action="/status/${s.key}" class="xform" style="gap:6px"><div class="row"><label>Plan status <select name="status" onchange="this.form.submit()"><option value="">— infer (${esc(p.inferred ? (STATUS_WORDS[p.status] || [p.status])[0] : "auto")})</option>${STATUSES.map((x) => `<option value="${x}"${normalizeStatus(s.reg.status) === x ? " selected" : ""}>${(STATUS_WORDS[x] || [x])[0]}</option>`).join("")}</select></label>
      <label>Priority <select name="priority" onchange="this.form.submit()">${PRIORITIES.map((x) => `<option value="${x}"${p.priority === x ? " selected" : ""}>${x}</option>`).join("")}</select></label>
      <label>PR # <input type="number" name="pr" min="1" style="width:80px" placeholder="536"></label><button class="b q" type="submit">Save</button></div>
      <label style="display:flex">Summary <input type="text" name="summary" value="${esc(s.reg.summary || "")}" placeholder="${esc(s.head.summary || "one line, shown on the home page")}" style="flex:1"></label></form>
    <p class="meta" style="margin:8px 0 0"><form class="inline" method="post" action="/refresh-prs/${s.key}"><button class="a" type="submit" title="Runs gh pr view for each PR">Refresh PR states</button></form>${prRefreshed ? `<span>${esc(prRefreshed)}</span>` : ""} ${s.exists ? `<a class="a" href="/view/${s.key}/" target="_blank" rel="noopener">View</a><form class="inline" method="post" action="/open/${s.key}"><button class="a" type="submit">${s.status === "ended" ? "Reopen in Lavish" : "Open in Lavish"}</button></form>` : ""}${s.exists && s.status !== "ended" ? `<form class="inline" method="post" action="/end/${s.key}" onsubmit="return confirm('End this Lavish session?')"><button class="a" type="submit">End session</button></form>` : ""}<form class="inline" method="post" action="/scan/${s.key}"><button class="a" type="submit" title="Look through this project's transcripts of the last 7 days for sessions that read or edited this plan">Find sessions</button></form>${s.exists && s.status !== "ended" ? `<form class="inline" method="post" action="/end/${s.key}?close=1&back=${encodeURIComponent(`/session/${s.key}`)}" onsubmit="return confirm('End this Lavish session and close its browser tabs?')"><button class="a" type="submit">End and close tabs</button></form>` : ""}</p>
    <p class="meta tags" style="margin:8px 0 0"><span class="k" style="margin-right:6px">Tags</span>${tagList(layout).map((t) => { const on = s.tags.some((x) => x.id === t.id); return `<form class="inline" method="post" action="/tag/${s.key}?back=${encodeURIComponent(`/session/${s.key}`)}"><input type="hidden" name="tid" value="${esc(t.id)}"><input type="hidden" name="on" value="${on ? "0" : "1"}"><button type="submit" class="tg1" style="cursor:pointer;border:1px solid ${on ? "var(--acc)" : "var(--rule)"};${on ? "background:var(--accSoft);color:var(--acc)" : ""}" title="${on ? "Remove the tag" : "Add the tag"}">${on ? "✓ " : ""}${esc(t.name)}</button></form>`; }).join(" ") || "none yet (create one in the sidebar)"}</p>`;
  const steps = [...STAGES].map((st, i) => `<span class="${p.stage === st ? "now" + (p.stageInferred ? " inferred" : "") : i < p.stageIndex ? "past" : ""}">${STAGE_LABELS[st]}</span>`).join("");
  const latest = p.progress.latest;
  const sidebar = renderSidebar(all, layout, { current: s.key });
  const body = `<div class="crumbs"><a href="/">All plans</a> › <a href="/?project=${encodeURIComponent(s.project)}">${esc(s.project)}</a> › <b>${esc(s.title)}</b>${s.tags.length ? ` <span class="tags" style="margin-left:6px">${s.tags.map((t) => `<a class="tg1" href="/?tag=${esc(t.id)}">${esc(t.name)}</a>`).join("")}</span>` : ""}</div>
  <h1>${esc(s.title)} <span class="vn" style="font-size:13px">v${s.versionCount || 0}</span>${!s.exists ? ' <span class="st orphan">file missing</span>' : ""}${s.exists ? ` <details class="fold" style="margin:0;font-size:13px;font-weight:400"><summary title="Rewrite the file's &lt;title&gt; (the current file is snapshotted first)">Rename</summary><form class="xform in" method="post" action="/rename/${s.key}" style="display:flex;gap:6px;align-items:center;flex-wrap:nowrap"><input type="text" name="title" value="${esc(s.title)}" maxlength="140" required style="width:min(60vw,520px)"><button class="b" type="submit">Save</button><span class="meta">what it decides, entity first, 3 to 7 words, no dates or codes</span></form></details>` : ""}</h1>
  <p class="meta" style="margin:0">${p.summary ? esc(p.summary) : `<span>${esc(s.project)}${s.worktree ? ` · worktree ${esc(s.worktree)}` : ""}</span>`}${p.summary && s.worktree ? ` · worktree ${esc(s.worktree)}` : ""}${related ? ` · <b>Related</b> ${related}` : ""}</p>
  <div class="stageline"><div class="stage-steps${p.stage === "parked" ? " parked" : ""}">${steps}</div><span>· ${esc(p.subLabel)}${p.stageNote ? ` · ${esc(p.stageNote)}` : ""}${latest ? ` · latest: ${esc(latest.text)} · ${esc(latest.session?.label || "")} · ${fmtDay(latest.at)}` : ""}</span></div>
  ${restored ? `<div class="notice">Restored version ${esc(restored)} onto disk. Your Lavish tab will offer a reload. The agent does not learn about this by itself, so tell it in the conversation panel.</div>` : ""}
  ${notice ? `<div class="notice ${/^(Could not|Folder missing|.* not found)/.test(notice) ? "bad" : ""}">${esc(notice)}</div>` : ""}
  <div class="twoCol"><div class="box" id="agent"><h3>Agent <span class="meta">who is on this plan, from lavish-poll / lavish-meta stamps${s.agent.source === "scan" ? " (this one from the transcript scan)" : ""}</span></h3>${agentBlock(s, { effortResult, scanResult })}${statusForm}</div>
  <div class="box" id="launch"><h3>Resume or start a new session</h3>${launchForms(s)}</div></div>
  <h2 id="sessions">Sessions <span class="meta">every agent that has been on this plan</span></h2>${sessionsTable(s)}
  <h2 id="history">History <span class="meta">the plan's main events, newest first</span></h2>${renderProgress(s)}
  ${renderVersions(s)}
  ${renderCommits(s)}${renderUnsent(s)}${renderExport(s)}
  <h2 id="conversation">Conversation <span class="meta">grouped per agent session, newest open; your private comments are in place by time and never sent</span></h2>${msgs}`;
  return page(s.title, `${s.project} · ${s.title}`, body, serverUp, { sidebar, layout, key: s.key });
}

function currentVersionState(s) {
  if (!s.exists || !s.versions.length) return { n: null, dirty: false };
  const latest = s.versions[s.versions.length - 1];
  try { return { n: latest.n, dirty: sha(readFileSync(s.resolved, "utf8")) !== latest.sha }; } catch { return { n: latest.n, dirty: false }; }
}
/** Comments and private notes written while each version was the one on screen (by timestamp). */
function commentsPerVersion(s) {
  const vs = s.versions;
  const sent = s.history.filter((h) => h.role === "user").map((h) => ({ at: h.at, kind: h.kind === "message" ? "message" : h.tag === "suggestion" ? "suggestion" : h.tag === "verdict" ? "verdict" : "sent", text: h.text, where: h.where }));
  const priv = s.notes.filter((n) => n.state !== "sent").map((n) => ({ at: n.created, kind: n.state === "resolved" ? "resolved" : "private", text: n.body, where: n.anchor?.text || "", files: n.attachments || [] }));
  const items = [...sent, ...priv].filter((i) => i.at).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const buckets = new Map(vs.map((v) => [v.n, []]));
  for (const i of items) {
    let owner = null;
    for (const v of vs) if (String(v.at) <= String(i.at)) owner = v;
    if (owner) buckets.get(owner.n).push(i);
    else if (vs.length) buckets.get(vs[0].n).push(i);
  }
  return buckets;
}
/** "What changed" for a version: its round label when the poll saved it, else the reason in words (no line counts). */
function versionWhy(v) {
  if (v.label) return v.label;
  return { "agent-reply": "round closed: the agent replied", poll: "agent polled", baseline: "first snapshot", "pre-restore": "before a restore", restore: "restored version", chrome: "saved from the Lavish page", scan: "edited between rounds" }[v.reason] || "file changed on disk";
}
/** Continue from ▾: restore only · restore and Resume the last session · restore and start a New session (POST /restore/<key>/<n>?then=). */
function continueFrom(s, n, { cls = "a" } = {}) {
  const f = (then, label, title) => `<form method="post" action="/restore/${s.key}/${n}${then ? `?then=${then}` : ""}" onsubmit="return confirm('Continue from version ${n}${then === "resume" ? " and resume the last session" : then === "new" ? " and start a new session" : ""}? The current file is snapshotted first, then v${n} is written over it, so nothing is lost.')"><button type="submit" title="${esc(title)}">${label}</button></form>`;
  return `<details class="cf" style="display:inline-block;position:relative"><summary class="${cls}" style="list-style:none;display:inline;cursor:pointer">Continue from ▾</summary><div class="menu" style="position:absolute;right:0;top:calc(100% + 4px);z-index:9">${f("", "Just restore this version", "Snapshot the current file, then put this version back on disk")}${s.agent.state !== "none" ? f("resume", "Restore and Resume the last session", `Then resume ${s.agent.name} as the Resume button would`) : ""}${f("new", "Restore and start a New session", "Then start a fresh session in a terminal with the default prompt")}</div></details>`;
}
function renderVersions(s) {
  const cur = currentVersionState(s);
  const buckets = commentsPerVersion(s);
  let html = `<h2 id="versions">Versions <span class="meta">${s.versions.length} saved${cur.n ? ` · the file on disk ${cur.dirty ? `has changed since v${cur.n} (snapshotted within ${SCAN_MS / 1000}s)` : `is v${cur.n}`}` : ""}</span></h2>`;
  if (!s.versions.length) return html + `<p class="empty">No versions yet. A copy is saved whenever the file changes (checked every ${SCAN_MS / 1000}s) and at every lavish-poll round.</p>`;
  html += `<div class="tw vt"><table><colgroup><col style="width:11%"><col style="width:13%"><col style="width:34%"><col style="width:20%"><col style="width:22%"></colgroup><thead><tr><th>Version</th><th>Saved</th><th>What changed</th><th title="comments you sent and private notes you wrote while this version was on screen">Comments</th><th>Actions</th></tr></thead><tbody>`;
  const vs = s.versions.slice().reverse();
  for (const v of vs) {
    const bucket = buckets.get(v.n) || [];
    const nSent = bucket.filter((i) => i.kind !== "private" && i.kind !== "resolved").length, nPriv = bucket.length - nSent;
    const commentsCell = bucket.length ? `<details class="vcomments"><summary>${nSent} sent${nPriv ? ` · ${nPriv} private` : ""}</summary>${bucket.map((i) => `<div class="note ${esc(i.kind === "private" || i.kind === "resolved" ? i.kind : "sent")}"><div class="anc">${esc(i.kind)}${i.where ? ` · “${esc(String(i.where).slice(0, 80))}”` : ""} · ${fmt(i.at)}</div>${esc(i.text)}${(i.files || []).length ? `<div class="thumbs">${i.files.map((f) => `<a href="${esc(f.url)}" target="_blank" rel="noopener"><img src="${esc(f.url)}" alt="${esc(f.name)}"></a>`).join("")}</div>` : ""}</div>`).join("")}</details>` : `<span class="num">–</span>`;
    const prev = s.versions.find((x) => x.n === v.n - 1) || s.versions.filter((x) => x.n < v.n).pop();
    const acts = [
      `<a class="a" href="/version/${s.key}/${v.n}/" target="_blank" rel="noopener">View</a>`,
      prev ? `<a class="a" href="/diff/${s.key}/${prev.n}/${v.n}" title="What changed against v${prev.n}">Diff</a>` : "",
      s.exists && (cur.dirty || v.n !== cur.n) ? continueFrom(s, v.n) : "",
    ].join("");
    html += `<tr id="v${v.n}"><td><b>v${v.n}</b>${v.n === cur.n && !cur.dirty ? ' <span class="st open">current</span>' : ""}${v.round != null ? ` <span class="num" title="review round">r${v.round}</span>` : ""}</td><td class="num">${fmt(v.at)}</td><td>${esc(versionWhy(v))}</td><td>${commentsCell}</td><td>${acts}</td></tr>`;
  }
  return html + `</tbody></table></div>`;
}
function renderCommits(s) {
  if (!s.exists) return "";
  const info = gitInfo(s.resolved);
  if (!info.root) return "";
  const log = gitLogForFile(s.resolved, 15);
  const st = gitStatusForFile(s.resolved);
  let html = `<details class="fold"><summary>Commits <span class="meta">${esc(info.slug || basename(info.root))} · working copy ${esc(st)} · ${log.length ? `${log.length} shown` : "not committed yet"}</span></summary><div class="in">`;
  if (!log.length) return html + `<p class="empty" style="padding:8px 0">Not committed yet.</p></div></details>`;
  html += `<div class="tw"><table class="tl"><thead><tr><th>Commit</th><th>When</th><th>Subject</th></tr></thead><tbody>`;
  for (const c of log) html += `<tr><td class="mono">${info.webBase ? `<a class="a" href="${esc(info.webBase)}/commit/${esc(c.hash)}" target="_blank" rel="noopener">${esc(c.hash)}</a>` : esc(c.hash)}</td><td class="num">${fmt(c.date)}</td><td>${esc(c.subject)}</td></tr>`;
  return html + `</tbody></table></div></div></details>`;
}
function transcriptMd(s) {
  const lines = [`# ${s.title}`, "", `File: ${s.resolved || s.file}`, `Session: ${s.key} · status ${s.status}${s.endedBy ? ` (ended by ${s.endedBy})` : ""}`, `Plan: ${s.plan.status}${s.plan.inferred ? " (inferred)" : ""}${s.plan.prs.length ? ` · PRs ${s.plan.prs.map((p) => `#${p.n}${p.state ? ` (${p.state.toLowerCase()})` : ""}`).join(", ")}` : ""}`, ""];
  if (s.plan.summary) lines.push(s.plan.summary, "");
  lines.push(`Stage: ${s.plan.stageLabel} · ${s.plan.subLabel}${s.plan.progress.pct != null ? ` · ${s.plan.progress.pct}%` : ""}`, "");
  if (s.agent.state !== "none") lines.push(`Agent: ${s.agent.name} · ${s.agent.provider} · ${s.agent.state} · ${s.agent.id}`, "");
  if ((s.reg.progress || []).length) { lines.push("## Progress", ""); for (const e of s.reg.progress) lines.push(`- ${e.at} · ${e.session?.label || ""} · ${e.text}${e.pct != null ? ` (${e.pct}%)` : ""}`); lines.push(""); }
  for (const g of transcriptGroups(s)) { lines.push(`## Session ${g.name}${g.provider ? ` (${g.provider})` : ""}`, ""); for (const i of g.items) lines.push(`### ${i.role === "agent" ? "Agent" : i.role === "system" ? "System" : "You"} · ${i.kind || ""}${i.where ? ` · on “${i.where.slice(0, 80)}”` : ""} · ${i.at}`, "", i.text, ""); }
  if (s.notes.length) { lines.push("## Private comments (never sent)", ""); for (const n of s.notes) lines.push(`- ${n.state || "private"}${n.anchor?.text ? ` · on “${String(n.anchor.text).slice(0, 80)}”` : ""}: ${n.body}`); lines.push(""); }
  if (s.versions.length) { lines.push("## Versions", ""); for (const v of s.versions) lines.push(`- v${v.n} · ${v.at} · ${v.label || v.reason}${v.round != null ? ` · round ${v.round}` : ""} · ${v.lines} lines`); lines.push(""); }
  return lines.join("\n");
}

{ const fails = checkContrast(); if (fails.length) { console.error(`lavish-home: palette contrast gate FAILED (WCAG AA 4.5:1). Fix these tokens before the page can start:\n  ${fails.join("\n  ")}`); process.exit(1); } }
/* ── version view + diff ──────────────────────────────────────────────── */
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".css": "text/css", ".js": "application/javascript", ".mjs": "application/javascript", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".pdf": "application/pdf" };
function versionBanner(s, v) {
  const total = s.versions.length;
  const link = (href, text) => `<a style="color:#ffd877;text-decoration:underline;text-underline-offset:2px" href="${href}">${text}</a>`;
  return `<div data-lavish-ui="version-banner" style="position:sticky;top:0;z-index:2147483000;background:#1c1b1a;color:#f3f1ec;font:13px/1.4 system-ui,sans-serif;padding:8px 14px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;box-shadow:0 2px 8px rgba(0,0,0,.25)"><span>Read-only snapshot · <b>v${v.n}</b> of ${total} · saved ${esc(fmt(v.at))}${v.label ? ` · ${esc(v.label)}` : v.round != null ? ` · round ${v.round}` : ""}</span>${link(`/session/${s.key}#versions`, "Version history")}${s.exists ? link(`/diff/${s.key}/${v.n}/current`, "Diff against current") : ""}</div>`;
}
/** Every conversation item of one version's window: comments sent, messages, agent replies, private notes, from v.at until the next version. */
function momentItems(s, v) {
  const next = s.versions.find((x) => x.n > v.n);
  const first = s.versions[0] && s.versions[0].n === v.n;
  const inWindow = (at) => at && (first || String(at) >= String(v.at)) && (!next || String(at) < String(next.at));
  const items = transcript(s).filter((i) => inWindow(i.at)).map((i) => ({ ...i }));
  for (const n of s.notes) if (inWindow(n.created)) items.push({ at: n.created, role: "private", kind: n.state || "private", text: n.body, where: n.anchor?.text || "" });
  return items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
function renderVersionView(s, n, serverUp) {
  const v = s.versions.find((x) => x.n === n);
  if (!v || !existsSync(versionPath(s.key, n))) return null;
  const items = momentItems(s, v);
  const cur = currentVersionState(s);
  const msg = (i) => `<div class="msg ${i.role === "agent" ? "agent" : i.role === "system" ? "sys" : i.role === "private" ? "priv" : i.kind === "annotation" ? "ann" : ""}" style="max-width:none;font-size:12.5px"><small>${i.role === "agent" ? "agent" : i.role === "system" ? "system" : i.role === "private" ? "private" : "you"} · ${esc(i.kind || "")}${i.where ? ` · “${esc(String(i.where).slice(0, 70))}”` : ""} · ${fmt(i.at)}</small>${esc(i.text)}</div>`;
  const counts = { sent: items.filter((i) => i.role === "user" && i.kind !== "message").length, msgs: items.filter((i) => i.role === "user" && i.kind === "message").length, replies: items.filter((i) => i.role === "agent").length, priv: items.filter((i) => i.role === "private").length };
  const prev = s.versions.filter((x) => x.n < n).pop();
  const nextV = s.versions.find((x) => x.n > n);
  const body = `<div style="display:grid;grid-template-columns:minmax(0,1fr) 380px;height:calc(100vh - 48px)">
  <iframe src="/version/${s.key}/${n}/raw" title="v${n} of ${esc(s.title)}" style="width:100%;height:100%;border:0;border-right:1px solid var(--rule);background:#fff"></iframe>
  <aside style="overflow:auto;padding:14px 16px 40px;background:var(--surface)">
    <div class="crumbs"><a href="/session/${s.key}">${esc(s.title)}</a> › <a href="/session/${s.key}#versions">Versions</a> › <b>v${n}</b></div>
    <h2 style="margin:6px 0 4px">v${n}${v.n === cur.n && !cur.dirty ? ' <span class="st open">current</span>' : ""} <span class="meta">of ${s.versions.length} · saved ${fmt(v.at)}${v.round != null ? ` · round ${v.round}` : ""}</span></h2>
    <p class="meta" style="margin:0 0 10px">${esc(versionWhy(v))}</p>
    <p style="margin:0 0 14px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">${prev ? `<a class="a" href="/version/${s.key}/${prev.n}/">← v${prev.n}</a><a class="a" href="/diff/${s.key}/${prev.n}/${n}">Diff → v${prev.n}</a>` : ""}${nextV ? `<a class="a" href="/version/${s.key}/${nextV.n}/">v${nextV.n} →</a>` : ""}${s.exists ? `<a class="a" href="/diff/${s.key}/${n}/current">Diff → current</a>` : ""}${s.exists && (cur.dirty || n !== cur.n) ? continueFrom(s, n, { cls: "b q" }) : '<span class="meta">this is the file on disk</span>'}</p>
    <h3 style="margin:0 0 8px;font-size:13.5px">This moment <span class="meta">${counts.sent} sent · ${counts.msgs} message${counts.msgs === 1 ? "" : "s"} · ${counts.replies} repl${counts.replies === 1 ? "y" : "ies"}${counts.priv ? ` · ${counts.priv} private` : ""} · until ${nextV ? `v${nextV.n}` : "now"}</span></h3>
    ${items.length ? items.map(msg).join("") : '<p class="empty" style="padding:6px 0">Nothing was written while this version was on screen.</p>'}
  </aside></div>`;
  return page(`v${n} · ${s.title}`, `${s.project} · ${s.title} · v${n}`, body, serverUp, { wide: true, key: s.key });
}
function serveVersion(res, s, n) {
  const v = s.versions.find((x) => x.n === n);
  if (!v || !existsSync(versionPath(s.key, n))) return send(res, 404, "text/plain", "no such version");
  let html = readFileSync(versionPath(s.key, n), "utf8");
  const base = `<base href="/version/${s.key}/${n}/" target="_parent">`;
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + base) : base + html;
  html = /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, (m) => m + versionBanner(s, v)) : versionBanner(s, v) + html;
  send(res, 200, "text/html; charset=utf-8", html);
}
function serveVersionAsset(res, s, rel) {
  const dir = dirname(s.resolved || s.file);
  const target = resolve(dir, decodeURIComponent(rel));
  const allowed = [dir, dirname(dir)].some((root) => target === root || target.startsWith(root + "/"));
  if (!allowed || !existsSync(target) || statSync(target).isDirectory()) return send(res, 404, "text/plain", "no such asset");
  res.writeHead(200, { "content-type": MIME[extname(target).toLowerCase()] || "application/octet-stream" });
  createReadStream(target).pipe(res);
}
function renderDiff(s, a, b, serverUp) {
  const load = (which) => {
    if (which === "current") { if (!s.exists) return null; return { label: "current file", html: readFileSync(s.resolved, "utf8"), at: statSync(s.resolved).mtime }; }
    const n = Number(which); const v = s.versions.find((x) => x.n === n);
    if (!v || !existsSync(versionPath(s.key, n))) return null;
    return { label: `v${n}`, html: readFileSync(versionPath(s.key, n), "utf8"), at: v.at };
  };
  const A = load(a), B = load(b);
  if (!A || !B) return null;
  const ops = diffLines(extractText(A.html), extractText(B.html));
  const adds = ops.filter((o) => o.type === "add").length, dels = ops.filter((o) => o.type === "del").length;
  const CONTEXT = 3;
  let out = "", i = 0;
  while (i < ops.length) {
    if (ops[i].type !== "same") { out += `<div class="${ops[i].type}">${esc(ops[i].text)}</div>`; i++; continue; }
    let j = i; while (j < ops.length && ops[j].type === "same") j++;
    const run = ops.slice(i, j);
    const head = i === 0 ? 0 : CONTEXT, tail = j === ops.length ? 0 : CONTEXT;
    if (run.length <= head + tail + 2) out += run.map((o) => `<div>${esc(o.text)}</div>`).join("");
    else {
      out += run.slice(0, head).map((o) => `<div>${esc(o.text)}</div>`).join("");
      out += `<details><summary>… ${run.length - head - tail} unchanged lines</summary>${run.slice(head, run.length - tail).map((o) => `<div>${esc(o.text)}</div>`).join("")}</details>`;
      out += run.slice(run.length - tail).map((o) => `<div>${esc(o.text)}</div>`).join("");
    }
    i = j;
  }
  const body = `<h1>${esc(s.title)}</h1><p class="meta"><a class="a" href="/session/${s.key}#versions">← Version history</a> · ${esc(A.label)} (${esc(fmt(A.at))}) → ${esc(B.label)} (${esc(fmt(B.at))})</p>
  <p class="legend"><b style="color:var(--good)">+${adds}</b> added · <b style="color:var(--bad)">−${dels}</b> removed · compared as the text a reader sees (scripts, styles and markup ignored). ${adds + dels === 0 ? "No visible text changed; the difference is in markup, styling or scripts." : ""}</p>
  <div class="diff">${out || `<div class="empty">Both versions have the same visible text.</div>`}</div>`;
  return page(`Diff · ${s.title}`, `${s.project} · diff`, body, serverUp);
}

/* ── progress, unsent and export sections of the session page ─────────── */
/** The plan's main events, newest first: the registry log (status, PRs, notes, verdicts), PR merges (gh), the first version,
 *  every session's start and end (from its transcript) and the terminals this page started. No per-poll entries. */
function historyOf(s) {
  const ev = [];
  const w = (x) => (STATUS_WORDS[x] || [x.replace(/-/g, " ") || "(inferred)"])[0];
  for (const e of s.reg.progress || []) {
    let text = e.text || "";
    if (e.kind === "status") { const m = /status (.*) → (.*)/.exec(text); text = m ? `Plan status · ${w(m[1].trim().replace(/[()]/g, ""))} → ${w(m[2].trim().replace(/[()]/g, ""))}${/implemented/.test(m[2]) ? " (verified)" : ""}` : `Plan status · ${text}`; }
    else if (e.kind === "pr") text = `Build · ${text}`;
    else if (e.kind === "verdict") text = `Review · ${text}`;
    else if (/^restarted by the home page/.test(text)) text = `Restarted · ${text.replace(/^restarted by the home page:?\s*/, "")}`;
    ev.push({ at: e.at, text, by: e.session?.label || "", src: `registry log · ${e.kind || "note"}`, pct: e.pct });
  }
  for (const p of s.plan.prs) if (p.mergedAt) ev.push({ at: p.mergedAt, text: `Build · PR #${p.n} merged${p.title ? ` · ${p.title}` : ""}`, by: "GitHub", src: "gh pr view · mergedAt" });
  if (s.versions[0]) ev.push({ at: s.versions[0].at, text: "Plan created · first version saved", by: "", src: "versions index" });
  const seen = new Set();
  for (const x of [s.reg.agent, ...s.agents]) {
    if (!x || !x.id || seen.has(x.id)) continue; seen.add(x.id);
    const info = sessionInfoOf(x);
    const label = `${agentLabel(x)} (${modelName(info.model) || (x.provider === "codex" ? "Codex" : "Claude")}${ENTRYPOINT_WORD[x.entrypoint] ? `, ${ENTRYPOINT_WORD[x.entrypoint]}` : ""})`;
    if (info.startedAt) ev.push({ at: info.startedAt, text: `Session started · ${label}`, by: "transcript", src: shortPath(info.file) });
    const live = s.agent.id === x.id && s.agent.state === "active";
    if (info.lastAt && !live) ev.push({ at: info.lastAt, text: `Session ended · ${label}`, by: "transcript", src: `last line of ${shortPath(info.file)}` });
  }
  for (const t of readTerminals()) if (t.planKey === s.key && t.createdAt) ev.push({ at: new Date(t.createdAt).toISOString(), text: `Terminal started · ${t.tmuxName}${t.model ? ` (${modelName(t.model)})` : ""}`, by: "home page", src: "terminals.json" });
  return ev.filter((e) => e.at).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
function renderProgress(s) {
  const sessions = recentSessions(s.reg);
  const entries = historyOf(s);
  let html = `<form method="post" action="/status/${s.key}" class="xform" style="margin:0 0 10px"><div class="row"><label style="flex:1 1 320px">Add a note <input type="text" name="progress" placeholder="what happened, e.g. PR3 opened (2 of 5)" style="flex:1"></label><label>% <input type="number" name="pct" min="0" max="100" style="width:64px"></label><button class="b q" type="submit">Save</button>${sessions.length ? `<span class="meta">working session${sessions.length > 1 ? "s" : ""} (7 days): ${sessions.map((x) => `<b>${esc(x.label)}</b> · ${fmt(x.at)}`).join(" · ")}</span>` : `<span class="meta">The agent writes here with <span class="mono">lavish-meta &lt;plan&gt; --progress "…"</span>; status and PR changes log themselves.</span>`}</div></form>`;
  if (!entries.length) return html + `<p class="empty" style="padding:6px 0 12px">No events yet.</p>`;
  html += `<div class="tw"><table class="tl"><colgroup><col style="width:14%"><col style="width:62%"><col style="width:24%"></colgroup><thead><tr><th>When</th><th>Event</th><th title="hover a row for its source">By</th></tr></thead><tbody>`;
  for (const e of entries) html += `<tr title="source: ${esc(e.src)}"><td class="num">${fmt(e.at)}</td><td>${esc(e.text)}${e.pct != null ? ` <span class="num">· ${e.pct}%</span>` : ""}</td><td class="sess">${esc(e.by)}</td></tr>`;
  return html + `</tbody></table></div>`;
}
function renderUnsent(s) {
  const items = s.unsent.items.filter((p) => !(p.tag === "message" && !p.selector) && p.tag !== "verdict");
  const draft = s.unsent.draft?.card?.text ? s.unsent.draft.card : null;
  if (!items.length && !draft) return "";
  let html = `<details class="fold" open><summary>Unsent comments <span class="meta">${items.length} queued in the Comments rail, not sent yet${draft ? " · plus an unfinished annotation card" : ""} · they reappear when the page is reopened</span></summary><div class="in">`;
  for (const p of items) html += `<div class="note"><div class="anc">${p.text ? `“${esc(String(p.text).slice(0, 120))}”` : "general"}${p.tag ? ` · &lt;${esc(p.tag)}&gt;` : ""} · queued</div>${esc(p.prompt || "")}${(p.attachments || []).length ? `<div class="thumbs">${p.attachments.map((a) => { const c = s.unsent.files?.[a.id]; const src = c?.url || `http://127.0.0.1:${process.env.LAVISH_AXI_PORT || 4387}/api/${s.key}/attachments/${a.id}`; return `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="${esc(a.name || "image")}"></a>`; }).join("")}</div>` : ""}</div>`;
  if (draft) html += `<div class="note"><div class="anc">annotation card on <span class="mono">${esc(draft.selector || "")}</span> · draft</div>${esc(draft.text)}</div>`;
  return html + `</div></details>`;
}
function renderExport(s) {
  if (!s.exists) return "";
  const chk = (v, label) => `<label><input type="checkbox" name="include" value="${v}"> ${label}</label>`;
  return `<details class="fold" id="export"><summary>Export <span class="meta">the plan alone by default; tick what to append, or untick the plan for the review material only</span></summary><div class="in">
  <form class="xform box" method="get" action="/export/${s.key}" target="_blank" onsubmit="this.include.value=[...this.querySelectorAll('input[name=include]:checked')].map(c=>c.value).join(',')">
    <div class="row"><span>Format</span><label><input type="radio" name="format" value="md" checked> Markdown</label><label><input type="radio" name="format" value="html"> HTML (self-contained)</label><label><input type="radio" name="format" value="pdf"> PDF</label></div>
    <div class="row"><span>Content</span><label><input type="checkbox" name="planbox" checked onchange="this.form.plan.value=this.checked?'1':'0'"> the plan</label>${chk("chat", "agent conversation")}${chk("comments", "comments sent")}${chk("notes", "private notes")}<input type="hidden" name="include" value=""><input type="hidden" name="plan" value="1"></div>
    <div class="row"><button class="b" type="submit">Download</button><a class="a" href="/export/${s.key}?format=html&inline=1" target="_blank">Preview HTML</a><span class="meta">PDF renders with the headless Chromium on this machine; Markdown from here uses the page's own converter run headlessly (open the plan in Lavish and export there for the fastest path).</span></div>
  </form></div></details>`;
}

/* ── export: the plan as html / pdf / md, plus optional appendices ─────── */
const exportsDir = (key) => join(stateDir, "exports", key);
const localBinEnv = () => ({ ...process.env, PATH: `${join(os.homedir(), ".local/bin")}:${process.env.PATH || ""}` });
/** Lavish's own bundler (inlines local assets, keeps CDN refs); works without the Lavish server. Falls back to the raw file. */
function selfContainedHtml(s) {
  const dir = exportsDir(s.key); mkdirSync(dir, { recursive: true });
  const out = join(dir, `bundle-${Date.now()}.html`);
  const r = spawnSync("lavish-axi", ["export", s.resolved, "--out", out], { encoding: "utf8", timeout: 30000, env: localBinEnv() });
  let html = "";
  try { if (r.status === 0 && existsSync(out)) html = readFileSync(out, "utf8"); } catch {}
  try { unlinkSync(out); } catch {}
  return html || readFileSync(s.resolved, "utf8");
}
const EXPORT_STYLE = `<style id="lavish-export-style">@page{size:A4;margin:16mm}@media print{#summarybar,.note-area,.outline,.outline-fab,.outline-toggle,.rowctl,dialog,.dform .row{display:none!important}.page{grid-template-columns:minmax(0,1fr)!important;padding-top:0!important}.mermaid-frame{resize:none;overflow:visible;min-height:0}details>summary.h::before{content:""!important}body{background:#fff}}#lavish-appendix{page-break-before:always}</style>`;
const EXPORT_RUNTIME = `<script>(function(){var X=window.__LAVISH_EXPORT||{};if(X.print){document.querySelectorAll("details").forEach(function(d){d.open=true});}if(X.md&&typeof domToMd==="function"){try{var md=domToMd();var pre=document.createElement("pre");pre.id="lavish-md";pre.textContent=md;document.body.innerHTML="";document.body.appendChild(pre);}catch(e){}}})();</script>`;
function injectExportHead(html, cfg) {
  const head = `<script>window.__LAVISH_EXPORT=${JSON.stringify(cfg).replace(/<\//g, "<\\/")};</script>${EXPORT_STYLE}`;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, head + "</head>") : head + html;
}
const appendToBody = (html, extra) => (/<\/body>/i.test(html) ? html.replace(/<\/body>/i, extra + "</body>") : html + extra);
function dataUri(path) { try { if (!path) return ""; const b = readFileSync(path); if (b.length > 8e6) return ""; return `data:${MIME[extname(path).toLowerCase()] || "application/octet-stream"};base64,${b.toString("base64")}`; } catch { return ""; } }
function lavishAttachmentPath(key, id) { const dir = join(stateDir, "attachments", key); try { const f = readdirSync(dir).find((n) => n.startsWith(id) && !n.endsWith(".meta")); return f ? join(dir, f) : ""; } catch { return ""; } }
function homeFilePath(key, id) { const dir = join(stateDir, "notes", `${key}.files`); try { const f = readdirSync(dir).find((n) => n.startsWith(id) && !n.endsWith(".json")); return f ? join(dir, f) : ""; } catch { return ""; } }
const imgTag = (src, name) => (src ? `<a href="${esc(src)}" target="_blank"><img src="${esc(src)}" alt="${esc(name)}"></a>` : `<span class="lx-missing">[image ${esc(name)} is no longer available]</span>`);
function sentNoteFor(s, h) { return s.notes.find((n) => n.sentAt && String(n.body || "") === String(h.text || "")); }
function appendixHtml(s, include) {
  const parts = [];
  const items = transcript(s);
  if (include.has("chat")) {
    const msgs = items.filter((i) => i.role === "agent" || i.role === "system" || i.kind === "message");
    parts.push(`<h2>Agent conversation</h2>` + (msgs.length ? msgs.map((i) => `<div class="lx-msg ${i.role}"><small>${i.role === "agent" ? "Agent" : i.role === "system" ? "System" : "You"} · ${esc(fmt(i.at))}</small>${esc(i.text)}</div>`).join("") : `<p class="lx-empty">No messages.</p>`));
  }
  if (include.has("comments")) {
    const sent = s.history.filter((h) => h.role === "user" && h.kind !== "message");
    parts.push(`<h2>Comments sent to the agent</h2>` + (sent.length ? sent.map((h) => {
      const note = sentNoteFor(s, h);
      const replies = (note?.replies || []).map((r) => `<div class="lx-reply">↳ ${esc(r.text)}</div>`).join("");
      const files = (h.attachments || []).map((id, i) => imgTag(dataUri(lavishAttachmentPath(s.key, id)) || dataUri(homeFilePath(s.key, note?.attachments?.[i]?.id || "")), id.slice(0, 8))).join("");
      return `<div class="lx-msg you"><small>${esc(h.tag || "annotation")}${h.where ? ` · “${esc(String(h.where).slice(0, 100))}”` : ""} · ${esc(fmt(h.at))}</small>${esc(h.text)}${files ? `<div class="lx-files">${files}</div>` : ""}${replies}</div>`;
    }).join("") : `<p class="lx-empty">None.</p>`));
  }
  if (include.has("notes")) {
    const priv = s.notes.filter((n) => !n.sentAt);
    parts.push(`<h2>Private notes</h2>` + (priv.length ? priv.map((n) => `<div class="lx-msg note"><small>${esc(n.state || "private")}${n.anchor?.text ? ` · “${esc(String(n.anchor.text).slice(0, 100))}”` : ""} · ${esc(fmt(n.updated || n.created))}</small>${esc(n.body)}${(n.attachments || []).length ? `<div class="lx-files">${n.attachments.map((a) => imgTag(dataUri(homeFilePath(s.key, a.id)), a.name)).join("")}</div>` : ""}</div>`).join("") : `<p class="lx-empty">None.</p>`));
  }
  if (!parts.length) return "";
  return `<section id="lavish-appendix"><style>#lavish-appendix{max-width:880px;margin:40px auto 80px;padding:0 28px;font:15px/1.5 "Avenir Next","Helvetica Neue",system-ui,sans-serif;color:#1c1b1a;border-top:1px solid #e6e3dd}#lavish-appendix h2{font:600 22px "Iowan Old Style","Palatino Linotype",Georgia,serif;margin:28px 0 10px}#lavish-appendix .lx-msg{margin:0 0 10px;padding:9px 12px;border-radius:8px;background:#f3f1ec;white-space:pre-wrap}#lavish-appendix .lx-msg.agent{background:#e4ecf4}#lavish-appendix .lx-msg.note{background:#fff;border:1px solid #e6e3dd}#lavish-appendix .lx-msg small{display:block;font-size:11px;color:#7a7772;margin-bottom:3px;white-space:normal}#lavish-appendix .lx-reply{margin-top:6px;padding:5px 9px;background:#fff;border-radius:6px;color:#4a4845}#lavish-appendix .lx-files{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}#lavish-appendix .lx-files img{max-width:220px;max-height:160px;border-radius:6px;border:1px solid #e6e3dd}#lavish-appendix .lx-empty,#lavish-appendix .lx-missing{color:#7a7772;font-style:italic}#lavish-appendix .lx-head small{color:#7a7772;font-size:12px}</style><div class="lx-head"><small>Appendix exported ${esc(fmt(new Date()))} from the Lavish home page</small></div>${parts.join("")}</section>`;
}
/** A standalone document of the review material only (no plan): the appendix in the plan's paper style. */
function reviewHtml(s, include) {
  const stamp = fmt(new Date());
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(s.title)} · review</title><style>@page{size:A4;margin:16mm}body{margin:0;background:#faf9f6;color:#1c1b1a;font:15px/1.5 "Avenir Next","Helvetica Neue",system-ui,sans-serif}.rv-head{max-width:880px;margin:36px auto 0;padding:0 28px}.rv-head h1{font:600 26px/1.2 "Iowan Old Style","Palatino Linotype",Georgia,serif;margin:0 0 6px}.rv-head p{color:#7a7772;font-size:13px;margin:0}#lavish-appendix{border-top:0!important;margin-top:8px!important}</style></head><body><div class="rv-head"><h1>${esc(s.title)}</h1><p>Review material only · ${esc(s.plan.stageLabel)} · ${esc(s.plan.subLabel)} · exported ${esc(stamp)} · <span>${esc(shortPath(s.resolved || s.file))}</span></p></div>${appendixHtml(s, include).replace('<div class="lx-head">', '<div class="lx-head" hidden>')}</body></html>`;
}
function exportHtml(s, include, { print = false, md = false } = {}) {
  let html = selfContainedHtml(s);
  html = injectExportHead(html, { plan: s.plan, at: new Date().toISOString(), print, md, include: [...include] });
  return appendToBody(html, (md ? "" : appendixHtml(s, include)) + EXPORT_RUNTIME);
}
function findChromium() {
  const pw = join(os.homedir(), "Library/Caches/ms-playwright");
  try {
    const dirs = readdirSync(pw).filter((d) => d.startsWith("chromium_headless_shell-")).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const d of dirs) { const bin = join(pw, d, "chrome-headless-shell-mac-arm64/chrome-headless-shell"); if (existsSync(bin)) return { bin, headlessFlag: false }; }
  } catch {}
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(chrome) ? { bin: chrome, headlessFlag: true } : null;
}
/** Print a URL to PDF or dump its DOM with the headless Chromium on this machine (Playwright's shell, else Google Chrome).
 *  Async on purpose: the page it renders is served by THIS process, so a blocking spawn would deadlock until the timeout. */
function headless(url, { pdfOut = "", dumpDom = false } = {}) {
  const c = findChromium();
  if (!c) return Promise.resolve({ error: "PDF and headless Markdown need chrome-headless-shell (Playwright) or Google Chrome; neither was found. Run: npx playwright install chromium" });
  const profile = join(stateDir, "exports", `profile-${process.pid}-${Date.now()}`);
  const args = [...(c.headlessFlag ? ["--headless=new"] : []), "--disable-gpu", "--hide-scrollbars", "--no-pdf-header-footer", "--virtual-time-budget=6000", "--timeout=15000", `--user-data-dir=${profile}`, ...(pdfOut ? [`--print-to-pdf=${pdfOut}`] : []), ...(dumpDom ? ["--dump-dom"] : []), url];
  return new Promise((resolve) => {
    let stdout = "", stderr = "", done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(killer); try { rmSync(profile, { recursive: true, force: true }); } catch {} resolve(r); };
    let child;
    try { child = spawn(c.bin, args, { stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return finish({ error: String(e.message || e) }); }
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish({ error: "headless browser timed out after 45 s", stdout, stderr }); }, 45000);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => finish({ error: String(e.message || e) }));
    child.on("close", (status) => finish({ stdout, stderr, status }));
  });
}
function writeTmpExport(key, html) {
  const dir = exportsDir(key); mkdirSync(dir, { recursive: true });
  const id = `tmp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  writeFileSync(join(dir, `${id}.html`), html);
  return { id, path: join(dir, `${id}.html`), url: `http://127.0.0.1:${PORT}/export-tmp/${key}/${id}.html` };
}
function sweepExports() {
  try {
    const root = join(stateDir, "exports"); if (!existsSync(root)) return;
    for (const k of readdirSync(root)) { const d = join(root, k); let names = []; try { names = readdirSync(d); } catch { continue; }
      for (const n of names) { if (!/^(tmp-|bundle-|profile-)/.test(n)) continue; const p = join(d, n); try { if (Date.now() - statSync(p).mtimeMs > 3600e3) rmSync(p, { recursive: true, force: true }); } catch {} } }
  } catch {}
}
/** The plan as Markdown: the page's own converter (handed over by the artifact, or run headlessly), else plain text. */
async function planMarkdown(s) {
  const dir = exportsDir(s.key);
  const meta = readJson(join(dir, "plan.md.json"), null);
  try { if (meta && meta.sourceSha === sha(readFileSync(s.resolved, "utf8")) && existsSync(join(dir, "plan.md"))) return { md: readFileSync(join(dir, "plan.md"), "utf8"), source: "page" }; } catch {}
  const tmp = writeTmpExport(s.key, exportHtml(s, new Set(), { md: true }));
  const r = await headless(tmp.url, { dumpDom: true });
  try { unlinkSync(tmp.path); } catch {}
  const m = r.stdout ? /<pre id="lavish-md">([\s\S]*?)<\/pre>/.exec(r.stdout) : null;
  if (m && m[1].trim()) return { md: decodeEntities(m[1]), source: "headless" };
  return { md: `> Plain-text fallback: open the plan in Lavish and export from the page for structured Markdown.\n\n` + extractText(readFileSync(s.resolved, "utf8")).join("\n\n"), source: "text" };
}
function appendixMd(s, include) {
  const out = [];
  const items = transcript(s);
  if (include.has("chat")) { out.push("## Agent conversation", ""); for (const i of items.filter((i) => i.role === "agent" || i.role === "system" || i.kind === "message")) out.push(`**${i.role === "agent" ? "Agent" : i.role === "system" ? "System" : "You"}** · ${i.at}`, "", i.text, ""); }
  if (include.has("comments")) { out.push("## Comments sent to the agent", ""); for (const h of s.history.filter((h) => h.role === "user" && h.kind !== "message")) { out.push(`- **${h.tag || "annotation"}**${h.where ? ` on “${String(h.where).slice(0, 80)}”` : ""} (${h.at}): ${h.text}`); for (const r of sentNoteFor(s, h)?.replies || []) out.push(`  - ↳ ${r.text}`); } out.push(""); }
  if (include.has("notes")) { out.push("## Private notes", ""); for (const n of s.notes.filter((n) => !n.sentAt)) out.push(`- **${n.state || "private"}**${n.anchor?.text ? ` on “${String(n.anchor.text).slice(0, 80)}”` : ""}: ${n.body}${(n.attachments || []).map((a) => ` ![${a.name}](${a.url})`).join("")}`); out.push(""); }
  return out.join("\n");
}


/* ── server ───────────────────────────────────────────────────────────── */
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
function cors(req, res) {
  const origin = req.headers.origin;
  const pathname = new URL(req.url, "http://x").pathname;
  if (origin === "null" && req.method === "GET" && /^\/api\/(registry|versions|sessions)/.test(pathname)) { res.setHeader("access-control-allow-origin", "null"); return; }
  if (origin === "null" && /^\/api\/export\/[0-9a-f]{16}\/plan\.md$/.test(pathname)) { res.setHeader("access-control-allow-origin", "null"); res.setHeader("access-control-allow-methods", "PUT,OPTIONS"); res.setHeader("access-control-allow-headers", "content-type"); return; }
  if (!origin || !LOOPBACK.test(origin)) return;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-max-age", "600");
}
function send(res, code, type, body) { res.writeHead(code, { "content-type": type }); res.end(body); }
const json = (res, code, value) => send(res, code, "application/json; charset=utf-8", JSON.stringify(value));
const redirect = (res, location) => { res.writeHead(303, { location }); res.end(); };
function readBody(req) { return new Promise((ok, fail) => { let d = ""; req.on("data", (c) => { d += c; if (d.length > 8e6) req.destroy(); }); req.on("end", () => ok(d)); req.on("error", fail); }); }
function readRawBody(req, max) { return new Promise((ok, fail) => { const chunks = []; let size = 0, over = false; req.on("data", (c) => { size += c.length; if (size > max) { over = true; req.resume(); return; } chunks.push(c); }); req.on("end", () => ok(over ? null : Buffer.concat(chunks))); req.on("error", fail); }); }
function parseBody(raw, type = "") { if (/json/i.test(type)) { try { return JSON.parse(raw || "{}"); } catch { return {}; } } return Object.fromEntries(new URLSearchParams(raw)); }
async function lavishUp() { try { const r = await fetch(`${lavishBase}/health`); return r.ok; } catch { return false; } }
const safeBack = (b, fallback) => (b && b.startsWith("/") && !b.startsWith("//") ? b : fallback);
/** Resume the plan's Lavish session headlessly (as /open does) and return its URL, or an error. */
function openLavish(s) {
  const r = spawnSync("lavish-axi", [s.resolved, "--no-open", ...(s.endedBy === "user" ? ["--reopen"] : [])], { encoding: "utf8", env: localBinEnv(), timeout: 60000 });
  if (r.status !== 0) return { error: `lavish-axi failed:\n${r.stdout}\n${r.stderr}` };
  const fresh = loadSessions().find((x) => x.resolved === s.resolved || x.file === s.resolved);
  return { url: fresh?.url || `${lavishBase}/session/${s.key}` };
}
/** /view/<key>/: the plan itself, read-only, with a <base> so its relative assets resolve through /view/<key>/<asset>. */
function serveView(res, s) {
  let html = readFileSync(s.resolved, "utf8");
  const base = `<base href="/view/${s.key}/">`;
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + base) : base + html;
  send(res, 200, "text/html; charset=utf-8", html);
}
/** Siblings of the plan file only (its own folder and subfolders); a ../ is refused; state.json is never touched. */
function serveViewAsset(res, s, rel) {
  const dir = dirname(s.resolved);
  let target; try { target = resolve(dir, normPath(decodeURIComponent(rel))); } catch { return send(res, 404, "text/plain", "no such asset"); }
  if (!target.startsWith(dir + "/") || !existsSync(target) || statSync(target).isDirectory()) return send(res, 404, "text/plain", "no such asset (only files beside the plan are served)");
  res.writeHead(200, { "content-type": MIME[extname(target).toLowerCase()] || "application/octet-stream" });
  createReadStream(target).pipe(res);
}
const layoutJson = (sessions) => { const layout = readLayout(); const tags = tagList(layout, new Set(sessions.map((s) => s.key))); return { layout, tags, counts: Object.fromEntries(tags.map((t) => [t.id, t.count])) }; };
const okLevel = (v, list) => (list.includes(String(v || "")) ? String(v) : "");
/** Resume or New session for a plan (the /connect POST, also used after Continue from ▾). Returns {redirect} or {status, html}. */
async function launchAction(s, { isNew, body, wanted = "" }, serverUp) {
  const provider = isNew ? (body.provider === "codex" ? "codex" : "claude") : (s.agent.provider || "claude");
  const model = String(body.model_free || body.model || "").trim();
  const effort = okLevel(body.effort, LAUNCH_OPTIONS[provider].efforts);
  const remember = { provider, model, effort, ...(isNew && body.prompt ? { prompt: String(body.prompt).slice(0, 4000) } : {}) };
  try { updateRegistry(s.key, { file: s.resolved, launch: remember }); } catch {}
  const back = `/session/${s.key}`;
  const fail = (status, title, message, opts = {}) => ({ status, html: errorPage(title, message, opts, serverUp) });
  await refreshLive(true);
  if (isNew) {
    const r = await startNewAgent({ provider, cwd: String(body.cwd || projectCwd(s)), planPath: s.resolved, planKey: s.key, model, effort, prompt: body.prompt }, { live: liveCache });
    if (!r.ok) return fail(422, "Could not start a new session", r.error, { back: `${back}#launch` });
    if (r.agent) { try { updateRegistry(s.key, { file: s.resolved, agent: r.agent }); } catch {} }
    const note = `Started ${r.tmuxName} in Terminal.app${r.terminalError ? ` (the window did not open: ${r.terminalError}; attach with: tmux attach -t '=${r.tmuxName}')` : ""}. Its first prompt opens this plan in Lavish and polls it${r.provider === "codex" ? "; the Codex thread is matched by folder on that first poll" : ""}.`;
    return { redirect: `${back}?notice=${encodeURIComponent(note)}#agent` };
  }
  // Resume: optionally a specific earlier session (from a transcript group), else the plan's current agent
  const rec = wanted ? (s.agents.find((a) => a.id === wanted) || (s.reg.agent && s.reg.agent.id === wanted ? s.reg.agent : null)) : s.reg.agent;
  if (wanted && !rec) return fail(404, "Unknown session", `No session ${wanted} is recorded on this plan.`, { back });
  const r = await resumeAgent({ agent: rec }, s.key, { model, effort }, { live: liveCache, tmuxNames: liveCache.tmux });
  if (!r.ok) return fail(422, "Could not resume", r.error, { back: `${back}#launch`, extra: `<p><a class="a" href="${back}#launch">Start a New session instead</a></p>` });
  const lv = openLavish(s);
  if (lv.error) return fail(500, "Terminal ready, Lavish did not open", `${r.action === "resume" ? `Resumed in ${r.tmuxName}. ` : ""}${lv.error}`, { back });
  if (r.action === "lavish" || r.terminalError || r.note) {
    const msg = r.action === "lavish" ? r.note : `${r.note || (r.action === "resume" ? `Resumed ${r.state.name} in terminal ${r.tmuxName}.` : `Terminal ${r.tmuxName}.`)}${r.terminalError ? ` Terminal.app did not open: ${r.terminalError}. Attach by hand: tmux attach -t '=${r.tmuxName}'` : ""}`;
    return { status: 200, html: page("Resume", s.title, `<div class="errpage"><h1>${esc(s.title)}</h1><div class="notice ${r.terminalError ? "warn" : ""}">${esc(msg)}</div><p><a class="b" style="text-decoration:none;padding:6px 12px;border-radius:6px;background:var(--acc);color:var(--accInk)" href="${esc(lv.url)}">Open the plan in Lavish</a></p><p class="meta">Opens by itself in 5 s.</p><meta http-equiv="refresh" content="5;url=${esc(lv.url)}"><p class="meta"><a class="a" href="${back}">← Back to the plan page</a></p></div>`, serverUp) };
  }
  return { redirect: lv.url };
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const path = url.pathname;
    let m;
    cors(req, res);
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    if (path === "/health") return json(res, 200, { ok: true, app: "lavish-home", sessions: Object.keys(readJson(join(stateDir, "state.json"), { sessions: {} }).sessions || {}).length, agentScan: lastAgentScan });

    /* API (CORS-enabled for the Lavish chrome) */
    if ((m = /^\/api\/queue\/([0-9a-f]{16})$/.exec(path))) {
      if (req.method === "GET") return json(res, 200, readQueue(m[1]));
      if (req.method === "PUT") { const body = parseBody(await readBody(req), req.headers["content-type"]); return json(res, 200, writeQueue(m[1], body)); }
      if (req.method === "DELETE") { deleteQueue(m[1]); return json(res, 200, { deleted: true }); }
      return json(res, 405, { error: "GET, PUT or DELETE" });
    }
    if ((m = /^\/api\/export\/([0-9a-f]{16})\/plan\.md$/.exec(path))) {
      if (req.method !== "PUT") return json(res, 405, { error: "PUT text/plain" });
      const state = readJson(join(stateDir, "state.json"), { sessions: {} });
      const file = resolveFile(state.sessions?.[m[1]]?.file || "");
      const raw = await readRawBody(req, 4 * 1024 * 1024);
      if (!raw) return json(res, 413, { error: "markdown larger than 4 MB" });
      const dir = exportsDir(m[1]); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "plan.md"), raw);
      let sourceSha = ""; try { if (file) sourceSha = sha(readFileSync(file, "utf8")); } catch {}
      writeJsonAtomic(join(dir, "plan.md.json"), { at: new Date().toISOString(), sourceSha, bytes: raw.length });
      return json(res, 200, { stored: true, bytes: raw.length });
    }
    if ((m = /^\/api\/notes\/([0-9a-f]{16})\/files(?:\/([0-9a-z]{6,40})(\.[a-z0-9]+)?)?$/.exec(path))) {
      const dir = join(stateDir, "notes", `${m[1]}.files`);
      if (req.method === "PUT" && !m[2]) {
        const name = String(url.searchParams.get("name") || "image").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
        const type = String(req.headers["content-type"] || "application/octet-stream").split(";")[0].trim();
        if (!/^image\//.test(type)) return json(res, 415, { error: "only images are stored as private attachments" });
        const body = await readRawBody(req, 25 * 1024 * 1024);
        if (!body) return json(res, 413, { error: "image larger than 25 MB" });
        const ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg" }[type] || "";
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${id}${ext}`), body);
        writeJsonAtomic(join(dir, `${id}.json`), { id, name, type, size: body.length, at: new Date().toISOString() });
        return json(res, 200, { id, name, type, size: body.length, url: `http://127.0.0.1:${PORT}/api/notes/${m[1]}/files/${id}` });
      }
      if (!m[2]) return json(res, 405, { error: "PUT a file, or GET /files/<id>" });
      const meta = readJson(join(dir, `${m[2]}.json`), null);
      const file = meta ? readdirSync(dir).find((f) => f.startsWith(m[2]) && !f.endsWith(".json")) : null;
      if (!meta || !file) return json(res, 404, { error: "no such file" });
      if (req.method === "DELETE") { try { unlinkSync(join(dir, file)); unlinkSync(join(dir, `${m[2]}.json`)); } catch {} return json(res, 200, { deleted: m[2] }); }
      res.writeHead(200, { "content-type": meta.type || "application/octet-stream", "cache-control": "private, max-age=86400", "content-disposition": `inline; filename="${meta.name.replace(/"/g, "")}"` });
      return createReadStream(join(dir, file)).pipe(res);
    }
    if ((m = /^\/api\/notes\/([0-9a-f]{16})$/.exec(path))) {
      if (req.method === "GET") return json(res, 200, readNotes(m[1]));
      if (req.method === "PUT") { const body = parseBody(await readBody(req), req.headers["content-type"]); return json(res, 200, writeNotes(m[1], body.notes)); }
      return json(res, 405, { error: "GET or PUT" });
    }
    await refreshLive();
    if ((m = /^\/api\/registry\/([0-9a-f]{16})(\/refresh-prs)?$/.exec(path))) {
      const sessions = loadSessions(); const s = sessions.find((x) => x.key === m[1]);
      if (!s) return json(res, 404, { error: "no such session" });
      if (m[2]) { const r = refreshPrs(s, { force: true }); return json(res, 200, { ...r, plan: loadSessions().find((x) => x.key === m[1]).plan }); }
      if (req.method === "POST") {
        const body = parseBody(await readBody(req), req.headers["content-type"]);
        const origin = String(req.headers.origin || "");
        const session = body.session && typeof body.session === "object" ? body.session : { label: LOOPBACK.test(origin) ? "reviewer (Lavish)" : origin === "null" ? "plan page" : "home page", host: os.hostname().replace(/\.local$/, "") };
        try { updateRegistry(m[1], { file: s.resolved || undefined, status: body.status, priority: body.priority, summary: body.summary, addPrs: body.addPrs, removePrs: body.removePrs, progress: body.progress, pct: body.pct, progressKind: body.progressKind, session }); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      const fresh = loadSessions().find((x) => x.key === m[1]);
      const plan = url.searchParams.get("all") === "1" ? { ...fresh.plan, progress: { ...fresh.plan.progress, entries: fresh.reg.progress || [] } } : fresh.plan;
      return json(res, 200, { registry: fresh.reg, plan, agent: fresh.agent });
    }
    if ((m = /^\/api\/versions\/([0-9a-f]{16})(\/snapshot)?$/.exec(path))) {
      const state = readJson(join(stateDir, "state.json"), { sessions: {} });
      const file = resolveFile(state.sessions?.[m[1]]?.file || "");
      if (m[2] && req.method === "POST" && file) { snapshotVersion(file, m[1], { reason: "chrome", round: roundOf(m[1]) }); seenMtime.set(m[1], statSync(file).mtimeMs); }
      const idx = readVersionIndex(m[1]);
      let current = null;
      if (file && idx.versions.length) { try { const digest = sha(readFileSync(file, "utf8")); current = idx.versions.find((v) => v.sha === digest)?.n ?? null; } catch {} }
      return json(res, 200, { ...idx, current, round: roundOf(m[1]), home: `http://127.0.0.1:${PORT}` });
    }
    if (path === "/api/sessions") return json(res, 200, loadSessions().map((s) => ({ key: s.key, title: s.title, project: s.project, file: s.resolved || s.file, status: s.status, plan: s.plan.status, priority: s.plan.priority, stage: s.plan.stage, progress: s.plan.progress.latest, session: s.plan.session, unsent: s.unsentCount, prs: s.plan.prs.map((p) => p.n), updated: s.updated, url: s.url, versions: s.versionCount, privateNotes: s.privateNotes,
      tags: s.tags, tabs: s.tabs, build: s.plan.build.key, added: s.added,
      agent: s.agent.state === "none" ? null : { provider: s.agent.provider, id: s.agent.id, state: s.agent.state, name: s.agent.name, model: s.agent.model, terminal: s.agent.terminal, tmuxName: s.agent.tmuxName, entrypoint: s.agent.entrypoint, cwd: s.agent.cwd, source: s.agent.source, at: s.agent.at } })));
    if (path === "/api/layout") {
      if (req.method === "GET") return json(res, 200, layoutJson(loadSessions()));
      if (req.method === "PUT") {
        const b = parseBody(await readBody(req), req.headers["content-type"]);
        try {
          if (b.op === "tag") tagPlan(String(b.key || ""), String(b.tid || ""), true);
          else if (b.op === "untag") tagPlan(String(b.key || ""), String(b.tid || ""), false);
          else if (b.op === "tag-create") createTag(String(b.name || ""));
          else if (b.op === "tag-rename") renameTag(String(b.tid || ""), String(b.name || ""));
          else if (b.op === "tag-delete") deleteTag(String(b.tid || ""));
          else if (b.op === "order-projects") setProjectOrder(Array.isArray(b.names) ? b.names : []);
          else if (b.op === "order-plans") setPlanOrder(String(b.project || ""), Array.isArray(b.keys) ? b.keys : []);
          else return json(res, 400, { error: "op must be tag, untag, tag-create, tag-rename, tag-delete, order-projects or order-plans" });
        } catch (e) { return json(res, 400, { error: e.message }); }
        const sessions = loadSessions();
        const touched = b.op === "tag" || b.op === "untag" ? sessions.find((x) => x.key === b.key) : null;
        return json(res, 200, { ...layoutJson(sessions), tagsHtml: touched ? tagsCellHtml(touched) : "" });
      }
      return json(res, 405, { error: "GET or PUT" });
    }
    if ((m = /^\/api\/presence\/([0-9a-f]{16})$/.exec(path))) {
      if (req.method === "GET") return json(res, 200, { tabs: presenceTabs(m[1]).filter((t) => !t.close).map((t) => ({ tab: t.tab, at: new Date(t.at).toISOString(), title: t.title })) });
      if (req.method !== "PUT" && req.method !== "POST") return json(res, 405, { error: "GET, PUT or POST" });
      const gone = url.searchParams.get("gone") === "1";
      const b = gone ? { tab: url.searchParams.get("tab") } : parseBody(await readBody(req), req.headers["content-type"]);
      const tab = String(b.tab || "").slice(0, 40); if (!tab) return json(res, 400, { error: "tab id needed" });
      if (!presence.has(m[1])) presence.set(m[1], new Map());
      const tabs = presence.get(m[1]);
      if (gone) { tabs.delete(tab); return json(res, 200, { gone: true }); }
      const prev = tabs.get(tab);
      if (prev && prev.close) { tabs.delete(tab); return json(res, 200, { close: true, reason: prev.close }); }
      tabs.set(tab, { at: Date.now(), title: String(b.title || "").slice(0, 200), close: "" });
      return json(res, 200, { close: false, tabs: presenceCount(m[1]) });
    }

    if ((m = /^\/export-tmp\/([0-9a-f]{16})\/(tmp-[a-z0-9]+\.html)$/.exec(path))) {
      const f = join(exportsDir(m[1]), m[2]);
      if (!existsSync(f)) return send(res, 404, "text/plain", "gone");
      return send(res, 200, "text/html; charset=utf-8", readFileSync(f, "utf8"));
    }
    const sessions = loadSessions();
    const layout = readLayout();
    const serverUp = await lavishUp();
    if (path === "/") return send(res, 200, "text/html; charset=utf-8", renderIndex(sessions, url.searchParams, serverUp, layout));
    if ((m = /^\/session\/([0-9a-f]{16})(\.md)?$/.exec(path))) {
      const s = sessions.find((x) => x.key === m[1]); if (!s) return send(res, 404, "text/plain", "no such session");
      if (m[2]) { res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${basename(s.file, ".html")}-transcript.md"` }); return res.end(transcriptMd(s)); }
      return send(res, 200, "text/html; charset=utf-8", renderSession(s, sessions, serverUp, url.searchParams, layout));
    }
    if ((m = /^\/view\/([0-9a-f]{16})\/(.*)$/.exec(path))) {
      const s = sessions.find((x) => x.key === m[1]); if (!s || !s.exists) return send(res, 404, "text/plain", "no such session or file missing");
      return m[2] ? serveViewAsset(res, s, m[2]) : serveView(res, s);
    }
    if ((m = /^\/view\/([0-9a-f]{16})$/.exec(path))) return redirect(res, `${path}/`);
    if ((m = /^\/version\/([0-9a-f]{16})\/(\d+)\/(.*)$/.exec(path))) {
      const s = sessions.find((x) => x.key === m[1]); if (!s) return send(res, 404, "text/plain", "no such session");
      if (!m[3]) { const html = renderVersionView(s, Number(m[2]), serverUp); return html ? send(res, 200, "text/html; charset=utf-8", html) : send(res, 404, "text/plain", "no such version"); }
      if (m[3] === "raw") return serveVersion(res, s, Number(m[2]));
      return serveVersionAsset(res, s, m[3]);
    }
    if ((m = /^\/version\/([0-9a-f]{16})\/(\d+)$/.exec(path))) return redirect(res, `${path}/`);
    if ((m = /^\/diff\/([0-9a-f]{16})\/(\d+|current)\/(\d+|current)$/.exec(path))) {
      const s = sessions.find((x) => x.key === m[1]); if (!s) return send(res, 404, "text/plain", "no such session");
      const html = renderDiff(s, m[2], m[3], serverUp);
      return html ? send(res, 200, "text/html; charset=utf-8", html) : send(res, 404, "text/plain", "no such version");
    }
    if ((m = /^\/connect\/([0-9a-f]{16})$/.exec(path))) {
      const s = sessions.find((x) => x.key === m[1]); if (!s || !s.exists) return send(res, 404, "text/plain", "no such session or file missing");
      if (req.method === "GET") return redirect(res, `/session/${s.key}#launch`);
      if (req.method !== "POST") return send(res, 405, "text/plain", "GET or POST");
      const body = parseBody(await readBody(req), req.headers["content-type"]);
      const out = await launchAction(s, { isNew: url.searchParams.get("new") === "1", body, wanted: url.searchParams.get("agent") || "" }, serverUp);
      return out.redirect ? redirect(res, out.redirect) : send(res, out.status, "text/html; charset=utf-8", out.html);
    }
    if (req.method === "POST" && (m = /^\/effort\/([0-9a-f]{16})$/.exec(path))) {
      const s = sessions.find((x) => x.key === m[1]); if (!s) return send(res, 404, "text/plain", "no such session");
      const body = parseBody(await readBody(req), req.headers["content-type"]);
      const level = okLevel(body.level, LAUNCH_OPTIONS.claude.efforts.filter((e) => e !== "default"));
      const a = s.agent; const back = `/session/${s.key}`;
      const say = (t) => redirect(res, `${back}?effort=${encodeURIComponent(t)}#agent`);
      if (!level) return say("Pick an effort level (low, medium, high, xhigh, max).");
      if (!(a.state === "active" && a.terminal && a.provider === "claude")) return say("Change effort needs a live Claude session in a terminal this page or Manager Marcus started; this plan's agent is not one.");
      const pane = await capturePane(a.tmuxName, 12);
      if (pane == null) return say(`Terminal ${a.tmuxName} is gone.`);
      if (!paneIdle(pane)) return say(`Not sent: ${a.tmuxName} is not at its prompt (it may be mid-task). Last lines:\n${pane.trim().split("\n").slice(-4).join("\n")}`);
      const r = await sendText(a.tmuxName, `/effort ${level}`);
      if (!r.ok) return say(`Could not type into ${a.tmuxName}: ${r.error}`);
      await new Promise((ok) => setTimeout(ok, 1500));
      const after = (await capturePane(a.tmuxName, 10)) || "";
      return say(`Typed /effort ${level} into ${a.tmuxName}. The pane now reads:\n${after.trim().split("\n").filter(Boolean).slice(-6).join("\n").slice(0, 700)}`);
    }
    if (req.method === "POST" && (m = /^\/scan\/([0-9a-f]{16})$/.exec(path))) {
      const s = sessions.find((x) => x.key === m[1]); if (!s || !s.exists) return send(res, 404, "text/plain", "no such session or file missing");
      const started = Date.now();
      const hits = await scanTranscripts(s.resolved, projectCwd(s));
      for (const h of hits.slice().reverse()) { try { updateRegistry(s.key, { file: s.resolved, agent: { provider: h.provider, id: h.id, cwd: projectCwd(s), entrypoint: h.provider === "codex" ? "codex" : "", guessed: Boolean(h.guessed), source: "scan", at: h.at } }); } catch {} }
      const names = hits.map((h) => `${agentLabel({ id: h.id, name: h.provider === "claude" ? liveCache.claude.find((l) => l.sessionId === h.id)?.name || "" : "" })}${h.provider === "codex" ? " (codex, guessed)" : ""}`);
      return redirect(res, `/session/${s.key}?scan=${encodeURIComponent(hits.length ? `Found ${hits.length} session(s) in the last 7 days of ${shortPath(projectCwd(s))}: ${names.join(", ")} (${Date.now() - started} ms). Dotted = from the scan; a real poll replaces it.` : `No session in the last 7 days of ${shortPath(projectCwd(s))} read or edited this plan through a path tool (${Date.now() - started} ms).`)}#agent`);
    }
    if (req.method === "POST" && path === "/tags") {
      const b = parseBody(await readBody(req), req.headers["content-type"]);
      try { const { tid } = createTag(b.name); return redirect(res, safeBack(url.searchParams.get("back"), `/?tag=${tid}`)); } catch (e) { return send(res, 400, "text/html; charset=utf-8", errorPage("Could not create the tag", e.message, {}, serverUp)); }
    }
    if (req.method === "POST" && (m = /^\/tags\/([a-z0-9]{6,24})$/.exec(path))) {
      const b = parseBody(await readBody(req), req.headers["content-type"]);
      try {
        if (b.op === "rename") { renameTag(m[1], b.name); return redirect(res, `/?tag=${m[1]}`); }
        if (b.op === "delete") { deleteTag(m[1]); return redirect(res, "/"); }
        return send(res, 400, "text/plain", "op must be rename or delete");
      } catch (e) { return send(res, 400, "text/html; charset=utf-8", errorPage("Tag change refused", e.message, { back: `/?tag=${m[1]}` }, serverUp)); }
    }
    if (req.method === "POST" && (m = /^\/tag\/([0-9a-f]{16})$/.exec(path))) {
      const b = parseBody(await readBody(req), req.headers["content-type"]);
      try { tagPlan(m[1], String(b.tid || ""), b.on !== "0"); } catch (e) { return send(res, 400, "text/html; charset=utf-8", errorPage("Could not tag the plan", e.message, {}, serverUp)); }
      return redirect(res, safeBack(url.searchParams.get("back"), `/session/${m[1]}`));
    }
    if (req.method === "POST" && (m = /^\/tabs\/([0-9a-f]{16})\/close$/.exec(path))) {
      const tabs = presenceTabs(m[1]).filter((t) => !t.close).sort((a, b) => b.at - a.at);
      const n = markTabs(m[1], "closed from the home page", { keep: tabs[0]?.tab || "" });
      return redirect(res, safeBack(url.searchParams.get("back"), `/session/${m[1]}?notice=${encodeURIComponent(`${n} tab${n === 1 ? "" : "s"} told to close (each closes itself on its next ping, within 10 s).`)}`));
    }
    if (req.method === "POST" && (m = /^\/rename\/([0-9a-f]{16})$/.exec(path))) {
      const s = sessions.find((x) => x.key === m[1]); if (!s || !s.exists) return send(res, 404, "text/plain", "no such session or file missing");
      const b = parseBody(await readBody(req), req.headers["content-type"]);
      const title = String(b.title || "").replace(/\s+/g, " ").trim().slice(0, 140);
      if (!title) return send(res, 400, "text/html; charset=utf-8", errorPage("Rename refused", "A plan needs a title.", { back: `/session/${s.key}` }, serverUp));
      if (title === s.title) return redirect(res, `/session/${s.key}`);
      snapshotVersion(s.resolved, s.key, { reason: "pre-rename", label: `before rename (${s.title})` });
      let html = readFileSync(s.resolved, "utf8");
      html = /<title>[^<]*<\/title>/i.test(html) ? html.replace(/<title>[^<]*<\/title>/i, () => `<title>${esc(title)}</title>`) : html.replace(/<head[^>]*>/i, (h) => `${h}<title>${esc(title)}</title>`);
      writeFileSync(s.resolved, html);
      snapshotVersion(s.resolved, s.key, { reason: "rename", label: `renamed: ${title}` });
      appendHistory(s.key, s.resolved, { role: "system", kind: "rename", text: `renamed from “${s.title}” to “${title}” on the home page` });
      seenMtime.delete(s.key);
      return redirect(res, `/session/${s.key}?notice=${encodeURIComponent(`Renamed to “${title}”. The Lavish tab shows the new title after a reload.`)}`);
    }
    if (req.method === "POST" && (m = /^\/restart\/([0-9a-f]{16})$/.exec(path))) {
      const s = sessions.find((x) => x.key === m[1]); if (!s || !s.exists) return send(res, 404, "text/plain", "no such session or file missing");
      const back = `/session/${s.key}`;
      await refreshLive(true);
      const st = agentState(s.reg, liveCache, liveCache.tmux);
      if (st.state === "active") return send(res, 409, "text/html; charset=utf-8", errorPage("Restart refused", `Session ${st.name} is live in ${st.terminal ? `terminal ${st.tmuxName}` : st.entrypointLabel || "another process"}. End it there first, then Restart: a second agent on the same plan would fight the first. Nothing was started.`, { back }, serverUp));
      let endNote = "";
      if (s.status !== "ended") { const r = spawnSync("lavish-axi", ["end", s.resolved], { encoding: "utf8", env: localBinEnv(), timeout: 60000 }); if (r.status !== 0) endNote = ` (lavish-axi end failed: ${(r.stderr || r.stdout || "").trim().slice(0, 200)})`; }
      const closed = markTabs(s.key, "restarted from the home page");
      const l = s.reg.launch || {};
      const provider = l.provider || st.provider || "claude";
      const r = await startNewAgent({ provider, cwd: projectCwd(s), planPath: s.resolved, planKey: s.key, model: l.model, effort: l.effort }, { live: liveCache });
      if (!r.ok) return send(res, 422, "text/html; charset=utf-8", errorPage("Could not restart", `The Lavish session was ended${endNote} and ${closed} tab${closed === 1 ? "" : "s"} told to close, but no new session started: ${r.error}`, { back }, serverUp));
      try { if (r.agent) updateRegistry(s.key, { file: s.resolved, agent: r.agent }); updateRegistry(s.key, { file: s.resolved, progress: `restarted by the home page: ${r.tmuxName} (${provider}${l.model ? `, ${l.model}` : ""})${closed ? ` · ${closed} tab${closed === 1 ? "" : "s"} told to close` : ""}`, session: { label: "home page", host: os.hostname().replace(/\.local$/, "") } }); } catch {}
      return redirect(res, `${back}?notice=${encodeURIComponent(`Restarted: Lavish session ended${endNote}, ${closed} tab${closed === 1 ? "" : "s"} told to close, ${r.tmuxName} started in Terminal.app${r.terminalError ? ` (the window did not open: ${r.terminalError}; attach with: tmux attach -t '=${r.tmuxName}')` : ""}. Its first prompt reopens this plan in Lavish and polls it.`)}#agent`);
    }
    if ((m = /^\/export\/([0-9a-f]{16})$/.exec(path))) {
      const s = sessions.find((x) => x.key === m[1]); if (!s || !s.exists) return send(res, 404, "text/plain", "no such session or file missing");
      const format = ["html", "pdf", "md"].includes(url.searchParams.get("format")) ? url.searchParams.get("format") : "html";
      const include = new Set(String(url.searchParams.get("include") || "").split(",").map((x) => x.trim()).filter((x) => ["chat", "comments", "notes"].includes(x)));
      const withPlan = url.searchParams.get("plan") !== "0";
      if (!withPlan && !include.size) return send(res, 400, "text/plain; charset=utf-8", "Nothing to export: tick at least one of chat, comments, notes when the plan is left out.");
      const stem = basename(s.resolved, ".html") + (withPlan ? ".export" : ".review") + ["chat", "comments", "notes"].filter((x) => include.has(x)).map((x) => "+" + x).join("");
      const inline = url.searchParams.get("inline") === "1";
      const disp = (ext) => (inline ? {} : { "content-disposition": `attachment; filename="${stem}.${ext}"` });
      if (format === "md") {
        const { md, source } = withPlan ? await planMarkdown(s) : { md: `# ${s.title}\n\n*Review material only · ${s.plan.stageLabel} · ${s.plan.subLabel} · exported ${new Date().toISOString()}*`, source: "review" };
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "x-lavish-md-source": source, ...disp("md") });
        return res.end(md + (include.size ? "\n\n---\n\n" + appendixMd(s, include) : "") + "\n");
      }
      const html = withPlan ? exportHtml(s, include, { print: format === "pdf" }) : reviewHtml(s, include);
      if (format === "html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...disp("html") }); return res.end(html); }
      const tmp = writeTmpExport(s.key, html);
      const pdfPath = join(exportsDir(s.key), `${tmp.id}.pdf`);
      const r = await headless(tmp.url, { pdfOut: pdfPath });
      try { unlinkSync(tmp.path); } catch {}
      if (r.error || !existsSync(pdfPath)) return send(res, 501, "text/plain; charset=utf-8", `PDF rendering failed: ${r.error || (r.stderr || "").slice(-600) || "no output"}`);
      const pdf = readFileSync(pdfPath); try { unlinkSync(pdfPath); } catch {}
      res.writeHead(200, { "content-type": "application/pdf", "content-length": pdf.length, ...disp("pdf") });
      return res.end(pdf);
    }
    if (req.method === "POST" && (m = /^\/restore\/([0-9a-f]{16})\/(\d+)$/.exec(path))) {
      const s = sessions.find((x) => x.key === m[1]); const n = Number(m[2]);
      if (!s || !s.exists) return send(res, 404, "text/plain", "no such session or file missing");
      if (!s.versions.find((v) => v.n === n) || !existsSync(versionPath(s.key, n))) return send(res, 404, "text/plain", "no such version");
      const then = url.searchParams.get("then") || "";
      snapshotVersion(s.resolved, s.key, { reason: "pre-restore" });
      copyFileSync(versionPath(s.key, n), s.resolved);
      snapshotVersion(s.resolved, s.key, { reason: "restore", label: `restored v${n}` });
      appendHistory(s.key, s.resolved, { role: "system", kind: "restore", text: `restored v${n} from the home page${then ? ` (then: ${then === "new" ? "new session" : "resume"})` : ""}` });
      seenMtime.delete(s.key);
      if (then === "resume" || then === "new") {
        const fresh = loadSessions().find((x) => x.key === s.key) || s;
        const l = fresh.reg.launch || {};
        const out = await launchAction(fresh, { isNew: then === "new", body: { provider: l.provider || fresh.agent.provider || "claude", model: l.model || "", effort: l.effort || "", prompt: l.prompt || "", cwd: projectCwd(fresh) }, wanted: "" }, serverUp);
        return out.redirect ? redirect(res, out.redirect) : send(res, out.status, "text/html; charset=utf-8", out.html);
      }
      return redirect(res, `/session/${s.key}?restored=${n}#versions`);
    }
    if (req.method === "POST" && (m = /^\/status\/([0-9a-f]{16})$/.exec(path))) {
      const s = sessions.find((x) => x.key === m[1]); if (!s) return send(res, 404, "text/plain", "no such session");
      const body = parseBody(await readBody(req), req.headers["content-type"]);
      const pr = Number(body.pr);
      try { updateRegistry(s.key, { file: s.resolved || undefined, status: body.status ?? undefined, priority: body.priority ?? undefined, summary: body.summary !== undefined && body.summary !== (s.reg.summary || "") ? body.summary : undefined, addPrs: Number.isInteger(pr) && pr > 0 ? [pr] : [], progress: body.progress ?? undefined, pct: body.pct !== undefined && body.pct !== "" ? body.pct : undefined, session: { label: "home page", host: os.hostname().replace(/\.local$/, "") } }); } catch (e) { return send(res, 400, "text/plain", e.message); }
      if (Number.isInteger(pr) && pr > 0) refreshPrs(loadSessions().find((x) => x.key === s.key), { force: true });
      return redirect(res, safeBack(url.searchParams.get("back"), `/session/${s.key}${body.progress ? "#progress" : ""}`));
    }
    if (req.method === "POST" && (m = /^\/refresh-prs\/([0-9a-f]{16})$/.exec(path))) {
      const s = sessions.find((x) => x.key === m[1]); if (!s) return send(res, 404, "text/plain", "no such session");
      const r = refreshPrs(s, { force: true });
      return redirect(res, `/session/${s.key}?prs=${encodeURIComponent(r.reason ? r.reason : `${r.checked} checked ${fmt(new Date())}`)}`);
    }
    if (req.method === "POST" && (m = /^\/(open|end)\/([0-9a-f]{16})$/.exec(path))) {
      const s = sessions.find((x) => x.key === m[2]); if (!s || !s.exists) return send(res, 404, "text/plain", "no such session or file missing");
      const file = s.resolved;
      const cmdArgs = m[1] === "end" ? ["end", file] : [file, "--no-open", ...(s.endedBy === "user" ? ["--reopen"] : [])];
      const r = spawnSync("lavish-axi", cmdArgs, { encoding: "utf8", env: localBinEnv(), timeout: 60000 });
      if (r.status !== 0) return send(res, 500, "text/plain; charset=utf-8", `lavish-axi ${cmdArgs.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
      if (m[1] === "end") { if (url.searchParams.get("close") === "1") markTabs(s.key, "session ended"); return redirect(res, safeBack(url.searchParams.get("back"), "/")); }
      const fresh = loadSessions().find((x) => x.resolved === file || x.file === file);
      return redirect(res, fresh?.url || "/");
    }
    send(res, 404, "text/plain", "not found");
  } catch (e) { res.writeHead(500, { "content-type": "text/plain" }); res.end(String(e?.stack || e)); }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`lavish-home on http://127.0.0.1:${PORT}  (state: ${stateDir})`);
  setTimeout(scanVersions, 1500);
  setInterval(() => { scanVersions(); sweepExports(); }, SCAN_MS);
  setTimeout(refreshAllPrs, 20_000);
  setInterval(refreshAllPrs, PR_REFRESH_MS);
  setTimeout(() => { refreshLive(true).then(() => scanAgents()); }, 5_000);
  setInterval(scanAgents, AGENT_SCAN_MS);
});
