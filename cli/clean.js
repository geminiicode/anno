const fs = require('fs');
const path = require('path');
const { storeRoot, storeDocOf, canonical, STORE_FILE_RE } = require('../core/paths');

// Reported, never deleted. A .corrupt is the user's only copy of comments the
// corrupt-file dialog promised were recoverable, and it's unparseable by
// definition — so it can't be scoped to <prefix>, and reaping it here would
// destroy another tree's backup.
const STORE_CORRUPT_RE = /^[0-9a-f]{64}\.json\.corrupt$/;

// Legacy co-located sidecars and their siblings: .<base>.comments.json plus
// .corrupt / .<pid>.tmp. Never read — v1 is unreadable litter (§4.5).
const LEGACY_RE = /\.comments\.json(\.corrupt|\.\d+\.tmp)?$/;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function underPrefix(docCanon, prefixCanon) {
  return docCanon === prefixCanon || docCanon.startsWith(prefixCanon + path.sep);
}

function remove(targets, force) {
  for (const t of targets) console.log(`${force ? 'removed' : 'would remove'} ${t}`);
  if (force) for (const t of targets) fs.rmSync(t, { force: true });
  if (targets.length === 0) console.log('Nothing to remove.');
  else if (!force) console.log(`\n${targets.length} item(s) — re-run with --force to remove.`);
}

// A missing doc means "not here right now" (branch switch, worktree, unmounted
// volume), NOT deleted — so this is prefix-scoped, dry-run by default, and never
// runs on its own (§4.4). Only entries whose doc canonicalizes under <prefix> are
// even considered, so a stat miss on some other tree's doc can't reap it.
function cleanStore(prefix, force) {
  const prefixCanon = canonical(path.resolve(prefix));
  const root = storeRoot();
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    console.log('Store is empty — nothing to remove.');
    return;
  }
  const targets = [];
  let corrupt = 0;
  for (const name of names) {
    const full = path.join(root, name);
    if (STORE_CORRUPT_RE.test(name)) {
      corrupt++;
      continue;
    }
    // A .<pid>.tmp is left alone: writeComments already replaces a stale one, and
    // removing a live writer's tmp fails its rename mid-flight.
    if (!STORE_FILE_RE.test(name)) continue;
    const doc = storeDocOf(name);
    if (!doc) continue; // unparseable entry: can't scope it, leave it alone
    if (!underPrefix(canonical(doc), prefixCanon)) continue;
    if (!fs.existsSync(doc)) targets.push(full); // doc is gone → orphan
  }
  remove(targets, force);
  if (corrupt) {
    console.log(`\n${corrupt} corrupt backup(s) in ${root} — each holds the comments of a doc that failed to parse. Delete by hand once recovered.`);
  }
}

// Direct readdir walk, not walkMarkdown: fs-walk's isSkipped drops dot-prefixed
// entries by design, and legacy sidecars ARE dot-prefixed — walkMarkdown would
// never see them. Dot-dirs / node_modules / symlinks are still not descended.
function collectLegacy(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      collectLegacy(full, out);
    } else if (LEGACY_RE.test(e.name)) {
      out.push(full);
    }
  }
}

function cleanLegacy(prefix, force) {
  const root = path.resolve(prefix);
  const targets = [];
  const st = (() => {
    try {
      return fs.statSync(root);
    } catch {
      return null;
    }
  })();
  if (st && st.isDirectory()) collectLegacy(root, targets);
  else if (st) {
    // a file prefix: only this doc's own sidecar and its siblings. Anchored, not a
    // substring match — `a.md` would otherwise also match `.ba.md.comments.json`.
    const own = new RegExp(`^\\.${escapeRe(path.basename(root))}\\.comments\\.json(\\.corrupt|\\.\\d+\\.tmp)?$`);
    for (const name of fs.readdirSync(path.dirname(root))) {
      if (own.test(name)) targets.push(path.join(path.dirname(root), name));
    }
  }
  remove(targets, force);
}

function usage() {
  console.error('Usage:');
  console.error('  anno clean <path> [--force]            Reap orphaned store entries under <path> (dry-run without --force)');
  console.error('  anno clean --legacy <path> [--force]   Sweep old co-located .comments.json litter under <path>');
}

function clean(args) {
  const force = args.includes('--force');
  const legacy = args.includes('--legacy');
  const prefix = args.find((a) => !a.startsWith('--'));
  // An explicit prefix is mandatory: a storewide sweep would reap another
  // branch's comments on a transient absence (§4.4).
  if (!prefix) {
    usage();
    process.exit(1);
  }
  if (legacy) cleanLegacy(prefix, force);
  else cleanStore(prefix, force);
}

module.exports = { clean };
