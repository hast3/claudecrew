'use strict';
// Crew health check: run `npm run check` (or `node lib/check.js`) after changing Crew.
// It compiles everything without running it, so it's safe while Crew is live:
//   - server.js, lib/*.js and public/sw.js parse as JavaScript
//   - every inline <script> in public/index.html parses (a single bad quote there
//     blanks the whole web UI, which is what happened on 2026-11-16)
//   - crew.config.json, package.json and the web app manifest are valid JSON
//   - agents in crew.config.json have unique, valid ids
// Exit code 0 = all good. The server also uses checkPage() to refuse a broken page.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Returns null if every inline script in the HTML compiles, else { message, line } (line in the HTML file).
function checkPage(html) {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    if (/\bsrc\s*=/.test(attrs)) continue;
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    if (type && !/^(text\/javascript|application\/javascript|module)$/i.test(type)) continue; // JSON, templates
    const firstLine = html.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length;
    try {
      new vm.Script(m[2], { filename: 'inline-script' });
    } catch (e) {
      const at = (String(e.stack).match(/inline-script:(\d+)/) || [])[1];
      return { message: e.message, line: at ? firstLine + Number(at) - 1 : firstLine };
    }
  }
  return null;
}

function checkJsFile(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    return null;
  } catch (e) {
    const out = String(e.stderr || e.message);
    const where = (out.match(/:(\d+)\r?\n/) || [])[1];
    const msg = (out.split('\n').find((l) => /Error/.test(l)) || out.split('\n')[0]).trim();
    return where ? `line ${where}: ${msg}` : msg;
  }
}

function run() {
  const results = [];
  const ok = (what) => results.push({ ok: true, what });
  const bad = (what, why) => results.push({ ok: false, what, why });
  const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');

  // JavaScript files
  const jsFiles = [path.join(ROOT, 'server.js')];
  for (const dir of ['lib', 'public']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) if (f.endsWith('.js')) jsFiles.push(path.join(ROOT, dir, f));
  }
  for (const f of jsFiles) {
    const err = checkJsFile(f);
    err ? bad(rel(f), err) : ok(rel(f));
  }

  // The web page
  const pageFile = path.join(ROOT, 'public', 'index.html');
  const pageErr = checkPage(fs.readFileSync(pageFile, 'utf8'));
  pageErr ? bad('public/index.html', `line ${pageErr.line}: ${pageErr.message}`) : ok('public/index.html (page scripts)');

  const setupErr = checkPage(fs.readFileSync(path.join(ROOT, 'public', 'setup.html'), 'utf8'));
  setupErr ? bad('public/setup.html', `line ${setupErr.line}: ${setupErr.message}`) : ok('public/setup.html (page scripts)');

  // JSON files
  let config = null;
  for (const f of ['crew.config.json', 'package.json', 'public/manifest.webmanifest']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
      if (f === 'crew.config.json') config = j;
      ok(f);
    } catch (e) {
      bad(f, e.message);
    }
  }

  // Agent list sanity
  if (config) {
    const ids = (config.agents || []).map((a) => String(a.id || '').toLowerCase());
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    const invalid = ids.filter((id) => !/^[a-z][a-z0-9-]*$/.test(id) || id === 'all');
    if (!ids.length) bad('agents', 'crew.config.json has no agents');
    else if (dupes.length) bad('agents', `duplicate id(s): ${[...new Set(dupes)].join(', ')}`);
    else if (invalid.length) bad('agents', `invalid id(s): ${invalid.join(', ')}`);
    else ok(`agents (${ids.length})`);
  }

  // Guard hook: risky things are refused, everyday work is not.
  try {
    const guard = require('./guard');
    const os = require('os');
    const home = os.homedir();
    const proj = path.join(ROOT, 'workspace', 'webapp');
    const ctx = { ...guard.context(proj), allow: [] };
    const cases = [
      ['Bash', { command: 'rm -rf /' }, true],
      ['PowerShell', { command: 'Remove-Item -Recurse -Force C:\\' }, true],
      ['Bash', { command: `rm -rf "${home.replace(/\\/g, '/')}/Documents"` }, true],
      ['Bash', { command: 'git push --force origin master' }, true],
      ['Bash', { command: 'diskpart /s wipe.txt' }, true],
      ['Bash', { command: 'govc vm.power -off realm-gs' }, true],
      ['PowerShell', { command: 'reg delete HKCU\\Software\\Foo /f' }, true],
      ['Bash', { command: 'cp new.d2s "C:/Games/save/Hero.d2s"' }, true],
      ['Write', { file_path: path.join(home, 'Desktop', 'notes.txt') }, true],
      ['Bash', { command: 'rm -rf ./build node_modules && npm run check' }, false],
      ['Bash', { command: 'git push origin master && git status' }, false],
      ['PowerShell', { command: 'Remove-Item -Force out.log' }, false],
      ['Bash', { command: 'govc vm.info realm-gs' }, false],
      ['Write', { file_path: path.join(home, '.claude', 'projects', 'x', 'memory', 'a.md') }, false],
      ['Edit', { file_path: path.join(proj, 'CLAUDE.md') }, false],
    ];
    const wrong = cases.filter(([n, i, deny]) => !!guard.check(n, i, proj, ctx) !== deny);
    const appr = guard.check('Bash', { command: 'rm -rf /' }, proj, { ...ctx, allow: ['Bash(rm -rf /)'] });
    if (wrong.length) bad('guard hook', wrong.map(([n, i, deny]) => `${deny ? 'should refuse' : 'should allow'}: ${n} ${i.command || i.file_path}`).join('; '));
    else if (appr) bad('guard hook', 'an approved action is still refused');
    else ok(`guard hook (${cases.length + 1} cases)`);
  } catch (e) { bad('guard hook', e.message); }

  // Silent-run watchdog and hand-off-limit notice, with shortened timers and a fake clock.
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, 'watchdog-test.js')], { encoding: 'utf8', timeout: 20000 });
    if (/^ok\b/m.test(out)) ok('watchdog + hand-off limit tests');
    else bad('watchdog tests', out.trim());
  } catch (e) { bad('watchdog tests', String(e.stdout || e.message).trim().slice(0, 600)); }

  for (const r of results) console.log(`${r.ok ? '  ok  ' : ' FAIL '} ${r.what}${r.ok ? '' : `\n        ${r.why}`}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} problem(s). Fix them before saying the change is done.` : '\nAll checks passed.');
  return failed ? 1 : 0;
}

if (require.main === module) process.exit(run());

module.exports = { checkPage };
