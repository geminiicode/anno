const fs = require('fs');
const path = require('path');
const { pathInScope } = require('./fs-walk');
const { storeDocOf, STORE_FILE_RE } = require('./paths');

// The scope guard — now the ONLY thing keeping the daemon from addressing a doc
// outside the watched tree. The trigger used to be a sidecar physically inside the
// tree; it's now a `doc` string in a global store file, so this is no longer
// backed by filesystem placement (§5). A future refactor MUST NOT "simplify away"
// the realpathSync containment check below — it is the last guard, not a redundant one.
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

// Store-watcher router shared by the CLI daemon and the GUI's folder watch, so both
// route store events through the same strict guard (inScope's realpathSync
// containment). Exported so the guard is unit-testable against a mock { enqueue }.
function createStoreRouter({ enqueue, isDir, abs, watchDir, index }) {
  return function routeStoreEvent(filename) {
    if (!filename || !STORE_FILE_RE.test(filename)) return; // §4.3 rule 1: skip .tmp/.corrupt
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
      // Never index an out-of-scope doc (the store is global — every window's writes
      // reach us), and if this was its unlink, evict any entry that predates the gating.
      if (unlinked) index.delete(hash);
      return;
    }
    // File is gone; drop the entry BEFORE returning, or a stray second unlink for this
    // hash would re-route to a doc whose store no longer exists. On create/change, keep
    // the index warm (§4.3 rule 2) so that doc's eventual unlink can still be routed.
    if (unlinked) index.delete(hash);
    else index.set(hash, doc);
    // §4.3 rule 3: enqueue the validated path ONLY. addressCore re-reads via
    // readComments(resolved), which re-hashes the path to its store file. Do NOT
    // reuse the object storeDocOf parsed — that would let a crafted file pass the
    // scope check with `doc` while smuggling comments in through its own contents.
    enqueue(resolved);
  };
}

module.exports = { inScope, createStoreRouter };
