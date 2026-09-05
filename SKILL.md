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
  anchor no longer fits. Only when Marcus asks. `node tools/patch-lavish.mjs --check` reports patch state.
- **Moved artifacts**: sessions are keyed by the file's real path. If a folder is renamed, run
  `tools/relink-paths.mjs --dry-run` then without the flag (it stops the server, backs up `state.json`,
  moves sessions, history, private notes, versions and registry records to their new keys).
- **Tests**: `node --test ~/.claude/skills/lavish/tools/test/*.test.mjs` (a file glob: this Node does not take a directory).

### What the reviewer sees (the patched chrome)

- **Theme**: light, Instagram palette (white surfaces, near-black text, blue accent) instead of the stock
  black + brass; the annotation card inside the artifact matches.
- **Comment mode** (top bar, "Agent | Notes"): in Agent mode what Marcus writes on an element is queued
  for the agent; in Notes mode everything he writes is a private comment. The annotation card follows the
  mode (primary button "Queue" vs "Save private note", the other one swaps in as secondary).
- **Comments rail** — a column between the artifact and the Conversation panel, toggled with the
  "Comments · n" button; it opens by itself the first time a comment exists. Every comment is a card
  anchored to an element, Google-Docs style: commented elements carry a faint tint and a numbered pin,
  **clicking a card scrolls the artifact to its element and highlights it** (Esc clears), clicking a pin
  selects the card, cards follow document order.
  - **Private** comments: "Keep private" on the card, Notes mode, "+ Private note" for a general note, or
    `window.lavish.privateNote(text, opts)` from artifact code. Saved on this machine
    (`~/.lavish-axi/notes/<key>.json` through the home page; localStorage while it is down). **They are
    never delivered to the agent — do not read `~/.lavish-axi/notes/` unless Marcus asks you to.** They
    survive reloads and revisions; when their element is gone they move to a collapsed "Detached" group.
  - **Queued** comments: the send queue, as editable cards (Edit, or double-click; Keep private; Remove).
    Clicking a pill in the Conversation panel opens the same editor. **Suggestions** ("Suggest edit" on the
    card: the element's text prefilled, Marcus edits it, "Queue suggestion") show as old → new.
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

### Home page — `http://127.0.0.1:4388` (`tools/lavish-home.mjs`, launchd `com.marcus.lavish-home`; Drive layout since 2026-09-04)

- **Layout**: a sidebar (All plans · Active now · one virtual folder per project for UNFILED plans · your folders,
  nested · "+ New folder"), a strip of the sessions that are running right now (click one to jump to its plan), folder
  tiles, then one table per project or subfolder. Default columns: **Plan** (monogram + title; hover the title for the
  summary, PRs, review counts, versions, latest progress) · **Folder** · **Status** (stage tag, plan chip, inline status
  select) · **Session** (the AGENT state first: not connected · active · in terminal · ended, with the session name, a
  pulsing dot when live, a dotted name when it came from the transcript scan; Lavish's own review state as the second
  line) · **Actions** (View · Resume · New session · Log · Move to… · Retire). Column widths drag (remembered per
  browser). Light and dark palettes: ◐ in the top bar (follows the system until you pick; saved per browser). Every
  text/background token pair is checked at startup for WCAG AA 4.5:1 (`node tools/lavish-home.mjs --check-contrast`);
  a failing pair stops the server with the pair named.
- **Folders** (`~/.lavish-axi/home-layout.json`, separate from the registry so `lavish-meta` can never clobber
  them): drag a row onto a folder in the sidebar or a tile, or a folder onto a folder (cycles are refused and greyed
  while dragging); Move-to in the row is the keyboard path. Deleting a folder moves its subfolders and plans up one
  level. `PUT /api/layout {op: file|move|create|rename|delete, …}` behind all of it.
- **Agent link** (`registry.json` → `agent` + `agents[]`): `lavish-poll` and `lavish-meta` stamp the session
  that ran them (Claude from `CLAUDE_CODE_SESSION_ID`; Codex by matching the newest live rollout of the folder). The
  page reads liveness from `~/.claude/sessions/<pid>.json` + a pid check and from Codex's writer locks; "in terminal"
  = its tmux session exists. **Run `lavish-poll` / `lavish-meta` from the working session** so Resume knows who you
  are: a session that only reads a plan is linked only by the bounded transcript scan (last 7 days of the plan's project
  folder, Read/Edit/Write targets only; at startup, hourly, and "Find sessions" on the plan page) and shows dotted until
  it polls for real. Every history row carries `agent {provider,id}`; when the id changes, the poll posts one
  "session changed: now <name> · <provider>" line into the chat.
- **View** = `/view/<key>/`: the plan as it is on disk, no Lavish chrome, no session change; relative assets beside
  the plan are served, nothing outside its folder. **Resume** (`POST /connect/<key>`, model + effort remembered per
  plan): live in tmux → Terminal.app forward and the plan in Lavish · live in VS Code/Cursor/Desktop → the plan in
  Lavish only, with a page saying so (a second writer would corrupt the transcript; nothing is spawned) · ended → `tmux
  new-session -s mm-claude-<8>` (or `mm-codex-<8>`) running `claude --resume <id> [--model --effort]` (or `codex
  resume <uuid> -m … -c model_reasoning_effort=…`) in the transcript's folder, Terminal.app attached, then the plan in
  Lavish. Same tmux names as Manager Marcus, so the two tools cannot double-resume. Refusals are pages naming the
  reason (folder missing, binary missing, Codex thread open in the app, tmux error verbatim). **New session**
  (`?new=1`): provider, model, effort, folder and a first prompt (default: open this plan in Lavish and poll it) in a
  fresh tmux terminal; Claude gets a chosen UUID stamped at once, Codex is matched by folder on its first poll.
  Terminals this page starts are listed in `~/.lavish-axi/terminals.json` (Manager Marcus's row shape).
- **Session page**: the Agent block (state, name, id, folder, stamp source; **Change effort** types `/effort <level>`
  into an OWNED Claude terminal only while its pane is at the prompt, then shows the pane's reply — the CLI also saves
  that level as the default for that model in `~/.claude/settings.json`; **Find sessions** runs the scan for this
  plan), the conversation grouped per agent session (newest open, older collapsed, a Resume button per session),
  plan-status form, folder select, Progress (stage strip, working sessions, notes, timeline), Versions (View · Diff →
  previous / current · Restore, with the comments per version), commits, private comments, Unsent comments, Export.
- **Versions** are saved by `lavish-poll` at every round and by the home page's 20-second scan, deduplicated by
  content. Diffs compare the visible text. **Restore** snapshots the current file first, then writes the chosen version
  over it; the Lavish tab offers a reload, but **the agent is not told** (the history file gets a `restore` entry).
- **Front-matter for new artifacts**: `<meta name="lavish:project" content="StyleManager-2.0">`,
  `<meta name="description" content="one sentence: what this plan decides">`, optionally `lavish:related` and
  `<meta name="lavish:logo" content="assets/logo.svg">` to replace the generated monogram. Status and PRs go through
  `lavish-meta`.
- `/api/sessions` carries `folder {id,name,path}` and `agent {provider,id,state,name,terminal,tmuxName,…}` per plan
  (Manager Marcus's terminal canvas reads it). Mention the home page when handing over an artifact.

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

## Plan-artifact template (local requirements, set 2026-07-22, skeleton approved 2026-09-02)

**Start every plan from `~/.claude/skills/lavish/tools/plan-template.html`** (copy it, keep it a single
self-contained .html: vanilla JS, no build step, the Mermaid CDN as the only external dependency, opens
directly with no server). Reference implementation of the skeleton: StyleManager
`.lavish/2026-09-02-lavish-planning-upgrades.html`. The skeleton, which Marcus approved on 2026-09-02:

- **Front-matter**: `<title>`, `<meta name="description">` (one sentence, the home page shows it),
  `lavish:project`, and `lavish:related` when it builds on another plan.
- **Reading order is fixed**: 1 Read this first (the answer in one paragraph inside `.answer`, then
  "What changed in this version"; older rounds under a collapsed "Earlier rounds") · 2 Decisions (every
  decision card, recommended option pre-checked, decided ones keep their answer via `data-decided`; the
  standard `table.alts` for alternatives: Option · What it buys · What it costs, `tr.rec` marks the
  recommendation) · then the evidence: Current state (verified against code, file paths) · Design ·
  Plan by PR · Risks and what to review (ordered by how silently it fails; what could not be verified is
  named) · Open questions · Feedback log.
- **Sticky outline** (`nav.outline`, built by the template JS from `details[data-sec]`): one entry per
  section with its review-status dot, the tally at the bottom, click to jump, active section follows
  the reading position; a Hide button and, below 1000 px (the Lavish iframe with both rails open), a
  floating "Outline" button that opens it as a drawer.
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
  .md and confirms the path). Mermaid sources are stashed before `mermaid.run()` and emitted as fences;
  viewer-only controls are skipped. Never rely on a programmatic download alone (embedded frames block it silently).
- **Feedback log**: the last section; after EVERY poll round that returns feedback the agent appends one
  line per received item with a one-line response, so the exported document carries its review history.
  The durable records are the history jsonl, the versions, and the rail's sent cards on the home page.
- **Stage strip and export dialog** are part of the skeleton: keep the `.stage` block under the header (it
  paints itself from the registry inside Lavish) and the export dialog with its format and appendix options.
- **Explain with examples** (Marcus, 2026-09-02): when a section explains something unfamiliar or
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
- Run `lavish-axi share <html-file> [--password <pw>] [--token <t>]` to publish the artifact on ht-ml.app (https://ht-ml.app), a third-party hosting service not part of Lavish, and get back a visitable URL. Shares are PUBLIC by default, so anyone with the link can open them. Pass --password to publish a PRIVATE password-protected page; viewers must supply the password to view. Local assets are inlined; remote refs load over the network. It returns the url plus a secret update_key for managing the page later. Use --token or LAVISH_AXI_HTML_APP_TOKEN only when you have an optional bearer token; it is never required. Users can also publish from the browser chrome's overflow menu. **Never run `share` unless Marcus explicitly asks** (it publishes to a public third-party host).
- Run `lavish-axi stop` to shut down the background server (it also self-stops when idle or after the last session ends with nothing connected). It kills every session's in-flight poll on this machine: check `ps -eo args | grep 'lavish-poll'` first.
- Run `lavish-axi playbook <playbook_id>` for focused artifact guidance. One artifact often combines several playbooks (for example a plan that includes a comparison and a diagram), so MUST open each matching playbook before writing HTML.
- Lavish does not auto-inject any design system - artifacts stay portable so they render identically when opened directly without lavish-axi running. Before writing any HTML: Decide the design direction in this strict priority order, and only move to the next step when the current one truly yields nothing: (1) if the user asked for a specific look or named design system, use that; (2) otherwise you must first inspect the project the artifact is about - the subject or product whose content or UI it represents, which may differ from your current working directory - and match that project's design system: Tailwind or theme config, shared CSS variables or design tokens, component library, brand assets, or existing styled pages. If the artifact previews, proposes, or mocks a specific app's UI, render it in that app's own design system so it faithfully shows the product, even when you are running in a different repo; (3) only when both steps come up empty, use the Lavish-recommended Tailwind CSS browser runtime v4 + DaisyUI v5, available via CDN, and prefer that CDN snippet over hand-writing styles unless explicitly instructed otherwise by the user - but restyle it per the Design direction section above: define a quiet custom theme (neutral base + one restrained accent) with DaisyUI theme CSS variables instead of shipping a stock accent-heavy theme name. Run `lavish-axi design` for a content-to-playbook router, a copy-pasteable CDN snippet, a Mermaid CDN snippet/init for diagrams, and the DaisyUI component reference. When you deliver the artifact, state which of the three design sources you used and why.
- Use lavish-axi when the user asks for a visual artifact, HTML explainer, interactive prototype, review surface, product or technical plan, comparison, report, or browser-based feedback loop
