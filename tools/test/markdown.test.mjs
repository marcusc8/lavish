// An agent's message keeps its shape (Marcus, 2026-10-16): the markdown block of rail.client.js, read from the file and
// run alone, plus pins on where it is used.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const src = readFileSync(process.env.RAIL_SOURCE || new URL('../rail.client.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('  /* ── markdown (Marcus'), src.indexOf('  /* ── end markdown ── */'));
const mdLite = new Function(block + '\nreturn mdLite;')();

test('everything is escaped first: a reply can never add markup of its own', () => {
  const html = mdLite('<script>alert(1)</script> and <b onmouseover="x">hi</b> & "q"');
  assert.doesNotMatch(html, /<script|<b onmouseover/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; and &lt;b onmouseover=&quot;x&quot;&gt;hi&lt;\/b&gt; &amp; &quot;q&quot;/);
  assert.doesNotMatch(mdLite('- **<img src=x onerror=y>**'), /<img/);
});

test('numbered and bulleted lines become lists, an indent nests, the number is kept', () => {
  assert.equal(mdLite('Got 3 items:\n1. Header\n2. Picker\n   - filters beside the search\n3. Units'),
    '<p>Got 3 items:</p><ol><li value="1">Header</li><li value="2">Picker</li></ol><ul><li style="margin-left:1.2em">filters beside the search</li></ul><ol><li value="3">Units</li></ol>');
  assert.equal(mdLite('* one\n• two'), '<ul><li>one</li><li>two</li></ul>');
});

test('bold, code, headings, paragraphs and line breaks', () => {
  assert.equal(mdLite('**Done:** the `view.js` file\nsecond line\n\nnext paragraph'),
    '<p><b>Done:</b> the <code>view.js</code> file<br>second line</p><p>next paragraph</p>');
  assert.equal(mdLite('## What changed'), '<p><b>What changed</b></p>');
  assert.equal(mdLite('    indented detail'), '<p>    indented detail</p>');
  assert.equal(mdLite(''), '');
});

test('it is used for the agent\'s Conversation bubbles and its replies under a comment, never for what Marcus writes', () => {
  assert.match(src, /if \(role === "agent" && body\) \{ body\.innerHTML = mdLite\(text\);/);
  assert.match(src, /\(t\.by === "agent" \? '<div class="lavish-md">' \+ mdLite\(t\.text\) \+ "<\/div>" : esc\(t\.text\)\)/);
});
