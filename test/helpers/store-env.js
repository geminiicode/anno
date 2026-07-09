const fs = require('fs');
const os = require('os');
const path = require('path');

// Point ANNO_STORE_DIR at a throwaway dir before any core/ import so writeComments
// never touches the developer's real ~/.anno. One dir per test FILE (node --test
// runs each file in its own process, so this module loads once per file) keeps the
// three real daemons in watch-daemon.test.js from watching a shared store and
// waking on each other's writes. Spawned children inherit it via default env.
// Unconditional: an ambient ANNO_STORE_DIR in the developer's shell must not
// aim the suite at a real store.
process.env.ANNO_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anno-store-'));
