const fs = require('fs');
const path = require('path');
const sidecar = require('../core/sidecar');
const { listMarkdownFiles, listDirs, pathInScope } = require('../core/fs-walk');
const { addressCore, errorStrandedWorking } = require('./address');
const { killActiveChild } = require('./claude');
const { createAddressQueue } = require('./address-queue');
const { createStaleRetry } = require('./stale-retry');

const DEBOUNCE_MS = 5000;

// Headless daemon can only warn; the confirm gate for huge folders is in the GUI.
const FILE_WARN_THRESHOLD = 2000;

// cap so a huge tree can't bloat every prompt with the folder map
const MANIFEST_CAP = 300;

// 4KB prefix only — a title past that is fine to miss; a # inside a code fence is not a title
function firstHeading(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    let fenced = false;
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
      const m = line.match(/^#\s+(.+)$/);
      if (m) return m[1].trim();
    }
    return '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// buildManifest runs every debounce batch just to detect change; without this
// cache that's up to MANIFEST_CAP open+reads per batch on an active tab.
const titleCache = new Map();
function cachedTitle(file) {
  try {
    const st = fs.statSync(file);
    const hit = titleCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.title;
    const title = firstHeading(file);
    titleCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, title });
    return title;
  } catch {
    return '';
  }
}

function buildManifest(files) {
  const live = new Set(files);
  for (const k of titleCache.keys()) if (!live.has(k)) titleCache.delete(k);
  return files.slice(0, MANIFEST_CAP).map((f) => ({ path: f, title: cachedTitle(f) }));
}

// Extracted from the queue callback so the { session, sentManifest } bookkeeping
// (regresses silently if wrong) is unit-testable with a fake addressCore.
async function runBatch(md, { session, sentManifest }, deps) {
  const { addressCore, listMarkdownFiles, buildManifest, watchDir, sessionName, isDir } = deps;
  // uncapped file list: the manifest is capped, but the liveFiles prune must see
  // every file or watermarks past MANIFEST_CAP leak
  const files = isDir ? listMarkdownFiles(watchDir) : null;
  const manifest = files ? buildManifest(files) : null;
  // JSON per entry: a raw `path\ttitle` join would let a tab in a title collide two
  // different maps into one signature and suppress a re-send
  const manifestSig = manifest && manifest.map((e) => JSON.stringify([e.path, e.title])).join('\n');
  const freshMap = manifest && (session === null || manifestSig !== sentManifest);
  const priorId = session ? session.id : null;

  // addressCore's own write re-fires the watcher, but no open comments remain → no infinite loop
  let result = await addressCore(md, { session, cwd: watchDir, manifest: freshMap ? manifest : null, sessionName, liveFiles: files });
  let sentThisRun = freshMap;
  if (result.resumeMiss) {
    result = await addressCore(md, { session: null, cwd: watchDir, manifest, sessionName, liveFiles: files });
    sentThisRun = Boolean(manifest);
  }
  // errored/parse-fail drop the WHOLE tab's session and watermarks — the failed
  // conversation may be mid-edit-confused; no other doc should inherit it.
  session = result.session || null;
  const rotated = session && priorId && session.id !== priorId;
  // A rotated session_id may be a fresh fork; re-send the map next batch (harmless
  // over-send). Only record a sig as sent when a run actually carried it — a skipped
  // pass never spawned claude, and marking its sig sent would hide a new file forever.
  if (rotated) sentManifest = null;
  else if (sentThisRun && !result.skipped) sentManifest = manifestSig;
  return { session, sentManifest, result };
}

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
  const label = isDir ? `${path.basename(abs)}/` : path.basename(abs);
  const sessionName = `anno: ${label}`;

  let watchers = [];

  // One warm session per tab, shared across the folder's files; memory-only, dies with
  // the daemon. Shared context means a prompt-injecting comment in one file can steer
  // the others (see the trust model in claude.js).
  let session = null;
  let sentManifest = null;

  const queue = createAddressQueue({
    debounceMs: DEBOUNCE_MS,
    process: async (md) => {
      try {
        const next = await runBatch(md, { session, sentManifest }, {
          addressCore, listMarkdownFiles, buildManifest, watchDir, sessionName, isDir,
        });
        session = next.session;
        sentManifest = next.sentManifest;
        const result = next.result;
        if (result.errored) {
          console.error(`${result.errored} comment(s) errored in ${path.basename(md)} — needs a human (reopen to retry).`);
        } else if (typeof result.applied === 'number' && !result.skipped) {
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
    let stranded = 0;
    for (const md of files) {
      stranded += errorStrandedWorking(md);
      queue.enqueue(md);
    }
    if (stranded) {
      console.warn(
        `${stranded} comment(s) were mid-run when a previous watcher stopped — ` +
          'marked errored (reopen them to retry).'
      );
    }
  } else {
    const stranded = errorStrandedWorking(abs);
    if (stranded) {
      console.warn(
        `${stranded} comment(s) were mid-run when a previous watcher stopped — ` +
          'marked errored (reopen them to retry).'
      );
    }
    queue.enqueue(abs);
  }

  return { close };
}

module.exports = {
  watch,
  listMarkdownFiles,
  FILE_WARN_THRESHOLD,
  runBatch,
  buildManifest,
  cachedTitle,
  firstHeading,
  titleCache,
  MANIFEST_CAP,
};
