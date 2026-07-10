const { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell } = require('electron');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sidecar = require('./core/sidecar');
const { MD_EXTENSIONS, MD_RE } = require('./core/markdown-ext');
const { listMarkdownFiles, listDirs, pathInScope } = require('./core/fs-walk');
const { canonical, storeRoot, seedStoreIndex } = require('./core/paths');
const { createStoreRouter } = require('./core/store-router');
const overlap = require('./core/overlap');

app.setName('anno');

// GUI confirms before spawning a folder agent; the headless daemon can't prompt.
const FOLDER_FILE_LIMIT = 2000;

// Electron passes the app root (__dirname) as argv[1]; skip it or it reads as a
// folder target. second-instance passes the forwarding process's argv.
function launchTarget(argv = process.argv) {
  for (const a of argv.slice(2)) {
    const abs = path.resolve(a);
    if (abs === __dirname) continue;
    let st;
    try {
      st = fsSync.statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) return { path: canonical(abs), isDir: true };
    if (MD_RE.test(abs)) return { path: canonical(abs), isDir: false };
  }
  return null;
}

function createWindow({ openTarget = true } = {}) {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    show: false,
    // Theme-match the native frame so no white sliver flashes behind the
    // frameless title bar; CSS @media handles live flips, so a stale value
    // between flips is harmless.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e2127' : '#ffffff',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 13 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('index.html');
  // Reap only THIS window's daemons when it closes — with multiple windows open,
  // each owns its own tabs. (will-quit still reaps all on full app quit.)
  const winWcId = win.webContents.id;
  win.on('closed', () => {
    for (const [r, t] of [...openTabs]) if (t.wcId === winWcId) stopTab(r);
  });
  // Open http(s) links in the system browser, not the app window — two routes:
  // target=_blank/window.open, and in-page anchors.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return; // in-page reloads/anchors
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  // Intercept accel chords here: a renderer keydown can't preventDefault the
  // native menu role. Cmd/Ctrl+R toggles the sidebar; Cmd/Ctrl+N opens a fresh
  // empty window. Shift modifier left untouched for both.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.shift) return;
    const accel = process.platform === 'darwin' ? input.meta : input.control;
    if (!accel) return;
    switch (input.key.toLowerCase()) {
      case 'r':
        event.preventDefault();
        win.webContents.send('toggle-comments');
        break;
      case 'n': {
        event.preventDefault();
        // Empty window — don't replay this process's launch target into it.
        const fresh = createWindow({ openTarget: false });
        fresh.once('ready-to-show', () => {
          fresh.show();
          fresh.focus();
        });
        break;
      }
    }
  });
  // A Cmd+N window opens empty (recents/empty state); only the launch path loads
  // the file anno was invoked with.
  const target = openTarget ? launchTarget() : null;
  if (target) sendTarget(win, target);
  return win;
}

// Buffer until the page has loaded — a path forwarded before the renderer's
// handlers exist would otherwise be lost.
function sendTarget(win, target) {
  const channel = target.isDir ? 'open-folder' : 'open-file';
  const send = () => {
    if (!win.webContents.isDestroyed()) win.webContents.send(channel, target.path);
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

// Single window: a second `anno review` can't get the lock, so it forwards its
// path here as a new tab and quits instead of opening its own window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const target = launchTarget(argv);
    if (target) sendTarget(win, target);
  });

  app.setAboutPanelOptions({ applicationName: 'anno', applicationVersion: require('./package.json').version });

  app.whenReady().then(() => {
    const win = createWindow();
    win.once('ready-to-show', () => {
      win.show();
      app.focus({ steal: true });
    });
  });

  app.on('window-all-closed', () => {
    // Quit on close even on macOS: anno is a transient reviewer.
    app.quit();
  });

  // OS won't reap our spawned agent daemons on exit — kill them explicitly.
  app.on('will-quit', () => {
    for (const mdPath of [...openTabs.keys()]) stopTab(mdPath);
  });
}

// Synchronous so preload can expose $HOME as a ready value.
ipcMain.on('app:homeDir', (event) => {
  event.returnValue = app.getPath('home');
});

ipcMain.handle('dialog:open', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'openDirectory'],
    filters: [{ name: 'Markdown', extensions: MD_EXTENSIONS }],
  });
  if (canceled || filePaths.length === 0) return null;
  const target = canonical(filePaths[0]);
  return { path: target, isDir: fsSync.statSync(target).isDirectory() };
});

ipcMain.handle('fs:listMarkdown', (event, dirPath) => {
  return listMarkdownFiles(dirPath).sort();
});

ipcMain.handle('fs:readFile', async (event, filePath) => {
  const content = await fs.readFile(filePath, 'utf8');
  return content;
});

// HELP.md ships in the app bundle; renderer needn't know the path.
ipcMain.handle('help:read', () => fs.readFile(path.join(__dirname, 'HELP.md'), 'utf8'));

// Sidecar paths we've already warned the user are corrupt — the watcher re-reads on every change,
// so without this each event would fire another dialog. Cleared on a clean read so a later
// re-corruption warns again.
const corruptWarned = new Set();

ipcMain.handle('comments:read', async (event, mdPath) => {
  try {
    const comments = sidecar.readComments(mdPath);
    corruptWarned.delete(sidecar.sidecarPath(mdPath)); // recovered — re-arm the warning
    return comments;
  } catch (err) {
    // Corrupt sidecar: readComments backed it up to .corrupt and threw. Returning [] keeps the app
    // usable, but a silent empty list reads as "my comments vanished" — surface it once so the user
    // knows they're recoverable from the backup.
    const p = err?.path || sidecar.sidecarPath(mdPath);
    if (!corruptWarned.has(p)) {
      corruptWarned.add(p);
      dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
        type: 'warning',
        title: 'Comments could not be loaded',
        message: `The comments file for ${path.basename(mdPath)} is corrupted and couldn’t be read.`,
        detail: `Your comments are safe — a backup was saved to:\n${p}.corrupt\n\nThe editor is showing an empty comment list for now. Fix or remove the corrupted file, then reopen the document to restore them.`,
      });
    }
    return [];
  }
});

// Keyed by canonical (realpath) root so one target opened via two path strings
// shares ONE daemon — never two claudes racing the sidecar.
const openTabs = new Map();

// Linux can't do recursive fs.watch (ERR_FEATURE_UNAVAILABLE_ON_PLATFORM): watch
// each dir instead. New subdirs aren't auto-watched then.
function startTreeWatch(rootDir, recursive, onChange) {
  try {
    return [fsSync.watch(rootDir, { recursive }, (_e, filename) => onChange(rootDir, filename))];
  } catch (err) {
    if (!recursive || err.code !== 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') throw err;
    const dirs = listDirs(rootDir);
    const watchers = dirs
      .map((d) => {
        try {
          return fsSync.watch(d, (_e, filename) => onChange(d, filename));
        } catch {
          return null; // skip an unwatchable dir rather than abort the whole tab
        }
      })
      .filter(Boolean);
    // inotify ENOSPC would otherwise stop live-reload for part of the tree silently.
    if (watchers.length < dirs.length) {
      console.warn(
        `anno: only watching ${watchers.length}/${dirs.length} directories under ${rootDir} ` +
          '(inotify limit?); some files won\'t live-reload.'
      );
    }
    return watchers;
  }
}

// Two watches, like watchTree: the doc's own directory for md edits, and the flat
// store for comment writes. A single-file tab knows its one store filename, so it
// needs no hash→doc index — the name alone routes a create, change, or unlink.
function watchFile(wc, mdPath) {
  const dir = path.dirname(mdPath);
  const mdName = path.basename(mdPath);
  const storeName = path.basename(sidecar.sidecarPath(mdPath));
  const debounce = {};
  const watchers = [];
  const fire = (kind) => {
    // Debounce: editors/agents write in bursts (truncate + write).
    clearTimeout(debounce[kind]);
    debounce[kind] = setTimeout(() => {
      if (!wc.isDestroyed()) wc.send('file:changed', { kind, mdPath, root: mdPath });
    }, 150);
  };
  try {
    watchers.push(fsSync.watch(dir, (_e, filename) => {
      if (filename === mdName) fire('md');
    }));
  } catch {
    /* live-reload watch failed; the agent still runs */
  }
  try {
    const sw = fsSync.watch(storeRoot(), (_e, filename) => {
      if (filename === storeName) fire('comments');
    });
    // Runtime FSWatcher 'error' (store dir churn, inotify limit) would otherwise throw
    // and take the window down; swallow to degrade comment live-reload, agent still runs.
    sw.on('error', () => {});
    watchers.push(sw);
  } catch {
    /* comment live-reload failed; the agent still runs */
  }
  return () => {
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
    for (const id of Object.values(debounce)) clearTimeout(id);
  };
}

// Debounced per file+kind so an md edit doesn't cancel a sibling comment edit.
// Two watches: the recursive tree for markdown edits (kind:'md'), and a
// non-recursive watch on the flat store for comment writes (kind:'comments').
function watchTree(wc, root) {
  const debounce = new Map();
  // storeRoot() asserts ownership+mode and throws on a world-readable store; that
  // must not take the tab down with it — live-reload degrades, the agent still runs.
  let storeIndex = new Map();
  try {
    storeIndex = seedStoreIndex();
  } catch {
    /* store unusable; the store watch below fails the same way and is caught there */
  }

  const send = (kind, mdPath) => {
    // Recursive fs.watch fires for every node_modules/.git file too, and the store
    // is global (every window's writes wake us); scope so an npm install or an
    // unrelated tab's comment doesn't reload this window.
    if (!pathInScope(root, mdPath)) return;
    const key = `${kind}:${mdPath}`;
    clearTimeout(debounce.get(key));
    debounce.set(
      key,
      setTimeout(() => {
        if (!wc.isDestroyed()) wc.send('file:changed', { kind, mdPath, root });
      }, 150)
    );
  };

  const onTree = (baseDir, filename) => {
    if (!filename || !MD_RE.test(filename)) return;
    send('md', path.join(baseDir, filename));
  };

  // Same router (strict realpathSync guard) as the CLI daemon. Its inScope
  // supersedes send()'s textual pathInScope for comment events — a symlinked-out
  // doc that pathInScope alone would pass is now rejected before reaching send().
  const onStore = createStoreRouter({
    enqueue: (mdPath) => send('comments', mdPath),
    isDir: true,
    abs: root,
    watchDir: root,
    index: storeIndex,
  });

  let watchers = [];
  try {
    watchers = startTreeWatch(root, true, onTree);
  } catch {
    /* live-reload watch failed; the agent still runs */
  }
  let storeWatcher = null;
  try {
    storeWatcher = fsSync.watch(storeRoot(), (_e, filename) => onStore(filename));
    // Runtime FSWatcher 'error' (store dir churn, inotify limit) would otherwise throw
    // and take the window down; swallow to degrade comment live-reload, agent still runs.
    storeWatcher.on('error', () => {});
  } catch {
    /* store watch failed; md live-reload + the agent still run */
  }
  return () => {
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
    if (storeWatcher) {
      try {
        storeWatcher.close();
      } catch {
        /* already closed */
      }
    }
    for (const id of debounce.values()) clearTimeout(id);
  };
}

// root must already be canonical (it's the openTabs key + daemon arg).
function spawnTab(wc, root, isDir) {
  if (openTabs.has(root)) return;
  const close = isDir ? watchTree(wc, root) : watchFile(wc, root);
  // ELECTRON_RUN_AS_NODE runs our own binary as plain node so it can exec the daemon.
  const daemon = spawn(process.execPath, [path.join(__dirname, 'cli', 'watch-daemon.js'), root], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  daemon.on('error', () => {}); // don't let a failed daemon crash the window
  // Store wc.id (stable) not wc — the wc object is destroyed on window close, but
  // we still need to attribute this daemon to its owning window for teardown.
  openTabs.set(root, { close, daemon, isDir, wcId: wc.id });
}

// This window's own tabs, in overlap.resolve's shape. Overlap is scoped per-window:
// each renderer has its own tab store, so resolving against other windows' roots
// would hand back focus/absorb verdicts the asking renderer can't act on.
const ownRoots = (wcId) =>
  [...openTabs.entries()]
    .filter(([, t]) => t.wcId === wcId)
    .map(([r, t]) => ({ root: r, isDir: t.isDir }));

function rootsOverlap(existingRoot, existingIsDir, root, isDir) {
  return (
    existingRoot === root ||
    (existingIsDir && overlap.covers(existingRoot, root)) ||
    (isDir && overlap.covers(root, existingRoot))
  );
}

async function confirmHugeFolder(wc, root) {
  const count = listMarkdownFiles(root).length;
  if (count <= FOLDER_FILE_LIMIT) return true;
  const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(wc), {
    type: 'warning',
    buttons: ['Open Anyway', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `This folder has ${count} markdown files.`,
    detail: 'Opening it starts one agent watching the whole tree, which may be slow.',
  });
  return response === 0;
}

async function startTabImpl(wc, root, isDir) {
  if (!root) return { action: 'started', root };
  root = canonical(root);

  // same-target multi-window isn't supported: if another window already owns an
  // overlapping root, focus that window rather than corrupting its daemon
  // (its renderer's tab store + watcher wc are out of this window's reach).
  for (const [r, t] of openTabs) {
    if (t.wcId === wc.id) continue;
    if (!rootsOverlap(r, t.isDir, root, isDir)) continue;
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.id === t.wcId
    );
    // Owner window is gone but its tab entry lingers (reaper hasn't run yet): don't
    // dead-end the open on a stale entry — skip it and let normal resolution handle it.
    if (!win) continue;
    if (win.isMinimized()) win.restore();
    win.focus();
    // Exact root match: the focus jump is intuitive on its own. A partial overlap
    // (folder vs file inside it) isn't, so explain the silent focus-jump.
    if (r !== root) {
      await dialog.showMessageBox(BrowserWindow.fromWebContents(wc), {
        type: 'info',
        buttons: ['OK'],
        message: 'Already open in another window',
        detail: `"${path.basename(root)}" overlaps a review open in another window. Close it there to open it here.`,
      });
    }
    return { action: 'elsewhere', root: r };
  }

  const verdict = overlap.resolve(root, isDir, ownRoots(wc.id));

  if (verdict.action === 'focus') {
    return { action: 'focus', root: verdict.root, selectFile: verdict.selectFile };
  }

  if (verdict.action === 'absorb') {
    const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(wc), {
      type: 'question',
      buttons: ['Open Folder', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: 'Open this folder as one review?',
      detail: `${verdict.absorbedFiles.length} open tab(s) inside it will be folded into the folder review.`,
    });
    if (response !== 0) return { action: 'cancelled' };
    if (!(await confirmHugeFolder(wc, root))) return { action: 'cancelled' };
    // Re-resolve AFTER the dialogs — a tab:stop could have changed what overlaps —
    // and await the absorbed daemons dead before respawning, else two agents
    // briefly write the same files (doc bodies aren't atomic).
    const re = overlap.resolve(root, isDir, ownRoots(wc.id));
    if (re.action === 'focus') return { action: 'focus', root: re.root, selectFile: re.selectFile };
    const absorbedFiles = re.action === 'absorb' ? re.absorbedFiles : [];
    await Promise.all(absorbedFiles.map((f) => stopTab(f)));
    // window closed during the dialog: don't spawn an unsupervised daemon for a dead window
    if (wc.isDestroyed()) return { action: 'cancelled' };
    spawnTab(wc, root, true);
    return { action: 'absorbed', root, absorbedFiles };
  }

  if (isDir && !(await confirmHugeFolder(wc, root))) return { action: 'cancelled' };
  if (wc.isDestroyed()) return { action: 'cancelled' };
  spawnTab(wc, root, isDir);
  return { action: 'started', root };
}

// Serialize tab:start so an open landing mid-dialog (e.g. a second `anno review`
// while an absorb prompt is up) can't compute overlap against a stale tab set and
// spawn a daemon the in-flight absorb won't fold in — the dual-daemon footgun.
let startChain = Promise.resolve();
function startTab(wc, root, isDir) {
  const run = startChain.then(() => startTabImpl(wc, root, isDir));
  startChain = run.catch(() => {}); // keep the chain alive past a rejection
  return run;
}

// Resolves once the daemon has exited — the absorb path waits for the old agent
// to die before respawning over its files.
function stopTab(root) {
  // Match the canonical key spawnTab used, or the lookup misses and we leak.
  root = canonical(root);
  const t = openTabs.get(root);
  if (!t) return Promise.resolve();
  t.close();
  // Delete now so a concurrent overlap.resolve() can't still see this tab.
  openTabs.delete(root);
  if (!t.daemon) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    t.daemon.once('exit', finish);
    // SIGINT not SIGTERM: lets watch.js run its handler and kill its claude child.
    try {
      t.daemon.kill('SIGINT');
    } catch {
      return finish(); // already gone
    }
    // A daemon ignoring SIGINT must not hang the absorb forever; the ppid poll
    // reaps a true straggler within ~2s regardless.
    setTimeout(finish, 1500).unref();
  });
}

ipcMain.handle('tab:start', (event, { root, isDir }) => startTab(event.sender, root, isDir));
ipcMain.handle('tab:stop', (event, root) => {
  // Only stop a tab the calling window owns — a renderer must not kill another window's daemon.
  const t = openTabs.get(canonical(root));
  if (t && t.wcId === event.sender.id) stopTab(root);
  return true;
});

ipcMain.handle('comments:write', async (event, mdPath, comments) => {
  // Report a write failure as false, not an unhandled invoke rejection.
  try {
    sidecar.writeComments(mdPath, comments);
    return true;
  } catch {
    return false;
  }
});
