// tabs-store.js in isolation: the file/folder slot model, activeRoot tracking, and
// the per-file park/hydrate round-trip that lets one folder-tab hold many docs
// while the singleton `state` only ever holds the selected one. (.mjs for ESM.)
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// store.js reaches window.api lazily (persist/readComments) — stub the bridge.
let disk = { comments: [] };
globalThis.window = {
  api: {
    readComments: async () => JSON.parse(JSON.stringify(disk.comments)),
    writeComments: async (_p, c) => { disk.comments = JSON.parse(JSON.stringify(c)); },
  },
};

const store = await import('../renderer/store.js');
const tabsStore = await import('../renderer/tabs-store.js');

beforeEach(() => {
  for (const p of tabsStore.tabPaths()) tabsStore.removeTab(p);
  disk = { comments: [] };
});

// A doc record shaped like what doc.js#selectFile caches into a folder slot.
function rec(rawText, comments = [], scrollTop = 0) {
  return { rawText, comments, activeId: null, lastWrittenJson: null, scrollTop };
}

test('saveActiveTab registers a FILE tab and sets activeRoot', () => {
  store.loadDoc({ filePath: '/a.md', rawText: '# A', comments: [] });
  tabsStore.saveActiveTab(0);
  assert.equal(tabsStore.tabKind('/a.md'), 'file');
  assert.equal(tabsStore.activeRoot, '/a.md');
  assert.equal(tabsStore.peekTab('/a.md').root, '/a.md');
});

test('createFolderTab is active with an empty singleton and no selection', () => {
  store.loadDoc({ filePath: '/a.md', rawText: '# A', comments: [] });
  tabsStore.saveActiveTab(0);
  tabsStore.createFolderTab('/dir', ['/dir/a.md', '/dir/b.md']);
  assert.equal(tabsStore.tabKind('/dir'), 'folder');
  assert.equal(tabsStore.activeRoot, '/dir');
  assert.equal(store.state.filePath, null, 'empty pane — singleton cleared');
  const slot = tabsStore.peekTab('/dir');
  assert.equal(slot.selectedFile, null);
  assert.equal(slot.docs.size, 0);
  assert.deepEqual(slot.files, ['/dir/a.md', '/dir/b.md']);
});

test('folder park/hydrate round-trips per-file docs through slot.docs', () => {
  tabsStore.createFolderTab('/dir', ['/dir/a.md', '/dir/b.md']);
  const slot = tabsStore.peekTab('/dir');

  // Select + edit A.
  slot.selectedFile = '/dir/a.md';
  store.hydrate('/dir/a.md', rec('# A', [{ id: 'a1', body: 'x' }]));
  store.setActive('a1');
  tabsStore.parkActive(30); // A parked into docs

  // Select + edit B.
  slot.selectedFile = '/dir/b.md';
  store.hydrate('/dir/b.md', rec('# B', [{ id: 'b1', body: 'y' }]));
  tabsStore.parkActive(10);

  assert.equal(slot.docs.size, 2);
  // Re-select A via the store helper — its edits/focus/scroll survived.
  const back = tabsStore.selectFileInTab('/dir', '/dir/a.md');
  assert.equal(store.state.filePath, '/dir/a.md');
  assert.equal(store.state.rawText, '# A');
  assert.equal(store.state.comments[0].id, 'a1');
  assert.equal(store.state.activeId, 'a1');
  assert.equal(back.scrollTop, 30);
});

test('switchTab restores a folder-tab to its selected file (or empty pane)', () => {
  // Empty folder-tab → switching to it clears the singleton.
  tabsStore.createFolderTab('/dir', ['/dir/a.md']);
  store.loadDoc({ filePath: '/x.md', rawText: '# X', comments: [] });
  tabsStore.saveActiveTab(0); // a file-tab now active
  tabsStore.parkActive(0);

  const slot = tabsStore.switchTab('/dir'); // back to the empty folder-tab
  assert.equal(slot.kind, 'folder');
  assert.equal(tabsStore.activeRoot, '/dir');
  assert.equal(store.state.filePath, null, 'no selection → empty singleton');

  // Give it a selection, switch away, switch back → restores that file.
  tabsStore.setDoc('/dir', '/dir/a.md', rec('# A'));
  tabsStore.selectFileInTab('/dir', '/dir/a.md');
  tabsStore.parkActive(0);
  tabsStore.switchTab('/x.md');
  assert.equal(store.state.filePath, '/x.md');
  tabsStore.switchTab('/dir');
  assert.equal(store.state.filePath, '/dir/a.md');
  assert.equal(store.state.rawText, '# A');
});

test('peekDoc resolves a file slot vs a folder docs entry', () => {
  store.loadDoc({ filePath: '/a.md', rawText: '# A', comments: [] });
  tabsStore.saveActiveTab(0);
  assert.equal(tabsStore.peekDoc('/a.md', '/a.md').rawText, '# A'); // file slot is its own record

  tabsStore.createFolderTab('/dir', ['/dir/a.md']);
  assert.equal(tabsStore.peekDoc('/dir', '/dir/a.md'), null, 'unloaded folder file → null');
  tabsStore.setDoc('/dir', '/dir/a.md', rec('# DA'));
  assert.equal(tabsStore.peekDoc('/dir', '/dir/a.md').rawText, '# DA');
});

test('patchDoc patches a folder docs entry without disturbing others', () => {
  tabsStore.createFolderTab('/dir', ['/dir/a.md', '/dir/b.md']);
  tabsStore.setDoc('/dir', '/dir/a.md', rec('# A'));
  tabsStore.setDoc('/dir', '/dir/b.md', rec('# B'));
  tabsStore.patchDoc('/dir', '/dir/a.md', { rawText: '# A edited', pendingBase: '# A' });
  assert.equal(tabsStore.peekDoc('/dir', '/dir/a.md').rawText, '# A edited');
  assert.equal(tabsStore.peekDoc('/dir', '/dir/a.md').pendingBase, '# A');
  assert.equal(tabsStore.peekDoc('/dir', '/dir/b.md').rawText, '# B', 'sibling untouched');
});

test('removeTab drops a folder slot and its docs with no retention', () => {
  tabsStore.createFolderTab('/dir', ['/dir/a.md']);
  tabsStore.setDoc('/dir', '/dir/a.md', rec('# A'));
  tabsStore.selectFileInTab('/dir', '/dir/a.md');

  tabsStore.removeTab('/dir');
  assert.equal(tabsStore.hasTab('/dir'), false);
  assert.equal(tabsStore.activeRoot, null);
  assert.equal(store.state.filePath, null);

  // Reopening the same folder starts fresh — the old docs Map is gone.
  tabsStore.createFolderTab('/dir', ['/dir/a.md']);
  assert.equal(tabsStore.peekTab('/dir').docs.size, 0);
});

test('removeTab on a background tab leaves the active singleton intact', () => {
  store.loadDoc({ filePath: '/a.md', rawText: '# A', comments: [] });
  tabsStore.saveActiveTab(0);
  store.loadDoc({ filePath: '/b.md', rawText: '# B', comments: [] });
  tabsStore.saveActiveTab(0); // B active
  tabsStore.removeTab('/a.md'); // background
  assert.equal(store.state.filePath, '/b.md');
  assert.equal(tabsStore.activeRoot, '/b.md');
});
