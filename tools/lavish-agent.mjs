/* lavish-agent.mjs — everything the home page knows about Claude / Codex sessions and terminals. Pure and testable:
 * every process call goes through an injectable `run(bin, args)` (default: execFile with a timeout), every filesystem
 * root is a parameter with a sensible default, and nothing here throws for a missing binary, a dead session or a
 * hostile string — those are values ({ok:false, error}).
 *
 * Copied from Manager Marcus (server/src/interact/{tmux,terminal,launch}.ts), same tmux names (mm-claude-<8>,
 * mm-codex-<8>) so the two tools cannot double-resume a session and Manager Marcus's terminal canvas can adopt what
 * this page starts.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync, readFileSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { readJson, writeJsonAtomic, stateDir, claudeSessionsDir, codexHome } from "./lavish-lib.mjs";

export const TMUX_BIN = "/usr/local/bin/tmux";
/** LAVISH_OSASCRIPT_BIN points a copy of the tools at a stub, so a check of the home's own path opens no Terminal window. */
export const OSASCRIPT_BIN = process.env.LAVISH_OSASCRIPT_BIN || "/usr/bin/osascript";
export const CLAUDE_BIN = join(os.homedir(), ".local/bin/claude");
export const CODEX_BIN = join(os.homedir(), ".local/bin/codex");
export const TMUX_PANE_COLS = 160, TMUX_PANE_ROWS = 48, TMUX_TIMEOUT_MS = 8000, TMUX_ENTER_DELAY_MS = 250;
/** The static table Manager Marcus also carries (server/src/constants.ts); the live lists come from ~/.lavish-axi/models.json (D7). */
export const LAUNCH_OPTIONS = {
  claude: { models: ["default", "fable", "opus", "sonnet", "haiku"], efforts: ["default", "low", "medium", "high", "xhigh", "max"] },
  codex: { models: ["default", "gpt-6-astra", "gpt-6-sol", "gpt-6-terra", "gpt-6-luna"], efforts: ["default", "low", "medium", "high", "xhigh"] },
};
export const terminalsPath = () => join(stateDir, "terminals.json");

/* ── models.json: the model lists Marcus edits (plan 2026-09-05, D7) ─────────── */
/* { claude: { models: [{id, name, full?}], efforts: [...] }, codex: { models: [{id, name}], efforts: [...] }, note }
 * `id` is what the CLI flag receives (claude --model fable · codex -m gpt-6-astra); `name` is what the page shows;
 * `full` is the id the transcript writes (claude-fable-5-1), so the Session column can name it. Seeded on first read;
 * a new model is one line in the file, not a code change. Free text stays accepted in every form. */
export const modelsPath = () => join(stateDir, "models.json");
export const DEFAULT_MODELS = {
  claude: { models: [
    { id: "fable", name: "Fable 5.1", full: "claude-fable-5-1" },
    { id: "opus", name: "Opus 5", full: "claude-opus-5" },
    { id: "sonnet", name: "Sonnet 5", full: "claude-sonnet-5" },
    { id: "haiku", name: "Haiku 4.5", full: "claude-haiku-4-5-20251001" },
  ], efforts: ["low", "medium", "high", "xhigh", "max"] },
  codex: { models: [
    { id: "gpt-6-astra", name: "GPT-6 Astra" },
    { id: "gpt-6-sol", name: "GPT-6 Sol" },
    { id: "gpt-6-terra", name: "GPT-6 Terra" },
    { id: "gpt-6-luna", name: "GPT-6 Luna" },
  ], efforts: ["low", "medium", "high", "xhigh"] },
  note: "Edit freely: the home page re-reads this file when it changes. The Claude 5.6 ids were unknown on 2026-09-05: add them as {id, name, full} lines under claude.models. Codex ids beyond gpt-6-astra are assumed (gpt-6-sol, -terra, -luna); correct them here if Codex refuses one.",
};
let modelsCache = { path: "", mtime: -1, value: null };
const cleanModel = (m) => (m && typeof m === "object" && String(m.id || "").trim() ? { id: String(m.id).trim(), name: String(m.name || m.id).trim(), ...(m.full ? { full: String(m.full).trim() } : {}) } : null);
/** The lists, validated, seeded when the file is missing, cached by the file's mtime. Never throws. */
export function readModels(path = modelsPath()) {
  let mtime = -1;
  try { mtime = statSync(path).mtimeMs; } catch { try { writeJsonAtomic(path, DEFAULT_MODELS); mtime = statSync(path).mtimeMs; } catch { /* unwritable: defaults */ } }
  if (modelsCache.path === path && modelsCache.mtime === mtime && modelsCache.value) return modelsCache.value;
  const raw = readJson(path, null) || {};
  const out = { note: String(raw.note || "") };
  for (const p of ["claude", "codex"]) {
    const r = raw[p] && typeof raw[p] === "object" ? raw[p] : {};
    const models = (Array.isArray(r.models) ? r.models : []).map(cleanModel).filter(Boolean);
    const efforts = (Array.isArray(r.efforts) ? r.efforts : []).map((e) => String(e || "").trim().toLowerCase()).filter((e) => /^[a-z]+$/.test(e));
    out[p] = { models: models.length ? models : DEFAULT_MODELS[p].models, efforts: efforts.length ? efforts : DEFAULT_MODELS[p].efforts };
  }
  modelsCache = { path, mtime, value: out };
  return out;
}
/** The LAUNCH_OPTIONS shape built from models.json ("default" first, ids only). */
export function launchOptions(models = readModels()) {
  return { claude: { models: ["default", ...models.claude.models.map((m) => m.id)], efforts: ["default", ...models.claude.efforts] }, codex: { models: ["default", ...models.codex.models.map((m) => m.id)], efforts: ["default", ...models.codex.efforts] } };
}
/** "Fable 5.1" for fable / claude-fable-5-1; the id itself when the file does not know it; "" for empty or default. */
export function modelName(id, models = readModels()) {
  const s = String(id || "").trim(); if (!s || s === "default") return "";
  const k = s.toLowerCase();
  for (const p of ["claude", "codex"]) for (const m of models[p].models) if (m.id.toLowerCase() === k || (m.full && m.full.toLowerCase() === k)) return m.name;
  return s;
}
/** "High", "XHigh", "Max": the effort word as the page shows it. */
export const effortName = (e) => { const s = String(e || "").trim(); if (!s || s === "default") return "Default"; return s === "xhigh" ? "XHigh" : s[0].toUpperCase() + s.slice(1); };

/* ── process seam ─────────────────────────────────────────────────────── */
/** {code, stdout, stderr}; a missing binary is code -1 with its message in stderr, a timeout is code -2. */
export function defaultRun(bin, args, { timeoutMs = TMUX_TIMEOUT_MS, env = process.env, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, env, cwd, maxBuffer: 8e6, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err && err.killed) return resolve({ code: -2, stdout: String(stdout || ""), stderr: `${bin} timed out` });
      if (err && err.code === "ENOENT") return resolve({ code: -1, stdout: "", stderr: `${bin} not found` });
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || (err ? err.message : "")) });
    });
  });
}
const lastLine = (s) => String(s || "").trim().split("\n").filter(Boolean).pop() || "";
const toResult = (r) => (r.code === 0 ? { ok: true } : { ok: false, error: lastLine(r.stderr) || `exit ${r.code}` });
const realpathOr = (p) => { try { return realpathSync(p); } catch { return p; } };
/** The env the CLIs and tmux are spawned with: ~/.local/bin on PATH (launchd lacks it), no CLAUDE* inherited from this process. */
export function childEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith("CLAUDE") && !["CODEX_THREAD_ID","CODEX_SESSION_ID"].includes(k)) out[k] = v;
  out.PATH = `${join(os.homedir(), ".local/bin")}:/usr/local/bin:${env.PATH || "/usr/bin:/bin"}`;
  return out;
}

/* ── names and argv ───────────────────────────────────────────────────── */
/** mm-<provider>-<first 8 alphanumerics of the id>. Not unique by construction: a collision surfaces as tmux's "duplicate session". */
export const tmuxName = (provider, id) => `mm-${provider === "codex" ? "codex" : "claude"}-${String(id).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8)}`;
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const flag = (name, v) => (v && v !== "default" ? [name, String(v)] : []);
/** A model id for the CLI flag: a listed id, or free text that looks like one (D7 keeps free text for both providers). */
const okModel = (provider, m) => { const s = String(m || "").trim(); if (!s || s === "default") return ""; return /^[\w.\-:]+$/.test(s) ? s : ""; };
const okEffort = (provider, e) => (launchOptions()[provider === "codex" ? "codex" : "claude"].efforts.includes(String(e || "")) && e !== "default" ? String(e) : "");
export function claudeResumeArgv(bin, id, { model, effort, prompt } = {}) { return [bin, "--resume", String(id), ...flag("--model", okModel("claude", model)), ...flag("--effort", okEffort("claude", effort)), ...(prompt ? ["--", String(prompt)] : [])]; }
export function claudeNewArgv(bin, { sessionId, model, effort, prompt }) { return [bin, "--session-id", String(sessionId), ...flag("--model", okModel("claude", model)), ...flag("--effort", okEffort("claude", effort)), "--", String(prompt || "")]; }
export function codexResumeArgv(bin, id, { model, effort, prompt } = {}) { const e = okEffort("codex", effort); return [bin, "resume", String(id), ...flag("-m", okModel("codex", model)), ...(e ? ["-c", `model_reasoning_effort="${e}"`] : []), ...(prompt ? [String(prompt)] : [])]; }
export function codexNewArgv(bin, { cwd, model, effort, prompt }) { const e = okEffort("codex", effort); return [bin, "-C", String(cwd), ...flag("-m", okModel("codex", model)), ...(e ? ["-c", `model_reasoning_effort="${e}"`] : []), String(prompt || "")]; }
/** The first prompt of a New session: open the plan in Lavish and poll it, so the session is connected before Marcus types. */
export const defaultNewPrompt = (planPath) => `Open the plan ${planPath} in Lavish (lavish-axi "${planPath}"), then poll it with lavish-poll (never lavish-axi poll) from this session so the home page links this session to the plan. Read the plan first; say what it decides and where it stands before doing anything else.`;

/* ── liveness ─────────────────────────────────────────────────────────── */
export const pidAlive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e && e.code === "EPERM"; } };
/** Claude sessions whose process is alive, from ~/.claude/sessions/<pid>.json (stale files of dead processes are skipped). */
export function liveClaudeSessions(dir = claudeSessionsDir(), isAlive = pidAlive) {
  const out = [];
  let names = []; try { names = readdirSync(dir); } catch { return out; }
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    const j = readJson(join(dir, f), null);
    if (!j || !j.sessionId || !j.pid || !isAlive(j.pid)) continue;
    out.push({ pid: Number(j.pid), sessionId: String(j.sessionId), name: String(j.name || ""), entrypoint: String(j.entrypoint || ""), cwd: String(j.cwd || ""), startedAt: j.startedAt || null, tmux: String(j.tmux || ""), status: String(j.status || "") });
  }
  return out;
}
/** Codex threads currently held open by a writer (the desktop app or a CLI): the ids with a lock file. */
export function liveCodexThreads(home = codexHome()) {
  const out = new Set();
  let names = []; try { names = readdirSync(join(home, "thread-writer-locks")); } catch { return out; }
  for (const f of names) if (f.endsWith(".lock")) out.add(f.slice(0, -5));
  return out;
}
export const ENTRYPOINT_LABEL = { "claude-vscode": "VS Code", "claude-cursor": "Cursor", "claude-desktop": "Desktop", cli: "terminal", codex: "Codex", "": "" };
/**
 * none | active | ended, plus where it lives. `live` = { claude: liveClaudeSessions(), codex: liveCodexThreads() },
 * `tmuxNames` = listTmux(). A live Claude session in tmux reports `terminal: true` (and its tmux name); an ended
 * session's tmux name is what Resume would create.
 */
export function agentState(reg, live, tmuxNames = new Set()) {
  const a = reg && reg.agent;
  if (!a || !a.id) return { state: "none", provider: "", id: "", name: "", entrypoint: "", cwd: "", terminal: false, tmuxName: "", source: "", at: "", guessed: false, status: "" };
  const provider = a.provider === "codex" ? "codex" : "claude";
  const name = tmuxName(provider, a.id);
  let alive = false, entrypoint = String(a.entrypoint || ""), status = "", tmuxOf = "", liveName = "";
  if (provider === "claude") {
    const l = (live?.claude || []).find((x) => x.sessionId === a.id);
    if (l) { alive = true; entrypoint = l.entrypoint || entrypoint; status = l.status; tmuxOf = l.tmux ? l.tmux.split(":")[0] : ""; liveName = l.name || ""; }
  } else alive = Boolean(live?.codex && live.codex.has(a.id));
  const inTmux = tmuxNames.has(name) || (tmuxOf && tmuxNames.has(tmuxOf));
  return {
    state: alive ? "active" : "ended", provider, id: a.id, name: liveName || a.name || String(a.id).replace(/[^a-z0-9]/gi, "").slice(0, 8),
    entrypoint, entrypointLabel: ENTRYPOINT_LABEL[entrypoint] ?? entrypoint, cwd: a.cwd || "", terminal: Boolean(alive && inTmux), tmuxName: tmuxOf && tmuxNames.has(tmuxOf) ? tmuxOf : name,
    source: a.source || "poll", at: a.at || "", guessed: Boolean(a.guessed), status,
  };
}
/**
 * What Resume should do, as a value (section 4's tree + the "Errors Connect shows" table). Never a silent no-op.
 *   {action: "refuse", error}          nothing spawned; the page names the reason
 *   {action: "activate"}               live in tmux with a client attached: bring Terminal.app forward, open Lavish
 *   {action: "attach"}                 live in tmux, nothing attached: open a Terminal window on it, open Lavish
 *   {action: "lavish"}                 live in an editor or Desktop: open Lavish only (that process already owns the transcript)
 *   {action: "resume"}                 ended: tmux new-session with --resume / codex resume, attach, open Lavish
 */
export function decideResume(st, { cwdExists = true, clients = [], appName = "" } = {}) {
  if (!st || st.state === "none") return { action: "refuse", error: "No agent has polled this plan yet. Start a New session (it opens the plan and polls it), or run lavish-poll from the session that is working on it." };
  if (st.state === "active") {
    if (st.terminal) return clients.length ? { action: "activate" } : { action: "attach" };
    if (st.provider === "codex") return { action: "refuse", error: `Codex thread ${st.name} is open in the Codex app; close it there or start a New session.` };
    const where = st.entrypointLabel || appName || "another process";
    // D3: that process owns the transcript. Open the plan in Lavish only; say so; spawn nothing.
    return { action: "lavish", note: `Session ${st.name} is live in ${where}. Nothing was started (a second writer would corrupt its transcript): type to it there, or start a New session.` };
  }
  if (!cwdExists) return { action: "refuse", error: `Folder missing: ${st.cwd}. Resume needs it; start a New session in another folder.` };
  return { action: "resume" };
}

/* ── tmux ─────────────────────────────────────────────────────────────── */
const tmux = (args, o = {}) => (o.run || defaultRun)(o.bin || TMUX_BIN, args, { timeoutMs: o.timeoutMs || TMUX_TIMEOUT_MS, env: childEnv(o.env || process.env) });
export async function hasTmux(o = {}) { return (await tmux(["-V"], o)).code === 0; }
/** Unset every CLAUDE* variable in the tmux SERVER's global environment (what every new pane inherits). No server = nothing to scrub. */
export async function scrubClaudeEnv(o = {}) {
  const r = await tmux(["show-environment", "-g"], o);
  if (r.code !== 0) return [];
  const scrubbed = [];
  for (const line of r.stdout.split("\n")) {
    if (!line || line.startsWith("-")) continue;
    const name = line.slice(0, line.indexOf("=") === -1 ? line.length : line.indexOf("="));
    if (name.startsWith("CLAUDE") || ["CODEX_THREAD_ID","CODEX_SESSION_ID"].includes(name)) { await tmux(["set-environment", "-g", "-u", name], o); scrubbed.push(name); }
  }
  return scrubbed;
}
/** A detached session running argv in cwd, sized so capture-pane does not wrap. Ends when the command exits. */
export async function newTmuxSession(name, cwd, argv, o = {}) {
  await scrubClaudeEnv(o);
  const command = argv.map(shellQuote).join(" ");
  return toResult(await tmux(["new-session", "-d", "-s", name, "-x", String(TMUX_PANE_COLS), "-y", String(TMUX_PANE_ROWS), "-c", cwd, command], o));
}
export async function listTmux(o = {}) {
  const r = await tmux(["list-sessions", "-F", "#S"], o);
  return r.code === 0 ? new Set(r.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) : new Set();
}
/** Client ttys attached to the session; empty when nothing is attached, the session is gone, or there is no server. */
export async function listClients(name, o = {}) {
  const r = await tmux(["list-clients", "-t", `=${name}`, "-F", "#{client_tty}"], o);
  return r.code === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}
/** Type text and submit it: a named buffer, a bracketed paste (one block, so newlines do not submit early), then Enter after a short delay. */
export async function sendText(name, text, o = {}) {
  const set = await tmux(["set-buffer", "-b", name, "--", text], o);
  if (set.code !== 0) return toResult(set);
  const paste = await tmux(["paste-buffer", "-p", "-d", "-b", name, "-t", `=${name}:`], o);
  if (paste.code !== 0) return toResult(paste);
  await new Promise((r) => setTimeout(r, o.enterDelayMs ?? TMUX_ENTER_DELAY_MS));
  return toResult(await tmux(["send-keys", "-t", `=${name}:`, "Enter"], o));
}
/** The last `lines` lines of the pane, or null when the session is gone. */
export async function capturePane(name, lines = 12, o = {}) {
  const r = await tmux(["capture-pane", "-p", "-J", "-t", `=${name}:`, "-S", `-${lines}`], o);
  return r.code === 0 ? r.stdout : null;
}
/** Idle = the CLI is waiting at its prompt: one of the last lines is the prompt row ("❯ …" or "> …" in Claude Code's box; "›" for Codex). */
export function paneIdle(text) {
  if (text == null) return false;
  const lines = String(text).split("\n").map((l) => l.replace(/\s+$/, "")).filter(Boolean).slice(-8);
  return lines.some((l) => /^\s*[❯›>](\s|$)/.test(l));
}

/* ── Terminal.app ─────────────────────────────────────────────────────── */
const NAME_RE = /^[a-z0-9-]+$/;
/** osascript argv: activate Terminal.app and open a window attached to the exact session. The single quotes around =name defeat zsh's =word expansion. */
export function attachScript(name, tmuxBin = TMUX_BIN) {
  if (!NAME_RE.test(name)) throw new Error(`bad tmux session name: ${name}`);
  return ["-e", 'tell application "Terminal"', "-e", "activate", "-e", `do script "${tmuxBin} attach -t '=${name}'"`, "-e", "end tell"];
}
export async function attachTerminal(name, o = {}) {
  let args; try { args = attachScript(name, o.tmuxBin || TMUX_BIN); } catch (e) { return { ok: false, error: e.message }; }
  const r = await (o.run || defaultRun)(o.osascriptBin || OSASCRIPT_BIN, args, { timeoutMs: o.timeoutMs || TMUX_TIMEOUT_MS });
  return r.code === 0 ? { ok: true } : { ok: false, error: lastLine(r.stderr) || `exit ${r.code}` };
}
/** Bring Terminal.app forward without opening a window (a client is already attached). */
export async function activateTerminal(o = {}) {
  const r = await (o.run || defaultRun)(o.osascriptBin || OSASCRIPT_BIN, ["-e", 'tell application "Terminal" to activate'], { timeoutMs: o.timeoutMs || TMUX_TIMEOUT_MS });
  return r.code === 0 ? { ok: true } : { ok: false, error: lastLine(r.stderr) || `exit ${r.code}` };
}

/* ── terminals.json: what this page started, in Manager Marcus's row shape ── */
export function readTerminals(path = terminalsPath()) { const v = readJson(path, { terminals: [] }); return Array.isArray(v.terminals) ? v.terminals : []; }
export function recordTerminal(row, path = terminalsPath()) {
  const rows = readTerminals(path).filter((t) => t.tmuxName !== row.tmuxName);
  rows.unshift({ tmuxName: row.tmuxName, provider: row.provider, sessionId: row.sessionId || null, cwd: row.cwd, createdAt: row.createdAt || Date.now(), ...(row.model ? { model: row.model } : {}), ...(row.effort ? { effort: row.effort } : {}), ...(row.planKey ? { planKey: row.planKey } : {}), startedBy: "lavish-home" });
  writeJsonAtomic(path, { terminals: rows.slice(0, 200), updatedAt: new Date().toISOString() });
  return rows[0];
}

/* ── the whole Resume / New session flow, over injected runners ──────────── */
/**
 * Resume the plan's agent per decideResume. Returns {ok, action, tmuxName, error?, terminalError?, lavish: true}.
 * `deps`: { run, claudeBin, codexBin, tmuxBin, osascriptBin, live, tmuxNames, clients(name) } — all optional.
 */
export async function resumeAgent(reg, planKey, { model, effort, prompt } = {}, deps = {}) {
  const live = deps.live || { claude: liveClaudeSessions(), codex: liveCodexThreads() };
  const tmuxNames = deps.tmuxNames || await listTmux(deps);
  const st = agentState(reg, live, tmuxNames);
  const clients = st.state === "active" && st.terminal ? await (deps.clients ? deps.clients(st.tmuxName) : listClients(st.tmuxName, deps)) : [];
  const d = decideResume(st, { cwdExists: st.cwd ? existsSync(st.cwd) : false, clients });
  if (d.action === "refuse") return { ok: false, action: d.action, error: d.error, state: st };
  if (d.action === "activate") { const r = await activateTerminal(deps); return { ok: true, action: d.action, tmuxName: st.tmuxName, state: st, ...(r.ok ? {} : { terminalError: r.error }) }; }
  if (d.action === "attach") { const r = await attachTerminal(st.tmuxName, deps); return { ok: true, action: d.action, tmuxName: st.tmuxName, state: st, ...(r.ok ? {} : { terminalError: r.error }) }; }
  if (d.action === "lavish") return { ok: true, action: d.action, state: st, note: d.note };
  // resume: a new tmux session running the CLI's own resume, in the transcript's cwd
  const bin = st.provider === "codex" ? (deps.codexBin || CODEX_BIN) : (deps.claudeBin || CLAUDE_BIN);
  if (!existsSync(bin)) return { ok: false, action: "resume", error: `${basename(bin)} not found in ${join(os.homedir(), ".local/bin")}`, state: st };
  if (!(await hasTmux(deps))) return { ok: false, action: "resume", error: `tmux not found at ${deps.tmuxBin || deps.bin || TMUX_BIN}`, state: st };
  const argv = st.provider === "codex" ? codexResumeArgv(bin, st.id, { model, effort, prompt }) : claudeResumeArgv(bin, st.id, { model, effort, prompt });
  const started = await newTmuxSession(st.tmuxName, realpathOr(st.cwd), argv, deps);
  if (!started.ok) {
    if (/duplicate session/i.test(started.error)) { const r = await activateTerminal(deps); return { ok: true, action: "activate", tmuxName: st.tmuxName, state: st, note: `already running in terminal ${st.tmuxName}`, ...(r.ok ? {} : { terminalError: r.error }) }; }
    return { ok: false, action: "resume", error: started.error, state: st };
  }
  recordTerminal({ tmuxName: st.tmuxName, provider: st.provider, sessionId: st.id, cwd: realpathOr(st.cwd), model: okModel(st.provider, model), effort: okEffort(st.provider, effort), planKey }, deps.terminalsPath);
  const opened = await attachTerminal(st.tmuxName, deps);
  return { ok: true, action: "resume", tmuxName: st.tmuxName, state: st, ...(opened.ok ? {} : { terminalError: opened.error }) };
}
/** Start a NEW session in tmux with a prompt that opens and polls the plan. Claude gets a chosen UUID (stamped as the agent at once); Codex's id is matched later by folder. */
export async function startNewAgent({ provider = "claude", cwd, planPath, planKey, model, effort, prompt }, deps = {}) {
  if (!cwd || !existsSync(cwd)) return { ok: false, error: `Folder missing: ${cwd || "(none)"}. New session needs a folder to start in.` };
  const p = provider === "codex" ? "codex" : "claude";
  const bin = p === "codex" ? (deps.codexBin || CODEX_BIN) : (deps.claudeBin || CLAUDE_BIN);
  if (!existsSync(bin)) return { ok: false, error: `${basename(bin)} not found in ${join(os.homedir(), ".local/bin")}` };
  if (!(await hasTmux(deps))) return { ok: false, error: `tmux not found at ${deps.tmuxBin || deps.bin || TMUX_BIN}` };
  const text = String(prompt || "").trim() || defaultNewPrompt(planPath);
  const sessionId = p === "claude" ? (deps.sessionId || randomUUID()) : null;
  const name = tmuxName(p, sessionId || (deps.now || Date.now()).toString(16).padStart(8, "0").slice(-8));
  const argv = p === "claude" ? claudeNewArgv(bin, { sessionId, model, effort, prompt: text }) : codexNewArgv(bin, { cwd: realpathOr(cwd), model, effort, prompt: text });
  const started = await newTmuxSession(name, realpathOr(cwd), argv, deps);
  if (!started.ok) return { ok: false, error: started.error };
  recordTerminal({ tmuxName: name, provider: p, sessionId, cwd: realpathOr(cwd), model: okModel(p, model), effort: okEffort(p, effort), planKey }, deps.terminalsPath);
  const opened = await attachTerminal(name, deps);
  return { ok: true, tmuxName: name, provider: p, sessionId, agent: sessionId ? { provider: "claude", id: sessionId, cwd: realpathOr(cwd), entrypoint: "cli", source: "home" } : null, ...(opened.ok ? {} : { terminalError: opened.error }) };
}

/* ── the model and the times of a session, from its transcript ──────────────── */
const infoCache = new Map(); // transcript file → { mtime, info }
/** ~/.claude/projects/<slug>/<id>.jsonl for a Claude record: its cwd's folder first, then any project folder. "" when absent. */
export function claudeTranscriptPath(rec, root = join(process.env.CLAUDE_CONFIG_DIR || join(os.homedir(), ".claude"), "projects")) {
  const id = String(rec?.id || ""); if (!/^[0-9a-f][0-9a-f-]{7,}$/i.test(id)) return "";
  if (rec.cwd) { const p = join(claudeProjectDir(rec.cwd, root), `${id}.jsonl`); if (existsSync(p)) return p; }
  for (const d of safeDir(root)) { const p = join(root, d, `${id}.jsonl`); if (existsSync(p)) return p; }
  return "";
}
/** The rollout file of a Codex thread (rollout-<stamp>-<id>.jsonl under sessions/Y/M/D), searched over the last `days` days. */
export function codexRolloutPath(id, { home = codexHome(), days = 90, now = Date.now() } = {}) {
  const want = `-${String(id || "").toLowerCase()}.jsonl`; if (want.length < 14) return "";
  const since = now - days * 864e5, root = join(home, "sessions");
  for (const y of safeDir(root).sort().reverse()) for (const mo of safeDir(join(root, y)).sort().reverse()) for (const d of safeDir(join(root, y, mo)).sort().reverse()) {
    const dayStamp = Date.parse(`${y}-${mo}-${d}T00:00:00Z`); if (Number.isFinite(dayStamp) && dayStamp < since - 864e5) continue;
    for (const f of safeDir(join(root, y, mo, d))) if (f.startsWith("rollout-") && f.toLowerCase().endsWith(want)) return join(root, y, mo, d, f);
  }
  return "";
}
function headText(file, bytes) { try { const fd = openSync(file, "r"); const buf = Buffer.alloc(bytes); const n = readSync(fd, buf, 0, bytes, 0); closeSync(fd); return buf.toString("utf8", 0, n); } catch { return ""; } }
function tailText(file, bytes) { const size = statSync(file).size; const start = Math.max(0, size - bytes); const fd = openSync(file, "r"); const buf = Buffer.alloc(size - start); readSync(fd, buf, 0, buf.length, start); closeSync(fd); return buf.toString("utf8"); }
/**
 * { model, startedAt, lastAt, file } for an agent record, read from its transcript and never from a guess:
 * Claude = the last assistant message.model in the tail of ~/.claude/projects/<slug>/<id>.jsonl, the first timestamp in the
 * file, the last timestamp in the tail; Codex = the rollout's session_meta (model, timestamp) and the file's mtime.
 * Cached by the file's mtime, so a transcript still being written is re-read on its next change. Never throws.
 */
export function sessionInfoOf(rec, opts = {}) {
  const none = { model: "", startedAt: "", lastAt: "", file: "" };
  try {
    if (!rec || !rec.id) return none;
    const provider = rec.provider === "codex" ? "codex" : "claude";
    const file = provider === "codex" ? codexRolloutPath(rec.id, opts.codex) : claudeTranscriptPath(rec, opts.projectsRoot);
    if (!file) return none;
    const mtime = statSync(file).mtimeMs;
    const hit = infoCache.get(file); if (hit && hit.mtime === mtime) return hit.info;
    let info;
    if (provider === "codex") {
      const head = headText(file, 65536).split("\n")[0];
      let meta = null; try { meta = JSON.parse(head); } catch {}
      const p = meta && meta.type === "session_meta" ? meta.payload || {} : {};
      let model = String(p.model || (p.turn_context && p.turn_context.model) || (/"model":"([^"]+)"/.exec(head) || [])[1] || "");
      for(const line of tailText(file,opts.tailBytes||262144).split("\n").reverse()){
        let row;try{row=JSON.parse(line);}catch{continue;}
        if(row.type==='turn_context'&&row.payload?.model){model=String(row.payload.model);break;}
      }
      info = { model, startedAt: String(p.timestamp || (meta && meta.timestamp) || ""), lastAt: new Date(mtime).toISOString(), file };
    } else {
      const startedAt = (/"timestamp":"([^"]+)"/.exec(headText(file, opts.headBytes || 65536)) || [])[1] || "";
      const lines = tailText(file, opts.tailBytes || 262144).split("\n").filter(Boolean);
      let model = "", lastAt = "";
      for (let i = lines.length - 1; i >= 0; i--) {
        let j; try { j = JSON.parse(lines[i]); } catch { continue; }
        if (!lastAt && j.timestamp) lastAt = String(j.timestamp);
        if (j.type === "assistant" && j.message && j.message.model) { model = String(j.message.model); break; }
      }
      info = { model, startedAt, lastAt: lastAt || new Date(mtime).toISOString(), file };
    }
    infoCache.set(file, { mtime, info });
    return info;
  } catch { return none; }
}

/* ── D11: the bounded transcript scan ────────────────────────────────────── */
/** ~/.claude/projects/<folder>: Claude Code encodes the cwd by replacing every non-alphanumeric with "-". */
export const claudeProjectDir = (cwd, root = join(process.env.CLAUDE_CONFIG_DIR || join(os.homedir(), ".claude"), "projects")) => join(root, String(cwd).replace(/[^A-Za-z0-9]/g, "-"));
const PATH_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
const pathMatches = (target, planPath) => { const t = String(target || ""); if (!t) return false; return t === planPath || t.endsWith("/" + basename(planPath)) && (planPath.endsWith(t) || t.endsWith(planPath) || t.startsWith("/") && realpathOr(t) === planPath); };
/** One transcript line → the session id + time when it is a Read/Edit/Write/NotebookEdit on the plan; a Bash mention does not count. */
export function scanLine(line, planPath) {
  if (!line.includes(basename(planPath))) return null;
  let j; try { j = JSON.parse(line); } catch { return null; }
  const content = j && j.message && Array.isArray(j.message.content) ? j.message.content : [];
  for (const c of content) {
    if (!c || c.type !== "tool_use" || !PATH_TOOLS.has(c.name)) continue;
    const target = c.input && (c.input.file_path || c.input.notebook_path || c.input.path);
    if (pathMatches(String(target || ""), planPath)) return { id: String(j.sessionId || ""), at: String(j.timestamp || ""), tool: c.name };
  }
  return null;
}
/**
 * Sessions that touched the plan through a path tool, bounded to the plan's Claude project folder, files modified in
 * the last `days` days, and a `grep -l` prefilter on the file name before any JSON is parsed. Newest first.
 * Codex rollouts of the same window are included by folder (session_meta.cwd inside projectCwd) + grep hit, marked guessed.
 */
export async function scanTranscripts(planPath, projectCwd, { days = 7, now = Date.now(), run = defaultRun, projectsRoot, codexRoot = codexHome(), grepBin = "/usr/bin/grep" } = {}) {
  const plan = realpathOr(planPath);
  const since = now - days * 864e5;
  const found = new Map();
  const dir = claudeProjectDir(projectCwd, projectsRoot);
  const candidates = [];
  try { for (const f of readdirSync(dir)) { if (!f.endsWith(".jsonl")) continue; const p = join(dir, f); try { if (statSync(p).mtimeMs >= since) candidates.push(p); } catch {} } } catch {}
  let hits = [];
  if (candidates.length) {
    const r = await run(grepBin, ["-l", "-F", "--", basename(plan), ...candidates], { timeoutMs: 20000 });
    hits = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  for (const file of hits) {
    let text; try { text = readFileSync(file, "utf8"); } catch { continue; }
    const fileId = basename(file, ".jsonl");
    for (const line of text.split("\n")) {
      const m = scanLine(line, plan); if (!m) continue;
      const id = m.id || fileId;
      const prev = found.get(id);
      if (!prev || m.at > prev.at) found.set(id, { provider: "claude", id, at: m.at, file, tool: m.tool });
    }
  }
  // Codex: rollouts in the window whose session_meta.cwd is the project (or inside it) and that mention the file name.
  const want = realpathOr(projectCwd);
  const rollouts = [];
  const sessRoot = join(codexRoot, "sessions");
  for (const y of safeDir(sessRoot)) for (const mo of safeDir(join(sessRoot, y))) for (const d of safeDir(join(sessRoot, y, mo))) {
    const dayStamp = Date.parse(`${y}-${mo}-${d}T00:00:00Z`); if (Number.isFinite(dayStamp) && dayStamp < since - 864e5) continue;
    for (const f of safeDir(join(sessRoot, y, mo, d))) { if (!f.startsWith("rollout-") || !f.endsWith(".jsonl")) continue; const p = join(sessRoot, y, mo, d, f); try { if (statSync(p).mtimeMs >= since) rollouts.push(p); } catch {} }
  }
  if (rollouts.length) {
    const r = await run(grepBin, ["-l", "-F", "--", basename(plan), ...rollouts], { timeoutMs: 20000 });
    for (const file of r.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
      let meta; try { meta = JSON.parse(headLine(file)); } catch { continue; }
      const p = meta && meta.type === "session_meta" ? meta.payload || {} : {};
      const cwd = realpathOr(String(p.cwd || ""));
      if (!p.id || !(cwd === want || cwd.startsWith(want + "/"))) continue;
      let at = ""; try { at = new Date(statSync(file).mtimeMs).toISOString(); } catch {}
      if (!found.has(p.id)) found.set(String(p.id), { provider: "codex", id: String(p.id), at, file, guessed: true });
    }
  }
  return [...found.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
/**
 * The hourly job: every plan of one project folder in a single pass (one grep with every file name, each hit file parsed
 * once). Returns { [planKey]: [{provider,id,at,file,tool?,guessed?}] }, each list newest first.
 */
export async function scanTranscriptsMany(plans, projectCwd, { days = 7, now = Date.now(), run = defaultRun, projectsRoot, codexRoot = codexHome(), grepBin = "/usr/bin/grep" } = {}) {
  const out = {}; const byBase = new Map();
  for (const p of plans) { const real = realpathOr(p.path); out[p.key] = []; byBase.set(basename(real), { key: p.key, path: real }); }
  if (!byBase.size) return out;
  const since = now - days * 864e5;
  const needles = [...byBase.keys()].flatMap((b) => ["-e", b]);
  const candidates = [];
  try { for (const f of readdirSync(claudeProjectDir(projectCwd, projectsRoot))) { if (!f.endsWith(".jsonl")) continue; const p = join(claudeProjectDir(projectCwd, projectsRoot), f); try { if (statSync(p).mtimeMs >= since) candidates.push(p); } catch {} } } catch {}
  const found = new Map(); // key → Map(id → rec)
  const put = (key, rec) => { if (!found.has(key)) found.set(key, new Map()); const m = found.get(key); const prev = m.get(rec.id); if (!prev || rec.at > prev.at) m.set(rec.id, rec); };
  if (candidates.length) {
    const r = await run(grepBin, ["-l", "-F", ...needles, "--", ...candidates], { timeoutMs: 30000 });
    for (const file of r.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
      let text; try { text = readFileSync(file, "utf8"); } catch { continue; }
      const fileId = basename(file, ".jsonl");
      for (const line of text.split("\n")) for (const [base, plan] of byBase) { if (!line.includes(base)) continue; const m = scanLine(line, plan.path); if (m) put(plan.key, { provider: "claude", id: m.id || fileId, at: m.at, file, tool: m.tool }); }
    }
  }
  const want = realpathOr(projectCwd); const rollouts = []; const sessRoot = join(codexRoot, "sessions");
  for (const y of safeDir(sessRoot)) for (const mo of safeDir(join(sessRoot, y))) for (const d of safeDir(join(sessRoot, y, mo))) {
    const dayStamp = Date.parse(`${y}-${mo}-${d}T00:00:00Z`); if (Number.isFinite(dayStamp) && dayStamp < since - 864e5) continue;
    for (const f of safeDir(join(sessRoot, y, mo, d))) { if (!f.startsWith("rollout-") || !f.endsWith(".jsonl")) continue; const p = join(sessRoot, y, mo, d, f); try { if (statSync(p).mtimeMs >= since) rollouts.push(p); } catch {} }
  }
  if (rollouts.length) {
    const r = await run(grepBin, ["-l", "-F", ...needles, "--", ...rollouts], { timeoutMs: 30000 });
    for (const file of r.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
      let meta; try { meta = JSON.parse(headLine(file)); } catch { continue; }
      const p = meta && meta.type === "session_meta" ? meta.payload || {} : {}; const cwd = realpathOr(String(p.cwd || ""));
      if (!p.id || !(cwd === want || cwd.startsWith(want + "/"))) continue;
      let text; try { text = readFileSync(file, "utf8"); } catch { continue; }
      let at = ""; try { at = new Date(statSync(file).mtimeMs).toISOString(); } catch {}
      for (const [base, plan] of byBase) if (text.includes(base) && !(found.get(plan.key) || new Map()).has(String(p.id))) put(plan.key, { provider: "codex", id: String(p.id), at, file, guessed: true });
    }
  }
  for (const [key, m] of found) out[key] = [...m.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return out;
}
function safeDir(p) { try { return readdirSync(p); } catch { return []; } }
function headLine(file, bytes = 4096) { try { const fd = openSync(file, "r"); const buf = Buffer.alloc(bytes); const n = readSync(fd, buf, 0, bytes, 0); closeSync(fd); return buf.toString("utf8", 0, n).split("\n")[0]; } catch { return ""; } }
