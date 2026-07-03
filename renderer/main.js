import {
  commentPaneEl,
  docPaneEl,
  contentEl,
  toggleSidebarBtn,
  toggleCommentsBtn,
  toggleResolvedBtn,
} from './dom.js';
import { getLayout, setLayout, applyLayout } from './layout.js';
import { renderComments } from './comments.js';
import { subscribe, render } from './store.js';
import { scheduleLayout } from './comment-layout.js';
import { openFile, openFolderTab, onExternalChange, showHome } from './doc.js';
import * as host from './host.js';
import './selection.js';
import './diff.js';
import './help.js';

// priority 10 → runs after renderDoc (priority 0), so the sidebar measures freshly-morphed rects
subscribe(renderComments, 10);

if ((globalThis.navigator?.userAgent || '').includes('Mac OS X')) document.body.classList.add('mac');

function toggleLeftSidebar() {
  setLayout({ sidebarCollapsed: !getLayout().sidebarCollapsed });
  applyLayout();
  scheduleLayout();
}
function toggleRightSidebar() {
  setLayout({ commentsCollapsed: !getLayout().commentsCollapsed });
  applyLayout();
  scheduleLayout();
}
function toggleResolved() {
  setLayout({ hideResolved: !getLayout().hideResolved });
  applyLayout();
  render();
}

// Cmd/Ctrl+T shows the home screen (deactivates the active doc); +L toggles the left
// sidebar. Right sidebar (Cmd+R) is handled in main via before-input-event IPC — Cmd+R is
// the native Reload role and a renderer keydown can't reliably swallow it.
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  if (k === 't') {
    e.preventDefault();
    showHome();
  } else if (k === 'l') {
    e.preventDefault();
    toggleLeftSidebar();
  } else if (k === 'h' && e.shiftKey) {
    e.preventDefault();
    toggleResolved();
  }
});

toggleSidebarBtn.addEventListener('click', toggleLeftSidebar);
toggleCommentsBtn.addEventListener('click', toggleRightSidebar);
toggleResolvedBtn.addEventListener('click', toggleResolved);

function flagScrolling(el) {
  el.classList.add('scrolling');
  clearTimeout(el._hideBar);
  el._hideBar = setTimeout(() => el.classList.remove('scrolling'), 700);
}

let mirroring = false;
docPaneEl.addEventListener(
  'scroll',
  () => {
    flagScrolling(docPaneEl);
    mirroring = true;
    commentPaneEl.scrollTop = docPaneEl.scrollTop;
    // swallow the scroll event our own mirror assignment fires, so the mirrored pane's scrollbar doesn't flash
    requestAnimationFrame(() => {
      mirroring = false;
    });
  },
  { passive: true }
);
commentPaneEl.addEventListener(
  'scroll',
  () => {
    if (mirroring) return; // driven by the doc mirror, not the user
    flagScrolling(commentPaneEl);
  },
  { passive: true }
);
window.addEventListener('resize', scheduleLayout);
contentEl.addEventListener('load', scheduleLayout, true);

host.onFileChanged(onExternalChange);
host.onOpenFile((mdPath) => openFile(mdPath));
host.onOpenFolder((dir) => openFolderTab(dir));
// Cmd+R arrives as IPC; swallow it while typing in a composer, else the toggle collapses the pane mid-edit
function isEditingText() {
  const el = document.activeElement;
  if (!el) return false;
  return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable;
}
host.onToggleComments(() => {
  if (isEditingText()) return;
  toggleRightSidebar();
});

applyLayout();
showHome();
