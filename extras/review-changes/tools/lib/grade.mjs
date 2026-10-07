/* grade.mjs — the grade per group: first-pass rate, rounds to green, Marcus's stars → a letter.
 *
 * Letter = the worse of the rate band (≥90 % A · ≥75 % B · ≥50 % C · else D) and the rounds band (1 A · 2 B ·
 * 3 C · 4+ D). Stars can only lower it (3 caps at B, ≤2 caps at C). A D always yields a lesson candidate.
 */
import { parseContextData } from "./history.mjs";

export function letterFor({ rate = 0, rounds = 1, stars = null } = {}) {
  const byRate = rate >= 0.9 ? 0 : rate >= 0.75 ? 1 : rate >= 0.5 ? 2 : 3;
  const byRounds = rounds <= 1 ? 0 : rounds === 2 ? 1 : rounds === 3 ? 2 : 3;
  let i = Math.max(byRate, byRounds);
  if (stars != null) { if (stars <= 2) i = Math.max(i, 2); else if (stars === 3) i = Math.max(i, 1); }
  return "ABCD"[i];
}

const checksFor = (batch, group) => batch.items.map((it) => parseContextData(it.text).data).find((d) => d?.kind === "checks" && d.group === group.id);

/** null until the group has received a checks batch. */
export function computeGrade(group, model) {
  const batches = (model.batches || []).map((b) => checksFor(b, group)).filter(Boolean);
  if (!batches.length) return null;
  const ticked = (d) => new Set((d.checks || []).filter((c) => c.works).map((c) => String(c.id)));
  const first = ticked(batches[0]);
  const total = group.rows.length;
  const passed = group.rows.filter((r) => r.status === "verified" || first.has(r.id)).length;
  const greenAt = batches.findIndex((d) => { const t = ticked(d); return group.rows.every((r) => t.has(r.id)); });
  const green = greenAt !== -1;
  const rounds = green ? greenAt + 1 : batches.length;
  const stars = group.stars ?? null;
  const letter = letterFor({ rate: total ? passed / total : 0, rounds, stars });
  const title = `first pass ${passed}/${total} · ${rounds} round${rounds === 1 ? "" : "s"}${green ? " to green" : " so far"}${stars != null ? ` · ${stars} stars` : ""}`;
  return { firstPass: { passed, total }, rounds, stars, letter, title };
}
