import { normalizeComment } from './helpers.js';
import * as host from './host.js';

export const state = {
  filePath: null,
  rawText: null,
  comments: [],
  activeId: null,
  pendingRange: null
};

const listeners = new Set();

// structural changes only — active-comment focus deliberately does NOT notify (see setActive)
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function render() {
  for (const fn of listeners) fn();
}

// snapshot of our last write, to detect + skip the watcher echoing it back (flicker)
let lastWrittenJson = null;

// `comments` is the RAW disk read; it matches only because what we wrote was already
// normalized. Keep write + read shapes identical — normalizing on read or reordering keys returns the flicker.
export function isOwnEcho(comments) {
  return lastWrittenJson !== null && JSON.stringify(comments) === lastWrittenJson;
}

// reconcile against the sidecar first: a blind write from stale state would clobber AI
// replies the CLI added since our last read. Adopt addressed-status/re-anchored quote
// only when we just imported an AI reply, so a deliberate user "Reopen" is never undone.
async function persist() {
  if (!state.filePath) return;
  try {
    const disk = (await host.readComments(state.filePath)).map(normalizeComment);
    const diskById = new Map(disk.map((c) => [c.id, c]));
    for (const c of state.comments) {
      const d = diskById.get(c.id);
      if (!d) continue;
      const have = new Set((c.replies || []).map((r) => `${r.createdAt}\n${r.body}`));
      let importedAi = false;
      for (const r of d.replies || []) {
        if (!have.has(`${r.createdAt}\n${r.body}`)) {
          c.replies.push(r);
          if (r.ai) importedAi = true;
        }
      }
      if (importedAi && c.status === 'open' && d.status === 'addressed') {
        c.status = 'addressed';
        if (d.quote && d.quote !== c.quote) {
          c.quote = d.quote;
          delete c.start;
          delete c.end;
          delete c.prefix;
          delete c.suffix;
        }
      }
    }
  } catch {
    /* disk unreadable — write what we have */
  }
  lastWrittenJson = JSON.stringify(state.comments); // for the echo check
  await host.writeComments(state.filePath, state.comments);
}

async function commit() {
  await persist();
  render();
}

export async function addComment(comment) {
  state.comments.push(comment);
  state.pendingRange = null;
  await commit();
}

export async function updateComment(id, patch) {
  const c = state.comments.find((x) => x.id === id);
  if (!c) return;
  Object.assign(c, patch);
  await commit();
}

export async function addReply(id, reply) {
  const c = state.comments.find((x) => x.id === id);
  if (!c) return;
  c.replies = c.replies || [];
  c.replies.push(reply);
  // a human follow-up re-opens an addressed thread; resolved stays closed (replying there is just a note)
  if (!reply.ai && c.status === 'addressed') c.status = 'open';
  await commit();
}

export async function removeComment(id) {
  state.comments = state.comments.filter((x) => x.id !== id);
  if (state.activeId === id) state.activeId = null;
  await commit();
}

export function setActive(id) {
  state.activeId = id;
}

export function setPending(range) {
  state.pendingRange = range;
}

// set state but do NOT render: the caller paints the doc HTML first (applyHighlights needs the rendered text), then calls render()

export function loadDoc({ filePath, rawText, comments }) {
  state.filePath = filePath;
  state.rawText = rawText;
  state.comments = comments.map(normalizeComment);
  state.activeId = null;
  state.pendingRange = null;
  // drop the old file's echo snapshot, else the new file's first watcher event is wrongly suppressed if its sidecar serializes identically
  lastWrittenJson = null;
}

// ---------- single-doc ↔ tab-slot seam ----------
// The singleton `state` holds one doc; tabs-store.js parks the others and round-trips
// the active one through these primitives, carrying lastWrittenJson (the per-tab echo marker).

// `comments` is the same array ref the singleton holds, so in-place persist() mutations stay
// reflected in the slot. INVARIANT: re-park (saveActiveTab) before reading the active tab's
// slot — removeComment/setComments/loadDoc reassign state.comments, so an unparked slot points
// at the stale array and would resurrect deleted comments.
export function snapshotActive() {
  return {
    rawText: state.rawText,
    comments: state.comments,
    activeId: state.activeId,
    lastWrittenJson,
  };
}

export function hydrate(filePath, slot) {
  state.filePath = filePath;
  state.rawText = slot.rawText;
  state.comments = slot.comments;
  state.activeId = slot.activeId;
  state.pendingRange = null;
  lastWrittenJson = slot.lastWrittenJson;
}

export function clearActive() {
  state.filePath = null;
  state.rawText = null;
  state.comments = [];
  state.activeId = null;
  state.pendingRange = null;
  lastWrittenJson = null;
}

export function setComments(comments) {
  state.comments = comments.map(normalizeComment);
}

export function setRawText(rawText) {
  state.rawText = rawText;
}

export function setActiveIfPresent(id) {
  state.activeId = id && state.comments.some((c) => c.id === id) ? id : null;
}
