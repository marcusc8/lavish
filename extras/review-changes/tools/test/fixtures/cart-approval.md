route:  https://app.stylaos.com/samples/carts/catalog  (PROD — post-merge recovery check for PR #504)
branch: main @ f747b3bd (squash of feat/samples/cart-approval-stages)
mode:   writes declared below
role:   admin (dev-agent)
writes: submit_cart → reject_cart → reopen_cart roundtrip on cart 85df1fe7
        ("Y Combinator Fall 2026", demo customer, 1 item, all state 1, no holds).
        Cleanup: reopen returns cart+item to state 1; samp_req (null before) restored
        to null via SQL after (samp_req is not guarded — only cart_state is).
        Persistent residue BY DESIGN: 3 sample_cart_reviews rows + activity entries
        (the handoff expects the reviews count to start growing).
        NOT exercised: approve_cart — it auto-mints sample_units (irreversible on
        real prod data); it uses the identical guarded-RPC channel proven by the
        other three, and was covered by pre-merge verification + CI.

CHECKS
  C1  signed-in     prod app renders signed-in UI as admin (not login screen)
  C2  open-carts    /samples/carts/catalog lists the YC cart, state "Shopping Cart"
  C3  request       "Request approval" on cart 85df1fe7 succeeds (no guard error
                    toast), cart moves to Waiting for Approval (state 2) — DB-confirmed
  C4  reject        Reject with reason succeeds, cart → Rejected (4) — DB-confirmed,
                    review row carries the note
  C5  reopen        Reopen succeeds, cart → Shopping Cart (1), stamps cleared —
                    DB-confirmed; item back to state 1
  C6  reviews-grow  sample_cart_reviews has 3 new rows (submitted/rejected/reopened)
                    with actor = dev-agent

RESULT
  C1  signed-in     PASS — "Dev Agent (local verification)" chip, full admin nav
  C2  open-carts    PASS — 6 carts listed, YC cart "1 - Shopping Cart"
  C3  request       PASS — advisory confirm (missing request-notes) accepted; cart → 2;
                    "Requested by Dev Agent on Aug 20, 2026"; samp_req auto-filled;
                    DB review row submitted 1→2 @ 05:43:19Z
  C4  reject        PASS — required-note dialog (Reject order disabled until note);
                    cart → 4; "Sent back by Dev Agent — <note>" banner; toast "Order
                    rejected"; DB review row rejected 2→4 with note @ 05:44:28Z
  C5  reopen        PASS — confirm accepted; cart → 1, item → 1, submitted_at/approved_at
                    null; header back to "Request approval"; DB review row reopened 4→1
                    @ 05:44:54Z
  C6  reviews-grow  PASS — sample_cart_reviews 0 → 3 rows, all actor = dev-agent uuid
  console: 0 errors, 0 warnings across the whole run
  cleanup: samp_req restored to null (was null pre-test); cart+item back to exact
           pre-test state; 3 review rows + activity entries remain (by design)
  NOT exercised: approve_cart (auto-mints sample_units on real data; same guarded
                 RPC channel as the three proven above)
