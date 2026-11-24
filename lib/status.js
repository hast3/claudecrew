// STATUS.md helpers: read the crew's status lines (any layout) and write new ones in one fixed layout.
const fs = require('fs');

const NONE = /^(|-|none|nobody|no one|n\/a|nothing)$/i;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// One line -> { date, time, id, item, state, waiting, text } or null.
function parseLine(raw, ids, owner) {
  let s = String(raw || '').trim().replace(/^[-*]\s+/, '');
  const m = /^(\d{4}-\d\d-\d\d)(?:\s+(\d\d:\d\d))?\s*(.*)$/.exec(s);
  if (!m) return null;
  const out = { date: m[1], time: m[2] || '', id: '', item: '', state: '', waiting: '', text: '' };
  let rest = m[3].replace(/^\|\s*/, '');
  if (rest.includes('|')) {
    const p = rest.split('|').map((x) => x.trim());
    out.id = (p[0] || '').replace(/^@/, '').replace(/:$/, '').toLowerCase();
    out.item = p[1] || '';
    out.state = p[2] || '';
    out.waiting = p.slice(3).join(' | ');
    out.text = [out.item, out.state].filter(Boolean).join(': ');
  } else {
    const im = /^@?([a-z0-9]+):?\s+(.*)$/i.exec(rest);
    out.id = im ? im[1].toLowerCase() : '';
    out.text = im ? im[2] : rest;
    out.item = out.text;
    const w = /waiting[- ]on:?\s*(.+?)\.?$/i.exec(out.text);
    out.waiting = w ? w[1] : '';
    if (!out.waiting && /\bblocked\b/i.test(out.text)) out.waiting = '?';
    out.state = /\bdone\b/i.test(out.text) ? 'done' : '';
  }
  out.waiting = NONE.test(out.waiting.trim()) ? '' : out.waiting.trim();
  out.blocked = !!out.waiting && !/^done\b/i.test(out.state);
  // who is the ball with
  const low = out.waiting.toLowerCase();
  // 'user' = the ball is with the person who runs Crew (named by settings.userName).
  const ownerLow = String(owner || '').trim().toLowerCase();
  const onOwner = ownerLow && new RegExp(`\\b${ownerLow.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(low);
  out.on = (ids || []).find((i) => new RegExp(`\\b${i}\\b`).test(low)) || (onOwner ? 'user' : '');
  return out;
}

function read(file, ids, owner, max = 200) {
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { return { feed: [], blocked: [] }; }
  const parsed = lines.map((l) => parseLine(l, ids, owner)).filter((x) => x && x.id).slice(-max);
  // Newest by date+time when stamped, else file order.
  const feed = parsed.map((x, i) => ({ ...x, i })).sort((a, b) => (`${b.date} ${b.time || '00:00'}`).localeCompare(`${a.date} ${a.time || '00:00'}`) || b.i - a.i);
  // Blocked board: each agent's most recent line, if it is waiting on someone.
  const seen = new Set();
  const blocked = [];
  for (const x of feed) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    if (x.blocked) blocked.push(x);
  }
  return { feed: feed.slice(0, 60), blocked };
}

function append(file, id, item, state, waiting) {
  const clean = (v) => String(v ?? '').replace(/[\r\n|]+/g, ' ').trim();
  const line = `${stamp()} | @${clean(id).replace(/^@/, '')} | ${clean(item)} | ${clean(state)} | ${clean(waiting) || '-'}\n`;
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.appendFileSync(file, (cur && !cur.endsWith('\n') ? '\n' : '') + line);
  return line.trim();
}

module.exports = { parseLine, read, append, stamp };
