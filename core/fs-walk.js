const fs = require('fs');
const path = require('path');
const { MD_RE } = require('./markdown-ext');

const MAX_DEPTH = 6;

// Never descend symlinks — could point outside the tree.
function isSkipped(entry) {
  return entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink();
}

function walkMarkdown(dir, { onDir, onFile } = {}, depth = 0) {
  if (depth > MAX_DEPTH) return;
  if (onDir) onDir(dir);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (isSkipped(e)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMarkdown(full, { onDir, onFile }, depth + 1);
    else if (onFile && MD_RE.test(e.name)) onFile(full);
  }
}

function listMarkdownFiles(dir) {
  const out = [];
  walkMarkdown(dir, { onFile: (f) => out.push(f) });
  return out;
}

function listDirs(dir) {
  const out = [];
  walkMarkdown(dir, { onDir: (d) => out.push(d) });
  return out;
}

function pathInScope(root, full) {
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const segs = rel.split(path.sep);
  if (segs.length - 1 > MAX_DEPTH) return false;
  return !segs.slice(0, -1).some((s) => s.startsWith('.') || s === 'node_modules');
}

module.exports = { listMarkdownFiles, listDirs, pathInScope, MAX_DEPTH };
