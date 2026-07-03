// covers the containment/visibility branch only — jsdom has no layout, so button geometry is the CDP probe's job
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
globalThis.NodeFilter = window.NodeFilter;
globalThis.CSS = (window.CSS && window.CSS.escape) ? window.CSS
  : { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) };
globalThis.localStorage = window.localStorage;
globalThis.requestAnimationFrame = (fn) => fn(0);
window.api = { readComments: async () => [], writeComments: async () => {} };

// jsdom Range has no getBoundingClientRect; stub zeros so we test the visibility branch, not geometry
window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });

// jsdom Selection.toString() is unimplemented (returns ''); trips the non-empty guard, so delegate to Range.toString()
const realGetSelection = window.getSelection.bind(window);
window.getSelection = () => {
  const sel = realGetSelection();
  if (sel && sel.rangeCount && sel.toString() === '') {
    sel.toString = () => sel.getRangeAt(0).toString();
  }
  return sel;
};

await import('../renderer/selection.js'); // registers the selection handlers (mouseup/keyup/selectionchange)
const { contentEl, addCommentBtn, docPaneEl } = await import('../renderer/dom.js');
const store = await import('../renderer/store.js');

function selectThroughLastWord(endNode) {
  const p = contentEl.querySelector('p:last-of-type');
  const textNode = p.firstChild;
  const range = document.createRange();
  range.setStart(textNode, textNode.textContent.length - 4);
  if (endNode) range.setEnd(endNode, 0);
  else range.setEnd(textNode, textNode.textContent.length);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

test('jsdom exposes a usable Selection (guards the assertions below)', () => {
  contentEl.innerHTML = '<p>hello world</p>';
  const sel = selectThroughLastWord(null);
  assert.equal(sel.rangeCount, 1);
  assert.ok(!sel.isCollapsed, 'range must be non-collapsed for the guard to run');
});

test('button shows when the selection ends past the last block (the regression)', () => {
  contentEl.innerHTML = '<p>Paragraph 12: filler text for layout testing.</p>';
  // sentinel after #content models the overshoot: CDP repro had endContainer a SPAN outside
  // #content, start still inside (jsdom collapses a range whose end precedes its start)
  const sentinel = document.createElement('span');
  document.body.appendChild(sentinel);
  addCommentBtn.hidden = true;
  selectThroughLastWord(sentinel);
  document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
  assert.equal(addCommentBtn.hidden, false, 'a selection anchored in content must offer the button even when it overshoots the last block');
  sentinel.remove();
});

test('normal in-content selection still shows the button (no regression)', () => {
  contentEl.innerHTML = '<p>Paragraph 6: some mid-document text.</p>';
  addCommentBtn.hidden = true;
  selectThroughLastWord(null); // both endpoints inside content
  document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
  assert.equal(addCommentBtn.hidden, false);
});

test('the button stays hidden mid-drag (selectionchange), only appears on release (mouseup)', () => {
  contentEl.innerHTML = '<p>Paragraph 6: some mid-document text.</p>';
  addCommentBtn.hidden = true;
  selectThroughLastWord(null);
  // selectionchange fires continuously while dragging — it must NOT pop the button in
  document.dispatchEvent(new window.Event('selectionchange'));
  assert.equal(addCommentBtn.hidden, true, 'no button while the selection is still being dragged');
  document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
  assert.equal(addCommentBtn.hidden, false, 'button appears once the drag is released');
});

test('shift-keyup surfaces the button after a keyboard selection', () => {
  contentEl.innerHTML = '<p>Paragraph for keyboard selection.</p>';
  addCommentBtn.hidden = true;
  selectThroughLastWord(null);
  document.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Shift', shiftKey: true, bubbles: true }));
  assert.equal(addCommentBtn.hidden, false, 'shift-keyup on a settled selection offers the button');
});

test('scroll mid-drag does not pop the button in (dragging suppression)', () => {
  contentEl.innerHTML = '<p>Paragraph for the scroll test.</p>';
  selectThroughLastWord(null);
  addCommentBtn.hidden = true;
  document.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  docPaneEl.dispatchEvent(new window.Event('scroll'));
  // without the `if (dragging) return` guard the scroll handler would re-pin and reveal the button here
  assert.equal(addCommentBtn.hidden, true, 'an auto-scrolling drag-select must not reveal the button');
  document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
});

test('scroll with no active anchor hides a stranded button', () => {
  contentEl.innerHTML = '<p>doc text</p>';
  window.getSelection().removeAllRanges();
  document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
  addCommentBtn.hidden = false; // pretend it was left visible from an earlier selection
  docPaneEl.dispatchEvent(new window.Event('scroll'));
  assert.equal(addCommentBtn.hidden, true, 'no selection/image anchor → scroll hides the button');
});

test('selection entirely outside content leaves the button hidden', () => {
  contentEl.innerHTML = '<p>doc text</p>';
  const outside = document.getElementById('layout') || document.body;
  const range = document.createRange();
  range.selectNodeContents(outside);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  addCommentBtn.hidden = true;
  document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
  assert.equal(addCommentBtn.hidden, true, 'a selection with no endpoint in content must not offer a comment');
});

store.loadDoc({ filePath: '/x/doc.md', rawText: '# d', comments: [] });
function fireAddComment() {
  addCommentBtn.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
}

test('anchors to the selected instance, not the first duplicate, trimming trailing space', () => {
  // select the 2nd "gamma" + a trailing space → tightened off both quote and offsets
  contentEl.innerHTML = '<p>gamma alpha</p><p>beta gamma end</p>';
  const text = contentEl.textContent;
  const second = text.indexOf('gamma', text.indexOf('gamma') + 1);
  const node = contentEl.querySelector('p:last-of-type').firstChild;
  const g = node.textContent.indexOf('gamma');
  const range = document.createRange();
  range.setStart(node, g);
  range.setEnd(node, g + 'gamma '.length); // include trailing space → tightened off the quote
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(range);
  store.setPending(null);
  fireAddComment();
  const p = store.state.pendingRange;
  assert.ok(p, 'a valid in-content selection must produce a pending comment');
  assert.equal(p.quote, 'gamma');
  assert.equal(p.start, second, 'anchored to the selected gamma, not the first');
});

test('a selection spanning a hard-wrapped line still anchors (quote from slice, not toString)', () => {
  // The bug: Selection.toString() collapses a line-wrap newline to a space → old check failed →
  // {0,0}. Anchoring must use the textContent slice so start/end/quote stay self-consistent.
  contentEl.innerHTML = '<p>alpha beta\ngamma delta epsilon</p>';
  const node = contentEl.querySelector('p').firstChild;
  const text = contentEl.textContent; // "alpha beta\ngamma delta epsilon"
  const start = text.indexOf('beta');
  const end = text.indexOf('delta') + 'delta'.length;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(range);
  // the harness stub hides the bug: override toString to collapse the wrap newline like a real
  // Selection (Range.toString keeps it). Without this the test would pass on the buggy code too.
  sel.toString = () => text.slice(start, end).replace(/\n/g, ' ');
  store.setPending(null);
  fireAddComment();
  const p = store.state.pendingRange;
  assert.ok(p && p.start < p.end, 'a wrapped-line selection must anchor (not collapse to {0,0})');
  assert.equal(text.slice(p.start, p.end), p.quote, 'quote is the exact anchored slice');
  assert.ok(p.quote.includes('\n'), 'the anchored quote keeps the internal wrap newline');
  assert.equal(p.start, start, 'anchored at the selection start');
});
