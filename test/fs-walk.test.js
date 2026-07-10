const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { pathInScope, MAX_DEPTH } = require('../core/fs-walk');

const p = (...segs) => segs.join(path.sep);

test('pathInScope: a markdown file directly under root is in scope', () => {
  assert.equal(pathInScope(p('a'), p('a', 'doc.md')), true);
});

test('pathInScope: node_modules anywhere in the path is out of scope', () => {
  assert.equal(pathInScope(p('a'), p('a', 'node_modules', 'pkg', 'readme.md')), false);
});

test('pathInScope: a dot-directory in the path is out of scope', () => {
  assert.equal(pathInScope(p('a'), p('a', '.git', 'COMMIT_EDITMSG.md')), false);
  assert.equal(pathInScope(p('a'), p('a', '.hidden', 'doc.md')), false);
});

test('pathInScope: deeper than MAX_DEPTH directories is out of scope', () => {
  const within = ['a', ...Array(MAX_DEPTH).fill('d'), 'doc.md']; // MAX_DEPTH dirs below root
  const beyond = ['a', ...Array(MAX_DEPTH + 1).fill('d'), 'doc.md'];
  assert.equal(pathInScope('a', within.join(path.sep)), true);
  assert.equal(pathInScope('a', beyond.join(path.sep)), false);
});

test('pathInScope: paths outside the root are rejected', () => {
  assert.equal(pathInScope(p('a', 'b'), p('a', 'c', 'doc.md')), false); // sibling
  assert.equal(pathInScope(p('a', 'b'), p('a', 'b')), false); // the root itself, not a file under it
  assert.equal(pathInScope(p('a', 'b'), p('a', 'bc', 'doc.md')), false); // prefix sibling, not contained
});
