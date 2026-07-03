#!/usr/bin/env node
// Internal daemon entry — spawned per tab by the GUI (main.js). Not a public `anno`
// subcommand: a headless watcher is useless without anno's own editor to write the sidecar.
const { watch } = require('./watch');

const target = process.argv[2];
if (!target) {
  console.error('watch-daemon: no target path given');
  process.exit(1);
}
watch(target);
