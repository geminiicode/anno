const test = require('node:test');
const assert = require('node:assert/strict');

const { findAnchor, diffLines } = require('../core/lib.js');

// ---------- findAnchor ----------

test('findAnchor trusts valid stored offsets', () => {
  const text = 'one two three two';
  assert.deepEqual(
    findAnchor(text, { start: 4, end: 7, quote: 'two' }),
    { start: 4, end: 7 }
  );
});

test('findAnchor falls back to quote search when offsets are stale', () => {
  const text = 'PREAMBLE one two three';
  assert.deepEqual(
    findAnchor(text, { start: 4, end: 7, quote: 'two' }),
    { start: 13, end: 16 }
  );
});

test('findAnchor uses prefix to disambiguate repeated quotes', () => {
  const text = 'two apples, then two oranges';
  assert.deepEqual(
    findAnchor(text, { quote: 'two', prefix: 'then ' }),
    { start: 17, end: 20 }
  );
});

test('findAnchor returns null for an orphaned comment', () => {
  assert.equal(findAnchor('nothing here', { quote: 'gone', start: 0, end: 4 }), null);
});

test('findAnchor treats an empty/whitespace quote as orphaned (no zero-width match)', () => {
  // A hand-authored sidecar could carry an empty quote with {start:0,end:0};
  // text.slice(0,0)==='' must not count as a match.
  assert.equal(findAnchor('some text', { quote: '', start: 0, end: 0 }), null);
  assert.equal(findAnchor('some text', { quote: '   ', start: 0, end: 0 }), null);
  assert.equal(findAnchor('some text', { start: 0, end: 0 }), null);
});

test('findAnchor handles a re-anchored comment (quote only, no offsets)', () => {
  const text = 'the revised wording is here';
  assert.deepEqual(
    findAnchor(text, { quote: 'revised wording' }),
    { start: 4, end: 19 }
  );
});

test('findAnchor strips markdown source syntax from the quote (e2e regression)', () => {
  // Claude re-anchored a comment with newQuote "**highlight**" — markdown
  // source — while the rendered text just says "highlight".
  const text = 'Comments are anchored to the exact text you highlight.';
  assert.deepEqual(
    findAnchor(text, { quote: '**highlight**' }),
    { start: 44, end: 53 }
  );
  assert.deepEqual(
    findAnchor(text, { quote: '`anchored`' }),
    { start: 13, end: 21 }
  );
  // A quote that is ONLY markers must not match everything.
  assert.equal(findAnchor(text, { quote: '**' }), null);
});

// ---------- diffLines ----------

test('diffLines marks identical input as all context', () => {
  const rows = diffLines('a\nb', 'a\nb');
  assert.deepEqual(rows.map((r) => r.type), ['ctx', 'ctx']);
});

test('diffLines reports adds and deletes', () => {
  const rows = diffLines('a\nb\nc', 'a\nX\nc');
  assert.deepEqual(rows, [
    { type: 'ctx', text: 'a' },
    { type: 'del', text: 'b' },
    { type: 'add', text: 'X' },
    { type: 'ctx', text: 'c' },
  ]);
});

test('diffLines handles pure append and pure removal', () => {
  assert.deepEqual(diffLines('a', 'a\nb').map((r) => r.type), ['ctx', 'add']);
  assert.deepEqual(diffLines('a\nb', 'a').map((r) => r.type), ['ctx', 'del']);
});

test('diffLines treats an empty doc as zero lines, not a phantom blank line', () => {
  // ''.split('\n') is [''] — without the empty-string guard this yields a
  // spurious leading {type:'del',text:''} / {type:'add',text:''}.
  assert.deepEqual(diffLines('', 'a\nb').map((r) => r.type), ['add', 'add']);
  assert.deepEqual(diffLines('a\nb', '').map((r) => r.type), ['del', 'del']);
  assert.deepEqual(diffLines('', ''), []);
});
