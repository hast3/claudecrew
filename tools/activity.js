#!/usr/bin/env node
// Who changed which files: node tools/activity.js [path-substring] [--since 24h]
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
let since = 0, sub = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--since') {
    const m = /^(\d+)\s*([mhd])$/i.exec(args[++i] || '');
    if (!m) { console.error('--since needs e.g. 90m, 24h or 7d'); process.exit(1); }
    since = Date.now() - Number(m[1]) * { m: 6e4, h: 36e5, d: 864e5 }[m[2].toLowerCase()];
  } else sub = args[i];
}
const file = path.join(__dirname, '..', 'data', 'activity.jsonl');
if (!fs.existsSync(file)) { console.log('(no activity yet)'); process.exit(0); }
const needle = sub.toLowerCase().replace(/\\/g, '/');
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let e; try { e = JSON.parse(line); } catch { continue; }
  if (Date.parse(e.t) < since) continue;
  const t = new Date(e.t); const p = (n) => String(n).padStart(2, '0');
  const when = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
  for (const f of e.files) if (f.toLowerCase().includes(needle)) console.log(`${when} | ${e.agent} | ${f}`);
}
