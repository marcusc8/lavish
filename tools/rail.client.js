/* lavish-local-patch:review-rail */
/* Comments rail — appended to lavish-axi's dist/chrome-client.js by patch-lavish.mjs.
 *
 * What it adds to the Lavish chrome (the parent page around the artifact iframe):
 *   - a "Comments" column between the artifact and the Conversation panel, Google-Docs style:
 *       PRIVATE comments  never leave this machine (saved through the home page on :4388, with a
 *                         localStorage fallback); shown until you delete them or their section is gone
 *       QUEUED comments   the existing send queue, now visible as cards, editable until Send
 *       SENT comments     a local record of what went to the agent, with the agent's threaded replies
 *   - clicking a card scrolls the artifact to its element and highlights it (the pins do the reverse)
 *   - a comment MODE in the top bar: "Agent" (annotations go to the send queue) or "Notes" (everything
 *     you write is a private comment); each shows its live count; the annotation card follows the mode
 *   - filter chips (All · Private · Queued · Sent), Edit / Keep private / Queue / Follow up / Resolve /
 *     Delete on every card, click-to-edit pills, suggestion cards (old text → new text)
 *   - image attachments on comments: agent-bound ones use Lavish's own attachment store (the agent gets
 *     them with the prompt), private ones are stored by the home page and never leave this machine
 *   - a review verdict next to Send (Approve · Request changes) that also sets the plan status
 *   - sent comments never disappear from the chat: a bubble is added the moment Send succeeds and the
 *     chat re-sync merges the local record back in if the server copy lacks it
 *   - unsent comments, their images and a half-written annotation card survive closing the tab: mirrored in
 *     this browser (localStorage) and on the home page (/api/queue), restored on the next open, with a notice;
 *     images of unsent comments get a private copy and are re-uploaded to Lavish at Send if Lavish expired them
 *   - a Stage chip (Planning · Developing · Review · Done) with the working session and the latest progress note
 *   - a Home link, a Chat show/hide toggle, "Version history" and "Export with options" in the overflow menu
 *   - anchor tracking with the patched SDK: cards in document order, re-anchoring when a section moved,
 *     a Detached group when it was removed, numbered pins and a tint on commented elements.
 *
 * Relies on the chrome's own top-level bindings: key, sessionData, frame, queued, render,
 * enqueuePrompt, persistQueuedPrompts, addChat, syncChat, sendQueued, postToFrame, artifactLoadToken,
 * escapeHtml, annotationPills, ended, closeMenus, submitQueuedOnce, lastReviewState, setReviewState,
 * saveJsonState, reviewStateStorageKey, hasUnsentDraft.
 */
(function lavishLocalRail() {
  if (typeof document === "undefined" || !document.getElementById("artifact") || !document.querySelector(".frame")) return;
  const HOME = String((typeof sessionData === "object" && sessionData && sessionData.homeUrl) || "http://127.0.0.1:4388").replace(/\/$/, "");
  const NOTES_KEY = "lavish-axi:notes:" + key;
  const RAIL_OPEN_KEY = "lavish-axi:rail-open";
  const CHAT_OPEN_KEY = "lavish-axi:chat-open";
  const MODE_KEY = "lavish-axi:comment-mode";
  const FILTER_KEY = "lavish-axi:rail-filter";
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* memory only */ } },
  };
  const esc = (v) => escapeHtml(String(v ?? ""));
  const now = () => new Date().toISOString();
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "\u2026" : s);
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const anchorOf = (p) => (p ? { selector: String(p.selector || ""), uid: String(p.uid || ""), tag: String(p.tag || ""), text: norm(p.text).slice(0, 240), section: String(p.section || ""), target: p.target || undefined } : null);
  // What the SDK matches on: for a suggestion the agent applied, the element now reads the NEW text (the card body).
  const matchTextOf = (c) => (c.anchor?.tag === "suggestion" ? c.body : c.anchor?.text || "");
  const lavishFileUrl = (id) => "/api/" + encodeURIComponent(key) + "/attachments/" + encodeURIComponent(id);
  const refsOf = (p) => (Array.isArray(p?.attachments) ? p.attachments.filter((a) => a && a.id).map((a) => ({ id: String(a.id), name: String(a.name || "image"), url: lavishFileUrl(a.id) })) : []);
  const SEMANTIC = /^(choice|export|review|note|whiteboard|layout-warnings|mermaid-node|suggestion|verdict)$/;
  // Same shape the patched server writes into the chat, so the local bubble equals the synced one.
  function summarize(p) {
    const tag = String(p.tag || ""), body = String(p.prompt || ""), where = norm(p.text);
    const head = !tag ? "" : SEMANTIC.test(tag) ? "[" + tag + "] " : "on <" + tag + "> ";
    const quoted = where && where !== body ? "\u201c" + where.slice(0, 90) + (where.length > 90 ? "\u2026" : "") + "\u201d \u2014 " : "";
    return head + quoted + body;
  }

  let notes = ls.get(NOTES_KEY, []);
  if (!Array.isArray(notes)) notes = [];
  let synced = null;            // null unknown · true home page reachable · false offline (localStorage only)
  let anchorsSupported = null;  // null unknown · true patched SDK answered · false legacy SDK (no pins)
  const anchorInfo = new Map(); // card id → { found, order, selector, text }
  const numbering = new Map();  // card id → pin number
  const editDrafts = new Map(); // card id → unsaved editor text (survives re-renders while attaching)
  let editingId = null;
  let selectedId = null;
  let lastAnchorSignature = "";
  let autoOpened = false;
  let commentMode = ls.get(MODE_KEY, "agent") === "private" ? "private" : "agent";
  let railFilter = ["all", "private", "queued", "sent"].includes(ls.get(FILTER_KEY, "all")) ? ls.get(FILTER_KEY, "all") : "all";
  let busy = 0;

  /* ── DOM ─────────────────────────────────────────────────────────────── */
  const frameWrap = document.querySelector(".frame");
  const rail = document.createElement("aside");
  rail.className = "lavish-rail";
  rail.id = "lavishRail";
  rail.innerHTML =
    '<div class="lavish-rail-head"><h2>Comments</h2><span class="lavish-rail-sync" id="lavishRailSync"></span>' +
    '<button class="lavish-rail-mini" id="lavishRailAdd" type="button" title="A private note that is not tied to an element">+ Private note</button>' +
    '<button class="lavish-rail-mini lavish-rail-x" id="lavishRailClose" type="button" aria-label="Hide comments">\u00d7</button></div>' +
    '<div class="lavish-rail-filters" id="lavishRailFilters" role="group" aria-label="Show">' +
      '<button type="button" data-filter="all">All <b></b></button><button type="button" data-filter="private">Private <b></b></button><button type="button" data-filter="queued">Queued <b></b></button><button type="button" data-filter="sent">Sent <b></b></button></div>' +
    '<div class="lavish-rail-notice" id="lavishRailNotice" hidden><span></span><span class="lavish-rail-notice-acts"></span><button type="button" data-act="dismiss" aria-label="Dismiss">\u00d7</button></div>' +
    '<div class="lavish-rail-legacy" id="lavishRailLegacy" hidden>Pins in the artifact, the card\u2019s mode buttons and detached-section detection switch on after the Lavish server restarts (<code>lavish-axi stop</code>, then reopen this page).</div>' +
    '<div class="lavish-rail-list" id="lavishRailList"></div>' +
    '<input type="file" id="lavishRailFile" class="lavish-card-file" accept="image/*" multiple hidden>';
  frameWrap.insertAdjacentElement("afterend", rail);
  const listEl = rail.querySelector("#lavishRailList");
  const syncEl = rail.querySelector("#lavishRailSync");
  const legacyEl = rail.querySelector("#lavishRailLegacy");
  const filtersEl = rail.querySelector("#lavishRailFilters");
  const fileInput = rail.querySelector("#lavishRailFile");

  const brand = document.querySelector(".bar .brand");
  if (brand) brand.insertAdjacentHTML("afterend", '<a class="lavish-bar-link" id="lavishHomeLink" href="' + esc(HOME) + '/" target="_blank" rel="noopener" title="Lavish home: every plan, its status, PRs, versions and transcript">Home</a>');
  const homeLink = document.getElementById("lavishHomeLink");
  if (homeLink) homeLink.insertAdjacentHTML("afterend",
    '<div class="lavish-version-wrap" id="lavishVersionWrap"><button class="lavish-bar-btn lavish-version" id="lavishVersionChip" type="button" aria-haspopup="menu" aria-expanded="false" title="Which version of the plan is on screen">v?</button>' +
    '<div class="menu lavish-version-menu" id="lavishVersionMenu" role="menu" hidden></div></div>');
  const versionChip = document.getElementById("lavishVersionChip");
  const versionMenu = document.getElementById("lavishVersionMenu");
  document.getElementById("lavishVersionWrap")?.insertAdjacentHTML("afterend",
    '<div class="lavish-stage-wrap" id="lavishStageWrap"><button class="lavish-bar-btn lavish-stage" id="lavishStageChip" type="button" aria-haspopup="menu" aria-expanded="false" title="Which stage the plan is in">Stage ?</button>' +
    '<div class="menu lavish-stage-menu" id="lavishStageMenu" role="menu" hidden></div></div>');
  const stageChip = document.getElementById("lavishStageChip");
  const stageMenu = document.getElementById("lavishStageMenu");
  const annotationSwitch = document.getElementById("annotation");
  if (annotationSwitch) annotationSwitch.insertAdjacentHTML("beforebegin",
    '<div class="lavish-seg" id="lavishModeSeg" role="group" aria-label="Comment mode" title="Agent: what you write on elements goes to the agent (the count is queued + sent). Notes: everything you write is a private comment only you see (the count is your notes).">' +
      '<button type="button" data-mode="agent" aria-pressed="false">Agent <b id="lavishAgentCount">0</b></button><button type="button" data-mode="private" aria-pressed="false">Notes <b id="lavishNotesCount">0</b></button></div>' +
    '<button class="lavish-bar-btn" id="lavishRailToggle" type="button" aria-pressed="false" title="Show or hide the Comments rail">Comments <b id="lavishRailCount">0</b></button>' +
    '<button class="lavish-bar-btn" id="lavishChatToggle" type="button" aria-pressed="true" title="Show or hide the conversation with the agent">Chat</button>');
  const toggle = document.getElementById("lavishRailToggle");
  const chatToggle = document.getElementById("lavishChatToggle");
  const countEl = document.getElementById("lavishRailCount");
  const agentCountEl = document.getElementById("lavishAgentCount");
  const notesCountEl = document.getElementById("lavishNotesCount");
  const modeSeg = document.getElementById("lavishModeSeg");
  const reloadItem = document.getElementById("reloadArtifact");
  if (reloadItem) reloadItem.insertAdjacentHTML("beforebegin",
    '<button class="menu-item" id="lavishHistoryItem" type="button"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span>Version history</span></button>' +
    '<button class="menu-item" id="lavishHomeItem" type="button"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg><span>Lavish home (all plans)</span></button>' +
    '<div class="menu-rule"></div>');
  const openExternal = (url) => { window.open(url, "_blank", "noopener"); if (typeof closeMenus === "function") closeMenus(); };
  document.getElementById("lavishHistoryItem")?.addEventListener("click", () => openExternal(HOME + "/session/" + encodeURIComponent(key) + "#versions"));
  document.getElementById("lavishHomeItem")?.addEventListener("click", () => openExternal(HOME + "/"));
  document.getElementById("exportArtifact")?.insertAdjacentHTML("afterend",
    '<button class="menu-item" id="lavishExportOptionsItem" type="button"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg><span>Export with options\u2026 (md, html, pdf; appendices)</span></button>');
  document.getElementById("lavishExportOptionsItem")?.addEventListener("click", () => openExternal(HOME + "/session/" + encodeURIComponent(key) + "#export"));
  // Review verdict, sent with the batch. Approve / Request changes also set the plan status on the home page.
  const sendActions = document.getElementById("sendActions");
  if (sendActions) sendActions.insertAdjacentHTML("afterbegin",
    '<select class="lavish-verdict" id="lavishVerdict" title="Review verdict for this batch. Approve and Request changes also update the plan status on the home page."><option value="">Comment</option><option value="approve">Approve plan</option><option value="changes">Request changes</option></select>');
  const verdictEl = document.getElementById("lavishVerdict");

  function setRailOpen(open, remember = true) {
    document.body.classList.toggle("lavish-rail-open", open);
    if (toggle) toggle.setAttribute("aria-pressed", String(open));
    if (remember) ls.set(RAIL_OPEN_KEY, open);
  }
  function setChatOpen(open, remember = true) {
    document.body.classList.toggle("lavish-chat-hidden", !open);
    if (chatToggle) chatToggle.setAttribute("aria-pressed", String(open));
    if (remember) ls.set(CHAT_OPEN_KEY, open);
  }
  function setMode(mode, remember = true) {
    commentMode = mode === "private" ? "private" : "agent";
    for (const b of modeSeg?.querySelectorAll("button") || []) b.setAttribute("aria-pressed", String(b.dataset.mode === commentMode));
    document.body.classList.toggle("lavish-mode-private", commentMode === "private");
    if (remember) ls.set(MODE_KEY, commentMode);
    postToFrame({ type: "lavish:setCommentMode", mode: commentMode });
  }
  function setFilter(f) { railFilter = f; ls.set(FILTER_KEY, f); renderRail(); }
  toggle?.addEventListener("click", () => setRailOpen(!document.body.classList.contains("lavish-rail-open")));
  chatToggle?.addEventListener("click", () => setChatOpen(document.body.classList.contains("lavish-chat-hidden")));
  modeSeg?.addEventListener("click", (event) => { const b = event.target.closest("button[data-mode]"); if (b) setMode(b.dataset.mode); });
  filtersEl.addEventListener("click", (event) => { const b = event.target.closest("button[data-filter]"); if (b) setFilter(b.dataset.filter); });
  rail.querySelector("#lavishRailClose").addEventListener("click", () => setRailOpen(false));
  rail.querySelector("#lavishRailAdd").addEventListener("click", () => {
    const n = { id: uid(), state: "private", anchor: null, body: "", created: now(), updated: now() };
    notes.push(n); editingId = n.id; saveNotes(); renderRail(); focusEditor(n.id);
  });

  /* ── cards ───────────────────────────────────────────────────────────── */
  function cards() {
    const list = [];
    queued.forEach((p, index) => {
      if ((p.tag === "message" && !p.selector) || p.tag === "verdict") return; // composer messages and verdicts are not comments
      list.push({ kind: "queued", id: "q:" + index, index, anchor: anchorOf(p), body: String(p.prompt || ""), at: "", files: refsOf(p) });
    });
    for (const n of notes) list.push({ kind: n.state === "sent" ? "sent" : n.state === "resolved" ? "resolved" : "private", id: n.id, note: n, anchor: n.anchor || null, body: String(n.body || ""), at: n.updated || n.created || "", files: Array.isArray(n.attachments) ? n.attachments : [] });
    return list;
  }
  const info = (c) => anchorInfo.get(c.id);
  function byOrder(a, b) {
    const oa = info(a)?.order, ob = info(b)?.order;
    if (oa != null && ob != null && oa !== ob) return oa - ob;
    if (oa != null && ob == null) return -1;
    if (oa == null && ob != null) return 1;
    return String(a.note?.created || "").localeCompare(String(b.note?.created || ""));
  }
  function filesHtml(c, editing) {
    if (!c.files.length) return "";
    return '<div class="lavish-card-files">' + c.files.map((f) =>
      '<a class="lavish-card-thumb" href="' + esc(f.url) + '" target="_blank" rel="noopener" title="' + esc(f.name) + '"><img src="' + esc(f.url) + '" alt="' + esc(f.name) + '" onerror="this.parentNode.classList.add(\'is-gone\')">' +
      (editing ? '<button type="button" class="lavish-thumb-x" data-act="unattach" data-id="' + esc(c.id) + '" data-file="' + esc(f.id) + '" aria-label="Remove image">\u00d7</button>' : "") + "</a>").join("") + "</div>";
  }
  function cardHtml(c, detached) {
    const isSuggestion = c.anchor?.tag === "suggestion";
    const chip = isSuggestion ? { queued: "Suggestion", private: "Private", sent: "Suggested", resolved: "Resolved" }[c.kind] : { queued: "Queued", private: "Private", sent: "Sent", resolved: "Resolved" }[c.kind];
    const where = c.anchor?.text ? "\u201c" + esc(trunc(c.anchor.text, 72)) + "\u201d" : c.anchor?.tag ? "&lt;" + esc(c.anchor.tag) + "&gt;" : "general note";
    const n = numbering.get(c.id);
    const editing = editingId === c.id;
    const a = (act, label, title) => '<button type="button" data-act="' + act + '" data-id="' + esc(c.id) + '"' + (title ? ' title="' + esc(title) + '"' : "") + ">" + label + "</button>";
    let actions = "";
    if (editing) {
      actions = a("save", "Save", "\u2318/Ctrl+Enter") + a("cancel", "Cancel", "Esc") + a("attach", "Attach image", "Attach screenshots or images (or paste one into the text)") + '<span class="lavish-card-hint">Enter sends \u00b7 Shift+Enter new line \u00b7 \u2318/Ctrl+Enter saves \u00b7 Esc cancels</span>';
    } else if (detached) {
      actions = (c.kind === "private" || c.kind === "queued" ? a("edit", "Edit") : "") + (c.kind === "queued" ? a("remove", "Remove") : a("delete", "Delete"));
    } else if (c.kind === "queued") {
      actions = a("edit", "Edit") + a("private", "Keep private", "Take it out of the send queue and keep it as a private comment") + a("remove", "Remove");
    } else if (c.kind === "private") {
      actions = a("edit", "Edit") + (ended ? "" : a("queue", "Queue to agent", "Move it into the send queue")) + a("delete", "Delete");
    } else if (c.kind === "sent") {
      actions = (ended ? "" : a("followup", "Follow up", "Queue a follow-up on the same element")) + a("resolve", "Resolve") + a("delete", "Delete");
    } else {
      actions = a("reopen", "Reopen") + a("delete", "Delete");
    }
    let body;
    if (editing) body = '<textarea class="lavish-card-edit" data-id="' + esc(c.id) + '" rows="4" placeholder="Write the comment\u2026 (paste an image to attach it)">' + esc(editDrafts.has(c.id) ? editDrafts.get(c.id) : c.body) + "</textarea>";
    else if (isSuggestion) body = '<div class="lavish-card-body lavish-card-suggestion"><del>' + esc(trunc(c.anchor.text, 160)) + "</del><ins>" + esc(c.body) + "</ins></div>";
    else body = '<div class="lavish-card-body">' + (c.body ? esc(c.body) : c.files.length ? "" : "<i>(empty)</i>") + "</div>";
    const replies = (c.note?.replies || []).map((r) => '<div class="lavish-card-reply"><small>Agent \u00b7 ' + esc(fmtTime(r.at)) + "</small>" + esc(r.text) + "</div>").join("");
    const meta = c.kind === "sent" && c.note?.sentAt ? "sent " + fmtTime(c.note.sentAt) : c.at ? fmtTime(c.at) : "";
    return '<div class="lavish-card is-' + c.kind + (detached ? " is-detached" : "") + (editing ? " is-editing" : "") + (selectedId === c.id ? " is-active" : "") + '" data-id="' + esc(c.id) + '" tabindex="0">' +
      '<div class="lavish-card-top">' + (n ? '<span class="lavish-card-n">' + n + "</span>" : "") + '<span class="lavish-chip">' + (detached ? "Detached" : chip) + '</span><span class="lavish-card-anchor" title="' + esc(c.anchor?.selector || "") + '">' + (isSuggestion ? "edit" : where) + "</span></div>" +
      body + filesHtml(c, editing) + replies + '<div class="lavish-card-actions">' + actions + (meta ? '<span class="lavish-card-meta">' + esc(meta) + "</span>" : "") + "</div></div>";
  }
  function fmtTime(iso) { const t = new Date(iso); if (isNaN(t)) return ""; const today = t.toDateString() === new Date().toDateString(); return (today ? "" : t.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " ") + t.toTimeString().slice(0, 5); }

  function renderRail() {
    // Keep unsaved editor text across re-renders (attaching an image re-renders the card).
    const openEditor = listEl.querySelector(".lavish-card-edit");
    if (openEditor && editingId) editDrafts.set(editingId, openEditor.value);
    const all = cards();
    const detached = all.filter((c) => c.kind !== "resolved" && info(c)?.found === false);
    const resolved = all.filter((c) => c.kind === "resolved");
    const active = all.filter((c) => c.kind !== "resolved" && !detached.includes(c)).sort(byOrder);
    numbering.clear();
    active.forEach((c, i) => numbering.set(c.id, i + 1));
    const counts = { all: active.length, private: active.filter((c) => c.kind === "private").length, queued: active.filter((c) => c.kind === "queued").length, sent: active.filter((c) => c.kind === "sent").length };
    if (countEl) countEl.textContent = String(counts.all);
    if (agentCountEl) agentCountEl.textContent = String(counts.queued + counts.sent);
    if (notesCountEl) notesCountEl.textContent = String(counts.private);
    toggle?.classList.toggle("has", counts.all > 0);
    for (const b of filtersEl.querySelectorAll("button[data-filter]")) { b.setAttribute("aria-pressed", String(b.dataset.filter === railFilter)); b.querySelector("b").textContent = String(counts[b.dataset.filter] ?? 0); }
    // First card in a session where the rail was never toggled: show it, so the feature is discoverable.
    if (active.length && !autoOpened && ls.get(RAIL_OPEN_KEY, null) === null && !document.body.classList.contains("lavish-rail-open")) { autoOpened = true; setRailOpen(true, false); }
    const shown = railFilter === "all" ? active : active.filter((c) => c.kind === railFilter);
    let html = shown.length
      ? shown.map((c) => cardHtml(c, false)).join("")
      : active.length
        ? '<div class="lavish-rail-empty">Nothing ' + esc(railFilter) + ' right now.</div>'
        : '<div class="lavish-rail-empty">No comments yet.<br><br>Click or select something in the artifact and write. In <b>Agent</b> mode it is queued for the agent; in <b>Notes</b> mode it is a private comment only you see. Click a card to jump to its place in the document; queued comments can be edited until you press <b>Send to Agent</b>.</div>';
    if (railFilter === "all" && resolved.length) html += '<details class="lavish-rail-group"><summary>Resolved \u00b7 ' + resolved.length + "</summary>" + resolved.map((c) => cardHtml(c, false)).join("") + "</details>";
    if (railFilter === "all" && detached.length) html += '<details class="lavish-rail-group" open><summary>Detached \u00b7 ' + detached.length + " <span>section changed or removed</span></summary>" + detached.map((c) => cardHtml(c, true)).join("") + "</details>";
    listEl.innerHTML = html;
    if (legacyEl) legacyEl.hidden = !(anchorsSupported === false && all.length);
    if (syncEl) {
      syncEl.className = "lavish-rail-sync" + (synced === true ? " is-on" : synced === false ? " is-off" : "") + (busy ? " is-busy" : "");
      syncEl.title = busy ? "Uploading\u2026" : synced === true ? "Private comments are saved on this machine through the Lavish home page." : synced === false ? "Home page (" + HOME + ") unreachable: private comments are kept in this browser only until it is back." : "";
    }
    homeLink?.classList.toggle("is-off", synced === false);
    requestAnchors();
  }
  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));
  function focusEditor(id) {
    const ta = listEl.querySelector('.lavish-card-edit[data-id="' + cssEscape(id) + '"]');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
  function cardEl(id) { return listEl.querySelector('.lavish-card[data-id="' + cssEscape(id) + '"]'); }
  /** Select a card: highlight it in the rail, scroll the artifact to its element and tint it (Docs-style). */
  function selectCard(id, { reveal = true, flash = false } = {}) {
    selectedId = id || null;
    for (const el of listEl.querySelectorAll(".lavish-card.is-active")) el.classList.remove("is-active");
    const el = id ? cardEl(id) : null;
    if (el) { el.classList.add("is-active"); if (flash) { el.classList.add("is-flash"); setTimeout(() => el.classList.remove("is-flash"), 1600); } }
    const c = id ? cards().find((x) => x.id === id) : null;
    const selector = c?.anchor?.selector || "";
    if (reveal) postToFrame({ type: "lavish:selectAnchor", selector, text: c ? matchTextOf(c) : "", tag: c?.anchor?.tag || "", section: c?.anchor?.section || "", id: id || "" });
    if (reveal && selector && anchorsSupported === false) postToFrame({ type: "lavish:revealElement", selector });
  }
  function focusCard(id) {
    setRailOpen(true, false);
    if (railFilter !== "all") { const c = cards().find((x) => x.id === id); if (c && c.kind !== railFilter) setFilter("all"); }
    const el = cardEl(id);
    if (!el) return;
    el.closest("details")?.setAttribute("open", "");
    el.scrollIntoView({ block: "center" });
    selectCard(id, { reveal: false, flash: true });
  }

  /* ── attachments ─────────────────────────────────────────────────────── */
  async function uploadToLavish(file) {
    const r = await fetch("/api/" + encodeURIComponent(key) + "/attachments", { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.attachment?.id) throw new Error(j.error || "upload failed");
    return { id: String(j.attachment.id), name: file.name || "image" };
  }
  async function uploadToHome(file) {
    const r = await fetch(HOME + "/api/notes/" + encodeURIComponent(key) + "/files?name=" + encodeURIComponent(file.name || "image"), { method: "PUT", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.id) throw new Error(j.error || "upload failed");
    return { id: String(j.id), name: String(j.name || file.name || "image"), url: String(j.url) };
  }
  const fetchFile = async (ref) => { const r = await fetch(ref.url); if (!r.ok) throw new Error("fetch failed"); const b = await r.blob(); return new File([b], ref.name || "image", { type: b.type || "application/octet-stream" }); };
  async function attachFiles(id, files) {
    const list = [...files].filter((f) => f && f.size);
    if (!list.length) return;
    busy++; renderRail();
    try {
      const qi = queuedIndex(id);
      if (qi >= 0 && queued[qi]) {
        for (const f of list) { const ref = await uploadToLavish(f); queued[qi].attachments = [...(queued[qi].attachments || []), ref]; }
        persistQueuedPrompts(); render();
      } else {
        const n = noteById(id);
        if (!n) return;
        for (const f of list) { const ref = await uploadToHome(f); n.attachments = [...(n.attachments || []), ref]; }
        n.updated = now(); saveNotes();
      }
    } catch (e) { alert("Could not attach: " + (e?.message || e)); }
    finally { busy--; renderRail(); if (editingId === id) focusEditor(id); }
  }
  function unattach(id, fileId) {
    const qi = queuedIndex(id);
    if (qi >= 0 && queued[qi]) { queued[qi].attachments = (queued[qi].attachments || []).filter((a) => String(a.id) !== fileId); if (!queued[qi].attachments.length) delete queued[qi].attachments; persistQueuedPrompts(); render(); return; }
    const n = noteById(id);
    if (n) { n.attachments = (n.attachments || []).filter((a) => String(a.id) !== fileId); n.updated = now(); saveNotes(); renderRail(); if (editingId === id) focusEditor(id); }
  }
  fileInput.addEventListener("change", () => { if (editingId && fileInput.files?.length) attachFiles(editingId, fileInput.files); fileInput.value = ""; });
  listEl.addEventListener("paste", (event) => {
    if (!event.target.matches(".lavish-card-edit")) return;
    const files = [...(event.clipboardData?.files || [])].filter((f) => /^image\//.test(f.type));
    if (files.length) { event.preventDefault(); attachFiles(event.target.dataset.id, files); }
  });

  /* ── actions ─────────────────────────────────────────────────────────── */
  const noteById = (id) => notes.find((n) => n.id === id);
  const queuedIndex = (id) => (String(id).startsWith("q:") ? Number(String(id).slice(2)) : -1);
  function openEdit(id) { editingId = id; editDrafts.delete(id); setRailOpen(true, false); renderRail(); focusEditor(id); }
  function saveEdit(id) {
    const ta = listEl.querySelector('.lavish-card-edit[data-id="' + cssEscape(id) + '"]');
    const text = ta ? ta.value.trim() : "";
    const qi = queuedIndex(id);
    editingId = null; editDrafts.delete(id);
    if (qi >= 0 && queued[qi]) {
      const hasFiles = (queued[qi].attachments || []).length > 0;
      if (text || hasFiles) queued[qi].prompt = text; else queued.splice(qi, 1);
      persistQueuedPrompts(); render(); return;
    }
    const n = noteById(id);
    if (n) { if (text || (n.attachments || []).length) { n.body = text; n.updated = now(); } else notes = notes.filter((x) => x !== n); saveNotes(); }
    renderRail();
  }
  const promptFrom = (anchor, body, attachments) => ({ uid: anchor?.uid || "", selector: anchor?.selector || "", tag: anchor?.tag || (anchor?.selector ? "div" : "note"), text: anchor?.text || "", ...(anchor?.target ? { target: anchor.target } : {}), prompt: body, ...(attachments?.length ? { attachments } : {}) });
  async function act(action, id) {
    const qi = queuedIndex(id);
    const p = qi >= 0 ? queued[qi] : null;
    const n = noteById(id);
    const anchor = p ? anchorOf(p) : n?.anchor || null;
    switch (action) {
      case "edit": openEdit(id); break;
      case "save": saveEdit(id); break;
      case "cancel": editingId = null; editDrafts.delete(id); renderRail(); break;
      case "attach": if (editingId === id) fileInput.click(); break;
      case "remove": if (p) { queued.splice(qi, 1); persistQueuedPrompts(); render(); } break;
      case "private": if (p) {
        // Out of the send queue: images move from Lavish's store to the private one, so they stay yours.
        busy++; renderRail();
        const files = [];
        try { for (const ref of refsOf(p)) files.push(await uploadToHome(await fetchFile(ref))); } catch { /* image lost on move; the text is kept */ }
        busy--;
        notes.push({ id: uid(), state: "private", anchor, body: String(p.prompt || ""), created: now(), updated: now(), ...(files.length ? { attachments: files } : {}) });
        queued.splice(qi, 1); persistQueuedPrompts(); saveNotes(); render();
      } break;
      case "queue": if (n && !ended) {
        busy++; renderRail();
        const refs = [];
        try { for (const ref of n.attachments || []) refs.push(await uploadToLavish(await fetchFile(ref))); } catch { /* image lost on move; the text is kept */ }
        busy--;
        enqueuePrompt(promptFrom(anchor, n.body, refs)); notes = notes.filter((x) => x !== n); saveNotes(); renderRail();
      } break;
      case "followup": if (n && !ended) { enqueuePrompt(promptFrom(anchor, "Follow-up on my earlier note (\u201c" + trunc(n.body, 60) + "\u201d): ")); openEdit("q:" + (queued.length - 1)); } break;
      case "resolve": if (n) { n.state = "resolved"; n.updated = now(); saveNotes(); renderRail(); } break;
      case "reopen": if (n) { n.state = n.sentAt ? "sent" : "private"; n.updated = now(); saveNotes(); renderRail(); } break;
      case "delete": if (n) { notes = notes.filter((x) => x !== n); saveNotes(); renderRail(); } break;
      default: break;
    }
  }
  listEl.addEventListener("click", (event) => {
    const x = event.target.closest("button[data-act=unattach]");
    if (x) { event.preventDefault(); unattach(x.dataset.id, x.dataset.file); return; }
    if (event.target.closest(".lavish-card-thumb")) return; // let the image open
    const b = event.target.closest("button[data-act]");
    if (b) { event.preventDefault(); act(b.dataset.act, b.dataset.id); return; }
    if (event.target.closest("textarea")) return;
    const card = event.target.closest(".lavish-card");
    if (card && !card.classList.contains("is-editing")) selectCard(card.dataset.id);
  });
  listEl.addEventListener("dblclick", (event) => {
    if (event.target.closest("textarea, button, a")) return;
    const card = event.target.closest(".lavish-card");
    if (card && !card.classList.contains("is-editing") && (card.classList.contains("is-private") || card.classList.contains("is-queued"))) openEdit(card.dataset.id);
  });
  listEl.addEventListener("keydown", (event) => {
    if (event.target.matches(".lavish-card-edit")) {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); saveEdit(event.target.dataset.id); }
      else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        // Enter = save this card and send the batch (like the composer). A private note only saves.
        event.preventDefault();
        const id = event.target.dataset.id; const wasQueued = queuedIndex(id) >= 0;
        saveEdit(id);
        if (wasQueued && !ended && queued.length && typeof sendQueued === "function") sendQueued(false);
      }
      else if (event.key === "Escape") { event.preventDefault(); editingId = null; editDrafts.delete(event.target.dataset.id); renderRail(); }
      return;
    }
    const card = event.target.closest(".lavish-card");
    if (card && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); selectCard(card.dataset.id); }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && selectedId && !event.target.closest("textarea, input, select")) selectCard(null);
  });
  function addPrivate(prompt) {
    const n = { id: uid(), state: "private", anchor: anchorOf(prompt), body: String(prompt?.prompt || "").trim(), created: now(), updated: now() };
    const refs = refsOf(prompt);
    if (!n.body && !refs.length) return null;
    notes.push(n); saveNotes(); setRailOpen(true, false); renderRail(); focusCard(n.id);
    if (refs.length) (async () => {
      // Images attached in the card went to Lavish's store; copy them to the private store.
      busy++; renderRail();
      try { for (const ref of refs) { n.attachments = [...(n.attachments || []), await uploadToHome(await fetchFile(ref))]; } } catch { /* keep what we got */ }
      busy--; n.updated = now(); saveNotes(); renderRail();
    })();
    return n;
  }
  /** "↳ Re “start of the comment”: reply" → attach to the sent card whose text starts that way. */
  function threadReply(text, at) {
    const m = /^\u21b3\s*Re\s+[\u201c"](.+?)[\u201d"]:\s*([\s\S]+)$/.exec(String(text || "").trim());
    if (!m) return false;
    const quote = norm(m[1]).replace(/\s*\u2026$/, "");
    const reply = m[2].trim();
    const n = notes.find((x) => x.sentAt && (norm(x.body).startsWith(quote) || norm(x.anchor?.text || "").startsWith(quote)));
    if (!n) return false;
    n.replies = Array.isArray(n.replies) ? n.replies : [];
    if (!n.replies.some((r) => r.text === reply)) { n.replies.push({ at: at || now(), text: reply }); n.updated = now(); saveNotes(); renderRail(); }
    return true;
  }

  /* ── persistence: home page first, localStorage as the fallback ──────── */
  let saveTimer = 0;
  function setSynced(v) { if (synced !== v) { synced = v; renderRail(); } }
  function saveNotes() { ls.set(NOTES_KEY, notes); clearTimeout(saveTimer); saveTimer = setTimeout(pushNotes, 350); }
  async function pushNotes() {
    try {
      const r = await fetch(HOME + "/api/notes/" + encodeURIComponent(key), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ notes }) });
      setSynced(r.ok);
    } catch { setSynced(false); }
  }
  async function pullNotes() {
    try {
      const r = await fetch(HOME + "/api/notes/" + encodeURIComponent(key), { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      if (Array.isArray(j.notes)) {
        // The home page is the durable copy; the browser copy only bridges the moments it is down.
        // Local notes it does not know about (written while it was down) are pushed, not dropped.
        const remoteIds = new Set(j.notes.map((n) => n.id));
        const localOnly = synced === false ? notes.filter((n) => !remoteIds.has(n.id)) : [];
        notes = [...j.notes, ...localOnly];
        ls.set(NOTES_KEY, notes);
        if (localOnly.length) pushNotes();
      }
      setSynced(true);
    } catch { setSynced(false); }
    renderRail();
  }
  function postRegistry(patch) {
    fetch(HOME + "/api/registry/" + encodeURIComponent(key), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }).catch(() => {});
  }

  /* ── durable queue: unsent comments, their images and the card draft survive the tab ─── */
  const QUEUE_MIRROR_KEY = "lavish-axi:queue-mirror:" + key;
  const STALE_MIRROR_DAYS = 30;
  const tabId = (() => { try { let t = sessionStorage.getItem("lavish-axi:tab-id"); if (!t) { t = uid(); sessionStorage.setItem("lavish-axi:tab-id", t); } return t; } catch { return uid(); } })();
  let homeCopies = {};        // Lavish attachment id → { id, url, name }: the copy in the home file store
  const keepHome = new Set(); // home copies referenced by sent cards: never pruned
  let sentSigs = [];
  let lastMirrorAt = "";
  let restoring = false;
  let frameLoaded = false;
  let mirrorTimer = 0;
  const inflightCopies = new Set();
  const sigOf = (p) => JSON.stringify([p.tag || "", p.selector || "", p.prompt || "", (p.attachments || []).map((a) => a.id)]);
  const isComment = (p) => !((p.tag === "message" && !p.selector) || p.tag === "verdict");
  const sentSet = (extra) => new Set([...sentSigs, ...(Array.isArray(extra) ? extra : [])].map((x) => x && x.sig).filter(Boolean));
  /** Union of the sent-signature records (ours + a mirror's), newest first, capped; never a replacement. */
  function mergeSent(list) {
    if (!Array.isArray(list) || !list.length) return;
    const seen = new Set(); const out = [];
    for (const x of [...list, ...sentSigs].sort((a, b) => String(b?.at || "").localeCompare(String(a?.at || "")))) { if (!x || !x.sig || seen.has(x.sig)) continue; seen.add(x.sig); out.push({ sig: x.sig, at: x.at || "" }); }
    sentSigs = out.slice(0, 50);
  }
  /** Drop queued items that a mirror lists as sent (they were delivered from another tab). Returns how many. */
  function dropSentFromQueue(m) {
    const gone = queued.filter((p) => (m?.sent || []).some((x) => x && x.sig === sigOf(p)));
    if (!gone.length) return 0;
    for (const p of gone) queued.splice(queued.indexOf(p), 1);
    restoring = true; try { persistQueuedPrompts(); } finally { restoring = false; }
    render();
    return gone.length;
  }
  const validMirror = (m) => (m && typeof m === "object" && Array.isArray(m.items)
    ? { v: 1, at: String(m.at || ""), by: String(m.by || ""), items: m.items.filter((p) => p && typeof p === "object"), files: m.files && typeof m.files === "object" ? m.files : {}, draft: m.draft && typeof m.draft === "object" ? m.draft : null, sent: Array.isArray(m.sent) ? m.sent : [] }
    : null);
  const readMirror = () => validMirror(ls.get(QUEUE_MIRROR_KEY, null));
  const currentDraft = () => (typeof lastReviewState !== "undefined" && lastReviewState ? lastReviewState : null);
  function buildMirror() { return { v: 1, at: now(), by: tabId, items: queued.map((p) => ({ ...p })), files: homeCopies, draft: currentDraft(), sent: sentSigs.slice(0, 50) }; }
  function writeMirror() {
    const m = buildMirror(); lastMirrorAt = m.at; ls.set(QUEUE_MIRROR_KEY, m);
    clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(pushMirror, 350);
  }
  // Pull before push: a tab that was open while another tab pressed Send still holds those items in its
  // queue. Writing them as a "newer" mirror would resurrect them everywhere, so the shared copy's sent
  // list is merged first and anything it names is dropped here before this tab's queue is written.
  async function pushMirror() {
    try {
      const r = await fetch(HOME + "/api/queue/" + encodeURIComponent(key), { cache: "no-store" });
      if (r.ok) {
        const remote = validMirror(await r.json());
        if (remote && remote.sent?.length) {
          mergeSent(remote.sent);
          const n = dropSentFromQueue(remote);
          if (n) showRailNotice(n + " queued comment(s) were already sent from another tab.");
        }
      }
    } catch { /* home page down: write what we have */ }
    const m = buildMirror(); lastMirrorAt = m.at; ls.set(QUEUE_MIRROR_KEY, m);
    fetch(HOME + "/api/queue/" + encodeURIComponent(key), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(m) }).catch(() => {});
  }
  // Lavish keeps an unsent upload only 7 days (an hour under disk pressure); a private copy keeps it whole.
  async function ensureHomeCopies() {
    for (const p of queued) for (const ref of p.attachments || []) {
      const id = String(ref.id || ""); if (!id || homeCopies[id] || inflightCopies.has(id)) continue;
      inflightCopies.add(id);
      try { homeCopies[id] = await uploadToHome(await fetchFile({ url: lavishFileUrl(id), name: ref.name || "image" })); writeMirror(); }
      catch { /* the Lavish copy is still valid; retried on the next persist */ }
      finally { inflightCopies.delete(id); }
    }
  }
  function pruneHomeCopies() {
    const live = new Set(); for (const p of queued) for (const ref of p.attachments || []) live.add(String(ref.id));
    for (const id of Object.keys(homeCopies)) {
      const c = homeCopies[id]; if (live.has(id) || keepHome.has(c?.id)) continue;
      delete homeCopies[id];
      if (c?.id) fetch(HOME + "/api/notes/" + encodeURIComponent(key) + "/files/" + encodeURIComponent(c.id), { method: "DELETE" }).catch(() => {});
    }
  }
  /** Before Send: re-upload from the private copy anything Lavish has expired; drop what cannot be recovered, and say so. */
  async function revalidateAttachments() {
    const dropped = []; let changed = false;
    for (const p of queued.slice()) {
      for (const ref of (p.attachments || []).slice()) {
        const id = String(ref.id || "");
        let ok = true; try { ok = (await fetch(lavishFileUrl(id), { method: "HEAD", cache: "no-store" })).status !== 404; } catch { ok = true; }
        if (ok) continue;
        const copy = homeCopies[id];
        try { if (!copy) throw new Error("no private copy"); const fresh = await uploadToLavish(await fetchFile(copy)); ref.id = fresh.id; homeCopies[fresh.id] = copy; delete homeCopies[id]; changed = true; }
        catch { p.attachments = p.attachments.filter((a) => a !== ref); if (!p.attachments.length) delete p.attachments; dropped.push(ref.name || id.slice(0, 8)); changed = true; if (!String(p.prompt || "").trim() && !p.attachments) queued.splice(queued.indexOf(p), 1); }
      }
    }
    if (changed) { persistQueuedPrompts(); render(); }
    if (dropped.length) showRailNotice("Could not recover " + dropped.length + " expired image(s): " + dropped.join(", ") + ". The text was sent without them.", { kind: "warn" });
  }
  function restoreFromMirror(m, { source = "this browser", force = false } = {}) {
    if (!m) return 0;
    const ageDays = (Date.now() - new Date(m.at || 0).getTime()) / 864e5;
    if (!force && m.items.length && ageDays > STALE_MIRROR_DAYS) { showStaleNotice(m, source); return 0; }
    Object.assign(homeCopies, m.files || {});
    mergeSent(m.sent);
    // Anything this browser OR the mirror knows was sent is never re-queued: a stale copy of the queue
    // (an older tab, a localStorage mirror written before Send) must not resurrect delivered comments.
    const sent = sentSet();
    let n = 0;
    if (queued.length === 0 && m.items.length) {
      restoring = true;
      try { for (const p of m.items) { if (sent.has(sigOf(p))) continue; if (!queued.some((q) => sigOf(q) === sigOf(p))) { enqueuePrompt(p); if (isComment(p)) n++; } } } finally { restoring = false; }
      persistQueuedPrompts();
    }
    if (m.draft && m.draft.card && String(m.draft.card.text || "").trim() && typeof lastReviewState !== "undefined" && !hasUnsentDraft()) {
      lastReviewState = m.draft; // the chrome's own frame-load handler posts lavish:restoreReviewState
      if (typeof saveJsonState === "function") saveJsonState(reviewStateStorageKey, m.draft);
      if (frameLoaded) postToFrame({ type: "lavish:restoreReviewState", state: m.draft });
    }
    return n;
  }
  async function pullQueue() {
    try {
      const r = await fetch(HOME + "/api/queue/" + encodeURIComponent(key), { cache: "no-store" }); if (!r.ok) return;
      const remote = validMirror(await r.json()); if (!remote) return;
      const local = readMirror();
      reconcile(remote); // its sent list counts whatever its age and whoever wrote it (this tab before a reload included)
      if (remote.by !== tabId && remote.at && remote.at > (local?.at || "")) {
        const n = restoreFromMirror(remote, { source: "the Lavish home page" });
        if (n) showRestoredNotice(n, "the Lavish home page");
      }
    } catch { /* home page down: this browser's copy only */ }
  }
  /** A newer mirror written elsewhere: items it lists as sent are gone from our queue. */
  function reconcile(m) {
    if (!m) return;
    // A mirror's sent list is evidence whatever its age: once sent, never queued again anywhere.
    mergeSent(m.sent);
    const n = dropSentFromQueue(m);
    if (n) showRailNotice(n + " queued comment(s) were sent from another tab.");
  }
  window.addEventListener("storage", (e) => {
    if (e.key !== QUEUE_MIRROR_KEY || !e.newValue) return;
    try { const m = validMirror(JSON.parse(e.newValue)); reconcile(m); if (queued.length === 0 && m?.items.length) { const n = restoreFromMirror(m, { source: "another tab" }); if (n) showRestoredNotice(n, "another tab"); } } catch { /* ignore */ }
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { pullQueue(); refreshRegistry(); } });
  const noticeEl = rail.querySelector("#lavishRailNotice");
  function showRailNotice(text, { kind = "info", actions = [] } = {}) {
    noticeEl.className = "lavish-rail-notice is-" + kind; noticeEl.hidden = false;
    noticeEl.querySelector("span").textContent = text;
    const acts = noticeEl.querySelector(".lavish-rail-notice-acts"); acts.innerHTML = "";
    for (const a of actions) { const b = document.createElement("button"); b.type = "button"; b.textContent = a.label; b.onclick = () => { hideRailNotice(); a.run(); }; acts.appendChild(b); }
    setRailOpen(true, false);
  }
  function hideRailNotice() { if (noticeEl) noticeEl.hidden = true; }
  noticeEl.querySelector("[data-act=dismiss]").addEventListener("click", hideRailNotice);
  const showRestoredNotice = (n, source) => showRailNotice("Restored " + n + " unsent comment" + (n === 1 ? "" : "s") + " from " + source + "." + (ended ? " This session has ended: keep them private, or reopen it from Home." : ""));
  function showStaleNotice(m, source) { showRailNotice(m.items.length + " unsent comment(s) from " + fmtTime(m.at) + " were not restored.", { actions: [{ label: "Restore", run: () => { const n = restoreFromMirror(m, { source, force: true }); if (n) showRestoredNotice(n, source); } }, { label: "Discard", run: clearMirror }] }); }
  function clearMirror() { homeCopies = {}; sentSigs = []; writeMirror(); }

  /* ── version chip: which version is on screen, which round, how it was edited ── */
  let versionIndex = null, versionTimer = 0;
  const fmtStamp = (iso) => { const t = new Date(iso); if (isNaN(t)) return ""; return t.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + t.toTimeString().slice(0, 5); };
  const versionWhy = (v) => v.label || ({ "agent-reply": "agent replied", poll: "agent polled", baseline: "first snapshot", scan: "file changed on disk", chrome: "opened in Lavish", "pre-restore": "before a restore", restore: "restored version" }[v.reason] || v.reason || "");
  async function refreshVersions({ snapshot = false } = {}) {
    try {
      const r = await fetch(HOME + "/api/versions/" + encodeURIComponent(key) + (snapshot ? "/snapshot" : ""), { method: snapshot ? "POST" : "GET", cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      versionIndex = await r.json();
    } catch { versionIndex = null; }
    renderVersionChip();
  }
  function renderVersionChip() {
    if (!versionChip) return;
    const vs = versionIndex?.versions || [];
    if (!vs.length) { versionChip.textContent = "v?"; versionChip.title = "No version saved yet (the home page is unreachable or the file is new)"; versionMenu.innerHTML = ""; return; }
    const latest = vs[vs.length - 1];
    const cur = versionIndex.current != null ? vs.find((v) => v.n === versionIndex.current) : null;
    const shown = cur || latest;
    const prev = vs.filter((v) => v.n < shown.n).pop();
    const delta = prev ? shown.lines - prev.lines : 0;
    versionChip.innerHTML = "v" + shown.n + (shown.round != null ? ' <span class="lavish-version-round">round ' + shown.round + "</span>" : "") + (!cur ? ' <span class="lavish-version-round" title="The file on disk differs from every saved version; it is snapshotted within seconds">edited</span>' : "");
    versionChip.title = "v" + shown.n + " of " + vs.length + " · saved " + fmtStamp(shown.at) + " · " + versionWhy(shown) + (prev ? " · " + (delta >= 0 ? "+" : "") + delta + " text lines vs v" + prev.n : "") + ". Click for the history.";
    const home = versionIndex.home || HOME;
    versionMenu.innerHTML = '<div class="menu-head"><div class="menu-label">Versions of this plan</div></div>' + vs.slice().reverse().map((v) => {
      const p = vs.filter((x) => x.n < v.n).pop();
      const d = p ? v.lines - p.lines : 0;
      return '<div class="lavish-version-row' + (v.n === shown.n ? " is-current" : "") + '"><div class="lavish-version-main"><b>v' + v.n + "</b>" + (v.round != null ? ' <span class="lavish-version-round">round ' + v.round + "</span>" : "") + ' <span class="lavish-version-when">' + esc(fmtStamp(v.at)) + "</span>" + (v.n === shown.n ? ' <span class="lavish-version-here">on screen</span>' : "") + '<div class="lavish-version-why">' + esc(versionWhy(v)) + (p ? ' · <span class="' + (d > 0 ? "up" : d < 0 ? "down" : "") + '">' + (d >= 0 ? "+" : "") + d + " lines</span>" : "") + "</div></div>" +
        '<div class="lavish-version-acts"><a href="' + esc(home) + "/version/" + encodeURIComponent(key) + "/" + v.n + '/" target="_blank" rel="noopener">view</a>' + (p ? '<a href="' + esc(home) + "/diff/" + encodeURIComponent(key) + "/" + p.n + "/" + v.n + '" target="_blank" rel="noopener">what changed</a>' : "") + "</div></div>";
    }).join("") + '<div class="menu-rule"></div><button class="menu-item" type="button" id="lavishVersionHistory"><span>Full history, diffs and restore on the home page</span></button>';
    versionMenu.querySelector("#lavishVersionHistory")?.addEventListener("click", () => { openExternal(home + "/session/" + encodeURIComponent(key) + "#versions"); setVersionMenu(false); });
  }
  function setVersionMenu(open) { if (!versionMenu) return; versionMenu.hidden = !open; versionChip?.setAttribute("aria-expanded", String(open)); }
  versionChip?.addEventListener("click", (event) => { event.stopPropagation(); if (typeof closeMenus === "function") closeMenus(); setStageMenu(false); setVersionMenu(versionMenu.hidden); });
  document.addEventListener("click", (event) => { if (versionMenu && !versionMenu.hidden && !event.target.closest("#lavishVersionWrap")) setVersionMenu(false); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && versionMenu && !versionMenu.hidden) setVersionMenu(false); });
  function scheduleVersionRefresh(ms, opts) { clearTimeout(versionTimer); versionTimer = setTimeout(() => refreshVersions(opts), ms); }

  /* ── stage chip: which stage the plan is in, who is working on it, the latest progress ── */
  let registryInfo = null, registryTimer = 0;
  const STAGE_ORDER = ["planning", "developing", "review", "done"];
  const STAGE_LABEL = { planning: "Planning", developing: "Developing", review: "Review", done: "Done", parked: "Parked" };
  async function refreshRegistry() {
    try { const r = await fetch(HOME + "/api/registry/" + encodeURIComponent(key), { cache: "no-store" }); if (!r.ok) throw new Error(String(r.status)); registryInfo = (await r.json()).plan || null; }
    catch { registryInfo = null; }
    renderStageChip();
  }
  function scheduleRegistryRefresh(ms) { clearTimeout(registryTimer); registryTimer = setTimeout(refreshRegistry, ms); }
  function renderStageChip() {
    if (!stageChip) return;
    const p = registryInfo;
    if (!p) { stageChip.textContent = "Stage ?"; stageChip.dataset.stage = ""; stageChip.title = "The home page (" + HOME + ") is unreachable"; stageMenu.innerHTML = ""; return; }
    const latest = p.progress?.latest || null;
    stageChip.dataset.stage = p.stage || "";
    stageChip.classList.toggle("is-inferred", Boolean(p.stageInferred));
    stageChip.innerHTML = esc(p.stageLabel || STAGE_LABEL[p.stage] || "Stage") + (p.subLabel ? ' <span class="lavish-version-round">' + esc(p.subLabel) + "</span>" : "");
    stageChip.title = (latest ? latest.text + " \u00b7 " + (latest.session?.label || "") + " \u00b7 " + fmtTime(latest.at) : "No progress notes yet") + (p.stageNote ? " \u00b7 " + p.stageNote : "") + ". Click for the timeline.";
    const steps = STAGE_ORDER.map((st) => '<span class="' + (p.stage === st ? "is-now" : STAGE_ORDER.indexOf(st) < (p.stageIndex ?? -1) ? "is-past" : "") + '">' + STAGE_LABEL[st] + "</span>").join("");
    const entries = (p.progress?.entries || []).slice(-8).reverse().map((e) => '<div class="lavish-stage-row"><span class="lavish-version-when">' + esc(fmtTime(e.at)) + '</span><span class="lavish-stage-sess">' + esc(e.session?.label || "") + "</span><div>" + esc(e.text) + (e.pct != null ? " \u00b7 " + e.pct + "%" : "") + "</div></div>").join("");
    stageMenu.innerHTML = '<div class="menu-head"><div class="menu-label">Stage of this plan</div></div><div class="lavish-stage-steps' + (p.stage === "parked" ? " is-parked" : "") + '">' + steps + "</div>" +
      '<div class="lavish-stage-meta">' + esc(String(p.status || "").replace("-", " ")) + (p.stageInferred ? " (inferred)" : "") + " \u00b7 priority " + esc(p.priority || "normal") + (p.progress?.pct != null ? " \u00b7 " + p.progress.pct + "% done" : "") + "</div>" +
      (p.session?.label ? '<div class="lavish-stage-meta">Working session: <b>' + esc(p.session.label) + "</b>" + (p.session.at ? " \u00b7 " + esc(fmtTime(p.session.at)) : "") + "</div>" : "") +
      (entries || '<div class="lavish-stage-meta">No progress notes yet. The agent posts them with lavish-meta --progress; status and PR changes log themselves.</div>') +
      '<div class="menu-rule"></div><button class="menu-item" type="button" id="lavishStageTimeline"><span>Timeline and progress notes on the home page</span></button><button class="menu-item" type="button" id="lavishStageExport"><span>Export with options\u2026</span></button>';
    stageMenu.querySelector("#lavishStageTimeline")?.addEventListener("click", () => { openExternal(HOME + "/session/" + encodeURIComponent(key) + "#progress"); setStageMenu(false); });
    stageMenu.querySelector("#lavishStageExport")?.addEventListener("click", () => { openExternal(HOME + "/session/" + encodeURIComponent(key) + "#export"); setStageMenu(false); });
  }
  function setStageMenu(open) { if (!stageMenu) return; stageMenu.hidden = !open; stageChip?.setAttribute("aria-expanded", String(open)); }
  stageChip?.addEventListener("click", (event) => { event.stopPropagation(); if (typeof closeMenus === "function") closeMenus(); setVersionMenu(false); setStageMenu(stageMenu.hidden); });
  document.addEventListener("click", (event) => { if (stageMenu && !stageMenu.hidden && !event.target.closest("#lavishStageWrap")) setStageMenu(false); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") setStageMenu(false); });

  /* ── anchors + pins (patched SDK), Detached detection ────────────────── */
  let anchorReq = 0, anchorTimer = 0, anchorTimeout = 0;
  function requestAnchors() {
    clearTimeout(anchorTimer);
    anchorTimer = setTimeout(() => {
      const anchors = cards().filter((c) => c.anchor?.selector && c.kind !== "resolved").map((c) => ({ id: c.id, selector: c.anchor.selector, text: matchTextOf(c), tag: c.anchor.tag, section: c.anchor.section || "", state: c.kind, n: numbering.get(c.id) ?? null }));
      const signature = JSON.stringify(anchors);
      if (signature === lastAnchorSignature && anchorsSupported !== null) return;
      lastAnchorSignature = signature;
      postToFrame({ type: "lavish:resolveAnchors", requestId: ++anchorReq, anchors });
      if (anchorsSupported === null && anchors.length) {
        clearTimeout(anchorTimeout);
        anchorTimeout = setTimeout(() => { if (anchorsSupported === null) { anchorsSupported = false; renderRail(); } }, 2500);
      }
    }, 200);
  }
  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    const msg = event.data || {};
    if (String(msg.artifact_load_token || "") !== artifactLoadToken) return;
    if (msg.type === "lavish:anchorsResolved") {
      anchorsSupported = true;
      clearTimeout(anchorTimeout);
      let dirty = false;
      for (const r of Array.isArray(msg.results) ? msg.results : []) {
        anchorInfo.set(r.id, r);
        if (!r.found || !r.selector) continue;
        // The SDK found the element (by selector, section or text): keep its current address, section and text,
        // so the next resolution starts from what the document says now (Docs re-anchors the same way).
        const qi = queuedIndex(String(r.id));
        if (qi >= 0 && queued[qi]) { const q = queued[qi]; if (q.selector !== r.selector || (r.section && q.section !== r.section)) { q.selector = r.selector; if (r.section) q.section = r.section; persistQueuedPrompts(); } }
        const n = noteById(r.id);
        if (n?.anchor) {
          const isSuggestion = n.anchor.tag === "suggestion";
          const next = { selector: r.selector, section: r.section || n.anchor.section || "", text: isSuggestion ? n.anchor.text : (r.text || n.anchor.text) };
          if (next.selector !== n.anchor.selector || next.section !== (n.anchor.section || "") || next.text !== n.anchor.text) { Object.assign(n.anchor, next); n.updated = now(); dirty = true; }
        }
      }
      if (dirty) saveNotes();
      renderRail();
    }
    if (msg.type === "lavish:privateNote") addPrivate(msg.prompt);
    if (msg.type === "lavish:focusNote") focusCard(String(msg.id || ""));
  });
  frame.addEventListener("load", () => { frameLoaded = true; lastAnchorSignature = ""; setTimeout(() => { setMode(commentMode, false); requestAnchors(); }, 900); scheduleVersionRefresh(1500, { snapshot: true }); });
  setInterval(() => { refreshVersions(); refreshRegistry(); }, 30_000);

  /* ── hooks into the chrome ───────────────────────────────────────────── */
  const origRender = render;
  render = function lavishLocalRenderHook() {
    const result = origRender.apply(this, arguments);
    for (const close of annotationPills.querySelectorAll(".pill-close")) {
      const pill = close.closest(".pill");
      const preview = pill?.querySelector(".pill-preview");
      if (preview && !preview.dataset.lavishEdit) {
        preview.dataset.lavishEdit = "1";
        preview.title = "Click to edit in the Comments rail";
        preview.style.cursor = "text";
        preview.addEventListener("click", (event) => { event.stopPropagation(); openEdit("q:" + close.dataset.index); });
      }
    }
    renderRail();
    return result;
  };
  const origPersist = persistQueuedPrompts;
  persistQueuedPrompts = function lavishLocalPersistHook() {
    const r = origPersist.apply(this, arguments);
    if (!restoring) { pruneHomeCopies(); writeMirror(); ensureHomeCopies(); }
    return r;
  };
  if (typeof setReviewState === "function") {
    const origSetReviewState = setReviewState;
    setReviewState = function lavishLocalReviewStateHook() { const r = origSetReviewState.apply(this, arguments); if (!restoring) writeMirror(); return r; };
  }
  const origSubmit = submitQueuedOnce;
  submitQueuedOnce = async function lavishLocalSubmitHook() {
    busy++; renderRail();
    try { await revalidateAttachments(); } finally { busy--; }
    const batch = queued.slice();
    // Home copies of images about to be sent stay: sent cards show them after Lavish's 7-day TTL.
    for (const p of batch) for (const ref of p.attachments || []) { const c = homeCopies[String(ref.id)]; if (c?.id) keepHome.add(c.id); }
    const result = await origSubmit.apply(this, arguments);
    if (result !== false) {
      const delivered = batch.filter((p) => !queued.includes(p));
      let changed = false;
      for (const p of delivered) {
        if (p.tag === "message" && !p.selector) continue; // the composer already added its bubble
        addChat("user", p.tag === "verdict" ? summarize({ ...p, text: p.prompt }) : summarize(p), true, "annotation");
        if (p.tag === "verdict") continue;
        const refs = refsOf(p).map((r) => { const c = homeCopies[r.id]; return c?.url ? { id: r.id, name: r.name, url: c.url } : r; });
        notes.push({ id: uid(), state: "sent", anchor: anchorOf(p), body: String(p.prompt || ""), created: now(), updated: now(), sentAt: now(), ...(refs.length ? { attachments: refs } : {}) });
        changed = true;
      }
      mergeSent(delivered.map((p) => ({ sig: sigOf(p), at: now() })));
      hideRailNotice();
      if (changed) { saveNotes(); renderRail(); }
      writeMirror();
    }
    return result;
  };
  // The server re-sends the whole chat when the browser reconnects. Sent comments live in our record too,
  // so if the server copy lacks one (an unpatched server, a restore, a lost write) it is merged back in.
  const origSyncChat = syncChat;
  syncChat = function lavishLocalSyncHook(chat) {
    const list = Array.isArray(chat) ? chat.slice() : [];
    for (const n of notes) {
      if (!n.sentAt) continue;
      const summary = summarize(promptFrom(n.anchor, n.body));
      if (!list.some((c) => c.role === "user" && (c.text === summary || (n.body && String(c.text || "").endsWith(n.body))))) list.push({ role: "user", kind: "annotation", text: summary, at: n.sentAt });
    }
    list.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
    return origSyncChat.call(this, list);
  };
  const origAddChat = addChat;
  addChat = function lavishLocalAddChatHook(role, text, shouldScroll, kind) {
    const el = origAddChat.apply(this, arguments);
    if (role === "agent") { threadReply(String(text || "")); scheduleVersionRefresh(2500); scheduleRegistryRefresh(2500); }
    return el;
  };
  const origSendQueued = sendQueued;
  sendQueued = function lavishLocalSendHook(endAfter) {
    const v = verdictEl ? verdictEl.value : "";
    if (v && !ended) {
      const label = v === "approve" ? "Approve" : "Request changes";
      queued.push({ uid: "", prompt: "Review verdict: " + label, selector: "", tag: "verdict", text: "Review verdict: " + label });
      persistQueuedPrompts();
      postRegistry({ status: v === "approve" ? "approved" : "in-review", progress: "Review verdict: " + label, progressKind: "verdict", session: { label: "reviewer (Lavish)" } });
      scheduleRegistryRefresh(900);
      verdictEl.value = "";
    }
    return origSendQueued.apply(this, arguments);
  };

  /* ── boot ────────────────────────────────────────────────────────────── */
  const remembered = ls.get(RAIL_OPEN_KEY, null);
  setRailOpen(remembered === null ? cards().length > 0 : Boolean(remembered), false);
  setChatOpen(ls.get(CHAT_OPEN_KEY, true) !== false, false);
  setMode(commentMode, false);
  const restoredLocal = restoreFromMirror(readMirror(), { source: "this browser" });
  renderRail();
  if (restoredLocal) showRestoredNotice(restoredLocal, "this browser");
  pullNotes();
  pullQueue();
  refreshVersions({ snapshot: true });
  refreshRegistry();
  window.__lavishLocalRail = { sigOf, sent: () => sentSigs, addPrivate, notes: () => notes, cards, render: renderRail, requestAnchors, select: selectCard, setMode, setFilter, attachFiles, refreshVersions, versions: () => versionIndex, refreshRegistry, registry: () => registryInfo, mirror: readMirror, homeCopies: () => homeCopies, revalidate: revalidateAttachments, restore: () => restoreFromMirror(readMirror(), { force: true }), pullQueue, open: (v = true) => setRailOpen(v) };
  /* ── presence: this tab tells the home page it is open on this plan (every 10 s, plan 2026-09-05 D6) ──────────
   * The home page counts the tabs per plan and, on "End session and close tabs" / "Close other tabs" / Restart, marks
   * them; a marked tab's next ping answers {close:true} and the tab closes itself (a page can close only itself). */
  (function lavishLocalPresence() {
    let stopped = false;
    const url = HOME + "/api/presence/" + encodeURIComponent(key);
    async function ping() {
      if (stopped) return;
      try {
        const r = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ tab: tabId, at: now(), title: document.title }) });
        if (!r.ok) return;
        const j = await r.json();
        if (j && j.close) {
          stopped = true;
          window.close();
          setTimeout(() => { if (!document.hidden) showRailNotice("The home page asked this tab to close (" + (j.reason || "session ended") + "). The browser kept it open: close it by hand.", { kind: "info" }); }, 600);
        }
      } catch { /* home page down: nothing to report */ }
    }
    ping();
    setInterval(ping, 10000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") ping(); });
    window.addEventListener("pagehide", () => { try { if (navigator.sendBeacon) navigator.sendBeacon(url + "?gone=1&tab=" + encodeURIComponent(tabId), ""); } catch { /* ignore */ } });
  })();
})();
