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
    if (doc) {
      index.set(hash, doc); // §4.3 rule 2: keep the index warm for a later unlink
    } else {
      doc = index.get(hash); // unreadable = an empty-list delete (unlink); route via index
      if (!doc) return; // unknown hash + unreadable file → drop, not an error
      unlinked = true;
    }
    const resolved = path.resolve(doc);
    if (!inScope({ isDir, abs, watchDir }, resolved)) return;
    // §4.3 rule 3: enqueue the validated path ONLY. addressCore re-reads via
    // readComments(resolved), which re-hashes the path to its store file. Do NOT
    // reuse the object storeDocOf parsed — that would let a crafted file pass the
    // scope check with `doc` while smuggling comments in through its own contents.
    enqueue(resolved);
    // File is gone; drop the entry or a stray second unlink for this hash would
    // re-route to a doc whose store no longer exists. Unlink path only — a
    // create/change re-set it above and its file is still there.
    if (unlinked) index.delete(hash);
  };
}

module.exports = { inScope, createStoreRouter };
