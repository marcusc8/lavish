#!/usr/bin/env node
/* lavish-poll.mjs — `lavish-axi poll` with a durable transcript.
 *
 * Why: the Lavish server hands feedback to the agent and clears it in the same step
 * (takeFeedback sets prompts = []). Only typed messages survive in state.json; annotations,
 * decision-form answers and export sends are delivered once and then exist nowhere. This
 * wrapper talks to the same local HTTP API the CLI uses and appends every delivered item
 * (and every agent reply) to ~/.lavish-axi/history/<session-key>.jsonl BEFORE printing it.
 *
 * It also keeps the artifact's VERSION HISTORY: every poll / reply is a review-round boundary, so
 * before talking to the server it saves a copy of the file under ~/.lavish-axi/versions/<key>/ when
 * the content changed since the last snapshot (the home page lists, views, diffs and restores them).
 *
 * Usage (same shape as the CLI):
 *   lavish-poll <html-file> [--agent-reply "<text>"] [--timeout-ms <n>] [--label "<version label>"]
 * Prints a short receipt, then the full JSON the server returned (dom_snapshot included).
 */
import { realpathSync, mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { snapshotVersion, readHistory, roundOf, agentInfo, agentLabel, updateRegistry, readRegistry } from "./lavish-lib.mjs";

import { ensureChats, claimChat, heartbeat, stopListening, mayDeliver } from "./lavish-chats.mjs";

import { sessionInfoOf } from "./lavish-agent.mjs";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? "" : String(args[i + 1] ?? ""); };
// --reply <n> "<text>" (repeatable): a threaded reply to item n of the LAST delivered batch (the receipt numbering).
const replies = [];
for (let i = 0; i < args.length; i++) if (args[i] === "--reply") replies.push({ n: Number(args[i + 1]), text: String(args[i + 2] ?? "") });
const valueSlots = new Set();
for (let i = 0; i < args.length; i++) {
  if (["--agent-reply", "--timeout-ms", "--label", "--chat"].includes(args[i])) valueSlots.add(i + 1);
  if (args[i] === "--reply") { valueSlots.add(i + 1); valueSlots.add(i + 2); }
}
const file = args.find((a, i) => !a.startsWith("--") && !valueSlots.has(i));
if (!file) die("usage: lavish-poll <html-file> [--agent-reply \"<text>\"] [--reply <n> \"<text>\"]... [--label \"<version label>\"] [--timeout-ms <n>]");
const absolute = realpathSync(resolve(file));
const key = createHash("sha256").update(absolute).digest("hex").slice(0, 16);
const stateDir = process.env.LAVISH_AXI_STATE_DIR || join(os.homedir(), ".lavish-axi");
const historyDir = join(stateDir, "history");
const historyPath = join(historyDir, `${key}.jsonl`);
const base = `http://127.0.0.1:${process.env.LAVISH_AXI_PORT || 4387}`;
const agentReply = flag("--agent-reply");
const timeoutMs = flag("--timeout-ms");

mkdirSync(historyDir, { recursive: true });
// Who is polling: the Claude session id every tool call carries (or the Codex thread matched by folder). Stamped on
// the plan's registry record so the home page can say which agent is on it, and on every history row.
const agent = agentInfo();
if(agent){const observed=sessionInfoOf(agent);if(observed.model){agent.model=observed.model;agent.modelObserved=true;}}
let owner={};
if(agent?.id){
 try{ensureChats(key,readRegistry()[key]||{},readHistory(key));owner=claimChat(key,agent,flag('--chat'));}catch(e){die(`lavish-poll: ${e.message}`);}
}else if(flag('--chat'))die('lavish-poll: this chat requires an identifiable agent session');
const agentRow = agent ? { provider: agent.provider, id: agent.id } : null;
const record = (entry) => appendFileSync(historyPath, JSON.stringify({ at: new Date().toISOString(), key, file: absolute, ...(agentRow ? { agent: agentRow } : {}), ...(owner.chatId?{chatId:owner.chatId}:{}), ...entry }) + "\n");
let sessionChanged = "";
if (agent) {
  try { updateRegistry(key, { file: absolute, agent: { ...agent, source: "poll" } }); } catch (e) { console.warn(`lavish-poll: agent stamp skipped (${e.message})`); }
  const prev = [...readHistory(key)].reverse().find((h) => h.agent && h.agent.id);
  if (prev && prev.agent.id !== agent.id) sessionChanged = `session changed: now ${agentLabel(agent)} \u00b7 ${agent.provider}`;
} else console.warn("lavish-poll: no agent id in this environment (not a Claude Code tool call, and no live Codex thread for this folder); the plan will not learn who is on it");

// Version history: a poll or reply closes a review round, so this is the moment to keep a copy of
// the artifact as the reviewer is about to see it. No-op when the content is unchanged.
try {
  const round = roundOf(key) + (agentReply ? 1 : 0);
  const snap = snapshotVersion(absolute, key, { reason: agentReply ? "agent-reply" : "poll", label: flag("--label"), round });
  if (snap.created) console.log(`lavish-poll: saved version v${snap.n} of ${basename(absolute)} (round ${round}) → ${join(stateDir, "versions", key)}`);
} catch (e) { console.warn(`lavish-poll: version snapshot skipped (${e.message})`); }

// The server self-stops when idle. Feedback queued while it was up is still in state.json,
// so resume the session headlessly (no browser launch) to bring the server back.
if (!(await healthy())) {
  const r = spawnSync("lavish-axi", [absolute, "--no-open"], { encoding: "utf8", env: { ...process.env, LAVISH_AXI_NO_OPEN: "1" } });
  if (r.status !== 0 || !(await healthy())) die(`Lavish server is not running and could not be started:\n${r.stdout}${r.stderr}`);
}

async function postReply(text) {
  const res = await fetch(`${base}/api/${key}/agent-reply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, ...owner }) });
  if (!res.ok) die(`agent-reply failed: HTTP ${res.status} ${await res.text()}`);
}
// Threaded replies go first, one per item, in the form the Comments rail recognises ("↳ Re “<start of the
// comment>”: <reply>"): the rail attaches each to the sent card whose text starts that way.
if (replies.length) {
  const history = readHistory(key);
  let end = history.length; while (end > 0 && history[end - 1].role !== "user") end--;
  let start = end; while (start > 0 && history[start - 1].role === "user") start--;
  const batch = history.slice(start, end);
  if (!batch.length) die("--reply: no delivered batch in the history to reply to");
  for (const r of replies) {
    const item = batch[r.n - 1];
    if (!item) die(`--reply ${r.n}: the last batch has ${batch.length} item(s)`);
    const quote = String(item.text || item.where || "").replace(/\s+/g, " ").trim();
    const text = `\u21b3 Re \u201c${quote.slice(0, 60)}${quote.length > 60 ? "\u2026" : ""}\u201d: ${r.text}`;
    await postReply(text);
    record({ role: "agent", kind: "reply", replyTo: r.n, text });
  }
}
if (sessionChanged) {
  // One boundary line in the chat, so the conversation panel shows where a new session took over.
  await postReply(sessionChanged);
  record({ role: "system", kind: "session", text: sessionChanged });
}
if (agentReply) {
  await postReply(agentReply);
  record({ role: "agent", kind: "reply", text: agentReply });
}

const aborter=new AbortController();
const pulse=()=>{if(!owner.chatId)return;try{if(!heartbeat(key,owner))aborter.abort(new Error('This chat was superseded by another connection'));}catch(e){if(!mayDeliver(key,owner))aborter.abort(e);}};
pulse();const pulseTimer=setInterval(pulse,5000);pulseTimer.unref();
process.on('exit',()=>{try{if(owner.chatId)stopListening(key,owner);}catch{}});
const url = `${base}/api/poll?file=${encodeURIComponent(absolute)}&chatId=${encodeURIComponent(owner.chatId||'')}&generation=${encodeURIComponent(owner.generation||'')}${timeoutMs ? `&timeoutMs=${encodeURIComponent(timeoutMs)}` : ""}`;
let response = null, lastErr = null;
for (let attempt = 0; attempt < 3 && !response; attempt++) {
  try {
    const res = await fetch(url,{signal:aborter.signal});
    const text = (await res.text()).trim(); // long-poll streams heartbeat spaces before the JSON
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    response = JSON.parse(text);
  } catch (e) { lastErr = e;if(aborter.signal.aborted)break; await new Promise((r) => setTimeout(r, 500)); }
}
clearInterval(pulseTimer);try{if(owner.chatId)stopListening(key,owner);}catch{}
if (!response) die(`poll failed after 3 attempts: ${lastErr?.message}`);

if(response.status === "superseded")die("This chat is no longer the active connection. Resume it from Lavish before polling again.");
if (response.status === "missing") die(`No Lavish session for ${absolute}. Run: lavish-axi "${absolute}"`);
if (response.status === "feedback") {
  const prompts = response.prompts || [];
  for (const p of prompts) {
    record({ role: "user", kind: p.tag === "message" ? "message" : "annotation", tag: p.tag || "", text: p.prompt || "", where: p.text || "", selector: p.selector || "", uid: p.uid || "", attachments: (p.attachments || []).map((a) => a.id), target: p.target });
  }
  if (response.session_ended) record({ role: "system", kind: "ended", text: `session ended by ${response.ended_by || "user"}` });
  const lines = prompts.map((p, i) => `  ${i + 1}. ${label(p)}: ${(p.prompt || "").replace(/\s+/g, " ").slice(0, 160)}`);
  console.log(`lavish-poll: received ${prompts.length} item(s) for ${basename(absolute)}  → history: ${historyPath}`);
  console.log(lines.join("\n"));
  if (response.artifact_failures?.length) console.log(`  ! ${response.artifact_failures.length} artifact failure(s) reported`);
  if (prompts.some((p) => p.tag === "suggestion")) console.log(`  ! suggestion(s): replace the element's current text (the quoted part) with the prompt text VERBATIM.`);
  console.log(response.session_ended
    ? `\nSESSION ENDED by ${response.ended_by || "user"}. Apply this last feedback, reply in the conversation, do not reopen uninvited.`
    : `\nNext: apply the feedback, then reply with\n  lavish-poll "${absolute}" --reply 1 "<answer to item 1>" ... --agent-reply "Got ${prompts.length} item(s): <one line each>. <what you changed>" --label "round N: <what changed>"`);
} else if (response.status === "ended") {
  record({ role: "system", kind: "ended", text: `session ended by ${response.ended_by || "user"}` });
  console.log(`lavish-poll: session already ended by ${response.ended_by || "user"}. Do not reopen uninvited.`);
} else {
  console.log(`lavish-poll: ${response.status} (no feedback within the timeout)`);
}
console.log("\n--- server response (JSON) ---");
console.log(JSON.stringify(response, null, 1));

function label(p) {
  const tag = p.tag || "";
  if (tag === "message") return "[message]";
  const where = (p.text || "").replace(/\s+/g, " ").trim();
  const semantic = /^(choice|export|review|note|whiteboard|layout-warnings|mermaid-node|suggestion|verdict)$/.test(tag);
  return (semantic ? `[${tag}]` : `[annotation on <${tag || "?"}>]`) + (where && where !== p.prompt ? ` “${where.slice(0, 60)}${where.length > 60 ? "…" : ""}”` : "");
}
async function healthy() { try { const r = await fetch(`${base}/health`); return r.ok; } catch { return false; } }
function die(m) { console.error(m); process.exit(1); }
