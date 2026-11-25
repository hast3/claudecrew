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

  // Agents write only inside the allowed folders; the tripwire. Fake folders stand in for the real ones; nothing is created outside the temp folder.
  try {
    const guard = require('./guard');
    const { createRootWatch } = require('./rootwatch');
    const os = require('os');
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-fakeroot-'));
    try {
      const home = os.homedir();
      const proj = 'C:\\Claude Code\\Proj';
      const base = { ...guard.context(proj), allow: [] };
      const ctx = { ...base, writeFolders: ['C:/Claude Code', home.replace(/\\/g, '/') + '/.claude', '//nas-box/Data/DS/Diablo Modding', 'N:/DS/Diablo Modding'], extraWrite: [] };
      const ctxTower = { ...ctx, cwd: home + '\\Documents\\Unreal Projects\\TowerGame', extraWrite: [] };
      const ctxTowerOk = { ...ctxTower, extraWrite: [home.replace(/\\/g, '/') + '/Documents/Unreal Projects/TowerGame'] };
      const BL = '"C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe"';
      const SC = 'C:\\Claude Code\\Proj\\scratch\\r1';
      const NAS = '\\\\nas-box\\Data\\DS\\Diablo Modding\\Monster Files';
      const cases = [
        // refused: outside the list
        ['Bash', { command: 'mkdir C:\\newthing' }, true],
        ['Bash', { command: 'mkdir C:/newthing/sub' }, true],
        ['Bash', { command: 'mkdir -p /c/newthing' }, true],
        ['Bash', { command: 'echo hi > C:/loose.txt' }, true],
        ['Bash', { command: `echo hi > "${home}\\Documents\\note.txt"` }, true],
        ['Bash', { command: 'cp a.png ~/Desktop/a.png' }, true],
        ['Bash', { command: 'cp a.png /c/Users/the owner/Downloads/a.png' }, true],
        ['PowerShell', { command: `Set-Content -Path "${home}\\Documents\\a.txt" -Value hi` }, true],
        ['PowerShell', { command: `Out-File "${home}\\Documents\\a.txt"` }, true],
        ['PowerShell', { command: `New-Item -ItemType Directory "${home}\\Desktop\\x"` }, true],
        ['PowerShell', { command: `Copy-Item a.txt -Destination "${home}\\Documents\\a.txt"` }, true],
        ['PowerShell', { command: 'New-Item -ItemType Directory \\newthing' }, true],
        ['PowerShell', { command: 'mkdir /newthing' }, true],
        ['PowerShell', { command: 'Set-Location C:\\; mkdir out' }, true],
        ['Bash', { command: 'cd C:/ && touch x.txt' }, true],
        ['Bash', { command: 'cd ~/Documents && touch x.txt' }, true],
        ['Bash', { command: 'cp a.txt "C:/Claude Code/../Windows/a.txt"' }, true],
        ['Bash', { command: 'cp a.txt "N:/Other Share/a.txt"' }, true],
        ['Bash', { command: 'cp a.txt "\\\\nas-box\\Data\\Other\\a.txt"' }, true],
        ['Bash', { command: 'curl -o /tmp/x.zip https://example.com/x.zip' }, true],
        ['Bash', { command: 'python -c "import os; os.makedirs(\'/tmp/x\')"' }, true],
        ['Bash', { command: 'python -c "open(\'C:/Users/the owner/Documents/a.txt\',\'w\').write(\'x\')"' }, true],
        ['PowerShell', { command: 'python tool.py --out /tmp/x' }, true],
        ['Bash', { command: 'node -e "require(\'fs\').mkdirSync(\'C:\\\\newthing\')"' }, true],
        ['Bash', { command: 'git clone https://example.com/r.git "C:/Users/the owner/Documents/r"' }, true],
        ['Write', { file_path: 'C:\\newthing\\a.txt' }, true],
        ['Write', { file_path: '/tmp/x/a.txt' }, true],
        ['Write', { file_path: home + '\\Documents\\a.txt' }, true],
        ['Edit', { file_path: 'C:\\Claude Code\\..\\Windows\\a.txt' }, true],
        // the try3 / t1 style Blender lines (relative output, wherever Blender was started)
        ['PowerShell', { command: `& ${BL} -b scene.blend -P render.py -- try3` }, true],
        ['Bash', { command: `${BL} -b scene.blend --python r.py -- --out t1` }, true],
        ['Bash', { command: `${BL} -b scene.blend -o //render/frame_#### -f 1` }, true],
        ['Bash', { command: 'blender -b x.blend --render-output out/f_#### -a' }, true],
        ['Bash', { command: 'blender -b x.blend -P r.py -- --output-dir=try3' }, true],
        ['Bash', { command: `blender -b x.blend -o "${home}\\Documents\\f_####" -a` }, true],
        // allowed
        ['Bash', { command: `${BL} -b scene.blend -o "${SC}\\frame_####" -f 1` }, false],
        ['PowerShell', { command: `& ${BL} -b scene.blend -P render.py -- --out "${SC}" --frames 24` }, false],
        ['Bash', { command: `blender -b x.blend -P r.py -- --samples 64 --out "${SC}"` }, false],
        ['Bash', { command: 'blender --version' }, false],
        ['Bash', { command: 'ls C:/nothing-here && cat C:\\nothing-here\\a.txt' }, false],
        ['PowerShell', { command: `Get-ChildItem C:\\nothing-here; Test-Path "${home}\\Documents"; Get-Content "${home}\\Documents\\a.txt"` }, false],
        ['Bash', { command: 'mkdir -p "C:/Claude Code/Proj/scratch/r1" && echo x > "C:/Claude Code/Proj/scratch/a.txt"' }, false],
        ['Bash', { command: 'echo x > a.txt && cp a.txt b.txt && mkdir sub' }, false],
        ['Bash', { command: 'cat /tmp/note.txt; ls /tmp' }, false],
        ['Bash', { command: 'git commit -m "tidy C:\\newthing mention > notes"' }, false],
        ['Bash', { command: 'node tools/status.js agentx "saw C:\\newthing" done none' }, false],
        ['Bash', { command: 'python tool.py --out "C:/Claude Code/Proj/scratch/x"' }, false],
        ['Bash', { command: 'node -e "const f = (a) => a; console.log(f(1))"' }, false],
        ['Bash', { command: 'git clone https://example.com/r.git "C:/Claude Code/r"' }, false],
        ['Bash', { command: 'ssh util-box "cat > /tmp/x"; scp a.txt util-box:/tmp/a.txt' }, false],
        ['Bash', { command: 'govc vm.info realm-gs' }, false],
        ['Bash', { command: `cp a.dat "${NAS}\\a.dat"` }, false],
        ['PowerShell', { command: 'Copy-Item a.dat "N:\\DS\\Diablo Modding\\Monster Files\\a.dat"' }, false],
        ['Bash', { command: `cd "${home}\\.claude" && echo x > n.md` }, false],
        ['Write', { file_path: 'C:\\Claude Code\\Proj\\scratch\\a.txt' }, false],
        ['Write', { file_path: 'workspace\\x\\a.txt' }, false],
        ['Write', { file_path: home + '\\.claude\\projects\\x\\memory\\m.md' }, false],
        ['Write', { file_path: NAS + '\\notes.txt' }, false],
        ['Write', { file_path: 'N:\\DS\\Diablo Modding\\Monster Files\\notes.txt' }, false],
      ];
      const wrong = cases.filter(([n, i, deny]) => !!guard.check(n, i, proj, ctx) !== deny);
      const hardOk = guard.isHard(guard.check('Bash', { command: 'mkdir C:\\newthing' }, proj, { ...ctx, allow: ['Bash(mkdir C:\\newthing)'] }));
      // Per-agent extra folder: empty = refused, set = allowed (and nothing else opens up).
      const towerFile = { file_path: ctxTower.cwd + '\\Source\\a.cpp' };
      const extraOk = guard.check('Write', towerFile, ctxTower.cwd, ctxTower) && !guard.check('Write', towerFile, ctxTower.cwd, ctxTowerOk)
        && !!guard.check('Write', { file_path: home + '\\Documents\\other.txt' }, ctxTower.cwd, ctxTowerOk);
      // No list configured: only the relative-Blender rule applies.
      const noList = { ...ctx, writeFolders: [] };
      const noListOk = !guard.check('Write', { file_path: 'C:\\newthing\\a.txt' }, proj, noList) && !!guard.check('Bash', { command: 'blender -b x.blend -P r.py -- try3' }, proj, noList);
      if (wrong.length) bad('write folders guard', wrong.map(([n, i, deny]) => `${deny ? 'should refuse' : 'should allow'}: ${n} ${i.command || i.file_path}`).join('; '));
      else if (!hardOk) bad('write folders guard', 'a refusal could be approved away');
      else if (!extraOk) bad('write folders guard', 'the per-agent extra folder setting does not work');
      else if (!noListOk) bad('write folders guard', 'with no folder list only the Blender rule should apply');
      else ok(`write folders guard (${cases.length + 3} cases)`);

      // Tripwire against fake folders: existing entries and system files are ignored; overlap lists every run.
      const { IGNORE_ROOT, IGNORE_HOME } = require('./rootwatch');
      const rootDir = path.join(fake, 'root'), homeDir = path.join(fake, 'home');
      for (const d of [rootDir, homeDir, path.join(homeDir, 'Documents'), path.join(rootDir, 'try3')]) fs.mkdirSync(d, { recursive: true });
      const watched = [{ dir: rootDir, ignore: IGNORE_ROOT }, { dir: homeDir, ignore: IGNORE_HOME }, { dir: path.join(homeDir, 'Documents'), ignore: IGNORE_HOME }];
      let t = 1000;
      const wakes = [];
      const w = createRootWatch({ watched, now: () => t, nameOf: (id) => id.toUpperCase(), assistant: 'assistant', wake: (id, text) => wakes.push({ id, text }) });
      const prob = [];
      const eq = (what, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) prob.push(`${what}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); };
      t = 1100; w.begin('sanc');
      fs.writeFileSync(path.join(rootDir, 'pagefile.sys'), ''); fs.mkdirSync(path.join(rootDir, '$Recycle.Bin')); fs.mkdirSync(path.join(homeDir, '.cache')); fs.writeFileSync(path.join(homeDir, 'desktop.ini'), '');
      t = 1200; w.end('sanc');
      eq('system files: nobody woken', wakes.length, 0);
      t = 1300; w.begin('sanc');
      fs.mkdirSync(path.join(rootDir, 'try4'));
      t = 1400; w.end('sanc');
      eq('single run: who was woken', wakes.map((x) => x.id).sort(), ['assistant', 'sanc']);
      eq('names the entry and the run', /try4/.test(wakes[0].text) && /@sanc/.test(wakes.find((x) => x.id === 'assistant').text), true);
      eq('nothing deleted', fs.existsSync(path.join(rootDir, 'try4')), true);
      wakes.length = 0;
      t = 1500; w.begin('sanc'); t = 1510; w.begin('agentx');
      fs.writeFileSync(path.join(homeDir, 'Documents', 'mystery.txt'), '');
      t = 1600; w.end('agentx'); t = 1700; w.end('sanc');
      eq('overlap: every candidate told', wakes.map((x) => x.id).sort(), ['agentx', 'assistant', 'sanc']);
      const aw = (wakes.find((x) => x.id === 'assistant') || {}).text || '';
      eq('overlap: says cause not known, lists both, names the file', /not known/.test(aw) && /@agentx/.test(aw) && /@sanc/.test(aw) && /mystery\.txt/.test(aw), true);
      wakes.length = 0;
      fs.mkdirSync(path.join(homeDir, 'later')); t = 1800; w.begin('agentx'); t = 1900; w.end('agentx');
      eq('made between runs: no agent blamed', wakes.length, 0);
      if (prob.length) bad('tripwire', prob.join('; '));
      else ok('tripwire (fake folders)');
    } finally { fs.rmSync(fake, { recursive: true, force: true }); }
  } catch (e) { bad('write folders guard', e.message); }


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
