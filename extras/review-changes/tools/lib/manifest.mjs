/* manifest.mjs — parse a /verify-changes manifest (the single source of checks, decision D8).
 *
 * Format (StyleManager .claude/verify/YYYY-MM-DD-<topic>.md, extended):
 *
 *   route:  /purchasing/costing        two+ spaces then "# …" is a comment
 *   preview: https://…                 optional; wins over route as the where-to-test link
 *   branch: … · mode: … · role: … · writes: … · session: … · range: … · worktree: …
 *   (a key's continuation lines are indented and appended)
 *
 *   CHECKS                              one check per "  Cn  slug  text" line; deeper-indented lines continue it
 *   HUMAN-ONLY                          same shape; checks the verifier cannot reach (human: true)
 *   RESULT                              "  Cn  slug  PASS|FAIL|blocked-by-Cm [— note] [· shot: path]"; lines at the id column
 *                                       that are not checks are trailer notes (console, cleanup …)
 *   GRADE                               "first-pass: a/b · rounds: n · stars: n · letter: A"
 *
 * Tolerant by contract: unknown lines are ignored, nothing throws.
 */

// Plain "CHECKS" or a markdown heading "## CHECKS — title (#497)"; several CHECKS blocks simply continue the list.
const SECTION = /^#*\s*(CHECKS|HUMAN-ONLY|AGENT-ONLY|RESULT|GRADE)\b/;
// A row id starts with a capital and ends in a digit, with an optional one- or two-letter suffix (C1, A12, Q-C7x,
// I-C4a, 3.1-C13b, H1H2x): the 2026-10-06 manifests prefix ids with the slice and suffix variants.
const ID = /^(\s*)([A-Z][A-Za-z0-9.-]*\d[a-z]{0,2})(?:\s+(.*))?$/;
const HEADER_KEY = /^([A-Za-z][\w-]*):\s*(.*)$/;

const stripComment = (v) => v.replace(/\s{2,}#\s.*$/, "").trim();
const indentOf = (line) => line.length - line.trimStart().length;

export function parseManifest(text) {
  const out = { header: {}, checks: [], result: {}, resultNotes: [], grade: null };
  const lines = String(text || "").split(/\r?\n/);
  let section = "header";
  let idCol = null;          // indentation of the id column in the current section
  let lastKey = "";          // header continuation target
  let current = null;        // open check
  let lastResult = null;     // open result entry
  let lastNote = -1;         // open trailer note (index into resultNotes)
  const gradeLines = [];

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const sec = SECTION.exec(line);
    if (sec && indentOf(line) === 0) { section = sec[1]; idCol = null; current = null; lastResult = null; lastNote = -1; continue; }

    if (section === "header") {
      const m = HEADER_KEY.exec(line);
      if (m && indentOf(line) === 0) { lastKey = m[1].toLowerCase(); out.header[lastKey] = stripComment(m[2]); }
      else if (lastKey && indentOf(line) > 0) out.header[lastKey] = `${out.header[lastKey]} ${stripComment(line)}`.trim();
      continue;
    }
    if (section === "GRADE") { gradeLines.push(line.trim()); continue; }

    const id = ID.exec(line);
    const isId = id && (idCol === null || indentOf(line) <= idCol);
    if (section === "CHECKS" || section === "HUMAN-ONLY" || section === "AGENT-ONLY") {
      if (isId) {
        idCol ??= indentOf(line);
        const rest = (id[3] || "").trim();
        if (!rest) { current = null; continue; }
        const sp = rest.search(/\s/);
        const slug = sp === -1 ? rest : rest.slice(0, sp);
        current = { id: id[2], slug, text: sp === -1 ? "" : rest.slice(sp).trim(), human: section === "HUMAN-ONLY", agent: section === "AGENT-ONLY" };
        out.checks.push(current);
      } else if (current && idCol !== null && indentOf(line) > idCol) {
        current.text = `${current.text} ${line.trim()}`.trim();
      }
      continue;
    }
    if (section === "RESULT") {
      if (isId) {
        idCol ??= indentOf(line);
        lastResult = parseResult((id[3] || "").trim());
        out.result[id[2]] = lastResult;
        lastNote = -1;
      } else if (idCol !== null && indentOf(line) > idCol) {
        if (lastNote >= 0) out.resultNotes[lastNote] = `${out.resultNotes[lastNote]} ${line.trim()}`;
        else if (lastResult) lastResult.note = `${lastResult.note} ${line.trim()}`.trim();
      } else {
        out.resultNotes.push(line.trim());
        lastNote = out.resultNotes.length - 1;
        lastResult = null;
      }
    }
  }
  if (gradeLines.length) out.grade = parseGrade(gradeLines.join(" · "));
  return out;
}

const STATUS = /^(pass(?:ed)?|ok|fail(?:ed)?|blocked(?:-by-([A-Z]+\d+))?|\(not run\)|not[- ]run)(?![\w-])/i;
/** "slug PASS — note" | "PASS" | "blocked-by-C2" | anything else (not-run, kept as the note). */
// A RESULT line may end with "shot: <path>" (the screenshot the run took for that row), after any "·" or "|".
const SHOT_TAIL = /\s*[·|]?\s*\bshot\s*:\s*(\S+)\s*$/i;
function parseResult(rest) {
  let shot = "";
  let s = rest.replace(SHOT_TAIL, (_, path) => { shot = path; return ""; });
  const withShot = (r) => (shot ? { ...r, shot } : r);
  let m = STATUS.exec(s);
  if (!m) {
    // the first token is the slug unless it is itself a status word
    const sp = s.search(/\s/);
    s = sp === -1 ? "" : s.slice(sp).trim();
    m = STATUS.exec(s);
  }
  if (!m) return withShot({ status: "not-run", note: s });
  const word = m[1].toLowerCase();
  const note = s.slice(m[0].length).replace(/^\s*[—–:-]\s*/, "").trim();
  if (word.startsWith("blocked")) return withShot({ status: "blocked", blockedBy: m[2] || "", note });
  if (/not/.test(word)) return withShot({ status: "not-run", note });
  return withShot({ status: word.startsWith("fail") ? "fail" : "pass", note });
}

function parseGrade(text) {
  const get = (k) => (new RegExp(`${k}\\s*:\\s*([^·\\n]+)`, "i").exec(text) || [])[1]?.trim() || "";
  const fp = /(\d+)\s*\/\s*(\d+)/.exec(get("first-pass"));
  const num = (v) => (v === "" || Number.isNaN(Number(v)) ? null : Number(v));
  return {
    firstPass: fp ? { passed: Number(fp[1]), total: Number(fp[2]) } : null,
    rounds: num(get("rounds")),
    stars: num(get("stars")),
    letter: get("letter").toUpperCase() || "",
  };
}

/** Priority · area · test · where · do · expect for one check. Labels win; else "do → expect"; where falls back
 * to preview, then route. The 2026-09-02 standard (Marcus): every row he tests is a table row —
 * priority (High/Medium/Low) · area (the feature) · test (what to test) · do (the steps) · expect (what he sees). */
export function phrase(check, header = {}) {
  const text = String(check?.text || "").trim();
  const parts = {};
  const re = /\b(priority|area|test|where|do|expect|shot)\s*:\s*/gi;
  const labels = [...text.matchAll(re)];
  if (labels.length) {
    labels.forEach((l, i) => {
      const end = i + 1 < labels.length ? labels[i + 1].index : text.length;
      parts[l[1].toLowerCase()] = text.slice(l.index + l[0].length, end).replace(/\s*·\s*$/, "").trim();
    });
  } else if (text.includes("→")) {
    const at = text.indexOf("→");
    parts.do = text.slice(0, at).trim();
    parts.expect = text.slice(at + 1).trim();
  } else parts.expect = text;
  const out = { where: parts.where || check?.where || header.preview || header.route || "", do: parts.do || "", expect: parts.expect || "" };
  for (const k of ["priority", "area", "test", "shot"]) if (parts[k]) out[k] = parts[k];
  return out;
}
