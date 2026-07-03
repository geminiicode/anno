// Drives the assembled address loop (envelope unwrap → extract → fresh-reread
// reconcile → write) with a fake runClaude and a real temp sidecar. cli.test.js
// covers the pure pieces (extractJsonArray, mergeReplies) separately.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { addressCore, mergeReplies } = require('../cli/address.js');
const sidecar = require('../core/sidecar.js');

// A temp doc + sidecar seeded with the given comments. Returns the md path.
function seed(comments, body = '# Doc\n\nThe quick brown fox.\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anno-addr-'));
  const md = path.join(dir, 'doc.md');
  fs.writeFileSync(md, body);
  sidecar.writeComments(md, comments);
  return md;
}

const openComment = (over = {}) => ({
  id: 'c1',
  quote: 'quick',
  body: 'make it faster',
  status: 'open',
  replies: [],
  ...over,
});

const ok = (stdout) => ({ stdout, stderr: '', code: 0 });

test('unwraps the JSON envelope, applies the reply, and writes it back', async () => {
  const md = seed([openComment()]);
  // The real CLI returns { result: "<text>" } under --output-format json.
  const fake = async () => ok(JSON.stringify({ result: '[{"id":"c1","reply":"sped it up","newQuote":"fast"}]' }));

  const result = await addressCore(md, { runClaude: fake });

  assert.equal(result.applied, 1);
  const after = sidecar.readComments(md);
  assert.equal(after[0].status, 'addressed');
  assert.equal(after[0].replies.at(-1).body, 'sped it up');
  assert.equal(after[0].replies.at(-1).ai, true);
  assert.equal(after[0].quote, 'fast'); // re-anchored by newQuote
  assert.ok(!('start' in after[0]) && !('end' in after[0])); // stale offsets cleared
  assert.ok(!('working' in after[0]), '👀 cleared on success (→ ✅)');
});

test('persists Claude hunks onto the AI reply through the sidecar round-trip', async () => {
  const md = seed([openComment()]);
  const fake = async () => {
    fs.writeFileSync(md, '# Doc\n\nThe fast brown fox.\n'); // agent actually edits the doc
    return ok(JSON.stringify({
      result:
        '[{"id":"c1","reply":"sped it up","newQuote":"fast","hunks":[{"before":"quick brown fox","after":"fast brown fox"}]}]',
    }));
  };

  await addressCore(md, { runClaude: fake });

  const reply = sidecar.readComments(md)[0].replies.at(-1);
  assert.deepEqual(reply.change, { hunks: [{ before: 'quick brown fox', after: 'fast brown fox' }] });
});

test('does NOT attach a diff when the agent only replied (no hunks) despite a reworded newQuote', async () => {
  const md = seed([openComment()]);
  // Agent rewords the anchor quote but returns no hunks — the only per-comment edit signal.
  const fake = async () => ok('[{"id":"c1","reply":"answered your question","newQuote":"fast"}]');

  const result = await addressCore(md, { runClaude: fake });

  assert.equal(result.applied, 1);
  const after = sidecar.readComments(md)[0];
  const reply = after.replies.at(-1);
  assert.ok(!('change' in reply), 'no diff button without agent hunks');
  assert.equal(after.quote, 'fast'); // re-anchoring still works, independent of hunks
});

// Drive resolveHunks via the exported mergeReplies: returns the change hunks the
// reply ends up with (or undefined when no change field was attached).
function changeFor(reply) {
  const c = openComment();
  mergeReplies([c], [{ id: 'c1', reply: 'x', ...reply }], 'now');
  return c.replies.at(-1).change;
}

test('unit: real agent hunks become the reply change', () => {
  const r = { newQuote: 'fast', hunks: [{ before: 'quick brown fox', after: 'fast brown fox' }] };
  assert.deepEqual(changeFor(r), { hunks: [{ before: 'quick brown fox', after: 'fast brown fox' }] });
});

test('unit: no hunks (reply only, even with a reworded newQuote) → no change field', () => {
  assert.equal(changeFor({ newQuote: 'fast' }), undefined);
});

test('unit: malformed / no-op hunks are dropped by sanitizeHunks → no change', () => {
  assert.equal(changeFor({ hunks: [{ before: 'same', after: 'same' }] }), undefined); // no-op
  assert.equal(changeFor({ hunks: [{ before: 1, after: 2 }] }), undefined); // non-string
});

test('accepts a bare (non-envelope) array from the agent', async () => {
  const md = seed([openComment()]);
  const fake = async () => ok('[{"id":"c1","reply":"done"}]');

  const result = await addressCore(md, { runClaude: fake });

  assert.equal(result.applied, 1);
  assert.equal(sidecar.readComments(md)[0].replies.at(-1).body, 'done');
});

test('forwards an anno-prefixed session name to runClaude — doc basename by default, sessionName overrides', async () => {
  const md = seed([openComment()]);
  const calls = [];
  const fake = async (_prompt, _cwd, opts) => {
    calls.push(opts);
    return ok('[{"id":"c1","reply":"done"}]');
  };

  await addressCore(md, { runClaude: fake });
  assert.equal(calls[0].name, `anno: ${path.basename(md)}`);

  sidecar.writeComments(md, [openComment()]); // reopen for a second pass
  await addressCore(md, { runClaude: fake, sessionName: 'anno: notes/' });
  assert.equal(calls[1].name, 'anno: notes/'); // folder-tab label wins over the default
});

test('reconciles against a FRESH read so a comment added mid-run is not dropped', async () => {
  const md = seed([openComment()]);
  // Simulate the user adding c2 while the agent was running: the fake mutates
  // the sidecar before resolving. addressCore must re-read, not write its stale
  // pre-run snapshot.
  const fake = async () => {
    const now = sidecar.readComments(md);
    now.push(openComment({ id: 'c2', quote: 'brown', body: 'recolor' }));
    sidecar.writeComments(md, now);
    return ok('[{"id":"c1","reply":"done"}]');
  };

  const result = await addressCore(md, { runClaude: fake });

  assert.equal(result.applied, 1);
  const after = sidecar.readComments(md);
  assert.deepEqual(after.map((c) => c.id).sort(), ['c1', 'c2']); // c2 survived
  assert.equal(after.find((c) => c.id === 'c2').status, 'open'); // untouched
});

test('exit 0 but no parseable array → errored (not a blind retry that double-applies)', async () => {
  const md = seed([openComment()]);
  const fake = async () => ok('I edited the doc but forgot to print the array.');

  const result = await addressCore(md, { runClaude: fake });

  assert.equal(result.errored, 1);
  const after = sidecar.readComments(md)[0];
  assert.equal(after.status, 'errored');
  assert.ok(!after.working, '👀 cleared so stale-retry will NOT re-run against the edited doc');
  assert.ok(after.errorDetail.includes('forgot to print'));
});

test('non-zero exit → errored (an Edit may have fired; never guess)', async () => {
  const md = seed([openComment()]);
  const fake = async () => ({ stdout: '', stderr: 'boom', code: 1 });

  const result = await addressCore(md, { runClaude: fake });

  assert.equal(result.errored, 1);
  const after = sidecar.readComments(md)[0];
  assert.equal(after.status, 'errored');
  assert.ok(!after.working);
});

test('resume miss (empty stdout + No conversation found) → resumeMiss, session dropped', async () => {
  const md = seed([openComment()]);
  const fake = async () => ({ stdout: '', stderr: 'No conversation found with session ID abc', code: 1 });

  const result = await addressCore(md, { runClaude: fake, session: { id: 'abc', seen: new Map() } });

  assert.deepEqual(result, { resumeMiss: true, session: null });
  assert.notEqual(sidecar.readComments(md)[0].status, 'errored');
});

test('resume miss clears the working marker so the daemon\'s cold retry actually runs', async () => {
  const md = seed([openComment()]);
  const miss = async () => ({ stdout: '', stderr: 'No conversation found with session ID abc', code: 1 });

  const r1 = await addressCore(md, { runClaude: miss, session: { id: 'abc', seen: new Map() } });
  assert.equal(r1.resumeMiss, true);
  assert.ok(!sidecar.readComments(md)[0].working, 'working marker cleared after resume-miss');

  const r2 = await addressCore(md, { runClaude: async () => ok('[{"id":"c1","reply":"done"}]'), session: null });
  assert.equal(r2.applied, 1);
  assert.equal(sidecar.readComments(md)[0].status, 'addressed');
});

test('warm resume forwards only the new turn and advances the watermark', async () => {
  const md = seed([openComment()]);
  let seenPrompt;
  const capture = async (prompt) => {
    seenPrompt = prompt;
    return { stdout: JSON.stringify({ result: '[{"id":"c1","reply":"ok"}]', session_id: 's1' }), stderr: '', code: 0 };
  };

  const first = await addressCore(md, { runClaude: capture });
  assert.ok(seenPrompt.includes('make it faster'), 'cold run forwards the comment body');
  assert.equal(first.session.id, 's1');

  const reopened = sidecar.readComments(md);
  reopened[0].replies.push({ author: 'Me', body: 'also shorten it', ai: false });
  sidecar.writeComments(md, reopened);

  await addressCore(md, { runClaude: capture, session: first.session });
  assert.ok(seenPrompt.includes('also shorten it'), 'warm run forwards the new follow-up');
  assert.ok(!seenPrompt.includes('make it faster'), 'warm run does NOT replay the original body');
});

test('one session shared across folder files: file B resumes A but still gets its own body', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anno-shared-'));
  const mdA = path.join(dir, 'a.md');
  const mdB = path.join(dir, 'b.md');
  fs.writeFileSync(mdA, '# A\n\nalpha text.\n');
  fs.writeFileSync(mdB, '# B\n\nbravo text.\n');
  sidecar.writeComments(mdA, [openComment({ id: 'c1', quote: 'alpha', body: 'fix alpha' })]);
  sidecar.writeComments(mdB, [openComment({ id: 'c1', quote: 'bravo', body: 'fix bravo' })]); // same id, different file

  let seenPrompt, seenSessionId;
  const capture = async (prompt, _cwd, opts) => {
    seenPrompt = prompt;
    seenSessionId = opts && opts.sessionId;
    return { stdout: JSON.stringify({ result: '[{"id":"c1","reply":"ok"}]', session_id: 's1' }), stderr: '', code: 0 };
  };

  const afterA = await addressCore(mdA, { runClaude: capture, cwd: dir });
  assert.equal(afterA.session.id, 's1');

  await addressCore(mdB, { runClaude: capture, session: afterA.session, cwd: dir });
  assert.equal(seenSessionId, 's1', 'file B resumes the shared session');
  assert.ok(seenPrompt.includes('fix bravo'), 'B forwards its own body despite the id collision with A');
  assert.ok(seenPrompt.includes(mdB), 'B is told to edit its own file');
});

test('folder manifest is injected into the prompt and excludes the target file', async () => {
  const md = seed([openComment()]);
  let seenPrompt;
  const capture = async (prompt) => {
    seenPrompt = prompt;
    return ok('[{"id":"c1","reply":"ok"}]');
  };
  const manifest = [
    { path: md, title: 'Target' }, // the target itself must be filtered out
    { path: '/docs/glossary.md', title: 'Glossary' },
    { path: '/docs/notes.md', title: '' }, // untitled — path only
  ];

  await addressCore(md, { runClaude: capture, manifest });

  assert.ok(seenPrompt.includes('/docs/glossary.md — Glossary'), 'sibling with title listed');
  assert.ok(seenPrompt.includes('/docs/notes.md'), 'untitled sibling listed by path');
  assert.ok(!seenPrompt.includes(`${md} — Target`), 'the target file is not listed as a sibling');
});

test('no manifest section when none is provided (single-file tab)', async () => {
  const md = seed([openComment()]);
  let seenPrompt;
  const capture = async (prompt) => {
    seenPrompt = prompt;
    return ok('[{"id":"c1","reply":"ok"}]');
  };

  await addressCore(md, { runClaude: capture });

  assert.ok(!seenPrompt.includes('other markdown documents in this folder'), 'manifest section omitted');
});

test('skips without invoking the agent when nothing is open', async () => {
  const md = seed([openComment({ status: 'resolved' })]);
  let called = false;
  const fake = async () => {
    called = true;
    return ok('[]');
  };

  const warmSession = { id: 's1', seen: new Map() };
  const result = await addressCore(md, { runClaude: fake, session: warmSession });

  assert.equal(result.applied, 0);
  assert.equal(result.skipped, true);
  assert.equal(called, false);
  assert.equal(result.session, warmSession, 'warm session survives an idle/skipped batch');
});

test('replies targeting unknown ids apply nothing — no reply, status stays open', async () => {
  const md = seed([openComment()]);
  const fake = async () => ok('[{"id":"nonexistent","reply":"nope"}]');

  const result = await addressCore(md, { runClaude: fake });

  assert.equal(result.applied, 0);
  const after = sidecar.readComments(md);
  assert.equal(after[0].status, 'open');
  assert.equal(after[0].replies.length, 0);
});

test('reviewer reply added MID-RUN is still forwarded on the next warm resume', async () => {
  const md = seed([openComment()]);
  let seenPrompt;
  const midRunReply = async (prompt) => {
    seenPrompt = prompt;
    // Reviewer adds a follow-up to disk while claude is still running: it lands in
    // the post-merge fresh read but was never in this prompt. The watermark must
    // count only what was forwarded, or this turn is sliced out forever.
    const during = sidecar.readComments(md);
    during[0].replies.push({ author: 'Me', body: 'also do X', ai: false });
    sidecar.writeComments(md, during);
    return { stdout: JSON.stringify({ result: '[{"id":"c1","reply":"done"}]', session_id: 's1' }), stderr: '', code: 0 };
  };

  const first = await addressCore(md, { runClaude: midRunReply });
  assert.ok(!seenPrompt.includes('also do X'), 'sanity: the mid-run reply was not in the first prompt');

  const reopened = sidecar.readComments(md);
  reopened[0].replies.push({ author: 'Me', body: 'and also Y', ai: false });
  sidecar.writeComments(md, reopened);

  const capture = async (prompt) => {
    seenPrompt = prompt;
    return { stdout: JSON.stringify({ result: '[{"id":"c1","reply":"did X and Y"}]', session_id: 's1' }), stderr: '', code: 0 };
  };
  await addressCore(md, { runClaude: capture, session: first.session });
  assert.ok(seenPrompt.includes('and also Y'), 'the reopening turn is forwarded');
  assert.ok(seenPrompt.includes('also do X'), 'the mid-run reply is forwarded on the next warm batch');
});

test('cold run matching the resume-miss signals is errored, not looped as a resume miss', async () => {
  const md = seed([openComment()]);
  const fake = async () => ({ stdout: '', stderr: 'No conversation found with session ID abc', code: 1 });

  const result = await addressCore(md, { runClaude: fake, session: null });

  assert.ok(!result.resumeMiss, 'cold run never classifies as resume miss');
  assert.equal(result.errored, 1);
  assert.equal(sidecar.readComments(md)[0].status, 'errored');
});

test('startup sweep errors stranded 👀 markers instead of leaving them for stale-retry', () => {
  const { errorStrandedWorking } = require('../cli/address.js');
  const md = seed([
    openComment({ working: true, workingSince: new Date().toISOString() }),
    openComment({ id: 'c2', quote: 'brown' }),
  ]);

  const swept = errorStrandedWorking(md);

  assert.equal(swept, 1);
  const after = sidecar.readComments(md);
  assert.equal(after[0].status, 'errored');
  assert.ok(!after[0].working, 'marker cleared');
  assert.match(after[0].errorDetail, /interrupted/);
  assert.equal(after[1].status, 'open', 'non-working comment untouched');
});

test('re-addressing a reopened errored comment clears the stale error fields', async () => {
  const md = seed([
    openComment({ status: 'open', errorDetail: 'old failure', erroredAt: '2026-01-01T00:00:00.000Z' }),
  ]);
  const fake = async () => ok('[{"id":"c1","reply":"fixed"}]');

  await addressCore(md, { runClaude: fake });

  const after = sidecar.readComments(md);
  assert.equal(after[0].status, 'addressed');
  assert.ok(!('errorDetail' in after[0]), 'stale errorDetail removed');
  assert.ok(!('erroredAt' in after[0]), 'stale erroredAt removed');
});

test('watermark entries for deleted comments are pruned from the shared seen map', async () => {
  const md = seed([openComment()]);
  const fake = async () => ok(JSON.stringify({ result: '[{"id":"c1","reply":"ok"}]', session_id: 's1' }));

  const seen = new Map([[`${md}\nghost`, 3]]); // watermark for a comment that no longer exists
  const result = await addressCore(md, { runClaude: fake, session: { id: 's1', seen } });

  assert.ok(!result.session.seen.has(`${md}\nghost`), 'deleted comment pruned');
  assert.ok(result.session.seen.has(`${md}\nc1`), 'live comment watermark kept');
});

test('watermarks for a whole file deleted from the tree are pruned via liveFiles', async () => {
  const md = seed([openComment()]);
  const ghostFile = path.join(path.dirname(md), 'gone.md'); // a doc no longer in the tree
  const fake = async () => ok(JSON.stringify({ result: '[{"id":"c1","reply":"ok"}]', session_id: 's1' }));

  const seen = new Map([[`${ghostFile}\nc9`, 2], [`${md}\nc1`, 0]]);
  const result = await addressCore(md, { runClaude: fake, session: { id: 's1', seen }, liveFiles: [md] });

  const keys = [...result.session.seen.keys()];
  assert.ok(!keys.some((k) => k.startsWith(`${ghostFile}\n`)), 'deleted-file watermark pruned');
  assert.ok(result.session.seen.has(`${md}\nc1`), 'surviving-file watermark kept');
});

test('a rotated session_id resets the watermark map instead of mis-mapping it', async () => {
  const md = seed([openComment()]);
  const seen = new Map([[`${md}\nc1`, 1]]);
  const fake = async () => ok(JSON.stringify({ result: '[{"id":"c1","reply":"ok"}]', session_id: 's2' }));

  const result = await addressCore(md, { runClaude: fake, session: { id: 's1', seen } });

  assert.equal(result.session.id, 's2');
  assert.equal(result.session.seen.size, 0, 'watermarks reset on rotation (next batch over-forwards cold)');
});

test('a runClaude spawn rejection errors the batch instead of stranding 👀', async () => {
  const md = seed([openComment()]);
  const fake = async () => { throw new Error('Failed to run claude: spawn ENOENT'); };

  const result = await addressCore(md, { runClaude: fake });

  assert.equal(result.errored, 1);
  assert.equal(result.session, null);
  const after = sidecar.readComments(md)[0];
  assert.equal(after.status, 'errored');
  assert.ok(!('working' in after), '👀 cleared on spawn failure — no stranded marker to loop the stale-retry');
});

test('scrubDetail redacts home paths and session ids from the persisted errorDetail', async () => {
  const md = seed([openComment()]);
  const leaky = `crashed at ${os.homedir()}/proj and /Users/someoneelse/x, session 019ed490-ba70-4a84-b2db-82589580fc71`;
  const fake = async () => ({ stdout: '', stderr: leaky, code: 1 }); // non-zero exit → markErrored(stderr)

  await addressCore(md, { runClaude: fake });

  const detail = sidecar.readComments(md)[0].errorDetail;
  assert.ok(!detail.includes(os.homedir()), 'own home path redacted');
  assert.ok(!detail.includes('/Users/someoneelse'), 'other-user home path redacted');
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(detail), 'session-id UUID redacted');
  assert.ok(detail.includes('~') && detail.includes('<id>'), 'redaction markers present');
});
