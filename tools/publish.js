// Publish a scrubbed snapshot of Claude Crew to the public GitHub repo.
//
//   node tools/publish.js --go       build, verify, commit and push to origin main (+ tag v<version>)
//   node tools/publish.js --go --release   same, then create the GitHub release v<version> with uninstall.ps1 + UNINSTALL.bat attached
//   node tools/publish.js            no flag = same as --dry (nothing is ever pushed without --go)
//   node tools/publish.js --dry      build and verify only; leaves scratch/publish to inspect
//   node tools/publish.js --notes "first bullet|second bullet"   changelog bullets (default: recent commit subjects)
//
// The private repo (this folder) keeps the real config, rules, ledger, notes and full history.
// The public repo gets its own linear history (branch main, author "Hast3" with a noreply address):
//   - tracked files only, minus the private ones in EXCLUDE
//   - crew.config.example.json built from the real config's shape with example values
//   - LICENSE and CHANGELOG.md carried over from the public branch, with a new section on top
//   - the owner's name, Windows user folder and any personal values from crew.config.json scrubbed
//   - the real agents' pictures (public/avatars/<real id>.png) left out; the "local" block of crew.config.json is never copied
// It refuses to push if any identifying string is still found in the export: every real agent id, name and
// folder (whole words, case-insensitive) and the machine names, checked in file contents AND file names.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'scratch', 'publish');
const REMOTE = 'origin';
const BRANCH = 'main';
const AUTHOR = { name: 'Hast3', email: 'hast3@users.noreply.github.com' };
const EXCLUDE = new Set(['crew.config.json', 'crew-rules.md', 'TOOLS.md', 'LEDGER.md', 'docs/AUTOMATIONS.md']);
const TEXT_EXT = new Set(['.js', '.json', '.md', '.html', '.css', '.ps1', '.cmd', '.bat', '.txt', '.webmanifest', '.svg', '.gitignore', '.yml', '.yaml']);
const EXAMPLE_AGENTS = [
  { id: 'assistant', name: 'Assistant', emoji: '🧭', avatar: 'compass', cwd: 'workspace/assistant',
    description: 'General helper and coordinator. Answers questions, makes plans, and hands project work to the right teammate.',
    instructions: 'You coordinate the crew. Answer general questions yourself. When a request belongs to a teammate\'s project, hand it to that one teammate with a short, specific brief.' },
  { id: 'webapp', name: 'WebApp', emoji: '🛠️', avatar: 'tools', cwd: 'workspace/webapp',
    description: 'Works on the my-web-app project: features, bug fixes and tests.',
    instructions: 'Run the test suite before you say a change is done. Commit locally only; never push.' },
  { id: 'docs', name: 'Docs', emoji: '📚', avatar: 'book', cwd: 'workspace/docs',
    description: 'Writes and tidies documentation.',
    instructions: 'Keep wording plain. Never invent features; read the code first.' },
];

const EXAMPLE_IDS = new Set(EXAMPLE_AGENTS.map((a) => a.id));
// Words allowed to appear even though a real agent has the same id or name. Keep this empty unless a generic
// word truly cannot be avoided, and say why next to each one.
const ALLOWED_WORDS = new Set([]);

const args = process.argv.slice(2);
const dry = args.includes('--dry') || !args.includes('--go');
const makeRelease = args.includes('--release');
const notesArg = args.includes('--notes') ? args[args.indexOf('--notes') + 1] : '';

function git(cmd, opts = {}) {
  return execFileSync('git', cmd, { cwd: opts.cwd || ROOT, encoding: 'utf8', env: { ...process.env, ...(opts.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function show(ref) { try { return git(['show', ref]); } catch { return ''; } }
function isText(f) { return TEXT_EXT.has(path.extname(f).toLowerCase()) || path.basename(f) === '.gitignore'; }
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------------------------------------------------------------- what counts as identifying
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'crew.config.json'), 'utf8'));
const owner = String(config.settings?.userName || '').trim();
const winUser = os.userInfo().username;
const gitName = (() => { try { return git(['config', 'user.name']); } catch { return ''; } })();
const gitEmail = (() => { try { return git(['config', 'user.email']); } catch { return ''; } })();

// Replacements applied to every text file in the export (order matters).
const replacements = [];
if (owner) {
  replacements.push([new RegExp(`\\b${esc(owner)}'s\\b`, 'g'), "the owner's"]);
  replacements.push([new RegExp(`\\b${esc(owner)}\\b`, 'g'), 'the owner']);
}
for (const u of new Set([winUser, owner].filter(Boolean))) {
  replacements.push([new RegExp(`C:\\\\\\\\Users\\\\\\\\${esc(u)}\\b`, 'g'), 'C:\\\\Users\\\\<you>']); // escaped form inside JS strings
  replacements.push([new RegExp(`C:\\\\Users\\\\${esc(u)}\\b`, 'g'), 'C:\\Users\\<you>']);
  replacements.push([new RegExp(`C:/Users/${esc(u)}\\b`, 'g'), 'C:/Users/<you>']);
}

// Anything matching these after scrubbing aborts the publish. Values come from the local config
// and git identity, so the script itself holds no personal strings.
const forbidden = [];
const words = []; // whole-word terms (agent ids, names, folders, machine names); also checked against file names
const addForbidden = (label, v) => { if (v && String(v).trim() && !/example\.com|cloudflareaccess\.com$|^your-/.test(String(v))) forbidden.push([label, new RegExp(esc(String(v)), 'i')]); };
addForbidden('owner name', owner);
addForbidden('windows user folder', `Users\\${winUser}`);
addForbidden('windows user folder', `Users/${winUser}`);
addForbidden('git user.name', gitName);
addForbidden('git user.email', gitEmail);
if (gitEmail.includes('@')) addForbidden('git email local part', gitEmail.split('@')[0]);
for (const part of gitName.split(/\s+/).filter((p) => p.length > 3)) addForbidden('git name part', part);
addForbidden('cloudflare hostname', config.cloudflare?.hostname);
addForbidden('cloudflare team', config.cloudflare?.teamDomain);
addForbidden('cloudflare aud', config.cloudflare?.aud);
for (const e of config.cloudflare?.allowedEmails || []) addForbidden('allowed email', e);
for (const a of config.agents || []) if (/^[A-Z]:[\\/]/.test(a.cwd || '')) addForbidden('agent folder', a.cwd);
// Every real agent (anyone not in EXAMPLE_AGENTS): id, name and folder, as whole words.
const realIds = new Set();
const addWord = (label, v) => {
  const t = String(v || '').trim();
  if (t.length < 3 || ALLOWED_WORDS.has(t.toLowerCase())) return;
  words.push([label, new RegExp('(?<![A-Za-z0-9])' + esc(t) + '(?![A-Za-z0-9])', 'i')]);
};
const fwd = (p) => String(p).split(path.sep).join('/').split(String.fromCharCode(92)).join('/');
for (const a of config.agents || []) {
  if (EXAMPLE_IDS.has(a.id)) continue;
  realIds.add(a.id);
  addWord('agent id', a.id);
  addWord('agent name', a.name);
  const cwd = fwd(a.cwd || '');
  if (!cwd || cwd === '.') continue;
  const abs = fwd(path.resolve(ROOT, cwd));
  const root = fwd(ROOT).toLowerCase();
  const inside = abs.toLowerCase() === root || abs.toLowerCase().startsWith(root + '/');
  addWord('agent folder', path.basename(abs));
  if (!inside) { addWord('agent folder path', abs); addWord('agent folder path', abs.split('/').join(String.fromCharCode(92))); }
}
for (const m of [os.hostname(), process.env.COMPUTERNAME, ...(Array.isArray(config.local?.machineNames) ? config.local.machineNames : [])]) addWord('machine name', m);
forbidden.push(['any e-mail address', /\b[a-z0-9._%+-]+@(gmail|outlook|hotmail|yahoo|icloud|proton)\.[a-z]+\b/i]);
forbidden.push(['LAN address other than the documented examples', /\b192\.168\.(?!x\.x\b|1\.20\b)\d+\.\d+\b/]);

// ---------------------------------------------------------------- build the export
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
git(['fetch', '-q', REMOTE]);
if (fs.existsSync(OUT)) { try { git(['worktree', 'remove', '--force', OUT]); } catch { fs.rmSync(OUT, { recursive: true, force: true }); } }
git(['worktree', 'prune']);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
git(['worktree', 'add', '--detach', '-q', OUT, `${REMOTE}/${BRANCH}`]);
// Carry over the two files the public branch owns, then empty it.
const license = show(`${REMOTE}/${BRANCH}:LICENSE`);
let changelog = show(`${REMOTE}/${BRANCH}:CHANGELOG.md`) || '# Changelog\n';
// Older entries (already public, history is never rewritten) may name real agents: drop those lines from the new version.
const dropped = changelog.split('\n').filter((l) => words.some(([, re]) => re.test(l)));
if (dropped.length) { changelog = changelog.split('\n').filter((l) => !dropped.includes(l)).join('\n'); console.log(`Changelog: dropped ${dropped.length} old line(s) that named real agents.`); }
git(['rm', '-rq', '.'], { cwd: OUT });

const files = git(['ls-files', '-z']).split('\0').filter(Boolean).filter((f) => !EXCLUDE.has(f))
  .filter((f) => { const m = f.match(/^public\/avatars\/(.+)\.png$/i); return !(m && realIds.has(m[1].toLowerCase())); });
const scrub = (s) => replacements.reduce((acc, [re, to]) => acc.replace(re, to), s);
let changed = 0;
for (const f of files) {
  const dest = path.join(OUT, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (isText(f)) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const out = scrub(src);
    if (out !== src) changed++;
    fs.writeFileSync(dest, out);
  } else fs.copyFileSync(path.join(ROOT, f), dest);
}

// Example config: real shape, example values, generic agents.
const example = {
  settings: { ...config.settings, userName: 'You', claudePath: null, groupCaps: {} },
  cloudflare: { enabled: false, hostname: 'crew.example.com', teamDomain: 'myteam.cloudflareaccess.com', aud: 'your-access-application-aud-tag', port: config.cloudflare?.port || 7778, allowedEmails: ['you@example.com'] },
  agents: EXAMPLE_AGENTS,
};
delete example.local; // private per-install settings are never published
fs.writeFileSync(path.join(OUT, 'crew.config.example.json'), JSON.stringify(example, null, 2) + '\n');

// .gitignore: ours plus the public-only entries (the real config is never committed there).
const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').trimEnd().split(/\r?\n/);
for (const extra of ['crew.config.json', '.env', 'install-log.txt', 'runtime/']) if (!ignore.includes(extra)) ignore.push(extra);
fs.writeFileSync(path.join(OUT, '.gitignore'), ignore.join('\n') + '\n');
if (license) fs.writeFileSync(path.join(OUT, 'LICENSE'), license + '\n');

// Changelog: add a section for this version unless it is already there.
if (!changelog.includes(`## ${version}\n`)) {
  let bullets = notesArg ? notesArg.split('|').map((s) => s.trim()).filter(Boolean) : [];
  if (!bullets.length) {
    const markerFile = path.join(ROOT, 'data', 'publish-last.json');
    let since = '';
    try { since = JSON.parse(fs.readFileSync(markerFile, 'utf8')).sha; } catch {}
    const range = since ? [`${since}..HEAD`] : ['-n', '30'];
    bullets = git(['log', '--format=%s', ...range]).split('\n').map((s) => s.replace(/\s*\(v\d+\.\d+\.\d+\)\s*$/, '').trim()).filter(Boolean);
  }
  bullets = bullets.filter((b) => !words.some(([, re]) => re.test(b)) && !forbidden.some(([, re]) => re.test(scrub(b))));
  changelog = changelog.replace(/^# Changelog\s*\n/, `# Changelog\n\n## ${version}\n${bullets.map((b) => `- ${b}`).join('\n')}\n`);
}
fs.writeFileSync(path.join(OUT, 'CHANGELOG.md'), scrub(changelog));

// ---------------------------------------------------------------- verify
const problems = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = path.join(dir, e.name);
    const rel = fwd(path.relative(OUT, p));
    for (const [label, re] of words) { const m = rel.match(re); if (m) problems.push(`${rel}: file name has a ${label} ("${m[0]}")`); }
    if (e.isDirectory()) { walk(p); continue; }
    if (!isText(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    for (const [label, re] of [...forbidden, ...words]) {
      const m = text.match(re);
      if (m) problems.push(`${path.relative(OUT, p)}: ${label} ("${m[0]}")`);
    }
    if (p.endsWith('.js')) {
      try { execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' }); } catch (err) { problems.push(`${path.relative(OUT, p)}: syntax error after scrub\n${String(err.stderr || err.message).trim()}`); }
    }
  }
};
walk(OUT);
if (problems.length) {
  console.error(`REFUSED: ${problems.length} problem(s) in the export (nothing pushed):`);
  for (const p of problems) console.error('  - ' + p);
  console.error(`Inspect ${OUT}`);
  process.exit(1);
}

git(['add', '-A'], { cwd: OUT });
const stat = git(['status', '--porcelain'], { cwd: OUT });
console.log(`Export: ${files.length} files (${changed} scrubbed), ${stat ? stat.split('\n').length : 0} changed vs ${REMOTE}/${BRANCH}, version ${version}`);
if (dry) { console.log(`Dry run. Inspect ${OUT} (git diff --cached there). Remove with: git worktree remove --force "${OUT}"`); process.exit(0); }
if (!stat) { console.log('Nothing to publish.'); git(['worktree', 'remove', '--force', OUT]); process.exit(0); }

const identity = { GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email };
// --no-verify: the repo's pre-commit hook checks the private tree (it needs crew.config.json,
// which the export deliberately lacks). The export was already syntax-checked and scrubbed above.
git(['commit', '-q', '--no-verify', '-m', `v${version}`], { cwd: OUT, env: identity });
const tags = git(['ls-remote', '--tags', REMOTE]).split('\n').map((l) => l.split('\t')[1]).filter(Boolean);
const tagIt = !tags.includes(`refs/tags/v${version}`);
if (tagIt) git(['tag', '-a', `v${version}`, '-m', `v${version}`], { cwd: OUT, env: identity });
git(['push', '-q', REMOTE, `HEAD:${BRANCH}`], { cwd: OUT });
if (tagIt) git(['push', '-q', REMOTE, `v${version}`], { cwd: OUT });
const pushed = git(['rev-parse', '--short', 'HEAD'], { cwd: OUT });
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data', 'publish-last.json'), JSON.stringify({ sha: git(['rev-parse', 'HEAD']), version, when: new Date().toISOString() }, null, 2));
if (makeRelease) {
  const gh = (a) => execFileSync('gh', a, { cwd: OUT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const slug = git(['remote', 'get-url', REMOTE]).replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '');
  const assets = ['uninstall.ps1', 'UNINSTALL.bat'].map((f) => path.join(OUT, f)).filter((f) => fs.existsSync(f));
  let have = true; try { gh(['release', 'view', `v${version}`, '--repo', slug]); } catch { have = false; }
  if (have) gh(['release', 'upload', `v${version}`, ...assets, '--clobber', '--repo', slug]);
  else gh(['release', 'create', `v${version}`, ...assets, '--repo', slug, '--title', `Claude Crew v${version}`, '--notes', (notesArg || `Claude Crew v${version}.`) + '\n\nTo remove Claude Crew completely: download UNINSTALL.bat and uninstall.ps1 into one folder and double-click UNINSTALL.bat (add -DryRun to preview).']);
  console.log(`Release v${version} on ${slug} with ${assets.length} uninstall file(s) attached.`);
}
git(['worktree', 'remove', '--force', OUT]);
console.log(`Published v${version} to ${REMOTE}/${BRANCH} as ${pushed}${tagIt ? ` (tag v${version})` : ''}.`);
