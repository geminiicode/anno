// doc.js tab orchestration under jsdom: closeTabUi neighbor selection and the
// cross-tab race — a read that resolves after a synchronous tab switch must not
// paint one tab's bytes into another. A gated window.api suspends reads mid-flight.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const dom = new JSDOM(`<!DOCTYPE html><body>
  <div id="tabBar"></div>
  <span id="currentFile"></span>
  <ul id="fileList"></ul>
  <div id="diffBanner" hidden>
    <span class="diff-summary"></span>
    <button id="diffDismiss"></button>
  </div>
  <main id="docPane"><article id="content"></article></main>
  <div id="commentList"></div>
  <aside id="commentPane"></aside>
</body>`, { url: 'http://localhost/' }); // url so localStorage isn't an opaque origin

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.HTMLElement = dom.window.HTMLElement; // morphdom reads it as a global (real in Electron)
globalThis.CSS = dom.window.CSS;
globalThis.localStorage = dom.window.localStorage;
globalThis.requestAnimationFrame = (cb) => cb();
globalThis.marked = require('marked');
globalThis.DOMPurify = require('dompurify')(dom.window);
globalThis.morphdom = require('morphdom');
globalThis.annoLib = require('../core/lib.js');

// readFileHook (when set) gates readFile so a test can suspend it, switch tabs,
// then release — reproducing the race window.
const files = new Map();
const sidecars = new Map();
let readFileHook = null;
let openCalls = 0;
// startTab resolves to main's overlap verdict; default 'started' (spawn a new tab).
// Tests override verdictFn to exercise focus/absorbed/cancelled. startTabCalls lets
// a test assert that a doc reload (selectFile) does NOT re-spawn an agent.
let verdictFn = () => ({ action: 'started' });
let startTabCalls = 0;
let stopTabCalls = [];
dom.window.api = {
  readFile: async (p) => {
    if (readFileHook) await readFileHook(p);
    if (!files.has(p)) throw new Error('missing');
    return files.get(p);
  },
  readComments: async (p) => JSON.parse(JSON.stringify(sidecars.get(p) ?? [])),
  writeComments: async (p, c) => sidecars.set(p, JSON.parse(JSON.stringify(c))),
  open: async () => { openCalls += 1; return null; }, // user cancels the picker
  startTab: async (root, isDir) => { startTabCalls += 1; return verdictFn(root, isDir); },
  stopTab: (root) => { stopTabCalls.push(root); },
  listMarkdown: async (dir) => [...files.keys()].filter((p) => p.startsWith(dir + '/')).sort(),
};

const doc = await import('../renderer/doc.js');
const store = await import('../renderer/store.js');
const tabsStore = await import('../renderer/tabs-store.js');
const { contentEl, fileListEl } = await import('../renderer/dom.js');

beforeEach(() => {
  for (const p of tabsStore.tabPaths()) tabsStore.removeTab(p);
  localStorage.clear(); // recents persist across tests via the home screen, else they leak
  files.clear();
  sidecars.clear();
  readFileHook = null;
  openCalls = 0;
  verdictFn = () => ({ action: 'started' });
  startTabCalls = 0;
  stopTabCalls = [];
  contentEl.innerHTML = '';
});

test('the + button shows the home screen (deactivates the active tab), it does NOT open the picker', async () => {
  const { tabBarEl } = await import('../renderer/dom.js');
  files.set('/a.md', '# A');
  await doc.openFile('/a.md');

  const add = tabBarEl.querySelector('.tab-new');
  assert.ok(add, '+ button present (inside the tab bar)');
  add.click();

  assert.equal(openCalls, 0, 'new-tab must not open the OS picker directly');
  assert.equal(store.state.filePath, null, 'active doc deactivated');
  assert.equal(tabsStore.activeRoot, null, 'no tab active');
  assert.deepEqual(tabsStore.tabPaths(), ['/a.md'], 'existing tab kept');
  assert.ok(contentEl.querySelector('.home-open'), 'home screen rendered with Open button');
});

test('the tab bar (incl. +) is hidden when there are no tabs, shown once a tab exists', async () => {
  const { tabBarEl } = await import('../renderer/dom.js');
  doc.showHome();
  assert.equal(tabBarEl.hidden, true, 'no tabs → whole bar hidden');
  assert.equal(tabBarEl.querySelector('.tab-new'), null, '+ lives inside the hidden bar');

  files.set('/a.md', '# A');
  await doc.openFile('/a.md');
  assert.equal(tabBarEl.hidden, false, 'a tab exists → bar shown');
  assert.ok(tabBarEl.querySelector('.tab-new'), '+ visible with tabs');
});

test('clicking a recent on the home screen opens it', async () => {
  files.set('/a.md', '# Alpha');
  localStorage.setItem('recentFiles', JSON.stringify(['/a.md']));
  doc.showHome();

  const link = contentEl.querySelector('.recent-link');
  assert.ok(link, 'recent row rendered on the home screen');
  link.click();
  // the click handler fires openFile (async, several awaits) but doesn't expose its promise
  for (let i = 0; i < 10; i++) await Promise.resolve();

  assert.equal(store.state.filePath, '/a.md');
  assert.ok(contentEl.innerHTML.includes('Alpha'));
});

test('closeTabUi activates a neighbor when the active middle tab is closed', async () => {
  files.set('/a.md', '# A');
  files.set('/b.md', '# B');
  files.set('/c.md', '# C');
  await doc.openFile('/a.md');
  await doc.openFile('/b.md');
  await doc.openFile('/c.md'); // order a,b,c
  doc.switchToTab('/b.md'); // active middle

  doc.closeTabUi('/b.md');

  assert.equal(store.state.filePath, '/c.md'); // next neighbor (order[idx+1])
  assert.deepEqual(tabsStore.tabPaths(), ['/a.md', '/c.md']);
});

test('closeTabUi activates the LEFT neighbor when the rightmost tab is closed', async () => {
  files.set('/a.md', '# A');
  files.set('/b.md', '# B');
  files.set('/c.md', '# C');
  await doc.openFile('/a.md');
  await doc.openFile('/b.md');
  await doc.openFile('/c.md'); // c active (last opened)

  doc.closeTabUi('/c.md');

  assert.equal(store.state.filePath, '/b.md'); // no idx+1 neighbor → order[idx-1]
  assert.deepEqual(tabsStore.tabPaths(), ['/a.md', '/b.md']);
});

test('closing the last remaining tab falls back to empty state', async () => {
  files.set('/a.md', '# A');
  await doc.openFile('/a.md');

  doc.closeTabUi('/a.md');

  assert.equal(store.state.filePath, null);
  assert.ok(contentEl.querySelector('.home-screen'), 'empty state renders the home screen');
  assert.deepEqual(tabsStore.tabPaths(), []);
});

test('an active-doc read that resolves after a tab switch does NOT bleed into the new tab', async () => {
  files.set('/a.md', '# A original');
  files.set('/b.md', '# B');
  await doc.openFile('/a.md');
  await doc.openFile('/b.md');
  doc.switchToTab('/a.md'); // showing A

  files.set('/a.md', '# A REWRITTEN'); // agent rewrote A on disk

  let release;
  readFileHook = () => new Promise((r) => { release = r; });
  const pending = doc.onExternalChange({ kind: 'md', mdPath: '/a.md' });
  doc.switchToTab('/b.md'); // switch while A's read is in flight
  readFileHook = null;
  release();
  await pending;

  assert.equal(store.state.filePath, '/b.md');
  assert.equal(store.state.rawText, '# B');
  assert.ok(contentEl.innerHTML.includes('B'));
  assert.ok(!contentEl.innerHTML.includes('REWRITTEN'), 'A content must not paint into B');
});

test('a background read that resolves after that tab becomes active repaints it (no stale view)', async () => {
  files.set('/a.md', '# A');
  files.set('/b.md', '# B original');
  await doc.openFile('/a.md');
  await doc.openFile('/b.md');
  doc.switchToTab('/a.md'); // b is background

  files.set('/b.md', '# B UPDATED');

  let release;
  readFileHook = () => new Promise((r) => { release = r; });
  const pending = doc.onExternalChange({ kind: 'md', mdPath: '/b.md' }); // background event
  doc.switchToTab('/b.md'); // b becomes active mid-read
  readFileHook = null;
  release();
  await pending;

  assert.equal(store.state.filePath, '/b.md');
  assert.ok(contentEl.innerHTML.includes('UPDATED'), 'became-active tab must repaint, not stay stale');
});

// ---------- folder-tabs: one tab scopes a directory + its selected file ----------

test('openFile honors a focus verdict instead of opening a second tab', async () => {
  files.set('/a.md', '# A');
  files.set('/b.md', '# B');
  await doc.openFile('/a.md');
  await doc.openFile('/b.md'); // b active
  // main says a folder/file tab already covers it → focus, no new tab
  verdictFn = () => ({ action: 'focus', root: '/a.md' });
  await doc.openFile('/c.md');
  assert.deepEqual(tabsStore.tabPaths(), ['/a.md', '/b.md']); // no /c.md tab
  assert.equal(store.state.filePath, '/a.md'); // focused the existing tab
});

test('openFolderTab opens a folder-tab with an empty pane (no auto-selected file)', async () => {
  files.set('/dir/a.md', '# A');
  files.set('/dir/b.md', '# B');
  await doc.openFolderTab('/dir');
  assert.equal(tabsStore.tabKind('/dir'), 'folder');
  assert.equal(tabsStore.activeRoot, '/dir');
  assert.equal(store.state.filePath, null, 'empty pane — nothing selected');
  assert.ok(contentEl.querySelector('.home-screen'), 'no selected file → home screen in the content area');
  assert.equal(fileListEl.querySelectorAll('.tree-file').length, 2, 'scoped tree painted');
});

test('selectFile reloads inside the folder-tab WITHOUT spawning an agent', async () => {
  files.set('/dir/a.md', '# Alpha');
  files.set('/dir/b.md', '# Bravo');
  await doc.openFolderTab('/dir'); // one startTab for the folder
  const callsAfterOpen = startTabCalls;

  await doc.selectFile('/dir/a.md');
  assert.equal(store.state.filePath, '/dir/a.md');
  assert.ok(contentEl.innerHTML.includes('Alpha'));
  assert.equal(startTabCalls, callsAfterOpen, 'selectFile must not call startTab (same agent)');
  assert.equal(tabsStore.tabPaths().length, 1, 'still one tab — no new file-tab');
});

test('switching selected files preserves each file\'s comment state per-file', async () => {
  files.set('/dir/a.md', '# A');
  files.set('/dir/b.md', '# B');
  await doc.openFolderTab('/dir');

  await doc.selectFile('/dir/a.md');
  await store.addComment({ id: 'a1', quote: 'q', body: 'on A', status: 'open', replies: [] });
  await doc.selectFile('/dir/b.md');
  await store.addComment({ id: 'b1', quote: 'q', body: 'on B', status: 'open', replies: [] });
  assert.equal(store.state.comments.length, 1);
  assert.equal(store.state.comments[0].id, 'b1');

  await doc.selectFile('/dir/a.md'); // back to A — its comment survived
  assert.equal(store.state.rawText, '# A');
  assert.equal(store.state.comments.length, 1);
  assert.equal(store.state.comments[0].id, 'a1');
});

test('a background folder file change is parked into the slot, not painted', async () => {
  files.set('/dir/a.md', '# A original');
  files.set('/dir/b.md', '# B');
  await doc.openFolderTab('/dir');
  await doc.selectFile('/dir/a.md');
  await doc.selectFile('/dir/b.md'); // a is now a backgrounded selection

  files.set('/dir/a.md', '# A rewritten');
  await doc.onExternalChange({ kind: 'md', mdPath: '/dir/a.md', root: '/dir' });
  assert.equal(store.state.filePath, '/dir/b.md', 'active selection unchanged');
  assert.ok(!contentEl.innerHTML.includes('rewritten'), 'background change not painted');

  await doc.selectFile('/dir/a.md'); // re-select surfaces the patched text
  assert.ok(contentEl.innerHTML.includes('rewritten'));
});

test('a folder file change mid-read, after switching away, still parks', async () => {
  // A read landing after the user switches away must park the change, not drop it.
  files.set('/dir/a.md', '# A v1');
  files.set('/dir/b.md', '# B');
  await doc.openFolderTab('/dir');
  await doc.selectFile('/dir/a.md');
  await doc.selectFile('/dir/b.md'); // caches b
  await doc.selectFile('/dir/a.md'); // a active again

  files.set('/dir/a.md', '# A v2');
  let release;
  readFileHook = () => new Promise((r) => { release = r; });
  const pending = doc.onExternalChange({ kind: 'md', mdPath: '/dir/a.md', root: '/dir' });
  await Promise.resolve();
  await doc.selectFile('/dir/b.md'); // switch away mid-read (b cached → no gated read)
  release();
  await pending;
  readFileHook = null;

  assert.equal(store.state.filePath, '/dir/b.md');
  assert.ok(!contentEl.innerHTML.includes('v2'), 'mid-read change not painted onto the new selection');
  await doc.selectFile('/dir/a.md');
  assert.ok(contentEl.innerHTML.includes('v2'), 'parked change surfaces on return');
});

test('openFile keys the tab by the canonical root main returns, not the raw arg', async () => {
  files.set('/canon/doc.md', '# Doc');
  verdictFn = () => ({ action: 'started', root: '/canon/doc.md' });
  await doc.openFile('/link/doc.md');
  assert.ok(tabsStore.hasTab('/canon/doc.md'), 'tab keyed by canonical root');
  assert.ok(!tabsStore.hasTab('/link/doc.md'), 'not keyed by the raw arg');
  assert.equal(store.state.filePath, '/canon/doc.md');
});

test('an external change to the selected folder file live-reloads it', async () => {
  files.set('/dir/a.md', '# A original');
  await doc.openFolderTab('/dir');
  await doc.selectFile('/dir/a.md');

  files.set('/dir/a.md', '# A live');
  await doc.onExternalChange({ kind: 'md', mdPath: '/dir/a.md', root: '/dir' });
  assert.ok(contentEl.innerHTML.includes('live'), 'selected file reloaded in place');
});

test('selectFile mid-read does not clobber the live doc after a tab switch', async () => {
  // The TOCTOU guard at the heart of folder-tabs: a slow read for b.md must not
  // paint b.md after the user has switched to another tab — but it should still
  // cache the record so re-selecting is instant.
  files.set('/dir/a.md', '# A');
  files.set('/dir/b.md', '# B rebuilt');
  files.set('/other/z.md', '# Z');
  await doc.openFolderTab('/dir');
  await doc.selectFile('/dir/a.md');
  await doc.openFolderTab('/other');
  await doc.selectFile('/other/z.md');
  doc.switchToTab('/dir'); // /dir active again, showing a.md

  let release;
  readFileHook = () => new Promise((r) => { release = r; });
  const pending = doc.selectFile('/dir/b.md'); // suspended mid-read
  await Promise.resolve();
  doc.switchToTab('/other'); // user switches away while b.md loads
  release();
  await pending;
  readFileHook = null;

  assert.equal(tabsStore.activeRoot, '/other');
  assert.equal(store.state.filePath, '/other/z.md', 'active selection unchanged by the late read');
  assert.ok(!contentEl.innerHTML.includes('rebuilt'), 'mid-read file not painted after switch-away');

  doc.switchToTab('/dir'); // the late read was still cached → re-select is instant
  await doc.selectFile('/dir/b.md');
  assert.ok(contentEl.innerHTML.includes('rebuilt'), 'cached record surfaced on re-select');
});

test('closing a folder-tab drops its slot with no per-file retention', async () => {
  files.set('/dir/a.md', '# A');
  await doc.openFolderTab('/dir');
  await doc.selectFile('/dir/a.md');

  doc.closeTabUi('/dir');
  assert.equal(tabsStore.hasTab('/dir'), false);
  assert.equal(store.state.filePath, null);
  assert.ok(stopTabCalls.includes('/dir'), 'agent stopped on close');
});

test('a comments-only reload keeps untouched doc text nodes identical (live selection survives)', async () => {
  // The bug: a comment's sidecar update rebuilt contentEl and corrupted a live selection. With morph,
  // an unchanged paragraph keeps its exact text node — the identity a native Range relies on.
  files.set('/s.md', '# T\n\nFirst paragraph stays put.\n\nSecond has the comment target.\n');
  sidecars.set('/s.md', []);
  await doc.openFile('/s.md');

  const p1 = [...contentEl.querySelectorAll('p')].find((p) => p.textContent.startsWith('First'));
  const node1 = p1.firstChild; // the text node a user would be mid-selecting
  assert.equal(node1.nodeType, 3);

  const full = contentEl.textContent;
  const q = 'comment target';
  const start = full.indexOf(q);
  sidecars.set('/s.md', [{ id: 'c1', quote: q, start, end: start + q.length, status: 'open', replies: [] }]);
  await doc.onExternalChange({ kind: 'comments', mdPath: '/s.md', root: '/s.md' });

  assert.ok(contentEl.querySelector('.comment-highlight[data-comment-id="c1"]'), 'comment highlight applied');
  assert.ok(node1.isConnected, 'untouched paragraph text node survives the reload');
  assert.equal(p1.firstChild, node1, 'morph reused the text node, did not replace it');
  assert.equal(node1.nodeValue, 'First paragraph stays put.');
});

test('rendered mermaid label text is excluded from the anchoring offset space', async () => {
  // A diagram label matching a comment quote must not enter the anchoring offset space, or the
  // quote goes non-unique and the comment silently detaches (or a match inside the SVG corrupts it).
  const { fullText } = await import('../renderer/anchoring.js');
  const root = document.createElement('div');
  root.innerHTML =
    '<p>Resolve a comment to grey it out.</p>' +
    '<div class="mermaid-diagram"><svg><g><text>Resolve</text></g></svg></div>';

  const text = fullText(root);
  assert.ok(text.includes('Resolve a comment'), 'prose is kept');
  assert.equal(text.split('Resolve').length - 1, 1, 'the diagram label "Resolve" is NOT counted');
  assert.ok(!text.includes('<svg>'), 'no markup leaks into the text space');
});

test('absorbed verdict closes the file-tabs and opens the folder-tab', async () => {
  files.set('/dir/a.md', '# A');
  files.set('/dir/b.md', '# B');
  await doc.openFile('/dir/a.md');
  await doc.openFile('/dir/b.md'); // two file-tabs

  verdictFn = () => ({ action: 'absorbed', root: '/dir', absorbedFiles: ['/dir/a.md', '/dir/b.md'] });
  stopTabCalls = [];
  await doc.openFolderTab('/dir');

  assert.deepEqual(tabsStore.tabPaths(), ['/dir'], 'file-tabs absorbed into the folder-tab');
  assert.equal(tabsStore.tabKind('/dir'), 'folder');
  assert.deepEqual(stopTabCalls, [], 'main already stopped the absorbed agents — renderer must not re-stop');
});
