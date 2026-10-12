#!/usr/bin/env node
// lavish-axi, as every agent on this machine runs it (~/.local/bin/lavish-axi points here since 2026-10-11).
// Marcus reads plans and review pages inside Manager Marcus's Plan tab (and on the Lavish home page), so opening a
// browser tab for every `lavish-axi <file>` only stacked stale tabs on 127.0.0.1:4387 until its connection pool was full.
// This shim runs the pinned, patched editor with LAVISH_AXI_NO_OPEN set; `--open` (removed from the arguments) asks for a
// tab anyway, for the one time Marcus wants one. Everything else, arguments and environment, passes through unchanged.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const real = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../.local/lib/node_modules/lavish-axi/dist/cli.mjs");
const args = process.argv.slice(2);
const wantsTab = args.includes("--open");
const env = { ...process.env };
if (wantsTab) delete env.LAVISH_AXI_NO_OPEN; else env.LAVISH_AXI_NO_OPEN = "1";
const r = spawnSync(process.execPath, [real, ...args.filter((a) => a !== "--open")], { stdio: "inherit", env });
process.exit(r.status ?? 1);
