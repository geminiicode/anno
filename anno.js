#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { review } = require('./cli/review');
const { list } = require('./cli/list');

function usage() {
  console.log('Usage:');
  console.log('  anno review <file.md|folder>   Open the editor AND auto-address comments (the full loop)');
  console.log('  anno list <file.md>            Show comments and their statuses');
  console.log('  anno help                      Show the full help guide');
}

// HELP.md is the single source of truth for help — same doc the GUI renders.
function help() {
  try {
    process.stdout.write(fs.readFileSync(path.join(__dirname, 'HELP.md'), 'utf8'));
  } catch {
    usage();
  }
}

if (require.main === module) {
  const [cmd, file] = process.argv.slice(2);
  if (cmd === 'review' && file) review(file);
  else if (cmd === 'list' && file) list(file);
  else if (cmd === 'help' || cmd === '--help' || cmd === '-h') help();
  else usage();
}
