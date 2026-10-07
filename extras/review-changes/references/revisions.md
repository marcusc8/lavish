# Revisions, outcomes and rounds — the conventions the rebuild reads

The page is rebuilt from the manifest and the Lavish history (`~/.lavish-axi/history/<key>.jsonl`, written by
`lavish-poll`). Nothing else is stored, so what you write in your replies is what the page can show. Three
conventions, all parsed by `tools/lib/history.mjs`:

## 1 · A row's outcome is your threaded reply

Marcus's comment on a row arrives as an annotation whose `selector` starts with the row's id
(`li#rv-<group>-C2 > …`) or whose text starts with `C2 ·`. Reply to **that item number**:

```
lavish-poll <plan> --reply 2 "Fixed: the permission was read once at mount; the toggle now re-reads it." …
```

The reply shows under his comment card and, after `review-checklist build`, under the row as
`agent · r2`. Earlier outcomes collapse under "earlier". A reply that starts with **Fixed** or **Done** sets the
`fixed · rN` chip; anything else ("Reproduced, still looking", "Cannot reproduce: …") is an outcome without it.

Notes typed in a row's note box arrive inside the checks batch and show as `you · rN` too.

## 2 · Free-form revisions become R-rows

The revisions box sends one `review` item (`kind: "revisions"`). Reply to it with one line per ask:

```
R1 → C1: the search toggle keeps its state across reloads
R2 → C2: a sound option on the notification
R3: History shows which engine answered the query
```

`R1 → C1` links the item to the row it belongs to; a bare `R3:` is a new row. They render under **Your
revisions** with an `open` chip. Later, close one with a line anywhere in a reply:

```
R2 done: the toggle menu has a sound option
```

Nothing in the box is allowed to vanish: if an ask is out of scope, still give it an R-line and say so in a
`done` line ("R3 done: out of scope for this PR, noted for phase 7").

## 3 · Rounds

`--agent-reply` closes a round (Lavish's version chip shows `vN · round N`); `--reply n` answers do not.
Every round: one `--reply` per delivered item, one `--agent-reply` starting with the receipt line the poll
printed, one `--label "round N: <what changed>"`, and one Feedback-log line per item in the plan page.

## The grade

Per group, computed at build once a checks batch exists: **first pass** = rows that worked on arrival (ticked
in the first batch, or PASS from the verify run) ÷ all rows; **rounds to green** = the batch in which every row
was ticked; **stars** from the last batch. Letter = the worse of the rate band (≥90 % A · ≥75 % B · ≥50 % C ·
else D) and the rounds band (1 A · 2 B · 3 C · 4+ D); stars only lower it (3 → at most B, ≤2 → at most C).
A **D** always yields a lesson candidate (`lessons ingest`).
