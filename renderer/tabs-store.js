// A tab's `root` is a FILE (file-tab) or a FOLDER (folder-tab). store.js keeps the
// singleton `state` on the active doc; this layer parks every other doc and round-trips
// the active one through snapshotActive/hydrate, so the editing loop needs no tab awareness.
//
// `activeRoot` (not `state.filePath`) is the active-tab signal — a folder-tab's root is
// its directory, which never equals the singleton's filePath.
import { state, snapshotActive, hydrate, clearActive } from './store.js';

// root -> slot. Two shapes:
//   file-tab:   { kind:'file',   root, rawText, comments, activeId, lastWrittenJson, scrollTop }
//   folder-tab: { kind:'folder', root, files:[abs], collapsedDirs:Set, selectedFile|null,
//                 docs: Map<file, {rawText, comments, activeId, lastWrittenJson, scrollTop}> }
const tabs = new Map();

// live binding — `import * as tabsStore` reads it fresh
export let activeRoot = null;

export function tabPaths() {
  return [...tabs.keys()];
}

export function hasTab(root) {
  return tabs.has(root);
}

export function tabKind(root) {
  const slot = tabs.get(root);
  return slot ? slot.kind : null;
}

export function peekTab(root) {
  return tabs.get(root) || null;
}

// For a file-tab the slot is its own doc record; for a folder-tab it's docs.get(file).
export function peekDoc(root, file) {
  const slot = tabs.get(root);
  if (!slot) return null;
  return slot.kind === 'folder' ? slot.docs.get(file) || null : slot;
}

// Register/refresh the active singleton as its own file-tab; also the file-tab park path.
export function saveActiveTab(scrollTop) {
  if (!state.filePath) return;
  tabs.set(state.filePath, { kind: 'file', root: state.filePath, ...snapshotActive(), scrollTop });
  activeRoot = state.filePath;
}

export function createFolderTab(root, files) {
  const slot = { kind: 'folder', root, files, collapsedDirs: new Set(), selectedFile: null, docs: new Map() };
  tabs.set(root, slot);
  activeRoot = root;
  clearActive(); // folder-tabs open with no file shown
  return slot;
}

export function parkActive(scrollTop) {
  if (!activeRoot) return;
  const slot = tabs.get(activeRoot);
  if (!slot) return;
  if (slot.kind === 'folder') {
    if (slot.selectedFile != null) slot.docs.set(slot.selectedFile, { ...snapshotActive(), scrollTop });
  } else {
    Object.assign(slot, snapshotActive(), { scrollTop });
  }
}

// Caller must parkActive() the outgoing tab first.
export function switchTab(root) {
  const slot = tabs.get(root);
  if (!slot) return null;
  activeRoot = root;
  if (slot.kind === 'folder') {
    const f = slot.selectedFile;
    if (f != null && slot.docs.has(f)) hydrate(f, slot.docs.get(f));
    else clearActive();
  } else {
    hydrate(root, slot);
  }
  return slot;
}

export function selectFileInTab(root, file) {
  const slot = tabs.get(root);
  if (!slot || slot.kind !== 'folder') return null;
  slot.selectedFile = file;
  const rec = slot.docs.get(file) || null;
  if (rec) hydrate(file, rec);
  return rec;
}

// Cache a freshly-read doc record into a folder-tab (without selecting/hydrating).
export function setDoc(root, file, rec) {
  const slot = tabs.get(root);
  if (slot && slot.kind === 'folder') slot.docs.set(file, rec);
}

export function patchTab(root, patch) {
  const slot = tabs.get(root);
  if (slot) Object.assign(slot, patch);
}

export function patchDoc(root, file, patch) {
  const rec = peekDoc(root, file);
  if (rec) Object.assign(rec, patch);
}

// Detach the active tab without removing it: the tab bar stays populated but none is
// highlighted, and the singleton clears. Backs "new tab = home screen" — caller parks first.
export function deactivate() {
  activeRoot = null;
  clearActive();
}

// Doesn't pick a neighbor — the caller repaints. Clears the singleton if the dropped tab was active.
export function removeTab(root) {
  tabs.delete(root);
  if (activeRoot === root) {
    activeRoot = null;
    clearActive();
  }
}
