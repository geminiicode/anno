// Flow 4 (e2e) + Flow 7: the watch-daemon's process lifecycle, exercised by
// spawning the real cli/watch-daemon.js — the guarantees that keep a headless
// agent from running with no window:
//   - startup sweeps a stranded 👀 marker to `errored` (no double-apply)
//   - SIGINT (clean window close) tears down and exits 0
//   - parent death (GUI crash / kill -9) → self-exit via the ppid poll
// No claude/GUI needed: the sweep fixture has no OPEN comment, so no batch ever
// spawns the agent.
require('./helpers/store-env.js'); // must precede any core/ import; spawned daemons inherit it
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { writeComments, readComments } = require('../core/sidecar.js');
const { createStoreRouter } = require('../cli/watch.js');
const { storeRoot, canonical } = require('../core/paths.js');

const DAEMON = path.join(__dirname, '..', 'cli', 'watch-daemon.js');

// Mirrors storePath()'s key so a test can name a store file by the doc it belongs
// to — or deliberately misname it (test d).
const hashOf = (p) => crypto.createHash('sha256').update(canonical(p)).digest('hex');
const writeStoreFile = (name, obj) =>
  fs.writeFileSync(path.join(storeRoot(), name), JSON.stringify(obj));

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll `fn` until truthy or the deadline; returns the value or throws on timeout.
async function waitFor(fn, { timeout = 8000, interval = 100, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await delay(interval);
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function tmpDoc(comments) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anno-daemon-'));
  const md = path.join(dir, 'doc.md');
  fs.writeFileSync(md, '# Doc\n\nsome text here\n');
  if (comments) writeComments(md, comments);
  return { dir, md };
}

// Wait for a spawned child (with a piped stdout) to print its "Watching …" banner
// so we know the ppid poll + watchers are installed before we act on it.
// A stub `claude` on PATH that drains stdin and exits non-zero, so a live address
// run resolves to a concrete, hermetic outcome (addressCore → markErrored) with no
// real Claude CLI, network, or file edit. Returns the dir to prepend to PATH.
function fakeClaudeBin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anno-fake-claude-'));
  fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\ncat >/dev/null 2>&1\nexit 1\n', { mode: 0o755 });
  return dir;
}

function waitForBanner(child) {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (d) => {
      buf += d;
      if (/Watching /.test(buf)) {
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
  });
}

// A folder-tab tree with one real markdown doc; returns the canonical root (what
// watch() passes as abs/watchDir) and the canonical doc path (what `doc` stores).
function tmpTree() {
  const root = canonical(fs.mkdtempSync(path.join(os.tmpdir(), 'anno-store-tree-')));
  const md = path.join(root, 'doc.md');
  fs.writeFileSync(md, '# Doc\n\ntext\n');
  return { root, md: canonical(md) };
}

const makeRouter = (root, enqueued, index = new Map()) =>
  createStoreRouter({ enqueue: (p) => enqueued.push(p), isDir: true, abs: root, watchDir: root, index });

// (a) scope guard: a store file whose `doc` resolves outside the watched tree is
// dropped — this is the last guard now that the trigger left the tree (§5).
test('store router: a doc outside the watched tree never enqueues', () => {
  const { root } = tmpTree();
  const outside = path.join(os.tmpdir(), 'anno-elsewhere', 'evil.md');
  const name = hashOf(outside) + '.json';
  writeStoreFile(name, { version: 2, doc: outside, comments: [{ id: 'x' }] });
  const enqueued = [];
  makeRouter(root, enqueued)(name);
  assert.deepEqual(enqueued, [], 'out-of-tree doc must not be addressed');
});

// (b) filter: the tmp file is valid, in-scope JSON about to vanish; only the
// filename filter (not a read) may block it, so give it an in-tree doc.
test('store router: a .tmp or .corrupt event never enqueues', () => {
  const { root, md } = tmpTree();
  const base = hashOf(md) + '.json';
  writeStoreFile(base + '.9999.tmp', { version: 2, doc: md, comments: [{ id: 'x' }] });
  writeStoreFile(base + '.corrupt', { version: 2, doc: md, comments: [{ id: 'x' }] });
  const enqueued = [];
  const route = makeRouter(root, enqueued);
  route(base + '.9999.tmp');
  route(base + '.corrupt');
  assert.deepEqual(enqueued, [], 'only exact <hash>.json may enqueue');
});

// (c) unlink: the empty-list delete removes the file, so the contents are gone —
// the seeded index is the only thing that can route the delete to its doc.
test('store router: an unlink routes via the index to the right document', () => {
  const { root, md } = tmpTree();
  const name = hashOf(md) + '.json';
  // File intentionally absent (unlinked); index carries the mapping.
  const index = new Map([[hashOf(md), md]]);
  const enqueued = [];
  makeRouter(root, enqueued, index)(name);
  assert.deepEqual(enqueued, [md], 'unlink event addresses the doc named in the index');
});

// (d) check/use invariant: a file whose `doc` (in-scope) and filename-hash
// disagree enqueues the validated path, but the smuggled comments are never
// applied — addressCore re-reads by hashing that path, landing on a different
// (empty) store file, not this crafted one.
test('store router: doc and filename-hash disagreeing applies nothing', () => {
  const { root, md } = tmpTree();
  const wrongName = '0'.repeat(64) + '.json'; // not hashOf(md)
  const malicious = [{ id: 'evil', quote: 'x', body: 'rm -rf', status: 'open' }];
  writeStoreFile(wrongName, { version: 2, doc: md, comments: malicious });
  const enqueued = [];
  makeRouter(root, enqueued)(wrongName);
  assert.deepEqual(enqueued, [md], 'enqueues the validated path, not the crafted file');
  // The payload was never trusted: re-reading by the validated path re-hashes to
  // <hash(md)>.json, which does not exist, so nothing is applied.
  assert.deepEqual(readComments(md), [], 'smuggled comments are not readable via the validated path');
});

// (e) index eviction: routing an unlink drops the hash, so a stray second unlink
// for the same (still-absent) file has nothing to route to.
test('store router: a second unlink for the same hash is dropped', () => {
  const { root, md } = tmpTree();
  const name = hashOf(md) + '.json'; // file intentionally absent (unlinked)
  const index = new Map([[hashOf(md), md]]);
  const enqueued = [];
  const route = makeRouter(root, enqueued, index);
  route(name); // first unlink routes via the index, then evicts the hash
  route(name); // index forgot it + store file still gone → nothing to route
  assert.deepEqual(enqueued, [md], 'the unlink must not re-fire once the index forgot it');
});

// (f) the strict guard the GUI previously lacked: a `doc` textually inside the
// tree but symlinked out passes pathInScope yet must fail realpathSync containment.
test('store router: a symlinked-out doc that passes a textual check is rejected', () => {
  const { root } = tmpTree();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anno-symlink-out-'));
  const realMd = path.join(outsideDir, 'real.md');
  fs.writeFileSync(realMd, '# Real\n\ntext\n');
  const link = path.join(root, 'link.md'); // textually under root; realpaths outside
  fs.symlinkSync(realMd, link);
  const name = hashOf(link) + '.json';
  writeStoreFile(name, { version: 2, doc: link, comments: [{ id: 'x' }] });
  const enqueued = [];
  makeRouter(root, enqueued)(name);
  assert.deepEqual(enqueued, [], 'realpathSync containment must reject a symlink pointing out of the tree');
});

test('startup sweeps a stranded 👀 marker to errored (no agent spawned)', async () => {
  // working:true with no live daemon = a marker a crashed watcher left behind.
  const { md } = tmpDoc([
    { id: 'c1', quote: 'some text here', body: 'tighten this', status: 'open', working: true, workingSince: new Date().toISOString() },
  ]);
  const child = spawn(process.execPath, [DAEMON, md], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const swept = await waitFor(
      () => readComments(md).find((c) => c.id === 'c1' && c.status === 'errored'),
      { label: 'stranded marker swept to errored' }
    );
    assert.equal(swept.status, 'errored');
    assert.ok(!swept.working, 'working marker cleared so stale-retry skips it');
    assert.match(swept.errorDetail || '', /interrupted/i);
  } finally {
    child.kill('SIGKILL');
  }
});

test('SIGINT (clean close) tears down and exits 0', async () => {
  const { dir } = tmpDoc(); // empty folder tab: nothing open, daemon just watches
  const child = spawn(process.execPath, [DAEMON, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  await waitForBanner(child);
  child.kill('SIGINT');
  const { code } = await Promise.race([
    exit,
    delay(8000).then(() => { throw new Error('daemon did not exit on SIGINT'); }),
  ]);
  assert.equal(code, 0, 'clean SIGINT teardown exits 0');
});

test('parent death → daemon self-exits via the ppid poll', async () => {
  const { dir } = tmpDoc();
  // Intermediate parent spawns the daemon and stays alive; it prints the daemon
  // pid so we can watch that exact process. Killing the parent orphans the daemon
  // (reparented to pid 1) — the ppid poll must notice and exit within ~2s.
  const parentSrc =
    `const {spawn}=require('child_process');` +
    `const c=spawn(process.execPath,[${JSON.stringify(DAEMON)},${JSON.stringify(dir)}],{stdio:'ignore'});` +
    `process.stdout.write(String(c.pid));` +
    `setInterval(()=>{},1<<30);`;
  const parent = spawn(process.execPath, ['-e', parentSrc], { stdio: ['ignore', 'pipe', 'ignore'] });

  let daemonPid;
  try {
    daemonPid = Number(
      await waitFor(
        () => new Promise((resolve) => {
          let s = '';
          parent.stdout.on('data', (d) => { s += d; if (s.trim()) resolve(s.trim()); });
        }),
        { label: 'daemon pid from parent' }
      )
    );
    assert.ok(daemonPid > 0 && alive(daemonPid), 'daemon started');
    await delay(500); // let the daemon install its ppid poll + watchers

    parent.kill('SIGKILL'); // GUI crash: no teardown signal reaches the daemon
    await waitFor(() => !alive(daemonPid), { timeout: 8000, label: 'orphaned daemon to self-exit' });
    assert.ok(!alive(daemonPid), 'daemon exited after its parent died');
  } finally {
    if (daemonPid && alive(daemonPid)) process.kill(daemonPid, 'SIGKILL');
    if (alive(parent.pid)) parent.kill('SIGKILL');
  }
});

// The live watcher, end to end: a comment written AFTER the daemon is already
// running can only be picked up by the runtime fs.watch(storeRoot()) registration
// (cli/watch.js) — the startup scan already ran with no store file present. A
// regression that breaks that registration (wrong dir, filename parsing, a coalesced
// event) would pass every router unit test above while the daemon silently goes deaf.
// The stub claude fails, so the observable outcome is the comment flipping to errored.
test('a store write while running triggers a live address run', async () => {
  const { root, md } = tmpTree(); // doc exists, but NO comment/store file yet
  const binDir = fakeClaudeBin();
  const child = spawn(process.execPath, [DAEMON, root], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
  });
  try {
    await waitForBanner(child); // watchers installed; startup scan saw an empty tree
    writeComments(md, [{ id: 'live1', quote: 'text', body: 'do a thing', status: 'open' }]);
    // 5s debounce + stub spawn; generous ceiling so a slow CI box doesn't flake.
    const errored = await waitFor(
      () => readComments(md).find((c) => c.id === 'live1' && c.status === 'errored'),
      { timeout: 20000, label: 'live comment picked up by the running daemon' }
    );
    assert.equal(errored.status, 'errored', 'daemon must react to a store write made after it began watching');
  } finally {
    child.kill('SIGKILL');
  }
});
