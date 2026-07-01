const fs = require('fs');
const path = require('path');
const sidecar = require('../core/sidecar');
const { listMarkdownFiles, listDirs, pathInScope } = require('../core/fs-walk');
const { addressCore } = require('./address');
const { killActiveChild } = require('./claude');
const { createAddressQueue } = require('./address-queue');
const { createStaleRetry } = require('./stale-retry');

const DEBOUNCE_MS = 5000;

// Headless daemon can only warn; the confirm gate for huge folders is in the GUI.
const FILE_WARN_THRESHOLD = 2000;

function startTreeWatch(rootDir, recursive, onChange) {
  try {
    return [fs.watch(rootDir, { recursive }, (_e, filename) => onChange(rootDir, filename))];
  } catch (err) {
    if (!recursive || err.code !== 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') throw err;
    // recursive watch unsupported (Linux): watch each dir; skip unwatchable ones rather than abort
    console.log(
      "Recursive watch unavailable on this platform; watching each subdirectory " +
        "(new subdirectories won't be auto-watched)."
    );
    const dirs = listDirs(rootDir);
    const watchers = dirs
      .map((d) => {
        try {
          return fs.watch(d, (_e, filename) => onChange(d, filename));
        } catch (e) {
          console.error(`Could not watch ${d}: ${e.message}`);
          return null;
        }
      })
      .filter(Boolean);
    // inotify ENOSPC would otherwise stop auto-addressing part of the tree silently.
    if (watchers.length < dirs.length) {
      console.warn(
        `Only watching ${watchers.length}/${dirs.length} directories ` +
          '(raise fs.inotify.max_user_watches?); some files won\'t auto-address.'
      );
    }
    return watchers;
  }
}

function watch(target, { ownSigint = true } = {}) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) {
    console.error(`Path not found: ${target}`);
    process.exit(1);
  }
  const isDir = fs.statSync(abs).isDirectory();
  const watchDir = isDir ? abs : path.dirname(abs);

  let watchers = [];

  const queue = createAddressQueue({
    debounceMs: DEBOUNCE_MS,
    process: async (md) => {
      try {
        // addressCore's own write re-fires the watcher, but no open comments remain → no infinite loop
        const result = await addressCore(md);
        if (!result.skipped) {
          console.log(`Updated ${result.applied} comment(s) in ${path.basename(md)}. Editor will live-reload.`);
        }
      } finally {
        // Failed/partial run leaves a 👀 marker; arm a delayed re-check or it
        // strands (finally covers the throw path too). See createStaleRetry.
        retry.reconcile(md);
      }
    },
    onError: (md, err) => console.error(`address failed for ${path.basename(md)}:`, err.message),
    onIdle: () => console.log('Watching for new comments…'),
  });

  const retry = createStaleRetry({
    enqueue: (md) => queue.enqueue(md),
    // A leftover 👀 marker means the doc needs another pass once it goes stale.
    hasPending: (md) => {
      try {
        return sidecar.readComments(md).some((c) => c.working);
      } catch {
        return false; // unreadable/corrupt — nothing to retry
      }
    },
    // Past the stale window so isWorking() lets the comment back through the filter.
    delayMs: sidecar.WORKING_STALE_MS + 1000,
  });

  const close = () => {
    retry.cancelAll();
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
  };

  // never address a doc outside the watched tree, so this daemon can't end up
  // writing a file another agent also owns (the dual-writer footgun)
  function consider(baseDir, filename) {
    if (!filename) return;
    const md = sidecar.mdPathForSidecar(path.join(baseDir, filename));
    if (!md) return;
    const resolved = path.resolve(md);
    if (!isDir) {
      if (resolved !== abs) return;
    } else {
      if (!pathInScope(watchDir, resolved)) return;
      // pathInScope is textual — resolve the real path so a symlinked-out .md
      // can't smuggle in an out-of-tree write.
      try {
        const realRoot = fs.realpathSync(watchDir);
        if (!fs.realpathSync(resolved).startsWith(realRoot + path.sep)) return;
      } catch {
        return; // unresolvable → don't risk addressing it
      }
    }
    queue.enqueue(resolved);
  }

  const label = isDir ? `${path.basename(abs)}/` : path.basename(abs);
  console.log(`Watching ${label} for new comments (Ctrl-C to stop)…`);
  // review() owns SIGINT (tears down editor); don't add a second handler
  if (ownSigint) {
    process.on('SIGINT', () => {
      close();
      killActiveChild();
      process.exit(0);
    });
  }

  // A parent crash / kill -9 skips the SIGINT teardown and would orphan this
  // daemon — an agent still auto-editing with no window. Exit when reparented.
  const startPpid = process.ppid;
  const ppidPoll = setInterval(() => {
    if (process.ppid !== startPpid || process.ppid === 1) {
      close();
      killActiveChild();
      process.exit(0);
    }
  }, 2000);
  ppidPoll.unref(); // the poll alone shouldn't keep us alive

  try {
    watchers = startTreeWatch(watchDir, isDir, consider);
  } catch (err) {
    console.error('Failed to start watcher:', err.message);
    process.exit(1);
  }

  if (isDir) {
    const files = listMarkdownFiles(watchDir);
    console.log(`Scanning ${files.length} markdown file(s) for open comments…`);
    if (files.length > FILE_WARN_THRESHOLD) {
      console.warn(
        `Watching ${files.length} markdown files (> ${FILE_WARN_THRESHOLD}); ` +
          'large trees may address slowly.'
      );
    }
    for (const md of files) queue.enqueue(md);
  } else {
    queue.enqueue(abs);
  }

  return { close };
}

module.exports = { watch, listMarkdownFiles, FILE_WARN_THRESHOLD };
