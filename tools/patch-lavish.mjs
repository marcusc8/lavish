#!/usr/bin/env node
/* patch-lavish.mjs — apply the local Lavish patches to a pinned lavish-axi install.
 *
 * What it changes (each edit is anchored on an exact code string and marked, so
 * running it twice is a no-op and a changed upstream file fails loudly):
 *   chrome-client.js  — paste in the composer converts clipboard text/html to Markdown
 *                     — chat bubbles render a "kind" (annotation vs typed message)
 *                     — the Comments rail (rail.client.js appended): private comments, editable queue,
 *                       sent-comment record + chat bubbles on Send, comment mode, chat hide, verdict,
 *                       Home / Version history links
 *   chrome.css        — the rail's styles and the light (Instagram-palette) theme (rail.css appended)
 *   cli.mjs (server)  — EVERY sent prompt is copied into the persistent chat log, not only
 *                       tag === "message"; annotations get a one-line summary + kind
 *   cli.mjs (SDK)     — the annotation card's textarea gets the same paste conversion
 *                     — mode-aware card buttons (Keep private / Queue / Suggest edit), window.lavish.privateNote(),
 *                       anchor resolution + numbered pins + tint on commented elements, click-to-highlight
 *                       (lavish:resolveAnchors / setCommentMode / selectAnchor), light-theme card, blue accent
 *
 * chrome-client.js and chrome.css are read from disk on every request, so those edits are live on the
 * next page reload. cli.mjs is loaded once per server process, so its edits need `lavish-axi stop` and
 * a fresh `lavish-axi <file>` (that kills every session's in-flight poll; they just re-run).
 *
 * Iterating on an edit that is already applied: reinstall the pinned version first
 * (`npm i -g lavish-axi@$(cat pinned-version.txt)`), then run this script again.
 *
 * Usage: node patch-lavish.mjs [--check] [--reapply-rail] [--target <lavish-axi package dir>]
 *   --check         report which anchors are present / already patched, change nothing (exit 1 if any anchor is missing)
 *   --reapply-rail  after editing rail.client.js / rail.css: cut the appended rail block off chrome-client.js and
 *                   chrome.css and append the current files (syntax-gated). Live on the next reload; no server restart.
 * Default target: $(npm root -g)/lavish-axi
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const check = args.includes("--check");
const targetIdx = args.indexOf("--target");
const target = targetIdx !== -1 ? args[targetIdx + 1] : join(execSync("npm root -g").toString().trim(), "lavish-axi");
const clientPath = join(target, "dist", "chrome-client.js");
const cliPath = join(target, "dist", "cli.mjs");
const cssPath = join(target, "dist", "chrome.css");
for (const p of [clientPath, cliPath, cssPath]) if (!existsSync(p)) fail(`not found: ${p}`);
const version = JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version;

const html2md = readFileSync(join(here, "html2md.js"), "utf8");
const railJs = readFileSync(join(here, "rail.client.js"), "utf8");
const railCss = readFileSync(join(here, "rail.css"), "utf8");
// Shared helper: returns true when it handled the paste (structured HTML on the clipboard).
const pasteHelper = `
function lavishLocalPasteAsMarkdown(event, textarea) {
  try {
    const dt = event.clipboardData; if (!dt) return false;
    if (Array.from(dt.files || []).length) return false; /* image paste: leave to the existing handler */
    const html = dt.getData("text/html"); if (!html) return false;
    const md = window.__lavishHtmlToMarkdown ? window.__lavishHtmlToMarkdown(html) : ""; if (!md) return false;
    event.preventDefault();
    const start = textarea.selectionStart ?? textarea.value.length, end = textarea.selectionEnd ?? start;
    textarea.setRangeText(md, start, end, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  } catch (e) { console.warn("lavish-local paste-md fallback", e); return false; }
}
`;

// SDK side of the Comments rail: resolve anchors (selector, then text match), report document order,
// draw pins, tint commented elements, highlight the selected one, and follow the comment mode.
const sdkAnchors = String.raw`    if (msg.type === "lavish:resolveAnchors") lavishLocalResolveAnchors(msg.anchors, msg.requestId);
    if (msg.type === "lavish:setCommentMode") lavishLocalCommentMode = msg.mode === "private" ? "private" : "agent";
    if (msg.type === "lavish:selectAnchor") lavishLocalSelectAnchor(msg);
  });
  /* lavish-local-patch:sdk-anchors */
  let lavishLocalCommentMode = "agent";
  let lavishLocalPins = [];
  let lavishLocalPinFrame = 0;
  let lavishLocalMarked = new Set();
  const LAVISH_LOCAL_TINT = '[data-lavish-note-state]{background:rgba(142,142,142,.10)!important;border-radius:3px}[data-lavish-note-state="queued"]{background:rgba(0,149,246,.11)!important}[data-lavish-note-state="sent"]{background:rgba(47,158,68,.11)!important}[data-lavish-note-active]{background:rgba(0,149,246,.20)!important;outline:2px solid rgba(0,149,246,.85)!important;outline-offset:3px}';
  function lavishLocalEnsureTintStyle() {
    if (document.getElementById("lavish-local-note-style")) return;
    const st = document.createElement("style");
    st.id = "lavish-local-note-style";
    st.textContent = LAVISH_LOCAL_TINT;
    document.head.appendChild(st);
  }
  function lavishLocalTextOf(el) { return String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(); }
  // Where an element sits: the section it belongs to (details[data-sec], else the nearest heading above it).
  // Insertions elsewhere in the document do not change it, unlike an nth-of-type selector.
  function lavishLocalSectionOf(el) {
    if (!(el instanceof Element)) return "";
    const det = el.closest("details[data-sec]");
    if (det) return String(det.getAttribute("data-sec") || "").slice(0, 120);
    let n = el;
    while (n && n !== document.body) {
      let p = n.previousElementSibling;
      while (p) {
        if (/^H[1-4]$/.test(p.tagName)) return lavishLocalTextOf(p).slice(0, 120);
        const hs = p.querySelectorAll ? p.querySelectorAll("h1,h2,h3,h4") : [];
        if (hs.length) return lavishLocalTextOf(hs[hs.length - 1]).slice(0, 120);
        p = p.previousElementSibling;
      }
      n = n.parentElement;
    }
    return "";
  }
  function lavishLocalSectionRoot(section) {
    if (!section) return null;
    const det = [...document.querySelectorAll("details[data-sec]")].find((d) => String(d.getAttribute("data-sec") || "").slice(0, 120) === section);
    if (det) return det;
    const h = [...document.querySelectorAll("h1,h2,h3,h4")].find((x) => lavishLocalTextOf(x).slice(0, 120) === section);
    return h ? (h.closest("section, details, article") || h.parentElement) : null;
  }
  const lavishLocalWords = (t) => String(t || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  // Similarity in [0, 1]: 1 when the element still starts with the remembered text, else Dice over word bigrams,
  // which survives rewording of a paragraph far better than an exact match.
  function lavishLocalSimilarity(elText, want) {
    const a = String(elText || "").replace(/\s+/g, " ").trim(), b = String(want || "").replace(/\s+/g, " ").trim();
    if (!a || !b) return 0;
    if (a.startsWith(b.slice(0, 48))) return 1;
    const wa = lavishLocalWords(a).slice(0, 80), wb = lavishLocalWords(b).slice(0, 80);
    if (wa.length < 2 || wb.length < 2) return wa.join(" ") === wb.join(" ") ? 1 : 0;
    const bg = (w) => { const set = new Set(); for (let i = 0; i < w.length - 1; i++) set.add(w[i] + " " + w[i + 1]); return set; };
    const A = bg(wa), B = bg(wb); let inter = 0; for (const x of A) if (B.has(x)) inter++;
    return (2 * inter) / (A.size + B.size);
  }
  /** The element a comment refers to, in this order: its selector if the text still matches; the best match inside
   *  the remembered section; the best match anywhere; a weakly matching selector; else nothing (detached). */
  function lavishLocalResolveOne(a) {
    const want = String(a.text || "").replace(/\s+/g, " ").trim();
    const tag = /^[a-z][a-z0-9-]*$/.test(String(a.tag || "")) ? String(a.tag) : "*";
    let el = a.selector ? safeQuerySelector(String(a.selector)) : null;
    if (el && !(el instanceof Element)) el = null;
    const score = (x) => lavishLocalSimilarity(lavishLocalTextOf(x), want);
    if (el && (!want || score(el) >= 0.6)) return { el, how: "selector" };
    const best = (root) => { let b = null, bs = 0; for (const c of (root || document.body).querySelectorAll(tag)) { if (isLavishUi(c)) continue; const sc = score(c); if (sc > bs) { bs = sc; b = c; } } return { el: b, s: bs }; };
    if (want) {
      const inSection = best(lavishLocalSectionRoot(a.section));
      if (inSection.el && inSection.s >= 0.45) return { el: inSection.el, how: "section" };
      const anywhere = best(null);
      if (anywhere.el && anywhere.s >= 0.6) return { el: anywhere.el, how: "text" };
      if (el && score(el) >= 0.25) return { el, how: "weak" };
      if (inSection.el && inSection.s >= 0.2) return { el: inSection.el, how: "section-weak" };
      return { el: null, how: "detached" };
    }
    return el ? { el, how: "selector" } : { el: null, how: "detached" };
  }
  function lavishLocalResolveAnchors(anchors, requestId) {
    const results = [], live = [];
    for (const a of Array.isArray(anchors) ? anchors : []) {
      const r = lavishLocalResolveOne(a);
      if (!r.el) { results.push({ id: a.id, found: false }); continue; }
      results.push({ id: a.id, found: true, selector: selector(r.el), text: lavishLocalTextOf(r.el).slice(0, 240), section: lavishLocalSectionOf(r.el), how: r.how });
      live.push({ id: a.id, el: r.el, state: String(a.state || ""), n: a.n });
    }
    live.sort((x, y) => (x.el === y.el ? 0 : x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    live.forEach((x, i) => { const r = results.find((r) => r.id === x.id); if (r) r.order = i; });
    for (const el of lavishLocalMarked) el.removeAttribute("data-lavish-note-state");
    lavishLocalMarked = new Set();
    if (live.length) lavishLocalEnsureTintStyle();
    for (const p of live) { p.el.setAttribute("data-lavish-note-state", p.state || "private"); lavishLocalMarked.add(p.el); }
    lavishLocalPins = live;
    lavishLocalDrawPins();
    postArtifactMessage("lavish:anchorsResolved", { requestId, results });
  }
  /** Click on a card: re-resolve now (the document may have changed since the last pass), then highlight and scroll. */
  function lavishLocalSelectAnchor(msg) {
    for (const el of document.querySelectorAll("[data-lavish-note-active]")) el.removeAttribute("data-lavish-note-active");
    const a = msg && typeof msg === "object" ? msg : { selector: msg };
    if (!a.selector && !a.text) return;
    const el = lavishLocalResolveOne({ selector: a.selector, text: a.text, tag: a.tag, section: a.section }).el;
    if (!(el instanceof Element)) return;
    lavishLocalEnsureTintStyle();
    el.setAttribute("data-lavish-note-active", "");
    let d = el.closest("details");
    while (d) { d.open = true; d = d.parentElement ? d.parentElement.closest("details") : null; }
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    lavishLocalSchedulePins();
  }
  function lavishLocalDrawPins() {
    const root = ensureShadow();
    for (const old of [...root.querySelectorAll(".lavish-note-pin")]) old.remove();
    for (const p of lavishLocalPins) {
      if (!p.el.isConnected) continue;
      const rect = p.el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.bottom < -40 || rect.top > window.innerHeight + 40) continue;
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "lavish-note-pin is-" + (p.state || "private");
      pin.textContent = p.n != null ? String(p.n) : "";
      pin.title = "Open this comment in the Comments rail";
      pin.style.left = Math.min(window.innerWidth - 26, Math.max(4, rect.right - 10)) + "px";
      pin.style.top = Math.max(4, rect.top - 8) + "px";
      pin.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); postArtifactMessage("lavish:focusNote", { id: p.id }); });
      root.appendChild(pin);
    }
  }
  function lavishLocalSchedulePins() {
    if (lavishLocalPinFrame) return;
    lavishLocalPinFrame = window.requestAnimationFrame(() => { lavishLocalPinFrame = 0; if (lavishLocalPins.length) lavishLocalDrawPins(); });
  }
  window.addEventListener("scroll", lavishLocalSchedulePins, { passive: true, capture: true });
  window.addEventListener("resize", lavishLocalSchedulePins);
  document.addEventListener("toggle", lavishLocalSchedulePins, true);
  function revealElement(selector2) {`;

// Mode-aware card: primary button follows the comment mode; "Suggest edit" turns the card into an
// old-text → new-text suggestion the agent applies verbatim (tag "suggestion", text = old, prompt = new).
const sdkCardHandler = String.raw`    sendButton.onclick = () => { lavishLocalPrimary(); };
    /* lavish-local-patch:sdk-private-handler */
    const lavishLocalPrivateButton = card.querySelector(".lavish-private");
    const lavishLocalSuggestButton = card.querySelector(".lavish-suggest");
    const lavishLocalHeading = card.querySelector(".lavish-heading");
    const lavishLocalHeadingText = lavishLocalHeading ? lavishLocalHeading.textContent : "";
    const lavishLocalPlaceholder = textarea.placeholder;
    const lavishLocalOldText = (options2.range ? String(options2.range.toString() || "") : String(anchor.innerText || anchor.textContent || "")).replace(/[ \t]+\n/g, "\n").trim();
    let lavishLocalSuggesting = false;
    function lavishLocalKeepPrivate() {
      const t = textarea.value.trim();
      if (t) postArtifactMessage("lavish:privateNote", { prompt: { ...c, prompt: t, section: lavishLocalSectionOf(anchor) } });
      closeCard();
      return true;
    }
    function lavishLocalQueueSuggestion() {
      const t = textarea.value.trim();
      if (t && t !== lavishLocalOldText) queuePrompt(t, { ...c, tag: "suggestion", text: lavishLocalOldText, queueKey: "" });
      closeCard();
      return true;
    }
    function lavishLocalPrimary() {
      return lavishLocalSuggesting ? lavishLocalQueueSuggestion() : lavishLocalCommentMode === "private" ? lavishLocalKeepPrivate() : tryQueue();
    }
    function lavishLocalApplyMode() {
      if (lavishLocalSuggesting) {
        sendButton.textContent = "Queue suggestion";
        if (lavishLocalPrivateButton) lavishLocalPrivateButton.hidden = true;
        if (lavishLocalSuggestButton) lavishLocalSuggestButton.hidden = true;
        if (lavishLocalHeading) lavishLocalHeading.textContent = "Suggest an edit: change the text, then queue";
        textarea.placeholder = "The new text";
      } else {
        const priv = lavishLocalCommentMode === "private";
        sendButton.textContent = priv ? "Save private note" : "Queue";
        if (lavishLocalPrivateButton) {
          lavishLocalPrivateButton.hidden = false;
          lavishLocalPrivateButton.textContent = priv ? "Queue to agent" : "Keep private";
          lavishLocalPrivateButton.title = priv ? "Send this one to the agent instead" : "Keep as a private comment in the Comments rail. Never sent to the agent.";
        }
        if (lavishLocalSuggestButton) lavishLocalSuggestButton.hidden = !lavishLocalOldText || c.tag === "mermaid-node";
        if (lavishLocalHeading) lavishLocalHeading.textContent = priv ? lavishLocalHeadingText.replace(/^Annotate/, "Private note on") : lavishLocalHeadingText;
        textarea.placeholder = priv ? "A note only you will see..." : lavishLocalPlaceholder;
      }
      positionCard();
    }
    if (lavishLocalPrivateButton) lavishLocalPrivateButton.onclick = () => { if (lavishLocalCommentMode === "private") tryQueue(); else lavishLocalKeepPrivate(); };
    if (lavishLocalSuggestButton) lavishLocalSuggestButton.onclick = () => {
      lavishLocalSuggesting = true;
      textarea.value = lavishLocalOldText;
      lavishLocalApplyMode();
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    };
    lavishLocalApplyMode();`;

// Light theme for the in-artifact card + pins, appended to the SDK's shadow stylesheet.
const sdkCss = ":host{color-scheme:light;--bg:#ffffff;--bg-panel:#ffffff;--bg-elevated:#fafafa;--fg:#262626;--fg-faint:#737373;--border:#dbdbdb;--accent:#0095f6;--accent-hover:#1877f2;--brass-ink:#ffffff;--steel-700:#efefef;--steel-600:#e2e2e2;--steel-400:#8e8e8e;--ink-700:#efefef;--shadow-floating:0 12px 40px rgba(0,0,0,.18)}"
  + ".lavish-annotation-card{border-color:#dbdbdb;box-shadow:0 12px 40px rgba(0,0,0,.18)}.lavish-annotation-card .lavish-cancel,.lavish-annotation-card .lavish-private,.lavish-annotation-card .lavish-suggest{background:#efefef;color:#262626}.lavish-annotation-card .lavish-cancel:hover,.lavish-annotation-card .lavish-private:hover,.lavish-annotation-card .lavish-suggest:hover{background:#e2e2e2}.lavish-annotation-card .lavish-cancel{margin-right:auto}.lavish-annotation-card .lavish-row{flex-wrap:wrap}.lavish-attachment-remove{color:#262626}.lavish-attachment-remove:hover{background:rgba(0,0,0,.08);color:#000}"
  + ".lavish-text-highlight{background:rgba(0,149,246,.18);box-shadow:0 0 0 1px rgba(0,149,246,.4)}"
  + ".lavish-note-pin{position:fixed;z-index:2147483646;width:18px;height:18px;border-radius:999px;border:1px solid #fff;background:#8e8e8e;color:#fff;font:700 10px/16px var(--font-sans);text-align:center;padding:0;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.25)}.lavish-note-pin.is-queued{background:#0095f6;color:#fff}.lavish-note-pin.is-sent{background:#2f9e44;color:#fff}.lavish-note-pin:hover{transform:scale(1.15)}";

const EDITS = [
  // ── chrome-client.js ────────────────────────────────────────────────────────────────────────
  {
    file: clientPath, id: "client:html2md",
    marker: "/* lavish-local-patch:html2md */",
    anchor: null, // prepend
    apply: (src) => `/* lavish-local-patch:html2md */ /* applied on lavish-axi ${version} */\n${html2md}\n${pasteHelper}\n${src}`,
  },
  {
    file: clientPath, id: "client:composer-paste",
    marker: "/* lavish-local-patch:composer-paste */",
    anchor: `chatInput.addEventListener("paste", (event) => {\n  const files = transferredFiles(event.clipboardData);`,
    replacement: `chatInput.addEventListener("paste", (event) => {\n  /* lavish-local-patch:composer-paste */\n  if (lavishLocalPasteAsMarkdown(event, chatInput)) return;\n  const files = transferredFiles(event.clipboardData);`,
  },
  {
    file: clientPath, id: "client:addChat-kind",
    marker: "/* lavish-local-patch:addChat-kind */",
    anchor: `function addChat(role, text, shouldScroll = true) {\n  if (!text) return;\n\n  const el = document.createElement("div");\n  el.className = "bubble " + role;\n  el.innerHTML = "<small>" + (role === "agent" ? "Agent" : "You") + "</small><div>" + escapeHtml(text) + "</div>";`,
    replacement: `function addChat(role, text, shouldScroll = true, kind = "") {\n  /* lavish-local-patch:addChat-kind */\n  if (!text) return;\n\n  const el = document.createElement("div");\n  el.className = "bubble " + role + (kind === "annotation" ? " lavish-local-annotation" : "");\n  if (kind === "annotation") { el.style.alignSelf = "stretch"; el.style.maxWidth = "100%"; }\n  el.innerHTML = "<small>" + (role === "agent" ? "Agent" : kind === "annotation" ? "You \\u00b7 sent annotation" : "You") + "</small><div>" + escapeHtml(text) + "</div>";`,
  },
  {
    file: clientPath, id: "client:syncChat-kind",
    marker: "/* lavish-local-patch:syncChat-kind */",
    anchor: `for (const item of chat) lastChatBubble = addChat(item.role, item.text, false) || lastChatBubble;`,
    replacement: `/* lavish-local-patch:syncChat-kind */\n  for (const item of chat) lastChatBubble = addChat(item.role, item.text, false, item.kind) || lastChatBubble;`,
  },
  {
    file: clientPath, id: "client:initialChat-kind",
    marker: "/* lavish-local-patch:initialChat-kind */",
    anchor: `initialChat.forEach((item) => addChat(item.role, item.text));`,
    replacement: `/* lavish-local-patch:initialChat-kind */\ninitialChat.forEach((item) => addChat(item.role, item.text, true, item.kind));`,
  },
  {
    file: clientPath, id: "client:review-rail",
    marker: "/* lavish-local-patch:review-rail */",
    anchor: null, // append: the rail hooks render()/submitQueuedOnce()/syncChat()/sendQueued() after the chrome defined them
    apply: (src) => `${src}\n${railJs}\n`,
  },
  // ── chrome.css ──────────────────────────────────────────────────────────────────────────────
  {
    file: cssPath, id: "css:review-rail",
    marker: "/* lavish-local-patch:review-rail */",
    anchor: null,
    apply: (src) => `${src}\n${railCss}\n`,
  },
  // ── cli.mjs: server ─────────────────────────────────────────────────────────────────────────
  {
    file: cliPath, id: "server:annotations-in-chat",
    marker: "/* lavish-local-patch:annotations-in-chat */",
    anchor: `const userMessages = restoring ? [] : acceptedPrompts.filter((prompt) => prompt.tag === "message" && prompt.prompt).map((prompt) => ({ role: "user", text: prompt.prompt, at: (/* @__PURE__ */ new Date()).toISOString() }));`,
    replacement: `/* lavish-local-patch:annotations-in-chat */\n    const userMessages = restoring ? [] : acceptedPrompts.filter((prompt) => prompt.prompt).map((prompt) => prompt.tag === "message" ? { role: "user", text: prompt.prompt, at: new Date().toISOString() } : { role: "user", kind: "annotation", text: lavishLocalSummarizePrompt(prompt), at: new Date().toISOString() });`,
  },
  {
    file: cliPath, id: "server:summarize-fn",
    marker: "/* lavish-local-patch:summarize-fn */",
    anchor: `function sessionKey(file) {\n  return crypto4.createHash("sha256").update(file).digest("hex").slice(0, 16);\n}`,
    replacement: `/* lavish-local-patch:summarize-fn */\nfunction lavishLocalSummarizePrompt(prompt) {\n  const tag = String(prompt.tag || "");\n  const body = String(prompt.prompt || "");\n  const where = String(prompt.text || "").replace(/\\s+/g, " ").trim();\n  const semantic = /^(choice|export|review|note|whiteboard|layout-warnings|mermaid-node|suggestion|verdict)$/.test(tag);\n  const head = !tag ? "" : semantic ? "[" + tag + "] " : "on <" + tag + "> ";\n  const quoted = where && where !== body ? "\\u201c" + where.slice(0, 90) + (where.length > 90 ? "\\u2026" : "") + "\\u201d \\u2014 " : "";\n  return head + quoted + body;\n}\nfunction sessionKey(file) {\n  return crypto4.createHash("sha256").update(file).digest("hex").slice(0, 16);\n}`,
  },
  // ── cli.mjs: SDK ────────────────────────────────────────────────────────────────────────────
  {
    file: cliPath, id: "sdk:card-paste",
    marker: "/* lavish-local-patch:sdk-card-paste */",
    anchor: `    textarea.addEventListener("paste", (event) => {\n      const { images, keepTextPaste } = planClipboardPaste(event.clipboardData, ATTACHMENT_ACCEPTED_MIME);`,
    replacement: `    /* lavish-local-patch:sdk-card-paste */\n    ${html2md.replace(/\n/g, "\n    ")}\n    ${pasteHelper.replace(/\n/g, "\n    ")}\n    textarea.addEventListener("paste", (event) => {\n      if (lavishLocalPasteAsMarkdown(event, textarea)) return;\n      const { images, keepTextPaste } = planClipboardPaste(event.clipboardData, ATTACHMENT_ACCEPTED_MIME);`,
  },
  {
    file: cliPath, id: "sdk:card-buttons",
    marker: 'class="lavish-private"',
    anchor: `<button class="lavish-send" type="button">Queue</button>`,
    replacement: `<button class="lavish-private" type="button">Keep private</button><button class="lavish-suggest" type="button" title="Edit this text yourself; the agent applies your version verbatim">Suggest edit</button><button class="lavish-send" type="button">Queue</button>`,
  },
  {
    file: cliPath, id: "sdk:card-handler",
    marker: "/* lavish-local-patch:sdk-private-handler */",
    anchor: `    sendButton.onclick = () => {\n      tryQueue();\n    };`,
    replacement: sdkCardHandler,
  },
  {
    file: cliPath, id: "sdk:card-enter-key",
    marker: "/* lavish-local-patch:sdk-enter-key */",
    anchor: `        const queued = tryQueue();\n        if (queued && sendNow) sendQueuedPrompts();`,
    replacement: `        /* lavish-local-patch:sdk-enter-key */\n        const queued = lavishLocalPrimary();\n        if (queued && sendNow && !(lavishLocalCommentMode === "private" && !lavishLocalSuggesting)) sendQueuedPrompts();`,
  },
  {
    file: cliPath, id: "sdk-section-capture",
    marker: "/* lavish-local-patch:sdk-section-capture */",
    anchor: `    const queueKey = typeof deriveQueueKey === "function" ? deriveQueueKey(originElement, options2) : "";`,
    replacement: `    /* lavish-local-patch:sdk-section-capture */\n    { const lavishLocalAnchorEl = (options2.selector && safeQuerySelector(String(options2.selector))) || originElement; item.section = lavishLocalSectionOf(lavishLocalAnchorEl instanceof Element ? lavishLocalAnchorEl : originElement); }\n    const queueKey = typeof deriveQueueKey === "function" ? deriveQueueKey(originElement, options2) : "";`,
  },
  {
    file: cliPath, id: "sdk:queue-routing",
    marker: "/* lavish-local-patch:sdk-queue-routing */",
    anchor: `postArtifactMessage("lavish:queuePrompt", { prompt: item });`,
    replacement: `/* lavish-local-patch:sdk-queue-routing */ postArtifactMessage(options2.__lavishPrivate ? "lavish:privateNote" : "lavish:queuePrompt", { prompt: item });`,
  },
  {
    file: cliPath, id: "sdk:api-privateNote",
    marker: "/* lavish-local-patch:sdk-api-privateNote */",
    anchor: `  window.lavish = {\n    queuePrompt,`,
    replacement: `  window.lavish = {\n    /* lavish-local-patch:sdk-api-privateNote */\n    privateNote: (prompt, options2 = {}) => queuePrompt(prompt, { ...options2, __lavishPrivate: true }),\n    queuePrompt,`,
  },
  {
    file: cliPath, id: "sdk:anchors",
    marker: "/* lavish-local-patch:sdk-anchors */",
    anchor: `    if (msg.type === "lavish:revealElement") revealElement(msg.selector);\n  });\n  function revealElement(selector2) {`,
    replacement: `    if (msg.type === "lavish:revealElement") revealElement(msg.selector);\n${sdkAnchors}`,
  },
  {
    file: cliPath, id: "sdk:card-css",
    marker: ".lavish-note-pin{",
    anchor: "100%{opacity:0}}`;\n    shadow.appendChild(style);",
    replacement: "100%{opacity:0}}" + sdkCss + "`;\n    shadow.appendChild(style);",
  },
  {
    file: cliPath, id: "sdk:accent",
    marker: "--lavish-accent:#0095f6",
    anchor: ":root{--lavish-accent:#f4c95d;--lavish-annotate-outline:2px solid var(--lavish-accent);--lavish-annotate-offset:2px}",
    replacement: ":root{--lavish-accent:#0095f6;--lavish-annotate-outline:2px solid var(--lavish-accent);--lavish-annotate-offset:2px}",
  },
];

if (args.includes("--reapply-rail")) {
  const marker = "/* lavish-local-patch:review-rail */";
  for (const [p, fresh] of [[clientPath, railJs], [cssPath, railCss]]) {
    const src = readFileSync(p, "utf8");
    const i = src.indexOf(marker);
    if (i === -1) fail(`${p}: rail block not present; run the full patch first`);
    const next = `${src.slice(0, i)}${fresh}\n`;
    if (p.endsWith(".js")) {
      const tmp = `${p}.patch-check.js`; writeFileSync(tmp, next);
      try { execSync(`node --check "${tmp}"`, { stdio: "inherit" }); } catch { unlinkSync(tmp); fail(`re-applied ${p} does not parse; nothing written`); }
      unlinkSync(tmp);
    } else {
      const open = (next.match(/\{/g) || []).length, close = (next.match(/\}/g) || []).length;
      if (open !== close) fail(`re-applied ${p} has unbalanced braces (${open} vs ${close}); nothing written`);
    }
    writeFileSync(p, next); log(`~ rail re-applied to ${p}`);
  }
  log("Reload the Lavish tab; no server restart needed.");
  process.exit(0);
}

const sources = new Map();
const read = (p) => { if (!sources.has(p)) sources.set(p, readFileSync(p, "utf8")); return sources.get(p); };
let missing = 0, applied = 0, already = 0;
for (const e of EDITS) {
  let src = read(e.file);
  if (src.includes(e.marker)) { already++; log(`= ${e.id}: already patched`); continue; }
  if (e.anchor !== null && !src.includes(e.anchor)) { missing++; log(`✗ ${e.id}: anchor NOT found (upstream changed this code)`); continue; }
  if (e.anchor !== null && src.split(e.anchor).length !== 2) { missing++; log(`✗ ${e.id}: anchor is not unique`); continue; }
  if (check) { log(`✓ ${e.id}: anchor present, would patch`); continue; }
  src = e.anchor === null ? e.apply(src) : src.replace(e.anchor, e.replacement);
  sources.set(e.file, src); applied++; log(`+ ${e.id}: patched`);
}
if (missing) { log(`\n${missing} anchor(s) missing on lavish-axi ${version}. Nothing written.`); process.exit(1); }
if (check) { log(`\ncheck ok on lavish-axi ${version}: ${already} already patched, ${EDITS.length - already} would apply`); process.exit(0); }
// Syntax gate BEFORE writing: a broken bundle would take the whole Lavish server down, so
// check the patched text in a temp file and touch the real install only when it parses.
for (const [p, src] of sources) {
  if (p.endsWith(".css")) {
    const open = (src.match(/\{/g) || []).length, close = (src.match(/\}/g) || []).length;
    if (open !== close) fail(`patched ${p} has unbalanced braces (${open} vs ${close}); nothing written`);
    continue;
  }
  const tmp = `${p}.patch-check${p.endsWith(".mjs") ? ".mjs" : ".js"}`;
  writeFileSync(tmp, src);
  try { execSync(`node --check "${tmp}"`, { stdio: "inherit" }); }
  catch { unlinkSync(tmp); fail(`patched ${p} does not parse; nothing written`); }
  unlinkSync(tmp);
}
for (const [p, src] of sources) writeFileSync(p, src);
log(`\nlavish-axi ${version}: ${applied} edit(s) applied, ${already} already present. Syntax check passed.`);
log(`chrome-client.js / chrome.css are live on the next reload; cli.mjs (SDK + server) needs: lavish-axi stop, then reopen a page.`);

function log(m) { console.log(m); }
function fail(m) { console.error(m); process.exit(1); }
