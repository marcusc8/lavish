/* lavish-lib.mjs — shared helpers for the local Lavish tooling (home page, poll wrapper, meta CLI).
 *
 * Storage layout under ~/.lavish-axi (override with LAVISH_AXI_STATE_DIR):
 *   state.json             the Lavish server's own store — read-only for us
 *   history/<key>.jsonl    review transcript, written by lavish-poll
 *   notes/<key>.json       the reviewer's PRIVATE comments (Comments rail). Never delivered to an agent.
 *   notes/<key>.files/     images attached to private comments
 *   queue/<key>.json       unsent comments, their image copies and the card draft, mirrored by the rail. Off-limits too.
 *   versions/<key>/        snapshots of the artifact file: index.json + v0001.html, v0002.html …
 *   registry.json          per-artifact plan status / priority / PRs / summary / progress log / agent link (lavish-meta, home page)
 *   home-layout.json       the reviewer's tags + sidebar order on the home page, v2 (separate from plan facts, so lavish-meta never clobbers them)
 *   exports/<key>/         the plan's Markdown handed over by the page, and temp files for PDF rendering
 *
 * <key> is sha256(realpath of the artifact).slice(0, 16), the same key the Lavish server uses.
 */
import { extractLinks } from "./lavish-chats.mjs";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, readSync, closeSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync, execFile } from "node:child_process";
import os from "node:os";

export const stateDir = process.env.LAVISH_AXI_STATE_DIR || join(os.homedir(), ".lavish-axi");
export const keyOf = (absolutePath) => createHash("sha256").update(absolutePath).digest("hex").slice(0, 16);
export const sha = (text) => createHash("sha256").update(text).digest("hex");
export const pad4 = (n) => String(n).padStart(4, "0");

export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

/* ── history (lavish-poll transcript) ────────────────────────────────────── */
export const historyPath = (key) => join(stateDir, "history", `${key}.jsonl`);
export function readHistory(key) {
  const p = historyPath(key);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
/** Review round = number of round-summary agent replies so far (threaded --reply answers do not count). */
export function roundOf(key) { return readHistory(key).filter((h) => h.role === "agent" && h.kind === "reply" && h.replyTo == null).length; }
export function appendHistory(key, file, entry) {
  mkdirSync(join(stateDir, "history"), { recursive: true });
  writeFileSync(historyPath(key), JSON.stringify({ at: new Date().toISOString(), key, file, ...entry }) + "\n", { flag: "a" });
}

/* ── private notes (Comments rail) ───────────────────────────────────────── */
export const notesPath = (key) => join(stateDir, "notes", `${key}.json`);
export function readNotes(key) {
  const v = readJson(notesPath(key), { notes: [], updatedAt: "" });
  return { notes: Array.isArray(v.notes) ? v.notes : [], updatedAt: v.updatedAt || "" };
}
export function writeNotes(key, notes) {
  const payload = { notes: Array.isArray(notes) ? notes : [], updatedAt: new Date().toISOString() };
  writeJsonAtomic(notesPath(key), payload);
  return payload;
}

/* ── unsent-comment mirror (Comments rail): survives closing the tab and other browsers ── */
export const queuePath = (key) => join(stateDir, "queue", `${key}.json`);
const EMPTY_QUEUE = () => ({ v: 1, at: "", by: "", items: [], files: {}, draft: null, sent: [] });
export function readQueue(key) {
  const v = readJson(queuePath(key), null);
  if (!v || typeof v !== "object") return EMPTY_QUEUE();
  return {
    v: 1, at: typeof v.at === "string" ? v.at : "", by: typeof v.by === "string" ? v.by : "",
    items: Array.isArray(v.items) ? v.items.filter((p) => p && typeof p === "object") : [],
    files: v.files && typeof v.files === "object" && !Array.isArray(v.files) ? v.files : {},
    draft: v.draft && typeof v.draft === "object" ? v.draft : null,
    sent: Array.isArray(v.sent) ? v.sent.filter((x) => x && typeof x === "object").slice(0, 50) : [],
  };
}
export function writeQueue(key, payload) {
  const q = { ...EMPTY_QUEUE(), ...(payload && typeof payload === "object" ? payload : {}) };
  q.v = 1; if (!q.at) q.at = new Date().toISOString();
  writeJsonAtomic(queuePath(key), q);
  return q;
}
export function deleteQueue(key) { try { unlinkSync(queuePath(key)); } catch { /* already gone */ } }

/* ── agent identity: which Claude / Codex session is running this tool ───── */
export const claudeSessionsDir = () => join(process.env.CLAUDE_CONFIG_DIR || join(os.homedir(), ".claude"), "sessions");
export const codexHome = () => process.env.CODEX_HOME || join(os.homedir(), ".codex");
const realpathOr = (p) => { try { return realpathSync(p); } catch { return p; } };
/** First 1 KB of a file, or "" (a rollout's first line is its session_meta). */
function headLine(file, bytes = 4096) {
  try { const fd = openSync(file, "r"); const buf = Buffer.alloc(bytes); const n = readSync(fd, buf, 0, bytes, 0); closeSync(fd); return buf.toString("utf8", 0, n).split("\n")[0]; } catch { return ""; }
}
/** The name Claude Code gave a session (stylemanager-2-0-54), from ~/.claude/sessions/<pid>.json; "" when unknown. */
export function claudeSessionName(id, dir = claudeSessionsDir()) {
  let names = []; try { names = readdirSync(dir); } catch { return ""; }
  for (const f of names) { if (!f.endsWith(".json")) continue; const j = readJson(join(dir, f), null); if (j && j.sessionId === id) return String(j.name || ""); }
  return "";
}
/**
 * Codex exposes no thread-id variable, so the thread is matched by folder: the newest rollout under
 * ~/.codex/sessions/YYYY/MM/DD/ (last `days` days) whose session_meta.cwd is `cwd` and whose writer lock exists.
 * One live thread in the folder = exact; several = the newest wins and the stamp says guessed: true.
 */
export function resolveCodexThread(cwd, { home = codexHome(), days = 7, now = Date.now() } = {}) {
  const want = realpathOr(cwd);
  const matches = [];
  const root = join(home, "sessions");
  const since = now - days * 864e5;
  let years = []; try { years = readdirSync(root); } catch { return null; }
  for (const y of years) for (const m of safeDir(join(root, y))) for (const d of safeDir(join(root, y, m))) {
    const dayDir = join(root, y, m, d);
    const dayStamp = Date.parse(`${y}-${m}-${d}T00:00:00Z`);
    if (Number.isFinite(dayStamp) && dayStamp < since - 864e5) continue;
    for (const f of safeDir(dayDir)) {
      if (!f.startsWith("rollout-") || !f.endsWith(".jsonl")) continue;
      const file = join(dayDir, f);
      let mtime; try { mtime = statSync(file).mtimeMs; } catch { continue; }
      if (mtime < since) continue;
      let meta; try { meta = JSON.parse(headLine(file)); } catch { continue; }
      const payload = meta && meta.type === "session_meta" ? meta.payload || {} : null;
      if (!payload || !payload.id || realpathOr(String(payload.cwd || "")) !== want) continue;
      if (!existsSync(join(home, "thread-writer-locks", `${payload.id}.lock`))) continue;
      matches.push({ id: String(payload.id), mtime, file });
    }
  }
  if (!matches.length) return null;
  matches.sort((a, b) => b.mtime - a.mtime);
  return { provider: "codex", id: matches[0].id, cwd: want, entrypoint: "codex", ...(matches.length > 1 ? { guessed: true } : {}) };
}
function safeDir(p) { try { return readdirSync(p); } catch { return []; } }
/** {provider, id, entrypoint, cwd, name?, guessed?} for the agent running this process, or null. */
export function agentInfo(env = process.env, cwd = process.cwd(), opts = {}) {
  const id = String(env.CLAUDE_CODE_SESSION_ID || "").trim();
  if (id) return { provider: "claude", id, entrypoint: String(env.CLAUDE_CODE_ENTRYPOINT || "cli"), cwd: realpathOr(cwd), name: claudeSessionName(id, opts.claudeSessionsDir) };
  if(env.CODEX_THREAD_ID)return {provider:"codex",id:String(env.CODEX_THREAD_ID),entrypoint:"codex",cwd:realpathOr(cwd)};
  return resolveCodexThread(cwd, opts.codex || {});
}
export const MAX_AGENTS = 10;
/** Display name of an agent record: the Claude session name, else the first 8 of the id. */
export const agentLabel = (a) => (a ? (a.name || String(a.id || "").replace(/[^a-z0-9]/gi, "").slice(0, 8)) : "");

/* ── registry: plan status, PRs, summary ─────────────────────────────────── */
export const registryPath = join(stateDir, "registry.json");
// Plan lifecycle, in order. "merged" = its PR(s) are on main; "implemented" = verified live; "retired" = parked or abandoned.
export const STATUSES = ["not-started", "in-review", "approved", "in-progress", "merged", "implemented", "retired", "superseded"];
export const STATUS_ALIASES = { draft: "not-started", shipped: "merged", parked: "retired", done: "implemented", "still-working": "in-progress", working: "in-progress", reviewed: "in-review" };
/** Accepts old names and loose spellings ("Not started", "shipped") and returns a STATUSES entry, or "" for empty. */
export function normalizeStatus(value) {
  const k = String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  return k ? (STATUS_ALIASES[k] || k) : "";
}
export const PRIORITIES = ["high", "normal", "low"];
/* Stage: a coarse view of the status, derived (never stored), so the two cannot drift. Review = the PRs are on
   main and the result awaits verification; PR review itself happens inside Developing. */
export const STAGES = ["planning", "developing", "review", "done"];
export const STAGE_LABELS = { planning: "Planning", developing: "Developing", review: "Review", done: "Done", parked: "Parked" };
export function stageOf(status) {
  const st = normalizeStatus(status);
  const stage = ["not-started", "in-review", "approved", ""].includes(st) ? "planning" : st === "in-progress" ? "developing" : st === "merged" ? "review" : st === "implemented" ? "done" : "parked";
  return { stage, label: STAGE_LABELS[stage], index: STAGES.indexOf(stage) };
}
/** One line under the stage: what within the stage is true right now. */
export function subLabelOf(status, prs = []) {
  const st = normalizeStatus(status);
  const merged = prs.filter((p) => p.state === "MERGED").length, open = prs.filter((p) => p.state === "OPEN").length;
  if (st === "not-started" || !st) return "drafting";
  if (st === "in-review") return "in review";
  if (st === "approved") return "approved, awaiting implementation";
  if (st === "in-progress") return prs.length ? `${merged} of ${prs.length} PRs merged${open ? `, ${open} open` : ""}` : "in progress";
  if (st === "merged") return "on main, awaiting verification";
  if (st === "implemented") return "verified live";
  return st;
}
/** Who is writing progress: the agent's branch or worktree @ machine, unless a label is given. */
export function sessionInfo(label = "", cwd = process.cwd()) {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 3000 });
  const branch = r.status === 0 ? r.stdout.trim() : "";
  const worktree = (/\/worktrees\/([^/]+)/.exec(cwd) || [])[1] || "";
  const host = os.hostname().replace(/\.local$/, "");
  return { label: String(label || "").trim() || `${worktree || branch || "no-branch"}@${host}`, branch, host, cwd };
}
export const MAX_PROGRESS = 300;
export function readRegistry() { return readJson(registryPath, {}); }
/** patch = { status?, priority?, summary?, file?, addPrs?, removePrs?, prs?, progress?: string, pct?: number, session?: {label,…}, progressKind?,
 *            agent?: {provider, id, cwd, entrypoint, name?, guessed?, source: "poll"|"meta"|"scan"|"home"} }
 *  An agent stamp alone never logs progress and, when the id is unchanged, never bumps updatedAt (a poll every few
 *  minutes must not make every plan look freshly edited); it does refresh agent.at (last seen). */
export function updateRegistry(key, patch = {}) {
  const reg = readRegistry();
  const cur = reg[key] || { prs: {} };
  cur.prs = cur.prs && typeof cur.prs === "object" ? cur.prs : {};
  cur.progress = Array.isArray(cur.progress) ? cur.progress : [];
  const at = new Date().toISOString();
  let touched = Object.keys(patch).some((k) => !["agent", "file", "launch"].includes(k) && patch[k] !== undefined);
  // launch = the Resume / New session choice (provider, model, effort, prompt) remembered per plan; a preference, not a fact: no bump.
  if (patch.launch && typeof patch.launch === "object") cur.launch = { provider: patch.launch.provider === "codex" ? "codex" : "claude", model: String(patch.launch.model || ""), effort: String(patch.launch.effort || ""), ...(patch.launch.prompt ? { prompt: String(patch.launch.prompt) } : (cur.launch && cur.launch.prompt ? { prompt: cur.launch.prompt } : {})) };
  if (patch.agent && typeof patch.agent === "object" && patch.agent.id) {
    const a = patch.agent;
    const stamp = { provider: a.provider === "codex" ? "codex" : "claude", id: String(a.id), cwd: String(a.cwd || ""), entrypoint: String(a.entrypoint || ""), ...(a.name ? { name: String(a.name) } : {}), ...(a.guessed ? { guessed: true } : {}), source: ["poll", "meta", "scan", "home"].includes(a.source) ? a.source : "poll", at };
    const prevId = cur.agent && cur.agent.id;
    // A real stamp (poll/meta/home) beats a scan; a scan never displaces a stamped agent, it only joins the list.
    const scanOverStamp = stamp.source === "scan" && cur.agent && cur.agent.source !== "scan";
    if (!scanOverStamp) { cur.agent = stamp; if (prevId !== stamp.id) touched = true; }
    const rest = (Array.isArray(cur.agents) ? cur.agents : []).filter((x) => x && x.id !== stamp.id);
    cur.agents = [scanOverStamp ? { ...stamp } : cur.agent, ...rest].slice(0, MAX_AGENTS);
  }
  const session = patch.session && typeof patch.session === "object" ? { label: String(patch.session.label || ""), branch: String(patch.session.branch || ""), host: String(patch.session.host || ""), cwd: String(patch.session.cwd || "") } : null;
  const log = (entry) => cur.progress.push({ at, ...entry, ...(session ? { session } : {}) });
  if (patch.status !== undefined) {
    const st = normalizeStatus(patch.status);
    if (st && !STATUSES.includes(st)) throw new Error(`unknown status "${patch.status}" (one of ${STATUSES.join(", ")})`);
    const prev = normalizeStatus(cur.status || "");
    cur.status = st;
    if (st !== prev) log({ kind: "status", text: `status ${prev || "(inferred)"} → ${st || "(inferred)"}`, status: st });
  }
  if (patch.priority !== undefined) {
    const pr = String(patch.priority || "normal").trim().toLowerCase();
    if (!PRIORITIES.includes(pr)) throw new Error(`unknown priority "${patch.priority}" (one of ${PRIORITIES.join(", ")})`);
    cur.priority = pr;
  }
  if (patch.summary !== undefined) cur.summary = String(patch.summary || "");
  if (patch.file) cur.file = patch.file;
  const added = [];
  for (const n of patch.addPrs || []) { if (!cur.prs[n]) added.push(Number(n)); cur.prs[n] = { ...(cur.prs[n] || {}), n: Number(n), source: "declared" }; }
  if (added.length) log({ kind: "pr", text: `PR ${added.map((n) => "#" + n).join(", ")} attached`, prs: added });
  for (const n of patch.removePrs || []) delete cur.prs[n];
  for (const [n, rec] of Object.entries(patch.prs || {})) cur.prs[n] = { ...(cur.prs[n] || {}), ...rec, n: Number(n) };
  const pct = patch.pct === undefined || patch.pct === null || patch.pct === "" ? null : Math.max(0, Math.min(100, Math.round(Number(patch.pct))));
  if (patch.progress !== undefined && String(patch.progress).trim()) log({ kind: patch.progressKind || "note", text: String(patch.progress).trim(), ...(pct != null ? { pct } : {}) });
  else if (pct != null) log({ kind: "note", text: `${pct}% done`, pct });
  if (session) cur.session = { ...session, at };
  while (cur.progress.length > MAX_PROGRESS) cur.progress.shift();
  if (touched || !cur.updatedAt) cur.updatedAt = at;
  reg[key] = cur;
  writeJsonAtomic(registryPath, reg);
  return cur;
}
/** { latest, pct, count, entries } for display; pct = last explicit pct, else merged/declared PRs. */
export function progressSummary(reg, prs = [], limit = 20) {
  const entries = Array.isArray(reg?.progress) ? reg.progress : [];
  const latest = entries.length ? entries[entries.length - 1] : null;
  const explicit = [...entries].reverse().find((e) => e.pct != null);
  const declared = prs.filter((p) => p.source !== "inferred");
  const pct = explicit ? explicit.pct : declared.length ? Math.round((100 * declared.filter((p) => p.state === "MERGED").length) / declared.length) : null;
  return { latest, pct, count: entries.length, entries: entries.slice(-limit) };
}

/* ── home layout: the reviewer's tags and sidebar order on the home page ───── */
/* Separate from registry.json on purpose: lavish-meta rewrites plan facts and must never be able to clobber this.
 * v2 (plan 2026-09-05, D9): { version: 2, tags: { tid: {name, createdAt} }, plans: { key: [tid, …] }, projectOrder: [project, …],
 * planOrder: { project: [key, …] }, updatedAt }. A v1 file ({ folders, plans: {key: fid} }) migrates on first read: every folder
 * becomes a tag of the same name and every filed plan gets that tag; the v1 file is kept beside it as home-layout.json.v1.bak. */
export const layoutPath = () => join(stateDir, "home-layout.json");
const EMPTY_LAYOUT = () => ({ version: 2, tags: {}, plans: {}, projectOrder: [], planOrder: {}, updatedAt: "" });
const TID_RE = /^[a-z0-9]{6,24}$/, KEY_RE = /^[0-9a-f]{16}$/;
/** v1 → v2 in memory (pure): folders become tags, nested folders flatten to their own name, a filed plan gets its folder's tag. */
export function migrateLayoutV1(v1) {
  const out = EMPTY_LAYOUT();
  const folders = v1 && v1.folders && typeof v1.folders === "object" ? v1.folders : {};
  for (const [fid, f] of Object.entries(folders)) if (f && typeof f === "object" && TID_RE.test(fid)) out.tags[fid] = { name: String(f.name || "Untitled"), createdAt: String(f.createdAt || "") };
  for (const [key, fid] of Object.entries(v1 && v1.plans && typeof v1.plans === "object" ? v1.plans : {})) if (KEY_RE.test(key) && typeof fid === "string" && out.tags[fid]) out.plans[key] = [fid];
  return out;
}
export function readLayout(path = layoutPath()) {
  const v = readJson(path, null);
  if (!v || typeof v !== "object") return EMPTY_LAYOUT();
  if (!v.version && v.folders) {
    const migrated = migrateLayoutV1(v);
    try { writeFileSync(`${path}.v1.bak`, JSON.stringify(v, null, 2)); writeLayout(migrated, path); } catch { /* read-only: serve the migrated view anyway */ }
    return migrated;
  }
  const out = EMPTY_LAYOUT();
  for (const [tid, t] of Object.entries(v.tags && typeof v.tags === "object" ? v.tags : {})) if (t && typeof t === "object" && TID_RE.test(tid)) out.tags[tid] = { name: String(t.name || "Untitled"), createdAt: String(t.createdAt || "") };
  for (const [key, list] of Object.entries(v.plans && typeof v.plans === "object" ? v.plans : {})) { if (!KEY_RE.test(key)) continue; const tids = [...new Set((Array.isArray(list) ? list : [list]).filter((t) => typeof t === "string" && out.tags[t]))]; if (tids.length) out.plans[key] = tids; }
  out.projectOrder = Array.isArray(v.projectOrder) ? [...new Set(v.projectOrder.filter((x) => typeof x === "string" && x))] : [];
  for (const [project, keys] of Object.entries(v.planOrder && typeof v.planOrder === "object" ? v.planOrder : {})) if (Array.isArray(keys)) out.planOrder[project] = [...new Set(keys.filter((k) => KEY_RE.test(k)))];
  out.updatedAt = String(v.updatedAt || "");
  return out;
}
export function writeLayout(layout, path = layoutPath()) {
  const out = { version: 2, tags: layout.tags || {}, plans: layout.plans || {}, projectOrder: layout.projectOrder || [], planOrder: layout.planOrder || {}, updatedAt: new Date().toISOString() };
  writeJsonAtomic(path, out);
  return out;
}
const newTid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const cleanName = (name) => String(name || "").replace(/\s+/g, " ").trim().slice(0, 80);
export function createTag(name, path = layoutPath()) {
  const layout = readLayout(path);
  const n = cleanName(name); if (!n) throw new Error("a tag needs a name");
  const dup = Object.entries(layout.tags).find(([, t]) => t.name.toLowerCase() === n.toLowerCase());
  if (dup) return { tid: dup[0], layout, existed: true };
  const tid = newTid();
  layout.tags[tid] = { name: n, createdAt: new Date().toISOString() };
  writeLayout(layout, path);
  return { tid, layout, existed: false };
}
export function renameTag(tid, name, path = layoutPath()) {
  const layout = readLayout(path);
  if (!layout.tags[tid]) throw new Error("no such tag");
  const n = cleanName(name); if (!n) throw new Error("a tag needs a name");
  layout.tags[tid].name = n;
  return writeLayout(layout, path);
}
/** Delete a tag: it comes off every plan; nothing else changes. */
export function deleteTag(tid, path = layoutPath()) {
  const layout = readLayout(path);
  if (!layout.tags[tid]) throw new Error("no such tag");
  delete layout.tags[tid];
  for (const [key, list] of Object.entries(layout.plans)) { const rest = list.filter((t) => t !== tid); if (rest.length) layout.plans[key] = rest; else delete layout.plans[key]; }
  return writeLayout(layout, path);
}
/** Put a tag on a plan (on = true) or take it off (on = false). */
export function tagPlan(key, tid, on = true, path = layoutPath()) {
  const layout = readLayout(path);
  if (!KEY_RE.test(String(key))) throw new Error("bad plan key");
  if (!layout.tags[tid]) throw new Error("no such tag");
  const cur = layout.plans[key] || [];
  const next = on ? [...new Set([...cur, tid])] : cur.filter((t) => t !== tid);
  if (next.length) layout.plans[key] = next; else delete layout.plans[key];
  return writeLayout(layout, path);
}
/** The sidebar's project order (names the page knows; unknown names are kept so a project that is empty today keeps its place). */
export function setProjectOrder(names, path = layoutPath()) {
  const layout = readLayout(path);
  layout.projectOrder = [...new Set((Array.isArray(names) ? names : []).map((x) => cleanName(x)).filter(Boolean))];
  return writeLayout(layout, path);
}
/** The order of plans inside one project's list. */
export function setPlanOrder(project, keys, path = layoutPath()) {
  const layout = readLayout(path);
  const p = cleanName(project); if (!p) throw new Error("a project name is needed");
  const list = [...new Set((Array.isArray(keys) ? keys : []).filter((k) => KEY_RE.test(String(k))))];
  if (list.length) layout.planOrder[p] = list; else delete layout.planOrder[p];
  return writeLayout(layout, path);
}
/** [{id, name}] of a plan's tags, by name. */
export function tagsOf(layout, key) {
  return (layout.plans[key] || []).filter((t) => layout.tags[t]).map((t) => ({ id: t, name: layout.tags[t].name })).sort((a, b) => a.name.localeCompare(b.name));
}
/** Tags as a list for the sidebar and menus: [{id, name, count}] by name; count = plans among `keys` (or every plan in the file). */
export function tagList(layout, keys = null) {
  const counts = {};
  for (const [key, list] of Object.entries(layout.plans)) { if (keys && !keys.has(key)) continue; for (const t of list) counts[t] = (counts[t] || 0) + 1; }
  return Object.entries(layout.tags).map(([id, t]) => ({ id, name: t.name, count: counts[id] || 0 })).sort((a, b) => a.name.localeCompare(b.name));
}
/** `items` in the remembered order: those named in `order` first (in that order), the rest as given. */
export function applyOrder(items, order, keyOf = (x) => x) {
  const rank = new Map((order || []).map((k, i) => [k, i]));
  return items.map((x, i) => [x, rank.has(keyOf(x)) ? rank.get(keyOf(x)) : order.length + i]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
}

/* ── versions: snapshots of the artifact file ────────────────────────────── */
export const versionsDir = (key) => join(stateDir, "versions", key);
export const versionPath = (key, n) => join(versionsDir(key), `v${pad4(n)}.html`);
export function readVersionIndex(key) {
  const v = readJson(join(versionsDir(key), "index.json"), { versions: [] });
  return { file: v.file || "", versions: Array.isArray(v.versions) ? v.versions : [] };
}
export const MAX_VERSIONS = 200;
/** Save a copy of `file` when its content differs from the latest snapshot. Returns {created, n}. */
export function snapshotVersion(file, key, { reason = "scan", label = "", round = null } = {}) {
  const html = readFileSync(file, "utf8");
  const digest = sha(html);
  const idx = readVersionIndex(key);
  const last = idx.versions[idx.versions.length - 1];
  if (last && last.sha === digest) {
    // Same content: still let a later, better-informed caller name it (label) or number its round.
    let touched = false;
    if (label && !last.label) { last.label = label; touched = true; }
    if (round != null && last.round == null) { last.round = round; touched = true; }
    if (touched) writeJsonAtomic(join(versionsDir(key), "index.json"), idx);
    return { created: false, n: last.n };
  }
  const n = last ? last.n + 1 : 1;
  mkdirSync(versionsDir(key), { recursive: true });
  writeFileSync(versionPath(key, n), html);
  idx.file = file;
  idx.versions.push({ n, at: new Date().toISOString(), sha: digest, bytes: Buffer.byteLength(html), lines: extractText(html).length, reason, label, round });
  while (idx.versions.length > MAX_VERSIONS) {
    const victim = idx.versions.splice(1, 1)[0]; // keep v1 (the original) and the newest ones
    try { unlinkSync(versionPath(key, victim.n)); } catch {}
  }
  writeJsonAtomic(join(versionsDir(key), "index.json"), idx);
  return { created: true, n };
}

/* ── visible text + line diff (no DOM needed) ─────────────────────────────── */
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", middot: "·", rarr: "→", larr: "←" };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") { const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(code) ? String.fromCodePoint(code) : m; }
    return Object.hasOwn(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
  });
}
/** The document as the reader sees it: one line per block, scripts/styles dropped. */
export function extractText(html) {
  const text = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|summary|details|blockquote|pre|td|th|dt|dd|figcaption|caption|label|form|table|ul|ol|header|footer|main|aside|nav)\s*>/gi, "\n")
    .replace(/<(p|div|li|h[1-6]|tr|section|article|summary|details|blockquote|pre|dt|dd|figcaption|form|table|ul|ol|header|footer|main|aside|nav)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}
/** Line diff → [{type: "same"|"add"|"del", text}]. LCS after trimming the common prefix/suffix. */
export function diffLines(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  const out = a.slice(0, start).map((text) => ({ type: "same", text }));
  const n = midA.length, m = midB.length;
  if (n && m && n * m <= 40_000_000) {
    const W = m + 1;
    const dp = new Uint16Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = midA[i] === midB[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { out.push({ type: "same", text: midA[i] }); i++; j++; }
      else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) out.push({ type: "del", text: midA[i++] });
      else out.push({ type: "add", text: midB[j++] });
    }
    while (i < n) out.push({ type: "del", text: midA[i++] });
    while (j < m) out.push({ type: "add", text: midB[j++] });
  } else {
    // Too large for an aligned diff: fall back to set membership (unordered but complete).
    const inB = new Set(midB), inA = new Set(midA);
    for (const t of midA) out.push({ type: inB.has(t) ? "same" : "del", text: t });
    for (const t of midB) if (!inA.has(t)) out.push({ type: "add", text: t });
  }
  for (const text of a.slice(endA)) out.push({ type: "same", text });
  return out;
}

/* ── artifact head metadata ───────────────────────────────────────────────── */
function unescapeHtml(s) { return decodeEntities(String(s ?? "")); }
/** Reads the first 64 KB: <title>, lavish:* meta tags, description, and a summary fallback (the lede / first paragraph). */
export function readHead(file, bytes = 65536) {
  try {
    const fd = openSync(file, "r"); const buf = Buffer.alloc(bytes); const n = readSync(fd, buf, 0, bytes, 0); closeSync(fd);
    const head = buf.toString("utf8", 0, n);
    const title = unescapeHtml((/<title>([^<]*)<\/title>/i.exec(head) || [])[1]?.trim());
    const meta = (name) => unescapeHtml((new RegExp(`<meta\\s+name=["']${name}["']\\s+content=["']([^"']*)["']`, "i").exec(head) || [])[1] || "");
    const list = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
    let summary = meta("lavish:summary") || meta("description");
    if (!summary) {
      const lede = /<p[^>]*class=["'][^"']*\blede\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(head) || /<h1[\s\S]*?<\/h1>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(head);
      if (lede) summary = extractText(lede[1]).join(" ");
    }
    if (summary.length > 260) summary = summary.slice(0, 257).replace(/\s+\S*$/, "") + "…";
    return {
      title, project: meta("lavish:project"), related: list(meta("lavish:related")), logo: meta("lavish:logo"),
      status: meta("lavish:status"), prs: list(meta("lavish:pr")).map((s) => Number(s.replace(/^#/, ""))).filter((x) => Number.isInteger(x) && x > 0),
      summary,
    };
  } catch { return { title: "", project: "", related: [], status: "", prs: [], summary: "" }; }
}

/* ── PR mentions in agent replies ─────────────────────────────────────────── */
/** "#529", "PR #530", "PR 531" → GitHub PR numbers. Plan slice labels like "PR3" (no #, < 3 digits) are ignored. */
export function extractPrMentions(texts) {
  const found = new Set();
  for (const t of texts) {
    const s = String(t || "");
    for (const m of s.matchAll(/\bPRs?\s*#?\s*(\d{3,5})\b/gi)) found.add(Number(m[1]));
    for (const m of s.matchAll(/(?<![\w/#])#(\d{3,5})\b/g)) found.add(Number(m[1]));
  }
  return found;
}

/* ── git ──────────────────────────────────────────────────────────────────── */
const gitCache = new Map();
const git = (cwd, args) => { const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 8000 }); return r.status === 0 ? r.stdout.trim() : ""; };
/** Repo root + GitHub web base for the file's directory. Cached for 10 minutes. */
export function gitInfo(file) {
  const dir = dirname(file);
  const hit = gitCache.get(dir);
  if (hit && Date.now() - hit.at < 600e3) return hit.value;
  let value = { root: "", remote: "", slug: "", webBase: "" };
  const root = existsSync(dir) ? git(dir, ["rev-parse", "--show-toplevel"]) : "";
  if (root) {
    const remote = git(root, ["config", "--get", "remote.origin.url"]);
    const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(remote);
    value = { root, remote, slug: m ? `${m[1]}/${m[2]}` : "", webBase: m ? `https://github.com/${m[1]}/${m[2]}` : "" };
  }
  gitCache.set(dir, { at: Date.now(), value });
  return value;
}
export function gitLogForFile(file, limit = 25) {
  const info = gitInfo(file);
  if (!info.root) return [];
  const out = git(info.root, ["log", `-n${limit}`, "--follow", "--date=iso-strict", "--format=%h%x09%ad%x09%s", "--", file]);
  return out ? out.split("\n").map((l) => { const [hash, date, ...rest] = l.split("\t"); return { hash, date, subject: rest.join("\t") }; }) : [];
}
export function gitStatusForFile(file) {
  const info = gitInfo(file);
  if (!info.root) return "";
  const s = git(info.root, ["status", "--porcelain", "--", file]);
  return s ? (s.startsWith("??") ? "untracked" : "modified") : "committed";
}

/* ── gh: PR state lookups ─────────────────────────────────────────────────── */
/** Returns {n, state, title, url, mergedAt} or {n, missing: true}; null when gh is unavailable. */
export async function ghPrView(slug, n) {
  const args=["pr", "view", String(n), "--repo", slug, "--json", "number,state,title,url,mergedAt,body,comments,statusCheckRollup"];
  const r=await new Promise(resolve=>execFile("gh",args,{encoding:"utf8",timeout:20000,maxBuffer:8e6,env:{...process.env,GH_PROMPT_DISABLED:"1",GH_NO_UPDATE_NOTIFIER:"1"}},(error,stdout,stderr)=>resolve({status:error?1:0,error:error?.code==='ENOENT'?error:null,stdout:stdout||'',stderr:stderr||''})));

  if (r.error) return null;
  if (r.status !== 0) return /Could not resolve|no pull requests found|not found/i.test(r.stderr) ? { n, missing: true } : null;
  try { const j = JSON.parse(r.stdout); return { n: j.number, state: String(j.state || "").toUpperCase(), title: j.title || "", url: j.url || "", mergedAt: j.mergedAt || "", links: extractLinks([j.url,j.body,...(j.comments||[]).map(c=>c.body),...(j.statusCheckRollup||[]).map(c=>c.targetUrl||c.detailsUrl)]) }; } catch { return null; }
}
