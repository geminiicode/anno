// host.js reads window.api at call time, not import time, so the bridge can be
// swapped after load. An eager binding passes every other test — this pins it.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { api: { readFile: async (p) => 'first:' + p } };
const host = await import('../renderer/host.js');

test('host resolves window.api at call time, so a post-import swap is honored', async () => {
  assert.equal(await host.readFile('/x'), 'first:/x');
  window.api = { readFile: async (p) => 'second:' + p }; // embedder swaps the bridge
  assert.equal(await host.readFile('/x'), 'second:/x'); // would be 'first:' if bound eagerly
});
