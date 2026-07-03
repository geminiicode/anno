// Flow 4 (e2e) + Flow 7: the watch-daemon's process lifecycle, exercised by
// spawning the real cli/watch-daemon.js — the guarantees that keep a headless
// agent from running with no window:
//   - startup sweeps a stranded 👀 marker to `errored` (no double-apply)
//   - SIGINT (clean window close) tears down and exits 0
//   - parent death (GUI crash / kill -9) → self-exit via the ppid poll
// No claude/GUI needed: the sweep fixture has no OPEN comment, so no batch ever
// spawns the agent.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeComments, readComments } = require('../core/sidecar.js');

const DAEMON = path.join(__dirname, '..', 'cli', 'watch-daemon.js');

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
