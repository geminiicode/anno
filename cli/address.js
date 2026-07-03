const os = require('os');
const path = require('path');
const { readComments, writeComments, statusOf, isWorking } = require('../core/sidecar');
const { buildPrompt, runClaude, extractJsonArray } = require('./claude');

// 'addressed' + a trailing reviewer reply re-qualifies: the watcher fires on
// that reply's write but would otherwise find nothing open and drop the
// follow-up. 'resolved' stays closed.
function needsAddressing(c) {
  const status = statusOf(c);
  if (status === 'open') return true;
  if (status === 'addressed') {
    const replies = Array.isArray(c.replies) ? c.replies : [];
    const last = replies[replies.length - 1];
    return Boolean(last) && !last.ai;
  }
  return false;
}

// Reads fresh, not a pre-run snapshot, so a comment added in the editor mid-run isn't clobbered.
function setWorking(mdPath, ids, now) {
  const idSet = new Set(ids);
  const fresh = readComments(mdPath);
  for (const c of fresh) {
    if (idSet.has(c.id)) {
      c.working = true;
      c.workingSince = now;
    }
  }
  writeComments(mdPath, fresh);
}

// One-shot `address` clears 👀 markers on exit: unlike the watcher (whose
// stale-retry re-checks them), it has nothing to re-check, so a failed run would
// otherwise suppress the comment from the next manual run until it stale-expires.
function clearWorking(mdPath) {
  const fresh = readComments(mdPath);
  let changed = false;
  for (const c of fresh) {
    if (c.working || c.workingSince !== undefined) {
      delete c.working;
      delete c.workingSince;
      changed = true;
    }
  }
  if (changed) writeComments(mdPath, fresh); // skip a no-op write (and editor reload)
}

// errorDetail is persisted to the sidecar (often committed) — redact home-path
// usernames and session-id UUIDs. Second regex catches home paths the exact match
// missed (case-insensitive; macOS /private prefix).
function scrubDetail(detail) {
  const home = os.homedir();
  let s = String(detail);
  if (home) s = s.split(home).join('~');
  s = s.replace(/\/(?:private\/)?(?:Users|home)\/[^/\s]+/gi, '~');
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');
  return s.slice(0, 2000);
}

// errored + 👀 cleared so needsAddressing and stale-retry both skip it — a blind retry against an already-edited doc IS the double-apply bug
function markErrored(mdPath, ids, detail) {
  const idSet = new Set(ids);
  const fresh = readComments(mdPath);
  const now = new Date().toISOString();
  for (const c of fresh) {
    if (!idSet.has(c.id)) continue;
    c.status = 'errored';
    c.erroredAt = now;
    if (detail) c.errorDetail = scrubDetail(detail);
    delete c.working;
    delete c.workingSince;
  }
  writeComments(mdPath, fresh);
}

// Stranded 👀 = a daemon died mid-run (kill -9 skips teardown) after claude may
// already have edited — stale-retry would double-apply. Safe to sweep on startup:
// one daemon owns a tree, so nothing else is mid-run.
function errorStrandedWorking(mdPath) {
  let fresh;
  try {
    fresh = readComments(mdPath);
  } catch {
    return 0;
  }
  const ids = fresh.filter((c) => c.working).map((c) => c.id);
  if (ids.length) markErrored(mdPath, ids, 'interrupted: the watcher stopped mid-run');
  return ids.length;
}

// Stale/expired --resume target: claude printed this and never ran, so nothing was
// edited — the one provably-safe failure (drop session, retry cold). Any other failure may have fired an Edit.
function isResumeMiss(stdout, stderr, code) {
  return code !== 0 && stdout.trim() === '' && /no conversation found/i.test(stderr || '');
}

// cwd anchors the Claude session's project identity — folder tabs pass the tree
// root so one shared session spans every file
async function addressCore(mdPath, { runClaude: runClaudeImpl = runClaude, session = null, cwd, manifest = null, sessionName = null, liveFiles = null } = {}) {
  const comments = readComments(mdPath);
  // !isWorking excludes comments already 👀: the pre-run write below re-fires
  // the watcher, and the re-armed pass would otherwise run Claude on them twice.
  const open = comments.filter((c) => needsAddressing(c) && !isWorking(c));
  if (open.length === 0) return { applied: 0, skipped: true, session };

  console.log(`Addressing ${open.length} open comment(s) in ${path.basename(mdPath)}…`);

  setWorking(mdPath, open.map((c) => c.id), new Date().toISOString());

  const seen = session && session.seen ? session.seen : null;
  let stdout, stderr, code;
  try {
    ({ stdout, stderr, code } = await runClaudeImpl(
      buildPrompt(mdPath, open, seen, manifest),
      cwd || path.dirname(path.resolve(mdPath)),
      { sessionId: session ? session.id : null, name: sessionName || `anno: ${path.basename(mdPath)}` }
    ));
  } catch (err) {
    // runClaude rejects only on a spawn failure (missing binary, EACCES, EAGAIN) —
    // nothing ran/edited, but leaving 👀 set would loop the stale-retry silently
    // forever, so surface it as errored rather than strand the marker.
    markErrored(mdPath, open.map((c) => c.id), err.message);
    return { errored: open.length, session: null };
  }

  // Guard on session: a COLD run matching these signals isn't a resume miss, and
  // treating it as one loops the daemon forever (retry → miss → re-enqueue) with no circuit breaker.
  if (session && session.id && isResumeMiss(stdout, stderr, code)) {
    // Nothing ran/edited: release 👀 so the immediate cold retry re-reads these as open —
    // else the fresh markers filter them out (!isWorking) and the retry no-ops until stale-expiry.
    clearWorking(mdPath);
    return { resumeMiss: true, session: null };
  }

  // Non-zero exit: json output can't reveal whether an Edit fired — error, never
  // blind-retry. Drop the session so a reopen won't resume a failed conversation.
  if (code !== 0) {
    markErrored(mdPath, open.map((c) => c.id), stderr || stdout);
    return { errored: open.length, session: null };
  }

  let resultText = stdout;
  let sessionId = session ? session.id : null;
  try {
    const envelope = JSON.parse(stdout);
    if (envelope && typeof envelope.result === 'string') resultText = envelope.result;
    if (envelope && typeof envelope.session_id === 'string') sessionId = envelope.session_id;
  } catch {
    /* not the envelope — use stdout as-is */
  }

  const replies = extractJsonArray(resultText);
  if (!replies) {
    // exit 0 but unparseable — may have edited the doc; error, don't re-run (see markErrored)
    markErrored(mdPath, open.map((c) => c.id), resultText);
    return { errored: open.length, session: null };
  }

  // FRESH read, not the pre-run snapshot: user may have added comments mid-run;
  // writing the stale snapshot would drop them.
  const fresh = readComments(mdPath);
  const applied = mergeReplies(fresh, replies, new Date().toISOString());
  // Skip the no-op write when nothing applied — it would re-fire the watcher and
  // re-address every debounce. (mergeReplies clears 👀 on the ones it addressed.)
  if (applied > 0) writeComments(mdPath, fresh);

  // Rotated session_id ⇒ our watermark doesn't map to it: reset so the next batch
  // over-forwards (safe) not under-forwards. Else advance to what was FORWARDED — the
  // pre-run reply count, never post-merge: a reviewer reply written mid-run is in `fresh`
  // but not the prompt, and counting it would slice it out of every future resume.
  const idChanged = session && session.id && sessionId && sessionId !== session.id;
  const nextSeen = idChanged ? new Map() : seen || new Map();
  if (!idChanged) {
    const repliedIds = new Set(replies.map((r) => r.id));
    for (const c of open) {
      if (repliedIds.has(c.id)) nextSeen.set(`${mdPath}\n${c.id}`, (c.replies || []).length);
    }
    // prune deleted comments' watermarks — the map lives for the daemon's life, else grows unbounded
    const liveIds = new Set(fresh.map((c) => c.id));
    const prefix = `${mdPath}\n`;
    for (const k of nextSeen.keys()) {
      if (k.startsWith(prefix) && !liveIds.has(k.slice(prefix.length))) nextSeen.delete(k);
    }
    // …and for whole files deleted from the tree: the per-file prune above never
    // revisits a removed doc's keys, so without this they leak for the daemon's life.
    if (liveFiles) {
      const live = new Set([...liveFiles].map((f) => path.resolve(f)));
      live.add(path.resolve(mdPath));
      for (const k of nextSeen.keys()) {
        const nl = k.indexOf('\n');
        if (nl > 0 && !live.has(path.resolve(k.slice(0, nl)))) nextSeen.delete(k);
      }
    }
  }

  return { applied, session: sessionId ? { id: sessionId, seen: nextSeen } : null };
}

// Keep only well-formed, real-difference hunks; drop malformed/no-op entries so a
// half-cooperative agent can't strand a reply with an unrenderable diff.
function sanitizeHunks(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const h of raw) {
    if (!h || typeof h !== 'object') continue;
    const { before, after } = h;
    if (typeof before !== 'string' || typeof after !== 'string') continue;
    if (before === after) continue;
    out.push({ before, after });
  }
  return out;
}

// The agent's sanitized real hunks only — no synthetic fallback. Synthetic
// quote-diff fallbacks fabricated phantom diffs in mixed batches (a reply-only
// comment with a reworded newQuote got another comment's edit attributed to it);
// the agent's hunks are the only per-comment edit signal. Image comments with no
// text hunks naturally return [] via sanitizeHunks.
function resolveHunks(r) {
  return sanitizeHunks(r.hunks);
}

function mergeReplies(comments, replies, now) {
  const byId = new Map(comments.map((c) => [c.id, c]));
  let applied = 0;
  for (const r of replies) {
    const c = byId.get(r.id);
    if (!c) continue;
    c.replies = Array.isArray(c.replies) ? c.replies : [];
    const reply = { author: 'Claude', body: r.reply, createdAt: now, ai: true };
    const hunks = resolveHunks(r);
    if (hunks.length) reply.change = { hunks }; // additive sidecar field; absent ⇒ no diff button
    c.replies.push(reply);
    c.status = 'addressed';
    delete c.working;
    delete c.workingSince;
    delete c.errorDetail;
    delete c.erroredAt;
    // re-anchor by quote; stale char offsets would orphan the comment
    if (typeof r.newQuote === 'string' && r.newQuote.trim()) {
      c.quote = r.newQuote;
      delete c.start;
      delete c.end;
      delete c.prefix;
      delete c.suffix;
    }
    applied += 1;
  }
  return applied;
}

module.exports = { addressCore, mergeReplies, needsAddressing, clearWorking, errorStrandedWorking };
