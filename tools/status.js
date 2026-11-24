#!/usr/bin/env node
// Add one line to STATUS.md with the real time and the fixed layout.
//   node tools/status.js <your-id> "<plain item>" "<state>" "<waiting-on or none>"
const path = require('path');
const { append } = require('../lib/status');
const [id, item, state, waiting] = process.argv.slice(2);
if (!id || !item || !state) {
  console.error('usage: node status.js <id> "<item>" "<state>" ["<waiting-on>"]');
  process.exit(1);
}
console.log(append(path.join(__dirname, '..', 'STATUS.md'), id, item, state, waiting || 'none'));
