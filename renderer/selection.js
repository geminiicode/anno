import { addCommentBtn, contentEl, docPaneEl, state } from './dom.js';
import { rangeToOffsets, fullText } from './anchoring.js';
import { openComposer } from './comments.js';
import { setPending } from './store.js';
import { focusComment } from './comment-layout.js';
import { basename, formatShortcut } from './helpers.js';

// images carry no text selection, so getSelection() can't represent a clicked one — track the pick out of band
let pendingImage = null;
// a mouse button is held (a potential drag) — suppresses the scroll-follow so an auto-scrolling
// drag-select doesn't pop the button in before the user has released
let dragging = false;

const SHORTCUT_LABEL = formatShortcut('Enter');
addCommentBtn.title = `Add a comment (${SHORTCUT_LABEL})`;
addCommentBtn.innerHTML = `💬 Comment <span class="kbd">${SHORTCUT_LABEL}</span>`;

// viewport coords (the button is position:fixed); clamp both edges so it never rides off-screen.
// unhide before measuring — a hidden element reports offsetWidth 0, so the right-edge clamp would miss.
function showButtonAt(rect) {
  addCommentBtn.hidden = false;
  const left = Math.min(rect.left, window.innerWidth - addCommentBtn.offsetWidth - 6);
  addCommentBtn.style.top = Math.max(6, rect.top - 38) + 'px';
  addCommentBtn.style.left = Math.max(6, left) + 'px';
}

// first line's top-left, so the button sits at a stable spot regardless of drag direction
function selectionStartRect(sel) {
  const range = sel.getRangeAt(0);
  const rects = range.getClientRects?.();
  if (rects && rects.length) return rects[0];
  return range.getBoundingClientRect();
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

// selectionchange only HIDES (a button jittering under the cursor mid-drag is distracting);
// mouseup — and shift-keyup for keyboard selection — is what shows it once the selection settles.
document.addEventListener('selectionchange', () => {
  if (!activeTextSelection() && !pendingImage) addCommentBtn.hidden = true;
});

function offerCommentButton() {
  const sel = activeTextSelection();
  if (!sel) return;
  pendingImage = null; // a text selection supersedes an image pick
  showButtonAt(selectionStartRect(sel));
}

document.addEventListener('mouseup', () => { dragging = false; offerCommentButton(); });
document.addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'Shift') offerCommentButton(); });
// a release off-window or a native drag gesture won't fire our document mouseup — clear the latch on
// those too, else the scroll-follow stays disabled until the next full mousedown→mouseup
window.addEventListener('blur', () => { dragging = false; });
document.addEventListener('dragend', () => { dragging = false; });

function currentAnchorRect() {
  if (pendingImage) return contentEl.contains(pendingImage) ? pendingImage.getBoundingClientRect() : null;
  const sel = activeTextSelection();
  return sel ? selectionStartRect(sel) : null;
}

// position:fixed, so #docPane scrolling out from under it would strand the button — re-pin to the
// anchor on scroll, and hide it once the anchor leaves the pane. Skipped mid-drag (see dragging).
docPaneEl?.addEventListener('scroll', () => {
  if (dragging) return;
  const rect = currentAnchorRect();
  if (!rect) { addCommentBtn.hidden = true; return; }
  const pane = docPaneEl.getBoundingClientRect();
  if (rect.bottom < pane.top || rect.top > pane.bottom) { addCommentBtn.hidden = true; return; }
  showButtonAt(rect);
}, { passive: true });

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
  const selText = sel.toString().trim();
  if (!selText) return;

  const text = fullText();
  const range = sel.getRangeAt(0);
  // Trust rangeToOffsets when it resolves, and take the quote from the textContent slice, NOT
  // Selection.toString() — toString() collapses hard-wrap newlines to spaces, so a wrapped-line
  // quote wouldn't match textContent and the comment would anchor at {0,0}.
  let offsets = rangeToOffsets(range);
  if (offsets && offsets.start < offsets.end) {
    // tighten past leading/trailing whitespace so quote and offsets stay in lockstep, no stray edges
    while (offsets.start < offsets.end && /\s/.test(text[offsets.start])) offsets.start += 1;
    while (offsets.end > offsets.start && /\s/.test(text[offsets.end - 1])) offsets.end -= 1;
  } else {
    // range unusable (e.g. a boundary on a non-text node) — best-effort locate by the selection text
    const idx = text.indexOf(selText);
    offsets = idx === -1 ? { start: 0, end: 0 } : { start: idx, end: idx + selText.length };
  }
  const quote = offsets.start < offsets.end ? text.slice(offsets.start, offsets.end) : selText;

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
  dragging = true;
  if (e.target !== addCommentBtn && !addCommentBtn.contains(e.target)) {
    pendingImage = null;
    addCommentBtn.hidden = true;
  }
});
