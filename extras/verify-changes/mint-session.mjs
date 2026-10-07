#!/usr/bin/env node
/*
 * Mints (or reuses) a Supabase session for the dev-agent verification account.
 * Part of the verify-changes skill — see SKILL.md §3.
 *
 * Usage:   node mint-session.mjs [worktree-root]        (default: cwd)
 * Prints:  { "storageKey": "sb-<ref>-auth-token", "role": "...", "session": {...} }
 *
 * The session object is the token endpoint's response verbatim — already the
 * exact shape supabase-js stores, so inject it with:
 *   localStorage.setItem(storageKey, JSON.stringify(session))
 * then reload. Sessions are cached at .claude/verify/.session.json and reused
 * until 60s before expiry, so repeated runs don't hammer the auth endpoint.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const root = process.argv[2] ?? process.cwd();
const envPath = join(root, ".env.local");
if (!existsSync(envPath)) {
  console.error(`no .env.local at ${root} — copy it from the primary checkout`);
  process.exit(1);
}
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const { VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: anonKey, DEV_AGENT_EMAIL: email, DEV_AGENT_PASSWORD: password } = env;
if (!url || !anonKey || !email || !password) {
  console.error("missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / DEV_AGENT_EMAIL / DEV_AGENT_PASSWORD in .env.local");
  process.exit(1);
}

// Same derivation supabase-js uses: `sb-${hostname first label}-auth-token`.
const storageKey = `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
const cachePath = join(root, ".claude", "verify", ".session.json");

let session = null;
if (existsSync(cachePath)) {
  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    if (cached?.expires_at && cached.expires_at * 1000 > Date.now() + 60_000) session = cached;
  } catch {
    /* stale/corrupt cache → re-mint */
  }
}

if (!session) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    console.error(`auth failed: HTTP ${res.status} ${await res.text()}`);
    console.error("→ the DEV_AGENT_PASSWORD in .env.local is likely stale; reset it in Supabase and update .env.local");
    process.exit(1);
  }
  session = await res.json();
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(session));
}

// Role lookup so the harness can assert it matches the manifest's `role:` line.
let role = null;
try {
  const res = await fetch(`${url}/rest/v1/profiles?select=role&id=eq.${session.user.id}`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${session.access_token}` },
  });
  role = (await res.json())[0]?.role ?? null;
} catch {
  /* role stays null; the skill treats unknown role as a self-check failure */
}

console.log(JSON.stringify({ storageKey, role, session }));
