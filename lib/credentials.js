'use strict';
// Write-only credential store: the web page can save, list names/dates, replace and delete,
// but nothing here ever returns a saved value. Files live in secrets/<name>.env as KEY=value lines.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'secrets');
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function lockDir() {
  if (process.platform !== 'win32') { try { fs.chmodSync(DIR, 0o700); } catch { /* best effort */ } return; }
  // whoami is reliable even if the USERNAME variable is odd.
  const who = execFileSync('whoami', { encoding: 'utf8' }).trim();
  // Remove inherited access, then grant only this Windows user (files inside inherit it).
  execFileSync('icacls', [DIR, '/inheritance:r', '/grant:r', `${who}:(OI)(CI)F`], { stdio: 'ignore' });
}

function ensureDir() {
  if (fs.existsSync(DIR)) return;
  fs.mkdirSync(DIR, { recursive: true });
  lockDir();
}

function fileOf(name) {
  // Friendly names like "Mail Service Account on SERVER-1" become mail-service-account-on-server-1.
  name = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  if (!NAME_RE.test(name)) throw new Error('Name: letters, numbers, - and _ only (max 40).');
  return { name, file: path.join(DIR, name + '.env') };
}

// Names and dates only. "custom" = a file not made by this dialog (cannot be replaced from the page).
function list() {
  ensureDir();
  const out = [];
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.env')) continue;
    const name = f.slice(0, -4);
    if (!NAME_RE.test(name)) continue;
    const full = path.join(DIR, f);
    let custom = true;
    try { custom = !/^PASSWORD=/m.test(fs.readFileSync(full, 'utf8')); } catch { /* unreadable */ }
    out.push({ name, savedAt: fs.statSync(full).mtimeMs, custom });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function save({ name, username, password }) {
  const one = (v, label) => {
    v = String(v == null ? '' : v);
    if (/[\r\n\0]/.test(v)) throw new Error(`${label} cannot contain line breaks.`);
    if (v.length > 500) throw new Error(`${label} is too long.`);
    return v;
  };
  const { name: n, file } = fileOf(name);
  const u = one(username, 'Username'), p = one(password, 'Password');
  if (!p) throw new Error('Password is empty.');
  ensureDir();
  const existing = fs.existsSync(file) && list().find((x) => x.name === n);
  if (existing && existing.custom) throw new Error('That entry has its own layout. Delete it first to replace it.');
  fs.writeFileSync(file, `USERNAME=${u}\nPASSWORD=${p}\n`, { mode: 0o600 });
  return { name: n };
}

function remove(name) {
  const { file } = fileOf(name);
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

module.exports = { list, save, remove, DIR };
