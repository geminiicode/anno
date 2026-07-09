const fs = require('fs');
const { canonical, storePath } = require('./paths');

// Mirrored in helpers.js#normalizeComment (ESM, can't require this) — change both together.
function statusOf(c) {
  return c.status || (c.resolved ? 'resolved' : 'open');
}

// Stale after this: a crashed CLI would otherwise strand the marker, freezing
// 👀 and hiding the comment from the open-filter forever. Mirrored in
// helpers.js (ESM copy) — change both together.
const WORKING_STALE_MS = 5 * 60 * 1000;

function isWorking(c, now = Date.now()) {
  if (!c.working) return false;
  const since = Date.parse(c.workingSince);
  if (Number.isNaN(since)) return true; // marked without a usable timestamp — trust it
  return now - since < WORKING_STALE_MS;
}

function sidecarPath(mdPath) {
  return storePath(mdPath);
}

const corruptBackedUp = new Set();

class CorruptSidecarError extends Error {
  constructor(p) {
    super(`Sidecar ${p} is not valid JSON. A backup was saved to ${p}.corrupt — fix or remove the original, then retry.`);
    this.name = 'CorruptSidecarError';
    this.path = p;
  }
}

// Corrupt JSON must NOT read as empty — the next write would discard every
// comment — so back up to <path>.corrupt and throw instead.
function readComments(mdPath) {
  const p = sidecarPath(mdPath);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // Once per path: a store event routes back here on every watcher fire, and a
    // permanently-broken file would otherwise rewrite its backup on each one.
    if (!corruptBackedUp.has(p)) {
      corruptBackedUp.add(p);
      try {
        fs.copyFileSync(p, p + '.corrupt');
      } catch {
        /* backup is best-effort */
      }
    }
    throw new CorruptSidecarError(p);
  }
  corruptBackedUp.delete(p); // parsed clean — a later re-corruption gets its own backup
  return Array.isArray(data.comments) ? data.comments : [];
}

// tmp + atomic rename so a crash mid-write can't truncate the live sidecar. Pid
// in the tmp name: GUI and watch daemon both write the same sidecar, and a shared
// tmp name would let one writer's rename pull the file from under the other → ENOENT.
// Empty list unlinks rather than leaving a husk; readComments treats missing as [],
// so this is behavior-neutral. Delete-event routing is the watcher index's job (§4.3).
function writeComments(mdPath, comments) {
  const p = sidecarPath(mdPath);
  if (comments.length === 0) {
    fs.rmSync(p, { force: true });
    return;
  }
  const tmp = `${p}.${process.pid}.tmp`;
  // doc is a stored reverse mapping (sha256 isn't invertible) — load-bearing for
  // watcher routing and anno clean.
  const data = JSON.stringify({ version: 2, doc: canonical(mdPath), comments }, null, 2);
  // 'wx' won't follow a pre-planted tmp symlink; a stale tmp is ours (pid-scoped)
  // from a crashed write, so it's safe to replace.
  try {
    fs.writeFileSync(tmp, data, { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, data, { encoding: 'utf8', flag: 'wx' });
  }
  fs.renameSync(tmp, p);
}

module.exports = {
  statusOf,
  isWorking,
  WORKING_STALE_MS,
  sidecarPath,
  readComments,
  writeComments,
  CorruptSidecarError,
};
