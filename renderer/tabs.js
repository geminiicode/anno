// The import cycle with doc.js is safe — both only call each other inside handlers, not at module-eval time.
import { tabBarEl } from './dom.js';
import { basename, formatShortcut } from './helpers.js';
import * as tabsStore from './tabs-store.js';
import { switchToTab, closeTabUi, showHome } from './doc.js';

export function renderTabs() {
  const roots = tabsStore.tabPaths();
  tabBarEl.hidden = roots.length === 0;
  tabBarEl.innerHTML = '';
  for (const root of roots) {
    const isFolder = tabsStore.tabKind(root) === 'folder';
    const tab = document.createElement('div');
    tab.className = 'tab' + (root === tabsStore.activeRoot ? ' active' : '') + (isFolder ? ' folder' : '');
    tab.title = root;

    const icon = document.createElement('span');
    icon.className = 'tab-ico';
    icon.textContent = isFolder ? '📁' : '📄';

    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = basename(root);
    label.addEventListener('click', () => switchToTab(root));

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.setAttribute('aria-label', `Close ${basename(root)}`);
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTabUi(root);
    });

    tab.append(icon, label, close);
    tabBarEl.appendChild(tab);
  }

  // no tabs → render nothing (bar already hidden above); the + only exists alongside real tabs
  if (roots.length === 0) return;

  const add = document.createElement('button');
  add.className = 'tab-new';
  add.textContent = '+';
  add.title = `New tab (${formatShortcut('T')})`;
  add.setAttribute('aria-label', 'New tab');
  add.addEventListener('click', showHome);
  tabBarEl.appendChild(add);
}
