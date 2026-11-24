// Nightly cleanup of old screenshots/clips. Usage: node tools/cleanup-shots.js [--dry]
// Top level of each folder only, images/clips only, older than 7 days.
const fs = require('fs');
const path = require('path');

const DIRS = [process.env.CREW_REVIEW_DIR, ...require('../lib/local-config').load().cleanupDirs].filter(Boolean);
const EXTS = new Set(['.png', '.jpg', '.bmp', '.gif', '.mp4']);
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const LOG = path.join(__dirname, '..', 'data', 'cleanup-shots.log');
const dry = process.argv.includes('--dry');

const now = Date.now();
let count = 0, bytes = 0;
for (const dir of DIRS) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { continue; }
  for (const n of names) {
    if (!EXTS.has(path.extname(n).toLowerCase())) continue;
    const p = path.join(dir, n);
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (!st.isFile() || now - st.mtimeMs < MAX_AGE_MS) continue;
    if (dry) console.log(p, (st.size / 1048576).toFixed(2) + ' MB');
    else { try { fs.unlinkSync(p); } catch (e) { continue; } }
    count++; bytes += st.size;
  }
}
const line = `${new Date().toISOString()} ${dry ? 'DRY RUN would delete' : 'deleted'} ${count} files, ${(bytes / 1048576).toFixed(1)} MB freed`;
console.log(line);
if (!dry) { try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {} }
