// Follow up continues the same card's conversation (Marcus, 2026-10-15): the block between the follow-up markers of
// rail.client.js, read from the file and run alone, plus threadReply run with stand-ins, plus pins on the wiring.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const src = readFileSync(process.env.RAIL_SOURCE || new URL('../rail.client.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('  /* ── follow-ups (Marcus'), src.indexOf('  /* ── end follow-ups ── */'));
const {followThread, foldFollowUp, railNotes} = new Function(block + '\nreturn {followThread, foldFollowUp, railNotes};')();

const parent = () => ({id: 'n1', state: 'sent', sentAt: '2026-10-15T09:00:00Z', body: 'P4-8: the shoebox differs', anchor: {selector: 'div#pr614-P4-8 > p', tag: 'p'},
  replies: [{at: '2026-10-15T09:10:00Z', text: 'Which parts differ?'}], follows: [{at: '2026-10-15T09:20:00Z', text: 'The sealing method too'}]});

test('the conversation is your follow-ups and the agent\'s replies by time, then your queued follow-ups with their queue index', () => {
  const queued = [{prompt: 'other'}, {prompt: 'And the UPC label', lavishFollowOf: 'n1', lavishFollowText: 'And the UPC label'}];
  assert.deepEqual(followThread(parent(), queued), [
    {by: 'agent', at: '2026-10-15T09:10:00Z', text: 'Which parts differ?'},
    {by: 'you', at: '2026-10-15T09:20:00Z', text: 'The sealing method too'},
    {by: 'you', at: '', text: 'And the UPC label', queued: true, qi: 1},
  ]);
});

test('a delivered follow-up joins its card and makes no card of its own; one whose card is gone, or not sent, is not folded', () => {
  const notes = [parent()];
  assert.equal(foldFollowUp(notes, {prompt: 'x', lavishFollowOf: 'n1', lavishFollowText: 'The arrangement'}, '2026-10-15T09:30:00Z'), true);
  assert.deepEqual(notes[0].follows.at(-1), {at: '2026-10-15T09:30:00Z', text: 'The arrangement'});
  assert.equal(notes.length, 1);
  assert.equal(foldFollowUp(notes, {prompt: 'x', lavishFollowOf: 'gone'}, 'now'), false);
  assert.equal(foldFollowUp([{...parent(), sentAt: undefined}], {prompt: 'x', lavishFollowOf: 'n1'}, 'now'), false);
  assert.equal(foldFollowUp(notes, {prompt: 'a plain comment'}, 'now'), false);
});

test('a review card is told its queued and sent notes with their conversation; decisions, verdicts and picks are not notes', () => {
  const n = parent();
  const cards = [
    {kind: 'sent', id: 'n1', note: n, anchor: n.anchor, body: n.body, key: ''},
    {kind: 'queued', id: 'q:0', anchor: {selector: 'div#pr9-A1', tag: 'div'}, body: 'Looks off', key: 'note:pr9-A1'},
    {kind: 'queued', id: 'q:1', anchor: {selector: 'div#pr9-A1 .vb', tag: 'button'}, body: 'Works', key: 'verdict:pr9-A1'},
    {kind: 'queued', id: 'q:2', anchor: {selector: 'form', tag: 'choice'}, body: 'D1: A', key: 'D1'},
    {kind: 'private', id: 'p1', note: {}, anchor: {selector: 'div#pr9-A1', tag: 'div'}, body: 'mine only', key: ''},
    {kind: 'queued', id: 'q:3', anchor: null, body: 'general', key: ''},
  ];
  const out = railNotes(cards, []);
  assert.deepEqual(out.map((x) => [x.selector, x.state, x.text]), [['div#pr614-P4-8 > p', 'sent', n.body], ['div#pr9-A1', 'queued', 'Looks off']]);
  assert.equal(out[0].at, n.sentAt);
  assert.deepEqual(out[0].thread.map((t) => t.by), ['agent', 'you']);
  assert.ok(out[0].thread.every((t) => !('qi' in t)));
});

test('an agent reply quoting a follow-up threads onto the card the follow-up belongs to', () => {
  const start = src.indexOf('  function threadReply(text, at) {');
  const code = src.slice(start, src.indexOf('\n  }\n', start) + 4);
  const notes = [{id: 'n0', sentAt: 't', body: 'The sealing method is another note', anchor: {}}, parent()];
  const threadReply = new Function('notes', 'norm', 'now', 'saveNotes', 'renderRail', code + '\nreturn threadReply;')(notes, (s) => String(s).replace(/\s+/g, ' ').trim(), () => 'T', () => {}, () => {});
  assert.equal(threadReply('↳ Re “The sealing method too”: Noted, egg crates.', 'T2'), true);
  assert.deepEqual(notes[1].replies.at(-1), {at: 'T2', text: 'Noted, egg crates.'});
  assert.equal(notes[0].replies, undefined);
});

test('the wiring: Follow up opens the box in the same card, an empty box queues nothing, a queued follow-up is no card, Send folds it', () => {
  assert.doesNotMatch(src, /Follow-up on my earlier note/);
  assert.match(src, /case "followup": if \(n && !ended\) \{ editingId = "f:" \+ n\.id;/);
  assert.match(src, /if \(n && text && !ended\) enqueuePrompt\(\{ \.\.\.promptFrom\(n\.anchor, text\), lavishFollowOf: n\.id, lavishFollowText: text \}\)/);
  assert.match(src, /if \(p\.lavishFollowOf && notes\.some\(\(n\) => n\.id === p\.lavishFollowOf\)\) return;/);
  assert.match(src, /if \(foldFollowUp\(notes, p, now\(\)\)\) \{ changed = true; continue; \}/);
  assert.match(src, /if \(String\(id\)\.startsWith\("f:"\)\) \{ queueFollowUp\(String\(id\)\.slice\(2\)\); return; \}/);
  assert.match(src, /requestAnchors\(\);\n    postNotesToFrame\(\);/);
});

test('times and line breaks (Marcus, 2026-10-16): a queued comment carries when it was queued, a card and every Conversation bubble show the time, a message keeps its lines', () => {
  assert.match(src, /enqueuePrompt = function lavishLocalQueuedAtHook\(raw\) \{[^}]*lavishQueuedAt: now\(\)/);
  assert.match(src, /body: String\(p\.prompt \|\| ""\), at: p\.lavishQueuedAt \|\| "", files: refsOf\(p\)/);
  assert.match(src, /c\.kind === "queued" && c\.at \? "queued " \+ fmtTime\(c\.at\)/);
  assert.match(src, /const at = chatAts \? chatAts\.shift\(\) : now\(\);/);
  assert.match(src, /chatAts = list\.map\(\(c\) => c\.at \|\| ""\);/);
  const css = readFileSync(new URL('../rail.css', import.meta.url), 'utf8');
  assert.match(css, /\.bubble > div \{ white-space: pre-wrap;/);
});
