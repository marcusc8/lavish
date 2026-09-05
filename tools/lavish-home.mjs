#!/usr/bin/env node
/* lavish-home.mjs — a home page for every Lavish page (a local Drive of plans), plus the small APIs the Comments rail needs.
 *
 * Reads ~/.lavish-axi/state.json (the Lavish server's single store), the history files written by
 * lavish-poll, the private notes written by the Comments rail, the version snapshots, the plan
 * registry (lavish-meta; since 2026-09-04 also the AGENT link: which Claude / Codex session polled the plan)
 * and the reviewer's folders (home-layout.json), and serves:
 *
 *   /                         every plan: sidebar (All plans · per-project · your folders), live-sessions strip, folder tiles, table
 *   /?folder=<fid>|project=<p> one folder or one project's unfiled plans
 *   /session/<key>            transcript grouped per agent session, Agent block (Resume · New session · Change effort · Find sessions),
 *                             plan-status form, versions (view / diff / restore), commits, private comments, export
 *   /session/<key>.md         the transcript as Markdown (download)
 *   /view/<key>/              the plan itself, read-only, no Lavish chrome, no state change; /view/<key>/<sibling asset> (siblings only)
 *   /version/<key>/<n>/       a saved version of the artifact, read-only, with its relative assets
 *   /diff/<key>/<a>/<b>       what changed between two versions (b may be "current")
 *   GET  /connect/<key>[?new=1]  the Resume / New session form (provider, model, effort, prompt; remembered per plan)
 *   POST /connect/<key>       Resume the plan's agent: live in tmux → bring Terminal forward · live in an editor → Lavish only ·
 *                             ended → tmux mm-<provider>-<8> running the CLI's own resume, Terminal.app attached, then Lavish.
 *                             Every refusal is a page naming the reason; a live session is never resumed twice.
 *   POST /connect/<key>?new=1 a NEW session in tmux with a prompt that opens and polls the plan (Claude or Codex)
 *   POST /effort/<key>        type /effort <level> into the plan's Claude terminal (only when idle), show the pane's reply
 *   POST /scan/<key>          Find sessions: the bounded transcript scan (D11) for this plan
 *   POST /restore/<key>/<n>   put version n back onto disk (the replaced file is snapshotted first)
 *   POST /open|end/<key>      resume / end the Lavish session
 *   POST /status/<key>        plan status · add PR · summary · progress (forms)
 *   POST /folders, /folders/<fid>, /move/<key>   folder forms (create · rename/move/delete · file a plan)
 *   /api/layout               GET the folders · PUT {op: create|rename|move|delete|file, …} (drag and drop)
 *   /api/notes/<key>          GET/PUT the reviewer's private comments (CORS for the Lavish chrome on :4387)
 *   /api/notes/<key>/files    PUT ?name= (raw image body) stores a private attachment; GET /:id serves it; DELETE /:id
 *   /api/registry/<key>       GET/POST plan status / PRs / summary · POST …/refresh-prs
 *   /api/versions/<key>       GET the version index · POST …/snapshot saves the file now if it changed
 *   /api/queue/<key>          GET/PUT/DELETE the rail's mirror of unsent comments, image copies and the card draft
 *   /api/export/<key>/plan.md PUT the page's own Markdown of the plan (text/plain), used by the md export
 *   /export/<key>?format=html|pdf|md&include=chat,comments,notes[&plan=0][&inline=1]
 *   /api/sessions             GET the plan list as JSON, with folder and agent {provider,id,state,name,terminal} per plan
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
  readLayout, createFolder, renameFolder, moveFolder, deleteFolder, filePlan, folderTree, folderPath, folderDescendants, agentLabel,
} from "./lavish-lib.mjs";
import {
  liveClaudeSessions, liveCodexThreads, listTmux, listClients, agentState, resumeAgent, startNewAgent, sendText, capturePane, paneIdle,
  scanTranscriptsMany, scanTranscripts, readTerminals, LAUNCH_OPTIONS, defaultNewPrompt, tmuxName, CLAUDE_BIN, CODEX_BIN, TMUX_BIN,
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
  light: { paper: "#faf9f6", surface: "#ffffff", tint: "#f1efe9", hover: "#f3f1ec", ink: "#1c1b1a", ink2: "#4a4845", ink3: "#66635d", rule: "#e6e3dd", acc: "#1f4e79", accInk: "#ffffff", accSoft: "#e4ecf4", good: "#2a6f46", goodInk: "#ffffff", goodSoft: "#e3f0e6", warn: "#7d6119", warnSoft: "#f6efdc", bad: "#9b3b2e", badSoft: "#f5e4e0", viol: "#4b3a8a", violSoft: "#e8e3f5", bar: "#1c1b1a", barInk: "#f3f1ec", barMute: "#b8b3aa", focus: "#1f4e79" },
  dark: { paper: "#15161a", surface: "#1e2026", tint: "#24262d", hover: "#282a32", ink: "#e8e6e1", ink2: "#c2beb6", ink3: "#9c988f", rule: "#2e3037", acc: "#6ea8ff", accInk: "#0b1220", accSoft: "#1f2b40", good: "#7fd69a", goodInk: "#0b1a10", goodSoft: "#1c2f24", warn: "#e2c06a", warnSoft: "#332b18", bad: "#f08a7a", badSoft: "#3a2220", viol: "#b9a8f5", violSoft: "#2a2440", bar: "#0f1013", barInk: "#e8e6e1", barMute: "#9c988f", focus: "#6ea8ff" },
};
const PAIRS = [["ink", "paper"], ["ink", "surface"], ["ink", "tint"], ["ink", "hover"], ["ink2", "paper"], ["ink2", "surface"], ["ink2", "tint"], ["ink2", "hover"], ["ink3", "paper"], ["ink3", "surface"], ["ink3", "tint"], ["ink3", "hover"],
  ["acc", "paper"], ["acc", "surface"], ["acc", "accSoft"], ["acc", "tint"], ["accInk", "acc"], ["good", "goodSoft"], ["good", "paper"], ["good", "surface"], ["goodInk", "good"], ["warn", "warnSoft"], ["warn", "paper"], ["warn", "surface"],
  ["bad", "badSoft"], ["bad", "paper"], ["bad", "surface"], ["viol", "violSoft"], ["viol", "paper"], ["barInk", "bar"], ["barMute", "bar"]];
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
const MONO_CSS = `.mg{background:hsl(var(--h) ${MONO.light.s}% ${MONO.light.lBg}%);color:hsl(var(--h) ${MONO.light.s}% ${MONO.light.lFg}%)}:root[data-theme=dark] .mg{background:hsl(var(--h) ${MONO.dark.s}% ${MONO.dark.lBg}%);color:hsl(var(--h) ${MONO.dark.s}% ${MONO.dark.lFg}%)}@media(prefers-color-scheme:dark){:root:not([data-theme=light]) .mg{background:hsl(var(--h) ${MONO.dark.s}% ${MONO.dark.lBg}%);color:hsl(var(--h) ${MONO.dark.s}% ${MONO.dark.lFg}%)}}`;
if (process.argv.includes("--check-contrast")) { const f = checkContrast(); console.log(f.length ? f.join("\n") : `contrast ok: ${PAIRS.length} pairs × ${Object.keys(PALETTES).length} palettes + monograms ≥ 4.5:1`); process.exit(f.length ? 1 : 0); }

/* ── live sessions cache (pid files, Codex locks, tmux names) ────────── */
let liveCache = { claude: [], codex: new Set(), tmux: new Set(), at: 0 };
async function refreshLive(force = false) {
  if (!force && Date.now() - liveCache.at < LIVE_TTL_MS) return liveCache;
  const tmux = await listTmux();
  liveCache = { claude: liveClaudeSessions(), codex: liveCodexThreads(), tmux, at: Date.now() };
  return liveCache;
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
    const fid = layout.plans[key] || "";
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
      folder: fid, folderPath: fid ? folderPath(layout, fid) : [],
      agent: agentState(reg, liveCache, liveCache.tmux),
      agents: Array.isArray(reg.agents) ? reg.agents : [],
    };
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
  return {
    status, inferred, note, priority, unworked, prs: list, summary: s.reg.summary || s.head.summary || "", webBase: s.resolved ? gitInfo(s.resolved).webBase : "",
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
const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const initials = (name) => { const w = String(name || "?").replace(/[-_.]/g, " ").trim().split(/\s+/).filter(Boolean); return (w.length > 1 ? w[0][0] + w[1][0] : String(w[0] || "?").slice(0, 2)).toUpperCase(); };
/** A generated monogram disc; a project may override it with <meta name="lavish:logo" content="assets/logo.svg"> (served as a sibling of the plan). */
const monogram = (name, { logo = "", key = "", size = 28 } = {}) => logo && key ? `<img class="mg mg-img" src="/view/${key}/${esc(logo)}" alt="${esc(name)}" width="${size}" height="${size}" style="--h:${hue(name)}">` : `<span class="mg" style="--h:${hue(name)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px" title="${esc(name)}">${esc(initials(name))}</span>`;
const glyph = (provider) => (provider === "codex" ? '<span class="pv" title="Codex">⌘</span>' : '<span class="pv" title="Claude">◆</span>');
const CSS = `
${THEME_CSS}
*{box-sizing:border-box;min-width:0}html{color-scheme:light dark}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 "Public Sans",system-ui,sans-serif}
a{color:var(--acc)}button{font:inherit}
.top{display:flex;align-items:center;gap:14px;padding:8px 18px;background:var(--bar);color:var(--barInk);position:sticky;top:0;z-index:5}.top a{color:inherit;text-decoration:none}.logo{display:flex;align-items:center;gap:9px;font-family:Newsreader,Georgia,serif;font-style:italic;font-size:19px}.logo .mg{font-style:normal;font-family:"Public Sans",system-ui,sans-serif;font-weight:700}.crumb{font-size:12px;color:var(--barMute)}.sp{flex:1}
.pill{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--tint);color:var(--ink2)}.top .pill{background:rgba(255,255,255,.12);color:var(--barInk)}.top .pill.on{background:var(--good);color:var(--goodInk)}.top .pill.off{background:var(--bad);color:#fff}
.search{flex:0 1 320px;display:flex;align-items:center;gap:6px;background:rgba(255,255,255,.1);border-radius:8px;padding:4px 10px}.search input{flex:1;background:transparent;border:0;color:var(--barInk);font:inherit;font-size:13px;outline:0}.search input::placeholder{color:var(--barMute)}
.tbtn{background:transparent;border:1px solid rgba(255,255,255,.18);color:var(--barInk);border-radius:8px;padding:3px 9px;cursor:pointer;font-size:13px}.tbtn:hover{background:rgba(255,255,255,.1)}
.shell{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:calc(100vh - 44px)}@media(max-width:900px){.shell{grid-template-columns:minmax(0,1fr)}.side{display:none}}
.side{border-right:1px solid var(--rule);padding:14px 10px 40px;background:var(--surface);position:sticky;top:44px;align-self:start;max-height:calc(100vh - 44px);overflow:auto}
.side h4{margin:14px 10px 4px;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink3);font-weight:700}
.nav{display:flex;align-items:center;gap:8px;padding:5px 10px;border-radius:8px;color:var(--ink2);text-decoration:none;font-size:13px;cursor:pointer;border:1px dashed transparent}.nav:hover{background:var(--hover)}.nav.on{background:var(--accSoft);color:var(--acc);font-weight:600}.nav .n{margin-left:auto;font-size:11px;color:var(--ink3);font-variant-numeric:tabular-nums}.nav.on .n{color:var(--acc)}.nav .ic{width:16px;text-align:center;color:var(--ink3)}.nav.on .ic{color:var(--acc)}
.nav.over{border-color:var(--acc);background:var(--accSoft)}.nav.nodrop{opacity:.35}.nav.sub{padding-left:26px}.nav.sub2{padding-left:42px}.nav.sub3{padding-left:58px}
.newf{display:flex;gap:6px;margin:8px 10px 0}.newf input{flex:1;font:inherit;font-size:12.5px;padding:4px 7px;border:1px solid var(--rule);border-radius:7px;background:var(--paper);color:var(--ink)}.newf button{font-size:12px;padding:4px 9px;border:1px solid var(--acc);border-radius:7px;background:var(--acc);color:var(--accInk);cursor:pointer}
main{padding:18px 22px 80px;max-width:1400px}.crumbs{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--ink3);margin:0 0 6px}.crumbs a{color:var(--ink2);text-decoration:none}.crumbs a:hover{text-decoration:underline}.crumbs b{color:var(--ink)}
h1{font-family:Newsreader,Georgia,serif;font-weight:600;font-size:24px;margin:0 0 4px}h2{font-family:Newsreader,Georgia,serif;font-weight:600;font-size:19px;margin:28px 0 8px}.meta{color:var(--ink3);font-size:12.5px}.empty{color:var(--ink3);padding:24px 0}
.strip{display:flex;gap:14px;overflow-x:auto;padding:8px 2px 10px;margin:6px 0 4px}.strip a{display:flex;flex-direction:column;align-items:center;gap:5px;text-decoration:none;color:var(--ink2);font-size:11px;width:76px;flex:0 0 auto}.strip a:hover{color:var(--ink)}.strip .av{position:relative}.strip .mg{width:44px;height:44px;font-size:15px;box-shadow:0 0 0 2px var(--surface),0 0 0 4px var(--good)}.strip .dot{position:absolute;right:-1px;bottom:-1px}.strip span.t{max-width:76px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center}.strip small{color:var(--ink3);max-width:76px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tiles{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0 18px}.tile{display:flex;align-items:center;gap:9px;padding:9px 12px;border:1px solid var(--rule);border-radius:10px;background:var(--surface);color:var(--ink);text-decoration:none;min-width:170px;transition:transform .12s,box-shadow .12s;cursor:pointer}.tile:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.08)}.tile.over{border-color:var(--acc);background:var(--accSoft)}.tile.nodrop{opacity:.35}.tile .fi{color:var(--acc);font-size:18px}.tile .n{margin-left:auto;font-size:11px;color:var(--ink3);font-variant-numeric:tabular-nums}.tile .acts{display:none;gap:4px;margin-left:6px}.tile:hover .acts{display:flex}.tile .acts button{background:none;border:0;color:var(--ink3);cursor:pointer;padding:0 3px;font-size:12px}.tile .acts button:hover{color:var(--acc)}
.filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:12px;margin:6px 0 10px}.filters>span{color:var(--ink3);margin-right:2px}.chip{padding:2px 9px;border:1px solid var(--rule);border-radius:999px;background:var(--surface);color:var(--ink2);text-decoration:none}.chip:hover{border-color:var(--ink3)}.chip.on{background:var(--acc);color:var(--accInk);border-color:var(--acc)}
.grp{margin:18px 0 4px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--acc);font-weight:700;display:flex;align-items:center;gap:8px}.grp span{color:var(--ink3);font-weight:500;letter-spacing:0;text-transform:none}
.tw{overflow-x:auto}table{width:100%;border-collapse:separate;border-spacing:0;background:var(--surface);border:1px solid var(--rule);border-radius:10px;table-layout:fixed}th{position:relative;text-align:left;font-size:11px;color:var(--ink3);font-weight:600;padding:8px 12px;border-bottom:1px solid var(--rule);text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;overflow:hidden}th .rz{position:absolute;top:0;right:-3px;width:7px;height:100%;cursor:col-resize;user-select:none}th .rz:hover,th .rz.on{background:var(--acc);opacity:.5}td{padding:9px 12px;border-bottom:1px solid var(--rule);vertical-align:top;font-size:13px;overflow:hidden}tr:last-child td{border-bottom:none}tbody tr{transition:background .12s,box-shadow .12s}tbody tr:hover{background:var(--hover)}tbody tr.drag{opacity:.5}tbody tr[draggable]{cursor:grab}tr.retired td{opacity:.6}tr.hit td{box-shadow:inset 3px 0 var(--acc)}
td.name{font-weight:600}td.name .t{display:flex;align-items:center;gap:9px}td.name .t a{color:var(--ink);text-decoration:none}td.name .t a:hover{text-decoration:underline}td.name small{display:block;font-weight:400;color:var(--ink3);font-family:ui-monospace,Menlo,monospace;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}
.hc{position:relative}.hc .card{display:none;position:absolute;left:0;top:calc(100% + 6px);z-index:4;width:380px;max-width:70vw;background:var(--surface);border:1px solid var(--rule);border-radius:10px;padding:10px 12px;box-shadow:0 8px 28px rgba(0,0,0,.14);font-weight:400;font-size:12.5px;color:var(--ink2);white-space:normal;line-height:1.45}.hc:hover .card,.hc:focus-within .card{display:block}.card p{margin:0 0 6px}.card .k{color:var(--ink3);font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-right:4px}
.mg{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;font-weight:700;letter-spacing:.02em;flex:0 0 auto;object-fit:cover}.mg-img{background:transparent}
${MONO_CSS}
.st{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;font-weight:600;white-space:nowrap}.st.open{background:var(--accSoft);color:var(--acc)}.st.ended{background:var(--tint);color:var(--ink3)}.st.feedback{background:var(--warnSoft);color:var(--warn)}.st.orphan{background:var(--badSoft);color:var(--bad)}.st.stale{background:var(--warnSoft);color:var(--warn)}
.plan{display:inline-block;font-size:11px;padding:1px 8px;border-radius:4px;font-weight:600;white-space:nowrap;border:1px solid transparent}.plan.not-started{background:var(--tint);color:var(--ink3)}.plan.in-review{background:var(--accSoft);color:var(--acc)}.plan.approved{background:var(--goodSoft);color:var(--good)}.plan.in-progress{background:var(--warnSoft);color:var(--warn)}.plan.merged{background:var(--good);color:var(--goodInk)}.plan.implemented{background:var(--good);color:var(--goodInk)}.plan.retired{background:var(--tint);color:var(--ink3)}.plan.superseded{background:var(--tint);color:var(--ink3);text-decoration:line-through}.plan.inferred{background:transparent;border-style:dashed;border-color:currentColor}
.prio{display:inline-block;font-size:10.5px;padding:0 6px;border-radius:999px;font-weight:600;white-space:nowrap;border:1px solid var(--rule);color:var(--ink3)}.prio.high{border-color:var(--bad);color:var(--bad)}.prio.low{opacity:.7}
select.inline{font:inherit;font-size:12px;padding:2px 4px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--ink2);cursor:pointer;max-width:150px}select.inline:hover{border-color:var(--rule);background:var(--surface)}
.pr{display:inline-block;font-size:11.5px;font-family:ui-monospace,Menlo,monospace;padding:0 6px;border-radius:4px;border:1px solid var(--rule);margin:0 4px 3px 0;text-decoration:none;color:var(--acc);white-space:nowrap;background:var(--surface)}.pr.MERGED{border-color:var(--good);color:var(--good)}.pr.OPEN{border-color:var(--warn);color:var(--warn)}.pr.CLOSED{border-color:var(--bad);color:var(--bad);text-decoration:line-through}.pr.inferred{border-style:dashed}
.num{font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--ink2)}
.a,button.a{color:var(--acc);text-decoration:underline;text-underline-offset:2px;cursor:pointer;margin-right:8px;white-space:nowrap;background:none;border:0;font:inherit;padding:0}form.inline{display:inline}
.ag{display:flex;align-items:center;gap:6px;white-space:nowrap;font-size:12.5px}.ag .pv{color:var(--ink3);font-size:11px}.ag.active{color:var(--good);font-weight:600}.ag.ended{color:var(--ink2)}.ag.none{color:var(--ink3)}.ag .name{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;font-weight:500}.ag.guessed .name{border-bottom:1px dotted currentColor}.ag.scan .name{border:1px dotted currentColor;border-radius:4px;padding:0 3px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--good);box-shadow:0 0 0 0 var(--good);animation:pulse 1.8s infinite}@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--good) 60%,transparent)}70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}
.lv{display:block;font-size:11px;color:var(--ink3);margin-top:3px}
.detail{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:20px}@media(max-width:900px){.detail{grid-template-columns:minmax(0,1fr)}}
.msg{margin:0 0 10px;padding:8px 11px;border-radius:8px;background:var(--tint);max-width:70ch;white-space:pre-wrap}.msg.agent{background:var(--accSoft)}.msg.ann{background:var(--warnSoft)}.msg.sys{background:var(--tint);color:var(--ink2)}.msg small{display:block;font-size:10.5px;color:var(--ink3);margin-bottom:2px;white-space:normal}
.tg{border:1px solid var(--rule);border-radius:10px;background:var(--surface);margin:0 0 12px}.tg summary{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;list-style:none;font-size:13px}.tg summary::-webkit-details-marker{display:none}.tg summary .who{font-weight:600;font-family:ui-monospace,Menlo,monospace;font-size:12px}.tg summary .when{color:var(--ink3);font-size:12px;margin-left:auto;white-space:nowrap}.tg .body{padding:6px 12px 10px;border-top:1px solid var(--rule)}
.side2{background:var(--surface);border:1px solid var(--rule);border-radius:10px;padding:14px;font-size:13px;position:sticky;top:56px}.side2 p{margin:0 0 10px}.mono{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;word-break:break-all}
.side2 select,.side2 input[type=text],.side2 input[type=number],.xform input,.xform select,.xform textarea{font:inherit;font-size:12.5px;padding:3px 6px;border:1px solid var(--rule);border-radius:6px;background:var(--paper);color:var(--ink)}button.b{font:inherit;font-size:12px;padding:3px 9px;border:1px solid var(--acc);border-radius:6px;background:var(--acc);color:var(--accInk);cursor:pointer}button.b.q{background:var(--surface);color:var(--acc)}button.b:disabled{opacity:.5;cursor:default}
.notice{background:var(--goodSoft);border:1px solid var(--good);color:var(--good);padding:8px 12px;border-radius:8px;margin:12px 0;font-size:13px}.notice.warn{background:var(--warnSoft);border-color:var(--warn);color:var(--warn)}.notice.bad{background:var(--badSoft);border-color:var(--bad);color:var(--bad)}
.note{border-left:3px solid var(--rule);background:var(--surface);border-radius:0 8px 8px 0;padding:8px 11px;margin:0 0 8px;font-size:13px}.note .anc{color:var(--ink3);font-size:12px;font-style:italic}.note.sent{border-left-color:var(--good)}.note.resolved{opacity:.6}
.diff{font:12.5px/1.5 ui-monospace,Menlo,monospace;background:var(--surface);border:1px solid var(--rule);border-radius:8px;overflow:hidden}.diff div{padding:1px 12px;white-space:pre-wrap;word-break:break-word}.diff .add{background:var(--goodSoft);color:var(--good)}.diff .del{background:var(--badSoft);color:var(--bad);text-decoration:line-through}.diff details{border-top:1px solid var(--rule);border-bottom:1px solid var(--rule)}.diff summary{padding:3px 12px;color:var(--ink3);cursor:pointer;background:var(--paper);font-size:12px}
.legend{font-size:12px;color:var(--ink2);margin:6px 0 12px}.legend b{font-weight:600}
.stg{display:inline-block;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;padding:1px 7px;border-radius:999px;margin-bottom:4px}.stg.planning{background:var(--accSoft);color:var(--acc)}.stg.developing{background:var(--warnSoft);color:var(--warn)}.stg.review{background:var(--violSoft);color:var(--viol)}.stg.done{background:var(--goodSoft);color:var(--good)}.stg.parked{background:var(--tint);color:var(--ink3)}.stg.inferred{background:transparent;border:1px dashed currentColor}
.prog{display:block;color:var(--ink3);font-size:12px;margin-top:4px}.prog b{color:var(--ink2);font-weight:500}
.stage-steps{display:flex;gap:6px;margin:8px 0 10px;max-width:640px}.stage-steps span{flex:1;text-align:center;padding:7px 4px;border-radius:6px;background:var(--tint);color:var(--ink3);font-size:12.5px}.stage-steps span.past{background:var(--accSoft);color:var(--acc)}.stage-steps span.now{background:var(--acc);color:var(--accInk);font-weight:600}.stage-steps span.now.inferred{outline:2px dashed var(--acc);outline-offset:-2px;background:var(--surface);color:var(--acc)}
.tl td.num{color:var(--ink3)}.tl .sess{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--ink2)}
.xform{background:var(--surface);border:1px solid var(--rule);border-radius:10px;padding:12px 14px;font-size:13px;display:grid;gap:8px;max-width:680px}.xform label{margin-right:12px}.xform .row{display:flex;gap:14px;flex-wrap:wrap;align-items:center}.xform textarea{width:100%;min-height:74px;resize:vertical}
.thumbs{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}.thumbs img{width:64px;height:64px;object-fit:cover;border-radius:6px;border:1px solid var(--rule);display:block}
.vcomments summary{cursor:pointer;color:var(--acc);font-size:12.5px;white-space:nowrap}.vcomments .note{margin:6px 0 0;max-width:520px;font-size:12.5px}.vcomments .note .anc{font-size:11.5px}
.note .reply{margin-top:5px;padding:4px 8px;background:var(--tint);border-radius:6px;color:var(--ink2);font-size:12.5px}
pre.pane{background:var(--bar);color:var(--barInk);padding:10px 12px;border-radius:8px;font:12px/1.4 ui-monospace,Menlo,monospace;overflow-x:auto;max-width:900px;white-space:pre-wrap}
.kv{display:grid;grid-template-columns:110px minmax(0,1fr);gap:4px 10px;font-size:13px;margin:8px 0}.kv .k{color:var(--ink3)}
.errpage{max-width:640px;margin:60px auto;padding:0 20px}.errpage h1{font-size:22px}.errpage p{font-size:15px}
`;
const CLIENT_JS = `
(function(){
  var KEY="lavish-home:theme",W="lavish-home:cols";
  function apply(t){if(t)document.documentElement.setAttribute("data-theme",t);else document.documentElement.removeAttribute("data-theme");}
  try{apply(localStorage.getItem(KEY)||"");}catch(e){}
  var tb=document.getElementById("themeToggle");
  if(tb)tb.addEventListener("click",function(){var cur=document.documentElement.getAttribute("data-theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");var next=cur==="dark"?"light":"dark";apply(next);try{localStorage.setItem(KEY,next);}catch(e){}});
  /* search: filter rows by title / path / folder */
  var q=document.getElementById("q");
  if(q)q.addEventListener("input",function(){var s=q.value.trim().toLowerCase();document.querySelectorAll("tbody tr[data-key]").forEach(function(tr){tr.style.display=!s||tr.textContent.toLowerCase().indexOf(s)!==-1?"":"none";});document.querySelectorAll("table").forEach(function(t){var any=[].some.call(t.querySelectorAll("tbody tr[data-key]"),function(r){return r.style.display!=="none"});var g=t.previousElementSibling;if(g&&g.classList.contains("grp"))g.style.display=any?"":"none";t.style.display=any?"":"none";});});
  /* column resize: widths per column name in localStorage */
  var saved={};try{saved=JSON.parse(localStorage.getItem(W)||"{}")||{};}catch(e){}
  document.querySelectorAll("table[data-cols]").forEach(function(t){var cols=t.querySelectorAll("col[data-col]");cols.forEach(function(c){if(saved[c.dataset.col])c.style.width=saved[c.dataset.col]+"px";});
    t.querySelectorAll("th .rz").forEach(function(h){h.addEventListener("mousedown",function(e){e.preventDefault();var th=h.parentNode,name=th.dataset.col,col=t.querySelector('col[data-col="'+name+'"]'),x0=e.clientX,w0=th.getBoundingClientRect().width;h.classList.add("on");
      function mv(ev){var w=Math.max(70,w0+ev.clientX-x0);if(col)col.style.width=w+"px";saved[name]=Math.round(w);}
      function up(){document.removeEventListener("mousemove",mv);document.removeEventListener("mouseup",up);h.classList.remove("on");try{localStorage.setItem(W,JSON.stringify(saved));}catch(e){}}
      document.addEventListener("mousemove",mv);document.addEventListener("mouseup",up);});});});
  /* drag and drop: a plan row onto a folder, a folder onto a folder; PUT /api/layout; cycles greyed while dragging */
  var L=window.__LAYOUT||{folders:{}};
  function desc(fid){var out={};out[fid]=1;var grew=true;while(grew){grew=false;Object.keys(L.folders).forEach(function(id){if(!out[id]&&out[L.folders[id].parent]){out[id]=1;grew=true;}});}return out;}
  var dragging=null;
  document.querySelectorAll("[data-drag]").forEach(function(el){el.addEventListener("dragstart",function(e){dragging=el.dataset.drag;e.dataTransfer.setData("text/plain",dragging);e.dataTransfer.effectAllowed="move";el.classList.add("drag");
      if(dragging.indexOf("folder:")===0){var d=desc(dragging.slice(7));document.querySelectorAll("[data-drop]").forEach(function(t){var v=t.dataset.drop;if(v.indexOf("folder:")===0&&d[v.slice(7)])t.classList.add("nodrop");});}});
    el.addEventListener("dragend",function(){el.classList.remove("drag");dragging=null;document.querySelectorAll(".nodrop,.over").forEach(function(t){t.classList.remove("nodrop");t.classList.remove("over");});});});
  document.querySelectorAll("[data-drop]").forEach(function(t){t.addEventListener("dragover",function(e){if(!dragging||t.classList.contains("nodrop"))return;e.preventDefault();e.dataTransfer.dropEffect="move";t.classList.add("over");});
    t.addEventListener("dragleave",function(){t.classList.remove("over");});
    t.addEventListener("drop",function(e){e.preventDefault();t.classList.remove("over");var src=e.dataTransfer.getData("text/plain")||dragging;if(!src||t.classList.contains("nodrop"))return;var target=t.dataset.drop;var fid=target.indexOf("folder:")===0?target.slice(7):"";
      var body=src.indexOf("plan:")===0?{op:"file",key:src.slice(5),fid:fid}:{op:"move",fid:src.slice(7),parent:fid};
      if(body.op==="move"&&body.fid===fid)return;
      fetch("/api/layout",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(function(j){if(j.error){alert(j.error);return;}L=j.layout||L;
        /* update counts and the moved row's folder cell without a reload */
        Object.keys(j.counts||{}).forEach(function(id){document.querySelectorAll('[data-count="'+id+'"]').forEach(function(n){n.textContent=j.counts[id];});});
        if(body.op==="file"){var tr=document.querySelector('tr[data-key="'+body.key+'"]');if(tr){var cell=tr.querySelector("td.folder");if(cell)cell.innerHTML=j.folderHtml||"";var view=document.body.dataset.view||"";if(view&&view!==("folder:"+fid)&&view!=="all")tr.style.display="none";}}
        else location.reload();
      }).catch(function(){alert("Could not move: the home page did not answer.");});});});
})();`;
const page = (title, crumb, body, serverUp, { pills = "", sidebar = "", layout = null, view = "" } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,600&family=Public+Sans:wght@400;600;700&display=swap" rel="stylesheet"><style>${CSS}</style><script>try{var t=localStorage.getItem("lavish-home:theme");if(t)document.documentElement.setAttribute("data-theme",t);}catch(e){}</script></head><body${view ? ` data-view="${esc(view)}"` : ""}>
<div class="top"><a class="logo" href="/">${monogram("Lavish", { size: 24 })}Lavish</a><span class="crumb">${esc(crumb)}</span><span class="sp"></span>${sidebar ? '<div class="search"><span aria-hidden="true">⌕</span><input id="q" type="search" placeholder="Search plans" autocomplete="off"></div>' : ""}${pills}<button class="tbtn" id="themeToggle" type="button" title="Light / dark (follows the system until you pick; saved in this browser)" aria-label="Toggle theme">◐</button><span class="pill ${serverUp ? "on" : "off"}">lavish :${process.env.LAVISH_AXI_PORT || 4387} ${serverUp ? "up" : "down"}</span></div>
${sidebar ? `<div class="shell"><aside class="side">${sidebar}</aside><main>${body}</main></div>` : `<main style="max-width:1280px;margin:0 auto">${body}</main>`}
<script>window.__LAYOUT=${JSON.stringify(layout ? { folders: layout.folders } : { folders: {} }).replace(/<\//g, "<\\/")};${CLIENT_JS}</script></body></html>`;
const errorPage = (title, message, { back = "/", extra = "" } = {}, serverUp = true) => page(title, title, `<div class="errpage"><h1>${esc(title)}</h1><p>${esc(message)}</p>${extra}<p class="meta"><a class="a" href="${esc(back)}">← Back</a></p></div>`, serverUp);

function planChip(plan) {
  const label = plan.status.replace("-", " ");
  const title = plan.note ? plan.note : plan.inferred ? "Inferred from PR states and review activity. Set it with lavish-meta, in the row, or on the session page." : "Declared with lavish-meta or <meta name=lavish:status>";
  return `<span class="plan ${esc(plan.status)}${plan.inferred ? " inferred" : ""}" title="${esc(title)}">${esc(label)}${plan.inferred ? " ?" : ""}</span>${plan.priority === "high" ? ' <span class="prio high">high</span>' : ""}`;
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
/** The Session cell: agent state first, Lavish's review state as a second line. */
function agentCell(s) {
  const a = s.agent;
  let top;
  if (a.state === "none") top = `<span class="ag none">not connected</span>`;
  else {
    const dot = a.state === "active" ? '<span class="dot"></span>' : "";
    const where = a.state === "active" ? (a.terminal ? "terminal" : a.entrypointLabel || "") : ago(a.at);
    const title = `${a.provider} ${a.id}${a.cwd ? ` · ${a.cwd}` : ""}${a.source === "scan" ? " · linked by the transcript scan (dotted): a real poll replaces it" : ""}${a.guessed ? " · guessed: several live Codex threads in this folder" : ""}`;
    top = `<span class="ag ${a.state}${a.source === "scan" ? " scan" : ""}${a.guessed ? " guessed" : ""}" title="${esc(title)}">${dot}${glyph(a.provider)}<span class="name">${esc(a.name)}</span>${where ? ` · ${esc(where)}` : ""}${a.state === "ended" ? " · ended" : ""}</span>`;
  }
  const lv = !s.exists ? `<span class="st orphan">orphaned</span>` : s.status === "ended" ? `lavish ended · ${esc(s.endedBy || "?")}` : s.stale ? `lavish open · stale` : `lavish ${esc(s.status)}${s.pending ? ` · ${s.pending} pending` : ""}`;
  return `${top}<span class="lv">${lv}</span>`;
}
const folderCellHtml = (s) => (s.folderPath.length ? s.folderPath.map((f, i) => `<a class="a" style="margin:0" href="/?folder=${esc(f.id)}">${esc(f.name)}</a>${i < s.folderPath.length - 1 ? ' <span class="num">›</span> ' : ""}`).join("") : `<span class="num" title="Unfiled: grouped under its project">–</span>`);
/** counts per folder (its plans and its descendants' plans) */
function folderCounts(layout, sessions) {
  const counts = {};
  for (const s of sessions) { if (!s.folder) continue; let cur = s.folder; const seen = new Set(); while (cur && layout.folders[cur] && !seen.has(cur)) { seen.add(cur); counts[cur] = (counts[cur] || 0) + 1; cur = layout.folders[cur].parent; } }
  return counts;
}

const PRIO_RANK = { high: 0, normal: 1, low: 2 };
function renderIndex(sessions, q, serverUp, layout) {
  const folder = q.get("folder") || "", project = q.get("project") || "";
  const status = q.get("status") || "", plan = q.get("plan") || "", prio = q.get("prio") || "", stage = q.get("stage") || "", agent = q.get("agent") || "";
  const showRetired = q.get("retired") === "1" || plan === "retired" || plan === "superseded" || stage === "parked";
  const counts = folderCounts(layout, sessions);
  const inFolder = folder ? folderDescendants(layout, folder) : null;
  const shown = sessions.filter((s) => (!folder || (s.folder && inFolder.has(s.folder)))
    && (!project || (s.project === project && !s.folder))
    && (!status || (status === "orphan" ? !s.exists : status === "stale" ? s.stale : s.status === status))
    && (!agent || (agent === "terminal" ? s.agent.state === "active" && s.agent.terminal : agent === "active" ? s.agent.state === "active" && !s.agent.terminal : agent === "any-active" ? s.agent.state === "active" : s.agent.state === agent))
    && (!plan || (plan === "unworked" ? s.plan.unworked : s.plan.status === plan))
    && (!prio || s.plan.priority === prio)
    && (!stage || s.plan.stage === stage)
    && (showRetired || !["retired", "superseded"].includes(s.plan.status)))
    .sort((a, b) => (PRIO_RANK[a.plan.priority] - PRIO_RANK[b.plan.priority]) || (b.updated - a.updated));
  const current = { ...(folder ? { folder } : {}), ...(project ? { project } : {}), ...(status ? { status } : {}), ...(agent ? { agent } : {}), ...(plan ? { plan } : {}), ...(prio ? { prio } : {}), ...(stage ? { stage } : {}), ...(q.get("retired") === "1" ? { retired: "1" } : {}) };
  const keep = (k, v, drop = []) => { const c = { ...current, [k]: v }; for (const d of drop) delete c[d]; return new URLSearchParams(c).toString().replace(/[^=&]+=(&|$)/g, ""); };
  const chip = (label, params, on) => `<a class="chip ${on ? "on" : ""}" href="/?${params}">${esc(label)}</a>`;
  const filters = `<div class="filters"><span>Agent:</span>${chip("All", keep("agent", ""), !agent)}${chip("not connected", keep("agent", "none"), agent === "none")}${chip("active", keep("agent", "active"), agent === "active")}${chip("in terminal", keep("agent", "terminal"), agent === "terminal")}${chip("ended", keep("agent", "ended"), agent === "ended")}<span style="margin-left:14px">Lavish:</span>${chip("any", keep("status", ""), !status)}${["open", "ended", "stale", "orphan"].map((s) => chip(s, keep("status", s), status === s)).join("")}</div>
  <div class="filters"><span>Stage:</span>${chip("any", keep("stage", ""), !stage)}${[...STAGES, "parked"].map((x) => chip(STAGE_LABELS[x], keep("stage", x), stage === x)).join("")}<span style="margin-left:14px">Plan:</span>${chip("any", keep("plan", ""), !plan)}${chip("unworked", keep("plan", "unworked"), plan === "unworked")}${STATUSES.map((p) => chip(p.replace("-", " "), keep("plan", p), plan === p)).join("")}<span style="margin-left:14px">Priority:</span>${chip("any", keep("prio", ""), !prio)}${PRIORITIES.map((p) => chip(p, keep("prio", p), prio === p)).join("")}${chip(showRetired ? "hide retired" : "show retired", keep("retired", showRetired ? "" : "1"), false)}</div>`;
  const back = encodeURIComponent("/?" + new URLSearchParams(current).toString());
  // sidebar
  const projects = [...new Set(sessions.map((s) => s.project))].sort();
  const unfiled = (p) => sessions.filter((s) => s.project === p && !s.folder && (showRetired || !["retired", "superseded"].includes(s.plan.status))).length;
  const tree = folderTree(layout);
  const navFolder = (n, depth) => `<a class="nav ${depth ? `sub${Math.min(depth, 3)}` : ""} ${folder === n.id ? "on" : ""}" href="/?folder=${esc(n.id)}" data-drop="folder:${esc(n.id)}" data-drag="folder:${esc(n.id)}" draggable="true"><span class="ic">▰</span>${esc(n.name)}<span class="n" data-count="${esc(n.id)}">${counts[n.id] || 0}</span></a>${n.children.map((c) => navFolder(c, depth + 1)).join("")}`;
  const sidebar = `<a class="nav ${!folder && !project ? "on" : ""}" href="/" data-drop="root"><span class="ic">▣</span>All plans<span class="n">${sessions.length}</span></a>
  <a class="nav ${agent === "any-active" ? "on" : ""}" href="/?agent=any-active"><span class="ic"><span class="dot" style="animation:none"></span></span>Active now<span class="n">${sessions.filter((s) => s.agent.state === "active").length}</span></a>
  <h4>Projects <span style="font-weight:400;letter-spacing:0;text-transform:none">· unfiled plans</span></h4>${projects.map((p) => `<a class="nav ${project === p ? "on" : ""}" href="/?project=${encodeURIComponent(p)}" data-drop="root">${monogram(p, { size: 18 })}${esc(p)}<span class="n">${unfiled(p)}</span></a>`).join("")}
  <h4>Folders</h4>${tree.map((n) => navFolder(n, 0)).join("") || '<p class="meta" style="margin:2px 10px 6px">None yet. Drag a plan onto a folder once you have one.</p>'}
  <form class="newf" method="post" action="/folders"><input type="hidden" name="parent" value="${esc(folder)}"><input name="name" placeholder="${folder ? "New subfolder" : "New folder"}" required maxlength="80"><button type="submit">+</button></form>`;
  // header + strip + tiles
  const crumbs = folder ? `<div class="crumbs"><a href="/">All plans</a>${folderPath(layout, folder).map((f, i, arr) => ` › ${i === arr.length - 1 ? `<b>${esc(f.name)}</b>` : `<a href="/?folder=${esc(f.id)}">${esc(f.name)}</a>`}`).join("")}</div>` : project ? `<div class="crumbs"><a href="/">All plans</a> › <b>${esc(project)}</b> <span>· unfiled</span></div>` : `<div class="crumbs"><b>All plans</b></div>`;
  const active = sessions.filter((s) => s.agent.state === "active").sort((a, b) => String(b.agent.at).localeCompare(String(a.agent.at)));
  const strip = !folder && !project && active.length ? `<div class="strip" title="Sessions that are running right now. Click one to jump to its plan.">${active.map((s) => `<a href="#row-${s.key}" title="${esc(s.title)} · ${esc(s.agent.name)} · ${esc(s.agent.terminal ? "terminal" : s.agent.entrypointLabel)}"><span class="av">${monogram(s.project, { logo: s.logo, key: s.key, size: 44 })}<span class="dot"></span></span><span class="t">${esc(s.agent.name)}</span><small>${esc(s.title)}</small></a>`).join("")}</div>` : "";
  const children = folder ? (tree.length ? (function find(list) { for (const n of list) { if (n.id === folder) return n.children; const r = find(n.children); if (r) return r; } return null; })(tree) || [] : []) : (!project ? tree : []);
  const tileActs = (n) => `<span class="acts"><form class="inline" method="post" action="/folders/${esc(n.id)}" onsubmit="var v=prompt('Rename folder',this.name.value);if(v===null)return false;this.name.value=v;return true"><input type="hidden" name="op" value="rename"><input type="hidden" name="name" value="${esc(n.name)}"><button type="submit" title="Rename">✎</button></form><form class="inline" method="post" action="/folders/${esc(n.id)}" onsubmit="return confirm('Delete the folder ${esc(n.name)}? Its plans and subfolders move up one level; nothing is lost.')"><input type="hidden" name="op" value="delete"><button type="submit" title="Delete (plans and subfolders move up)">🗑</button></form></span>`;
  const tiles = children.length ? `<div class="tiles">${children.map((n) => `<a class="tile" href="/?folder=${esc(n.id)}" data-drop="folder:${esc(n.id)}" data-drag="folder:${esc(n.id)}" draggable="true"><span class="fi">▰</span>${esc(n.name)}${tileActs(n)}<span class="n" data-count="${esc(n.id)}">${counts[n.id] || 0}</span></a>`).join("")}</div>` : "";
  const folderRow = folder ? `<p class="meta" style="margin:0 0 8px">${counts[folder] || 0} plan${counts[folder] === 1 ? "" : "s"} · <form class="inline" method="post" action="/folders/${esc(folder)}" onsubmit="var v=prompt('Rename folder',this.name.value);if(v===null)return false;this.name.value=v;return true"><input type="hidden" name="op" value="rename"><input type="hidden" name="name" value="${esc(layout.folders[folder]?.name || "")}"><button class="a" type="submit">Rename</button></form><form class="inline" method="post" action="/folders/${esc(folder)}" onsubmit="return confirm('Delete this folder? Its plans and subfolders move up one level; nothing is lost.')"><input type="hidden" name="op" value="delete"><button class="a" type="submit">Delete folder</button></form> Move to <form class="inline" method="post" action="/folders/${esc(folder)}"><input type="hidden" name="op" value="move"><select class="inline" name="parent" onchange="this.form.submit()"><option value="">— root</option>${folderOptions(layout, layout.folders[folder]?.parent || "", folderDescendants(layout, folder))}</select></form></p>` : "";
  // table(s)
  const groups = new Map();
  for (const s of shown) { const g = folder ? (s.folder === folder ? "" : folderPath(layout, s.folder).slice(folderPath(layout, folder).length).map((f) => f.name).join(" › ")) : s.project; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(s); }
  const cols = `<colgroup><col data-col="plan" style="width:34%"><col data-col="folder" style="width:13%"><col data-col="status" style="width:15%"><col data-col="session" style="width:20%"><col data-col="actions" style="width:18%"></colgroup>`;
  const head = `<thead><tr><th data-col="plan">Plan<span class="rz"></span></th><th data-col="folder">Folder<span class="rz"></span></th><th data-col="status">Status<span class="rz"></span></th><th data-col="session">Session<span class="rz"></span></th><th data-col="actions">Actions</th></tr></thead>`;
  const pills = `<span class="pill">${sessions.length} plans · ${sessions.filter((s) => s.agent.state === "active").length} active · ${sessions.filter((s) => s.plan.unworked).length} unworked · ${sessions.filter((s) => s.plan.status === "in-progress").length} in progress</span>`;
  let body = `${crumbs}<h1>${folder ? esc(layout.folders[folder]?.name || "Folder") : project ? esc(project) : "Lavish plans"}</h1>${folderRow}<p class="meta">${folder || project ? "" : "Every plan on this machine. Drag a row onto a folder (sidebar or tile) to file it; Move-to does the same from the keyboard. Hover a title for its summary, PRs and review counts. Resume puts you back in front of the agent that wrote the plan; New session starts a fresh one that opens and polls it."}</p>${strip}${tiles}${filters}`;
  if (!shown.length) body += `<p class="empty">Nothing here.</p>`;
  for (const [g, list] of groups) {
    body += `${g ? `<div class="grp">${esc(g)}<span>${list.length} plan${list.length === 1 ? "" : "s"} · last activity ${fmtDay(list.slice().sort((a, b) => b.updated - a.updated)[0].updated)}</span></div>` : ""}<div class="tw"><table data-cols="1">${cols}${head}<tbody>`;
    for (const s of list) body += row(s, back, layout);
    body += `</tbody></table></div>`;
  }
  return page(folder ? `${layout.folders[folder]?.name || "Folder"} · Lavish` : "Lavish home", folder ? folderPath(layout, folder).map((f) => f.name).join(" › ") : project || "all plans", body, serverUp, { pills, sidebar, layout, view: folder ? `folder:${folder}` : project ? `project:${project}` : "all" });
}
function folderOptions(layout, selected = "", exclude = new Set()) {
  const out = [];
  const walk = (list, depth) => { for (const n of list) { if (!exclude.has(n.id)) out.push(`<option value="${esc(n.id)}"${n.id === selected ? " selected" : ""}>${"&nbsp;&nbsp;".repeat(depth)}${esc(n.name)}</option>`); walk(n.children, depth + 1); } };
  walk(folderTree(layout), 0);
  return out.join("");
}
function statusSelect(s, back) {
  const opts = STATUSES.map((x) => `<option value="${x}"${(s.reg.status ? normalizeStatus(s.reg.status) : "") === x ? " selected" : ""}>${x.replace("-", " ")}</option>`).join("");
  return `<form class="inline" method="post" action="/status/${s.key}?back=${back}">${planChip(s.plan)}<br><select class="inline" name="status" onchange="this.form.submit()" title="Set the plan status (the chip above shows what is in effect)"><option value="">— infer</option>${opts}</select></form>`;
}
function hoverCard(s) {
  const latest = s.plan.progress.latest;
  return `<div class="card"><p>${esc(s.plan.summary || "No summary (add <meta name=description> to the plan or set one on its page).")}</p>
  <p><span class="k">PRs</span>${prChips(s.plan)}</p>
  <p><span class="k">Review</span>${s.agentMsgs} ${s.agentMsgs === 1 ? "reply" : "replies"} · ${s.userSent} sent${s.privateNotes ? ` · ${s.privateNotes} private` : ""}${s.unsentCount ? ` · ${s.unsentCount} unsent` : ""} &nbsp; <span class="k">Versions</span>${s.versionCount || 0} &nbsp; <span class="k">Priority</span>${esc(s.plan.priority)}</p>
  ${latest ? `<p><span class="k">Latest</span>${esc(latest.text)} · ${esc(latest.session?.label || "")} · ${fmtDay(latest.at)}</p>` : ""}
  <p><span class="k">Updated</span>${fmt(s.updated)} &nbsp; <span class="k">Agent</span>${s.agent.state === "none" ? "not connected" : `${esc(s.agent.name)} · ${esc(s.agent.provider)} · ${esc(s.agent.state)}`}</p>
  <p class="mono" style="color:var(--ink3)">${esc(shortPath(s.resolved || s.file))}</p></div>`;
}
function row(s, back = "", layout) {
  const note = !s.exists ? " · file missing" : s.moved ? " · path moved, re-linked" : s.worktree ? ` · worktree ${esc(s.worktree)}` : "";
  const launch = s.reg.launch || {};
  const resume = s.agent.state === "none" ? "" : `<form class="inline" method="post" action="/connect/${s.key}" title="${esc(s.agent.state === "active" ? (s.agent.terminal ? "Bring its terminal forward and open the plan in Lavish" : `Live in ${s.agent.entrypointLabel}: opens the plan in Lavish only`) : `Resume ${s.agent.name} in a terminal (${launch.model || "default model"}, ${launch.effort || "default effort"}) and open the plan in Lavish`)}"><input type="hidden" name="model" value="${esc(launch.model || "")}"><input type="hidden" name="effort" value="${esc(launch.effort || "")}"><button class="a" type="submit">Resume</button></form>`;
  const acts = [
    s.exists ? `<a class="a" href="/view/${s.key}/" target="_blank" rel="noopener" title="Read the plan as it is on disk: no Lavish chrome, no session change">View</a>` : "",
    s.exists ? resume : "",
    s.exists ? `<a class="a" href="/connect/${s.key}?new=1" title="Start a fresh Claude or Codex session in a terminal with a prompt that opens and polls this plan">New session</a>` : "",
    `<a class="a" href="/session/${s.key}">Log</a>`,
  ].join("");
  const moveTo = `<form class="inline" method="post" action="/move/${s.key}?back=${back}"><select class="inline" name="fid" onchange="this.form.submit()" title="Move to a folder (keyboard path; drag the row onto a folder does the same)"><option value="">${s.folder ? "— unfile" : "Move to…"}</option>${folderOptions(layout, s.folder)}</select></form>`;
  const retire = s.plan.status !== "retired" ? `<form class="inline" method="post" action="/status/${s.key}?back=${back}"><input type="hidden" name="status" value="retired"><button class="a" type="submit" title="Park or abandon this plan (hidden from the default view)">Retire</button></form>` : "";
  return `<tr id="row-${s.key}" class="${s.plan.status === "retired" ? "retired" : ""}" data-key="${s.key}" data-drag="plan:${s.key}" draggable="true"><td class="name"><div class="hc"><div class="t">${monogram(s.project, { logo: s.logo, key: s.key })}<a href="/session/${s.key}">${esc(s.title)}</a></div>${hoverCard(s)}</div><small title="${esc(s.resolved || s.file)}">${esc(shortPath(s.resolved || s.file))}${note}</small></td><td class="folder">${folderCellHtml(s)}</td><td><span class="stg ${esc(s.plan.stage)}${s.plan.stageInferred ? " inferred" : ""}" title="${esc(s.plan.subLabel)}">${esc(s.plan.stageLabel)}</span><br>${statusSelect(s, back)}</td><td>${agentCell(s)}</td><td>${acts}<br>${moveTo}${retire}</td></tr>`;
}
function shortPath(p) { return p.replace(os.homedir(), "~").replace("/Library/CloudStorage/Dropbox-Personal/Development/", "/…/"); }

/* ── connect form + agent block (session page) ────────────────────────── */
const opts = (list, sel) => list.map((x) => `<option value="${esc(x)}"${x === (sel || "default") ? " selected" : ""}>${esc(x)}</option>`).join("");
function launchForms(s, { isNew = false, cwd = "" } = {}) {
  const l = s.reg.launch || {};
  const a = s.agent;
  const provider = l.provider || a.provider || "claude";
  const resumeForm = a.state === "none" ? `<p class="meta">No agent has polled this plan yet, so there is nothing to resume. Start a New session, or run <span class="mono">lavish-poll</span> from the session that is on it.</p>` :
    `<form class="xform" method="post" action="/connect/${s.key}"><div class="row"><b>Resume</b> ${glyph(a.provider)} <span class="mono">${esc(a.name)}</span> <span class="meta">${a.state === "active" ? `live${a.terminal ? " in terminal " + esc(a.tmuxName) : " in " + esc(a.entrypointLabel)}` : `ended · ${esc(ago(a.at))}`}</span></div>
    <div class="row"><label>Model <select name="model">${a.provider === "codex" ? `<option value="">default</option>` : opts(LAUNCH_OPTIONS.claude.models, l.model)}</select></label>${a.provider === "codex" ? `<label>or <input type="text" name="model_free" value="${esc(l.model && !LAUNCH_OPTIONS.codex.models.includes(l.model) ? l.model : "")}" placeholder="codex model (free text)" style="width:160px"></label>` : ""}<label>Effort <select name="effort">${opts(LAUNCH_OPTIONS[a.provider === "codex" ? "codex" : "claude"].efforts, l.effort)}</select></label><button class="b" type="submit">${a.state === "active" ? (a.terminal ? "Bring the terminal forward" : "Open in Lavish") : "Resume in a terminal"}</button></div>
    <p class="meta" style="margin:0">${a.state === "active" ? (a.terminal ? "Already running in tmux: nothing new is started. Model and effort apply at the next resume." : `The session is live in ${esc(a.entrypointLabel)}: nothing is started (a second writer would corrupt its transcript); the plan opens in Lavish.`) : `Starts <span class="mono">tmux new-session -s ${esc(a.tmuxName)}</span> in <span class="mono">${esc(shortPath(a.cwd || ""))}</span> running <span class="mono">${a.provider === "codex" ? "codex resume" : "claude --resume"} ${esc(String(a.id).slice(0, 8))}…</span>, opens Terminal.app on it, then opens the plan in Lavish. Remembered per plan.`}</p></form>`;
  const newForm = `<form class="xform" method="post" action="/connect/${s.key}?new=1" style="margin-top:12px"><div class="row"><b>New session</b> <span class="meta">a fresh terminal with a prompt that opens and polls this plan, so it is connected before you type a word</span></div>
    <div class="row"><label>Provider <select name="provider" onchange="this.form.querySelector('[name=model]').innerHTML=this.value==='codex'?'<option value=\\'\\'>default</option>':'${LAUNCH_OPTIONS.claude.models.map((m) => `<option value=${m}>${m}</option>`).join("")}';this.form.querySelector('[name=effort]').innerHTML=(this.value==='codex'?${JSON.stringify(LAUNCH_OPTIONS.codex.efforts)}:${JSON.stringify(LAUNCH_OPTIONS.claude.efforts)}).map(function(e){return '<option value='+e+'>'+e+'</option>'}).join('')"><option value="claude"${provider !== "codex" ? " selected" : ""}>Claude</option><option value="codex"${provider === "codex" ? " selected" : ""}>Codex</option></select></label>
    <label>Model <select name="model">${provider === "codex" ? `<option value="">default</option>` : opts(LAUNCH_OPTIONS.claude.models, l.model)}</select></label><label>or <input type="text" name="model_free" placeholder="codex model (free text)" style="width:150px"></label><label>Effort <select name="effort">${opts(LAUNCH_OPTIONS[provider === "codex" ? "codex" : "claude"].efforts, l.effort)}</select></label></div>
    <div class="row"><label style="flex:1">Folder <input type="text" name="cwd" value="${esc(cwd || projectCwd(s))}" style="width:100%"></label></div>
    <label>First prompt<textarea name="prompt">${esc(l.prompt || defaultNewPrompt(s.resolved || s.file))}</textarea></label>
    <div class="row"><button class="b" type="submit">Start in a terminal</button><span class="meta">Claude: <span class="mono">claude --session-id &lt;new uuid&gt; …</span> (stamped on the plan at once). Codex: <span class="mono">codex -C &lt;folder&gt; …</span> (its thread id is matched by folder on the first poll).</span></div></form>`;
  return isNew ? newForm + `<details style="margin-top:14px"><summary class="meta" style="cursor:pointer">Resume the existing session instead</summary>${resumeForm}</details>` : resumeForm + newForm;
}
function renderConnect(s, q, serverUp, layout) {
  const isNew = q.get("new") === "1";
  const body = `<div class="crumbs"><a href="/">All plans</a> › <a href="/session/${s.key}">${esc(s.title)}</a> › <b>${isNew ? "New session" : "Resume"}</b></div><h1>${esc(s.title)}</h1><p class="meta">${esc(shortPath(s.resolved || s.file))}</p>${agentBlock(s, { forms: false })}${launchForms(s, { isNew })}`;
  return page(`${isNew ? "New session" : "Resume"} · ${s.title}`, `${s.project} · ${s.title}`, body, serverUp, { layout });
}
/** The Agent block: state, name, id, cwd, provider, source; Change effort for owned Claude terminals; Find sessions; earlier sessions. */
function agentBlock(s, { forms = true, effortResult = "", scanResult = "" } = {}) {
  const a = s.agent;
  const owned = a.state === "active" && a.terminal && a.provider === "claude";
  const list = s.agents.filter((x) => x.id !== a.id);
  return `<h2 id="agent">Agent <span class="meta" style="font-family:'Public Sans',system-ui;font-size:12.5px;font-weight:400">who is on this plan, from lavish-poll / lavish-meta stamps${a.source === "scan" ? " (this one from the transcript scan)" : ""}</span></h2>
  <div class="kv"><span class="k">State</span><span>${a.state === "none" ? '<span class="ag none">not connected</span>' : `<span class="ag ${a.state}${a.source === "scan" ? " scan" : ""}">${a.state === "active" ? '<span class="dot"></span>' : ""}${esc(a.state)}${a.state === "active" ? ` · ${a.terminal ? "terminal " + esc(a.tmuxName) : esc(a.entrypointLabel)}${a.status ? ` · ${esc(a.status)}` : ""}` : ` · ${esc(ago(a.at))}`}</span>`}</span>
  ${a.state !== "none" ? `<span class="k">Name</span><span>${glyph(a.provider)} <span class="mono">${esc(a.name)}</span> · ${esc(a.provider)}${a.guessed ? " · guessed (several live Codex threads in this folder)" : ""}</span><span class="k">Id</span><span class="mono">${esc(a.id)}</span><span class="k">Folder</span><span class="mono">${esc(a.cwd || "")}${a.cwd && !existsSync(a.cwd) ? ' <span class="st orphan">missing</span>' : ""}</span><span class="k">Stamped</span><span>${esc(a.source)} · ${fmt(a.at)}${a.state === "ended" ? ` · would resume as <span class="mono">${esc(a.tmuxName)}</span>` : ""}</span>` : ""}</div>
  ${effortResult ? `<div class="notice">${esc(effortResult)}</div>` : ""}${scanResult ? `<div class="notice">${esc(scanResult)}</div>` : ""}
  ${forms ? `<div class="row" style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin:6px 0 10px">
    ${owned ? `<form class="inline" method="post" action="/effort/${s.key}"><label>Change effort <select name="level">${LAUNCH_OPTIONS.claude.efforts.filter((e) => e !== "default").map((e) => `<option value="${e}">${e}</option>`).join("")}</select></label> <button class="b q" type="submit" title="Types /effort <level> into the terminal ${esc(a.tmuxName)}, only while it is idle at its prompt, then shows the pane's reply">Type /effort into the terminal</button></form>` : a.state === "active" && a.provider === "claude" ? `<span class="meta">Change effort is only offered for a Claude session in a terminal this page or Manager Marcus started (this one is in ${esc(a.entrypointLabel)}).</span>` : ""}
    <form class="inline" method="post" action="/scan/${s.key}"><button class="b q" type="submit" title="Look through this project's transcripts of the last 7 days for sessions that read or edited this plan (Read/Edit/Write targets only; a Bash mention does not count)">Find sessions</button></form>
    ${a.state === "ended" || a.state === "none" ? `<a class="a" href="/connect/${s.key}">Resume / New session…</a>` : `<a class="a" href="/connect/${s.key}?new=1">New session…</a>`}</div>` : ""}
  ${list.length ? `<p class="meta" style="margin:4px 0 0">Earlier sessions on this plan: ${list.map((x) => `<span class="ag ${x.source === "scan" ? "scan" : ""}" style="display:inline-flex;margin-right:10px" title="${esc(x.provider)} ${esc(x.id)} · ${esc(x.source)} · ${esc(fmt(x.at))}">${glyph(x.provider)}<span class="name">${esc(agentLabel(x))}</span> · ${esc(ago(x.at))}</span>`).join("")}</p>` : ""}`;
}

function renderSession(s, all, serverUp, q, layout) {
  const groups = transcriptGroups(s).reverse();
  const msgHtml = (i) => `<div class="msg ${i.role === "agent" ? "agent" : i.role === "system" ? "sys" : i.kind === "annotation" ? "ann" : ""}"><small>${i.role === "agent" ? "agent" : i.role === "system" ? "system" : "you"} · ${esc(i.kind || "")}${i.tag && i.kind === "annotation" ? ` on &lt;${esc(i.tag)}&gt;` : ""}${i.where ? ` · “${esc(i.where.slice(0, 80))}”` : ""} · ${fmt(i.at)}</small>${esc(i.text)}</div>`;
  const msgs = groups.length ? groups.map((g, gi) => {
    const live = s.agent.id && g.id === s.agent.id ? s.agent : null;
    const resumeBtn = g.id && !(live && live.state === "active") && g.rec ? `<form class="inline" method="post" action="/connect/${s.key}?agent=${encodeURIComponent(g.id)}" style="margin-left:8px"><button class="a" type="submit" title="Resume this particular session in a terminal">Resume</button></form>` : "";
    return `<details class="tg"${gi === 0 ? " open" : ""}><summary>${g.id ? glyph(g.provider) : ""}<span class="who">${esc(g.name)}</span>${live ? `<span class="ag ${live.state}" style="font-size:11.5px">${live.state === "active" ? '<span class="dot"></span>' : ""}${esc(live.state)}</span>` : ""}${resumeBtn}<span class="when">${g.items.length} message${g.items.length === 1 ? "" : "s"} · ${fmtDay(g.first)}${g.last !== g.first ? ` → ${fmtDay(g.last)}` : ""}</span></summary><div class="body">${g.items.map(msgHtml).join("")}</div></details>`;
  }).join("") : `<p class="empty">No transcript yet. Typed messages and agent replies appear here from state.json; annotations appear once lavish-poll has delivered a round.</p>`;
  const related = s.related.map((r) => { const t = all.find((x) => x.resolved && (x.resolved.endsWith(r) || basename(x.resolved) === r)); return t ? `<a class="a" href="/session/${t.key}">${esc(t.title)}</a>` : esc(r); }).join("<br>");
  const restored = q.get("restored"), prRefreshed = q.get("prs"), notice = q.get("notice"), effortResult = q.get("effort") || "", scanResult = q.get("scan") || "";
  const statusForm = `<form method="post" action="/status/${s.key}" style="display:grid;gap:6px">
      <label>Plan status <select name="status" onchange="this.form.submit()"><option value="">— infer (${esc(s.plan.inferred ? s.plan.status : "auto")})</option>${STATUSES.map((x) => `<option value="${x}"${normalizeStatus(s.reg.status) === x ? " selected" : ""}>${x.replace("-", " ")}</option>`).join("")}</select>
      &nbsp; Priority <select name="priority" onchange="this.form.submit()">${PRIORITIES.map((x) => `<option value="${x}"${s.plan.priority === x ? " selected" : ""}>${x}</option>`).join("")}</select></label>
      <label>Add PR # <input type="number" name="pr" min="1" style="width:90px" placeholder="536"> <button class="b" type="submit">Save</button></label>
      <label>Summary <input type="text" name="summary" value="${esc(s.reg.summary || "")}" placeholder="${esc(s.head.summary || "one line, shown on the home page")}" style="width:100%"></label>
    </form>
    <form method="post" action="/refresh-prs/${s.key}" style="margin-top:6px"><button class="b q" type="submit" title="Runs gh pr view for each PR">Refresh PR states</button>${prRefreshed ? ` <span class="meta">${esc(prRefreshed)}</span>` : ""}</form>
    <form method="post" action="/move/${s.key}" style="margin-top:6px"><label>Folder <select name="fid" onchange="this.form.submit()"><option value="">— unfiled (${esc(s.project)})</option>${folderOptions(layout, s.folder)}</select></label></form>`;
  const body = `<div class="crumbs"><a href="/">All plans</a>${s.folderPath.map((f) => ` › <a href="/?folder=${esc(f.id)}">${esc(f.name)}</a>`).join("") || ` › <a href="/?project=${encodeURIComponent(s.project)}">${esc(s.project)}</a>`} › <b>${esc(s.title)}</b></div>
  <h1 style="display:flex;align-items:center;gap:10px">${monogram(s.project, { logo: s.logo, key: s.key, size: 32 })}${esc(s.title)}</h1><p class="meta">${esc(s.project)}${s.worktree ? ` · worktree ${esc(s.worktree)}` : ""} · session ${s.key}${s.plan.summary ? `<br>${esc(s.plan.summary)}` : ""}</p>
  ${restored ? `<div class="notice">Restored version ${esc(restored)} onto disk. Your Lavish tab will offer a reload. The agent does not learn about this by itself, so tell it in the conversation panel.</div>` : ""}
  ${notice ? `<div class="notice ${/^(Could not|Folder missing|.* not found)/.test(notice) ? "bad" : ""}">${esc(notice)}</div>` : ""}
  ${agentBlock(s, { effortResult, scanResult })}
  <div class="detail"><div><h2 style="margin-top:14px">Conversation <span class="meta" style="font-family:'Public Sans',system-ui;font-size:12.5px;font-weight:400">grouped per agent session, newest first</span></h2>${msgs}</div><div class="side2">
    <p><b>File</b><br><span class="mono">${esc(s.resolved || s.file)}</span>${!s.exists ? ' <span class="st orphan">missing</span>' : ""}</p>
    <p><b>Lavish session</b> ${esc(s.status)}${s.endedBy ? ` by ${esc(s.endedBy)}` : ""} · <b>updated</b> ${fmt(s.updated)}<br><b>Review</b> ${s.agentMsgs} agent replies · ${s.userSent} items sent · ${s.privateNotes} private comments</p>
    <p><b>Stage</b> <span class="stg ${esc(s.plan.stage)}${s.plan.stageInferred ? " inferred" : ""}">${esc(s.plan.stageLabel)}</span> ${esc(s.plan.subLabel)}${s.plan.session?.label ? ` · <b>working session</b> ${esc(s.plan.session.label)}` : ""}<br><b>Plan</b> ${planChip(s.plan)} &nbsp; <b>PRs</b> ${prChips(s.plan)}</p>
    ${statusForm}
    ${related ? `<p style="margin-top:12px"><b>Related</b><br>${related}</p>` : ""}
    <p style="margin-top:12px">${s.exists ? `<a class="a" href="/view/${s.key}/" target="_blank" rel="noopener">View</a><form class="inline" method="post" action="/open/${s.key}"><button class="a" type="submit">${s.status === "ended" ? "Reopen in Lavish" : "Open in Lavish"}</button></form>` : ""}<a class="a" href="/session/${s.key}.md">Export transcript (.md)</a>${s.exists && s.status !== "ended" ? `<form class="inline" method="post" action="/end/${s.key}" onsubmit="return confirm('End this Lavish session?')"><button class="a" type="submit">End session</button></form>` : ""}</p>
  </div></div>
  ${launchForms(s)}
  ${renderProgress(s)}
  ${renderVersions(s)}
  ${renderCommits(s)}
  ${renderNotes(s)}
  ${renderUnsent(s)}
  ${renderExport(s)}`;
  return page(s.title, `${s.project} · ${s.title}`, body, serverUp, { layout });
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
function renderVersions(s) {
  const cur = currentVersionState(s);
  const buckets = commentsPerVersion(s);
  let html = `<h2 id="versions">Versions <span class="meta" style="font-family:'Public Sans',system-ui;font-size:12.5px;font-weight:400">${s.versions.length} saved${cur.n ? ` · the file on disk ${cur.dirty ? `has changed since v${cur.n} (snapshotted within ${SCAN_MS / 1000}s)` : `is v${cur.n}`}` : ""}</span></h2>`;
  if (!s.versions.length) return html + `<p class="empty">No versions yet. A copy is saved whenever the file changes (checked every ${SCAN_MS / 1000}s) and at every lavish-poll round.</p>`;
  html += `<div class="tw"><table><thead><tr><th>Version</th><th>Saved</th><th>Why</th><th>Round</th><th title="comments you sent and private notes you wrote while this version was on screen">Comments</th><th>Text lines</th><th>Size</th><th>Actions</th></tr></thead><tbody>`;
  const vs = s.versions.slice().reverse();
  for (const v of vs) {
    const bucket = buckets.get(v.n) || [];
    const nSent = bucket.filter((i) => i.kind !== "private" && i.kind !== "resolved").length, nPriv = bucket.length - nSent;
    const commentsCell = bucket.length ? `<details class="vcomments"><summary>${nSent} sent · ${nPriv} private</summary>${bucket.map((i) => `<div class="note ${esc(i.kind === "private" || i.kind === "resolved" ? i.kind : "sent")}"><div class="anc">${esc(i.kind)}${i.where ? ` · “${esc(String(i.where).slice(0, 80))}”` : ""} · ${fmt(i.at)}</div>${esc(i.text)}${(i.files || []).length ? `<div class="thumbs">${i.files.map((f) => `<a href="${esc(f.url)}" target="_blank" rel="noopener"><img src="${esc(f.url)}" alt="${esc(f.name)}"></a>`).join("")}</div>` : ""}</div>`).join("")}</details>` : `<span class="num">–</span>`;
    const prev = s.versions.find((x) => x.n === v.n - 1) || s.versions.filter((x) => x.n < v.n).pop();
    const delta = prev ? v.lines - prev.lines : 0;
    const why = v.label ? esc(v.label) : v.reason === "agent-reply" ? "agent replied (round closed)" : v.reason === "poll" ? "agent polled" : v.reason === "baseline" ? "first snapshot" : v.reason === "pre-restore" ? "before a restore" : v.reason === "restore" ? "restored version" : "file changed on disk";
    const acts = [
      `<a class="a" href="/version/${s.key}/${v.n}/" target="_blank" rel="noopener">View</a>`,
      prev ? `<a class="a" href="/diff/${s.key}/${prev.n}/${v.n}">Diff → previous</a>` : "",
      s.exists ? `<a class="a" href="/diff/${s.key}/${v.n}/current">Diff → current</a>` : "",
      s.exists && (cur.dirty || v.n !== cur.n) ? `<form class="inline" method="post" action="/restore/${s.key}/${v.n}" onsubmit="return confirm('Put version ${v.n} back onto disk? The current file is snapshotted first, so nothing is lost.')"><button class="a" type="submit">Restore</button></form>` : "",
    ].join("");
    html += `<tr id="v${v.n}"><td><b>v${v.n}</b>${v.n === cur.n && !cur.dirty ? ' <span class="st open">current</span>' : ""}</td><td class="num">${fmt(v.at)}</td><td>${why}</td><td class="num">${v.round ?? "–"}</td><td>${commentsCell}</td><td class="num">${v.lines}${prev ? ` <span style="color:${delta > 0 ? "var(--good)" : delta < 0 ? "var(--bad)" : "var(--ink3)"}">(${delta > 0 ? "+" : ""}${delta})</span>` : ""}</td><td class="num">${kb(v.bytes)}</td><td>${acts}</td></tr>`;
  }
  return html + `</tbody></table></div>`;
}
function renderCommits(s) {
  if (!s.exists) return "";
  const info = gitInfo(s.resolved);
  if (!info.root) return "";
  const log = gitLogForFile(s.resolved, 15);
  const st = gitStatusForFile(s.resolved);
  let html = `<h2>Commits <span class="meta" style="font-family:'Public Sans',system-ui;font-size:12.5px;font-weight:400">${esc(info.slug || basename(info.root))} · working copy ${esc(st)}</span></h2>`;
  if (!log.length) return html + `<p class="empty">Not committed yet.</p>`;
  html += `<div class="tw"><table><thead><tr><th>Commit</th><th>When</th><th>Subject</th></tr></thead><tbody>`;
  for (const c of log) html += `<tr><td class="mono">${info.webBase ? `<a class="a" href="${esc(info.webBase)}/commit/${esc(c.hash)}" target="_blank" rel="noopener">${esc(c.hash)}</a>` : esc(c.hash)}</td><td class="num">${fmt(c.date)}</td><td>${esc(c.subject)}</td></tr>`;
  return html + `</tbody></table></div>`;
}
function renderNotes(s) {
  const notes = s.notes.slice().sort((a, b) => String(a.created).localeCompare(String(b.created)));
  let html = `<h2>Private comments <span class="meta" style="font-family:'Public Sans',system-ui;font-size:12.5px;font-weight:400">${notes.length} · written in the Comments rail · never sent to the agent</span></h2>`;
  if (!notes.length) return html + `<p class="empty">None. In Lavish, click or select something in the artifact and choose “Keep private”.</p>`;
  for (const n of notes) html += `<div class="note ${esc(n.state || "private")}"><div class="anc">${n.anchor?.text ? `“${esc(String(n.anchor.text).slice(0, 120))}”` : "general"}${n.anchor?.tag ? ` · &lt;${esc(n.anchor.tag)}&gt;` : ""} · ${esc(n.state || "private")}${n.state === "sent" && n.sentAt ? ` ${fmt(n.sentAt)}` : ""} · ${fmt(n.updated || n.created)}</div>${esc(n.body)}${(n.attachments || []).length ? `<div class="thumbs">${n.attachments.map((f) => `<a href="${esc(f.url)}" target="_blank" rel="noopener"><img src="${esc(f.url)}" alt="${esc(f.name)}"></a>`).join("")}</div>` : ""}${(n.replies || []).map((r) => `<div class="reply">↳ ${esc(r.text)}</div>`).join("")}</div>`;
  return html;
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
function serveVersion(res, s, n) {
  const v = s.versions.find((x) => x.n === n);
  if (!v || !existsSync(versionPath(s.key, n))) return send(res, 404, "text/plain", "no such version");
  let html = readFileSync(versionPath(s.key, n), "utf8");
  const base = `<base href="/version/${s.key}/${n}/">`;
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
function renderProgress(s) {
  const p = s.plan;
  const steps = [...STAGES].map((st, i) => `<span class="${p.stage === st ? "now" + (p.stageInferred ? " inferred" : "") : i < p.stageIndex ? "past" : ""}">${STAGE_LABELS[st]}</span>`).join("");
  const sessions = recentSessions(s.reg);
  const entries = (s.reg.progress || []).slice().reverse();
  let html = `<h2 id="progress">Progress <span class="meta" style="font-family:'Public Sans',system-ui;font-size:12.5px;font-weight:400">${esc(p.stageLabel)} · ${esc(p.subLabel)}${p.progress.pct != null ? ` · ${p.progress.pct}% done` : ""}${p.stageNote ? ` · ${esc(p.stageNote)}` : ""}</span></h2>
  <div class="stage-steps${p.stage === "parked" ? " parked" : ""}">${steps}</div>
  <p class="meta">${sessions.length ? `Working session${sessions.length > 1 ? "s" : ""} (last 7 days): ${sessions.map((x) => `<b>${esc(x.label)}</b>${x.cwd ? ` <span class="mono">${esc(shortPath(x.cwd))}</span>` : ""} · ${fmt(x.at)}`).join(" · ")}` : "No session has posted progress yet. The agent does it with <span class=\"mono\">lavish-meta &lt;plan&gt; --progress \"…\"</span>; status and PR changes log themselves."}</p>
  <form method="post" action="/status/${s.key}" class="xform"><div class="row"><label style="flex:1 1 auto;display:flex;gap:6px;align-items:center">Add a progress note <input type="text" name="progress" placeholder="what happened, e.g. PR3 opened (2 of 5)" style="flex:1 1 auto;font:inherit;font-size:12.5px;padding:3px 6px;border:1px solid #d5d2cb;border-radius:6px"></label><label>% <input type="number" name="pct" min="0" max="100" style="width:64px;font:inherit;font-size:12.5px;padding:3px 6px;border:1px solid #d5d2cb;border-radius:6px"></label><button class="b" type="submit" style="font:inherit;font-size:12px;padding:3px 9px;border:1px solid var(--acc);border-radius:6px;background:var(--acc);color:#fff;cursor:pointer">Save</button></div></form>`;
  if (!entries.length) return html;
  html += `<table class="tl"><thead><tr><th>When</th><th>Session</th><th>Event</th></tr></thead><tbody>`;
  for (const e of entries) html += `<tr><td class="num">${fmt(e.at)}</td><td class="sess">${esc(e.session?.label || "")}</td><td>${e.kind === "status" ? "🔄 " : e.kind === "pr" ? "🔗 " : e.kind === "verdict" ? "✅ " : ""}${esc(e.text)}${e.pct != null ? ` <span class="num">· ${e.pct}%</span>` : ""}</td></tr>`;
  return html + `</tbody></table>`;
}
function renderUnsent(s) {
  const items = s.unsent.items.filter((p) => !(p.tag === "message" && !p.selector) && p.tag !== "verdict");
  const draft = s.unsent.draft?.card?.text ? s.unsent.draft.card : null;
  if (!items.length && !draft) return "";
  let html = `<h2>Unsent comments <span class="meta" style="font-family:'Public Sans',system-ui;font-size:12.5px;font-weight:400">${items.length} queued in the Comments rail, not sent yet${draft ? " · plus an unfinished annotation card" : ""} · they reappear when the page is reopened</span></h2>`;
  for (const p of items) html += `<div class="note"><div class="anc">${p.text ? `“${esc(String(p.text).slice(0, 120))}”` : "general"}${p.tag ? ` · &lt;${esc(p.tag)}&gt;` : ""} · queued</div>${esc(p.prompt || "")}${(p.attachments || []).length ? `<div class="thumbs">${p.attachments.map((a) => { const c = s.unsent.files?.[a.id]; const src = c?.url || `http://127.0.0.1:${process.env.LAVISH_AXI_PORT || 4387}/api/${s.key}/attachments/${a.id}`; return `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="${esc(a.name || "image")}"></a>`; }).join("")}</div>` : ""}</div>`;
  if (draft) html += `<div class="note"><div class="anc">annotation card on <span class="mono">${esc(draft.selector || "")}</span> · draft</div>${esc(draft.text)}</div>`;
  return html;
}
function renderExport(s) {
  if (!s.exists) return "";
  const chk = (v, label) => `<label><input type="checkbox" name="include" value="${v}"> ${label}</label>`;
  return `<h2 id="export">Export <span class="meta" style="font-family:'Public Sans',system-ui;font-size:12.5px;font-weight:400">the plan alone by default; tick what to append, or untick the plan for the review material only</span></h2>
  <form class="xform" method="get" action="/export/${s.key}" target="_blank" onsubmit="this.include.value=[...this.querySelectorAll('input[name=include]:checked')].map(c=>c.value).join(',')">
    <div class="row"><span>Format</span><label><input type="radio" name="format" value="md" checked> Markdown</label><label><input type="radio" name="format" value="html"> HTML (self-contained)</label><label><input type="radio" name="format" value="pdf"> PDF</label></div>
    <div class="row"><span>Content</span><label><input type="checkbox" name="planbox" checked onchange="this.form.plan.value=this.checked?'1':'0'"> the plan</label>${chk("chat", "agent conversation")}${chk("comments", "comments sent")}${chk("notes", "private notes")}<input type="hidden" name="include" value=""><input type="hidden" name="plan" value="1"></div>
    <div class="row"><button class="b" type="submit" style="font:inherit;font-size:12px;padding:4px 10px;border:1px solid var(--acc);border-radius:6px;background:var(--acc);color:#fff;cursor:pointer">Download</button><a class="a" href="/export/${s.key}?format=html&inline=1" target="_blank">Preview HTML</a><span class="meta">PDF renders with the headless Chromium on this machine; Markdown from here uses the page's own converter run headlessly (open the plan in Lavish and export there for the fastest path).</span></div>
  </form>`;
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
const layoutJson = (sessions) => { const layout = readLayout(); return { layout, counts: folderCounts(layout, sessions), tree: folderTree(layout) }; };
const okLevel = (v, list) => (list.includes(String(v || "")) ? String(v) : "");

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
      folder: s.folder ? { id: s.folder, name: s.folderPath[s.folderPath.length - 1]?.name || "", path: s.folderPath.map((f) => f.name).join(" › ") } : null,
      agent: s.agent.state === "none" ? null : { provider: s.agent.provider, id: s.agent.id, state: s.agent.state, name: s.agent.name, terminal: s.agent.terminal, tmuxName: s.agent.tmuxName, entrypoint: s.agent.entrypoint, cwd: s.agent.cwd, source: s.agent.source, at: s.agent.at } })));
    if (path === "/api/layout") {
      if (req.method === "GET") return json(res, 200, layoutJson(loadSessions()));
      if (req.method === "PUT") {
        const b = parseBody(await readBody(req), req.headers["content-type"]);
        try {
          if (b.op === "file") filePlan(String(b.key || ""), String(b.fid || ""));
          else if (b.op === "move") moveFolder(String(b.fid || ""), String(b.parent || ""));
          else if (b.op === "create") createFolder(String(b.name || ""), String(b.parent || ""));
          else if (b.op === "rename") renameFolder(String(b.fid || ""), String(b.name || ""));
          else if (b.op === "delete") deleteFolder(String(b.fid || ""));
          else return json(res, 400, { error: "op must be file, move, create, rename or delete" });
        } catch (e) { return json(res, 400, { error: e.message }); }
        const sessions = loadSessions();
        const moved = b.op === "file" ? sessions.find((x) => x.key === b.key) : null;
        return json(res, 200, { ...layoutJson(sessions), folderHtml: moved ? folderCellHtml(moved) : "" });
      }
      return json(res, 405, { error: "GET or PUT" });
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
      if (!m[3]) return serveVersion(res, s, Number(m[2]));
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
      if (req.method === "GET") return send(res, 200, "text/html; charset=utf-8", renderConnect(s, url.searchParams, serverUp, layout));
      if (req.method !== "POST") return send(res, 405, "text/plain", "GET or POST");
      const body = parseBody(await readBody(req), req.headers["content-type"]);
      const isNew = url.searchParams.get("new") === "1";
      const provider = isNew ? (body.provider === "codex" ? "codex" : "claude") : (s.agent.provider || "claude");
      const model = String(body.model_free || body.model || "").trim();
      const effort = okLevel(body.effort, LAUNCH_OPTIONS[provider].efforts);
      const remember = { provider, model, effort, ...(isNew && body.prompt ? { prompt: String(body.prompt).slice(0, 4000) } : {}) };
      try { updateRegistry(s.key, { file: s.resolved, launch: remember }); } catch {}
      const back = `/session/${s.key}`;
      await refreshLive(true);
      if (isNew) {
        const r = await startNewAgent({ provider, cwd: String(body.cwd || projectCwd(s)), planPath: s.resolved, planKey: s.key, model, effort, prompt: body.prompt }, { live: liveCache });
        if (!r.ok) return send(res, 422, "text/html; charset=utf-8", errorPage("Could not start a new session", r.error, { back: `/connect/${s.key}?new=1` }, serverUp));
        if (r.agent) { try { updateRegistry(s.key, { file: s.resolved, agent: r.agent }); } catch {} }
        const note = `Started ${r.tmuxName} in Terminal.app${r.terminalError ? ` (the window did not open: ${r.terminalError}; attach with: tmux attach -t '=${r.tmuxName}')` : ""}. Its first prompt opens this plan in Lavish and polls it${r.provider === "codex" ? "; the Codex thread is matched by folder on that first poll" : ""}.`;
        return redirect(res, `${back}?notice=${encodeURIComponent(note)}#agent`);
      }
      // Resume: optionally a specific earlier session (from a transcript group), else the plan's current agent
      const wanted = url.searchParams.get("agent") || "";
      const rec = wanted ? (s.agents.find((a) => a.id === wanted) || (s.reg.agent && s.reg.agent.id === wanted ? s.reg.agent : null)) : s.reg.agent;
      if (wanted && !rec) return send(res, 404, "text/html; charset=utf-8", errorPage("Unknown session", `No session ${wanted} is recorded on this plan.`, { back }, serverUp));
      const r = await resumeAgent({ agent: rec }, s.key, { model, effort }, { live: liveCache, tmuxNames: liveCache.tmux });
      if (!r.ok) return send(res, 422, "text/html; charset=utf-8", errorPage("Could not resume", r.error, { back: `/connect/${s.key}`, extra: `<p><a class="a" href="/connect/${s.key}?new=1">Start a New session instead</a></p>` }, serverUp));
      const lv = openLavish(s);
      if (lv.error) return send(res, 500, "text/html; charset=utf-8", errorPage("Terminal ready, Lavish did not open", `${r.action === "resume" ? `Resumed in ${r.tmuxName}. ` : ""}${lv.error}`, { back }, serverUp));
      if (r.action === "lavish" || r.terminalError || r.note) {
        const msg = r.action === "lavish" ? r.note : `${r.note || (r.action === "resume" ? `Resumed ${r.state.name} in terminal ${r.tmuxName}.` : `Terminal ${r.tmuxName}.`)}${r.terminalError ? ` Terminal.app did not open: ${r.terminalError}. Attach by hand: tmux attach -t '=${r.tmuxName}'` : ""}`;
        return send(res, 200, "text/html; charset=utf-8", page("Resume", s.title, `<div class="errpage"><h1>${esc(s.title)}</h1><div class="notice ${r.terminalError ? "warn" : ""}">${esc(msg)}</div><p><a class="b" style="text-decoration:none;padding:6px 12px;border-radius:6px;background:var(--acc);color:var(--accInk)" href="${esc(lv.url)}">Open the plan in Lavish</a></p><p class="meta">Opens by itself in 5 s.</p><meta http-equiv="refresh" content="5;url=${esc(lv.url)}"><p class="meta"><a class="a" href="${back}">← Back to the plan page</a></p></div>`, serverUp));
      }
      return redirect(res, lv.url);
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
    if (req.method === "POST" && path === "/folders") {
      const b = parseBody(await readBody(req), req.headers["content-type"]);
      try { const { fid } = createFolder(b.name, b.parent || ""); return redirect(res, `/?folder=${fid}`); } catch (e) { return send(res, 400, "text/html; charset=utf-8", errorPage("Could not create the folder", e.message, {}, serverUp)); }
    }
    if (req.method === "POST" && (m = /^\/folders\/([a-z0-9]{6,24})$/.exec(path))) {
      const b = parseBody(await readBody(req), req.headers["content-type"]);
      const parent = layout.folders[m[1]]?.parent || "";
      try {
        if (b.op === "rename") { renameFolder(m[1], b.name); return redirect(res, `/?folder=${m[1]}`); }
        if (b.op === "move") { moveFolder(m[1], b.parent || ""); return redirect(res, `/?folder=${m[1]}`); }
        if (b.op === "delete") { deleteFolder(m[1]); return redirect(res, parent ? `/?folder=${parent}` : "/"); }
        return send(res, 400, "text/plain", "op must be rename, move or delete");
      } catch (e) { return send(res, 400, "text/html; charset=utf-8", errorPage("Folder change refused", e.message, { back: `/?folder=${m[1]}` }, serverUp)); }
    }
    if (req.method === "POST" && (m = /^\/move\/([0-9a-f]{16})$/.exec(path))) {
      const b = parseBody(await readBody(req), req.headers["content-type"]);
      try { filePlan(m[1], b.fid || ""); } catch (e) { return send(res, 400, "text/html; charset=utf-8", errorPage("Could not move the plan", e.message, {}, serverUp)); }
      return redirect(res, safeBack(url.searchParams.get("back"), `/session/${m[1]}`));
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
      snapshotVersion(s.resolved, s.key, { reason: "pre-restore" });
      copyFileSync(versionPath(s.key, n), s.resolved);
      snapshotVersion(s.resolved, s.key, { reason: "restore", label: `restored v${n}` });
      appendHistory(s.key, s.resolved, { role: "system", kind: "restore", text: `restored v${n} from the home page` });
      seenMtime.delete(s.key);
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
      if (m[1] === "end") return redirect(res, "/");
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
