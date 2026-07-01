// Single-instance (see main.js): later `anno review`s forward their path as a
// tab and exit. Per-tab agents live in main now, so this is fire-and-forget.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function review(target) {
  if (!fs.existsSync(target)) {
    console.error(`Path not found: ${target}`);
    process.exit(1);
  }
  const abs = path.resolve(target);
  const appDir = path.join(__dirname, '..');

  let electronPath;
  try {
    electronPath = require('electron'); // returns the binary path, not a module
  } catch {
    console.error('Electron failed to load. Reinstall anno: npm i -g anno-md');
    process.exit(1);
  }

  console.log(`Opening ${path.basename(abs)} in the editor…`);
  // Detached + unref so the window outlives this CLI process.
  const editor = spawn(electronPath, [appDir, abs], { stdio: 'ignore', detached: true });
  editor.unref();
}

module.exports = { review };
