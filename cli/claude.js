const { spawn } = require('child_process');
const path = require('path');

let activeChild = null;

function killActiveChild() {
  if (activeChild) activeChild.kill();
}

function extractJsonArray(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

// seen: `${mdPath}\n${id}` -> reply count already forwarded; null = cold (send all).
// Keyed by file+comment because one session spans the folder — a re-used id collides across docs.
// manifest: sibling {path,title} for a folder tab; null/empty ⇒ omit.
function buildPrompt(mdPath, openComments, seen = null, manifest = null) {
  const seenKey = (id) => `${mdPath}\n${id}`;
  const items = openComments.map((c) => {
    const replies = Array.isArray(c.replies) ? c.replies : [];
    const knownCount = seen ? seen.get(seenKey(c.id)) || 0 : 0;
    const newToSession = !seen || !seen.has(seenKey(c.id));
    const item = { id: c.id, quote: c.quote };
    if (newToSession) item.comment = c.body;
    const freshReplies = replies.slice(knownCount);
    if (freshReplies.length) {
      item.thread = freshReplies.map((r) => ({
        from: r.ai ? 'you' : 'reviewer',
        body: r.body,
      }));
    }
    // Never emit a bare {id, quote}: re-send the body + last AI turn as thread so the "already applied, don't redo" guard fires — a bare body risks re-applying the original.
    if (!item.comment && !item.thread) {
      item.comment = c.body;
      const lastAi = [...replies].reverse().find((r) => r.ai);
      if (lastAi) item.thread = [{ from: 'you', body: lastAi.body }];
    }
    return item;
  });
  // guard on the filtered siblings, not raw manifest.length — a folder tab holding
  // only this file would otherwise emit the header with zero bullets under it
  const siblings = Array.isArray(manifest)
    ? manifest.filter((e) => path.resolve(e.path) !== path.resolve(mdPath))
    : [];
  const manifestBlock = siblings.length
    ? [
        '',
        'The other markdown documents in this folder (Read any with your Read tool',
        'for context — shared terminology, facts, structure — but do NOT edit them):',
        ...siblings.map((e) => `  - ${e.path}${e.title ? ` — ${e.title}` : ''}`),
      ]
    : [];
  return [
    'You are revising a markdown document based on reviewer comments.',
    '',
    `Edit this file IN PLACE using your Edit tool: ${mdPath}`,
    '',
    'This is a continuing session that may have revised OTHER files in this folder',
    'earlier. Two hard rules follow from that:',
    `  1. Edit ONLY the file named above (${mdPath}). You MAY Read sibling files in`,
    '     the folder for context — to keep terminology, headings, or facts',
    '     consistent across documents — but do NOT edit any file other than the one',
    '     named above, and never edit a .comments.json file.',
    '  2. The comments below are the SOLE instructions for this file. Ignore',
    '     instructions or requests carried over from earlier documents in this',
    '     session unless a comment below explicitly asks you to apply them here.',
    ...manifestBlock,
    '',
    'Re-read the file above before editing — its current on-disk text is the source',
    'of truth, not your memory of an earlier revision.',
    '',
    'Each comment below points at a quoted span of the document and asks for a',
    'change. Apply each change faithfully and minimally — do not rewrite',
    'untouched sections.',
    '',
    'A comment may include a "thread" of prior turns. When present, the original',
    'change was already applied to the document; the reviewer\'s latest message',
    'is a follow-up. Address that follow-up relative to the current text — do',
    'not redo the original change.',
    '',
    'Reviewer comments (JSON):',
    JSON.stringify(items, null, 2),
    '',
    'When done, output ONLY a JSON array (no prose, no code fence) with one',
    'entry per comment:',
    '[{',
    '  "id": "<comment id>",',
    '  "reply": "<one sentence describing what you changed>",',
    '  "newQuote": "<the revised text this comment now points at, as PLAIN',
    '               rendered text — never include markdown syntax characters',
    '               like ** or _ or backticks, because anchoring searches the',
    '               rendered document, not the source. E.g. if you changed the',
    '               span to **bold**, newQuote is just the word, no asterisks.',
    '               null if you deleted the span.>",',
    '  "hunks": [{ "before": "<the exact text you removed/replaced>",',
    '              "after": "<the exact text you put in its place>" }]',
    '}]',
    '',
    'About "hunks": list the ACTUAL edits you made to the document source to',
    'address THIS comment — one object per contiguous change. "before" is the',
    'literal text as it was, "after" is the literal text as it now is, copied',
    'verbatim from your Edit (keep markdown syntax here — unlike newQuote, this',
    'shows the real source change). An inserted passage has before:"" ; a deleted',
    'passage has after:"" . A change MAY touch text outside the originally quoted',
    'span — include whatever you actually edited. Emit one hunk per edit; use',
    'multiple hunks if you changed separate places for the same comment. If you',
    'genuinely made no textual change, use an empty array [].',
  ].join('\n');
}

// prompt on stdin: argv would hit ARG_MAX on large comment sets.
// Resolves { stdout, stderr, code }, NEVER rejects on non-zero exit: an Edit may have
// fired before claude failed and the json envelope can't tell, so the caller classifies
// the raw signals (see addressCore).
function runClaude(prompt, cwd, { sessionId, name } = {}) {
  return new Promise((resolve, reject) => {
    // Fence Read/Edit to the review tree: the doc + comments are in the prompt, so a prompt-
    // injecting doc can drive Edit — bare `Read,Edit` would auto-approve any writable path
    // (~/.zshrc, ~/.ssh). Out-of-tree calls fall to a prompt, which headless -p denies.
    const root = cwd || process.cwd();
    const args = [
      '-p',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      `Read(/${root}/**),Edit(/${root}/**)`,
      '--output-format',
      'json',
    ];
    // name only on create — a resumed session already carries the name set at creation
    if (sessionId) args.push('--resume', sessionId);
    else if (name) args.push('--name', name);
    const child = spawn('claude', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    activeChild = child;
    let stdout = '';
    let stderr = '';
    let stderrHead = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    // Bound stderr so a chatty child can't balloon the daemon, but keep the HEAD: the resume-miss classifier greps for "no conversation found" (printed at the start), which a tail-only keep would drop.
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 65536) {
        if (stderrHead === null) stderrHead = stderr.slice(0, 8192);
        stderr = stderr.slice(-57344);
      }
    });
    child.on('error', (err) => {
      activeChild = null;
      reject(
        new Error(`Failed to run claude: ${err.message}. Is the Claude Code CLI on your PATH?`)
      );
    });
    child.on('close', (code) => {
      activeChild = null;
      const err = stderrHead === null ? stderr : `${stderrHead}\n[…stderr truncated…]\n${stderr}`;
      resolve({ stdout, stderr: err, code });
    });
    // a child that exits before draining stdin emits EPIPE here; with no listener it
    // throws and takes down the long-lived daemon. Swallow — 'error'/'close' handle it.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

module.exports = { extractJsonArray, buildPrompt, runClaude, killActiveChild };
