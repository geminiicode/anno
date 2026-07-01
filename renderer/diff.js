import { escapeHtml } from './helpers.js';

function diffRowsHtml(rows) {
  return rows
    .map((r) => {
      const sign = r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' ';
      return `<div class="diff-row ${r.type}"><span class="sign">${sign}</span>${escapeHtml(r.text) || '&nbsp;'}</div>`;
    })
    .join('');
}

// diffLines is O(m·n); a giant before/after (corrupt/hand-edited sidecar) would hang
// the renderer at markup-build time (diff built on render, not on toggle click). Past
// this size, skip diffLines for a placeholder — still counts as a real edit so the toggle shows.
const MAX_DIFF_CHARS = 50000;
const MAX_DIFF_LINES = 2000;
function tooLargeToDiff(h) {
  return (
    h.before.length > MAX_DIFF_CHARS ||
    h.after.length > MAX_DIFF_CHARS ||
    h.before.split('\n').length > MAX_DIFF_LINES ||
    h.after.split('\n').length > MAX_DIFF_LINES
  );
}

export function renderHunksHtml(hunks) {
  return hunks
    // same predicate hasRenderableDiff gates on — keeps a null/malformed/no-op hunk from throwing or rendering as empty rows + a stray ⋯
    .filter((h) => h && typeof h.before === 'string' && typeof h.after === 'string' && h.before !== h.after)
    .map((h) =>
      tooLargeToDiff(h)
        ? '<div class="diff-row gap">(diff too large to display)</div>'
        : diffRowsHtml(annoLib.diffLines(h.before, h.after))
    )
    .join('<div class="diff-row gap">⋯</div>');
}

// a toggle is worth showing only if some hunk is a real before≠after edit
export function hasRenderableDiff(change) {
  return (
    !!change &&
    Array.isArray(change.hunks) &&
    change.hunks.some(
      (h) => h && typeof h.before === 'string' && typeof h.after === 'string' && h.before !== h.after
    )
  );
}
