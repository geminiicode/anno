const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { covers, resolve } = require('../core/overlap.js');

// Build paths with the platform separator so the tests run on Windows too.
const p = (...segs) => segs.join(path.sep);

test('covers: equality', () => {
  assert.equal(covers(p('a', 'b'), p('a', 'b')), true);
});

test('covers: ancestor contains descendant', () => {
  assert.equal(covers(p('a', 'b'), p('a', 'b', 'c.md')), true);
});

test('covers: descendant does NOT contain ancestor', () => {
  assert.equal(covers(p('a', 'b', 'c.md'), p('a', 'b')), false);
});

test('covers: siblings/disjoint', () => {
  assert.equal(covers(p('a', 'b'), p('a', 'c')), false);
  assert.equal(covers(p('x'), p('y')), false);
});

test('covers: path-prefix is not containment (/a/bc vs /a/b)', () => {
  assert.equal(covers(p('a', 'b'), p('a', 'bc')), false);
  assert.equal(covers(p('a', 'b'), p('a', 'bc', 'd.md')), false);
});

test('resolve: nothing open → started', () => {
  assert.deepEqual(resolve(p('a', 'doc.md'), false, []), {
    action: 'started',
    root: p('a', 'doc.md'),
  });
});

test('resolve: exact file match → focus, no selectFile', () => {
  const existing = [{ root: p('a', 'doc.md'), isDir: false }];
  assert.deepEqual(resolve(p('a', 'doc.md'), false, existing), {
    action: 'focus',
    root: p('a', 'doc.md'),
    selectFile: null,
  });
});

test('resolve: exact folder match → focus, no selectFile', () => {
  const existing = [{ root: p('a'), isDir: true }];
  assert.deepEqual(resolve(p('a'), true, existing), {
    action: 'focus',
    root: p('a'),
    selectFile: null,
  });
});

test('resolve: file inside an open folder-tab → focus folder + select the file', () => {
  const existing = [{ root: p('a'), isDir: true }];
  assert.deepEqual(resolve(p('a', 'b', 'doc.md'), false, existing), {
    action: 'focus',
    root: p('a'),
    selectFile: p('a', 'b', 'doc.md'),
  });
});

test('resolve: folder inside an open folder-tab → focus, no selectFile', () => {
  const existing = [{ root: p('a'), isDir: true }];
  assert.deepEqual(resolve(p('a', 'b'), true, existing), {
    action: 'focus',
    root: p('a'),
    selectFile: null,
  });
});

test('resolve: new folder over open file-tabs → absorb the contained files', () => {
  const existing = [
    { root: p('a', 'one.md'), isDir: false },
    { root: p('a', 'sub', 'two.md'), isDir: false },
    { root: p('elsewhere', 'three.md'), isDir: false }, // outside → not absorbed
  ];
  assert.deepEqual(resolve(p('a'), true, existing), {
    action: 'absorb',
    root: p('a'),
    absorbedFiles: [p('a', 'one.md'), p('a', 'sub', 'two.md')],
  });
});

test('resolve: new folder over an open SUB-folder-tab → absorb it (no dual daemon)', () => {
  // The footgun guard: a sub-folder agent left open under its new parent would be
  // a second daemon writing the same subtree. It must be folded in, not left running.
  const existing = [{ root: p('a', 'sub'), isDir: true }];
  assert.deepEqual(resolve(p('a'), true, existing), {
    action: 'absorb',
    root: p('a'),
    absorbedFiles: [p('a', 'sub')],
  });
});

test('resolve: new folder absorbs both contained files AND sub-folders', () => {
  const existing = [
    { root: p('a', 'one.md'), isDir: false },
    { root: p('a', 'sub'), isDir: true },
    { root: p('elsewhere'), isDir: true }, // outside → not absorbed
  ];
  assert.deepEqual(resolve(p('a'), true, existing), {
    action: 'absorb',
    root: p('a'),
    absorbedFiles: [p('a', 'one.md'), p('a', 'sub')],
  });
});

test('resolve: new folder with no contained file-tabs → started', () => {
  const existing = [{ root: p('elsewhere', 'doc.md'), isDir: false }];
  assert.deepEqual(resolve(p('a'), true, existing), {
    action: 'started',
    root: p('a'),
  });
});

test('resolve: open file is NOT a folder, so a file at a deeper path → started', () => {
  // A file-tab never "covers" anything — opening a sibling file just starts.
  const existing = [{ root: p('a', 'one.md'), isDir: false }];
  assert.deepEqual(resolve(p('a', 'two.md'), false, existing), {
    action: 'started',
    root: p('a', 'two.md'),
  });
});

test('resolve: prefix sibling folder is not covered (/a/bc vs open /a/b)', () => {
  const existing = [{ root: p('a', 'b'), isDir: true }];
  assert.deepEqual(resolve(p('a', 'bc', 'doc.md'), false, existing), {
    action: 'started',
    root: p('a', 'bc', 'doc.md'),
  });
});
