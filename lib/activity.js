'use strict';
// Per-run changed-files log: one line per agent run in data/activity.jsonl.
// {t, agent, cwd, task, files[]}. Git repos use the run's git before/after diff;
// other folders use a modified-time scan of the cwd since the run started.

const fs = require('fs');
const path = require('path');

const MAX_FILES = 200;
const SKIP_DIRS = new Set(['save', 'saves', 'node_modules', '.git']);

function scan(cwd, since) {
  const out = [];
  const stack = [cwd];
  let visited = 0;
  while (stack.length && out.length < MAX_FILES && visited < 50000) {
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      visited++;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name.toLowerCase())) stack.push(full); }
      else if (e.isFile()) {
        try { if (fs.statSync(full).mtimeMs >= since && out.length < MAX_FILES) out.push(full); } catch { /* gone */ }
      }
    }
  }
  return out;
}

function record(file, { agent, cwd, text, changed, touched, since }) {
  try {
    const root = path.resolve(cwd);
    const under = (p) => { const r = path.relative(root, p); return r && !r.startsWith('..') && !path.isAbsolute(r); };
    const skip = (p) => path.relative(root, p).split(/[\\/]/).some((s) => s.toLowerCase() === 'save' || s.toLowerCase() === 'saves');
    let abs;
    if (changed && changed.repo) abs = changed.files.map((f) => path.resolve(changed.repo, f.path));
    else abs = scan(root, since - 2000).concat([...(touched || [])].map((p) => path.resolve(root, p)));
    const files = [...new Set(abs)].filter((p) => under(p) && !skip(p)).slice(0, MAX_FILES).map((p) => p.replace(/\\/g, '/'));
    if (!files.length) return;
    const task = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), agent, cwd: root.replace(/\\/g, '/'), task, files }) + '\n');
  } catch { /* logging must never break a run */ }
}

module.exports = { record };
