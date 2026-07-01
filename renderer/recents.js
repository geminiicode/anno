import { basename, prettyPath } from './helpers.js';
import { openFile } from './doc.js';
import { openFileOrFolder } from './filetree.js';

const RECENT_KEY = 'recentFiles';
const RECENT_MAX = 5;

function getRecents() {
  try {
    const r = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(r) ? r.slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function addRecent(filePath) {
  const recents = [filePath, ...getRecents().filter((p) => p !== filePath)].slice(0, RECENT_MAX);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recents));
}

export function removeRecent(filePath) {
  const recents = getRecents().filter((p) => p !== filePath);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recents));
}

function clearRecents() {
  localStorage.removeItem(RECENT_KEY);
}

// The editor empty state: a home screen with the wordmark, recent files, and the
// OS picker. Rendered into `contentEl` by doc.showEmpty / showHome (no active doc).
export function renderHome(container) {
  const recents = getRecents();
  container.innerHTML = '';

  const home = document.createElement('div');
  home.className = 'home-screen';

  const title = document.createElement('h1');
  title.className = 'home-wordmark';
  title.textContent = 'anno';
  home.appendChild(title);

  const openBtn = document.createElement('button');
  openBtn.className = 'home-open';
  openBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span>Open file or folder…</span>';
  openBtn.addEventListener('click', () => openFileOrFolder());

  if (recents.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'home-hint';
    hint.textContent = 'Open a folder or file to start reading.';
    home.appendChild(hint);
  } else {
    const section = document.createElement('div');
    section.className = 'home-recent';

    const head = document.createElement('div');
    head.className = 'home-recent-head';
    const label = document.createElement('h4');
    label.textContent = 'Recent';
    const clear = document.createElement('button');
    clear.className = 'home-clear';
    clear.textContent = 'Clear';
    clear.addEventListener('click', () => {
      clearRecents();
      renderHome(container);
    });
    head.append(label, clear);
    section.appendChild(head);

    const ul = document.createElement('ul');
    for (const p of recents) {
      const li = document.createElement('li');
      li.className = 'recent-link';
      li.title = p;
      li.dataset.path = p;
      li.addEventListener('click', () => openFile(p));

      const name = document.createElement('span');
      name.className = 'recent-name';
      name.textContent = basename(p);

      const path = document.createElement('span');
      path.className = 'recent-path';
      path.textContent = prettyPath(p);

      li.append(name, path);
      ul.appendChild(li);
    }
    section.appendChild(ul);
    home.appendChild(section);
  }

  home.appendChild(openBtn);
  container.appendChild(home);
}
