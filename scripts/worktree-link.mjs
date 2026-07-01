#!/usr/bin/env node
// prestart/pretest self-heal: a fresh worktree has no node_modules. Single package,
// no workspaces, so a shared symlink to main's is correct (carries the electron binary
// + jsdom). Serves MAIN's dep versions — if this worktree changes deps, rm + npm install.
// No-op in the main checkout or outside a git repo.
import { existsSync, lstatSync, symlinkSync, unlinkSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const cwd = process.cwd();
const nmPath = join(cwd, 'node_modules');

// clear a dangling symlink (target gone) so we relink; else it reads as "present" and never self-heals
function usableNodeModules(p) {
  let st;
  try { st = lstatSync(p); } catch { return false; }
  if (st.isSymbolicLink() && !existsSync(p)) { unlinkSync(p); return false; }
  return true;
}

if (usableNodeModules(nmPath)) process.exit(0);

let mainModules;
try {
  // git may emit a relative common-dir; resolve against cwd or mainRoot is a bare fragment
  const commonDir = realpathSync(
    resolve(cwd, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8' }).trim())
  );
  const mainRoot = commonDir.endsWith('/.git') ? commonDir.slice(0, -'/.git'.length) : null;
  mainModules = mainRoot && join(mainRoot, 'node_modules');
} catch {
  process.exit(0);
}

if (mainModules && existsSync(mainModules)) {
  symlinkSync(mainModules, nmPath);
  console.error('[worktree-link] symlinked node_modules from main checkout');
} else {
  console.error('[worktree-link] main checkout has no node_modules — run `npm install` here');
}
