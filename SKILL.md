---
name: lavish
description: Turn complex or visual agent responses into rich, reviewable HTML artifacts the user can annotate and send feedback on, using the lavish-axi CLI. Use when about to give a plan, comparison, diagram, table, code diff, report, or anything easier to grasp visually than as prose.
---

# Lavish Editor

Lavish Editor helps agents turn rich HTML artifacts into collaborative human review surfaces. Whenever you are about to give user a complex response that will be easier to understand via a rich / interactive page, consider using Lavish Editor. First generate an interactive HTML artifact according to user request, then run `lavish-axi <html-file>` so the user can visually review it, annotate elements or selected text, queue prompts, and send feedback back through `lavish-poll`.

## Local tooling (set 2026-08-26, extended 2026-09-02) - READ FIRST, overrides the stock commands below

lavish-axi is **pinned and patched on this machine**. Never run `npx -y lavish-axi`: npx re-resolves
"latest" on every launch and would silently swap in an unpatched build. Use the bare bin
`lavish-axi` (global install in `~/.local/lib/node_modules/lavish-axi`, version in
`~/.claude/skills/lavish/tools/pinned-version.txt`). If a lavish-axi message says to run
`npx -y lavish-axi ...`, run `lavish-axi ...` instead. Tools live in `~/.claude/skills/lavish/tools/`,
their CLIs are on PATH via `~/.local/bin`.

### No browser tab (Marcus, 2026-10-11)

`lavish-axi` on this machine is the shim `tools/lavish-axi.mjs` (`~/.local/bin/lavish-axi` points at it): it runs the
pinned, patched editor with `LAVISH_AXI_NO_OPEN` set, so **opening or resuming a session never opens a browser tab**.
Marcus reads every plan and review page inside Manager Marcus's Plan tab (and on the Lavish home page); a tab per
rebuild only stacked stale tabs on 127.0.0.1:4387 until Chrome's six-per-host pool was full and pages stopped loading.
Pass `--open` only when he asks for a tab. Mention the page's place in Manager Marcus when handing it over, not a URL to
open. Diagrams: author them as `pre.mmd` (the template does), never `.mermaid`, unless he asked for an editable
whiteboard: the editor turns every `.mermaid` container into a 7.5 MB whiteboard frame with its own long-poll.

### Commands

- **`lavish-poll <html-file> [--reply <n> "..."]... [--agent-reply "..."] [--label "..."]`** REPLACES
  `lavish-axi poll`. Same arguments, same local API, but first it (1) **saves a version snapshot** of the
  artifact under `~/.lavish-axi/versions/<key>/` when the content changed since the last snapshot
  (`--label` names it, e.g. `--label "round 2: facts panel, expected dates"`), then (2) appends every
  delivered item and every agent reply to `~/.lavish-axi/history/<key>.jsonl`, the durable transcript (the
  server deletes prompts on delivery). Never call `lavish-axi poll` directly.
  **Run it from the working session** (the session that owns the plan), never from a helper session: every run stamps
  `CLAUDE_CODE_SESSION_ID` on the plan's registry record, which is what the home page's Resume uses to find you.
  **Threaded replies:** `--reply <n> "<text>"` (repeatable) answers item n of the LAST delivered batch, in
  the receipt's numbering; the Comments rail attaches it under that sent comment, so answer every item
  that deserves one and keep `--agent-reply` for the round summary.
  **Suggestions:** a delivered item with `tag: "suggestion"` means the reviewer edited the text: its `text`
  is the element's current text, its `prompt` the replacement. Apply it VERBATIM (no rewording), and only
  raise it if the change contradicts something else in the document.
  **Verdicts:** `tag: "verdict"` ("Review verdict: Approve" / "Request changes") arrives with the batch and
  already set the plan status on the home page; treat Approve as the go-ahead for the next step.
- **Every `--agent-reply` starts with a receipt** of what was received, one line per item
  ("Got 3 items: Facts panel, Expected dates, vocabulary."), then what changed. The wrapper prints
  the exact receipt line to use.
- **`lavish-meta <html-file> [--status <s>] [--priority high|normal|low] [--retire] [--pr <n,n>] [--summary "..."] [--progress "..."] [--pct n] [--session "<label>"]`**
  records what happened to a plan so the home page, the Lavish top bar and the plan page can show it
  (sidecar `~/.lavish-axi/registry.json`; no artifact edit, so no reload in the reviewer's tab).
  **Stage** is derived from the status and shown everywhere: Planning (not-started, in-review, approved) ·
  Developing (in-progress) · Review (merged, awaiting verification) · Done (implemented) · Parked.
  **Progress log**: status and PR changes log themselves; `--progress "<what happened>"` adds a note with the
  writer's session label (`<branch or worktree>@<host>` from your cwd, or `--session`). **Required
  milestones**, each one call: plan approved (`--status approved --progress "approved; starting PR1 <scope>"`),
  each PR opened (`--status in-progress --pr <n> --progress "PR <n> opened: <scope> (k of m)"`), gates green
  (`--progress "PR <n>: preflight green, awaiting review"`), each PR merged (`--progress "PR <n> merged (k of
  m)"`, the last one with `--status merged`), verified live (`--status implemented --progress "verified on
  prod: <what>"`), and any blocker (`--progress "blocked on …"`). Statuses, in lifecycle order: `not-started` ·
  `in-review` · `approved` · `in-progress` · `merged` (its PRs are on main) · `implemented` (verified live)
  · `retired` · `superseded` (old names draft/shipped/parked still accepted). **Required touchpoints:** when
  you open a PR that implements a plan → `lavish-meta <plan> --status in-progress --pr <n>`; when the
  plan's last PR lands → `--status merged`; once verified on prod → `--status implemented`; when a newer
  plan replaces it → `--status superseded`. Without these the home page infers a status (dashed chip
  with "?") from PR states and review activity, and only finds PRs that agent replies mention as `#NNN`.
  A plan declared in-progress whose every known PR is merged is shown as merged automatically.
- **`lavish-axi end <html-file>`** when a review is finished (final feedback applied, or the user says
  done). The home page flags sessions open for 14+ days as stale.
- **Upgrading**: `tools/lavish-upgrade.sh [version]` installs, re-applies the patch, rolls back if an
  anchor no longer fits. Only when the user asks. `node tools/patch-lavish.mjs --check` reports patch state.
- **Moved artifacts**: sessions are keyed by the file's real path. If a folder is renamed, run
  `tools/relink-paths.mjs --dry-run` then without the flag (it stops the server, backs up `state.json`,
  moves sessions, history, private notes, versions and registry records to their new keys).
- **Tests**: `node --test ~/.claude/skills/lavish/tools/test/*.test.mjs` (a file glob: this Node does not take a directory).

### What the reviewer sees (the patched chrome)

- **Theme**: light, Instagram palette (white surfaces, near-black text, blue accent) instead of the stock
  black + brass; the annotation card inside the artifact matches.
- **Comment mode** (top bar, "Agent | Notes"): in Agent mode what the user writes on an element is queued
  for the agent; in Notes mode everything he writes is a private comment. The annotation card follows the
  mode: Enter (or the round send button) queues in Agent mode and saves a private note in Notes mode.
- **The comment box is Figma's** (Marcus, 10 Nov 2026; `sdk:card-figma*` in `patch-lavish.mjs`): one rounded field
  that says "Add a comment" and a round send button. No heading, no hint line, no Cancel and no Keep private:
  **Enter queues, Esc closes the box, with text in it too**, and a private note is made from Notes mode. Empty,
  the paperclip (attach), the pencil (Suggest edit, on text) and the send button sit beside the field; with text,
  the field takes the whole width and they move to a row below. The hint line appears only to report an
  attachment error.
- **Comments rail** — a column between the artifact and the Conversation panel, toggled with the
  "Comments · n" button; it opens by itself the first time a comment exists. Every comment is a card
  anchored to an element, Google-Docs style: commented elements carry a faint tint and a numbered pin,
  **clicking a card scrolls the artifact to its element and highlights it** (Esc clears), clicking a pin
  selects the card, cards follow document order.
  - **Private** comments: Notes mode, "+ Private note" for a general note, "Keep private" on a queued card, or
    `window.lavish.privateNote(text, opts)` from artifact code. Saved on this machine
    (`~/.lavish-axi/notes/<key>.json` through the home page; localStorage while it is down). **They are
    never delivered to the agent — do not read `~/.lavish-axi/notes/` unless the user asks you to.** They
    survive reloads and revisions; when their element is gone they move to a collapsed "Detached" group.
  - **Queued** comments: the send queue, as editable cards (Edit, or double-click; Keep private; Remove).
    Clicking a pill in the Conversation panel opens the same editor. **Suggestions** ("Suggest edit" on the
    card: the element's text prefilled, the user edits it, "Queue suggestion") show as old → new.
  - **Images on comments**: while editing a card, "Attach image" or paste. Agent-bound comments use Lavish's
    own attachment store, so the agent receives them as `attachments` on the prompt (fetch
    `GET /api/<key>/attachments/<id>` on :4387 when the image matters). Private comments store theirs through
    the home page (`~/.lavish-axi/notes/<key>.files/`), never on the Lavish server. Moving a comment between
    the two copies the images across.
  - **Filters** (All · Private · Queued · Sent) at the top of the rail; the top-bar mode switch shows live
    counts (Agent = queued + sent, Notes = private) so the active mode and its load are visible at a glance.
  - **Sent** comments stay as a record with the agent's threaded replies under them, Follow up and
    Resolve. Send adds a "You · sent annotation" bubble at once and the chat re-sync merges the local
    record back in, so sent items never disappear from the chat.
  - **Verdict** next to Send: Comment (default) / Approve plan / Request changes. Approve and Request
    changes travel with the batch as a `verdict` item and set the plan status (approved / in-review).
- **Version chip** in the top bar ("v4 · round 3"): the version of the plan on screen and its review round;
  hover shows when it was saved and how it was edited, click lists every version with "view" and "what
  changed" links. Opening a page snapshots the file if it changed, so the number is always current.
- **Stage chip** next to it ("Developing · 2 of 5 PRs merged"): the plan's stage, hover for the latest
  progress note and who wrote it, click for the four-step strip, the working session and the last eight
  entries. The plan page itself carries the same strip under its header (template `.stage`) and a stage pill
  in its summary bar, live inside Lavish and frozen in exports.
- **Unsent comments survive leaving the page.** Queued comments, their images and a half-written annotation
  card are mirrored in the browser and on the home page (`~/.lavish-axi/queue/<key>.json`) and restored the
  next time the session opens, from any browser, with a "Restored N unsent comments" notice; images of unsent
  comments get a private copy and are re-uploaded to Lavish at Send if Lavish expired them (it keeps
  unreferenced uploads 7 days, less under disk pressure). They are NOT delivered until Send. **`~/.lavish-axi/queue/`
  is off-limits to the agent, like `notes/`.**
- **Export with options** ("Export" in the plan's summary bar, or "Export with options…" in the overflow
  menu): Markdown, self-contained HTML, or PDF (rendered by the home page with the headless Chromium on this
  machine), each optionally with appendices that are off by default and separate from the plan: the agent
  conversation, the comments sent, the private notes with images; unticking "the plan" exports only that
  review material (`/export/<key>?plan=0&include=…`). The stock "Export standalone HTML" menu item stays as
  the plan-only path.
- **Home** link and **Chat** show/hide in the top bar; **Version history** / **Lavish home** in the
  overflow menu.
- Pasting Google Docs / rich HTML into the composer or an annotation card converts to Markdown.
- **Patch layers and restarts**: `chrome-client.js` / `chrome.css` are read from disk per request, so
  chrome changes are live on reload. The SDK inside the artifact (pins, tint, card buttons, modes,
  detached detection) and server changes load once per server process: they need `lavish-axi stop` and a
  fresh `lavish-axi <file>`. A restart kills every session's in-flight poll on this machine (they re-run,
  nothing is lost). The rail shows a hint while the SDK is still the old one. After editing `rail.client.js`
  or `rail.css`, run `node tools/patch-lavish.mjs --reapply-rail` (live on reload, no restart). To change an
  SDK or server edit that is already applied, reinstall the pinned version first
  (`npm i -g lavish-axi@$(cat tools/pinned-version.txt)`) and run `node tools/patch-lavish.mjs` again.

### Home page — `http://127.0.0.1:4388` (`tools/lavish-home.mjs`, launchd `com.marcus.lavish-home`; Drive-style "Sheet" layout since 2026-09-05, plan `.lavish/2026-09-05-lavish-home-redesign.html`)

- **Layout**: white ground, Schibsted Grotesk + IBM Plex Mono. A **sidebar** (All plans · Active now · **projects with
  their plans nested**, 5 newest each + Show more, drag a project onto a project or a plan onto a plan to reorder
  (saved server-side; the tables follow), click a project to collapse it (remembered), hover a plan for its preview
  card, drag the edge to resize, a hide button and ← → that step through the plans in sidebar order (also the arrow
  keys outside a text field) · **Tags** with counts · "+ New tag"). Then one **Drive-style filter row** (Agent · Stage ·
  Plan · Priority · Lavish · Tags as popovers; nothing moves when one opens) with a **Columns** button, and one table
  per project (5 newest rows on the home view + "Show 10 more"; a project page lists all). Default columns: **Plan**
  (title + v{n}, `high` pill; hover for summary, Plan/Build with their reason, PRs, review counts, latest progress,
  agent, path — the card is drawn at page level so no table clips it) · **Plan status** (dot + word; the select
  appears on hover) · **Build** (D4: Not started · Developing · PR open · Merging · Merged · Needs review · Verified,
  derived from status + PR states) · **Session** (name, then Model · place · N tabs) · **Modified** · **Added** ·
  **Actions** (View · Resume · ⋯). Recorded but off by default, from the Columns button: Tags · Priority · Project ·
  Completed · Retired · Versions · Reviews. Double-click a header to sort (asc → desc → newest first; status columns
  by stage order; remembered). Right-click a row (or Shift+F10, or ⋯) for Open in Lavish · New session… · Restart ·
  Log · Tag › · End session and close tabs · Close other tabs · Retire. Column widths, columns, sort, sidebar width,
  hidden state, collapsed projects and the palette (◐) are remembered per browser. Every text/background token pair
  is checked at startup for WCAG AA 4.5:1 (`node tools/lavish-home.mjs --check-contrast`); a failing pair stops the
  server with the pair named. Fluid width, no horizontal scroll at 1280 px.
- **Tags** (`~/.lavish-axi/home-layout.json` v2, separate from the registry so `lavish-meta` can never clobber it;
  a v1 folders file migrates on first read and is kept as `.v1.bak`): a plan carries any number of tags; create one in
  the sidebar, assign from the row menu's Tag › (ticks), the plan page's tag row, or by dragging a row or a sidebar
  plan onto a tag; `?tag=<tid>` filters. `PUT /api/layout {op: tag|untag|tag-create|tag-rename|tag-delete|
  order-projects|order-plans}` behind all of it.
- **Agent link** (`registry.json` → `agent` + `agents[]`): `lavish-poll` and `lavish-meta` stamp the session
  that ran them (Claude from `CLAUDE_CODE_SESSION_ID`; Codex by matching the newest live rollout of the folder). The
  page reads liveness from `~/.claude/sessions/<pid>.json` + a pid check and from Codex's writer locks; "in terminal"
  = its tmux session exists. **The model comes from the transcript** (last assistant `message.model` in
  `~/.claude/projects/<slug>/<id>.jsonl`, Codex `session_meta`), cached by mtime, named through `models.json`; the
  remembered launch choice is the fallback, marked "(remembered)". **Run `lavish-poll` / `lavish-meta` from the working
  session** so Resume knows who you are: a session that only reads a plan is linked only by the bounded transcript scan
  (last 7 days of the plan's project folder, Read/Edit/Write targets only; at startup, hourly, and "Find sessions" on
  the plan page) and shows dotted until it polls for real. Every history row carries `agent {provider,id}`; when the id
  changes, the poll posts one "session changed: now <name> · <provider>" line into the chat.
- **Browser tabs**: every Lavish tab pings `PUT /api/presence/<key>` every 10 s (the patched chrome); the row shows
  "N tabs". **End session and close tabs** (`POST /end/<key>?close=1`) and **Close other tabs** mark them; a marked tab
  closes itself on its next ping (a page can close only itself; a tab whose history is longer than one entry shows a
  notice instead). **Restart** (`POST /restart/<key>`, D10) refuses while the plan's agent is live anywhere; otherwise
  it ends the Lavish session, marks the tabs, and starts a NEW session with the plan's remembered provider / model /
  effort and the default prompt, logging "restarted by the home page" in the registry.
- **View** = `/view/<key>/`: the plan as it is on disk, no Lavish chrome, no session change; relative assets beside
  the plan are served, nothing outside its folder. **Resume** (`POST /connect/<key>`, model + effort remembered per
  plan): live in tmux → Terminal.app forward and the plan in Lavish · live in VS Code/Cursor/Desktop → the plan in
  Lavish only, with a page saying so (a second writer would corrupt the transcript; nothing is spawned) · ended → `tmux
  new-session -s mm-claude-<8>` (or `mm-codex-<8>`) running `claude --resume <id> [--model --effort]` (or `codex
  resume <uuid> -m … -c model_reasoning_effort=…`) in the transcript's folder, Terminal.app attached, then the plan in
  Lavish. Same tmux names as Manager Marcus, so the two tools cannot double-resume. Refusals are pages naming the
  reason (folder missing, binary missing, Codex thread open in the app, tmux error verbatim). **New session**
  (`?new=1`, in the plan page's Resume block; `GET /connect/<key>` redirects there): provider, model, effort, folder
  and a first prompt (default: open this plan in Lavish and poll it) in a fresh tmux terminal; Claude gets a chosen UUID
  stamped at once, Codex is matched by folder on its first poll. **Model lists live in `~/.lavish-axi/models.json`**
  (seeded: Claude Fable 5.1 · Opus 5 · Sonnet 5 · Haiku 4.5, Codex GPT-6 Astra · Sol · Terra · Luna; efforts per
  provider, Claude adds Max; a new model is one line; free text stays accepted). The model, effort and folder fields
  are typeable comboboxes (arrow keys, Enter; the folder one suggests recent folders); **Choose in Finder…** runs an
  async `osascript choose folder`. Terminals this page starts are listed in `~/.lavish-axi/terminals.json`.
- **Plan page** (`/session/<key>`): the same sidebar, title + v{n} + **Rename** (rewrites the file's `<title>`,
  snapshotted before and after), the stage line, an **Agent** block (state, session · provider · model, folder,
  started; Change effort types `/effort <level>` into an OWNED Claude terminal only while its pane is at the prompt;
  plan-status form; tags), the **Resume + New session** block with Restart, a **Sessions** table (model · where ·
  started · last ended · browsers, from the transcripts), **History** (registry log status/PR/notes, PR merges, first
  version, session starts and ends, terminals; hover a row for its source), **Versions** (Version · Saved · What
  changed · Comments · View · Diff · Continue from ▾), Commits / Unsent / Export folded, and the **Conversation** with
  the private comments in place by time.
- **Versions** are saved by `lavish-poll` at every round and by the home page's 20-second scan, deduplicated by
  content. `/version/<key>/<n>/` shows the snapshot in an iframe beside that moment's comments, messages, replies and
  private notes, with **Continue from ▾**: just restore · restore and Resume · restore and start a New session
  (`POST /restore/<key>/<n>?then=resume|new`). Restore snapshots the current file first, then writes the chosen
  version over it; the Lavish tab offers a reload, but **the agent is not told** (the history file gets a `restore`
  entry).
- **Naming rule for new plans (D8)**: the `<title>` says what the plan decides, entity first, 3 to 7 words, no dates
  or codes ("Samples shipments, bins, ladder and lists", not "2026-09-04-samples-logistics-and-lists"). Existing plans
  keep their titles until renamed on their plan page.
- **Front-matter for new artifacts**: `<meta name="lavish:project" content="your-project">`,
  `<meta name="description" content="one sentence: what this plan decides">`, optionally `lavish:related`. Status and
  PRs go through `lavish-meta`.
- `/api/sessions` carries `tags [{id,name}]`, `tabs`, `build`, `added` and `agent {provider,id,state,name,model,
  terminal,tmuxName,…}` per plan (Manager Marcus's terminal canvas reads it). Mention the home page when handing over
  an artifact.

## Request



If the request above is non-empty, the user invoked `/lavish` explicitly - build an HTML artifact for that request now, following the workflow below.
If it is empty, infer what to visualize from the conversation.

## When to use

Use lavish-axi when the user asks for a visual artifact, HTML explainer, interactive prototype, review surface, product or technical plan, comparison, report, or browser-based feedback loop

## Workflow

1. Create the HTML artifact (default location `.lavish/<name>.html` in the working directory; StyleManager plans live in `docs/plans/`). Include the front-matter meta tags above.
2. Run `lavish-axi <html-file>` to open or resume a review session in the browser.
3. Run `lavish-poll <html-file>` (the local wrapper, never the raw `lavish-axi poll`) to long-poll for the user's annotations, queued prompts, and browser-proven severe layout failures returned as `layout_warnings`. It snapshots the artifact version and appends everything delivered to the session's history jsonl before printing it.
   On the first poll, prefer `--agent-reply "<one-line summary of what you built and what to review first>"` so the conversation panel opens with context.
   The poll stays silent until the user acts or the real browser proves meaningful content is inaccessible or unusable - leave it running, never kill it.
   Cosmetic, intentional, transient, tiny, and uncertain observations remain silent.
   Keep the poll in the foreground by default and let it return the feedback directly to the agent.
   A background poll is allowed only through a harness-native tracked background-job facility whose completion result is guaranteed to resume or notify the same agent (in Claude Code: Bash `run_in_background`).
   Never use `nohup`, shell `&`, `disown`, redirected fire-and-forget processes, or a detached terminal without an explicit verified callback merely to keep polling alive.
   If the harness has no completion-aware background facility, use the foreground poll or first wire a verified wake callback into the surrounding supervisor.
   Do not tell the user the artifact is being monitored until that wake path is live.
   If the poll gets killed or times out anyway, just re-run it - queued feedback is never lost.
4. If poll returns `layout_warnings`, follow the returned `next_step`: repair the severe failure and re-check it before involving the human.
5. Apply human feedback, then poll again with `lavish-poll <html-file> --reply 1 "<answer>" --reply 2 "<answer>" --agent-reply "Got N items: <one line each>. <what changed>" --label "round N: <what changed>"` to answer each comment under its card, reply in the browser, name the new version, and keep the loop going under the same foreground-or-verified-wake-path rule. Suggestions (`tag: "suggestion"`) are applied verbatim.
6. When implementation starts from the plan: `lavish-meta <html-file> --status in-progress --pr <n>` for each PR; `--status merged` when the last one lands; `--status implemented` once verified live.
7. Run `lavish-axi end <html-file>` when the review is finished (required; the home page flags sessions left open).
8. `Send & End` ends the session. Its final feedback is still delivered once. After that response, polling stops, and the agent must not reopen the session uninvited. Deliver any remaining updates directly in this conversation.

## Visual guidance

- Use visual hierarchy to make the most important decisions, risks, tradeoffs, and next actions obvious at a glance
- Use visual structure such as sections, cards, tables, diagrams, annotated snippets, and side-by-side comparisons instead of long prose
- Choose typography, spacing, color, and layout deliberately so the artifact has a clear point of view
- Prevent horizontal overflow at every nesting level: nested grid/flex children also need minmax(0, 1fr) tracks and min-width: 0, especially when badges, labels, or status text use wide pixel or monospace fonts; wrap, truncate, or contain long unbreakable text deliberately
- When the artifact would describe existing or current UI or state, show it instead: capture screenshots of the real pages (run the app read-only if needed) and embed them, rather than explaining the current look in prose; reserve prose for what cannot be shown such as rationale, trade-offs, and open questions

## Design direction (local preference - overrides the stock look)

Stock component-kit themes read as generic AI output. Artifacts should feel deliberately designed, like an editorial document, not a DaisyUI demo:

- Palette: a neutral, paper-like base (warm off-white in light mode, deep neutral gray in dark mode), near-ink body text, and ONE restrained accent (deep blue, teal, or oxblood) used sparingly - links, key figures, active states. If everything is highlighted, nothing is.
- Never use yellow or gold as the theme accent, and never pick gold-accent themes such as DaisyUI `luxury`. Yellow/amber is reserved for content that genuinely warns of something, applied as a muted tint on a small element - never as large amber text blocks or decorative badges.
- Typography carries the hierarchy: a distinctive display face for headings, a clean sans (or quiet serif) for body, generous line-height, and real size contrast between levels. Separate sections with whitespace and hairline rules in preference to boxes. Skip the AI-convergent faces (Inter, Roboto, Fraunces, Geist, Plus Jakarta Sans, Space Grotesk) - pick faces with personality (e.g. Newsreader, Public Sans, Spectral, IBM Plex).
- Write the copy like an editor, not a model: em-dashes at most twice per page, no arrow chains in prose, no exclamation-mark enthusiasm.
- Tables stay quiet: tabular figures for numbers, one delimiter style (hairline OR faint zebra, not both), badges only where a status genuinely needs one.
- Avoid the generic-AI tells: uniform grids of identical rounded cards, badge/emoji confetti, alert components wrapping non-alerts, gradient hero banners, and every section boxed in its own card.

## Plan-artifact template (local requirements, set 2026-07-22, skeleton approved 2026-09-02, layout and page register 2026-11-10)

**Decisions in two places (Marcus, 2026-10-16).** Every decision is asked where the plan discusses it as well as under
Decisions: in that section put `<div class="dmirror" data-decision="<the form's data-lavish-question>"></div>`. The template
shows the same question there; answering either copy updates both, either Queue sends the one answer, and the export lists
it once. Plan generators that replace the template's `<main>` must keep the template's script, which does this.

**Review tabs (2026-10-14).** The template carries a `review-view` block before the Feedback log; when you copy the
template to `<name>.html`, change `plan-template` in that block's script path to `<name>` (the two marker lines and the
two lines between them otherwise stay exactly as they are). After the plan's first build, `review-changes page` writes
`assets/<name>-review/view.js` beside it and the plan page shows Plan | Review N | Pull requests N, with comments and
chat working on every tab because it is one Lavish page. A plan with no review yet shows no tabs.

**Start every plan from `~/.claude/skills/lavish/tools/plan-template.html`** (copy it, keep it a single
self-contained .html: vanilla JS, no build step, the Mermaid CDN as the only external dependency, opens
directly with no server). Reference implementation of the skeleton: StyleManager
`.lavish/2026-09-02-lavish-planning-upgrades.html`; of the 2026-11-10 layout and register: StyleManager
`docs/plans/2026-11-10-plan-layout-example.html` (an example built by hand, before the register was data).
The skeleton, which the user approved on 2026-09-02 and revised on 2026-11-10:

- **Front-matter**: `<title>` (the naming rule, D8 of the home redesign: what the plan decides, entity
  first, 3 to 7 words, no dates or codes — the home page and the Lavish tab show it verbatim; a plan can be
  renamed later on its home plan page), `<meta name="description">` (one sentence, the home page shows it),
  `lavish:project`, and `lavish:related` when it builds on another plan.
- **Two bands, in this order** (Marcus, 2026-11-10: he reads the designs, the decisions and what is open; he
  reviews designs in Figma and trusts the build plan). **For the reader**, open: Read this first · The pages
  (only when the plan draws screens) · Decisions (every decision card, recommended option pre-checked, decided
  ones keep their answer via `data-decided`; the standard `table.alts` for alternatives: Option · What it buys ·
  What it costs, `tr.rec` marks the recommendation) · Open questions · Risks and what to review (ordered by how
  silently it fails; what could not be verified is named). Then the line `div.band#builder` "For the builder",
  and **for the builder**, closed by default: Current state (verified against code, file paths) · Design ·
  Execution · Plan by PR · Feedback log. Never delete the builder sections: other sessions and the planning
  flow read them. A choice that is hard to undo (the shape of the data, money, a migration) is never left
  below the line: it goes to the reader as a decision in plain words. Section titles carry no numbers.
- **Header**: the `h1` is the plan's NAME in three to eight words (`<br>` after a colon is fine), never a
  sentence. The sentence goes in `p.lede` (one or two). The facts go in `.meta > dl.kv`, label beside value:
  For · Date and version · From (the request, brief or pins answered) · Scope · Builds on.
- **The answer** (`.answer`): ONE sentence in `p.answer-lead`, then three to eight points in `dl.kv.points`
  (a two-to-four-word label, a one-line value), then the counts in `p.answer-count`. No paragraph of 200
  words. The reader's own words go under "In your words" in `.said` (`span.when` + `q`), quoted as written.
  `.example` takes a title in `p.ex-title` and the case followed through its places in a `dl.kv`.
- **Label beside value everywhere** (his pin of 7 November 2026): facts, key points, a page's details and a
  worked example are `dl.kv` rows (`<div><dt>label</dt> <dd>value</dd></div>`), never a value under its label.
- **Width**: the page takes the whole window; prose stops at 70 characters, tables and decisions at 1,120 px,
  pictures run to the right edge. Do not set a `max-width` on `.page` or `main`.
- **The pages: a register, not a gallery** (section `data-sec="The pages"`, his notes of 2026-11-10). One
  entry per PAGE, listing every drawing of it oldest first, as JSON in `<script type="application/json"
  id="plan-pages">`; the template draws the cards, the filters, the outline rows and the preview into
  `#planPages`. A page a round does not touch STAYS in the list: that is how he finds the latest version of
  every page, and it is the reason the register exists. Carry the JSON forward from the previous plan of the
  same work and add this round's drawings to their pages; never start a new list of only this round's frames.
  The fields: `round` (the current round) · `figma` (the file's URL up to `node-id=`) · `assets` (the pictures'
  folder, relative to the plan) · `groups[]` (`id`, `letter` = the Figma section's letter or "", `name`,
  `short` for the outline) · `pages[]` (`group`, `title`, `does`, `fig`, `decisions`, `final`, `retired`,
  `drawings[]`) · `drawings[]` (`round`, `at`, `file`, `node`, `w`, `h`, and `problem` / `solution` /
  `changed`, or one line in `note`). The rules:
  - **State is derived, except two.** New = one drawing, of this round. Revised = several, the last of this
    round. Unchanged = the last is of an earlier round. `retired` (a sentence: why, and what replaced it) only
    when he retired the page; `final` (the day he said so, "9 November") only on his word, and a later pin removes it.
  - **A page is what he would call one page.** When a round redraws a page under a new file name, add the
    drawing to the SAME page. Two variations of one round are two pages until he picks one.
  - **Every drawing has its day and hour** in `at` (local time, `YYYY-MM-DDTHH:MM`, when the picture was
    saved): he edits many things in one day and tells rounds apart by the hour.
  - **Every page says what it does** in `does`: one plain sentence a reader who does not code can follow.
    **Every drawing of this round says** `problem` (what was wrong or missing, in his words where a pin said
    it), `solution` (what the drawing does about it) and `changed` (what differs from the earlier drawing, or
    "New page."). Do not invent a problem the sources do not state; say what the drawing set in `note` instead.
  - **Pictures are whole pages**, top to bottom, never cropped, with `w` and `h` so a lazy picture keeps its
    place. A click opens the page over the whole window with its details, its comment count and its decision
    cards beside it; a comment made there stays attached to that page (the template moves the picture and the
    details into the preview and back, and both carry ids).
  - **`fig`** numbers this round's pages in reading order; "figure 3" and "figures 3–5, 8" anywhere in the
    text then link to the card by themselves.
- **Decisions point at what they are about**: the number in `span.dn`, the question and `p.why` in `.dq`, the
  options in `.dopts` (lead words in `<b>` inside `span.opt`). `data-place="<a heading or section name>"` on
  the form names where the plan discusses it; a page lists its decisions in `"decisions": ["D1"]`. The
  template then writes "Refers to: Figure 1 · the plan: <place>" under the question, shows a "To decide" row
  on the page's card, and puts the same card (a `.dmirror`, so one answer) in that page's preview. "D5"
  anywhere in the text links to its card. A card written the short way (`h4` "D1 · …", `p.why`, labels) is
  wrapped by the template.
- **Links that jump**: write a reference to a place in the plan as `<a href="#id">` and give the target an
  `id`; the template opens the target's section, scrolls to it and outlines it. With Annotate on, Lavish turns
  a click on anything but a button or a form control into a comment, links included, so anything of your own
  that must stay clickable carries `data-lavish-action` (the template sets it on the outline, on `href="#…"`
  links and on its own controls). A modal `<dialog>` sits above Lavish's comment card: never use one for
  something the reader should be able to comment on.
- **A comment pinned to a spot of a page** (10 Nov 2026): in the preview, with Annotate on, a click on the picture
  anchors the comment to a small marker at that point, not to the whole picture. Nothing to author: the template
  makes the marker, shows it on the thumbnail too, and rebuilds every marker from the comments' selectors on load
  (no storage). **Reading one as the agent:** the item's selector ends in `#spot-<page>-x<n>-y<n>`, where `<page>`
  is the page's id (its Figma node with `-` for `:`), and x and y are thousandths of the picture's width and
  height from its top-left corner; its `text` says the same in words ("Pin at 42% across, 29.4% down on
  <title>"). Open that page's picture and look at that place before answering (crop around it when the picture
  is tall); a comment on a spot is about what is drawn there, not about the page as a whole.
- **Execution section** (`details[data-sec="Execution"]`, between Design and Plan by PR): which agents are
  started, in what order and in which lanes, with ONE diagram (one box per agent, an arrow for "waits for"),
  a table of the same (order, lane, agent, what it does, when it starts), and a paragraph headed "What you
  will see in Manager Marcus" that says what appears on the page while the plan runs and what done looks
  like. Write it as instructions someone could follow: Manager Marcus's planning flow reads this section and
  gives it to the planner as the draft of the coordinator's hand-off, so the plan and the hand-off stay one
  document; a plan that says nothing here leaves the coordinator to guess. Keep the `data-sec` value exactly
  `Execution`, because that is what the flow looks for. Name roles and lanes, not model ids or dates: those
  change, and the settings decide them when the plan runs.
- **Plain language first** (the user, D13): Read this first and Decisions are written for a reader who does
  not code. Say what will happen and what it changes for the person using the product, in everyday words;
  define a technical term the first time it is needed, or leave it out. File paths, function names, table
  names and other identifiers belong in the evidence sections (Current state, Design, Execution, Plan by
  PR), never in the answer paragraph or in a decision's question and options: the reader decides from the
  answer and the decisions alone, and a sentence they cannot read is a decision they cannot make.
- **Outline rail** (`nav.outline`, built by the template JS from `details[data-sec]`): a rail on the LEFT
  EDGE of the window, as tall as the window, with one entry per section, its review-status dot, the tally at
  the bottom, click to jump, active section follows the reading position. Under The pages it lists one row
  per group of the register (the Figma section's letter, its short name, pages drawn this round in blue and
  pages in grey); the builder's sections sit under a "For the builder" label. A Hide button and, below
  1000 px (the Lavish iframe with both rails open), a floating "Outline" button that opens it as a drawer.
- **Every section is `details[data-sec]` with a `summary.h`** carrying `.title`, a one-line `.sum` shown
  only while collapsed, and `.badges` (reading time; `span.risk` for prod-silent areas: RLS, money,
  migrations, Edge deploys). A plan must be skimmable with every section closed.
- **Phase strip** (`.phase` with `span[data-pr="529"]` cells) for plans with more than two PRs: inside
  Lavish the template colours the cells from the home page's registry (merged / open); opened directly
  they stay neutral.
- **Per-section status** (Approved / Needs changes / Question) persists to localStorage best-effort; the
  Lavish iframe has no `allow-same-origin`, so every access is wrapped in try/catch and statuses die on
  reload there. Per-section note textareas are NOT part of the template: the Comments rail's private
  comments do that job for any element, durably.
- **Diagrams**: anything sequential or relational is Mermaid (in a `resize: both` frame) or inline SVG,
  never a bullet list; old vs new is shown as a visual diff (`.diffold` / `.diffnew`).
- **Export** stays visible-first and exports the WHOLE plan: a `<dialog>` with the Markdown in a
  textarea and Copy / Download / "Send to agent" (queuePrompt `tag: "export"`; the agent saves it as
  .md and confirms the path). The register exports one block per page (its latest drawing, state and
  details); `dl.kv` rows export as "label: value" lines. Mermaid sources are stashed before `mermaid.run()` and emitted as fences;
  viewer-only controls are skipped. Never rely on a programmatic download alone (embedded frames block it silently).
- **Feedback log**: the last section; after EVERY poll round that returns feedback the agent appends one
  line per received item with a one-line response, so the exported document carries its review history.
  The durable records are the history jsonl, the versions, and the rail's sent cards on the home page.
- **Stage strip and export dialog** are part of the skeleton: keep the `.stage` block under the header (it
  paints itself from the registry inside Lavish) and the export dialog with its format and appendix options.
- **Explain with examples** (the user, 2026-09-02): when a section explains something unfamiliar or
  complicated, open with a concrete case in an `.example` callout using this project's entities (a linesheet,
  a sample cart, a factory PO, a container), then state the rule. Prefer a chart (inline SVG or Mermaid, per
  the `dataviz` skill) or a table with real numbers to adjectives; put the source link right next to the
  claim it supports; use a picture from the web when it carries meaning, with a caption and its source. Repo
  plans copy web images into `docs/plans/assets/<slug>/` (attribution in the caption); scratch artifacts in
  `.lavish/` may hotlink.
- **Design direction** (above) still governs the look: paper base, one accent, faces with personality,
  hairlines over boxes, quiet tables, no badge confetti. Yellow/amber only for genuine warnings.

## Playbooks

Run `lavish-axi playbook <id>` for focused, detailed guidance on any of these.
One artifact often combines several playbooks (for example a plan that includes a comparison and a diagram), so MUST open each matching playbook before writing HTML.
For flows, architecture, state, or sequence diagrams, do not hand-build boxes-and-arrows from div/flexbox; open the diagram playbook and use the theme-aware Mermaid snippet from `lavish-axi design` unless SVG is needed for richly annotated nodes.

- `diagram` - Map relationships, flows, state, and architecture
- `table` - Turn dense records into scan-friendly review surfaces
- `comparison` - Show options, tradeoffs, and current vs target behavior
- `plan` - Explain a product or technical plan before implementation
- `code` - Render source code, code files, patches, PR diffs, and before/after code inside Lavish artifacts
- `input` - Must be used when the agent needs to collect user input on decisions, choices, preferences, triage, scope, or other structured feedback from within the artifact
- `slides` - Create a deliberate presentation when slides are requested

## Commands & rules

- Run `lavish-axi <html-file>` to open or resume a Lavish Editor session. If the user explicitly ended the session from the browser, this refuses to reopen it and explains why instead of reopening uninvited - pass `--reopen` only when the user asks for further review or something important needs their visual attention
- Unless the user specifies another location, create HTML artifacts in the current working directory under `.lavish/`
- Lavish serves the html file through a local express.js server. If your html needs to reference other filesystem assets such as images, CSS, fonts, and local scripts, copy them into the same directory as the HTML file, then reference them with relative paths from that directory. Never prepend `/` to those asset paths - root paths won't work
- Run `lavish-poll <html-file>` to wait for user feedback or browser-proven severe layout failures. It long-polls and stays silent until the user sends feedback, ends the session, or the real browser proves meaningful content is inaccessible or unusable, so leave it running - never kill it. Repair and re-check every returned layout failure before involving the human; cosmetic, intentional, transient, tiny, and uncertain observations stay silent. Keep the poll in the foreground by default and let it return the feedback directly to the agent. A background poll is allowed only through a harness-native tracked background-job facility whose completion result is guaranteed to resume or notify the same agent. Never use `nohup`, shell `&`, `disown`, redirected fire-and-forget processes, or a detached terminal without an explicit verified callback merely to keep polling alive. If the harness has no completion-aware background facility, use the foreground poll or first wire a verified wake callback into the surrounding supervisor. Do not tell the user the artifact is being monitored until that wake path is live. If the poll gets killed or times out anyway, just re-run it - queued feedback is never lost. `Send & End` ends the session. Its final feedback is still delivered once. After that response, polling stops, and the agent must not reopen the session uninvited.
- Rendered Mermaid diagrams in `.mermaid` containers become embedded, editable Excalidraw whiteboards in the browser (click a diagram to unlock editing; a Fullscreen action opens it over the whole viewport) - flowchart, sequence, class, ER, and state diagrams convert to editable shapes; other types embed as an image to draw on. Scenes autosave locally; when a reload detects a changed Mermaid source, the reviewer explicitly chooses to re-convert and discard saved edits or keep editing the saved scene. Standalone and exported copies still render plain Mermaid. Queue feedback adds a prompt to the Conversation panel; when the user sends it, poll returns a tag "whiteboard" prompt carrying a bounded edit summary plus local scenePath (.excalidraw JSON) and previewPath (PNG) files - read the summary first, open the files only when needed, then apply the edits by updating the Mermaid source in the artifact (never try to write the scene back)
- Run `lavish-axi end <html-file>` to end a session as the agent - ending it this way still allows a plain reopen later. When the user ends it from the browser instead, a later `lavish-axi <html-file>` refuses to reopen it without `--reopen`
- Run `lavish-axi export <html-file> [--out <path>]` to write a portable copy of the artifact - one HTML file with its LOCAL assets inlined - so it opens with no Lavish server and no sibling files. Remote CDN/font references are left as links, so it needs network to render those. Users can also export from the browser chrome's overflow menu
- Run `lavish-axi share <html-file> [--password <pw>] [--token <t>]` to publish the artifact on ht-ml.app (https://ht-ml.app), a third-party hosting service not part of Lavish, and get back a visitable URL. Shares are PUBLIC by default, so anyone with the link can open them. Pass --password to publish a PRIVATE password-protected page; viewers must supply the password to view. Local assets are inlined; remote refs load over the network. It returns the url plus a secret update_key for managing the page later. Use --token or LAVISH_AXI_HTML_APP_TOKEN only when you have an optional bearer token; it is never required. Users can also publish from the browser chrome's overflow menu. **Never run `share` unless the user explicitly asks** (it publishes to a public third-party host).
- Run `lavish-axi stop` to shut down the background server (it also self-stops when idle or after the last session ends with nothing connected). It kills every session's in-flight poll on this machine: check `ps -eo args | grep 'lavish-poll'` first.
- Run `lavish-axi playbook <playbook_id>` for focused artifact guidance. One artifact often combines several playbooks (for example a plan that includes a comparison and a diagram), so MUST open each matching playbook before writing HTML.
- Lavish does not auto-inject any design system - artifacts stay portable so they render identically when opened directly without lavish-axi running. Before writing any HTML: Decide the design direction in this strict priority order, and only move to the next step when the current one truly yields nothing: (1) if the user asked for a specific look or named design system, use that; (2) otherwise you must first inspect the project the artifact is about - the subject or product whose content or UI it represents, which may differ from your current working directory - and match that project's design system: Tailwind or theme config, shared CSS variables or design tokens, component library, brand assets, or existing styled pages. If the artifact previews, proposes, or mocks a specific app's UI, render it in that app's own design system so it faithfully shows the product, even when you are running in a different repo; (3) only when both steps come up empty, use the Lavish-recommended Tailwind CSS browser runtime v4 + DaisyUI v5, available via CDN, and prefer that CDN snippet over hand-writing styles unless explicitly instructed otherwise by the user - but restyle it per the Design direction section above: define a quiet custom theme (neutral base + one restrained accent) with DaisyUI theme CSS variables instead of shipping a stock accent-heavy theme name. Run `lavish-axi design` for a content-to-playbook router, a copy-pasteable CDN snippet, a Mermaid CDN snippet/init for diagrams, and the DaisyUI component reference. When you deliver the artifact, state which of the three design sources you used and why.
- Use lavish-axi when the user asks for a visual artifact, HTML explainer, interactive prototype, review surface, product or technical plan, comparison, report, or browser-based feedback loop


## Saved chats and connections (2026-09-09)

The home page and the editor share a saved-chat picker. Browsing an older chat does not change the active connection; **Resume** explicitly selects it. **New chat** starts a fresh provider session with the plan and a short progress handoff. **Reconnect** retries its existing session without silently starting another.

When a launch or resume prompt supplies `--chat <id>`, keep that flag on every `lavish-poll` call. A superseded response means another chat now owns the plan: stop polling and do not continue editing that plan until explicitly resumed. Only the active chat's delivery token can receive feedback or write replies. Keep an indefinite foreground poll attached while listening; a running provider process alone is not proof of listening.

The chat records live under `~/.lavish-axi/chats/`, separate from the shared skill files. They contain personal session identities and are not part of a public skill distribution. Older unattributed messages remain in Earlier conversation; never infer their owner from the latest agent. Private notes must not be included in handoffs.

GitHub PR and Vercel links referenced in the document or agent replies appear in both plan information and the editor conversation. PR refresh also collects Vercel links from the PR body, comments and check results. Include resulting PR/deployment URLs in plan progress replies so they can be referenced later.

The shared viewer supplies hidden scrollbars, outline section toggles, and Expand all / Collapse all to existing plans. New documents made from `tools/plan-template.html` include the same controls for standalone viewing. `patch-lavish.mjs` installs the shared server/chat patch through `patch-plan-workspaces.mjs`; run the regular patch and `--reapply-rail` when updating an already-patched installation.

A session actively owned by a desktop app cannot be safely resumed by launching a second CLI writer. Reconnect reports that condition and the existing session to use. New/resumed terminal agents remain pending until their actual poll confirms the connection; never claim a successful connection merely because a launch command returned.
