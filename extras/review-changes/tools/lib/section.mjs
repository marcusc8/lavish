/* section.mjs — the Review checklist section: model → HTML, and its place in a plan page.
 *
 * The section lives between <!-- review:begin --> and <!-- review:end -->, inserted before the plan's
 * Feedback log (the template's last section). Everything outside the markers is left byte-identical, so a
 * rebuild replaces only what the tool owns. The markup is the idiom of the lavish plan template
 * (details[data-sec] + summary.h) with its own rv- styles, because older plan pages do not share the
 * template's stylesheet. See references/checklist-section.html for the hand-built original.
 */
import { phrase } from "./manifest.mjs";

export const BEGIN = "<!-- review:begin -->";
export const END = "<!-- review:end -->";

export const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "group";
export const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const RESULT_STATUS = { pass: "verified", fail: "failed", blocked: "blocked", "not-run": "not-run" };

/** Absolute link for a where: http as is; a path or fragment against the group's base; else as typed. */
export function hrefFor(where, base = "") {
  const w = String(where || "").trim();
  if (!w) return base || "";
  if (/^https?:\/\//i.test(w)) return w;
  if (!base) return w;
  return base.replace(/\/$/, "") + (/^[/#?]/.test(w) ? w : "/" + w);
}

/** One group from one manifest. opts: group (title), branch, worktree, range, session, verified, link. */
export function modelFromManifest(manifest, opts = {}) {
  const h = manifest.header || {};
  const group = opts.group || h.group || "PR";
  const base = String(h.base || "").replace(/\/$/, "");
  const rows = (manifest.checks || []).map((c) => {
    const ph = phrase(c, h);
    const r = manifest.result?.[c.id];
    const labelled = /\b(where|do|expect)\s*:/i.test(c.text);
    return {
      id: c.id, slug: c.slug, human: !!c.human, agent: !!c.agent,
      priority: ph.priority || "", area: ph.area || "", test: ph.test || "",
      text: ph.test || (labelled ? ph.expect || c.text : c.text),
      where: ph.where, do: ph.do, expect: labelled || c.text.includes("→") ? ph.expect : "",
      whereHref: hrefFor(ph.where, base),
      status: r ? RESULT_STATUS[r.status] || "not-run" : "not-run",
      blockedBy: r?.blockedBy || "", resultNote: r?.note || "",
      // The screenshot the run took for this row (a path relative to the manifest); the RESULT line's wins over the
      // check row's. The build resolves it to shotHref (relative to the page) after copying the file beside the plan.
      shot: r?.shot || ph.shot || "", shotHref: "", shotMissing: false,
      works: false, yourNote: "", comments: [], outcomes: [], fixedRound: null,
    };
  });
  const g = {
    id: group, slug: slugify(group), title: opts.title || group, manifest: opts.manifest || "",
    link: opts.link || h.preview || base || h.route || "",
    branch: opts.branch || h.branch || "", worktree: opts.worktree || h.worktree || "", range: opts.range || h.range || "",
    session: opts.session || h.session || "", verified: opts.verified || h.verified || "",
    writes: h.writes && !/^\(none\)/i.test(h.writes) ? h.writes : "",
    rows, grade: null, rounds: 0, stars: null,
    table: rows.some((r) => r.test), // the 2026-09-02 table style: header row + columns
  };
  g.counters = counters(rows);
  return { groups: [g], revisions: [] };
}

export function counters(rows) {
  const works = rows.filter((r) => r.works).length;
  const verified = rows.filter((r) => r.status === "verified").length;
  // agent-only rows are the agent's to run: they never "need you"
  return { works, total: rows.length, verified, needYou: rows.filter((r) => !r.works && r.status !== "verified" && !r.agent).length };
}

/* ── render ─────────────────────────────────────────────────────────────── */
const STYLE = `<style>
  /* Review checklist (review-changes skill). Self-contained: template variables with fallbacks, so the
     section renders the same inside a plan-template page and inside an older plan page. */
  .rv { font-family: "Avenir Next", "Helvetica Neue", "Segoe UI", system-ui, sans-serif; font-size: 15px; line-height: 1.5; }
  .rv .rv-intro { color: var(--ink-3, #7a7772); font-size: 13.5px; margin: 4px 0 14px; }
  .rv-group { border: 1px solid var(--hairline, #e6e3dd); border-radius: 8px; padding: 14px 16px 12px; margin: 0 0 16px; background: #fff; }
  .rv-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 14px; align-items: baseline; padding-bottom: 10px; border-bottom: 1px solid var(--hairline, #e6e3dd); }
  .rv-head .rv-title { font-size: 17px; font-weight: 600; }
  .rv-head .rv-title a { font-weight: 400; font-size: 13.5px; margin-left: 8px; }
  .rv-head .rv-facts { grid-column: 1; color: var(--ink-3, #7a7772); font-size: 12.5px; }
  .rv-head .rv-facts code { font-size: 12px; }
  .rv-head .rv-counter { grid-column: 2; grid-row: 1 / span 2; text-align: right; font-size: 12.5px; color: var(--ink-2, #4a4845); white-space: nowrap; }
  .rv-grade { display: inline-block; margin-left: 8px; padding: 2px 9px; border-radius: 999px; font-weight: 600; background: #ecebe6; color: var(--ink-3, #7a7772); }
  .rv-grade.a { background: var(--ok-soft, #e3f0e6); color: var(--ok, #2f7d4f); } .rv-grade.b { background: var(--accent-soft, #e4ecf4); color: var(--accent, #1f4e79); }
  .rv-grade.c { background: var(--warn-soft, #f6efdc); color: var(--warn, #8a6d1f); } .rv-grade.d { background: var(--crit-soft, #f5e4e0); color: var(--crit, #9b3b2e); }
  .rv-badges { display: inline-flex; gap: 6px; margin-left: 8px; font-size: 11px; }
  .rv-badges span { padding: 3px 8px; border-radius: 999px; background: #ecebe6; color: var(--ink-3, #7a7772); white-space: nowrap; }
  .rv-badges span.risk { background: var(--warn-soft, #f6efdc); color: var(--warn, #8a6d1f); }
  .rv-group-notes { padding: 8px 0 2px; }
  .rv-rows { list-style: none; margin: 0; padding: 0; }
  .rv-row { display: grid; grid-template-columns: 32px 74px minmax(0, 1fr) auto; gap: 0 10px; padding: 10px 0; border-bottom: 1px dashed var(--hairline, #e6e3dd); align-items: start; }
  .rv-row:last-child { border-bottom: 0; }
  .rv-id { font-weight: 600; color: var(--accent, #1f4e79); font-variant-numeric: tabular-nums; padding-top: 2px; }
  .rv-works { display: inline-flex; gap: 5px; align-items: center; font-size: 13px; color: var(--ink-2, #4a4845); padding-top: 2px; white-space: nowrap; }
  .rv-body { min-width: 0; }
  .rv-text { margin: 0; }
  .rv-status { display: inline-flex; gap: 5px; padding-top: 3px; }
  .rv-where { display: block; color: var(--ink-2, #4a4845); font-size: 13.5px; margin-top: 2px; }
  .rv-where b { font-weight: 600; color: var(--ink-3, #7a7772); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; margin-right: 2px; }
  .rv-chip { display: inline-block; font-size: 11px; line-height: 1; padding: 3px 7px; border-radius: 999px; border: 1px solid; white-space: nowrap; font-weight: 600; }
  .rv-chip.verified { color: var(--ok, #2f7d4f); border-color: var(--ok, #2f7d4f); } .rv-chip.failed { color: var(--crit, #9b3b2e); border-color: var(--crit, #9b3b2e); }
  .rv-chip.blocked { color: var(--warn, #8a6d1f); border-color: var(--warn, #8a6d1f); } .rv-chip.not-run { color: var(--ink-3, #7a7772); border-color: var(--hairline, #d6d1c7); }
  .rv-chip.fixed { color: var(--accent, #1f4e79); border-color: var(--accent, #1f4e79); } .rv-chip.works { color: var(--ok, #2f7d4f); border-color: var(--ok, #2f7d4f); background: var(--ok-soft, #e3f0e6); }
  .rv-outcome, .rv-yours { font-size: 13.5px; margin-top: 5px; padding-left: 10px; border-left: 2px solid var(--hairline, #e6e3dd); color: var(--ink-2, #4a4845); }
  .rv-outcome .rv-who, .rv-yours .rv-who { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-3, #7a7772); margin-right: 6px; }
  .rv-history { font-size: 12.5px; margin-top: 3px; padding-left: 12px; color: var(--ink-3, #7a7772); }
  .rv-history summary { cursor: pointer; }
  .rv-history li { margin: 2px 0; }
  .rv-note { display: block; width: 100%; margin-top: 6px; font: inherit; font-size: 13px; padding: 4px 8px; border: 1px solid var(--hairline, #e6e3dd); border-radius: 5px; background: #fffdf8; }
  .rv-foot { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--hairline, #e6e3dd); font-size: 13px; color: var(--ink-3, #7a7772); }
  .rv-stars { display: inline-flex; flex-direction: row-reverse; gap: 2px; }
  .rv-stars input { position: absolute; opacity: 0; width: 0; height: 0; }
  .rv-stars label { font-size: 20px; line-height: 1; color: #d6d1c7; cursor: pointer; }
  .rv-stars input:checked ~ label, .rv-stars label:hover, .rv-stars label:hover ~ label { color: var(--warn, #8a6d1f); }
  .rv-human { margin: 0 0 16px; }
  .rv-human ul { margin: 4px 0 0; padding-left: 22px; }
  .rv-revisions { margin: 0; }
  .rv-revisions textarea { width: 100%; min-height: 120px; font: inherit; font-size: 14px; padding: 10px 12px; border: 1px solid var(--hairline, #e6e3dd); border-radius: 6px; background: #fffdf8; }
  .rv-send { display: flex; gap: 12px; align-items: center; margin-top: 10px; }
  .rv-send button { font: inherit; font-size: 14px; padding: 7px 14px; border: 1px solid var(--accent, #1f4e79); border-radius: 6px; background: var(--accent, #1f4e79); color: #fff; cursor: pointer; }
  .rv-send .rv-queued { font-size: 12.5px; color: var(--ok, #2f7d4f); }
  /* table style (2026-09-02): Works · Priority · What to test · Steps · Expected result */
  .rv-table .rv-row { grid-template-columns: 66px 64px minmax(0, 1fr) minmax(0, 1.35fr) minmax(0, 1.35fr) auto; gap: 0 12px; }
  .rv-table .rv-hdr { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-3, #7a7772); font-weight: 600; padding: 6px 0; border-bottom: 1px solid var(--hairline, #e6e3dd); }
  .rv-table .rv-row .rv-id { font-size: 12px; margin-left: 4px; }
  .rv-table .rv-works { margin: 0; }
  .rv-pri { display: inline-block; font-size: 11.5px; font-weight: 600; padding: 2px 7px; border-radius: 4px; white-space: nowrap; }
  .rv-pri.high { background: var(--crit-soft, #f5e4e0); color: var(--crit, #9b3b2e); } .rv-pri.medium { background: var(--warn-soft, #f6efdc); color: var(--warn, #8a6d1f); } .rv-pri.low { background: #ecebe6; color: var(--ink-3, #7a7772); }
  .rv-area { display: block; font-size: 11.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-3, #7a7772); margin-bottom: 1px; }
  .rv-test { margin: 0; font-weight: 600; }
  .rv-test .rv-id { font-weight: 500; color: var(--ink-3, #7a7772); margin-right: 4px; }
  .rv-table .rv-where { overflow-wrap: anywhere; } .rv-table .rv-where a { word-break: break-all; }
  .rv-steps, .rv-expect { margin: 0; font-size: 14px; color: var(--ink-2, #4a4845); min-width: 0; }
  .rv-expect { color: var(--ink, #1c1b1a); }
  .rv-expect .rv-note { margin-top: 8px; }
  @media (max-width: 900px) { .rv-table .rv-row { grid-template-columns: 66px minmax(0, 1fr) auto; } .rv-table .rv-row .rv-pri, .rv-table .rv-hdr { display: none; } .rv-table .rv-steps, .rv-table .rv-expect { grid-column: 2; } }
  .rv-shot { display: block; margin: 8px 0 2px; width: max-content; max-width: 100%; }
  .rv-shot img { display: block; max-height: 150px; max-width: 100%; border: 1px solid var(--hairline, #e6e3dd); border-radius: 4px; background: #fff; }
  .rv-shot:hover img { box-shadow: 0 0 0 2px var(--accent-soft, #e4ecf4); }
  .rv-shot-missing { font-size: 12.5px; color: var(--warn, #8a6d1f); margin: 6px 0 2px; }
  .rv-agent-row .rv-shot img { max-height: 90px; }
  .rv-agent { margin: 10px 0 0; font-size: 13.5px; color: var(--ink-2, #4a4845); }
  .rv-agent summary { cursor: pointer; color: var(--ink-3, #7a7772); }
  .rv-agent ul { list-style: none; margin: 6px 0 0; padding: 0; }
  .rv-agent li { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; gap: 0 10px; padding: 6px 0; border-bottom: 1px dashed var(--hairline, #e6e3dd); }
  .rv-agent li:last-child { border-bottom: 0; }
  .rv-agent .rv-where { font-size: 12.5px; }
</style>`;

const SCRIPT = `<script>
function rvSend() {
  const q = window.lavish && window.lavish.queuePrompt;
  const sec = document.getElementById("review-checklist");
  let queued = 0;
  for (const form of sec.querySelectorAll("form.rv-group")) {
    const group = form.dataset.group;
    // only rows with a Works box are his: the table header and the agent-only rows are skipped
    const checks = [...form.querySelectorAll(".rv-row[data-check]")].filter((row) => row.querySelector('input[type=checkbox]')).map((row) => ({
      id: row.dataset.check,
      works: !!row.querySelector('input[type=checkbox]')?.checked,
      note: (row.querySelector(".rv-note")?.value || "").trim(),
    }));
    const stars = Number(form.querySelector('input[type=radio]:checked')?.value || 0) || null;
    if (!checks.some((c) => c.works || c.note) && !stars) continue;
    const line = checks.map((c) => c.id + " " + (c.works ? "works" : "not yet") + (c.note ? " (" + c.note + ")" : "")).join(", ");
    const prompt = "Review checks · " + group + ": " + line + (stars ? ". Stars: " + stars : "");
    const data = { kind: "checks", group, checks, stars };
    if (q) q(prompt, { tag: "review", text: "Review checks · " + group, element: form, queueKey: form.dataset.lavishQuestion, data });
    else console.log("no Lavish SDK:", prompt, data);
    queued++;
  }
  const rev = sec.querySelector(".rv-revisions textarea");
  const text = (rev?.value || "").trim();
  if (text) {
    if (q) q("Review revisions: " + text, { tag: "review", text: "Review revisions", element: rev.form, queueKey: "Review revisions", data: { kind: "revisions", text } });
    else console.log("no Lavish SDK: revisions", text);
    queued++;
  }
  const badge = sec.querySelector(".rv-queued");
  if (badge) { badge.hidden = false; badge.textContent = queued ? queued + " queued · press Send to agent in the Lavish bar" : "nothing to send yet: tick a box, write a note or a revision"; }
}
</script>`;

export const GROUP_ATTRS = ["manifest", "title", "link", "branch", "worktree", "range", "session", "verified"];
const unesc = (t) => String(t ?? "").replace(/&(amp|lt|gt|quot);/g, (m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"' }[e]));
/** The groups already in a section, in order, with the facts stored on their forms: [{group, manifest, …}]. */
export function groupsInSection(section) {
  const out = [];
  for (const m of String(section || "").matchAll(/<form class="rv-group(?: [^"]*)?"([^>]*)>/g)) {
    const attrs = {};
    for (const a of m[1].matchAll(/data-([a-z-]+)="([^"]*)"/g)) attrs[a[1]] = unesc(a[2]);
    if (attrs.group) out.push({ group: attrs.group, ...Object.fromEntries(GROUP_ATTRS.map((k) => [k, attrs[k] || ""])) });
  }
  return out;
}

const chip = (cls, label) => `<span class="rv-chip ${cls}">${esc(label)}</span>`;
/** The row's screenshot, as a thumbnail that opens the full image in a new tab (Marcus, 2026-10-05: the run already
 *  verified the screen, so the evidence belongs in the row, not on disk). A missing file says so instead. */
function renderShot(r) {
  if (r.shotHref) return `<a class="rv-shot" href="${esc(r.shotHref)}" target="_blank" rel="noopener" title="Open the screenshot for ${esc(r.id)}"><img src="${esc(r.shotHref)}" alt="Screenshot for ${esc(r.id)}" loading="lazy"></a>`;
  if (r.shotMissing) return `<div class="rv-shot-missing">screenshot not found: ${esc(r.shot)}</div>`;
  return "";
}
const STATUS_LABEL = { verified: "verified", failed: "failed", blocked: "blocked", "not-run": "not run" };

function renderRow(g, r) {
  const rid = `rv-${g.slug}-${r.id}`;
  const chips = [chip(r.status, r.status === "blocked" && r.blockedBy ? `blocked by ${r.blockedBy}` : STATUS_LABEL[r.status] || r.status)];
  if (r.works) chips.push(chip("works", "works"));
  if (r.fixedRound) chips.push(chip("fixed", `fixed · r${r.fixedRound}`));
  if (r.reopenedRound) chips.push(chip("failed", `reopened · r${r.reopenedRound}`));
  const href = r.whereHref || r.where;
  const linkText = (r.where || "").length > 3 ? r.where : (href || "here").replace(/^https?:\/\//, "");
  const whereLink = `<b>Where</b> <a href="${esc(href)}" target="_blank" rel="noopener">${esc(linkText)}</a>`;
  const lines = [];
  if (r.resultNote || r.status !== "not-run") lines.push(`<div class="rv-outcome"><span class="rv-who">verify</span>${esc(STATUS_LABEL[r.status] || r.status)}${r.resultNote ? ` — ${esc(r.resultNote)}` : ""}</div>`);
  const outs = r.outcomes || [];
  if (outs.length) {
    const last = outs[outs.length - 1];
    lines.push(`<div class="rv-outcome"><span class="rv-who">agent · r${last.round}</span>${esc(last.text)}</div>`);
    if (outs.length > 1) lines.push(`<details class="rv-history"><summary>earlier</summary><ul>${outs.slice(0, -1).map((o) => `<li><b>r${o.round}</b> ${esc(o.text)}</li>`).join("")}</ul></details>`);
  }
  for (const c of r.comments || []) lines.push(`<div class="rv-yours"><span class="rv-who">you · r${c.round}</span>${esc(c.text)}</div>`);
  if (r.yourNote) lines.push(`<div class="rv-yours"><span class="rv-who">your note</span>${esc(r.yourNote)}</div>`);
  const note = `<input class="rv-note" name="note-${esc(r.id)}" placeholder="Your note on ${esc(r.id)} (optional)">`;
  const works = `<label class="rv-works"><input type="checkbox" name="works-${esc(r.id)}" value="${esc(r.id)}"${r.works ? " checked" : ""}> Works</label>`;
  if (g.table) {
    // The 2026-09-02 table: Works · Priority · What to test · Steps · Expected result · status. The id stays in the
    // test cell's text ("C2 · …") so a comment on the row still resolves by its token (history.mjs).
    const pri = r.priority ? `<span class="rv-pri ${esc(r.priority.toLowerCase())}">${esc(r.priority)}</span>` : "<span></span>";
    return `    <li class="rv-row" data-check="${esc(r.id)}" id="${rid}">
      <span>${works}</span>
      ${pri}
      <div class="rv-body">${r.area ? `<span class="rv-area">${esc(r.area)}</span>` : ""}<p class="rv-text rv-test"><span class="rv-id">${esc(r.id)}</span> ${esc(r.text)}
          <span class="rv-where">${whereLink}</span></p></div>
      <p class="rv-steps">${esc(r.do)}</p>
      <div class="rv-expect"><p class="rv-expect">${esc(r.expect)}</p>${renderShot(r) ? "\n        " + renderShot(r) : ""}
${lines.map((l) => "        " + l).join("\n")}${lines.length ? "\n" : ""}        ${note}
      </div>
      <div class="rv-status">${chips.join("")}</div>
    </li>`;
  }
  const whereParts = [whereLink];
  if (r.do) whereParts.push(`<b>Do</b> ${esc(r.do)}`);
  if (r.expect && r.expect !== r.text) whereParts.push(`<b>Expect</b> ${esc(r.expect)}`);
  return `    <li class="rv-row" data-check="${esc(r.id)}" id="${rid}">
      <span class="rv-id">${esc(r.id)}</span>
      ${works}
      <div class="rv-body">
        <p class="rv-text">${esc(r.id)} · ${esc(r.text)}
          <span class="rv-where">${whereParts.join(" · ")}</span></p>${renderShot(r) ? "\n        " + renderShot(r) : ""}
${lines.map((l) => "        " + l).join("\n")}${lines.length ? "\n" : ""}        ${note}
      </div>
      <div class="rv-status">${chips.join("")}</div>
    </li>`;
}

/** AGENT-ONLY rows: the agent runs them (SQL, ledger, role gates); shown collapsed with their status, no Works box. */
function renderAgentRows(g, rows) {
  if (!rows.length) return "";
  const verified = rows.filter((r) => r.status === "verified").length;
  const items = rows.map((r) => {
    const rid = `rv-${g.slug}-${r.id}`;
    const href = r.whereHref || r.where;
    const outs = r.outcomes || [];
    const last = outs.length ? `<div class="rv-outcome"><span class="rv-who">agent · r${outs[outs.length - 1].round}</span>${esc(outs[outs.length - 1].text)}</div>` : "";
    const verify = r.resultNote || r.status !== "not-run" ? `<div class="rv-outcome"><span class="rv-who">verify</span>${esc(STATUS_LABEL[r.status] || r.status)}${r.resultNote ? ` — ${esc(r.resultNote)}` : ""}</div>` : "";
    const shot = renderShot(r);
    const yours = (r.comments || []).map((c) => `<div class="rv-yours"><span class="rv-who">you · r${c.round}</span>${esc(c.text)}</div>`).join("");
    return `      <li class="rv-row rv-agent-row" data-check="${esc(r.id)}" id="${rid}"><span class="rv-id">${esc(r.id)}</span><div class="rv-body"><p class="rv-text">${esc(r.id)} · ${esc(r.expect || r.text)}<span class="rv-where"><b>Where</b> <a href="${esc(href)}" target="_blank" rel="noopener">${esc(r.where || href)}</a>${r.do ? ` · <b>Do</b> <code>${esc(r.do)}</code>` : ""}</span></p>${verify}${shot}${last}${yours}</div><div class="rv-status">${chip(r.status, STATUS_LABEL[r.status] || r.status)}</div></li>`;
  });
  return `  <details class="rv-agent"><summary>Checked by the agent, not you · ${rows.length} · ${verified} verified</summary>
    <ul>
${items.join("\n")}
    </ul>
  </details>\n`;
}

function renderGroup(g) {
  const c = g.counters || counters(g.rows);
  const facts = [];
  if (g.branch) facts.push(`branch <code>${esc(g.branch)}</code>`);
  if (g.worktree) facts.push(`worktree <code>${esc(g.worktree)}</code>`);
  if (g.range) facts.push(`range <code>${esc(g.range)}</code>`);
  if (g.session) facts.push(`session <code>${esc(g.session)}</code>`);
  const badges = [];
  if (g.verified) badges.push(`<span>verified ${esc(g.verified)}</span>`);
  if (g.writes) badges.push(`<span class="risk" title="${esc(g.writes)}">writes</span>`);
  const grade = g.grade ? `<span class="rv-grade ${g.grade.letter.toLowerCase()}" title="${esc(g.grade.title || "")}">grade ${esc(g.grade.letter)}</span>` : `<span class="rv-grade" title="First-pass rate, rounds to green and your stars; computed when the first checks arrive">grade —</span>`;
  const stars = [5, 4, 3, 2, 1].map((n) => `<input type="radio" name="stars-${g.slug}" value="${n}" id="rv-${g.slug}-s${n}"${g.stars === n ? " checked" : ""}><label for="rv-${g.slug}-s${n}">★</label>`).join("");
  // The facts a rebuild needs to re-derive this group without its original flags (see groupsInSection).
  const stored = GROUP_ATTRS.filter((k) => g[k]).map((k) => ` data-${k}="${esc(g[k])}"`).join("");
  const yours = g.rows.filter((r) => !r.agent), agentRows = g.rows.filter((r) => r.agent);
  const hdr = g.table ? `    <li class="rv-row rv-hdr"><span>Works?</span><span>Priority</span><span>What to test</span><span>Steps</span><span>Expected result</span><span></span></li>\n` : "";
  return `<form class="rv-group${g.table ? " rv-table" : ""}" data-lavish-question="Review checks · ${esc(g.id)}" data-group="${esc(g.id)}"${stored} onsubmit="event.preventDefault()">
  <header class="rv-head">
    <div class="rv-title">${esc(g.title)}${g.link ? ` <a href="${esc(g.link)}" target="_blank" rel="noopener">${esc(g.link.replace(/^https?:\/\//, ""))}</a>` : ""}${badges.length ? `<span class="rv-badges">${badges.join("")}</span>` : ""}</div>
    <div class="rv-facts">${facts.join(" · ")}</div>
    <div class="rv-counter">${c.works} of ${c.total} work · ${c.verified} verified · ${c.needYou} need you ${grade}</div>
  </header>
${(g.comments || []).length ? `  <div class="rv-group-notes">${(g.comments || []).map((c) => `<div class="rv-yours"><span class="rv-who">you · r${c.round}</span>${esc(c.text)}</div>`).join("")}${(g.outcomes || []).map((o) => `<div class="rv-outcome"><span class="rv-who">agent · r${o.round}</span>${esc(o.text)}</div>`).join("")}</div>\n` : ""}  <ul class="rv-rows">
${hdr}${yours.map((r) => renderRow(g, r)).join("\n")}
  </ul>
${renderAgentRows(g, agentRows)}  <div class="rv-foot" data-lavish-ui="review-stars">
    <span>How did this land?</span>
    <span class="rv-stars" title="Your rating for this group">${stars}</span>
  </div>
</form>`;
}

function renderRevisions(model) {
  const revs = model.revisions || [];
  if (!revs.length) return "";
  const g = { id: "Your revisions", slug: "revisions" };
  const rows = revs.map((r) => `    <li class="rv-row" data-check="${esc(r.id)}" id="rv-revisions-${esc(r.id)}">
      <span class="rv-id">${esc(r.id)}</span>
      <span class="rv-works">${r.linked ? `→ ${esc(r.linked)}` : ""}</span>
      <div class="rv-body"><p class="rv-text">${esc(r.id)} · ${esc(r.text)}</p>${(r.outcomes || []).slice(-1).map((o) => `<div class="rv-outcome"><span class="rv-who">agent · r${o.round}</span>${esc(o.text)}</div>`).join("")}</div>
      <div class="rv-status">${r.done ? chip("fixed", `done · r${r.done}`) : chip("not-run", "open")}</div>
    </li>`).join("\n");
  return `<div class="rv-group" data-group="${esc(g.id)}">
  <header class="rv-head"><div class="rv-title">Your revisions</div><div class="rv-facts">from the free-form box, split into tracked items; → links an item to the row it belongs to</div></header>
  <ul class="rv-rows">
${rows}
  </ul>
</div>`;
}

/** The whole section (without the markers), from a model. */
export function renderSection(model) {
  const groups = model.groups || [];
  const all = groups.flatMap((g) => g.rows);
  const c = counters(all);
  const human = all.filter((r) => r.human);
  const sum = `${c.total} check${c.total === 1 ? "" : "s"} in ${groups.length} group${groups.length === 1 ? "" : "s"} · ${c.verified} verified · ${c.needYou} need you`;
  return `<section class="blk rv" id="review-checklist"><details open data-sec="Review checklist">
<summary class="h"><span class="title">Review checklist</span><span class="sum">${esc(sum)}</span><span class="badges"><span>review</span></span></summary>
${STYLE}
<p class="rv-intro">Try each check where it says. Tick <b>Works</b> when it did; click a row's text to comment on that row; the box at the bottom is for anything longer. <b>Send my checks</b> sends everything at once.</p>

${groups.map(renderGroup).join("\n\n")}

${renderRevisions(model)}${human.length ? `<div class="rv-human"><b>Still needs a human check</b><ul>${human.map((r) => `<li>${esc(r.id)} · ${esc(r.text)}</li>`).join("")}</ul></div>` : ""}

<form class="rv-revisions" data-lavish-question="Review revisions" onsubmit="event.preventDefault(); rvSend()">
  <textarea name="revisions" placeholder="Anything longer: what you would change, what surprised you, what to do next. The agent splits this into tracked items under the rows or as new R-rows."></textarea>
  <div class="rv-send" data-lavish-ui="review-send"><button type="submit">Send my checks</button><span class="rv-queued" hidden>queued · press Send to agent in the Lavish bar</span></div>
</form>
${SCRIPT}
</details></section>`.replace(/\n{3,}/g, "\n\n");
}

/* ── the plan page ───────────────────────────────────────────────────────── */
const FEEDBACK_LOG = /data-sec="(Feedback log|fb)"/;

/** Insert (or replace) the section; outside the markers the page is byte-identical. */
export function insertSection(page, section) {
  const block = `${BEGIN}\n${section}\n${END}\n`;
  const b = page.indexOf(BEGIN), e = page.indexOf(END);
  if (b !== -1 && e > b) return page.slice(0, b) + block + page.slice(e + END.length).replace(/^\n/, "");
  const fb = FEEDBACK_LOG.exec(page);
  let at;
  if (fb) at = page.lastIndexOf("\n", fb.index) + 1;
  else if (page.includes("</main>")) at = page.indexOf("</main>");
  else if (page.includes("</body>")) at = page.indexOf("</body>");
  else at = page.length;
  return page.slice(0, at) + block + page.slice(at);
}

export function extractSection(page) {
  const b = page.indexOf(BEGIN), e = page.indexOf(END);
  if (b === -1 || e < b) return null;
  return page.slice(b + BEGIN.length, e).replace(/^\n/, "").replace(/\n$/, "");
}

/** A page of its own when there is no plan to append to. */
export function standalonePage(section, { title = "Review checklist", project = "", description = "Checks to try in the app, grouped by PR." } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="lavish:project" content="${esc(project)}">
<meta name="description" content="${esc(description)}">
<style>
  :root { --paper: #faf9f6; --ink: #1c1b1a; --ink-2: #4a4845; --ink-3: #7a7772; --hairline: #e6e3dd; --accent: #1f4e79; --accent-soft: #e4ecf4; --ok: #2f7d4f; --ok-soft: #e3f0e6; --warn: #8a6d1f; --warn-soft: #f6efdc; --crit: #9b3b2e; --crit-soft: #f5e4e0; }
  * { box-sizing: border-box; min-width: 0; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.55 "Avenir Next", "Helvetica Neue", "Segoe UI", system-ui, sans-serif; }
  main { max-width: 880px; margin: 0 auto; padding: 22px 28px 120px; }
  h1, .h { font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; font-weight: 600; letter-spacing: -0.01em; }
  h1 { font-size: 30px; line-height: 1.15; margin: 8px 0 12px; }
  a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
  code { font: 13.5px/1.4 "SF Mono", Menlo, Consolas, monospace; background: #f1efe9; padding: 1px 5px; border-radius: 4px; }
  section.blk { border-top: 1px solid var(--hairline); padding: 8px 0 16px; }
  details > summary.h { cursor: pointer; padding: 12px 0; list-style: none; display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; grid-template-areas: "caret title badges" "caret sum badges"; column-gap: 10px; align-items: baseline; }
  details > summary.h::-webkit-details-marker { display: none; }
  details > summary.h::before { content: "▸"; grid-area: caret; color: var(--ink-3); font-size: 16px; }
  details[open] > summary.h::before { content: "▾"; }
  summary.h .title { grid-area: title; font-size: 22px; }
  summary.h .sum { grid-area: sum; font-weight: 400; font-size: 14px; color: var(--ink-3); margin-top: 2px; }
  details[open] > summary.h .sum { display: none; }
  summary.h .badges { grid-area: badges; display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; font: 11px/1 "Avenir Next", system-ui, sans-serif; }
  .badges span { padding: 3px 8px; border-radius: 999px; background: #ecebe6; color: var(--ink-3); white-space: nowrap; }
  ul.styled { padding-left: 0; margin: 8px 0 14px; list-style: none; }
  ul.styled li { position: relative; padding-left: 22px; margin: 5px 0; }
</style>
</head>
<body>
<main>
  <div class="kicker">Review</div>
  <h1>${esc(title)}</h1>
${BEGIN}
${section}
${END}
  <section class="blk"><details data-sec="Feedback log">
    <summary class="h"><span class="title">Feedback log</span><span class="sum">Every review round: what was received, what changed.</span><span class="badges"><span>log</span></span></summary>
    <ul id="feedlog" class="styled"></ul>
  </details></section>
</main>
</body>
</html>
`;
}
