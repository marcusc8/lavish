/* lavish html2md — clipboard text/html → Markdown, tuned for Google Docs.
 *
 * Why this exists: the Lavish composer is a <textarea>, which can only accept the
 * text/plain clipboard flavor. Google Docs puts a rich text/html flavor beside it
 * that encodes bold/italic as inline styles (font-weight:700, font-style:italic)
 * inside a <b style="font-weight:normal" id="docs-internal-guid-…"> wrapper. A
 * generic converter reads that wrapper as "bold everything". This one reads styles.
 *
 * Browser-only (uses DOMParser). Exposes window.__lavishHtmlToMarkdown(html) and
 * returns "" when the HTML has no structure worth converting, so callers can fall
 * back to the plain-text paste. Also injected verbatim into chrome-client.js by
 * patch-lavish.mjs; keep it dependency-free and ES2020.
 */
(function () {
  const STRUCTURE = /<(h[1-6]|ul|ol|li|table|pre|code|a\s|b[\s>]|strong|i[\s>]|em)\b/i;
  const STYLE_BOLD = /font-weight\s*:\s*(bold|[6-9]00)/i;
  const STYLE_ITALIC = /font-style\s*:\s*italic/i;
  const STYLE_NORMAL_WEIGHT = /font-weight\s*:\s*(normal|[1-5]00)/i;

  function styleOf(el) { return (el.getAttribute && el.getAttribute("style")) || ""; }
  function isBold(el) {
    const st = styleOf(el);
    if (STYLE_NORMAL_WEIGHT.test(st)) return false;           // the Docs guid wrapper
    if (STYLE_BOLD.test(st)) return true;
    return el.tagName === "B" || el.tagName === "STRONG";
  }
  function isItalic(el) { return el.tagName === "I" || el.tagName === "EM" || STYLE_ITALIC.test(styleOf(el)); }
  function collapse(s) { return s.replace(/[ \t\r\n ]+/g, " "); }

  function inline(node) {
    if (node.nodeType === 3) return collapse(node.nodeValue);
    if (node.nodeType !== 1) return "";
    const tag = node.tagName;
    if (tag === "BR") return "\n";
    if (tag === "IMG") return node.getAttribute("alt") ? "[image: " + node.getAttribute("alt") + "]" : "";
    let s = Array.from(node.childNodes).map(inline).join("");
    if (!s.trim()) return s;
    if (tag === "A" && node.getAttribute("href") && !/^javascript:/i.test(node.getAttribute("href"))) {
      return "[" + s.trim() + "](" + node.getAttribute("href") + ")";
    }
    if (tag === "CODE") return "`" + s.trim() + "`";
    const lead = s.match(/^\s*/)[0], trail = s.match(/\s*$/)[0], core = s.trim();
    let wrapped = core;
    if (isBold(node)) wrapped = "**" + wrapped + "**";
    if (isItalic(node)) wrapped = "*" + wrapped + "*";
    return lead + wrapped + trail;
  }

  function cellText(td) { const out = []; Array.from(td.childNodes).forEach((c) => block(c, out, 0)); return out.join(" ").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim(); }

  function block(node, out, depth) {
    if (node.nodeType === 3) { const t = collapse(node.nodeValue).trim(); if (t) out.push(t); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    const kids = Array.from(node.childNodes);
    if (/^H[1-6]$/.test(tag)) { let t = kids.map(inline).join("").trim(); t = t.replace(/^\*\*(.+)\*\*$/, "$1"); if (t) out.push("#".repeat(+tag[1]) + " " + t); return; }
    if (tag === "P" || tag === "DIV" && !kids.some((k) => k.nodeType === 1 && /^(P|DIV|UL|OL|TABLE|H[1-6]|PRE|BLOCKQUOTE)$/.test(k.tagName))) {
      const t = kids.map(inline).join("").trim(); if (t) out.push(t); return;
    }
    if (tag === "UL" || tag === "OL") {
      let i = 0;
      const items = [];
      kids.filter((k) => k.nodeType === 1 && k.tagName === "LI").forEach((li) => {
        i++;
        // Children render at the same depth; continuation lines (including a nested
        // list's own "- " lines) are indented by two spaces below the marker.
        const sub = []; Array.from(li.childNodes).forEach((c) => block(c, sub, depth));
        const marker = tag === "UL" ? "- " : i + ". ";
        const lines = sub.join("\n").split("\n");
        items.push(lines.map((line, j) => (j === 0 ? marker + line : "  " + line)).join("\n"));
      });
      if (items.length) out.push(items.join("\n"));
      return;
    }
    if (tag === "TABLE") {
      const rows = Array.from(node.querySelectorAll("tr")).map((tr) => Array.from(tr.children).filter((c) => /^T[DH]$/.test(c.tagName)).map(cellText));
      if (!rows.length) return;
      const width = Math.max.apply(null, rows.map((r) => r.length));
      const pad = (r) => r.concat(Array(width - r.length).fill(""));
      out.push(["| " + pad(rows[0]).join(" | ") + " |", "|" + " --- |".repeat(width)].concat(rows.slice(1).map((r) => "| " + pad(r).join(" | ") + " |")).join("\n"));
      return;
    }
    if (tag === "PRE") { out.push("```\n" + node.textContent.replace(/\s+$/, "") + "\n```"); return; }
    if (tag === "BLOCKQUOTE") { const sub = []; kids.forEach((k) => block(k, sub, depth)); if (sub.length) out.push(sub.join("\n\n").split("\n").map((l) => "> " + l).join("\n")); return; }
    if (tag === "HR") { out.push("---"); return; }
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "META" || tag === "TITLE") return;
    // Inline-only container (span, b, the Docs wrapper, td fallthrough): treat as a paragraph
    // when it has no block children, otherwise recurse.
    const hasBlock = kids.some((k) => k.nodeType === 1 && /^(P|DIV|UL|OL|TABLE|H[1-6]|PRE|BLOCKQUOTE|BR)$/.test(k.tagName));
    if (!hasBlock && kids.length) { const t = kids.map(inline).join("").trim(); if (t) out.push(t); return; }
    kids.forEach((k) => block(k, out, depth));
  }

  function htmlToMarkdown(html) {
    if (!html || !STRUCTURE.test(html)) return "";
    const doc = new DOMParser().parseFromString(html, "text/html");
    const out = [];
    Array.from(doc.body.childNodes).forEach((n) => block(n, out, 0));
    const md = out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
    // If the result is just the plain text with no markdown syntax, report "" so the
    // caller keeps the browser's default paste (nothing gained, nothing risked).
    return /(^|\n)(#{1,6} |- |\d+\. |> |\|)|\*\*|`|\]\(/.test(md) ? md : "";
  }

  if (typeof window !== "undefined") window.__lavishHtmlToMarkdown = htmlToMarkdown;
  if (typeof module !== "undefined" && module.exports) module.exports = { htmlToMarkdown };
})();
