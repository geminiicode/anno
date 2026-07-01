const { readComments, statusOf } = require('../core/sidecar');
const fs = require('fs');

function list(mdPath) {
  // missing doc is a user error; don't read it as a false all-clear
  if (!fs.existsSync(mdPath)) {
    console.error(`File not found: ${mdPath}`);
    process.exit(1);
  }
  let comments;
  try {
    comments = readComments(mdPath);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (comments.length === 0) {
    console.log('No comments.');
    return;
  }
  for (const c of comments) {
    console.log(`[${statusOf(c).toUpperCase()}] ${c.id}`);
    console.log(`  quote: ${JSON.stringify((c.quote || '').slice(0, 80))}`);
    console.log(`  note:  ${c.body}`);
    for (const r of c.replies || []) {
      console.log(`    ↳ ${r.ai ? 'AI' : r.author}: ${r.body}`);
    }
  }
}

module.exports = { list };
