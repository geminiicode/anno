// Flow 6: the public CLI surface. `watch` and `address` were removed as user-facing
// commands; only `review` and `list` remain. Spawns the real anno.js so the argv
// dispatch (not just the underlying modules) is what's under test.
require('./helpers/store-env.js'); // must precede any core/ import; spawned anno.js inherits it
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeComments } = require('../core/sidecar.js');
const { storePath } = require('../core/paths.js');

const ANNO = path.join(__dirname, '..', 'anno.js');

// process.execPath, not "node" — the test's own node, no PATH assumptions.
function runAnno(args) {
  return spawnSync(process.execPath, [ANNO, ...args], { encoding: 'utf8' });
}

for (const args of [[], ['bogus'], ['watch', 'x.md'], ['address', 'x.md']]) {
  test(`\`anno ${args.join(' ') || '(none)'}\` falls through to usage`, () => {
    const { stdout, status } = runAnno(args);
    assert.match(stdout, /Usage:/);
    // the removed commands must not be advertised anywhere in the usage text
    assert.doesNotMatch(stdout, /\banno watch\b/);
    assert.doesNotMatch(stdout, /\banno address\b/);
    assert.match(stdout, /anno review/);
    assert.match(stdout, /anno list/);
    assert.equal(status, 0);
  });
}

test('`anno help` prints the shipped HELP.md, not the bare usage', () => {
  const help = fs.readFileSync(path.join(__dirname, '..', 'HELP.md'), 'utf8');
  const { stdout } = runAnno(['help']);
  assert.equal(stdout, help);
});

test('`anno list <file>` prints comments and their statuses', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anno-cli-'));
  const md = path.join(dir, 'doc.md');
  fs.writeFileSync(md, '# Doc\n\nsome text\n');
  writeComments(md, [{ id: 'c1', quote: 'some text', body: 'fix this', status: 'open' }]);
  const { stdout, status } = runAnno(['list', md]);
  assert.equal(status, 0);
  assert.match(stdout, /open/i);
  assert.match(stdout, /fix this/);
});

test('`anno review <missing>` errors with Path not found (no Electron launch)', () => {
  // review.js checks existsSync before it ever resolves Electron, so a missing
  // path exercises the review dispatch without spawning a window.
  const { stderr, status } = runAnno(['review', '/no/such/path/here.md']);
  assert.match(stderr, /Path not found/);
  assert.equal(status, 1);
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'anno-clean-'));
}

function commented(dir, name) {
  const md = path.join(dir, name);
  fs.writeFileSync(md, `# ${name}\n\ntext\n`);
  writeComments(md, [{ id: 'c1', quote: 'text', body: 'fix', status: 'open' }]);
  return md;
}

// storePath hashes canonical(md), which resolves symlinks only while md exists —
// so capture the entry path BEFORE orphaning the doc, or the hash won't match.
test('`anno clean` with no path prefix refuses and deletes nothing', () => {
  const dir = tmpDir();
  const md = commented(dir, 'gone.md');
  const entry = storePath(md);
  fs.rmSync(md); // orphan the store entry
  const { status } = runAnno(['clean']);
  assert.notEqual(status, 0);
  assert.equal(fs.existsSync(entry), true); // untouched
});

test('`anno clean <path>` without --force is a dry run', () => {
  const dir = tmpDir();
  const md = commented(dir, 'gone.md');
  const entry = storePath(md);
  fs.rmSync(md);
  const { stdout, status } = runAnno(['clean', dir]);
  assert.equal(status, 0);
  assert.match(stdout, /would remove/);
  assert.equal(fs.existsSync(entry), true); // dry run leaves it on disk
});

test('`anno clean <path> --force` reaps a gone doc but keeps a live one', () => {
  const dir = tmpDir();
  const goneMd = commented(dir, 'gone.md');
  const liveMd = commented(dir, 'live.md');
  const goneEntry = storePath(goneMd);
  const liveEntry = storePath(liveMd);
  fs.rmSync(goneMd);
  const { status } = runAnno(['clean', dir, '--force']);
  assert.equal(status, 0);
  assert.equal(fs.existsSync(goneEntry), false); // orphan reaped
  assert.equal(fs.existsSync(liveEntry), true); // live doc's entry preserved
});

// The corrupt-file dialog promises these are recoverable, and they're unparseable
// so they can't be scoped to <path> — reaping one would destroy another tree's backup.
test('`anno clean <path> --force` reports a .corrupt backup but never deletes it', () => {
  const dir = tmpDir();
  const md = commented(dir, 'gone.md');
  const entry = storePath(md);
  const backup = `${entry}.corrupt`;
  fs.copyFileSync(entry, backup);
  fs.rmSync(md);
  const { stdout, status } = runAnno(['clean', dir, '--force']);
  assert.equal(status, 0);
  assert.equal(fs.existsSync(entry), false); // orphan still reaped
  assert.equal(fs.existsSync(backup), true); // backup survives
  assert.match(stdout, /corrupt backup/);
});

test('`anno clean <path> --force` ignores an entry whose doc is outside <path>', () => {
  const inside = tmpDir();
  const outside = tmpDir();
  const outsideMd = commented(outside, 'other.md');
  const outsideEntry = storePath(outsideMd);
  fs.rmSync(outsideMd); // orphaned, but not under `inside`
  const { status } = runAnno(['clean', inside, '--force']);
  assert.equal(status, 0);
  assert.equal(fs.existsSync(outsideEntry), true); // out of prefix → untouched
});

test('`anno clean --legacy <path> --force` sweeps v1 files and their siblings', () => {
  const dir = tmpDir();
  const legacy = [
    '.doc.md.comments.json',
    '.doc.md.comments.json.corrupt',
    '.doc.md.comments.json.4242.tmp',
  ].map((n) => path.join(dir, n));
  for (const f of legacy) fs.writeFileSync(f, '{"version":1}');

  const first = runAnno(['clean', '--legacy', dir, '--force']);
  assert.equal(first.status, 0);
  for (const f of legacy) assert.equal(fs.existsSync(f), false);

  const second = runAnno(['clean', '--legacy', dir, '--force']);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /Nothing to remove/);
});
