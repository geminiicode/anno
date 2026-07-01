// formatShortcut is a pure platform-aware label, but it reads a module-level
// `isMac` captured from navigator.userAgent at import. Each branch therefore
// needs its own module instance: set navigator, then import with a distinct
// query string so Node's ESM cache re-evaluates the module under that platform.
import test from 'node:test';
import assert from 'node:assert/strict';

test('formatShortcut renders ⌘ / ⌘⇧ on macOS', async () => {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }, configurable: true });
  const { formatShortcut } = await import('../renderer/helpers.js?platform=mac');
  assert.equal(formatShortcut('M'), '⌘M');
  assert.equal(formatShortcut('R'), '⌘R');
  assert.equal(formatShortcut('H', { shift: true }), '⌘⇧H');
  assert.equal(formatShortcut('L', { shift: false }), '⌘L');
  assert.equal(formatShortcut('Enter'), '⌘↵'); // Enter renders as the ↵ glyph on mac
});

test('formatShortcut renders Ctrl+ / Ctrl+Shift+ off macOS', async () => {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, configurable: true });
  const { formatShortcut } = await import('../renderer/helpers.js?platform=win');
  assert.equal(formatShortcut('M'), 'Ctrl+M');
  assert.equal(formatShortcut('H', { shift: true }), 'Ctrl+Shift+H');
  assert.equal(formatShortcut('L'), 'Ctrl+L'); // default opts: no shift
  assert.equal(formatShortcut('Enter'), 'Ctrl+Enter'); // no compact glyph off-mac, keep the word
});
