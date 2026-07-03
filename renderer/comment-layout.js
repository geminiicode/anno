import { commentListEl, commentPaneEl, contentEl, docPaneEl, state } from './dom.js';
import { offsetsToRange, findImageBySrc } from './anchoring.js';
import { setActive } from './store.js';

const GAP = 8;

// Don't add scrollTop: the list scroll mirrors the doc's, so a scroll-relative
// target here would double-count and misalign cards.
function cardTarget(el) {
  const contentTop = contentEl.getBoundingClientRect().top;
  let rect = null;
  if (el.dataset.commentId) {
    const anchorEl = contentEl.querySelector(
      `.comment-highlight[data-comment-id="${CSS.escape(el.dataset.commentId)}"]`
    );
    if (anchorEl) rect = anchorEl.getBoundingClientRect();
    else {
      // detached comment (quote removed, no live span): position it at the gap where the text was,
      // via a collapsed Range at its last-known offset — nothing injected into the document
      const c = state.comments.find((x) => x.id === el.dataset.commentId);
      if (c && Number.isFinite(c.start)) {
        const r = offsetsToRange(c.start, c.start);
        if (r) { try { rect = r.getBoundingClientRect(); } catch { /* no layout (jsdom) */ } }
      }
    }
  } else if (state.pendingRange) {
    if (state.pendingRange.imageSrc) {
      const img = findImageBySrc(state.pendingRange.imageSrc);
      if (img) rect = img.getBoundingClientRect();
    } else {
      const r = offsetsToRange(state.pendingRange.start, state.pendingRange.end);
      if (r) rect = r.getBoundingClientRect();
    }
  }
  if (!rect) return null;
  return rect.top - contentTop;
}

let layoutQueued = false;
export function scheduleLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => {
    layoutQueued = false;
    layoutComments();
  });
}

// animate=false places cards instantly; after a rebuild `transition: top` would
// otherwise slide every fresh card in from top:0 (a full-sidebar bounce).
export function layoutComments(animate = true) {
  const cards = [...commentListEl.children].filter((el) =>
    el.classList.contains('comment-card')
  );
  if (cards.length === 0) {
    commentListEl.style.height = '';
    return;
  }
  if (!animate) commentListEl.classList.add('no-anim');

  const items = cards.map((el) => ({ el, target: cardTarget(el), height: el.offsetHeight }));

  // Cards arrive start-sorted; a card whose anchor yields no rect at all (offset out of range)
  // inherits the preceding card's position instead of sinking to the bottom via Infinity.
  let filled = 0;
  for (const it of items) {
    if (it.target == null) it.target = filled;
    else filled = it.target;
  }

  const activeIdx = items.findIndex(
    (it) => it.el.classList.contains('active') && isFinite(it.target)
  );

  items.sort((a, b) => a.target - b.target);

  let cursor = 0;
  for (const it of items) {
    const top = Math.max(isFinite(it.target) ? it.target : cursor, cursor);
    it.top = top;
    cursor = top + it.height + GAP;
  }

  if (activeIdx !== -1) {
    const active = items.find((it) => it.el.classList.contains('active'));
    if (active && active.top > active.target) {
      const ai = items.indexOf(active);
      // floor active's pull-up at the stacked height of the cards above — pulling past it
      // forces them negative, the clamp below pins them to 0, and they pile up (the
      // near-anchored overlap bug)
      let minTop = 0;
      for (let i = 0; i < ai; i++) minTop += items[i].height + GAP;
      active.top = Math.max(active.target, minTop);
      let limit = active.top - GAP;
      for (let i = ai - 1; i >= 0; i--) {
        if (items[i].top + items[i].height > limit) {
          items[i].top = limit - items[i].height;
        }
        limit = items[i].top - GAP;
      }
    }
  }

  let maxBottom = 0;
  for (const it of items) {
    const top = Math.max(0, it.top);
    it.el.style.top = top + 'px';
    maxBottom = Math.max(maxBottom, top + it.height);
  }
  // clamp to last card's bottom (not docHeight) to avoid dead scroll space; floor at viewport so a short list fills
  commentListEl.style.height =
    Math.max(maxBottom + 24, commentPaneEl.clientHeight) + 'px';

  if (!animate) {
    // force reflow to commit the no-anim placement before re-enabling transitions
    void commentListEl.offsetHeight;
    commentListEl.classList.remove('no-anim');
  }
}

// repaints only active classes — no full re-render, so an open reply composer survives
export function focusComment(id, scrollDoc) {
  setActive(id);
  for (const span of contentEl.querySelectorAll('.comment-highlight')) {
    span.classList.toggle('active', span.dataset.commentId === id);
  }
  for (const card of commentListEl.querySelectorAll('.comment-card')) {
    card.classList.toggle('active', card.dataset.commentId === id);
  }
  if (scrollDoc) {
    const span = contentEl.querySelector(`.comment-highlight[data-comment-id="${CSS.escape(id)}"]`);
    if (span) {
      // center by math, not scrollIntoView — which no-ops when the marker is already partly visible (the usual case)
      const spanRect = span.getBoundingClientRect();
      const paneRect = docPaneEl.getBoundingClientRect();
      const delta = spanRect.top - paneRect.top - (docPaneEl.clientHeight - spanRect.height) / 2;
      docPaneEl.scrollTo({ top: Math.max(0, docPaneEl.scrollTop + delta), behavior: 'smooth' });
    }
  } else {
    const card = commentListEl.querySelector(`.comment-card[data-comment-id="${CSS.escape(id)}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}
