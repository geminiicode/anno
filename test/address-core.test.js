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

test('unwraps the JSON envelope, applies the reply, and writes it back', async () => {
  const md = seed([openComment()]);
  // The real CLI returns { result: "<text>" } under --output-format json.
  const fake = async () => JSON.stringify({ result: '[{"id":"c1","reply":"sped it up","newQuote":"fast"}]' });

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
    return JSON.stringify({
      result:
        '[{"id":"c1","reply":"sped it up","newQuote":"fast","hunks":[{"before":"quick brown fox","after":"fast brown fox"}]}]',
    });
  };

  await addressCore(md, { runClaude: fake });

  const reply = sidecar.readComments(md)[0].replies.at(-1);
  assert.deepEqual(reply.change, { hunks: [{ before: 'quick brown fox', after: 'fast brown fox' }] });
});

test('does NOT attach a diff when the agent only replied (no hunks) despite a reworded newQuote', async () => {
  const md = seed([openComment()]);
  // Agent rewords the anchor quote but returns no hunks — the only per-comment edit signal.
  const fake = async () => '[{"id":"c1","reply":"answered your question","newQuote":"fast"}]';

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
  const fake = async () => '[{"id":"c1","reply":"done"}]';

  const result = await addressCore(md, { runClaude: fake });

  assert.equal(result.applied, 1);
  assert.equal(sidecar.readComments(md)[0].replies.at(-1).body, 'done');
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
    return '[{"id":"c1","reply":"done"}]';
  };

  const result = await addressCore(md, { runClaude: fake });

  assert.equal(result.applied, 1);
  const after = sidecar.readComments(md);
  assert.deepEqual(after.map((c) => c.id).sort(), ['c1', 'c2']); // c2 survived
  assert.equal(after.find((c) => c.id === 'c2').status, 'open'); // untouched
});

test('throws (with truncated detail) when the output has no parseable array', async () => {
  const md = seed([openComment()]);
  const fake = async () => 'I edited the doc but forgot to print the array.';

  await assert.rejects(addressCore(md, { runClaude: fake }), /Could not parse replies/);
  // 👀 left set on failure so stale-retry re-checks it rather than tight-looping.
  assert.equal(sidecar.readComments(md)[0].working, true);
});

test('skips without invoking the agent when nothing is open', async () => {
  const md = seed([openComment({ status: 'resolved' })]);
  let called = false;
  const fake = async () => {
    called = true;
    return '[]';
  };

  const result = await addressCore(md, { runClaude: fake });

  assert.deepEqual(result, { applied: 0, skipped: true });
  assert.equal(called, false);
});

test('replies targeting unknown ids apply nothing — no reply, status stays open', async () => {
  const md = seed([openComment()]);
  const fake = async () => '[{"id":"nonexistent","reply":"nope"}]';

  const result = await addressCore(md, { runClaude: fake });

  assert.equal(result.applied, 0);
  const after = sidecar.readComments(md);
  assert.equal(after[0].status, 'open');
  assert.equal(after[0].replies.length, 0);
});
