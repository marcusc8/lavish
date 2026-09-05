#!/usr/bin/env node
/* relink-paths.mjs — one-time repair of Lavish sessions whose artifact moved.
 *
 * Why: sessions are keyed by sha256(realpath of the artifact). When the Dropbox folder was
 * renamed (Dropbox/ → Dropbox-Personal/, Aug 2026) every stored path went stale, so those
 * sessions can never be resumed from the home page. This script:
 *   1. stops the Lavish server (it rewrites state.json on every request),
 *   2. backs up ~/.lavish-axi/state.json,
 *   3. for each session whose file is missing, tries the renamed path; if it exists, moves the
 *      session to its new key (file, url, whiteboards, history, notes, versions, registry), merging chat into an existing
 *      session for the same file if one was created after the rename,
 *   4. prints a report. Sessions whose file is gone for good are left as they are (the home
 *      page shows them as orphaned).
 * Usage: node relink-paths.mjs [--dry-run] [--from /Dropbox/ --to /Dropbox-Personal/]
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const FROM = flag("--from", "/Dropbox/"), TO = flag("--to", "/Dropbox-Personal/");
const stateDir = process.env.LAVISH_AXI_STATE_DIR || join(os.homedir(), ".lavish-axi");
const statePath = join(stateDir, "state.json");
const keyOf = (file) => createHash("sha256").update(file).digest("hex").slice(0, 16);

if (!dry) {
  const stop = spawnSync("lavish-axi", ["stop"], { encoding: "utf8" });
  console.log(`lavish-axi stop → ${stop.status === 0 ? "stopped" : "was not running"}`);
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  copyFileSync(statePath, `${statePath}.bak-${stamp}`);
  console.log(`backup: ${statePath}.bak-${stamp}`);
}

const state = JSON.parse(readFileSync(statePath, "utf8"));
const report = { relinked: 0, merged: 0, orphaned: 0, ok: 0 };
for (const [key, s] of Object.entries(state.sessions)) {
  if (existsSync(s.file)) { report.ok++; continue; }
  const candidate = s.file.includes(FROM) ? s.file.replace(FROM, TO) : "";
  if (!candidate || !existsSync(candidate)) { report.orphaned++; console.log(`  orphan   ${s.file}`); continue; }
  const newFile = realpathSync(candidate);
  const newKey = keyOf(newFile);
  const newUrl = String(s.url || "").replace(/\/session\/[0-9a-f]+$/, `/session/${newKey}`);
  if (state.sessions[newKey] && newKey !== key) {
    // A session for the new path already exists (artifact reopened after the rename): fold the old chat in, keep the newer status.
    const t = state.sessions[newKey];
    t.chat = [...(s.chat || []), ...(t.chat || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    delete state.sessions[key];
    report.merged++; console.log(`  merged   ${s.file}\n        →  ${newFile} (existing session ${newKey})`);
  } else {
    delete state.sessions[key];
    state.sessions[newKey] = { ...s, key: newKey, file: newFile, url: newUrl };
    report.relinked++; console.log(`  relinked ${s.file}\n        →  ${newFile} (${key} → ${newKey})`);
  }
  // Everything else keyed by the session key moves with it: whiteboard scenes, lavish-poll history,
  // private notes, version snapshots, and the registry record (status / PRs / summary).
  for (const [oldPath, newPath] of [
    [join(stateDir, "whiteboards", key), join(stateDir, "whiteboards", newKey)],
    [join(stateDir, "history", `${key}.jsonl`), join(stateDir, "history", `${newKey}.jsonl`)],
    [join(stateDir, "notes", `${key}.json`), join(stateDir, "notes", `${newKey}.json`)],
    [join(stateDir, "notes", `${key}.files`), join(stateDir, "notes", `${newKey}.files`)],
    [join(stateDir, "queue", `${key}.json`), join(stateDir, "queue", `${newKey}.json`)],
    [join(stateDir, "exports", key), join(stateDir, "exports", newKey)],
    [join(stateDir, "versions", key), join(stateDir, "versions", newKey)],
  ]) if (!dry && existsSync(oldPath) && !existsSync(newPath)) renameSync(oldPath, newPath);
  if (!dry) {
    const regPath = join(stateDir, "registry.json");
    try {
      const reg = JSON.parse(readFileSync(regPath, "utf8"));
      if (reg[key] && !reg[newKey]) { reg[newKey] = { ...reg[key], file: newFile }; delete reg[key]; writeFileSync(regPath, JSON.stringify(reg, null, 2)); }
    } catch { /* no registry yet */ }
  }
}
if (!dry) writeFileSync(statePath, JSON.stringify(state, null, 2));
console.log(`\n${dry ? "DRY RUN " : ""}ok ${report.ok} · relinked ${report.relinked} · merged ${report.merged} · orphaned ${report.orphaned}`);
