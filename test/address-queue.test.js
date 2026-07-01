const test = require('node:test');
const assert = require('node:assert/strict');

const { createAddressQueue } = require('../cli/address-queue.js');

// A manual timer: schedule() captures the callback in `fire`; the test invokes
// it explicitly, so there's no real delay and ordering is deterministic.
function manualTimer() {
  let fire = null;
  return {
    set: (fn) => { fire = fn; return 1; },
    clear: () => { fire = null; },
    run: () => fire(),       // returns the (async) run() promise
    armed: () => fire !== null,
  };
}

test('queue dedups items scheduled before a run fires', async () => {
  const t = manualTimer();
  const seen = [];
  const q = createAddressQueue({
    process: async (x) => { seen.push(x); },
    debounceMs: 0, setTimer: t.set, clearTimer: t.clear,
  });
  q.enqueue('a');
  q.enqueue('a');
  await t.run();
  assert.deepEqual(seen, ['a']); // one entry, processed once
});

test('a change arriving mid-run is re-processed after the run finishes', async () => {
  const t = manualTimer();
  const seen = [];
  let release;
  const gate = new Promise((r) => { release = r; });

  const q = createAddressQueue({
    process: async (x) => {
      seen.push(x);
      if (x === 'a') await gate; // hold the run open while we enqueue 'b'
    },
    debounceMs: 0, setTimer: t.set, clearTimer: t.clear,
  });

  q.enqueue('a');
  const firstRun = t.run();        // starts processing 'a', now awaiting gate
  await Promise.resolve();         // let process('a') start
  q.enqueue('b');                  // lands mid-run → must re-arm
  assert.equal(q.isRunning(), true);
  release();
  await firstRun;                  // finishes 'a', finally re-schedules for 'b'
  assert.ok(t.armed(), 're-armed for the mid-run item');
  await t.run();                   // process 'b'
  assert.deepEqual(seen, ['a', 'b']);
});

// Exercises the REAL setTimeout/clearTimeout path (no injected timers): rapid
// duplicate enqueues must collapse into a single run. This catches a regression
// the manual-timer tests can't — e.g. dropping clearTimer(timer) would leak
// multiple live timers and run the item more than once.
test('real timers: rapid duplicate enqueues coalesce into one run', async () => {
  const seen = [];
  const q = createAddressQueue({
    process: async (x) => { seen.push(x); },
    debounceMs: 10,
  });
  q.enqueue('x');
  q.enqueue('x');
  q.enqueue('x');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen, ['x']); // debounced + deduped to a single run
});

test('an error in one item is reported and does not stop the batch', async () => {
  const t = manualTimer();
  const seen = [];
  const errors = [];
  const q = createAddressQueue({
    process: async (x) => {
      seen.push(x);
      if (x === 'bad') throw new Error('boom');
    },
    onError: (item, err) => errors.push([item, err.message]),
    debounceMs: 0, setTimer: t.set, clearTimer: t.clear,
  });
  q.enqueue('bad');
  q.enqueue('good');
  await t.run();
  assert.deepEqual(seen, ['bad', 'good']);     // both attempted
  assert.deepEqual(errors, [['bad', 'boom']]); // error surfaced, not thrown
});
