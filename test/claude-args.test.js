// Security regression: runClaude must scope Read/Edit to the review tree, never bare. A bare
// `Read,Edit` under acceptEdits auto-approves edits to any writable file. Patch spawn pre-require
// so claude.js binds the fake at import.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const child_process = require('child_process');
const path = require('path');

let captured = null;
child_process.spawn = (cmd, args, opts) => {
  captured = { cmd, args, opts };
  const child = new EventEmitter();
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stdin = Object.assign(new EventEmitter(), { end() {} });
  child.kill = () => {};
  process.nextTick(() => child.emit('close', 0)); // resolve runClaude immediately
  return child;
};

const { runClaude } = require('../cli/claude.js');

function allowedToolsValue(args) {
  const i = args.indexOf('--allowedTools');
  return i === -1 ? null : args[i + 1];
}

test('runClaude scopes Read/Edit to the passed cwd, not a bare allow-all', async () => {
  await runClaude('prompt', '/review/root');
  const val = allowedToolsValue(captured.args);
  assert.equal(val, 'Read(/review/root/**),Edit(/review/root/**)');
  assert.notEqual(val, 'Read,Edit', 'must not allow-list Read/Edit unscoped');
  assert.ok(!/(^|,)Edit(,|$)/.test(val), 'no bare Edit rule that would auto-approve any path');
  assert.equal(captured.opts.cwd, '/review/root', 'spawn cwd matches the scope root');
});

// a rule the matcher has to normalize fences everything out the day it stops — review dies quietly
test('runClaude emits a clean absolute glob, never a doubled or relative separator', async () => {
  await runClaude('prompt', '/review/root/');
  const val = allowedToolsValue(captured.args);
  assert.ok(!val.includes('//'), `no doubled separator to normalize away: ${val}`);
  assert.equal(val, 'Read(/review/root/**),Edit(/review/root/**)');
});

test('runClaude resolves a relative cwd against process.cwd()', async () => {
  await runClaude('prompt', 'docs/notes');
  const val = allowedToolsValue(captured.args);
  const want = path.join(process.cwd(), 'docs/notes', '**');
  assert.equal(val, `Read(${want}),Edit(${want})`, 'relative scope must resolve to an absolute glob');
  assert.ok(!/(^|,)Edit(,|$)/.test(val), 'still no bare Edit rule');
});

test('runClaude falls back to process.cwd() so the scope is never empty', async () => {
  await runClaude('prompt', undefined);
  const val = allowedToolsValue(captured.args);
  const want = path.join(process.cwd(), '**');
  assert.ok(val.includes(`Edit(${want})`), 'scope derived from process.cwd() when no cwd given');
  assert.ok(!/(^|,)Edit(,|$)/.test(val), 'still no bare Edit rule');
});
