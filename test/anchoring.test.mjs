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

test('rangeToOffsets handles element-node boundaries (triple-click selects a whole block)', () => {
  // triple-click gives ELEMENT-node boundaries (the <p>), not text nodes — the old scan returned null
  setContent('<p>alpha</p><p>bravo charlie</p>');
  const p2 = contentEl.querySelectorAll('p')[1];
  const range = document.createRange();
  range.selectNodeContents(p2); // boundaries are (p2, 0) and (p2, 1) — element containers
  assert.deepEqual(rangeToOffsets(range), { start: 5, end: 5 + 'bravo charlie'.length });
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
  assert.equal(anchors.get('hit').detached, false);
  const span = contentEl.querySelector('.comment-highlight[data-comment-id="hit"]');
  assert.ok(span, 'anchored quote should be wrapped in a highlight span');
  assert.equal(span.textContent, 'quick');

  // Orphaned comment: flagged, no span.
  assert.equal(anchors.get('miss').detached, true);
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

  assert.equal(anchors.get('busy').detached, false, 'working comment should not orphan on a quote miss');
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

  assert.equal(anchors.get('fresh').detached, false, 'a fresh working comment should hold, not orphan');
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
  assert.equal(anchors.get('past').detached, true, 'offsets past the doc end orphan the comment');
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

  assert.equal(anchors.get('stale').detached, true, 'a stale working flag falls back to orphaning');
  assert.equal(contentEl.querySelector('.comment-highlight[data-comment-id="stale"]'), null);
});

test('a comment whose quote was removed is detached and refreshes start to the context gap', () => {
  // quote removed entirely (neither quote nor held offsets resolve) but context present → NO in-doc
  // marker; refresh start to where the text was so the card lays out at that gap and keeps its order.
  setContent('<p>Before the gap after</p>');
  store.loadDoc({
    filePath: '/x/doc.md',
    rawText: '# d',
    comments: [
      { id: 'gone', quote: 'REMOVED PHRASE', prefix: 'Before ', suffix: ' after', start: 7, end: 21, status: 'open', replies: [] },
    ],
  });

  applyHighlights();

  assert.equal(anchors.get('gone').detached, true, 'a quote-removed comment is detached (no live span)');
  assert.equal(contentEl.querySelector('.comment-highlight[data-comment-id="gone"]'), null, 'no marker injected into the document');
  const c = store.state.comments.find((x) => x.id === 'gone');
  assert.equal(c.start, 'Before '.length, 'start refreshed to the context gap (just after the prefix), so it sorts in place');
  assert.equal(c.end, c.start);
});

test('a removed-quote comment with no matching context is detached and keeps its last-known offset', () => {
  setContent('<p>totally different text</p>');
  store.loadDoc({
    filePath: '/x/doc.md',
    rawText: '# d',
    comments: [
      { id: 'nocontext', quote: 'gone', prefix: 'ZZZ ', suffix: ' YYY', start: 4, end: 8, status: 'open', replies: [] },
    ],
  });

  applyHighlights();

  assert.equal(anchors.get('nocontext').detached, true, 'no span → detached');
  assert.equal(contentEl.querySelector('.comment-highlight[data-comment-id="nocontext"]'), null, 'nothing injected');
  const c = store.state.comments.find((x) => x.id === 'nocontext');
  assert.equal(c.start, 4, 'no context match → start stays at its last-known offset, so order is preserved');
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

test('the pending highlight re-anchors by quote when a mid-compose reload shifts the text', () => {
  // a mid-compose reload can move the text — fixed offsets would strand it; must relocate by quote
  setContent('<p>The quick brown fox</p>');
  store.loadDoc({ filePath: '/x/doc.md', rawText: '# d', comments: [] });
  store.setPending({ start: 4, end: 9, quote: 'quick', prefix: 'The ', suffix: ' brown' });
  applyHighlights();
  assert.equal(contentEl.querySelector('.comment-highlight.pending').textContent, 'quick');

  setContent('<p>Yesterday, the quick brown fox jumped</p>');
  applyHighlights();
  const span = contentEl.querySelector('.comment-highlight.pending');
  assert.ok(span, 'pending highlight survives the reload');
  assert.equal(span.textContent, 'quick', 're-anchored by quote, not left at the stale offsets');
  store.setPending(null);
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
  assert.equal(anchors.get('img-hit').detached, false);
  assert.equal(anchors.get('img-miss').detached, true);

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
