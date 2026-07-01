// Two pane-layout behaviors that live in renderer DOM code with no Electron
// coverage: the comment-list height clamp (the over-scroll fix) and
// ensureCommentsVisible. jsdom gives no real geometry, so the clamp test stubs
// getBoundingClientRect/offsetHeight/clientHeight to feed layoutComments the
// numbers the line under test arithmetic on (incl. a scrollHeight stub to prove
// the clamp no longer floors on doc height).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
// http origin (not file:///) so window.localStorage isn't an opaque-origin stub.
const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
globalThis.CSS = (window.CSS && window.CSS.escape) ? window.CSS
  : { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) };
globalThis.localStorage = window.localStorage;
globalThis.requestAnimationFrame = (fn) => fn(0);
window.api = { readComments: async () => [], writeComments: async () => {} };

const { layoutComments } = await import('../renderer/comment-layout.js');
const { ensureCommentsVisible, getLayout, setLayout } = await import('../renderer/layout.js');
const { contentEl, commentListEl, commentPaneEl } = await import('../renderer/dom.js');

// Build one comment card + its anchor span, with geometry forced via stubs.
// anchorTop is the highlight's viewport top; contentEl sits at top 0, so
// cardTarget == anchorTop. paneHeight drives the viewport floor.
function place({ anchorTop, cardHeight, paneHeight }) {
  contentEl.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  contentEl.innerHTML = '';
  const span = document.createElement('span');
  span.className = 'comment-highlight';
  span.dataset.commentId = 'c1';
  span.getBoundingClientRect = () => ({ top: anchorTop, height: 10, bottom: anchorTop + 10, left: 0, right: 0, width: 0 });
  contentEl.appendChild(span);

  commentListEl.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'comment-card';
  card.dataset.commentId = 'c1';
  Object.defineProperty(card, 'offsetHeight', { value: cardHeight, configurable: true });
  commentListEl.appendChild(card);

  Object.defineProperty(commentPaneEl, 'clientHeight', { value: paneHeight, configurable: true });
}

test('list height tracks last-card-bottom (+24), not document height, when the card sits low in a tall doc', () => {
  // Card anchored 2000px down a tall doc; the list should size to the card's
  // bottom + 24, not to the (much larger) document scroll height.
  place({ anchorTop: 2000, cardHeight: 100, paneHeight: 600 });
  // Force a large doc-scroll height: the OLD code floored on contentEl.scrollHeight
  // and would yield 9999 here; jsdom reports 0 by default, which would let the old
  // code masquerade as the new behavior. Stubbing it pins the new clamp — this test
  // FAILS if the scrollHeight floor is reinstated.
  Object.defineProperty(contentEl, 'scrollHeight', { value: 9999, configurable: true });
  layoutComments(false);
  // top = max(2000, 0) = 2000; maxBottom = 2100; max(2100+24, 600) = 2124.
  // Old code: max(2124, 9999) = 9999 — would fail this assertion.
  assert.equal(commentListEl.style.height, '2124px');
});

test('list height floors at the pane/viewport height for a short list', () => {
  place({ anchorTop: 10, cardHeight: 50, paneHeight: 600 });
  layoutComments(false);
  // maxBottom = 60; max(60+24, 600) = 600.
  assert.equal(commentListEl.style.height, '600px');
});

function placeMany(anchors, cardHeight, paneHeight, activeId) {
  contentEl.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  contentEl.innerHTML = '';
  commentListEl.innerHTML = '';
  const cards = [];
  anchors.forEach(({ id, anchorTop }) => {
    const span = document.createElement('span');
    span.className = 'comment-highlight';
    span.dataset.commentId = id;
    span.getBoundingClientRect = () => ({ top: anchorTop, height: 10, bottom: anchorTop + 10, left: 0, right: 0, width: 0 });
    contentEl.appendChild(span);

    const card = document.createElement('div');
    card.className = 'comment-card' + (id === activeId ? ' active' : '');
    card.dataset.commentId = id;
    Object.defineProperty(card, 'offsetHeight', { value: cardHeight, configurable: true });
    commentListEl.appendChild(card);
    cards.push(card);
  });
  Object.defineProperty(commentPaneEl, 'clientHeight', { value: paneHeight, configurable: true });
  return cards;
}

test('near-anchored cards never overlap even when the active one is pulled to its anchor', () => {
  // active pulled to anchor would shove the cards above negative → clamp to 0 → pile up (overlap bug)
  const cards = placeMany(
    [{ id: 'a', anchorTop: 4 }, { id: 'b', anchorTop: 8 }, { id: 'c', anchorTop: 12 }],
    100, 600, 'c'
  );
  layoutComments(false);
  const tops = cards.map((el) => parseFloat(el.style.top));
  for (let i = 1; i < tops.length; i++) {
    assert.ok(tops[i] >= tops[i - 1] + 100, `card ${i} (top ${tops[i]}) overlaps card ${i - 1} (top ${tops[i - 1]})`);
  }
  assert.ok(tops[0] >= 0, 'no card is clamped off the top');
});

test('no overlap when the active card is in the middle (cards above and below)', () => {
  // active in the middle: floor holds cards above while the greedy pass stacks those below
  const cards = placeMany(
    [{ id: 'a', anchorTop: 3 }, { id: 'b', anchorTop: 6 }, { id: 'c', anchorTop: 9 },
     { id: 'd', anchorTop: 12 }, { id: 'e', anchorTop: 15 }],
    100, 600, 'c'
  );
  layoutComments(false);
  const tops = cards.map((el) => parseFloat(el.style.top));
  for (let i = 1; i < tops.length; i++) {
    assert.ok(tops[i] >= tops[i - 1] + 100, `card ${i} (top ${tops[i]}) overlaps card ${i - 1} (top ${tops[i - 1]})`);
  }
  assert.ok(tops[0] >= 0, 'no card is clamped off the top');
});

test('ensureCommentsVisible opens the pane when comments are collapsed', () => {
  setLayout({ commentsCollapsed: true });
  document.body.classList.add('comments-collapsed');
  ensureCommentsVisible();
  assert.equal(getLayout().commentsCollapsed, false, 'layout flag cleared');
  assert.equal(document.body.classList.contains('comments-collapsed'), false, 'applyLayout ran');
});

test('ensureCommentsVisible is a no-op when comments are already visible', () => {
  setLayout({ commentsCollapsed: false });
  // Deliberately wrong body class: applyLayout would clear it, so its survival
  // proves the visible branch skipped setLayout/applyLayout entirely.
  document.body.classList.add('comments-collapsed');
  ensureCommentsVisible();
  assert.equal(getLayout().commentsCollapsed, false, 'flag untouched');
  assert.equal(document.body.classList.contains('comments-collapsed'), true, 'applyLayout not called');
});
