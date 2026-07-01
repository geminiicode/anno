const path = require('path');

// Containment between two ALREADY-CANONICAL roots. The `+ path.sep` guard stops
// prefix false positives — /a/bc is NOT inside /a/b.
function covers(a, b) {
  return b === a || b.startsWith(a + path.sep);
}

// Electron-free for unit-testing; newRoot + existingRoots are pre-canonicalized.
function resolve(newRoot, newIsDir, existingRoots) {
  // Exact match wins over containment.
  for (const e of existingRoots) {
    if (e.root === newRoot) return { action: 'focus', root: e.root, selectFile: null };
  }
  for (const e of existingRoots) {
    if (e.isDir && covers(e.root, newRoot)) {
      return { action: 'focus', root: e.root, selectFile: newIsDir ? null : newRoot };
    }
  }
  // Absorb sub-FOLDER-tabs too, not just files: a sub-folder agent left open
  // beside its new parent would be a second daemon writing the same subtree's
  // sidecars (and non-atomic doc bodies) — the dual-writer footgun.
  if (newIsDir) {
    const absorbedFiles = existingRoots
      .filter((e) => e.root !== newRoot && covers(newRoot, e.root))
      .map((e) => e.root);
    if (absorbedFiles.length > 0) return { action: 'absorb', root: newRoot, absorbedFiles };
  }
  return { action: 'started', root: newRoot };
}

module.exports = { covers, resolve };
