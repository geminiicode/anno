require('./helpers/store-env.js'); // must precede any core/ import
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sidecar = require('../core/sidecar.js');

function tmpDoc() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anno-test-'));
  return path.join(dir, 'doc.md');
}

// ---------- statusOf (the canonical status-normalization rule) ----------

test('statusOf prefers explicit status, falls back to legacy resolved boolean', () => {
  assert.equal(sidecar.statusOf({ status: 'addressed' }), 'addressed');
  assert.equal(sidecar.statusOf({ resolved: true }), 'resolved');
  assert.equal(sidecar.statusOf({ resolved: false }), 'open');
  assert.equal(sidecar.statusOf({}), 'open');
});

// ---------- isWorking (the transient 👀 overlay, with stale-expiry) ----------

test('isWorking is false without the flag, true when freshly marked', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(sidecar.isWorking({}, now), false);
  assert.equal(sidecar.isWorking({ status: 'open' }, now), false);
  assert.equal(
    sidecar.isWorking({ working: true, workingSince: '2026-01-01T00:00:00Z' }, now),
    true
  );
});

test('isWorking expires a stale marker so a crashed run is retried', () => {
  const since = '2026-01-01T00:00:00Z';
  const start = Date.parse(since);
  assert.equal(sidecar.isWorking({ working: true, workingSince: since }, start + 1000), true);
  // Just past the stale window → treated as not-working.
  assert.equal(
    sidecar.isWorking({ working: true, workingSince: since }, start + sidecar.WORKING_STALE_MS + 1),
    false
  );
});

test('isWorking trusts the flag when the timestamp is missing or unparseable', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(sidecar.isWorking({ working: true }, now), true);
  assert.equal(sidecar.isWorking({ working: true, workingSince: 'garbage' }, now), true);
});

test('sidecar roundtrips comments through the store, leaving nothing beside the doc', () => {
  const md = tmpDoc();
  sidecar.writeComments(md, [{ id: 'c1', body: 'hi' }]);
  // No co-located artifact — the whole point of the store.
  assert.deepEqual(fs.readdirSync(path.dirname(md)), []);
  assert.ok(fs.existsSync(sidecar.sidecarPath(md)));
  assert.deepEqual(sidecar.readComments(md), [{ id: 'c1', body: 'hi' }]);
});

test('sidecar returns [] when no sidecar exists', () => {
  assert.deepEqual(sidecar.readComments(tmpDoc()), []);
});

test('sidecar throws on corrupt JSON and backs the file up first', () => {
  const md = tmpDoc();
  const p = sidecar.sidecarPath(md);
  fs.writeFileSync(p, 'not json{');
  assert.throws(() => sidecar.readComments(md), sidecar.CorruptSidecarError);
  assert.equal(fs.readFileSync(p + '.corrupt', 'utf8'), 'not json{');
});

// ---------- atomic writes (tmp + rename, never a truncated live sidecar) ----------

test('writeComments leaves no .tmp file behind', () => {
  const md = tmpDoc();
  sidecar.writeComments(md, [{ id: 'c1' }]);
  assert.equal(fs.existsSync(sidecar.sidecarPath(md) + '.tmp'), false);
});

test('writeComments preserves the existing sidecar when the write throws', () => {
  const md = tmpDoc();
  sidecar.writeComments(md, [{ id: 'good' }]);
  // The tmp now lives in the store, so chmod the store dir — chmod'ing the doc's
  // dir no longer blocks anything. This guards the atomicity promise: a failed
  // write leaves last-good comments intact.
  const store = path.dirname(sidecar.sidecarPath(md));
  fs.chmodSync(store, 0o555);
  try {
    assert.throws(() => sidecar.writeComments(md, [{ id: 'clobber' }]));
  } finally {
    fs.chmodSync(store, 0o755); // restore so readback + cleanup work
  }
  assert.deepEqual(sidecar.readComments(md), [{ id: 'good' }]);
  assert.equal(fs.existsSync(sidecar.sidecarPath(md) + '.tmp'), false);
});

test('empty write leaves no file on disk', () => {
  const md = tmpDoc();
  sidecar.writeComments(md, [{ id: 'c1' }]);
  sidecar.writeComments(md, []);
  assert.equal(fs.existsSync(sidecar.sidecarPath(md)), false);
  assert.deepEqual(sidecar.readComments(md), []);
});

// readComments must stay pure: a doc whose comments live only in a legacy
// co-located sidecar opens empty and that file is never touched (§4.5).
test('readComments ignores a legacy co-located sidecar and leaves it byte-identical', () => {
  const md = tmpDoc();
  const legacy = path.join(path.dirname(md), '.doc.md.comments.json');
  const bytes = JSON.stringify({ version: 1, comments: [{ id: 'old' }] });
  fs.writeFileSync(legacy, bytes);
  const before = fs.readFileSync(legacy);
  assert.deepEqual(sidecar.readComments(md), []);
  assert.deepEqual(fs.readFileSync(legacy), before);
});
