const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('node:crypto');

// Canonicalize so a file opened via two path strings (/tmp symlink vs its
// realpath) hashes to one store key. Raw-path fallback for files not yet on disk.
function canonical(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p; // not on disk yet
  }
}

// Asserted, not requested: mkdirSync's mode is umask-masked on create and no-ops
// on an existing dir, so an older anno (or an attacker) that made this 0o755
// leaves it wide open and the mode arg never fires. The stat is the actual guard.
// getuid is POSIX-only; anno ships macOS + Linux.
function assertStore(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const st = fs.statSync(root);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`anno store ${root} is owned by uid ${st.uid}, not ${process.getuid()} — refusing to use it.`);
  }
  if (st.mode & 0o077) {
    throw new Error(`anno store ${root} is group/other-accessible (mode ${(st.mode & 0o777).toString(8)}) — chmod 700 it.`);
  }
}

// Memoized per process: storePath() is called per watcher event and per comment
// read, and a path function must not mkdir on every call. A startup guard is what
// this is — a mid-session chmod is out of scope.
let checked = null;
function storeRoot() {
  const root = process.env.ANNO_STORE_DIR || path.join(os.homedir(), '.anno', 'store');
  if (checked !== root) {
    assertStore(root);
    checked = root;
  }
  return root;
}

function storePath(mdPath) {
  const hash = crypto.createHash('sha256').update(canonical(mdPath)).digest('hex');
  return path.join(storeRoot(), hash + '.json');
}

// Exact <sha256>.json — deliberately excludes <hash>.json.<pid>.tmp (valid JSON
// about to vanish) and <hash>.json.corrupt (already quarantined), which an
// unfiltered store watcher would parse and enqueue for a dead file (§4.3 rule 1).
const STORE_FILE_RE = /^[0-9a-f]{64}\.json$/;

// Read the `doc` reverse-mapping out of one store file; null on any read/parse
// failure. Never returns the comments — watcher routing must re-read those by the
// validated path, never trust this file's contents as the payload (§4.3 rule 3).
function storeDocOf(filename) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(storeRoot(), filename), 'utf8')).doc;
    return typeof doc === 'string' && doc ? doc : null;
  } catch {
    return null;
  }
}

// hash → doc index, seeded by scanning the store at startup. Unlink events carry
// no readable contents (empty-list delete removes the file), so this index is
// what routes a delete back to its document (§4.3 rule 2).
function seedStoreIndex() {
  const index = new Map();
  let names;
  try {
    names = fs.readdirSync(storeRoot());
  } catch {
    return index; // store not created yet
  }
  for (const name of names) {
    if (!STORE_FILE_RE.test(name)) continue;
    const doc = storeDocOf(name);
    if (doc) index.set(name.slice(0, 64), doc);
  }
  return index;
}

module.exports = { canonical, storeRoot, storePath, STORE_FILE_RE, storeDocOf, seedStoreIndex };
