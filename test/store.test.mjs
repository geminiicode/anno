// The renderer store is ESM and talks to window.api; this stubs the bridge with
// an in-memory sidecar and exercises the action + persist-reconcile path that
// has no Electron coverage. (.mjs so node --test can import the ES module.)
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Stub the Electron preload bridge before importing the store.
let disk = { comments: [] };
globalThis.window = {
  api: {
    readComments: async () => JSON.parse(JSON.stringify(disk.comments)),
    writeComments: async (_p, comments) => { disk.comments = JSON.parse(JSON.stringify(comments)); },
  },
};

const store = await import('../renderer/store.js');
const tabsStore = await import('../renderer/tabs-store.js');
const { isWorking, WORKING_STALE_MS } = await import('../renderer/helpers.js');
const { createRequire } = await import('node:module');
const sidecar = createRequire(import.meta.url)('../core/sidecar.js');

// The store's `tabs` Map and lastWrittenJson are module-level process state that
// loadDoc seeds — clear it before every test so residue can't leak across them.
beforeEach(resetTabs);

// ---------- isWorking (renderer mirror of sidecar.js#isWorking) ----------

test('isWorking reads the marker with stale-expiry (renderer mirror)', () => {
  const since = '2026-01-01T00:00:00Z';
  const start = Date.parse(since);
  assert.equal(isWorking({}, start), false);
  assert.equal(isWorking({ working: true, workingSince: since }, start + 1000), true);
  // probe the real boundary so a constant change can't slip past this test
  assert.equal(isWorking({ working: true, workingSince: since }, start + WORKING_STALE_MS + 1), false);
  assert.equal(isWorking({ working: true }, start), true); // missing timestamp → trust flag
});

// The two mirrors must not drift — the "change both together" comments are
// otherwise unenforced (a one-sided edit would ship green).
test('renderer and CLI WORKING_STALE_MS stay in sync', () => {
  assert.equal(WORKING_STALE_MS, sidecar.WORKING_STALE_MS);
});

function reset() {
  disk = { comments: [] };
  store.loadDoc({ filePath: '/x/doc.md', rawText: '# hi', comments: [] });
}

test('loadDoc sets state without rendering (caller paints HTML first)', () => {
  reset();
  let renders = 0;
  const off = store.subscribe(() => { renders++; });
  store.loadDoc({ filePath: '/x/doc.md', rawText: '# hi', comments: [{ id: 'c1', body: 'b' }] });
  assert.equal(renders, 0);
  assert.equal(store.state.comments.length, 1);
  off();
});

test('addComment persists, clears pendingRange, renders once, writes no transient state', async () => {
  reset();
  let renders = 0;
  const off = store.subscribe(() => { renders++; });
  store.setPending({ quote: 'q' });
  await store.addComment({ id: 'c1', quote: 'q', body: 'b', status: 'open', replies: [] });
  assert.equal(renders, 1);
  assert.equal(disk.comments.length, 1);
  assert.equal(store.state.pendingRange, null);
  assert.ok(!('_orphaned' in disk.comments[0]));
  off();
});

test('an editor write injects no working field onto a comment that has none', async () => {
  // normalizeComment must not bake in a derived `working` field, or every save
  // writes working:false and breaks the byte-identical echo check.
  reset();
  await store.addComment({ id: 'c1', quote: 'q', body: 'b', status: 'open', replies: [] });
  assert.ok(!('working' in disk.comments[0]), 'no transient working key written');
});

test('an editor save round-trips a CLI-written 👀 marker (after reload)', async () => {
  reset();
  // loadDoc pulls the CLI's marker into state via the spread; a later unrelated
  // save must preserve it, not clobber it.
  store.loadDoc({
    filePath: '/x/doc.md',
    rawText: '# hi',
    comments: [
      { id: 'c1', quote: 'q', body: 'b', status: 'open', working: true, workingSince: '2026-01-01T00:00:00Z', replies: [] },
    ],
  });
  await store.addReply('c1', { author: 'Me', body: 'ok', createdAt: 't2', ai: false });
  assert.equal(disk.comments[0].working, true);
  assert.equal(disk.comments[0].workingSince, '2026-01-01T00:00:00Z');
});

test('persist imports the CLI\'s AI reply and keeps the local one (reconcile)', async () => {
  reset();
  await store.addComment({ id: 'c1', quote: 'q', body: 'b', status: 'open', replies: [] });
  // CLI wrote an AI reply to disk out from under us.
  disk.comments[0].replies = [{ author: 'Claude', body: 'done', createdAt: 't1', ai: true }];
  disk.comments[0].status = 'addressed';
  await store.addReply('c1', { author: 'Me', body: 'ok', createdAt: 't2', ai: false });
  const bodies = store.state.comments[0].replies.map((r) => r.body).sort();
  assert.deepEqual(bodies, ['done', 'ok']);
});

test('persist does not duplicate an already-imported reply', async () => {
  reset();
  await store.addComment({ id: 'c1', quote: 'q', body: 'b', status: 'open', replies: [] });
  disk.comments[0].replies = [{ author: 'Claude', body: 'done', createdAt: 't1', ai: true }];
  await store.addReply('c1', { author: 'Me', body: 'ok', createdAt: 't2', ai: false });
  await store.updateComment('c1', { status: 'resolved' }); // re-persist
  assert.equal(store.state.comments[0].replies.filter((r) => r.body === 'done').length, 1);
});

test('addReply re-opens an addressed thread on a human reply', async () => {
  reset();
  await store.addComment({ id: 'c1', quote: 'q', body: 'b', status: 'open', replies: [] });
  await store.updateComment('c1', { status: 'addressed' });
  await store.addReply('c1', { author: 'Me', body: 'no, shorter', createdAt: 't1', ai: false });
  assert.equal(store.state.comments[0].status, 'open');
  assert.equal(disk.comments[0].status, 'open'); // the re-open reaches disk → watcher re-arms
});

test('addReply keeps an addressed thread addressed when the reply is AI', async () => {
  reset();
  await store.addComment({ id: 'c1', quote: 'q', body: 'b', status: 'open', replies: [] });
  await store.updateComment('c1', { status: 'addressed' });
  await store.addReply('c1', { author: 'Claude', body: 'also did x', createdAt: 't1', ai: true });
  assert.equal(store.state.comments[0].status, 'addressed');
});

test('addReply does not re-open a resolved thread (reply is just a note)', async () => {
  reset();
  await store.addComment({ id: 'c1', quote: 'q', body: 'b', status: 'open', replies: [] });
  await store.updateComment('c1', { status: 'resolved' });
  await store.addReply('c1', { author: 'Me', body: 'one more note', createdAt: 't1', ai: false });
  assert.equal(store.state.comments[0].status, 'resolved');
});

test('isOwnEcho is true for our own write, false for a foreign one', async () => {
  reset();
  await store.addComment({ id: 'c1', quote: 'q', body: 'b', status: 'open', replies: [] });
  // Disk now holds exactly what we wrote → our own watcher echo.
  assert.equal(store.isOwnEcho(disk.comments), true);
  // A foreign write (CLI added a reply) must not be mistaken for an echo.
  const foreign = JSON.parse(JSON.stringify(disk.comments));
  foreign[0].replies.push({ author: 'Claude', body: 'edited', createdAt: 't', ai: true });
  assert.equal(store.isOwnEcho(foreign), false);
});

test('loadDoc clears the echo snapshot so a new file is not falsely suppressed', async () => {
  reset();
  await store.addComment({ id: 'c1', quote: 'q', body: 'b', status: 'open', replies: [] });
  const writtenForA = JSON.parse(JSON.stringify(disk.comments));
  store.loadDoc({ filePath: '/x/other.md', rawText: '# b', comments: [] });
  // Even if file B's sidecar serializes identically to A's last write, it must
  // not be treated as an echo after the switch.
  assert.equal(store.isOwnEcho(writtenForA), false);
});

test('setActiveIfPresent keeps a surviving id and drops a vanished one', () => {
  reset();
  store.loadDoc({ filePath: '/x/doc.md', rawText: '# hi', comments: [{ id: 'c1', body: 'b' }] });
  store.setActiveIfPresent('c1');
  assert.equal(store.state.activeId, 'c1');
  store.setActiveIfPresent('gone');
  assert.equal(store.state.activeId, null);
});

test('removeComment clears activeId when the active comment is deleted', async () => {
  reset();
  await store.addComment({ id: 'c1', quote: 'q', body: 'b', status: 'open', replies: [] });
  store.setActive('c1');
  await store.removeComment('c1');
  assert.equal(store.state.comments.length, 0);
  assert.equal(store.state.activeId, null);
  assert.equal(disk.comments.length, 0);
});

// ---------- tabs: multiple docs live in one window (tabs-store.js) ----------
// The Map is module state shared across tests, so clear it before each.
function resetTabs() {
  for (const p of tabsStore.tabPaths()) tabsStore.removeTab(p);
  disk = { comments: [] };
}

// openFile's gesture in two steps: load the doc into the singleton (core), then
// register it as its own tab (shell). Mirrors renderer/doc.js#openFile.
function openTab(filePath, fields) {
  store.loadDoc({ filePath, ...fields });
  tabsStore.saveActiveTab(0);
}

test('saveActiveTab registers the loaded doc; hasTab and tabPaths reflect the open set', () => {
  resetTabs();
  assert.equal(tabsStore.hasTab('/x/a.md'), false);
  store.loadDoc({ filePath: '/x/a.md', rawText: '# A', comments: [] });
  assert.equal(tabsStore.hasTab('/x/a.md'), false); // loadDoc alone doesn't track it
  tabsStore.saveActiveTab(0);
  assert.equal(tabsStore.hasTab('/x/a.md'), true);
  openTab('/x/b.md', { rawText: '# B', comments: [] });
  assert.deepEqual(tabsStore.tabPaths().sort(), ['/x/a.md', '/x/b.md']);
});

test('switchTab parks the active doc and restores another tab from memory', () => {
  resetTabs();
  store.loadDoc({ filePath: '/x/a.md', rawText: '# A', comments: [{ id: 'a1', body: 'x' }] });
  store.setActive('a1');
  tabsStore.saveActiveTab(40); // park A with its focus + scroll
  store.loadDoc({ filePath: '/x/b.md', rawText: '# B', comments: [{ id: 'b1', body: 'y' }] });
  store.setActive('b1');
  tabsStore.saveActiveTab(10);

  const slot = tabsStore.switchTab('/x/a.md');
  assert.equal(store.state.filePath, '/x/a.md');
  assert.equal(store.state.rawText, '# A');
  assert.equal(store.state.comments[0].id, 'a1');
  assert.equal(store.state.activeId, 'a1'); // focus survived the round-trip
  assert.equal(slot.scrollTop, 40); // so does scroll
});

test("switchTab restores each tab's own echo snapshot (isOwnEcho stays per-tab)", async () => {
  resetTabs();
  store.loadDoc({ filePath: '/x/a.md', rawText: '# A', comments: [] });
  await store.addComment({ id: 'a1', quote: 'q', body: 'b', status: 'open', replies: [] });
  const writtenA = JSON.parse(JSON.stringify(disk.comments));
  tabsStore.saveActiveTab(0);

  disk = { comments: [] }; // B has a different sidecar
  store.loadDoc({ filePath: '/x/b.md', rawText: '# B', comments: [] });
  await store.addComment({ id: 'b1', quote: 'q', body: 'b', status: 'open', replies: [] });
  tabsStore.saveActiveTab(0);

  // Back to A: A's own last write must still read as an echo, B's must not.
  tabsStore.switchTab('/x/a.md');
  assert.equal(store.isOwnEcho(writtenA), true);
  assert.equal(store.isOwnEcho(disk.comments), false);
});

test('patchTab updates a background tab without touching the active doc', () => {
  resetTabs();
  openTab('/x/a.md', { rawText: '# A', comments: [] });
  openTab('/x/b.md', { rawText: '# B', comments: [] }); // B active

  // A's agent rewrote it on disk while B is showing.
  tabsStore.patchTab('/x/a.md', { rawText: '# A edited', comments: [{ id: 'a9', body: 'new' }] });
  assert.equal(store.state.filePath, '/x/b.md'); // active untouched
  assert.equal(store.state.rawText, '# B');

  const slot = tabsStore.switchTab('/x/a.md'); // switching surfaces the patch
  assert.equal(slot.rawText, '# A edited');
  assert.equal(store.state.comments[0].id, 'a9');
});

test('removeTab clears the singleton for the active tab, keeps it for a background tab', () => {
  resetTabs();
  openTab('/x/a.md', { rawText: '# A', comments: [] });
  openTab('/x/b.md', { rawText: '# B', comments: [] }); // B active

  tabsStore.removeTab('/x/a.md'); // closing a background tab leaves the view as-is
  assert.equal(store.state.filePath, '/x/b.md');
  assert.deepEqual(tabsStore.tabPaths(), ['/x/b.md']);

  tabsStore.removeTab('/x/b.md'); // closing the active tab resets to empty
  assert.equal(store.state.filePath, null);
  assert.equal(store.state.rawText, null);
  assert.deepEqual(store.state.comments, []);
  assert.deepEqual(tabsStore.tabPaths(), []);
});
