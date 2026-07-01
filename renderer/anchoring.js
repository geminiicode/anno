import { contentEl, state } from './dom.js';
import { focusComment } from './comment-layout.js';
import { getLayout } from './layout.js';
import { isWorking } from './helpers.js';

// orphaned flag kept off comment objects so they stay serializable; rebuilt each applyHighlights()
export const anchors = new Map();

// the in-composition selection isn't a comment yet, so it carries no id
const PENDING_ID = '__pending__';

function getTextNodes(root) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  return nodes;
}

export function rangeToOffsets(range) {
  const nodes = getTextNodes(contentEl);
  let offset = 0;
  let start = null;
  let end = null;
  for (const node of nodes) {
    const len = node.nodeValue.length;
    if (node === range.startContainer) start = offset + range.startOffset;
    if (node === range.endContainer) end = offset + range.endOffset;
    offset += len;
  }
  if (start === null || end === null) return null;
  if (start > end) [start, end] = [end, start];
  return { start, end };
}

export function offsetsToRange(start, end) {
  const nodes = getTextNodes(contentEl);
  let offset = 0;
  const range = document.createRange();
  let startSet = false;
  let endSet = false;
  for (const node of nodes) {
    const len = node.nodeValue.length;
    if (!startSet && start <= offset + len) {
      range.setStart(node, Math.max(0, start - offset));
      startSet = true;
    }
    if (!endSet && end <= offset + len) {
      range.setEnd(node, Math.max(0, end - offset));
      endSet = true;
      break;
    }
    offset += len;
  }
  if (!startSet || !endSet) return null;
  return range;
}

export function fullText() {
  return contentEl.textContent;
}

function locateRange(comment) {
  const anchor = annoLib.findAnchor(fullText(), comment);
  return anchor ? offsetsToRange(anchor.start, anchor.end) : null;
}

// Images contribute no textContent, so they anchor by markdown-source src
// (data-anno-src, stamped in images.js before the file:// rewrite), not a quote.
export function findImageBySrc(src) {
  if (src == null) return null;
  for (const img of contentEl.querySelectorAll('img')) {
    const key = img.dataset.annoSrc ?? img.getAttribute('src');
    if (key === src) return img;
  }
  return null;
}

function imageOffset(img) {
  try {
    const range = document.createRange();
    range.setStart(contentEl, 0);
    range.setEndBefore(img);
    return range.toString().length;
  } catch {
    return null;
  }
}

function highlightImage(img, comment) {
  img.classList.add('comment-highlight', 'image');
  if (comment.status === 'resolved') img.classList.add('resolved');
  if (comment.id === state.activeId) img.classList.add('active');
  img.dataset.commentId = comment.id;
}

function highlightRange(range, comment, pending = false) {
  const nodes = getTextNodes(contentEl).filter((node) => range.intersectsNode(node));
  for (const node of nodes) {
    const nodeRange = document.createRange();
    nodeRange.selectNodeContents(node);
    if (node === range.startContainer) nodeRange.setStart(node, range.startOffset);
    if (node === range.endContainer) nodeRange.setEnd(node, range.endOffset);
    if (nodeRange.collapsed) continue;

    const span = document.createElement('span');
    span.className = 'comment-highlight';
    if (pending) span.classList.add('pending', 'active');
    if (comment.status === 'resolved') span.classList.add('resolved');
    // from state so active styling survives a structural re-render, not just a focusComment() repaint
    if (comment.id === state.activeId) span.classList.add('active');
    span.dataset.commentId = comment.id;
    try {
      nodeRange.surroundContents(span);
    } catch {
      // throws on a range partially selecting a non-text node; skip rather than corrupt the DOM
    }
  }
}

function clearHighlights() {
  for (const el of contentEl.querySelectorAll('.comment-highlight')) {
    // unwrapping an <img> (not a wrapper span) would move its children out and DELETE it; strip marker only
    if (el.tagName === 'IMG') {
      el.classList.remove('comment-highlight', 'image', 'resolved', 'active', 'pending');
      delete el.dataset.commentId;
      continue;
    }
    const parent = el.parentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    parent.normalize();
  }
}

export function applyHighlights() {
  clearHighlights();
  anchors.clear();
  for (const comment of state.comments) {
    // hidden resolved comments get no inline highlight — matches the sidebar filter
    if (comment.status === 'resolved' && getLayout().hideResolved) continue;
    if (comment.imageSrc) {
      const img = findImageBySrc(comment.imageSrc);
      anchors.set(comment.id, { orphaned: !img });
      if (img) {
        highlightImage(img, comment);
        // sort inline with text comments: an img has no textContent, so derive its
        // offset from the length of all text preceding it (leave unset → bottom-sort on failure)
        const off = imageOffset(img);
        if (off != null) {
          comment.start = off;
          comment.end = off;
        }
      }
      continue;
    }
    const range = locateRange(comment);
    // Claude rewrites the quoted text while addressing, so findAnchor misses and the
    // highlight would vanish mid-run. Hold it at last-known offsets until the write re-anchors.
    if (!range && isWorking(comment)) {
      const held = offsetsToRange(comment.start, comment.end);
      if (held) {
        anchors.set(comment.id, { orphaned: false });
        highlightRange(held, comment);
        continue;
      }
    }
    anchors.set(comment.id, { orphaned: !range });
    if (range) {
      // refresh offsets from where the quote was found so re-anchored comments (CLI clears start/end) regain a sort position
      const off = rangeToOffsets(range);
      if (off) {
        comment.start = off.start;
        comment.end = off.end;
      }
      highlightRange(range, comment);
    }
  }
  highlightPending();
  wireHighlightClicks();
}

// pending comment isn't in state.comments yet + native selection was cleared; paint it or the quote goes dark until save
function highlightPending() {
  const p = state.pendingRange;
  if (!p) return;
  if (p.imageSrc) {
    findImageBySrc(p.imageSrc)?.classList.add('comment-highlight', 'image', 'active', 'pending');
    return;
  }
  if (!Number.isFinite(p.start) || !Number.isFinite(p.end) || p.start >= p.end) return;
  const range = offsetsToRange(p.start, p.end);
  if (range) highlightRange(range, { id: PENDING_ID, status: 'open' }, true);
}

function wireHighlightClicks() {
  // spans only — a commented image's click is handled in selection.js; pending has no comment to focus
  for (const span of contentEl.querySelectorAll('span.comment-highlight:not(.pending)')) {
    span.addEventListener('click', (e) => {
      e.stopPropagation();
      focusComment(span.dataset.commentId, true);
    });
  }
}
