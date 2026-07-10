require('./helpers/store-env.js'); // must precede any core/ import
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('node:crypto');

const { canonical, storeRoot, storePath } = require('../core/paths.js');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function tmpDir(prefix = 'anno-paths-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('a symlink and its target hash to the same store key', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'doc.md');
  fs.writeFileSync(target, '# Doc\n');
  const link = path.join(dir, 'alias.md');
  fs.symlinkSync(target, link);
  assert.equal(storePath(link), storePath(target));
  // and it is keyed on the resolved target, not the alias
  assert.equal(path.basename(storePath(link)), sha(fs.realpathSync(target)) + '.json');
});

test('a nonexistent path produces a stable key via the raw-path fallback', () => {
  const p = path.join(tmpDir(), 'never-created.md');
  assert.equal(canonical(p), p); // no realpath → raw path
  assert.equal(storePath(p), storePath(p)); // stable across calls
  assert.equal(path.basename(storePath(p)), sha(p) + '.json');
});

test('ANNO_STORE_DIR is honored as the store root', () => {
  const custom = tmpDir('anno-custom-');
  const prev = process.env.ANNO_STORE_DIR;
  process.env.ANNO_STORE_DIR = custom;
  try {
    assert.equal(storeRoot(), custom);
    assert.equal(path.dirname(storePath('/some/doc.md')), custom);
  } finally {
    process.env.ANNO_STORE_DIR = prev;
  }
});

test('storeRoot refuses a group/other-accessible store directory', () => {
  const loose = tmpDir('anno-loose-');
  fs.chmodSync(loose, 0o755);
  const prev = process.env.ANNO_STORE_DIR;
  process.env.ANNO_STORE_DIR = loose;
  try {
    assert.throws(() => storeRoot(), /group\/other-accessible|mode/);
  } finally {
    process.env.ANNO_STORE_DIR = prev;
  }
});
