// Host bridge — the renderer's one contract with its environment (Electron preload
// `window.api` in anno). Read lazily, not bound at module load, so tests can swap the stub first.
const api = () => window.api;

export const readFile = (p) => api().readFile(p);
export const readHelp = () => api().readHelp();
export const readComments = (p) => api().readComments(p);
export const writeComments = (p, c) => api().writeComments(p, c);
export const homeDir = () => api().homeDir;

export const openPicker = () => api().open();
export const listMarkdown = (d) => api().listMarkdown(d);
// resolves to main's overlap verdict: {action:'started'|'focus'|'absorbed'|'cancelled'|'elsewhere', ...}
export const startTab = (root, isDir) => api().startTab(root, isDir);
export const stopTab = (root) => api().stopTab(root);
export const onFileChanged = (cb) => api().onFileChanged(cb);
export const onOpenFile = (cb) => api().onOpenFile(cb);
export const onOpenFolder = (cb) => api().onOpenFolder(cb);
export const onToggleComments = (cb) => api().onToggleComments(cb);
