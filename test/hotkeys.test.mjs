// The ⌘L / ⌘⇧H keydown handlers live in renderer/main.js, which is the renderer
// ENTRY module: importing it under jsdom pulls the whole app (selection.js,
// diff.js, doc.js, host.js with its Electron-preload deps) and wires top-level
// listeners — too entangled to load cleanly here, and the toggle functions it
// defines aren't exported. So the keydown→handler path itself stays on manual
// coverage. What IS cleanly importable is the seam the handlers mutate: each
// toggle does setLayout({ x: !getLayout().x }) + applyLayout(), and applyLayout
// projects that flag onto observable DOM. We pin that seam: a flip of each
// hotkey's flag must flip the body class / button state the user sees. If a
// future refactor moves these flags, this fails even though main.js is untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;

const { getLayout, setLayout, applyLayout } = await import('../renderer/layout.js');
const { toggleResolvedBtn } = await import('../renderer/dom.js');

// Mirrors toggleLeftSidebar/toggleRightSidebar/toggleResolved in main.js — the
// exact mutation each keydown branch performs before re-rendering.
function toggle(flag) {
  setLayout({ [flag]: !getLayout()[flag] });
  applyLayout();
}

test('⌘L seam: toggling sidebarCollapsed flips the body class', () => {
  setLayout({ sidebarCollapsed: false });
  applyLayout();
  assert.equal(document.body.classList.contains('sidebar-collapsed'), false);
  toggle('sidebarCollapsed');
  assert.equal(document.body.classList.contains('sidebar-collapsed'), true);
  toggle('sidebarCollapsed');
  assert.equal(document.body.classList.contains('sidebar-collapsed'), false);
});

test('⌘⇧H seam: toggling hideResolved flips the resolved-button state', () => {
  setLayout({ hideResolved: false });
  applyLayout();
  assert.equal(toggleResolvedBtn.textContent, 'Hide resolved');
  toggle('hideResolved');
  assert.equal(toggleResolvedBtn.textContent, 'Show resolved');
  assert.equal(toggleResolvedBtn.classList.contains('active'), true);
});
