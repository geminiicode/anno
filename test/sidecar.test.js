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

test('sidecar roundtrips comments through the hidden file', () => {
  const md = tmpDoc();
  sidecar.writeComments(md, [{ id: 'c1', body: 'hi' }]);
  assert.ok(fs.existsSync(path.join(path.dirname(md), '.doc.md.comments.json')));
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
  // Force the tmp write to fail (read-only dir) after a valid sidecar exists.
  const dir = path.dirname(md);
  fs.chmodSync(dir, 0o555);
  try {
    assert.throws(() => sidecar.writeComments(md, [{ id: 'clobber' }]));
  } finally {
    fs.chmodSync(dir, 0o755); // restore so readback + cleanup work
  }
  assert.deepEqual(sidecar.readComments(md), [{ id: 'good' }]);
  assert.equal(fs.existsSync(sidecar.sidecarPath(md) + '.tmp'), false);
});

// mdPathForSidecar is the inverse of sidecarPath; the folder watcher relies on
// it to map a changed sidecar back to its doc.
test('mdPathForSidecar recovers the doc path and ignores non-sidecars', () => {
  const md = tmpDoc();
  assert.equal(sidecar.mdPathForSidecar(sidecar.sidecarPath(md)), md);
  assert.equal(sidecar.mdPathForSidecar(md), null);
  assert.equal(sidecar.mdPathForSidecar('/x/.doc.md.comments.json.corrupt'), null);
});
