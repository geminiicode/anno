// Pins runBatch's { session, sentManifest } bookkeeping (regresses silently) with a
// fake addressCore; plus unit tests for the manifest/title helpers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  runBatch,
  buildManifest,
  cachedTitle,
  firstHeading,
  titleCache,
  MANIFEST_CAP,
} = require('../cli/watch.js');

const MANIFEST = [{ path: '/w/a.md', title: 'A' }, { path: '/w/b.md', title: 'B' }];
const sig = (m) => m.map((e) => JSON.stringify([e.path, e.title])).join('\n');

function fakeCore(results) {
  let i = 0;
  const calls = [];
  const fn = async (md, opts) => {
    calls.push({ md, opts });
    return results[Math.min(i++, results.length - 1)];
  };
  fn.calls = calls;
  return fn;
}

function deps(core, over = {}) {
  return {
    addressCore: core,
    listMarkdownFiles: () => ['/w/a.md', '/w/b.md'],
    buildManifest: () => MANIFEST,
    watchDir: '/w',
    sessionName: 'anno: w/',
    isDir: true,
    ...over,
  };
}

const warm = (id) => ({ id, seen: new Map() });

test('runBatch: cold run carries the manifest and records it as sent', async () => {
  const core = fakeCore([{ session: warm('s1'), applied: 1 }]);
  const out = await runBatch('/w/a.md', { session: null, sentManifest: null }, deps(core));

  assert.deepEqual(core.calls[0].opts.manifest, MANIFEST, 'manifest carried cold');
  assert.deepEqual(core.calls[0].opts.liveFiles, ['/w/a.md', '/w/b.md'], 'full file list for the prune');
  assert.equal(out.session.id, 's1');
  assert.equal(out.sentManifest, sig(MANIFEST));
});

test('runBatch: warm run with an UNCHANGED manifest does not re-send it', async () => {
  const core = fakeCore([{ session: warm('s1'), applied: 0 }]);
  const out = await runBatch('/w/a.md', { session: warm('s1'), sentManifest: sig(MANIFEST) }, deps(core));

  assert.equal(core.calls[0].opts.manifest, null, 'unchanged map not re-sent (warm-session win)');
  assert.equal(out.sentManifest, sig(MANIFEST), 'recorded sig unchanged');
});

test('runBatch: a CHANGED manifest is re-sent and the new sig recorded', async () => {
  const core = fakeCore([{ session: warm('s1'), applied: 0 }]);
  const out = await runBatch('/w/a.md', { session: warm('s1'), sentManifest: 'stale-sig' }, deps(core));

  assert.deepEqual(core.calls[0].opts.manifest, MANIFEST, 'changed map re-sent');
  assert.equal(out.sentManifest, sig(MANIFEST));
});

test('runBatch: a SKIPPED pass keeps the warm session and does not record the manifest', async () => {
  // real addressCore echoes the PASSED session on an empty batch, so the warm session
  // survives an idle debounce; marking a skipped sig as sent would hide a new file forever
  const s = warm('s1');
  const core = fakeCore([{ skipped: true, session: s }]);
  const out = await runBatch('/w/a.md', { session: s, sentManifest: 'sig-x' }, deps(core));

  assert.equal(out.session, s, 'warm session preserved across a skipped batch');
  assert.equal(out.sentManifest, 'sig-x', 'skipped run leaves sentManifest untouched');
});

test('runBatch: a resume-miss retries cold with the full manifest', async () => {
  const core = fakeCore([
    { resumeMiss: true, session: null },
    { session: warm('s2'), applied: 1 },
  ]);
  const out = await runBatch('/w/a.md', { session: warm('s1'), sentManifest: 'x' }, deps(core));

  assert.equal(core.calls.length, 2, 'retried once');
  assert.equal(core.calls[1].opts.session, null, 'retry is cold');
  assert.deepEqual(core.calls[1].opts.manifest, MANIFEST, 'full map on the cold retry');
  assert.equal(out.session.id, 's2');
  assert.equal(out.sentManifest, null);
});

test('runBatch: a rotated session_id forces a manifest re-send next batch', async () => {
  const core = fakeCore([{ session: warm('s2'), applied: 1 }]);
  const out = await runBatch('/w/a.md', { session: warm('s1'), sentManifest: sig(MANIFEST) }, deps(core));

  assert.equal(out.session.id, 's2');
  assert.equal(out.sentManifest, null, 'rotation resets sentManifest');
});

test('runBatch: a single-file tab sends no folder map', async () => {
  const core = fakeCore([{ session: warm('s1'), applied: 1 }]);
  const out = await runBatch('/w/a.md', { session: null, sentManifest: null }, deps(core, { isDir: false }));

  assert.equal(core.calls[0].opts.manifest, null, 'no map for a single-file tab');
  assert.equal(core.calls[0].opts.liveFiles, null);
  assert.equal(out.sentManifest, null);
});

function tmpFile(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anno-watch-'));
  const f = path.join(dir, 'doc.md');
  fs.writeFileSync(f, body);
  return f;
}

test('firstHeading: first ATX h1, ignoring headings inside code fences', () => {
  assert.equal(firstHeading(tmpFile('# Real Title\n\nbody')), 'Real Title');
  assert.equal(firstHeading(tmpFile('```\n# not a title\n```\n# Actual\n')), 'Actual');
  assert.equal(firstHeading(tmpFile('~~~\n# fenced\n~~~\n# After\n')), 'After');
  assert.equal(firstHeading(tmpFile('no heading at all\n')), '');
});

test('cachedTitle: caches by mtime+size, re-reads when the file changes', () => {
  titleCache.clear();
  const f = tmpFile('# One\n');
  assert.equal(cachedTitle(f), 'One');
  assert.ok(titleCache.has(f), 'populated the cache');
  fs.writeFileSync(f, '# Two Changed\n'); // different size ⇒ cache miss
  assert.equal(cachedTitle(f), 'Two Changed');
});

test('cachedTitle: a same-size edit still busts the cache via mtime', () => {
  titleCache.clear();
  const f = tmpFile('# One\n');
  assert.equal(cachedTitle(f), 'One');
  fs.writeFileSync(f, '# Two\n'); // same byte length as '# One\n' — only mtime differs
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(f, later, later); // force a distinct mtime past coarse fs resolution
  assert.equal(cachedTitle(f), 'Two', 'mtime change alone invalidates');
});

test('buildManifest: caps at MANIFEST_CAP and prunes cache for deleted files', () => {
  titleCache.clear();
  const many = Array.from({ length: MANIFEST_CAP + 5 }, (_, i) => `/no/such/f${i}.md`);
  assert.equal(buildManifest(many).length, MANIFEST_CAP, 'sliced to the cap');

  titleCache.clear();
  const a = tmpFile('# A\n');
  const b = tmpFile('# B\n');
  buildManifest([a, b]);
  assert.ok(titleCache.has(a) && titleCache.has(b), 'both cached');
  buildManifest([a]); // b no longer in the tree
  assert.ok(titleCache.has(a) && !titleCache.has(b), 'deleted file pruned from the cache');
});
