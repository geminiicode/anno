require('./helpers/store-env.js'); // must precede any core/ import
const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractJsonArray, buildPrompt } = require('../cli/claude.js');
const { mergeReplies, needsAddressing, clearWorking } = require('../cli/address.js');
const { writeComments, readComments } = require('../core/sidecar.js');

// ---------- extractJsonArray ----------

test('extractJsonArray parses a bare array', () => {
  assert.deepEqual(extractJsonArray('[{"id":"c1"}]'), [{ id: 'c1' }]);
});

test('extractJsonArray parses a fenced array with prose around it', () => {
  const text = 'Here you go:\n```json\n[{"id":"c1"}]\n```\nDone!';
  assert.deepEqual(extractJsonArray(text), [{ id: 'c1' }]);
});

test('extractJsonArray finds the array inside chatty unfenced output', () => {
  const text = 'I made the changes. [{"id":"c1","reply":"done"}] Hope that helps.';
  assert.deepEqual(extractJsonArray(text), [{ id: 'c1', reply: 'done' }]);
});

test('extractJsonArray returns null on garbage and empty input', () => {
  assert.equal(extractJsonArray('no array here'), null);
  assert.equal(extractJsonArray(''), null);
  assert.equal(extractJsonArray('[broken'), null);
});

// Regression: a stray `[` before the real array (a `[12:53:43]` timestamp, a markdown
// [link]) once got swallowed by first-`[`/last-`]` slicing, erroring the whole batch.
test('extractJsonArray skips a leading bracket that is not the reply array', () => {
  const arr = [{ id: 'c1', reply: 'done', hunks: [] }];
  assert.deepEqual(extractJsonArray('[12:53:43] ' + JSON.stringify(arr)), arr);
  assert.deepEqual(extractJsonArray('see [docs] then ' + JSON.stringify(arr)), arr);
  assert.deepEqual(extractJsonArray('note [1,2] first ' + JSON.stringify(arr)), arr);
});

test('extractJsonArray is not fooled by brackets inside JSON strings', () => {
  const arr = [{ id: 'c1', reply: 'has ] and [ inside' }];
  assert.deepEqual(extractJsonArray('[00:00:00] ' + JSON.stringify(arr)), arr);
});

// ---------- mergeReplies ----------

test('mergeReplies marks addressed, attaches reply, re-anchors quote', () => {
  const comments = [
    { id: 'c1', quote: 'old text', body: 'fix it', status: 'open', start: 5, end: 13, prefix: 'x', suffix: 'y' },
  ];
  const applied = mergeReplies(
    comments,
    [{ id: 'c1', reply: 'Rewrote it.', newQuote: 'new text' }],
    '2026-01-01T00:00:00Z'
  );
  assert.equal(applied, 1);
  const c = comments[0];
  assert.equal(c.status, 'addressed');
  assert.equal(c.quote, 'new text');
  assert.equal(c.replies[0].body, 'Rewrote it.');
  assert.equal(c.replies[0].ai, true);
  assert.ok(!('start' in c) && !('end' in c) && !('prefix' in c) && !('suffix' in c));
});

test('mergeReplies clears the 👀 working marker when it addresses a comment', () => {
  const comments = [
    { id: 'c1', quote: 'q', body: 'b', status: 'open', working: true, workingSince: '2026-01-01T00:00:00Z' },
  ];
  mergeReplies(comments, [{ id: 'c1', reply: 'done', newQuote: 'q2' }], '2026-01-01T00:05:00Z');
  const c = comments[0];
  assert.equal(c.status, 'addressed');
  assert.ok(!('working' in c) && !('workingSince' in c), 'addressed ⇒ no longer working');
});

test('mergeReplies keeps the old quote when newQuote is null (span deleted)', () => {
  const comments = [{ id: 'c1', quote: 'kept', body: 'b', status: 'open', start: 0, end: 4 }];
  mergeReplies(comments, [{ id: 'c1', reply: 'Deleted the span.', newQuote: null }], 'now');
  assert.equal(comments[0].quote, 'kept');
  assert.equal(comments[0].start, 0); // offsets survive so the editor can try them
});

test('mergeReplies ignores replies for comments deleted mid-run', () => {
  const comments = [{ id: 'c2', quote: 'q', body: 'b', status: 'open' }];
  const applied = mergeReplies(comments, [{ id: 'c1', reply: 'gone' }], 'now');
  assert.equal(applied, 0);
  assert.equal(comments[0].status, 'open');
});

test('mergeReplies leaves comments added during the run untouched (race regression)', () => {
  // The fresh sidecar read contains a comment that did not exist when the
  // revision started; merging must preserve it as-is.
  const comments = [
    { id: 'c1', quote: 'q1', body: 'b1', status: 'open' },
    { id: 'c_new', quote: 'q2', body: 'added mid-run', status: 'open' },
  ];
  const applied = mergeReplies(comments, [{ id: 'c1', reply: 'done' }], 'now');
  assert.equal(applied, 1);
  assert.equal(comments[1].status, 'open');
  assert.equal(comments[1].body, 'added mid-run');
});

// ---------- mergeReplies: per-comment change hunks ----------

test('mergeReplies stores Claude-supplied hunks on the AI reply', () => {
  const comments = [{ id: 'c1', quote: 'old', body: 'b', status: 'open' }];
  mergeReplies(
    comments,
    [{ id: 'c1', reply: 'Fixed.', newQuote: 'new', hunks: [{ before: 'old para', after: 'new para' }] }],
    'now'
  );
  assert.deepEqual(comments[0].replies.at(-1).change, { hunks: [{ before: 'old para', after: 'new para' }] });
});

test('mergeReplies attaches no change when the agent omits hunks (reply only)', () => {
  const comments = [{ id: 'c1', quote: 'quick', body: 'b', status: 'open' }];
  mergeReplies(comments, [{ id: 'c1', reply: 'Sped it up.', newQuote: 'fast' }], 'now');
  // No synthetic span-diff: the agent's hunks are the only per-comment edit signal.
  assert.ok(!('change' in comments[0].replies.at(-1)), 'no hunks ⇒ no diff button');
  assert.equal(comments[0].quote, 'fast'); // re-anchoring still happened, independent of hunks
});

test('mergeReplies drops malformed / no-op hunks → no change', () => {
  const comments = [{ id: 'c1', quote: 'old', body: 'b', status: 'open' }];
  mergeReplies(
    comments,
    [{ id: 'c1', reply: 'Fixed.', newQuote: 'new', hunks: [{ before: 'same', after: 'same' }, { junk: true }] }],
    'now'
  );
  assert.ok(!('change' in comments[0].replies.at(-1)), 'all hunks malformed/no-op ⇒ no diff button');
});

test('mergeReplies keeps a real hunk alongside dropped malformed ones', () => {
  const comments = [{ id: 'c1', quote: 'old', body: 'b', status: 'open' }];
  mergeReplies(
    comments,
    [{ id: 'c1', reply: 'Fixed.', newQuote: 'new', hunks: [{ before: 'same', after: 'same' }, { before: 'a', after: 'b' }] }],
    'now'
  );
  assert.deepEqual(comments[0].replies.at(-1).change, { hunks: [{ before: 'a', after: 'b' }] });
});

test('mergeReplies attaches no change for an image comment with no hunks', () => {
  const comments = [{ id: 'c1', quote: 'diagram.png', body: 'b', status: 'open', imageSrc: 'diagram.png' }];
  mergeReplies(comments, [{ id: 'c1', reply: 'Noted.', newQuote: null }], 'now');
  assert.ok(!('change' in comments[0].replies.at(-1)), 'image comment with no edit ⇒ no bogus diff');
});

// ---------- needsAddressing ----------

test('needsAddressing: a fresh open comment needs a pass', () => {
  assert.equal(needsAddressing({ status: 'open' }), true);
  assert.equal(needsAddressing({}), true); // status defaults to open
});

test('needsAddressing: an addressed comment with no new reply is done', () => {
  const c = { status: 'addressed', replies: [{ body: 'Rewrote it.', ai: true }] };
  assert.equal(needsAddressing(c), false);
});

test('needsAddressing: a reviewer follow-up re-opens an addressed thread', () => {
  const c = {
    status: 'addressed',
    replies: [
      { body: 'Rewrote it.', ai: true },
      { body: 'No, make it shorter.', ai: false },
    ],
  };
  assert.equal(needsAddressing(c), true);
});

test('needsAddressing: resolved threads stay closed even with a trailing reply', () => {
  const c = { status: 'resolved', replies: [{ body: 'one more thing', ai: false }] };
  assert.equal(needsAddressing(c), false);
});

test('needsAddressing: an addressed comment with empty/missing replies is done', () => {
  assert.equal(needsAddressing({ status: 'addressed', replies: [] }), false);
  assert.equal(needsAddressing({ status: 'addressed' }), false); // guards array access
});

test('needsAddressing: a reply missing the ai flag counts as the reviewer', () => {
  // mergeReplies has always stamped AI replies with ai:true, so a reply lacking
  // the flag (legacy sidecar) is a human turn — re-qualify it.
  const c = { status: 'addressed', replies: [{ body: 'legacy human note' }] };
  assert.equal(needsAddressing(c), true);
});

test('mergeReplies output is not re-addressable (no watcher loop)', () => {
  // The no-infinite-loop guarantee: after a pass, the appended AI reply is the
  // last turn, so the write that re-fires the watcher finds nothing to do.
  const comments = [
    {
      id: 'c1',
      quote: 'q',
      body: 'b',
      status: 'addressed',
      replies: [
        { body: 'Rewrote it.', ai: true },
        { body: 'No, shorter.', ai: false },
      ],
    },
  ];
  assert.equal(needsAddressing(comments[0]), true); // reviewer follow-up qualifies
  mergeReplies(comments, [{ id: 'c1', reply: 'Shortened it.', newQuote: 'q' }], 'now');
  assert.equal(needsAddressing(comments[0]), false); // and is closed after the pass
});

// ---------- clearWorking (one-shot exit cleanup) ----------

test('clearWorking strips 👀 markers but leaves every other field intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anno-clear-'));
  const md = path.join(dir, 'doc.md');
  writeComments(md, [
    { id: 'a', body: 'x', status: 'open', working: true, workingSince: '2026-01-01T00:00:00Z' },
    { id: 'b', body: 'y', status: 'addressed', replies: [{ body: 'done', ai: true }] },
  ]);
  clearWorking(md);
  const out = readComments(md);
  assert.ok(!('working' in out[0]) && !('workingSince' in out[0]));
  assert.equal(out[0].status, 'open'); // status untouched — only the marker is cleared
  assert.equal(out[1].status, 'addressed');
  assert.equal(out[1].replies[0].body, 'done');
});

// ---------- buildPrompt ----------

test('buildPrompt embeds the file path and each open comment', () => {
  const p = buildPrompt('/tmp/notes.md', [{ id: 'c1', quote: 'q', body: 'change this' }]);
  assert.ok(p.includes('/tmp/notes.md'));
  assert.ok(p.includes('"change this"'));
  assert.ok(p.includes('"c1"'));
});

test('buildPrompt with no replies omits a thread', () => {
  const p = buildPrompt('/tmp/notes.md', [{ id: 'c1', quote: 'q', body: 'change this' }]);
  // "from" only appears inside serialized thread items, never in the static
  // instructions — so its absence proves no thread was attached.
  assert.ok(!p.includes('"from"'));
});

test('buildPrompt carries the reply thread for a re-opened comment', () => {
  const p = buildPrompt('/tmp/notes.md', [
    {
      id: 'c1',
      quote: 'q',
      body: 'change this',
      replies: [
        { body: 'Rewrote it.', ai: true },
        { body: 'No, make it shorter.', ai: false },
      ],
    },
  ]);
  assert.ok(p.includes('"thread"'));
  assert.ok(p.includes('"from": "you"'));
  assert.ok(p.includes('"from": "reviewer"'));
  assert.ok(p.includes('No, make it shorter.'));
});

// ---------- HELP.md ----------
// guard HELP.md ships, not its contents — it's a tips reference, not a command index
test('HELP.md ships and is non-empty', () => {
  const help = fs.readFileSync(path.join(__dirname, '..', 'HELP.md'), 'utf8');
  assert.ok(help.trim().length > 0, 'HELP.md must not be empty');
});
