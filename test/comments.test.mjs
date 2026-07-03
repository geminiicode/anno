// The comment pane is renderer DOM code with no Electron coverage. This drives
// the real renderComments/openComposer through the bug they fix: a structural
// re-render (the sidecar watcher firing when an AI reply lands) must not wipe a
// composer the user is mid-typing. jsdom supplies the document the modules read
// at import; node --test runs this file in its own process, so the globals and
// the imported-once store/dom singletons don't leak into other suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'file:///', pretendToBeVisual: true });
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
globalThis.CSS = (window.CSS && window.CSS.escape) ? window.CSS
  : { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) };
for (const k of ['NodeFilter', 'Node', 'Range', 'Element', 'HTMLElement', 'getComputedStyle']) {
  if (window[k] !== undefined) globalThis[k] = window[k];
}
window.HTMLElement.prototype.scrollIntoView = function () {}; // jsdom omits it; focusComment calls it
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0);
globalThis.DOMPurify = { sanitize: (s) => s };
globalThis.annoLib = require('../core/lib.js'); // renderHunksHtml diffs via annoLib.diffLines

// In-memory sidecar bridge. persist() reads disk to reconcile, so echo back the
// live comments rather than dropping them.
let diskComments = [];
window.api = {
  readComments: async () => JSON.parse(JSON.stringify(diskComments)),
  writeComments: async (_p, c) => { diskComments = JSON.parse(JSON.stringify(c)); },
  readFile: async () => '',
  watchFile: () => {},
  onFileChanged: () => {},
  onOpenFile: () => {},
  onOpenFolder: () => {},
};

// dom.js binds element refs at import, so import after the document exists and
// reuse this one document across tests (resetting state, not recreating it).
const store = await import('../renderer/store.js');
const { state } = store;
const { renderComments, openComposer } = await import('../renderer/comments.js');
store.subscribe(() => renderComments()); // mirror main.js: structural change -> rebuild

const commentList = document.getElementById('commentList');

// Reset to one open comment on a fresh doc.
function seed() {
  diskComments = [{
    id: 'c1', quote: 'some quoted text', body: 'original comment', author: 'Me',
    createdAt: '2026-06-20T00:00:00Z', status: 'open', replies: [], start: 0, end: 5,
  }];
  store.loadDoc({ filePath: '/tmp/doc.md', rawText: 'some quoted text here', comments: diskComments });
  renderComments();
}

// The watcher path: an AI reply lands on c1, then setComments + render rebuilds.
function aiReplyLands() {
  const withReply = JSON.parse(JSON.stringify(state.comments));
  withReply[0].replies.push({ author: 'AI', body: 'AI suggestion', createdAt: '2026-06-25T00:00:00Z', ai: true });
  diskComments = withReply;
  store.setComments(withReply);
  store.render();
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('AI reply landing preserves a half-typed new comment (text, caret, focus)', () => {
  seed();
  state.pendingRange = { quote: 'new selection', prefix: '', suffix: '', start: 6, end: 10 };
  openComposer();
  let ta = commentList.querySelector('.composer.comment-card textarea');
  ta.value = 'half-typed new comment';
  ta.setSelectionRange(5, 5);
  ta.focus();

  aiReplyLands();

  ta = commentList.querySelector('.composer.comment-card textarea');
  assert.ok(ta, 'composer survives the rebuild');
  assert.equal(ta.value, 'half-typed new comment', 'draft text preserved');
  assert.equal(ta.selectionStart, 5, 'caret preserved');
  assert.equal(document.activeElement, ta, 'focus handed back to the composer');
  assert.ok(commentList.querySelector('.reply.ai'), 'the AI reply still rendered');
  assert.equal(commentList.querySelectorAll('.composer.comment-card').length, 1, 'no double-inject');
});

test('AI reply landing preserves a half-typed reply (text, caret, focus)', () => {
  seed();
  commentList.querySelector('.comment-card[data-comment-id="c1"] .reply-btn').click();
  let ta = commentList.querySelector('.reply-composer textarea');
  ta.value = 'my half-typed reply';
  ta.setSelectionRange(3, 3);
  ta.focus();

  aiReplyLands();

  ta = commentList.querySelector('.comment-card[data-comment-id="c1"] .reply-composer textarea');
  assert.ok(ta && !ta.closest('.reply-composer').hidden, 'reply composer still open');
  assert.equal(ta.value, 'my half-typed reply', 'reply draft preserved');
  assert.equal(ta.selectionStart, 3, 'caret preserved');
  assert.equal(document.activeElement, ta, 'focus handed back to the reply composer');
});

test('submitting a reply does not leave the sent text in a reopened composer', async () => {
  seed();
  commentList.querySelector('.comment-card[data-comment-id="c1"] .reply-btn').click();
  commentList.querySelector('.reply-composer textarea').value = 'submitted reply body';
  commentList.querySelector('.reply-composer .save').click();
  await settle();

  const open = [...commentList.querySelectorAll('.reply-composer')].find((b) => !b.hidden);
  assert.equal(open, undefined, 'no open reply composer after submit');
  assert.ok(state.comments[0].replies.some((r) => r.body === 'submitted reply body'), 'reply persisted');
});

test('submitting a new comment does not leave a stale composer', async () => {
  seed();
  state.pendingRange = { quote: 'new sel', prefix: '', suffix: '', start: 6, end: 10 };
  openComposer();
  commentList.querySelector('.composer.comment-card textarea').value = 'brand new comment';
  commentList.querySelector('.composer.comment-card .save').click();
  await settle();

  assert.equal(commentList.querySelector('.composer.comment-card'), null, 'no composer left after submit');
  assert.ok(state.comments.some((c) => c.body === 'brand new comment'), 'comment persisted');
});

// addComment branches on pendingRange.imageSrc: image comments anchor by src and
// must NOT carry text offsets (start/end/prefix/suffix), or findAnchor would try
// to re-resolve them. Text comments carry the offsets.
test('addComment writes imageSrc and omits text offsets for an image comment', async () => {
  seed();
  state.pendingRange = { quote: 'diagram.png', imageSrc: 'diagram.png' };
  openComposer();
  commentList.querySelector('.composer.comment-card textarea').value = 'about this image';
  commentList.querySelector('.composer.comment-card .save').click();
  await settle();

  const c = state.comments.find((x) => x.body === 'about this image');
  assert.ok(c, 'image comment persisted');
  assert.equal(c.imageSrc, 'diagram.png');
  assert.equal(c.quote, 'diagram.png');
  for (const k of ['start', 'end', 'prefix', 'suffix']) {
    assert.equal(c[k], undefined, `image comment must not carry ${k}`);
  }
});

test('an AI reply with change.hunks renders a Show diff toggle that reveals/hides the diff', () => {
  diskComments = [{
    id: 'c1', quote: 'fast', body: 'make it faster', author: 'Me',
    createdAt: '2026-06-20T00:00:00Z', status: 'addressed', start: 0, end: 4,
    replies: [{
      author: 'Claude', body: 'Sped it up.', createdAt: '2026-06-21T00:00:00Z', ai: true,
      change: { hunks: [{ before: 'the quick fox', after: 'the fast fox' }] },
    }],
  }];
  store.loadDoc({ filePath: '/tmp/doc.md', rawText: 'fast', comments: diskComments });
  renderComments();

  const card = commentList.querySelector('.comment-card[data-comment-id="c1"]');
  const toggle = card.querySelector('.diff-toggle');
  const panel = card.querySelector('.reply-diff');
  assert.ok(toggle && panel, 'toggle + panel rendered for the AI reply');
  assert.equal(toggle.textContent, 'Show diff');
  assert.ok(panel.hidden, 'diff hidden by default');
  // lazy: diff HTML isn't built at render time, only on first open
  assert.equal(panel.innerHTML, '', 'diff rows not rendered until the toggle opens');

  toggle.click();
  assert.equal(panel.hidden, false, 'revealed on click');
  assert.equal(toggle.textContent, 'Hide diff');
  assert.ok(panel.querySelector('.diff-row.add') && panel.querySelector('.diff-row.del'), 'diff rows built on first open');

  toggle.click();
  assert.ok(panel.hidden, 'hidden again on second click');
  assert.equal(panel.dataset.built, '1', 'diff cached after first build');
});

test('comments render in text order regardless of insertion order', () => {
  store.loadDoc({ filePath: '/tmp/doc.md', rawText: 'Alpha Beta Gamma Delta words', comments: [] });
  const mk = (id, start) => ({
    id, quote: id, body: id, author: 'Me', createdAt: '2026-01-01T00:00:00Z',
    status: 'open', replies: [], start, end: start + 3,
  });
  store.setComments([mk('g', 12), mk('a', 0), mk('d', 18), mk('b', 6)]);
  store.render();
  const order = [...commentList.querySelectorAll('.comment-card')].map((c) => c.dataset.commentId);
  assert.deepEqual(order, ['a', 'b', 'g', 'd'], 'cards sorted by anchor offset, not insertion order');
});

// The bug: a comment whose highlight span is absent (quote mid-rewrite/removed) was dumped to the
// sidebar bottom because layoutComments ordered by live rects (no rect → Infinity). Must follow c.start.
test('a comment with no live highlight still lays out above a later anchored comment', () => {
  store.loadDoc({ filePath: '/tmp/doc.md', rawText: 'x', comments: [] });
  const content = document.getElementById('content');
  content.innerHTML = '<p>text <span class="comment-highlight" data-comment-id="late">later</span></p>';
  const rect = (top) => () => ({ top, bottom: top + 12, height: 12, left: 0, right: 0, width: 0 });
  content.querySelector('.comment-highlight[data-comment-id="late"]').getBoundingClientRect = rect(500);
  content.getBoundingClientRect = rect(0);

  const mk = (id, start) => ({
    id, quote: id, body: id, author: 'Me', createdAt: '2026-01-01T00:00:00Z',
    status: 'open', replies: [], start, end: start + 3,
  });
  store.setComments([mk('early', 0), mk('late', 100)]);
  store.render();

  const top = (id) => parseFloat(commentList.querySelector(`.comment-card[data-comment-id="${id}"]`).style.top);
  try {
    assert.ok(top('early') < top('late'), `early card (${top('early')}) must sit above the later card (${top('late')})`);
  } finally {
    // shared document across tests: leftover text nodes make offsetsToRange resolve a Range whose
    // getBoundingClientRect jsdom omits, throwing in a later composer test — reset the stubs
    content.innerHTML = '';
    delete content.getBoundingClientRect;
  }
});

test('an AI reply without change renders no Show diff toggle', () => {
  diskComments = [{
    id: 'c1', quote: 'q', body: 'b', author: 'Me', createdAt: '2026-06-20T00:00:00Z',
    status: 'addressed', start: 0, end: 1,
    replies: [{ author: 'Claude', body: 'Done.', createdAt: '2026-06-21T00:00:00Z', ai: true }],
  }];
  store.loadDoc({ filePath: '/tmp/doc.md', rawText: 'q', comments: diskComments });
  renderComments();
  assert.equal(commentList.querySelector('.diff-toggle'), null, 'no toggle without a change');
});

test('addComment writes text offsets and omits imageSrc for a text comment', async () => {
  seed();
  state.pendingRange = { quote: 'sel', prefix: 'pre', suffix: 'suf', start: 6, end: 10 };
  openComposer();
  commentList.querySelector('.composer.comment-card textarea').value = 'about this text';
  commentList.querySelector('.composer.comment-card .save').click();
  await settle();

  const c = state.comments.find((x) => x.body === 'about this text');
  assert.ok(c, 'text comment persisted');
  assert.equal(c.imageSrc, undefined, 'text comment must not carry imageSrc');
  assert.deepEqual(
    { start: c.start, end: c.end, prefix: c.prefix, suffix: c.suffix },
    { start: 6, end: 10, prefix: 'pre', suffix: 'suf' }
  );
});

// Regression: renderHunksHtml must survive a mixed hunks array (a valid hunk
// alongside a null/malformed element) — hasRenderableDiff gates on .some(), so a
// bad element can pass the gate; the render must filter, not throw mid-pane.
test('renderHunksHtml ignores malformed elements instead of throwing', async () => {
  const { renderHunksHtml } = await import('../renderer/diff.js');
  let html;
  assert.doesNotThrow(() => {
    html = renderHunksHtml([{ before: 'a', after: 'b' }, null, { before: 1, after: 2 }]);
  });
  assert.match(html, /diff-row/, 'still renders the one valid hunk');
});

// A no-op hunk (before === after) inside a mixed array must not render as empty
// context rows + a stray ⋯ separator — renderHunksHtml filters it like hasRenderableDiff.
test('renderHunksHtml drops a no-op hunk in a mixed array', async () => {
  const { renderHunksHtml } = await import('../renderer/diff.js');
  const html = renderHunksHtml([{ before: 'same', after: 'same' }, { before: 'a', after: 'b' }]);
  assert.doesNotMatch(html, /diff-row gap/, 'no separator emitted for the dropped no-op');
  assert.match(html, /diff-row add/, 'the real edit still renders');
});

// diffLines is O(m·n): an oversized before/after (corrupted/hand-edited sidecar)
// would hang the renderer at markup-build time. The cap must short-circuit to a
// placeholder and never feed diffLines — so the test completes fast.
test('renderHunksHtml caps an oversized hunk with a placeholder instead of diffing it', async () => {
  const { renderHunksHtml } = await import('../renderer/diff.js');
  const huge = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
  let html;
  const t0 = Date.now();
  assert.doesNotThrow(() => {
    html = renderHunksHtml([{ before: huge, after: huge + '\nplus one line' }]);
  });
  assert.ok(Date.now() - t0 < 1000, 'must not build the O(m·n) LCS matrix');
  assert.match(html, /diff too large to display/, 'placeholder shown');
  assert.doesNotMatch(html, /diff-row (add|del)/, 'diffLines was not fed the oversized hunk');
});

// Commented images must be navigable like text highlights: clicking one focuses its
// existing comment instead of offering a duplicate; only an uncommented image starts
// a new comment. selection.js wires the contentEl click handler at import.
test('clicking a commented image focuses its comment; an uncommented image opens the composer', async () => {
  const { applyHighlights } = await import('../renderer/anchoring.js');
  await import('../renderer/selection.js'); // wires the delegated image click handler
  const contentEl = document.getElementById('content');
  const addBtn = document.getElementById('addCommentBtn');

  diskComments = [{
    id: 'img1', quote: 'diagram.png', imageSrc: 'diagram.png', body: 'about the diagram',
    author: 'Me', createdAt: '2026-06-20T00:00:00Z', status: 'open', replies: [],
  }];
  store.loadDoc({ filePath: '/tmp/doc.md', rawText: 'x', comments: diskComments });
  contentEl.innerHTML =
    '<img data-anno-src="diagram.png" src="file:///diagram.png">' +
    '<img data-anno-src="other.png" src="file:///other.png">';
  applyHighlights(); // stamps data-commentId on the commented <img>
  renderComments();

  const [commented, uncommented] = contentEl.querySelectorAll('img');

  commented.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(addBtn.hidden, true, 'no add-comment button for an already-commented image');
  assert.equal(commentList.querySelector('.composer.comment-card'), null, 'no new composer opened');
  const card = commentList.querySelector('.comment-card[data-comment-id="img1"]');
  assert.ok(card && card.classList.contains('active'), 'the existing comment is focused');

  uncommented.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(addBtn.hidden, false, 'uncommented image surfaces the add-comment button');
});

// A comment whose quoted text was removed has no live highlight. Instead of an in-doc marker, the
// card flags itself detached and keeps its document-order slot (positioned at the gap).
test('a comment whose quote is gone renders a detached card, no in-doc marker', async () => {
  const { applyHighlights } = await import('../renderer/anchoring.js');
  const contentEl = document.getElementById('content');
  contentEl.innerHTML = '<p>the text here</p>';
  store.loadDoc({ filePath: '/tmp/doc.md', rawText: 'the text here', comments: [] });
  store.setComments([{
    id: 'gone', quote: 'VANISHED', body: 'note', author: 'Me',
    createdAt: '2026-01-01T00:00:00Z', status: 'open', replies: [], start: 4, end: 9,
  }]);
  applyHighlights(); // populates the anchors map renderComments reads
  renderComments();
  try {
    const card = commentList.querySelector('.comment-card[data-comment-id="gone"]');
    assert.ok(card, 'card rendered');
    assert.ok(card.classList.contains('detached'), 'card flagged detached');
    assert.match(card.querySelector('.meta').textContent, /quote removed/, 'meta flags the removal');
    assert.equal(contentEl.querySelector('.comment-highlight[data-comment-id="gone"]'), null, 'nothing injected into the doc');
  } finally {
    contentEl.innerHTML = '';
  }
});

// spans are rebuilt by morphdom, so clicks are delegated on contentEl — a click on a text highlight
// must still focus its comment (and :not(.pending) not swallow the composing selection).
test('clicking a text highlight focuses its comment via the delegated listener', async () => {
  const { applyHighlights } = await import('../renderer/anchoring.js');
  await import('../renderer/selection.js');
  const contentEl = document.getElementById('content');
  store.loadDoc({ filePath: '/tmp/doc.md', rawText: 'alpha beta gamma', comments: [] });
  contentEl.innerHTML = '<p>alpha beta gamma</p>';
  store.setComments([{
    id: 'c1', quote: 'beta', body: 'b', author: 'Me',
    createdAt: '2026-01-01T00:00:00Z', status: 'open', replies: [], start: 6, end: 10,
  }]);
  applyHighlights();
  renderComments();
  try {
    const span = contentEl.querySelector('.comment-highlight[data-comment-id="c1"]');
    assert.ok(span, 'highlight span painted');
    span.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.equal(state.activeId, 'c1', 'clicking the highlight sets its comment active');
    const card = commentList.querySelector('.comment-card[data-comment-id="c1"]');
    assert.ok(card && card.classList.contains('active'), 'the comment card is focused');
  } finally {
    contentEl.innerHTML = ''; // shared document — leftover spans break later Range-based tests
  }
});

// Cmd/Ctrl+Enter starts a comment ONLY when a doc selection (or image) is pending.
// That guard in selection.js is what keeps the global shortcut from colliding with
// the composer's own Cmd+Enter save. Drive the real document keydown handler.
const realGetSelection = window.getSelection.bind(window);
function fakeTextSelection(text) {
  const range = document.createRange();
  range.selectNodeContents(contentElFor());
  window.getSelection = () => ({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
    toString: () => text,
    removeAllRanges() {},
  });
}
function contentElFor() {
  return document.getElementById('content');
}

test('Cmd+Enter with an active text selection opens the composer', async () => {
  await import('../renderer/selection.js'); // wires the document keydown handler
  store.loadDoc({ filePath: '/tmp/doc.md', rawText: 'some selected words here', comments: [] });
  // leave contentEl empty: a populated one makes offsetsToRange return a Range whose
  // getBoundingClientRect jsdom doesn't implement, blowing up layoutComments (same
  // reason the other composer tests don't populate it). The indexOf fallback in
  // startComment then yields {0,0} offsets, which is fine — we assert on the quote.
  contentElFor().innerHTML = '';
  // clear any image pick leaked from a prior test, else startComment takes the image path
  document.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  state.pendingRange = null;
  renderComments();

  fakeTextSelection('selected words');
  try {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { metaKey: true, key: 'Enter', bubbles: true }));
  } finally {
    window.getSelection = realGetSelection;
  }

  assert.ok(state.pendingRange, 'pending range set from the selection');
  assert.equal(state.pendingRange.quote, 'selected words', 'composer seeded with the selected text');
  assert.ok(commentList.querySelector('.composer.comment-card'), 'composer opened');
  store.setPending(null);
});

test('Cmd+Enter with no selection and no pending image is a no-op', async () => {
  await import('../renderer/selection.js');
  store.loadDoc({ filePath: '/tmp/doc.md', rawText: 'nothing selected', comments: [] });
  contentElFor().textContent = 'nothing selected';
  // clear any image pick leaked from a prior test (selection.js clears it on outside mousedown)
  document.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  state.pendingRange = null;
  renderComments();

  // collapsed selection -> activeTextSelection() returns null, so the guard must bail
  window.getSelection = () => ({ isCollapsed: true, rangeCount: 0, getRangeAt: () => null, toString: () => '', removeAllRanges() {} });
  try {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { metaKey: true, key: 'Enter', bubbles: true }));
  } finally {
    window.getSelection = realGetSelection;
  }

  assert.equal(state.pendingRange, null, 'no pending range — the guard prevented startComment');
  assert.equal(commentList.querySelector('.composer.comment-card'), null, 'no composer opened');
});
