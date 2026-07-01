const { spawn } = require('child_process');

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

function buildPrompt(mdPath, openComments) {
  const items = openComments.map((c) => {
    const item = { id: c.id, quote: c.quote, comment: c.body };
    // Carry prior turns so a re-opened thread answers the follow-up against the
    // current doc instead of re-applying the original comment.
    const replies = Array.isArray(c.replies) ? c.replies : [];
    if (replies.length) {
      item.thread = replies.map((r) => ({
        from: r.ai ? 'you' : 'reviewer',
        body: r.body,
      }));
    }
    return item;
  });
  return [
    'You are revising a markdown document based on reviewer comments.',
    '',
    `Edit this file IN PLACE using your Edit tool: ${mdPath}`,
    '',
    'Each comment below points at a quoted span of the document and asks for a',
    'change. Apply each change faithfully and minimally — do not rewrite',
    'untouched sections. Do NOT edit any .comments.json file.',
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

// prompt on stdin: argv would hit ARG_MAX on large comment sets
function runClaude(prompt, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      [
        '-p',
        '--permission-mode',
        'acceptEdits',
        // Edit is NOT dir-sandboxed — a prompt-injecting doc can modify any existing file the user can write (no-Write only blocks new-file creation). Trust model: only review files you trust.
        '--allowedTools',
        'Read,Edit',
        '--output-format',
        'json',
      ],
      { cwd, stdio: ['pipe', 'pipe', 'inherit'] }
    );
    activeChild = child;
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', (err) => {
      activeChild = null;
      reject(
        new Error(`Failed to run claude: ${err.message}. Is the Claude Code CLI on your PATH?`)
      );
    });
    child.on('close', (code) => {
      activeChild = null;
      if (code !== 0) return reject(new Error(`claude exited with code ${code}`));
      resolve(stdout);
    });
    child.stdin.end(prompt);
  });
}

module.exports = { extractJsonArray, buildPrompt, runClaude, killActiveChild };
