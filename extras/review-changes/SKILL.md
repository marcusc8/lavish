---
name: review-changes
description: Use when a PR or phase has landed and the user wants to know whether it works, when he asks to review, verify, check or "try" what was built, when lavish-poll delivers Review checklist items (ticks, a row comment, revisions, a verdict), or when a review loop must be resumed or handed to another session.
---

# Review changes

**The deliverable is a Review checklist on the plan's Lavish page**, not a code review and not a gate
report in the terminal: checks the user tries in the app, one group per PR, every row saying **where** to
test, **what** to do and **what** to expect, the agent's outcome under the row after each fix, the grade on
the group header. He never reads the session; the page is the whole conversation.

Tools (on PATH, also `~/.agents/skills/review-changes/tools/` for Codex): `review-checklist`,
`lavish-axi`, `lavish-poll`, `lavish-meta`, `lessons`. Format and conventions: `references/manifest-format.md`,
`references/revisions.md`; the section's look: `references/checklist-section.html`.

## The loop

1. **During implementation** keep the manifest (`.claude/verify/YYYY-MM-DD-<topic>.md`): one falsifiable
   check per requirement, **phrased as a table row the user can act on with his eyes** (the 2026-09-02 standard
   in `references/manifest-format.md`): `priority: · area: · test: · where: · do: · expect:` (+ `shot:` for the run's screenshot, shown in the row), plain words, no
   backend vocabulary; empty states as their own Low rows; `HUMAN-ONLY` for the floor; every SQL, ledger,
   role-gate or storage check under `AGENT-ONLY` (you run those, he never sees them as his). No manifest yet? Write it now from the
   plan's acceptance lines and his request, never from the diff, and say so in the group's `--session` name.
2. **When it lands.** Unit of review = the commit range against its base (`git merge-base`), never a bare
   `git diff`: another session holds uncommitted hunks. Run `/verify` where the project has it, then
   `lessons recall --project <name> --files <changed> --text "<task>"`, then
   `review-checklist build --plan <plan.html> --manifest <file> --group "PR #n" --range a..b --session "<name>"`,
   `lavish-meta <plan> --status in-progress` (or `merged` when the last PR is on main), `lavish-axi <plan>`
   (`--reopen` only if he ended it and asked), and `lavish-poll <plan> --agent-reply "PR #n landed: M checks,
   V verified, K need you; start with …" --label "round 1: checklist"` as a **tracked background job**
   (Claude Code `run_in_background`; Codex: foreground, no `--timeout-ms`, re-run if it returns). If the
   history already holds this round's opener, do not send a second one: an `--agent-reply` closes a round.
3. **On feedback** (`receiving-code-review` governs): per row → reproduce, fix, commit with explicit paths
   (no `git add -A`, no stash, no rebase; foreign hunks → stop and ask), re-run that check if `/verify`
   exists. Then **one** `lavish-poll` call with `--reply n` for every delivered item (a fix reply starts with
   `Fixed:`; a revisions item gets `R1 → C2: …` lines), `--agent-reply` starting with the printed receipt,
   `--label "round N: …"`. **Then** `review-checklist build …` again, after every reply, fix or not (a
   "not fixed, re-planning" reply is an outcome too and reopens the row), and `review-checklist list --plan …`
   to confirm it sits under the row. Add one line per item to the plan's Feedback log (a plain edit,
   outside the review markers).
4. **Same turn, every fix:** `lessons ingest` with the comment, the diagnosis and the fix; name the key in the
   reply. A grade of D → a lesson candidate too.
5. **Second failure on one row → re-plan in the reply**, no third quick fix: reproduce end to end, name the
   chain link that went quiet, then fix with a test that fails on the old code.
6. **End or hand off.** All rows work or verdict Approve → `lavish-meta --status implemented`, `lavish-axi
   end`, `finishing-a-development-branch` if the branch is open. Leaving with rows open →
   `review-checklist handoff --plan … --launch` (writes `docs/reviews/<date>-<slug>-HANDOFF.md`, then opens a
   Terminal window with claude or codex already running the hand-off as its first prompt through Manager
   the user's launch endpoint; `--provider`, `--model`, `--effort`) and stop polling. Never hand him a prompt to paste.

## Rationalizations seen in testing

| Thought | Reality |
|---|---|
| "He's in a hurry, a terminal summary is faster" | He asked whether it works; that answer is the page he can tick, and it takes one build. |
| "Tests and typecheck are green, so it works" | Gates are the floor. The rows are what he does in the app. |
| "The SQL check is important, he should see it" | He tests the front end. Important backend checks go under `AGENT-ONLY` and you run them. |
| "No manifest / no PR by that number, so skip the page" | Check the range, write the manifest from the plan, build anyway; say what you assumed on the group header. |
| "Reply last, rebuild first" | The rebuild renders your replies. Reply, then build, then `list`. |
| "A second quick fix while he waits" | Two failures on one row means the diagnosis was wrong. Re-plan in the reply. |
| "I'll hand-edit the section" | Only `review-checklist build` writes between the markers; a hand edit is lost at the next rebuild. |
| "The lesson can wait for the retro" | The lesson is written in the same turn as the fix or it is never written. |

## Red flags — stop

Bare `git diff` · `git add -A` · a checklist row without a link · a fix without a `--reply` · a build before
the reply · a round closed without `--label` · polling with the raw `lavish-axi poll` · a "fixed" claim you
did not watch pass.
