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

// mkdir's mode is umask-masked and no-ops on an existing dir, so the mode arg can't
// be trusted — the stat below is the real guard. getuid is POSIX-only (macOS + Linux).
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

// Memoized: storePath() runs per watcher event and per read, so it must not mkdir
// every call. Startup guard only — a mid-session chmod is out of scope.
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

// Exact <sha256>.json — excludes the .<pid>.tmp (about to vanish) and .corrupt
// (quarantined) siblings a watcher would otherwise enqueue for a dead file.
const STORE_FILE_RE = /^[0-9a-f]{64}\.json$/;

// The `doc` reverse-mapping only; null on any failure. Never returns the comments —
// routing must re-read those by the validated path, not trust this file's payload.
function storeDocOf(filename) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(storeRoot(), filename), 'utf8')).doc;
    return typeof doc === 'string' && doc ? doc : null;
  } catch {
    return null;
  }
}

// hash → doc index for routing unlinks: a delete removes the file, so its contents
// are gone and only this seeded mapping can point the event back at its document.
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
