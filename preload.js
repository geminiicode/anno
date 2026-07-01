const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  homeDir: ipcRenderer.sendSync('app:homeDir'),
  open: () => ipcRenderer.invoke('dialog:open'),
  listMarkdown: (dir) => ipcRenderer.invoke('fs:listMarkdown', dir),
  readFile: (file) => ipcRenderer.invoke('fs:readFile', file),
  readHelp: () => ipcRenderer.invoke('help:read'),
  readComments: (mdPath) => ipcRenderer.invoke('comments:read', mdPath),
  writeComments: (mdPath, comments) => ipcRenderer.invoke('comments:write', mdPath, comments),
  // Main is the sole authority on open roots: it canonicalizes, runs overlap
  // containment, and returns a verdict — the renderer never decides whether a
  // new agent spawns.
  startTab: (root, isDir) => ipcRenderer.invoke('tab:start', { root, isDir }),
  stopTab: (root) => ipcRenderer.invoke('tab:stop', root),
  onFileChanged: (cb) => ipcRenderer.on('file:changed', (_e, payload) => cb(payload)),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, mdPath) => cb(mdPath)),
  onOpenFolder: (cb) => ipcRenderer.on('open-folder', (_e, dir) => cb(dir)),
  onToggleComments: (cb) => ipcRenderer.on('toggle-comments', () => cb()),
});
