// Flow 6: the public CLI surface. `watch` and `address` were removed as user-facing
// commands; only `review` and `list` remain. Spawns the real anno.js so the argv
// dispatch (not just the underlying modules) is what's under test.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeComments } = require('../core/sidecar.js');

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
