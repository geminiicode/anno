import { state, contentEl, docPaneEl, currentFileEl } from './dom.js';
import { prettyPath, normalizeComment } from './helpers.js';
import { addRecent, removeRecent, renderHome } from './recents.js';
import { focusComment } from './comment-layout.js';
import { renderTabs } from './tabs.js';
import { paintActiveTree } from './filetree.js';
import { resolveImageSrcs } from './images.js';
import * as store from './store.js';
import * as tabsStore from './tabs-store.js';
import * as host from './host.js';

function paintDoc(raw) {
  contentEl.innerHTML = DOMPurify.sanitize(marked.parse(raw));
  resolveImageSrcs(contentEl, state.filePath);
}

function showActive(scrollTop) {
  currentFileEl.textContent = prettyPath(state.filePath);
  paintDoc(state.rawText);
  store.render();
  docPaneEl.scrollTop = scrollTop || 0;
  restoreFocus();
  paintActiveTree();
  renderTabs();
}

function showEmpty() {
  currentFileEl.textContent = '';
  renderHome(contentEl); // the home screen IS the editor empty state
  store.render();
  paintActiveTree();
  renderTabs();
}

// "New tab" (⌘T / the + button) and app start: park + detach the active doc so the tab
// bar shows no active tab (or is empty), then render the home screen. Picking a recent or
// using the Open button opens a real doc tab as usual.
export function showHome() {
  tabsStore.parkActive(docPaneEl.scrollTop);
  tabsStore.deactivate();
  showEmpty();
}

export async function openFile(file) {
  if (tabsStore.hasTab(file)) {
    switchToTab(file);
    return;
  }
  // main decides whether a fresh agent spawns or an existing tab (file- or covering folder-tab) owns it
  const verdict = await host.startTab(file, false);
  if (!verdict || verdict.action === 'cancelled') return;
  // another window owns this root; main already focused it — don't touch our state
  if (verdict.action === 'elsewhere') return;
  if (verdict.action === 'focus') {
    switchToTab(verdict.root);
    if (verdict.selectFile) await selectFile(verdict.selectFile);
    return;
  }
  // key off main's canonical root, not the raw arg — file:changed carries the canonical path, so a symlinked open keyed by raw would never match
  const root = verdict.root || file;
  if (tabsStore.hasTab(root)) return switchToTab(root); // raced during the await
  let raw;
  try {
    raw = await host.readFile(root);
  } catch {
    removeRecent(root);
    currentFileEl.textContent = `Could not open ${prettyPath(root)}`;
    host.stopTab(root); // tear down the agent we just spawned but can't use
    return;
  }
  const comments = await host.readComments(root);
  if (tabsStore.hasTab(root)) return switchToTab(root); // racing second open landed mid-await
  tabsStore.parkActive(docPaneEl.scrollTop);
  store.loadDoc({ filePath: root, rawText: raw, comments });
  tabsStore.saveActiveTab(0);
  showActive(0);
  addRecent(root);
}

export async function openFolderTab(dir) {
  if (tabsStore.hasTab(dir)) {
    switchToTab(dir);
    return;
  }
  const verdict = await host.startTab(dir, true);
  if (!verdict || verdict.action === 'cancelled') return;
  // another window owns this root; main already focused it — don't touch our state
  if (verdict.action === 'elsewhere') return;
  if (verdict.action === 'focus') {
    switchToTab(verdict.root);
    if (verdict.selectFile) await selectFile(verdict.selectFile);
    return;
  }
  if (verdict.action === 'absorbed') {
    // main already stopped the file-agents + spawned the folder agent; just drop our
    // tabs (no host.stopTab — that would kill the new folder agent's siblings)
    for (const f of verdict.absorbedFiles || []) tabsStore.removeTab(f);
    await buildFolderTab(verdict.root || dir);
    return;
  }
  if (verdict.action === 'started') await buildFolderTab(verdict.root || dir);
}

// root is main's canonical path — key the tab off it so file:changed routes here.
async function buildFolderTab(root) {
  const files = await host.listMarkdown(root);
  if (tabsStore.hasTab(root)) return switchToTab(root); // raced during the await
  tabsStore.parkActive(docPaneEl.scrollTop);
  tabsStore.createFolderTab(root, files);
  showEmpty();
}

// Pick a file inside the active folder-tab: a doc reload, not a new tab/agent (no startTab).
export async function selectFile(file) {
  const root = tabsStore.activeRoot;
  if (!root || tabsStore.tabKind(root) !== 'folder') return;
  const slot = tabsStore.peekTab(root);
  if (slot.selectedFile === file) return;
  tabsStore.parkActive(docPaneEl.scrollTop);

  if (tabsStore.peekDoc(root, file)) {
    const rec = tabsStore.selectFileInTab(root, file);
    showActive(rec ? rec.scrollTop || 0 : 0);
    return;
  }

  let raw;
  try {
    raw = await host.readFile(file);
  } catch {
    return; // vanished — keep current selection
  }
  const comments = await host.readComments(file);
  const rec = { rawText: raw, comments: comments.map(normalizeComment), activeId: null, lastWrittenJson: null, scrollTop: 0 };
  // cache the record regardless, but only hydrate the singleton if our folder-tab is still active
  tabsStore.setDoc(root, file, rec);
  if (tabsStore.activeRoot !== root) return; // switched away — don't clobber the live doc
  tabsStore.selectFileInTab(root, file);
  showActive(0);
  addRecent(file);
}

export function switchToTab(root) {
  if (root === tabsStore.activeRoot) return;
  tabsStore.parkActive(docPaneEl.scrollTop);
  const slot = tabsStore.switchTab(root);
  if (!slot) return;
  if (slot.kind === 'folder') {
    if (slot.selectedFile != null) {
      const rec = tabsStore.peekDoc(root, slot.selectedFile);
      showActive(rec ? rec.scrollTop || 0 : 0);
    } else {
      showEmpty();
    }
  } else {
    showActive(slot.scrollTop || 0);
  }
}

// closing a background tab leaves the view as-is; an active one activates a neighbor (or empty)
export function closeTabUi(root) {
  const wasActive = root === tabsStore.activeRoot;
  const order = tabsStore.tabPaths();
  host.stopTab(root);
  tabsStore.removeTab(root);
  if (!wasActive) {
    renderTabs();
    paintActiveTree();
    return;
  }
  const idx = order.indexOf(root);
  const next = order[idx + 1] || order[idx - 1] || null;
  if (next) switchToTab(next);
  else showEmpty();
}

function restoreFocus() {
  if (state.activeId) focusComment(state.activeId, false);
}

async function reloadDoc(newRaw) {
  const fp = state.filePath;
  if (!fp) return;
  const scrollTop = docPaneEl.scrollTop;
  const keepActive = state.activeId;
  const comments = await host.readComments(fp);
  if (state.filePath !== fp) return; // switched away mid-read
  store.setRawText(newRaw);
  store.setComments(comments);
  store.setActiveIfPresent(keepActive);
  paintDoc(newRaw);
  store.render();
  docPaneEl.scrollTop = scrollTop;
  restoreFocus();
}

async function reloadComments() {
  const fp = state.filePath;
  if (!fp) return;
  const disk = await host.readComments(fp);
  if (state.filePath !== fp) return; // switched away mid-read
  if (store.isOwnEcho(disk)) return; // our own write bounced back through the watcher — re-render would flicker
  const keepActive = state.activeId;
  store.setComments(disk);
  store.setActiveIfPresent(keepActive);
  store.render();
  restoreFocus();
}

// A watched file changed. `root` names the owning tab (file-tab root === mdPath;
// folder-tab root === its directory, mdPath === whichever tree file changed).
export async function onExternalChange({ kind, mdPath, root }) {
  root = root || mdPath; // file-tab events may omit root
  if (!tabsStore.hasTab(root)) return;

  // re-check after every await: a synchronous switch can land mid-read, else we'd
  // bleed one doc's bytes into another or leave a now-active doc stale
  const isLive = () => mdPath === state.filePath && root === tabsStore.activeRoot;

  if (kind === 'md') {
    let raw;
    try {
      raw = await host.readFile(mdPath);
    } catch {
      return; // vanished — keep stale snapshot
    }
    if (isLive()) {
      if (raw === state.rawText) return;
      return reloadDoc(raw);
    }
    const rec = tabsStore.peekDoc(root, mdPath);
    if (!rec) return; // folder file never loaded — fresh read happens on select
    tabsStore.patchDoc(root, mdPath, { rawText: raw });
  } else if (kind === 'comments') {
    if (isLive()) return reloadComments();
    const comments = (await host.readComments(mdPath)).map(normalizeComment);
    if (isLive()) return reloadComments(); // switched onto it mid-read
    const rec = tabsStore.peekDoc(root, mdPath);
    if (rec) tabsStore.patchDoc(root, mdPath, { comments });
  }
}
