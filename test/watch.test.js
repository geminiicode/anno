const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listMarkdownFiles, FILE_WARN_THRESHOLD } = require('../cli/watch.js');

// Build a temp tree and return its root. `spec` maps relative paths to file
// contents; intermediate dirs are created as needed.
function tmpTree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anno-walk-'));
  for (const [rel, body] of Object.entries(spec)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

const names = (root) => listMarkdownFiles(root).map((p) => path.relative(root, p)).sort();

test('listMarkdownFiles matches all markdown extensions, ignores others', () => {
  const root = tmpTree({
    'a.md': '', 'b.markdown': '', 'c.mdown': '', 'd.mkd': '',
    'e.txt': '', 'f.js': '', 'README': '',
  });
  assert.deepEqual(names(root), ['a.md', 'b.markdown', 'c.mdown', 'd.mkd']);
});

test('listMarkdownFiles recurses into subdirs but skips dotfiles and node_modules', () => {
  const root = tmpTree({
    'top.md': '',
    'sub/nested.md': '',
    '.hidden/secret.md': '',          // dot-dir skipped
    'node_modules/pkg/readme.md': '', // node_modules skipped
    '.dotfile.md': '',                // dotfile skipped
  });
  assert.deepEqual(names(root), ['sub/nested.md', 'top.md']);
});

test('listMarkdownFiles skips symlinked files and directories', () => {
  const root = tmpTree({ 'real.md': '', 'outside/secret.md': '' });
  // A symlinked .md file and a symlinked directory, both pointing outside `root`.
  fs.symlinkSync(path.join(root, 'outside', 'secret.md'), path.join(root, 'link.md'));
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'linkdir'));
  assert.deepEqual(names(root), ['outside/secret.md', 'real.md']); // no link.md, no linkdir/*
});

test('listMarkdownFiles stops at depth 6', () => {
  // root/d1/.../d7/deep.md is 7 dirs below root → beyond the depth-6 cap.
  const deep = Array.from({ length: 7 }, (_, i) => `d${i + 1}`).join('/');
  const root = tmpTree({ 'shallow.md': '', [`${deep}/deep.md`]: '' });
  assert.deepEqual(names(root), ['shallow.md']);
});

test('listMarkdownFiles returns [] for a missing directory', () => {
  assert.deepEqual(listMarkdownFiles('/no/such/dir/here'), []);
});

test('FILE_WARN_THRESHOLD is exported as a positive number', () => {
  assert.equal(typeof FILE_WARN_THRESHOLD, 'number');
  assert.ok(FILE_WARN_THRESHOLD > 0);
});
