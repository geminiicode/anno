// A failed/partial address leaves a 👀 marker that excludes the comment from the
// next watcher pass until it goes stale — and nothing else re-fires the watcher,
// so it would strand until an unrelated edit. After each pass reconcile(item)
// arms a timer to re-enqueue once the marker is stale, or cancels if none remains.
// Timers injectable for testing (mirrors createAddressQueue).
function createStaleRetry({
  enqueue,
  hasPending,
  delayMs,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const timers = new Map();

  function cancel(item) {
    const t = timers.get(item);
    if (t !== undefined) {
      clearTimer(t);
      timers.delete(item);
    }
  }

  return {
    // Arm a retry iff a marker remains, else cancel any pending one. Supersedes
    // the prior timer so repeated passes reset the window rather than stacking.
    reconcile(item) {
      cancel(item);
      if (!hasPending(item)) return;
      const t = setTimer(() => {
        timers.delete(item);
        enqueue(item);
      }, delayMs);
      // Don't keep the process alive just for a pending retry.
      if (t && typeof t.unref === 'function') t.unref();
      timers.set(item, t);
    },
    cancel,
    cancelAll() {
      for (const t of timers.values()) clearTimer(t);
      timers.clear();
    },
    pendingCount: () => timers.size,
  };
}

module.exports = { createStaleRetry };
