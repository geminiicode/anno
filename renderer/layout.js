import {
  toggleSidebarBtn,
  toggleCommentsBtn,
  toggleResolvedBtn,
} from './dom.js';
import { scheduleLayout } from './comment-layout.js';
import { formatShortcut } from './helpers.js';

const LAYOUT_KEY = 'panelLayout';

const SIDEBAR_SC = `(${formatShortcut('L')})`;
const COMMENTS_SC = `(${formatShortcut('R')})`;
const RESOLVED_SC = `(${formatShortcut('H', { shift: true })})`;

export function getLayout() {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {};
  } catch {
    return {};
  }
}

export function setLayout(patch) {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...getLayout(), ...patch }));
}

export function applyLayout() {
  const l = getLayout();
  document.body.classList.toggle('sidebar-collapsed', !!l.sidebarCollapsed);
  document.body.classList.toggle('comments-collapsed', !!l.commentsCollapsed);
  toggleSidebarBtn.classList.toggle('active', !!l.sidebarCollapsed);
  toggleCommentsBtn.classList.toggle('active', !!l.commentsCollapsed);
  toggleResolvedBtn.classList.toggle('active', !!l.hideResolved);
  toggleSidebarBtn.dataset.tooltip =
    (l.sidebarCollapsed ? 'Show file sidebar' : 'Hide file sidebar') + ' ' + SIDEBAR_SC;
  toggleCommentsBtn.dataset.tooltip =
    (l.commentsCollapsed ? 'Show comments' : 'Hide comments') + ' ' + COMMENTS_SC;
  toggleResolvedBtn.textContent = l.hideResolved ? 'Show resolved' : 'Hide resolved';
  // .header-action has no styled data-tooltip CSS (that's .icon-btn only) — use native title
  toggleResolvedBtn.title =
    (l.hideResolved ? 'Show resolved comments' : 'Hide resolved comments') + ' ' + RESOLVED_SC;
}

// surface the right sidebar if hidden, else the composer renders into a collapsed pane
export function ensureCommentsVisible() {
  if (getLayout().commentsCollapsed) {
    setLayout({ commentsCollapsed: false });
    applyLayout();
    scheduleLayout();
  }
}
