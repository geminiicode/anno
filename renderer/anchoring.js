import { contentEl, state } from './dom.js';
import { focusComment } from './comment-layout.js';
import { getLayout } from './layout.js';
import { isWorking } from './helpers.js';

// per-comment anchor status ({ detached: bool }) kept off the comment objects so they stay
// serializable; rebuilt each applyHighlights(). detached = no live highlight span (quote removed).
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

export function rangeToOffsets(range, root = contentEl) {
  // Range.toString() (unlike Selection.toString()) keeps newlines, and setEnd handles ELEMENT
  // containers (triple-click selects a whole <p>) the old text-node scan couldn't match.
  const measure = (container, offset) => {
    if (!root.contains(container)) return null;
    const pre = document.createRange();
    pre.selectNodeContents(root);
    try {
      pre.setEnd(container, offset);
    } catch {
      return null; // offset out of range for the container
    }
    return pre.toString().length;
  };
  let start = measure(range.startContainer, range.startOffset);
  let end = measure(range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  if (start > end) [start, end] = [end, start];
  return { start, end };
}

export function offsetsToRange(start, end, root = contentEl) {
  const nodes = getTextNodes(root);
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

export function fullText(root = contentEl) {
  return root.textContent;
}

function locateRange(comment, root = contentEl) {
  const anchor = annoLib.findAnchor(fullText(root), comment);
  return anchor ? offsetsToRange(anchor.start, anchor.end, root) : null;
}

// Images contribute no textContent, so they anchor by markdown-source src
// (data-anno-src, stamped in images.js before the file:// rewrite), not a quote.
export function findImageBySrc(src, root = contentEl) {
  if (src == null) return null;
  for (const img of root.querySelectorAll('img')) {
    const key = img.dataset.annoSrc ?? img.getAttribute('src');
    if (key === src) return img;
  }
  return null;
}

function imageOffset(img, root = contentEl) {
  try {
    const range = document.createRange();
    range.setStart(root, 0);
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

function highlightRange(range, comment, pending = false, root = contentEl) {
  const nodes = getTextNodes(root).filter((node) => range.intersectsNode(node));
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

// unique occurrence only — a recurring prefix/suffix would anchor at the wrong match
function uniqueIndex(text, s) {
  if (!s) return -1;
  const i = text.indexOf(s);
  return i !== -1 && text.indexOf(s, i + 1) === -1 ? i : -1;
}

// Caret after the left context, else before the right — but only on a real context match; a blind
// clamped offset would strand it somewhere unrelated. No match → null (orphan).
function caretOffset(comment, root = contentEl) {
  const text = fullText(root);
  if (comment.prefix) {
    const i = uniqueIndex(text, comment.prefix);
    if (i !== -1) return i + comment.prefix.length;
  }
  if (comment.suffix) {
    const i = uniqueIndex(text, comment.suffix);
    if (i !== -1) return i;
  }
  return null;
}

// Held-highlight span: the region now between the comment's surviving prefix/suffix (what's being
// rewritten). Null when a context is gone/ambiguous or the gap collapsed (quote removed).
function contextBounds(comment, root = contentEl) {
  const text = fullText(root);
  const pi = uniqueIndex(text, comment.prefix);
  const si = uniqueIndex(text, comment.suffix);
  if (pi === -1 || si === -1) return null;
  const start = pi + comment.prefix.length;
  return si > start ? { start, end: si } : null;
}

function clearHighlights(root = contentEl) {
  for (const el of root.querySelectorAll('.comment-highlight')) {
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

// Paints spans into `root` (a detached clone on the production path) for the caller to morph in.
// clearHighlights is a no-op on a fresh tree; only matters if a caller passes the live contentEl.
export function applyHighlights(root = contentEl) {
  clearHighlights(root);
  anchors.clear();
  for (const comment of state.comments) {
    // hidden resolved comments get no inline highlight — matches the sidebar filter
    if (comment.status === 'resolved' && getLayout().hideResolved) continue;
    if (comment.imageSrc) {
      const img = findImageBySrc(comment.imageSrc, root);
      anchors.set(comment.id, { detached: !img });
      if (img) {
        highlightImage(img, comment);
        // sort inline with text comments: an img has no textContent, so derive its
        // offset from the length of all text preceding it (leave unset → bottom-sort on failure)
        const off = imageOffset(img, root);
        if (off != null) {
          comment.start = off;
          comment.end = off;
        }
      }
      continue;
    }
    const range = locateRange(comment, root);
    // findAnchor missed mid-rewrite: hold the highlight, but bound it by surviving context, not
    // stale offsets — tracks an in-place rewrite, collapses on removal (→ detached). Blind offsets
    // would over-extend into text that shifted up and bleed onto the next line.
    if (!range && isWorking(comment)) {
      const bounds = contextBounds(comment, root);
      const held = bounds && offsetsToRange(bounds.start, bounds.end, root);
      if (held) {
        anchors.set(comment.id, { detached: false });
        highlightRange(held, comment, false, root);
        continue;
      }
    }
    if (range) {
      anchors.set(comment.id, { detached: false });
      // refresh offsets from where the quote was found so re-anchored comments (CLI clears start/end) regain a sort position
      const off = rangeToOffsets(range, root);
      if (off) {
        comment.start = off.start;
        comment.end = off.end;
      }
      highlightRange(range, comment, false, root);
      continue;
    }
    // Quote gone (Claude removed the text, or a hand-edit). No in-doc marker — hold the comment's
    // document position by refreshing start to where the text was (via surviving context), so its
    // card lays out at that gap and keeps its order. The detached state shows on the sidebar card;
    // comment-layout derives the card's rect from this offset when there's no live span.
    const caret = caretOffset(comment, root);
    if (caret != null) {
      comment.start = caret;
      comment.end = caret;
    }
    anchors.set(comment.id, { detached: true });
  }
  highlightPending(root);
}

// pending comment isn't in state.comments yet + native selection was cleared; paint it or the quote goes dark until save
function highlightPending(root = contentEl) {
  const p = state.pendingRange;
  if (!p) return;
  if (p.imageSrc) {
    findImageBySrc(p.imageSrc, root)?.classList.add('comment-highlight', 'image', 'active', 'pending');
    return;
  }
  // Re-anchor by quote first (like committed comments) so a mid-compose reload shifting the text
  // doesn't strand the pending highlight at stale offsets. Raw offsets only when there's no quote.
  let range = p.quote ? locateRange(p, root) : null;
  if (!range && Number.isFinite(p.start) && Number.isFinite(p.end) && p.start < p.end) {
    range = offsetsToRange(p.start, p.end, root);
  }
  if (range) highlightRange(range, { id: PENDING_ID, status: 'open' }, true, root);
}

// Delegated once: highlight spans are rebuilt into a detached tree each render and morphed
// in, so per-span listeners (the old approach) would be stripped by morph. Images are handled
// in selection.js; the :not(.pending) filter skips the in-composition selection (no comment).
contentEl.addEventListener('click', (e) => {
  const span = e.target.closest?.('span.comment-highlight:not(.pending)');
  if (!span || !contentEl.contains(span)) return;
  e.stopPropagation();
  focusComment(span.dataset.commentId, true);
});
