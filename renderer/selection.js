import { addCommentBtn, contentEl, state } from './dom.js';
import { rangeToOffsets, fullText } from './anchoring.js';
import { openComposer } from './comments.js';
import { setPending } from './store.js';
import { focusComment } from './comment-layout.js';
import { basename, formatShortcut } from './helpers.js';

// images carry no text selection, so getSelection() can't represent a clicked one — track the pick out of band
let pendingImage = null;

const SHORTCUT_LABEL = formatShortcut('Enter');
addCommentBtn.title = `Add a comment (${SHORTCUT_LABEL})`;
addCommentBtn.innerHTML = `💬 Comment <span class="kbd">${SHORTCUT_LABEL}</span>`;

function showButtonAt(rect) {
  addCommentBtn.style.top = window.scrollY + rect.top - 38 + 'px';
  addCommentBtn.style.left = window.scrollX + rect.left + 'px';
  addCommentBtn.hidden = false;
}

function activeTextSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  // commonAncestorContainer bubbles to #layout on select-to-end; test both endpoints instead
  if (!contentEl.contains(range.startContainer) && !contentEl.contains(range.endContainer)) return null;
  if (sel.toString().trim().length === 0) return null;
  return sel;
}

document.addEventListener('selectionchange', () => {
  const sel = activeTextSelection();
  if (sel) {
    pendingImage = null; // a text selection supersedes an image pick
    showButtonAt(sel.getRangeAt(0).getBoundingClientRect());
    return;
  }
  if (!pendingImage) addCommentBtn.hidden = true;
});

// fall back to matching the markdown-source src in case highlightImage's data-commentId stamp isn't applied yet
function commentIdForImage(img) {
  if (img.dataset.commentId) return img.dataset.commentId;
  const src = img.dataset.annoSrc ?? img.getAttribute('src');
  const match = state.comments.find((c) => c.imageSrc && c.imageSrc === src);
  return match ? match.id : null;
}

// delegated so it survives the innerHTML swaps on every doc repaint
contentEl.addEventListener('click', (e) => {
  const img = e.target.closest && e.target.closest('img');
  if (!img || !contentEl.contains(img)) return;
  const existingId = commentIdForImage(img);
  if (existingId) {
    pendingImage = null;
    addCommentBtn.hidden = true;
    focusComment(existingId, false);
    return;
  }
  pendingImage = img;
  showButtonAt(img.getBoundingClientRect());
});

// shared by the button and the keyboard shortcut; an image pick takes precedence (no text selection to read)
function startComment() {
  if (pendingImage) {
    const img = pendingImage;
    pendingImage = null;
    if (!contentEl.contains(img)) return; // repaint dropped it
    const src = img.dataset.annoSrc ?? img.getAttribute('src') ?? '';
    if (!src) return;
    const label = (img.getAttribute('alt') || '').trim() || basename(src) || 'image';
    setPending({ imageSrc: src, quote: label });
    addCommentBtn.hidden = true;
    openComposer();
    return;
  }

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  // trailing newlines from an over-the-end range break the offset match below; trim first
  const quote = sel.toString().trim();
  if (!quote) return;

  const text = fullText();
  const range = sel.getRangeAt(0);
  // quote is authoritative, offsets best-effort: if they disagree (e.g. range starts on a block-boundary newline node), relocate by text
  let offsets = rangeToOffsets(range);
  if (!offsets || text.slice(offsets.start, offsets.end) !== quote) {
    // seed indexOf from the range's offset so a repeated phrase anchors to the selected instance, not the first
    let idx = text.indexOf(quote, offsets ? offsets.start : 0);
    if (idx === -1) idx = text.indexOf(quote);
    offsets = idx === -1 ? { start: 0, end: 0 } : { start: idx, end: idx + quote.length };
  }

  setPending({
    start: offsets.start,
    end: offsets.end,
    quote,
    prefix: text.slice(Math.max(0, offsets.start - 32), offsets.start),
    suffix: text.slice(offsets.end, offsets.end + 32),
  });
  addCommentBtn.hidden = true;
  sel.removeAllRanges();
  openComposer();
}

addCommentBtn.addEventListener('mousedown', (e) => {
  // mousedown (not click) so the selection isn't cleared first
  e.preventDefault();
  startComment();
});

// Cmd/Ctrl+Enter comments on the current selection. The guard (selection must be
// inside contentEl, or an image picked) means this never collides with the
// composer's own Cmd+Enter save — that fires only while typing in the textarea.
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
  if (!pendingImage && !activeTextSelection()) return;
  e.preventDefault();
  startComment();
});

document.addEventListener('mousedown', (e) => {
  if (e.target !== addCommentBtn && !addCommentBtn.contains(e.target)) {
    pendingImage = null;
    addCommentBtn.hidden = true;
  }
});
