const fs = require('fs');
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

async function addressCore(mdPath, { runClaude: runClaudeImpl = runClaude } = {}) {
  const comments = readComments(mdPath);
  // !isWorking excludes comments already 👀: the pre-run write below re-fires
  // the watcher, and the re-armed pass would otherwise run Claude on them twice.
  const open = comments.filter((c) => needsAddressing(c) && !isWorking(c));
  if (open.length === 0) return { applied: 0, skipped: true };

  console.log(`Addressing ${open.length} open comment(s) in ${path.basename(mdPath)}…`);

  // 👀 before the (long) run. Left set on any non-success exit so a failed run
  // stale-expires and backs off (via !isWorking above) instead of tight-looping.
  setWorking(mdPath, open.map((c) => c.id), new Date().toISOString());

  const stdout = await runClaudeImpl(buildPrompt(mdPath, open), path.dirname(path.resolve(mdPath)));

  let resultText = stdout;
  try {
    const envelope = JSON.parse(stdout);
    if (envelope && typeof envelope.result === 'string') resultText = envelope.result;
  } catch {
    /* not the envelope — use stdout as-is */
  }

  const replies = extractJsonArray(resultText);
  if (!replies) {
    const err = new Error('Could not parse replies from Claude output (doc may still have been edited).');
    err.detail = resultText.slice(0, 2000);
    throw err;
  }

  // FRESH read, not the pre-run snapshot: user may have added comments mid-run;
  // writing the stale snapshot would drop them.
  const fresh = readComments(mdPath);
  const applied = mergeReplies(fresh, replies, new Date().toISOString());
  // Skip the no-op write when nothing applied — it would re-fire the watcher and
  // re-address every debounce. (mergeReplies clears 👀 on the ones it addressed.)
  if (applied > 0) writeComments(mdPath, fresh);
  return { applied };
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

async function address(mdPath) {
  if (!fs.existsSync(mdPath)) {
    console.error(`File not found: ${mdPath}`);
    process.exit(1);
  }
  try {
    const result = await addressCore(mdPath);
    if (result.skipped) {
      console.log('No open comments to address.');
    } else {
      console.log(`Done. Updated ${result.applied} comment(s) to "addressed" with replies.`);
      console.log('Reopen the file in the editor to see the revisions and replies.');
    }
  } catch (err) {
    console.error(err.message);
    if (err.detail) console.error(err.detail);
    process.exitCode = 1; // exitCode (not exit) so the finally clears markers first
  } finally {
    clearWorking(mdPath);
  }
}

module.exports = { addressCore, mergeReplies, needsAddressing, clearWorking, address };
