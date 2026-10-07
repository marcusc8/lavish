---
name: verify-changes
description: Use after completing substantial multi-step UI work, or when the user runs /verify — proves the changes actually work by driving the Playwright MCP browser against a dev server as the dev-agent account, walking a manifest of falsifiable checks, auto-fixing failures (max 3 rounds), and reporting evidence. Start the manifest at TASK START for any long task that touches UI.
---

# verify-changes — Playwright self-verification

Prove that claimed changes work in the running app, with evidence. Full design

## When this runs

- **At the start** of any substantial multi-step task touching UI under `src/`:
  begin the manifest immediately (§1) and append to it as you build.
- **After** that task's implementation: run the verification pass (§2–§6).
- **On demand** via `/verify [manifest-path]` (defaults to the newest manifest).
- **Not** for one-line copy edits or non-UI work — a browser run costs more than
  it returns there.

## Hard rules — non-negotiable

1. **Read-only by default.** Navigate, read, type into fields to observe reactions
   — but never click Save / Submit / Delete / Send unless the manifest's `writes:`
   block declares that exact write.
2. **Some pages WRITE ON LOAD** (e.g. `DetailCatalogTab.load` creates `style_components`
   rows for unsynced sketch markers). Before treating any page as read-only, read its
   load path and prove every write branch is inert for the chosen subject — query the
   DB directly, pick subject data where the write is a no-op, and confirm empirically
   with a before/after `count(*)` + `max(updated_at)` check in the manifest.
3. **A write may be declared only if its cleanup path is proven to exist first.**
   Test rows use the `ZZ-VERIFY-` prefix and are deleted at the end of the run.
   No provable cleanup path (e.g. buy sheets have no delete; sales-order delete
   only cancels) → the check moves to the user's click-script instead.
4. **Destructive or outward-facing actions are never automated** — delete, cancel,
   email, anything reaching an external party — regardless of declarations.
5. **Dev-agent service account only** (`DEV_AGENT_EMAIL` in `.env.local`). Never
   the user's own credentials.
6. **The app talks to production Supabase.** Every page load touches real data;
   treat side effects as real.
7. **Never weaken a check to make it pass**, and never hardcode an expected value
   into app code to satisfy an assertion. Every fix is named in the report.

## 1 · The manifest — written DURING the work, never reconstructed after

Path: `.claude/verify/YYYY-MM-DD-<topic>.md` (gitignored). Append each check at
the moment you implement its requirement, phrased from the user's request — not
from what the code happens to do.

```
route:  /purchasing/costing
branch: feat/purchasing/costing-page
mode:   read-only            # or: writes declared below
role:   admin                # role the run must hold
writes: (none)               # each declared write: what, ZZ-VERIFY- marker, cleanup path

CHECKS
  C1  page-loads      nav /purchasing/costing → heading "Costing" visible
                      AND zero console errors AND no error boundary
  C2  field-fob       label "FOB Cost" → numeric input, editable
  C5  computed-total  set FOB=10.00 → "Landed Cost" recomputes, not 0.00, not NaN
  C6  empty-state     a style with no HTS assignment shows the empty state,
                      NOT a silent blank panel

RESULT   (filled in by the run, never by hand)
```

Check rules:
- **Falsifiable.** "The page works" is not a check. "Setting FOB to 10.00 makes
  Landed Cost change to something ≠ 0.00 and ≠ NaN" is.
- **Behavioral beats existence.** Element-exists checks are the weakest kind;
  relationship assertions (input → recomputation) carry the weight.
- **Every data-driven check gets an empty-state companion.** Several prod tables
  are legitimately empty; a correct page over empty data must show its empty
  state, and the verifier must distinguish *broken* from *empty*.

## 2 · Environment

- Verify the branch under test in its worktree. Pin every git call:
  `git -C <absolute-worktree-path>` (CWD resets between turns).
- Copy `.env.local` from the primary checkout into the worktree if missing —
  without it every data call fails on missing env.
- **Run `npm install` in the worktree** (verify `node_modules/vite` exists first).
  A fresh worktree's `node_modules` is EMPTY, and because worktrees live *inside*
  the primary checkout, Node resolution silently walks up and uses the primary's
  modules — which are branch-stale and will be missing deps main has added. The
  symptom is a Vite overlay "Failed to resolve import X", which looks like a code
  bug but is a harness bug. Abort and fix the environment; never report it as a
  feature failure.
- **Always start your own server** from the worktree, in the background:
  `npm run dev -- --port 5199 --strictPort`
  Never reuse whatever listens on :5173 — it may be the stale primary checkout
  serving a different branch. `--strictPort` guarantees you know which server
  you're talking to (it dies loudly instead of hopping ports).
- Kill that server when the run ends, pass or fail.

## 3 · Sign in — session injection

- Run `node .claude/skills/verify-changes/mint-session.mjs <worktree-root>`.
  It prints `{ storageKey, role, session }`, caching the session at
  `.claude/verify/.session.json` and reusing it until expiry.
- In the browser: navigate to `http://localhost:5199/`, then evaluate
  `localStorage.setItem(storageKey, JSON.stringify(session))`, then reload.
- **Self-check before any feature check:** the app renders signed-in UI (not the
  login screen) AND `role` matches the manifest's `role:` line. On failure,
  **abort the entire run** and report a harness/credential problem. Never report
  feature failures from an unauthenticated or wrong-role run.

## 4 · The verification pass

For each check, in manifest order:
- Deep-link straight to the route (BrowserRouter → real paths).
- Assert against `browser_snapshot` (the accessibility tree), not pixels.
  Unfindable-by-label is itself a finding (missing accessible label).
- Read `browser_console_messages`: **uncaught errors fail the check they occur
  in; warnings go into the report but never fail.**
- Capture one screenshot per check as evidence (`.playwright-mcp/`, gitignored).
- A check whose precondition failed is `blocked-by-<id>`, not `fail`.

## 5 · Fix loop

- **Max 3 rounds, 10-minute total budget.** Anything still red after that goes to
  the user with evidence, diagnosis, and a proposed fix per failure.
- Auto-fix only when the cause is unambiguous. Ambiguous requirement, schema
  change, or anything destructive → stop and ask instead.
- **Every round starts cold:** hard reload + cleared console. Never trust HMR to
  have fully applied a fix.

## 6 · Report

- Fill the manifest's `RESULT` block (pass / fail / blocked-by per check).
- Report to the user: check table with evidence paths, every fix applied per
  round (what changed and why), and anything still red with diagnosis + proposal.
- When a PR exists (or gets created), paste the RESULT block into the PR body
  next to the preview link — evidence travels with the review.
- Always close with the limits line:
  > Verified against localhost + live data as `<role>`. Not covered: visual
  > design quality, prod behavior, other roles, regressions outside this
  > manifest, race/slow-network behavior.
