'use strict';
// Update check and self-update. Checks the latest GitHub release (unauthenticated, quiet on failure)
// and can update this install in place: `git` if it is a clone, otherwise the release zip overlaid.
// Never touches the user's own files (see KEEP).
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
// Top-level names an update must never overwrite or delete.
const KEEP = (name) => ['crew.config.json', 'data', 'workspace', 'node_modules', '.git', '.env'].includes(name)
  || name.startsWith('.env.') || name.includes('.bak') || name.includes('secrets');

function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function newer(a, b) { // is a newer than b
  const x = parse(a), y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function get(url, { json = false, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('http:') ? http : https).get(url, { headers: { 'User-Agent': 'claude-crew-updater', Accept: json ? 'application/vnd.github+json' : '*/*' }, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), { json, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(json ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error((String(stderr || stdout || err.message)).trim().split('\n').slice(-3).join(' ')));
      resolve(String(stdout).trim());
    });
  });
}

function createUpdater({ root, dataDir, repo, supervised, log = () => {} }) {
  const readVersion = () => {
    try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
  };
  const info = { current: readVersion(), latest: null, available: false, url: null, checkedAt: null, error: null, busy: false, updatedTo: null };
  // CREW_UPDATE_API lets tests point at a local fake of the GitHub API.
  const apiBase = process.env.CREW_UPDATE_API || 'https://api.github.com';
  let timer = null;

  async function check() {
    try {
      const rel = await get(`${apiBase}/repos/${repo}/releases/latest`, { json: true });
      info.current = readVersion();
      info.latest = String(rel.tag_name || '').replace(/^v/, '') || null;
      info.url = rel.html_url || `https://github.com/${repo}/releases`;
      info.available = !info.updatedTo && newer(info.latest, info.current);
      info.error = null;
    } catch (err) {
      info.error = err.message; // offline, private repo or rate limited: stay quiet
    }
    info.checkedAt = Date.now();
    return info;
  }

  function start() {
    check();
    timer = setInterval(check, CHECK_EVERY_MS);
    timer.unref();
  }

  const isGit = () => fs.existsSync(path.join(root, '.git'));

  async function viaGit(tag) {
    const before = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    await run('git', ['fetch', '--tags', 'origin'], { cwd: root });
    // Fast-forward to the release itself (not whatever main holds), so users get what was announced.
    await run('git', ['merge', '--ff-only', `refs/tags/${tag}`], { cwd: root });
    const after = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    if (before !== after) {
      const p = (s) => { try { const j = JSON.parse(s); return JSON.stringify([j.dependencies, j.devDependencies]); } catch { return s; } };
      if (p(before) !== p(after)) await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev'], { cwd: root, shell: process.platform === 'win32' });
    }
  }

  async function extract(zipFile, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const attempts = [['tar', ['-xf', zipFile, '-C', dest]], ['unzip', ['-q', '-o', zipFile, '-d', dest]]];
    if (process.platform === 'win32') attempts.push(['powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${dest}' -Force`]]);
    let last;
    for (const [cmd, args] of attempts) {
      try { await run(cmd, args); return; } catch (err) { last = err; }
    }
    throw new Error(`could not unpack the download (${last.message})`);
  }

  async function viaZip(tag) {
    const tmp = path.join(dataDir, 'update-tmp');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const zipUrl = process.env.CREW_UPDATE_ZIP || `https://github.com/${repo}/archive/refs/tags/${tag}.zip`;
      const zipFile = path.join(tmp, 'release.zip');
      fs.writeFileSync(zipFile, await get(zipUrl));
      const out = path.join(tmp, 'out');
      await extract(zipFile, out);
      const tops = fs.readdirSync(out);
      const src = tops.length === 1 && fs.statSync(path.join(out, tops[0])).isDirectory() ? path.join(out, tops[0]) : out;
      if (!fs.existsSync(path.join(src, 'server.js'))) throw new Error('the download did not look like Claude Crew');
      for (const name of fs.readdirSync(src)) {
        if (KEEP(name)) continue;
        if (supervised && name === 'run-crew.cmd') continue; // that script is running right now
        fs.cpSync(path.join(src, name), path.join(root, name), { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async function apply() {
    if (info.busy) throw new Error('an update is already running');
    await check();
    if (!info.available) throw new Error(info.error ? `can't reach GitHub (${info.error})` : 'already up to date');
    info.busy = true;
    const tag = `v${info.latest}`;
    try {
      if (isGit()) await viaGit(tag); else await viaZip(tag);
      info.updatedTo = info.latest;
      info.available = false;
      info.current = readVersion();
      log(`Updated to ${info.latest}`);
      return { ok: true, version: info.latest, restarting: !!supervised };
    } finally {
      info.busy = false;
    }
  }

  return { start, check, apply, status: () => ({ ...info }) };
}

module.exports = { createUpdater, newer };
