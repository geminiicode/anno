import { commentListEl, commentPaneEl, state } from './dom.js';
import { escapeHtml, truncate, formatDate, newId, isWorking } from './helpers.js';
import { getLayout, ensureCommentsVisible } from './layout.js';
import { anchors } from './anchoring.js';
import { layoutComments, focusComment } from './comment-layout.js';
import { hasRenderableDiff, renderHunksHtml } from './diff.js';
import * as store from './store.js';

export function renderComments() {
  // emptying the list clamps scrollTop to 0; capture and restore across rebuild
  const savedScroll = commentPaneEl.scrollTop;
  // composer draft text lives only in the DOM; the rebuild below wipes it (e.g. sidecar reload mid-typing)
  const drafts = captureDrafts();
  commentListEl.innerHTML = '';
  commentListEl.classList.remove('is-empty');
  if (!state.filePath) return;

  const visible = getLayout().hideResolved
    ? state.comments.filter((c) => c.status !== 'resolved')
    : state.comments;
  if (visible.length === 0 && !state.pendingRange) {
    commentListEl.classList.add('is-empty');
    commentListEl.style.height = '';
    const empty = document.createElement('div');
    empty.className = 'comment-empty';
    empty.textContent = 'Select text in the document to add a comment.';
    commentListEl.appendChild(empty);
    return;
  }

  // orphans (no resolvable anchor) sink to the bottom
  const pos = (c) => (Number.isFinite(c.start) ? c.start : Number.MAX_SAFE_INTEGER);
  const sorted = [...visible].sort((a, b) => pos(a) - pos(b));
  for (const c of sorted) {
    const card = document.createElement('div');
    card.className = 'comment-card';
    if (c.id === state.activeId) card.classList.add('active');
    if (c.status === 'resolved') card.classList.add('resolved');
    card.dataset.commentId = c.id;

    // detached = the quoted text is gone from the doc, so there's no live highlight. The card keeps
    // its document-order slot (positioned at the gap) and flags the removal instead of silently
    // pointing at nothing.
    const detached = !!anchors.get(c.id)?.detached;
    if (detached) card.classList.add('detached');
    const anchorTag = detached ? ' · ⚠︎ quote removed' : '';
    const repliesHtml = (c.replies || [])
      .map((r, ri) => {
        // diff HTML built lazily on first toggle-open, not here — renderHunksHtml is O(m·n)
        // and would run for every addressed reply on the render hot path even when never opened.
        const diff = hasRenderableDiff(r.change)
          ? `<button class="diff-toggle" type="button">Show diff</button>
          <div class="reply-diff" hidden></div>`
          : '';
        return `
        <div class="reply${r.ai ? ' ai' : ''}" data-reply-idx="${ri}">
          <div class="reply-meta">${escapeHtml(r.author || (r.ai ? 'AI' : 'Me'))}${
          r.ai ? ' 🤖' : ''
        } · ${formatDate(r.createdAt)}</div>
          <div class="reply-body">${escapeHtml(r.body)}</div>
          ${diff}
        </div>`;
      })
      .join('');

    const working = isWorking(c);
    if (working) card.classList.add('working');
    card.innerHTML = `
      ${reactionChip(c, working)}
      <div class="quote">${escapeHtml(truncate(c.quote, 160))}</div>
      <div class="body">${escapeHtml(c.body)}</div>
      ${statusBadge(c, working)}
      <div class="replies">${repliesHtml}</div>
      <div class="meta">
        <span>${escapeHtml(c.author || 'Me')} · ${formatDate(c.createdAt)}${anchorTag}</span>
        <span class="actions">
          <button class="reply-btn">Reply</button>
          <button class="resolve">${c.status === 'resolved' ? 'Reopen' : 'Resolve'}</button>
          <button class="danger delete">Delete</button>
        </span>
      </div>
      <div class="reply-composer" hidden></div>`;

    card.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('.reply-composer')) return;
      focusComment(c.id, true);
    });
    card.querySelector('.resolve').addEventListener('click', () => toggleResolve(c.id));
    card.querySelector('.delete').addEventListener('click', () => deleteComment(c.id));
    card.querySelector('.reply-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openReplyComposer(card, c.id);
    });
    card.querySelectorAll('.diff-toggle').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const panel = btn.nextElementSibling;
        if (!panel) return;
        const show = panel.hidden;
        // build the diff once, on first open (markup is rebuilt every renderComments,
        // so cache on the live node via dataset.built rather than a per-reply closure)
        if (show && !panel.dataset.built) {
          const ri = Number(btn.closest('.reply')?.dataset.replyIdx);
          const hunks = c.replies?.[ri]?.change?.hunks;
          if (hunks) panel.innerHTML = renderHunksHtml(hunks);
          panel.dataset.built = '1';
        }
        panel.hidden = !show;
        btn.textContent = show ? 'Hide diff' : 'Show diff';
        layoutComments(false);
      });
    });
    commentListEl.appendChild(card);
  }
  restoreDrafts(drafts);
  layoutComments(false);
  commentPaneEl.scrollTop = savedScroll;
}

export function openComposer() {
  ensureCommentsVisible();
  store.render(); // paint the pending selection in the doc (native selection was cleared) + sidebar
  injectNewComposer();
}

// setPending(null) + repaint: drop the pending doc highlight and the composer card together
function discardPending() {
  store.setPending(null);
  store.render();
}

// drops any existing composer first so openComposer (render-then-inject) can't stack two
function injectNewComposer() {
  commentListEl.querySelector('.composer.comment-card')?.remove();
  const composer = document.createElement('div');
  composer.className = 'composer comment-card active';
  composer.innerHTML = `
    <div class="quote">${escapeHtml(truncate(state.pendingRange.quote, 160))}</div>
    <textarea placeholder="Write a comment…"></textarea>
    <div class="composer-actions">
      <button class="cancel">Cancel</button>
      <button class="primary save">Comment</button>
    </div>`;
  commentListEl.prepend(composer);
  layoutComments(false);
  const textarea = composer.querySelector('textarea');
  textarea.focus();

  composer.querySelector('.cancel').addEventListener('click', discardPending);
  const save = () => {
    const body = textarea.value.trim();
    if (!body) { textarea.focus(); return; }
    addComment(body);
  };
  composer.querySelector('.save').addEventListener('click', save);
  textarea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save();
    if (e.key === 'Escape') discardPending();
  });
  return textarea;
}

function snapshotTextarea(ta, active) {
  return {
    value: ta.value,
    selStart: ta.selectionStart,
    selEnd: ta.selectionEnd,
    focused: ta === active,
  };
}

// open composers' draft text isn't in state — read it from the DOM
function captureDrafts() {
  const drafts = { newComposer: null, replies: [], outsideFocus: null };
  const active = document.activeElement;
  // focus outside the pane survives the rebuild but the builds below steal it
  if (active && active !== document.body && !commentListEl.contains(active)) {
    drafts.outsideFocus = active;
  }
  const nc = commentListEl.querySelector('.composer.comment-card textarea');
  if (nc) drafts.newComposer = snapshotTextarea(nc, active);
  for (const box of commentListEl.querySelectorAll('.reply-composer')) {
    if (box.hidden) continue;
    const ta = box.querySelector('textarea');
    const id = box.closest('.comment-card')?.dataset.commentId;
    if (ta && id) drafts.replies.push({ id, ...snapshotTextarea(ta, active) });
  }
  return drafts;
}

function applyDraft(ta, d) {
  ta.value = d.value;
  try { ta.setSelectionRange(d.selStart, d.selEnd); } catch { /* stale range */ }
}

// the builds steal focus, so hand it back to the one the user was actually in (focusBack) last
function restoreDrafts(drafts) {
  let focusBack = null;
  if (drafts.newComposer && state.pendingRange) {
    const ta = injectNewComposer();
    applyDraft(ta, drafts.newComposer);
    if (drafts.newComposer.focused) focusBack = { ta, d: drafts.newComposer };
  }
  for (const d of drafts.replies) {
    const card = commentListEl.querySelector(
      `.comment-card[data-comment-id="${CSS.escape(d.id)}"]`
    );
    if (!card) continue;
    openReplyComposer(card, d.id);
    const ta = card.querySelector('.reply-composer textarea');
    if (!ta) continue;
    applyDraft(ta, d);
    if (d.focused) focusBack = { ta, d };
  }
  if (focusBack) {
    focusBack.ta.focus();
    applyDraft(focusBack.ta, focusBack.d); // focus() can move the caret to end
  } else if (commentListEl.contains(document.activeElement)) {
    // a build stole focus the user didn't have — return it where it was
    if (drafts.outsideFocus && drafts.outsideFocus.isConnected) {
      drafts.outsideFocus.focus();
    } else {
      document.activeElement.blur();
    }
  }
}

async function addComment(body) {
  const p = state.pendingRange;
  const comment = {
    id: newId(),
    quote: p.quote, // image: alt/filename label shown on the card
    body,
    author: 'Me',
    createdAt: new Date().toISOString(),
    status: 'open',
    replies: [],
  };
  // image comments anchor by src, not text offsets — keep start/end/prefix/suffix off them
  if (p.imageSrc) {
    comment.imageSrc = p.imageSrc;
  } else {
    comment.prefix = p.prefix;
    comment.suffix = p.suffix;
    comment.start = p.start;
    comment.end = p.end;
  }
  await store.addComment(comment);
  focusComment(comment.id, false);
}

// 👀/✅ for AI-driven states, statusBadge for human ones — exactly one shows. `working` is stale-adjusted.
function reactionChip(c, working) {
  if (working) return '<span class="reaction working" title="Claude is addressing this…">👀</span>';
  if (c.status === 'addressed') return '<span class="reaction done" title="Addressed by Claude">✅</span>';
  if (c.status === 'errored') {
    // errorDetail can be up to scrubDetail's 2000-char cap; a native tooltip that long
    // is unreadable, so show a lead fragment (full detail lives in the sidecar).
    const detail = c.errorDetail ? c.errorDetail.slice(0, 200) : '';
    const why = detail ? `: ${detail}${c.errorDetail.length > 200 ? '…' : ''}` : '';
    return `<span class="reaction errored" title="${escapeHtml('Claude could not address this — reply to retry' + why)}">⚠️</span>`;
  }
  return '';
}

function statusBadge(c, working) {
  if (c.status === 'resolved') return '<span class="badge resolved">Resolved</span>';
  if (working || c.status === 'addressed' || c.status === 'errored') return ''; // shown by the reaction chip
  return '<span class="badge open">Open</span>';
}

async function toggleResolve(id) {
  const c = state.comments.find((x) => x.id === id);
  if (!c) return;
  await store.updateComment(id, { status: c.status === 'resolved' ? 'open' : 'resolved' });
}

function openReplyComposer(card, id) {
  const box = card.querySelector('.reply-composer');
  if (!box) return;
  box.hidden = false;
  box.innerHTML = `
    <textarea placeholder="Reply…"></textarea>
    <div class="composer-actions">
      <button class="cancel">Cancel</button>
      <button class="primary save">Reply</button>
    </div>`;
  const textarea = box.querySelector('textarea');
  textarea.focus();
  layoutComments(false);
  const close = () => { box.hidden = true; box.innerHTML = ''; layoutComments(false); };
  box.querySelector('.cancel').addEventListener('click', (e) => { e.stopPropagation(); close(); });
  const save = (e) => {
    if (e) e.stopPropagation();
    const body = textarea.value.trim();
    if (!body) { textarea.focus(); return; }
    close(); // hide before re-render, else captureDrafts resurrects the sent text
    addReply(id, { author: 'Me', body, createdAt: new Date().toISOString(), ai: false });
  };
  box.querySelector('.save').addEventListener('click', save);
  textarea.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save();
    if (e.key === 'Escape') close();
  });
}

async function addReply(id, reply) {
  await store.addReply(id, reply);
  focusComment(id, false);
}

async function deleteComment(id) {
  await store.removeComment(id);
}
