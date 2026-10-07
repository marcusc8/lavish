---
description: Prove the current change works — drive Playwright through the manifest's checks against a dev server, auto-fix failures (max 3 rounds), report evidence. Invoke as /verify [manifest-path].
---
Invoke the **verify-changes** skill (`.claude/skills/verify-changes/SKILL.md`) and run the full
verification pass now.

Manifest: **$ARGUMENTS** — if empty, use the newest file in `.claude/verify/`; if none exists,
build one first from the requirements of the work just completed in this conversation (falsifiable
checks only, empty-state companions for data-driven checks), show it to me briefly, then run.

Follow the skill exactly: own dev server on port 5199 (strictPort), session injection via
`mint-session.mjs`, the signed-in + role self-check before any feature check, read-only unless the
manifest declares writes, max 3 fix rounds / 10 minutes, then the evidence report with the RESULT
block filled in and the limits line at the end.
