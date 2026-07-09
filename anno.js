#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { review } = require('./cli/review');
const { list } = require('./cli/list');
const { clean } = require('./cli/clean');

function usage() {
  console.log('Usage:');
  console.log('  anno review <file.md|folder>           Open the editor AND auto-address comments (the full loop)');
  console.log('  anno list <file.md>                    Show comments and their statuses');
  console.log('  anno clean <path> [--force]            Reap orphaned store entries under <path> (dry-run without --force)');
  console.log('  anno clean --legacy <path> [--force]   Sweep old co-located .comments.json litter under <path>');
  console.log('  anno help                              Show the full help guide');
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
  const argv = process.argv.slice(2);
  const [cmd] = argv;
  if (cmd === 'review' && argv[1]) review(argv[1]);
  else if (cmd === 'list' && argv[1]) list(argv[1]);
  else if (cmd === 'clean') clean(argv.slice(1));
  else if (cmd === 'help' || cmd === '--help' || cmd === '-h') help();
  else usage();
}
