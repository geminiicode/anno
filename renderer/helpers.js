import * as host from './host.js';

let idCounter = 0;
export function newId() {
  idCounter += 1;
  return 'c' + Date.now().toString(36) + '_' + idCounter.toString(36);
}

// Mirrors sidecar.js#WORKING_STALE_MS — change both together (a test asserts equality).
export const WORKING_STALE_MS = 5 * 60 * 1000;

// computed at render, not in normalizeComment — baking a derived field into the persisted shape breaks the byte-exact echo check
export function isWorking(c, now = Date.now()) {
  if (!c.working) return false;
  const since = Date.parse(c.workingSince);
  if (Number.isNaN(since)) return true; // marked without a usable timestamp — trust it
  return now - since < WORKING_STALE_MS;
}

// status fallback duplicates sidecar.js#statusOf (ESM can't require it) — change both together.
export function normalizeComment(c) {
  const status = c.status || (c.resolved ? 'resolved' : 'open');
  return {
    ...c,
    status,
    replies: Array.isArray(c.replies) ? c.replies : [],
  };
}

// navigator landed in Node 21; CI runs Node 20, so optional-chain or this module throws at load under `node --test`
const isMac = (globalThis.navigator?.userAgent || '').includes('Mac OS X');

export function formatShortcut(key, { shift = false } = {}) {
  // 'Enter' has no compact glyph off-mac, so keep the word there; ↵ reads cleanly next to ⌘
  const label = isMac && key === 'Enter' ? '↵' : key;
  if (isMac) return `${shift ? '⌘⇧' : '⌘'}${label}`;
  return `Ctrl+${shift ? 'Shift+' : ''}${label}`;
}

export function basename(p) {
  return p.split(/[/\\]/).pop();
}

export function prettyPath(p) {
  const home = host.homeDir();
  if (home && (p === home || p.startsWith(home + '/'))) return '~' + p.slice(home.length);
  return p;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function truncate(s, n) {
  s = String(s ?? ''); // quote may be undefined (span deleted); .length would throw

  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}
