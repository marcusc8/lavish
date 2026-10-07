/* history.mjs — what the lavish history says about a checklist: ticks, notes, comments, outcomes, revisions.
 *
 * The history is ~/.lavish-axi/history/<key>.jsonl, written by lavish-poll (LAVISH_AXI_STATE_DIR overrides the
 * dir; <key> = sha256(realpath).slice(0, 16), the Lavish server's own key). Entries:
 *   {role:"user", kind:"annotation"|"message", tag, text (the comment), where (element text), selector, …}
 *   {role:"agent", kind:"reply", replyTo?: n, text}   — replyTo answers item n of the batch just delivered
 *
 * A "Send my checks" arrives as tag "review" whose text ends with a "Context data:" JSON block (the SDK folds the
 * queuePrompt data option into the prompt text): {kind:"checks", group, checks:[{id, works, note}], stars} or
 * {kind:"revisions", text}. The rebuild is a pure function of this file, so the agent's conventions are parsed
 * from its own replies (see references/revisions.md): "R1 → C2: text" lines split a revision; "R2 done: …"
 * closes one; an outcome starting with Fixed/Done marks a row fixed · rN.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import os from "node:os";
import { counters } from "./section.mjs";

export const stateDir = () => process.env.LAVISH_AXI_STATE_DIR || join(os.homedir(), ".lavish-axi");
export const keyOf = (absolutePath) => createHash("sha256").update(absolutePath).digest("hex").slice(0, 16);
export const historyPath = (key) => join(stateDir(), "history", `${key}.jsonl`);

export function readHistory(key) {
  const p = historyPath(key);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const CONTEXT = "\n\nContext data:\n";
export function parseContextData(text) {
  const s = String(text || "");
  const i = s.lastIndexOf(CONTEXT);
  if (i === -1) return { text: s.trim(), data: null };
  let data = null;
  try { data = JSON.parse(s.slice(i + CONTEXT.length)); } catch { data = null; }
  return { text: s.slice(0, i).trim(), data };
}

const stripRe = (t) => String(t || "").replace(/^\u21b3 Re \u201c[^\u201d]*\u201d:\s*/, "").trim();

/** User runs → batches {round, items:[{…entry, replies:[{round,text}]}], summary, agent:[{round,text,replyTo}]}.
 *  round follows Lavish's chip: the number of agent round summaries before the batch, plus one. */
export function batchesOf(entries) {
  const batches = [];
  let cur = null, summaries = 0;
  for (const e of entries) {
    if (e.role === "user") {
      if (!cur || cur.closed) { cur = { round: summaries + 1, items: [], summary: "", agent: [], closed: false }; batches.push(cur); }
      cur.items.push({ ...e, replies: [] });
    } else if (e.role === "agent") {
      if (e.replyTo == null) summaries++;
      if (!cur) continue;
      cur.closed = true;
      const text = stripRe(e.text);
      cur.agent.push({ round: cur.round, text, replyTo: e.replyTo ?? null });
      if (e.replyTo != null) { const it = cur.items[e.replyTo - 1]; if (it) it.replies.push({ round: cur.round, text }); }
      else cur.summary = String(e.text || "");
    }
  }
  return batches;
}

const ID_IN_SELECTOR = (slug) => new RegExp(`#rv-${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-([A-Z]+\\d+)\\b`);
const TOKEN = /\b([A-Z][A-Za-z0-9.-]*\d[a-z]{0,2})\b/;
/** The row a comment belongs to: the anchor selector's row id first, else the first id token in the element text. */
function matchRow(item, group, rowById) {
  const sel = String(item.selector || "");
  const m = ID_IN_SELECTOR(group.slug).exec(sel);
  if (m) return rowById.get(m[1]) || null;
  if (/#rv-|#review-checklist/.test(sel)) return null; // another group, the group header or the chrome (their text starts with the first row)
  const t = TOKEN.exec(String(item.where || ""));
  return t ? rowById.get(t[1]) || null : null;
}

/** "R1 → C2: text" / "R2: text" / "R3 - C1: text" lines; else inline "R1 (text), R2 (text)". */
export function splitRevisions(text, { lineOnly = false } = {}) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const m = /^\s*(R\d+)\s*(?:(?:→|->|-|—)\s*([A-Z]+\d+))?\s*[:—-]\s*(.+)$/.exec(line);
    if (m) out.push({ id: m[1], linked: m[2] || "", text: m[3].trim() });
  }
  if (!out.length && !lineOnly) for (const m of String(text || "").matchAll(/\b(R\d+)\s*\(([^)]+)\)/g)) out.push({ id: m[1], linked: "", text: m[2].trim() });
  return out;
}

const DONE_LINE = /^\s*(R\d+)\s+done\b\s*[:—-]?\s*(.*)$/i;
const FIXED = /^(fixed|done)\b/i;

/** Overlay the history on a model built from the manifest. Returns the same model, mutated. */
export function applyHistory(model, entries) {
  const batches = batchesOf(entries);
  model.batches = batches;
  model.rounds = batches.length;
  model.verdict = null;
  model.revisions = [];
  const revById = new Map();
  const revision = (id) => { if (!revById.has(id)) { const r = { id, linked: "", text: "", done: null, outcomes: [], comments: [] }; revById.set(id, r); model.revisions.push(r); } return revById.get(id); };

  for (const g of model.groups) {
    g.stars = null;
    g.comments = [];
    g.outcomes = [];
    const rowById = new Map(g.rows.map((r) => [r.id, r]));
    for (const r of g.rows) Object.assign(r, { works: false, comments: [], outcomes: [], fixedRound: null, reopenedRound: null });
    for (const b of batches) {
      for (const it of b.items) {
        const { data } = parseContextData(it.text);
        if (it.tag === "review" && data?.kind === "checks") {
          if (data.group !== g.id) continue;
          for (const c of data.checks || []) {
            const row = rowById.get(String(c.id));
            if (!row) continue;
            row.works = !!c.works;
            if (c.note) row.comments.push({ round: b.round, text: String(c.note), kind: "note" });
          }
          if (data.stars) g.stars = Number(data.stars) || null;
        } else if (it.tag === "review" || it.tag === "verdict") {
          continue;
        } else {
          const row = matchRow(it, g, rowById);
          if (!row) {
            // the n-th form in the section is the n-th group; a comment on it (or its header) is the group's
            const fm = /#review-checklist[^]*?form:nth-of-type\((\d+)\)/.exec(String(it.selector || ""));
            if (fm && model.groups[Number(fm[1]) - 1] === g && !/#rv-/.test(String(it.selector || ""))) {
              g.comments.push({ round: b.round, text: parseContextData(it.text).text });
              for (const rep of it.replies) g.outcomes.push({ round: rep.round, text: rep.text });
            }
            continue;
          }
          row.comments.push({ round: b.round, text: parseContextData(it.text).text, kind: "comment" });
          // a comment after a fix reopens the row until the next Fixed/Done reply
          if (row.fixedRound && b.round > row.fixedRound) { row.fixedRound = null; row.reopenedRound = b.round; }
          for (const rep of it.replies) {
            row.outcomes.push({ round: rep.round, text: rep.text });
            if (FIXED.test(rep.text)) { row.fixedRound = rep.round; row.reopenedRound = null; }
          }
        }
      }
    }
    g.counters = counters(g.rows);
  }

  for (const b of batches) {
    for (const it of b.items) {
      if (it.tag === "verdict") model.verdict = String(it.text || "").replace(/^Review verdict:\s*/i, "").trim() || null;
      const { data } = parseContextData(it.text);
      // R-lines in a reply create rows: any comment can carry asks, the revisions box also accepts the inline form
      const fromBox = it.tag === "review" && data?.kind === "revisions";
      if (fromBox || (it.tag !== "review" && it.tag !== "verdict")) for (const rep of it.replies) for (const s of splitRevisions(rep.text, { lineOnly: !fromBox })) Object.assign(revision(s.id), { linked: s.linked, text: s.text });
      const rm = /#rv-revisions-(R\d+)\b/.exec(String(it.selector || ""));
      if (rm) { const r = revision(rm[1]); r.comments.push({ round: b.round, text: parseContextData(it.text).text }); for (const rep of it.replies) r.outcomes.push({ round: rep.round, text: rep.text }); }
    }
    for (const ag of b.agent) for (const line of ag.text.split("\n")) {
      const m = DONE_LINE.exec(line);
      if (m && revById.has(m[1])) { const r = revById.get(m[1]); r.done = ag.round; if (m[2].trim()) r.outcomes.push({ round: ag.round, text: m[2].trim() }); }
    }
  }
  return model;
}
