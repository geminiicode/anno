import { fileListEl } from './dom.js';
import { openFile, openFolderTab, selectFile } from './doc.js';
import * as tabsStore from './tabs-store.js';
import * as host from './host.js';

export async function openFileOrFolder() {
  const res = await host.openPicker();
  if (!res) return;
  if (res.isDir) openFolderTab(res.path);
  else openFile(res.path);
}

// the sidebar tree belongs to the active tab — folder-tab paints its scoped tree, file-tab/none clears it
export function paintActiveTree() {
  const root = tabsStore.activeRoot;
  const slot = root ? tabsStore.peekTab(root) : null;
  if (!slot || slot.kind !== 'folder') {
    fileListEl.innerHTML = '';
    return;
  }
  renderFolderTree(slot);
}

function renderFolderTree(slot) {
  fileListEl.innerHTML = '';
  if (slot.files.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No markdown files found';
    li.style.color = 'var(--muted)';
    li.style.cursor = 'default';
    fileListEl.appendChild(li);
    return;
  }
  const root = { dirs: new Map(), files: [] };
  for (const abs of slot.files) {
    const rel = abs.slice(slot.root.length + 1);
    const parts = rel.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push({ name: parts[parts.length - 1], path: abs });
  }
  renderTree(slot, root, 0, '');
}

function renderTree(slot, node, depth, prefix) {
  for (const name of [...node.dirs.keys()].sort((a, b) => a.localeCompare(b))) {
    const dirPath = prefix + name + '/';
    const collapsed = slot.collapsedDirs.has(dirPath);
    const row = document.createElement('li');
    row.className = 'tree-folder';
    row.style.paddingLeft = 8 + depth * 14 + 'px';
    const tw = document.createElement('span');
    tw.className = 'tw';
    tw.textContent = collapsed ? '▸' : '▾';
    row.append(tw, document.createTextNode(name));
    row.addEventListener('click', () => {
      if (slot.collapsedDirs.has(dirPath)) slot.collapsedDirs.delete(dirPath);
      else slot.collapsedDirs.add(dirPath);
      paintActiveTree();
    });
    fileListEl.appendChild(row);
    if (!collapsed) renderTree(slot, node.dirs.get(name), depth + 1, dirPath);
  }
  for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
    const li = document.createElement('li');
    li.className = 'tree-file';
    li.style.paddingLeft = 8 + depth * 14 + 14 + 'px';
    li.textContent = f.name;
    li.title = f.path;
    li.dataset.path = f.path;
    li.classList.toggle('active', f.path === slot.selectedFile);
    li.addEventListener('click', () => selectFile(f.path));
    fileListEl.appendChild(li);
  }
}
