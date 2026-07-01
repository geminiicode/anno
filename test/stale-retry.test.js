const test = require('node:test');
const assert = require('node:assert/strict');

const { createStaleRetry } = require('../cli/stale-retry.js');

// Fake timer registry: set() returns an incrementing id and stores the cb;
// fire(id) invokes it; cleared ids can't fire. Lets us assert arm/cancel/
// supersede deterministically without real time (mirrors address-queue.test).
function fakeTimers() {
  const cbs = new Map();
  let nextId = 0;
  return {
    set: (fn) => { const id = ++nextId; cbs.set(id, fn); return id; },
    clear: (id) => { cbs.delete(id); },
    fire: (id) => { const fn = cbs.get(id); cbs.delete(id); fn(); },
    armed: () => cbs.size,
  };
}

test('reconcile arms a retry that re-enqueues once the marker goes stale', () => {
  const t = fakeTimers();
  const enqueued = [];
  const r = createStaleRetry({
    enqueue: (x) => enqueued.push(x),
    hasPending: () => true,
    delayMs: 1000, setTimer: t.set, clearTimer: t.clear,
  });
  r.reconcile('doc');
  assert.equal(r.pendingCount(), 1);
  assert.deepEqual(enqueued, []); // not yet — only after the timer fires
  t.fire(1);
  assert.deepEqual(enqueued, ['doc']);
  assert.equal(r.pendingCount(), 0); // timer consumed
});

test('reconcile cancels (does not arm) when no marker remains', () => {
  const t = fakeTimers();
  let pending = true;
  const r = createStaleRetry({
    enqueue: () => {}, hasPending: () => pending,
    delayMs: 1000, setTimer: t.set, clearTimer: t.clear,
  });
  r.reconcile('doc'); // marker present → armed
  assert.equal(r.pendingCount(), 1);
  pending = false;
  r.reconcile('doc'); // run succeeded, marker gone → cancelled
  assert.equal(r.pendingCount(), 0);
  assert.equal(t.armed(), 0);
});

test('repeated reconcile supersedes the prior timer (no stacking)', () => {
  const t = fakeTimers();
  const enqueued = [];
  const r = createStaleRetry({
    enqueue: (x) => enqueued.push(x), hasPending: () => true,
    delayMs: 1000, setTimer: t.set, clearTimer: t.clear,
  });
  r.reconcile('doc'); // id 1
  r.reconcile('doc'); // id 2; id 1 cleared
  assert.equal(t.armed(), 1);
  t.fire(2);
  assert.deepEqual(enqueued, ['doc']); // fires once, not twice
});

test('cancelAll clears every pending retry', () => {
  const t = fakeTimers();
  const r = createStaleRetry({
    enqueue: () => {}, hasPending: () => true,
    delayMs: 1000, setTimer: t.set, clearTimer: t.clear,
  });
  r.reconcile('a');
  r.reconcile('b');
  assert.equal(r.pendingCount(), 2);
  r.cancelAll();
  assert.equal(r.pendingCount(), 0);
  assert.equal(t.armed(), 0);
});
