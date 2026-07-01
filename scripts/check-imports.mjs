// Renderer modules touch `document` at load, so can't be imported headless to
// check exports. Run from repo root; exits non-zero on any mismatch.
import fs from 'fs';
import path from 'path';

const dir = 'renderer';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
const src = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

function exportsOf(code) {
  const out = new Set();
  for (const m of code.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_]+)/g)) out.add(m[1]);
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g))
    for (let n of m[1].split(',')) { n = n.trim().split(/\s+as\s+/).pop().trim(); if (n) out.add(n); }
  return out;
}
const exp = Object.fromEntries(files.map((f) => [f, exportsOf(src[f])]));

let problems = 0;
const importRe = /import\s*(\*\s*as\s*[A-Za-z0-9_]+|\{[^}]*\}|[A-Za-z0-9_]+)?\s*from\s*['"]\.\/([A-Za-z0-9_.-]+)['"]/g;
for (const f of files) {
  for (const m of src[f].matchAll(importRe)) {
    const clause = m[1] || '';
    const target = m[2].endsWith('.js') ? m[2] : m[2] + '.js';
    if (!src[target]) { console.error(`${f}: imports missing module ./${target}`); problems++; continue; }
    const brace = clause.match(/\{([^}]*)\}/);
    if (!brace) continue;
    for (let n of brace[1].split(',')) {
      n = n.trim().split(/\s+as\s+/)[0].trim();
      if (n && !exp[target].has(n)) { console.error(`${f}: imports {${n}} from ./${target} — NOT exported`); problems++; }
    }
  }
}
if (problems) { console.error(`${problems} unresolved renderer import(s)`); process.exit(1); }
console.log('OK — every named renderer import resolves to a real export');
