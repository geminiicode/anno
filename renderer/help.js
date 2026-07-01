import { helpBtn, helpOverlay, helpCloseBtn, helpBody } from './dom.js';
import * as host from './host.js';

// HELP.md is the same doc `anno help` prints; render it once, lazily, on first open.
let loaded = false;
async function ensureLoaded() {
  if (loaded) return;
  try {
    const md = await host.readHelp();
    helpBody.innerHTML = DOMPurify.sanitize(marked.parse(md));
  } catch {
    helpBody.innerHTML = '<p>Help is unavailable.</p>';
  }
  loaded = true; // a failed read still counts — avoid hammering a missing file on every open
}

const isOpen = () => !helpOverlay.hidden;

async function openHelp() {
  await ensureLoaded();
  helpOverlay.hidden = false;
}
function closeHelp() {
  helpOverlay.hidden = true;
}

helpBtn.addEventListener('click', () => (isOpen() ? closeHelp() : openHelp()));
helpCloseBtn.addEventListener('click', closeHelp);
// click on the backdrop (not the panel) dismisses
helpOverlay.addEventListener('click', (e) => {
  if (e.target === helpOverlay) closeHelp();
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === '/') {
    e.preventDefault();
    isOpen() ? closeHelp() : openHelp();
  } else if (e.key === 'Escape' && isOpen()) {
    e.preventDefault();
    closeHelp();
  }
});
