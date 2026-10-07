# The manifest — the single source of checks

One file per PR or phase, kept **during** the work (StyleManager: `.claude/verify/YYYY-MM-DD-<topic>.md`,
gitignored; elsewhere the same path). `/verify-changes` runs it where that skill exists; `review-checklist
build` renders it. Never reconstruct it after the fact from the diff.

```
route:   /samples/carts/photos          # two spaces then "# …" is a comment; "PR #504" inside a value is kept
base:    https://app.stylaos.com        # optional: bare where-paths become links against it
preview: https://pr-12.vercel.app/…     # optional: wins over route as the group's link
branch:  feat/samples/photos-v2         # optional: git supplies it when absent
session: photos · implementer           # optional: the session that produced the group
range:   a1b2c3..HEAD                   # optional: the commit range under review
mode:    read-only                      # or: writes declared below
role:    admin
writes:  (none)                         # anything else shows a "writes" risk badge on the group

CHECKS
  C1  photo-upload   priority: High · area: Photo upload · test: Upload each photo angle · where: /samples/carts/photos · do: Open Sample Photos, find a test sample, and upload Left, Right, Front, Back, Top and Bottom · expect: Each image appears in the correct labeled slot and stays there after refreshing
  C2  replace-photo  priority: High · area: Replace photo · test: Replace an existing photo · where: /samples/carts/photos · do: Upload a different image into an occupied slot · expect: Only the new image is shown
  C9  empty-tab      priority: Low · area: Status tabs · test: An empty tab says so · where: /samples/carts/photos · do: Open a status tab with no samples in it · expect: A one-line "Nothing under <tab>" message, no spinner

HUMAN-ONLY
  H1  wedge-scanner  priority: Medium · area: Photo station · test: Scan with the real scanner · where: /samples/carts/photos?capture=1 · do: Scan a shoe's label with the wedge scanner · expect: The sheet filters to that shoe

AGENT-ONLY
  A1  ledger         where: SQL editor (main) · do: select max(version) from supabase_migrations.schema_migrations; · expect: 20260901120000 or later
  A2  verdict-gate   where: SQL editor (main) · do: select count(*) from sample_photo_reviews where item_id = '<row>'; · expect: unchanged after a refused verdict

RESULT   (filled in by the verify run, never by hand)
  C1  photo-upload   PASS — six slots filled, survive a reload
  C2  replace-photo  FAIL — the old image stays until a hard refresh
  A1  ledger         PASS
  H1  wedge-scanner  blocked-by-C1
  console: 0 errors                     ← lines at the id column that are not checks are trailer notes

GRADE    (written by review-checklist at the end)
  first-pass: 2/3 · rounds: 1 · stars: 4 · letter: B
```

Also accepted: markdown headings (`## CHECKS — costing page (#497)`, several per file) and id prefixes other
than C (`D3`, `T2`, `P1`). Results without a matching check are ignored by the renderer.

## Phrasing a check — the standard (the user, 2026-09-02)

the user tests the **front end** and suggests visual changes; he does not look at the backend. Every row he
reads is a table row, in the words he would use:

| Priority | PR / Area | What to test | Steps | Expected result | Works? |
|---|---|---|---|---|---|
| High | #522 — Replace photo | Replace an existing photo | Upload a different image into an occupied slot | A confirmation appears; after confirming, only the new image is displayed | ☐ |

Labels, in this order, separated by ` · `, one row per line:

- `priority:` High / Medium / Low. High = the feature's main path or anything that fails silently on screen;
  Medium = secondary paths; Low = empty states and cosmetics. Write rows High first.
- `area:` the feature in 2–4 words ("Replace photo", "US arrival gate"). The group supplies the PR number.
- `test:` what to test, 3–7 words, a verb phrase ("Replace an existing photo"). This is the row's headline.
- `where:` the route path (the link). Optional when the group's route applies.
- `do:` the steps, one or two sentences, starting by naming the screen in plain words ("Open Sample Photos, …").
- `expect:` one sentence: what he sees when it works.
- `shot:` (optional) the screenshot the run took for this row, as a path relative to the manifest (for example
  `evidence/2026-10-05-planner-pool/shots-2.3/c3-example-week.png`). It may sit on the check row or at the end of
  the row's RESULT line (`PASS — 839 cartons · shot: shots-2.3/c3-example-week.png`); the RESULT one wins.
  `review-checklist build` copies the file beside the plan (`assets/<plan>-review/<group>/`) and shows it in the
  row as a thumbnail that opens full size, so the user sees the evidence on the page instead of opening the app
  (his rule, 2026-10-05: the run already verified the screen). A missing file is named in the row, never a broken
  image.

Vocabulary: **plain words only**. No table, column, RPC, function or file names; no SQL; no migration numbers,
error codes or SQLSTATEs; no "RLS", "ledger", "trigger", "UUID", "row id". Say "message" or "confirmation",
"button", "tab", "slot", "column", "box (LPN)". Status names as the screen shows them ("Delivered to Customer").
An empty state is its own Low row, never folded into another row as a "companion".

Three sections:

- `CHECKS` — front-end rows only, what he does on a screen and sees with his eyes. 6–14 per PR.
- `HUMAN-ONLY` — same labels; things only a human on the floor can do (a real scanner, a printer, a physical
  box, a login only he has). Listed under "Still needs a human check".
- `AGENT-ONLY` — the backend: SQL counts, the migration ledger, role gates, storage listings. `where: SQL
  editor (main)` (or a bucket path), `do:` the exact query, `expect:` the value. **The agent runs these**
  (via `/verify` or by hand) and the page shows them collapsed under "Checked by the agent, not you" with
  their status; they never count as "need you".

Older forms still parse: `where: … · do: … · expect: …` (the expect becomes the headline), `do → expect`
(where = preview, else route), or a plain sentence (the sentence is the expectation). A group without any
`test:` label renders in the older list layout; with one, as the table. Rules from `/verify-changes` still
hold: falsifiable ("the page works" is not a check) and behavioural over existence.

## Status mapping

| RESULT | chip |
|---|---|
| `PASS` / `ok` | verified |
| `FAIL — reason` | failed, reason shown under the row |
| `blocked-by-Cn` | blocked by Cn |
| anything else / absent | not run |
