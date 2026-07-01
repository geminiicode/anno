// Timer fns are injectable so the debounce + re-arm semantics are unit-testable
// without real timers or fs.watch.
function createAddressQueue({
  process: processItem,
  debounceMs,
  onError,
  onIdle,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const pending = new Set();
  let timer = null;
  let running = false;

  async function run() {
    if (running) return;
    running = true;
    const batch = [...pending];
    pending.clear();
    try {
      for (const item of batch) {
        try {
          await processItem(item);
        } catch (err) {
          if (onError) onError(item, err);
        }
      }
    } finally {
      running = false;
      if (onIdle) onIdle();
      // change landed mid-run is still in `pending` → re-schedule or it's dropped
      if (pending.size) schedule();
    }
  }

  function schedule() {
    clearTimer(timer);
    timer = setTimer(run, debounceMs);
  }

  return {
    enqueue(item) {
      pending.add(item);
      schedule();
    },
    pendingSize: () => pending.size,
    isRunning: () => running,
  };
}

module.exports = { createAddressQueue };
