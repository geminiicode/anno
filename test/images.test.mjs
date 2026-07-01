// resolveImageSrcs rewrites markdown image paths (relative to the doc dir) to
// absolute file:// URLs, leaving remote/data srcs alone. (.mjs + jsdom: it walks
// a DOM container.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const dom = new JSDOM('<!DOCTYPE html><body></body>');
globalThis.document = dom.window.document;
globalThis.URL = dom.window.URL;

const { resolveImageSrcs } = await import('../renderer/images.js');

function render(html, filePath) {
  const el = dom.window.document.createElement('div');
  el.innerHTML = html;
  resolveImageSrcs(el, filePath);
  return el;
}

test('rewrites a relative src against the doc directory', () => {
  const el = render('<img src="diagram.png">', '/docs/notes.md');
  assert.equal(el.querySelector('img').getAttribute('src'), 'file:///docs/diagram.png');
});

test('resolves nested and ../ paths', () => {
  const el = render('<img src="img/a.png"><img src="../shared/b.png">', '/docs/notes.md');
  const srcs = [...el.querySelectorAll('img')].map((i) => i.getAttribute('src'));
  assert.deepEqual(srcs, ['file:///docs/img/a.png', 'file:///shared/b.png']);
});

test('maps an absolute local path to a file URL', () => {
  const el = render('<img src="/var/pics/x.png">', '/docs/notes.md');
  assert.equal(el.querySelector('img').getAttribute('src'), 'file:///var/pics/x.png');
});

test('leaves remote, data, and already-file srcs untouched', () => {
  const html =
    '<img src="https://ex.com/a.png">' +
    '<img src="data:image/png;base64,AAAA">' +
    '<img src="file:///already/abs.png">';
  const el = render(html, '/docs/notes.md');
  const srcs = [...el.querySelectorAll('img')].map((i) => i.getAttribute('src'));
  assert.deepEqual(srcs, [
    'https://ex.com/a.png',
    'data:image/png;base64,AAAA',
    'file:///already/abs.png',
  ]);
});

test('encodes spaces in the doc directory path', () => {
  const el = render('<img src="pic.png">', '/docs/My Docs/notes.md');
  assert.equal(el.querySelector('img').getAttribute('src'), 'file:///docs/My%20Docs/pic.png');
});

test('no-op when there is no open file', () => {
  const el = render('<img src="x.png">', null);
  assert.equal(el.querySelector('img').getAttribute('src'), 'x.png');
});

// images.js skips file:/blob: srcs assuming DOMPurify stripped them. Pin that:
// if a DOMPurify upgrade let file:/blob:/javascript: through, this fails.
test('DOMPurify strips raw file:/blob:/javascript: image srcs (sanitize contract)', () => {
  const DOMPurify = require('dompurify')(dom.window);
  const strip = (html) => {
    const el = dom.window.document.createElement('div');
    el.innerHTML = DOMPurify.sanitize(html);
    const img = el.querySelector('img');
    return img ? img.getAttribute('src') : null;
  };
  assert.equal(strip('<img src="file:///etc/passwd">'), null);
  assert.equal(strip('<img src="blob:abcd">'), null);
  assert.equal(strip('<img src="javascript:alert(1)">'), null);
  // sanity: a normal relative src survives so the rewrite still has input
  assert.equal(strip('<img src="ok.png">'), 'ok.png');
});
