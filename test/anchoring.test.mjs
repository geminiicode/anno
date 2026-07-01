// The DOM half of anchoring: char-offset ↔ Range translation over the rendered
// text nodes. An off-by-one here silently orphans comments. (.mjs: DOM globals
// must be set before the dynamic import — the renderer binds contentEl at load.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// http origin (not file:///) so window.localStorage isn't an opaque-origin stub.
const dom = new JSDOM('<!DOCTYPE html><html><body><article id="content"></article></body></html>', {
  url: 'http://localhost/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.requestAnimationFrame = (cb) => cb();
// lib.js is a UMD module exposed as a global script in the app; the renderer
// reaches it as `annoLib`.
globalThis.annoLib = require('../core/lib.js');

const { rangeToOffsets, offsetsToRange, applyHighlights, anchors, fullText } = await import(
  '../renderer/anchoring.js'
);
const store = await import('../renderer/store.js');
const { contentEl } = await import('../renderer/dom.js');

function setContent(html) {
  contentEl.innerHTML = html;
}

test('offset round-trips across multiple text nodes (inline markup splits the text)', () => {
  // "Hello " | "brave" | " world" — three text nodes from the <strong>.
  setContent('<p>Hello <strong>brave</strong> world</p>');
  assert.equal(fullText(), 'Hello brave world');

  // "brave" is chars 6..11, and it lives entirely in the middle text node.
  const range = offsetsToRange(6, 11);
  assert.equal(range.toString(), 'brave');
  assert.deepEqual(rangeToOffsets(range), { start: 6, end: 11 });
});

test('offset round-trips a span crossing a node boundary', () => {
  setContent('<p>Hello <strong>brave</strong> world</p>');
  // "brave world" spans the <strong> text node into the trailing text node.
  const range = offsetsToRange(6, 17);
  assert.equal(range.toString(), 'brave world');
  assert.deepEqual(rangeToOffsets(range), { start: 6, end: 17 });
});

test('offset round-trips a span ending at the exact end of the text', () => {
  // The off-by-one that orphans comments lives at end === fullText().length.
  setContent('<p>Hello world</p>');
  assert.equal(fullText().length, 11);
  const range = offsetsToRange(6, 11);
  assert.equal(range.toString(), 'world');
  assert.deepEqual(rangeToOffsets(range), { start: 6, end: 11 });
});

test('offset round-trips a collapsed (zero-width) range', () => {
  setContent('<p>Hello world</p>');
  const range = offsetsToRange(5, 5);
  assert.equal(range.toString(), '');
  assert.deepEqual(rangeToOffsets(range), { start: 5, end: 5 });
});

test('offsetsToRange returns null when offsets run past the rendered text', () => {
  setContent('<p>short</p>');
  assert.equal(offsetsToRange(2, 999), null);
});

test('applyHighlights wraps an anchored quote and flags an orphan', () => {
  setContent('<p>The quick brown fox</p>');
  store.loadDoc({
    filePath: '/x/doc.md',
    rawText: '# d',
    comments: [
      { id: 'hit', quote: 'quick', start: 4, end: 9, status: 'open', replies: [] },
      { id: 'miss', quote: 'not in the document', status: 'open', replies: [] },
    ],
  });

  applyHighlights();

  // Anchored comment: not orphaned, and a highlight span carries its id.
  assert.equal(anchors.get('hit').orphaned, false);
  const span = contentEl.querySelector('.comment-highlight[data-comment-id="hit"]');
  assert.ok(span, 'anchored quote should be wrapped in a highlight span');
  assert.equal(span.textContent, 'quick');

  // Orphaned comment: flagged, no span.
  assert.equal(anchors.get('miss').orphaned, true);
  assert.equal(contentEl.querySelector('.comment-highlight[data-comment-id="miss"]'), null);
});

test('a working comment holds its highlight at last offsets when its quote no longer matches', () => {
  setContent('<p>The nimble brown fox</p>');
  store.loadDoc({
    filePath: '/x/doc.md',
    rawText: '# d',
    comments: [
      { id: 'busy', quote: 'quick', start: 4, end: 9, status: 'open', working: true, replies: [] },
    ],
  });

  applyHighlights();

  assert.equal(anchors.get('busy').orphaned, false, 'working comment should not orphan on a quote miss');
  const span = contentEl.querySelector('.comment-highlight[data-comment-id="busy"]');
  assert.ok(span, 'highlight should persist while Claude is addressing the comment');
  assert.equal(span.textContent, 'nimbl', 'held highlight sits at the last-known offsets');
});

test('a working comment with a fresh workingSince holds its highlight (the common case)', () => {
  // prior test hits isWorking's NaN branch; this pins working:true + fresh workingSince
  setContent('<p>The nimble brown fox</p>');
  const freshSince = new Date(Date.now() - 1000).toISOString();
  store.loadDoc({
    filePath: '/x/doc.md',
    rawText: '# d',
    comments: [
      { id: 'fresh', quote: 'quick', start: 4, end: 9, status: 'open', working: true, workingSince: freshSince, replies: [] },
    ],
  });

  applyHighlights();

  assert.equal(anchors.get('fresh').orphaned, false, 'a fresh working comment should hold, not orphan');
  const span = contentEl.querySelector('.comment-highlight[data-comment-id="fresh"]');
  assert.ok(span, 'highlight persists for a freshly-marked working comment');
  assert.equal(span.textContent, 'nimbl');
});

test('a working comment whose offsets exceed the shrunken doc orphans, does not throw', () => {
  setContent('<p>tiny</p>');
  store.loadDoc({
    filePath: '/x/doc.md',
    rawText: '# d',
    comments: [
      { id: 'past', quote: 'quick', start: 40, end: 45, status: 'open', working: true, replies: [] },
    ],
  });

  assert.doesNotThrow(() => applyHighlights());
  assert.equal(anchors.get('past').orphaned, true, 'offsets past the doc end orphan the comment');
  assert.equal(contentEl.querySelector('.comment-highlight[data-comment-id="past"]'), null);
});

test('a stale working flag does not resurrect a highlight for a gone quote', () => {
  setContent('<p>The nimble brown fox</p>');
  store.loadDoc({
    filePath: '/x/doc.md',
    rawText: '# d',
    comments: [
      { id: 'stale', quote: 'quick', start: 4, end: 9, status: 'open', working: true, workingSince: '2000-01-01T00:00:00Z', replies: [] },
    ],
  });

  applyHighlights();

  assert.equal(anchors.get('stale').orphaned, true, 'a stale working flag falls back to orphaning');
  assert.equal(contentEl.querySelector('.comment-highlight[data-comment-id="stale"]'), null);
});

test('the pending selection is highlighted while composing, and cleared when discarded', () => {
  // startComment clears the native selection and the comment isn't in state.comments yet,
  // so applyHighlights must paint pendingRange itself or the quote goes dark mid-compose.
  setContent('<p>The quick brown fox</p>');
  store.loadDoc({ filePath: '/x/doc.md', rawText: '# d', comments: [] });
  store.setPending({ start: 4, end: 9, quote: 'quick' });

  applyHighlights();
  const span = contentEl.querySelector('.comment-highlight.pending');
  assert.ok(span, 'pending selection should be highlighted');
  assert.equal(span.textContent, 'quick');

  store.setPending(null);
  applyHighlights();
  assert.equal(contentEl.querySelector('.comment-highlight.pending'), null, 'discarding clears the pending highlight');
});

test('a collapsed / orphaned pending range draws no highlight, does not throw', () => {
  setContent('<p>tiny</p>');
  store.loadDoc({ filePath: '/x/doc.md', rawText: '# d', comments: [] });
  store.setPending({ start: 0, end: 0, quote: '' }); // the {0,0} orphan fallback
  assert.doesNotThrow(() => applyHighlights());
  assert.equal(contentEl.querySelector('.comment-highlight.pending'), null);
  store.setPending(null);
});

test('hideResolved layout drops inline highlights for resolved comments', () => {
  // getLayout() reads localStorage; wire jsdom's so hideResolved is observable.
  globalThis.localStorage = dom.window.localStorage;
  try {
    setContent('<p>The quick brown fox</p>');
    store.loadDoc({
      filePath: '/x/doc.md',
      rawText: '# d',
      comments: [
        { id: 'open', quote: 'quick', start: 4, end: 9, status: 'open', replies: [] },
        { id: 'done', quote: 'brown', start: 10, end: 15, status: 'resolved', replies: [] },
      ],
    });

    localStorage.setItem('panelLayout', JSON.stringify({ hideResolved: true }));
    applyHighlights();
    assert.ok(contentEl.querySelector('.comment-highlight[data-comment-id="open"]'));
    assert.equal(
      contentEl.querySelector('.comment-highlight[data-comment-id="done"]'),
      null,
      'resolved comment should have no highlight while hidden',
    );

    localStorage.setItem('panelLayout', JSON.stringify({ hideResolved: false }));
    applyHighlights();
    assert.ok(
      contentEl.querySelector('.comment-highlight[data-comment-id="done"]'),
      'resolved comment highlight should return when shown',
    );
  } finally {
    localStorage.removeItem('panelLayout');
    delete globalThis.localStorage;
  }
});

test('image comment anchors to its <img> by src and survives re-highlight', () => {
  // data-anno-src is the stable markdown-source key images.js stamps on every img.
  setContent('<p>before</p><img data-anno-src="diagram.png" src="file:///abs/diagram.png"><p>after</p>');
  store.loadDoc({
    filePath: '/x/doc.md',
    rawText: '# d',
    comments: [
      { id: 'img-hit', quote: 'diagram.png', imageSrc: 'diagram.png', status: 'open', replies: [] },
      { id: 'img-miss', quote: 'gone.png', imageSrc: 'gone.png', status: 'open', replies: [] },
    ],
  });

  applyHighlights();

  const img = contentEl.querySelector('img.comment-highlight[data-comment-id="img-hit"]');
  assert.ok(img, 'image comment should ring its <img>');
  assert.equal(anchors.get('img-hit').orphaned, false);
  assert.equal(anchors.get('img-miss').orphaned, true);

  // Anchored image gets a finite inline offset (length of "before") so it sorts
  // by document position, not to the bottom alongside the orphan.
  const hit = store.state.comments.find((c) => c.id === 'img-hit');
  const miss = store.state.comments.find((c) => c.id === 'img-miss');
  assert.equal(hit.start, 'before'.length);
  assert.ok(Number.isFinite(hit.start));
  assert.equal(miss.start, undefined, 'orphaned image keeps no offset, sinks to bottom');

  // Re-applying must not unwrap (and thereby delete) the image.
  applyHighlights();
  assert.ok(contentEl.querySelector('img[data-anno-src="diagram.png"]'), 'img must survive clear+reapply');
  assert.ok(contentEl.querySelector('img.comment-highlight[data-comment-id="img-hit"]'));
});
