const fs = require('fs');
const path = require('path');
const { pathInScope } = require('./fs-walk');
const { storeDocOf, STORE_FILE_RE } = require('./paths');

// The ONLY thing keeping the daemon from addressing a doc outside the watched tree:
// the trigger is now a `doc` string in a global store file, not a sidecar physically
// in the tree. A refactor MUST NOT drop the realpathSync check — it's the last guard.
function inScope({ isDir, abs, watchDir }, resolved) {
  if (!isDir) return resolved === abs;
  if (!pathInScope(watchDir, resolved)) return false;
  // pathInScope is textual — resolve the real path so a symlinked-out .md can't
  // smuggle in an out-of-tree write.
  try {
    const realRoot = fs.realpathSync(watchDir);
    return fs.realpathSync(resolved).startsWith(realRoot + path.sep);
  } catch {
    return false; // unresolvable → don't risk addressing it
  }
}

// Shared by the CLI daemon and the GUI folder watch so both route through the same
// strict guard.
function createStoreRouter({ enqueue, isDir, abs, watchDir, index }) {
  return function routeStoreEvent(filename) {
    if (!filename || !STORE_FILE_RE.test(filename)) return; // skip .tmp/.corrupt
    const hash = filename.slice(0, 64);
    let doc = storeDocOf(filename);
    let unlinked = false;
    if (!doc) {
      doc = index.get(hash); // unreadable = an empty-list delete (unlink); route via index
      if (!doc) return; // unknown hash + unreadable file → drop, not an error
      unlinked = true;
    }
    const resolved = path.resolve(doc);
    if (!inScope({ isDir, abs, watchDir }, resolved)) {
      // Global store: every window's writes reach us. Never index an out-of-scope
      // doc; on its unlink, evict any entry left from before this gating.
      if (unlinked) index.delete(hash);
      return;
    }
    // Unlink: drop the entry before returning, or a stray second unlink re-routes to
    // a gone doc. Create/change: keep it warm so the doc's eventual unlink routes.
    if (unlinked) index.delete(hash);
    else index.set(hash, doc);
    // Enqueue the validated PATH only — addressCore re-reads by re-hashing it. Never
    // reuse storeDocOf's parsed object, or a crafted file could pass the scope check
    // on `doc` while smuggling comments through its own contents.
    enqueue(resolved);
  };
}

module.exports = { inScope, createStoreRouter };
