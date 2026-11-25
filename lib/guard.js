'use strict';
// Crew guard: a PreToolUse hook passed to every agent run.
// Agents run with permissions bypassed, so this is the only thing that stops a tool call.
// It refuses a short list of risky actions, each with a plain one-line reason:
//   - recursive deletes on a drive root, the home folder, or outside the project folders
//   - git push --force and git reset --hard on main or master
//   - format, diskpart and other disk wipes
//   - deleting or overwriting game saves, or anything in the user folder outside the project folders
//   - govc / ESXi power, shutdown and destroy commands
//   - registry deletes
// A refusal is written to CREW_GUARD_LOG so Crew shows it on the "Permission needed" card.
// Approving that card re-runs the agent with the rule in CREW_GUARD_ALLOW, which lets it through.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SAVE_RE = /\.(d2s|d2x|sss|ctc|key|ma[0-3])$/i;

// ---------- paths ----------
function norm(p) {
  let s = String(p || '').trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
  s = s.replace(/^\/\/([a-z])\//i, (_, d) => `${d}:/`).replace(/^\/([a-z])(\/|$)/i, (_, d) => `${d}:/`);
  if (/^[a-z]:$/i.test(s)) s += '/';
  return s.toLowerCase().replace(/\/+$/, '') || '/';
}
function under(p, root) {
  const a = norm(p), b = norm(root);
  return a === b || a.startsWith(b.endsWith('/') ? b : b + '/');
}
function isRoot(p) {
  const s = norm(p);
  return s === '/' || /^[a-z]:\/?$/.test(s) || /^[a-z]:\/\*$/.test(s) || s === '/*';
}

function context(cwd) {
  const home = os.homedir();
  const projects = [ROOT, path.dirname(ROOT)]; // the Crew folder and everything beside it (C:\Claude Code\...)
  try {
    const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'crew.config.json'), 'utf8'));
    for (const a of conf.agents || []) if (a.cwd) projects.push(a.cwd);
  } catch {}
  if (cwd) projects.push(cwd);
  const scratch = [os.tmpdir(), '/tmp', path.join(home, 'AppData', 'Local', 'Temp')];
  // Under the home folder, agents may still write memory notes and drop review pictures.
  const homeOk = [path.join(home, '.claude'), path.join(home, 'td_review'), ...scratch];
  let allow = [];
  try { allow = JSON.parse(process.env.CREW_GUARD_ALLOW || '[]'); } catch {}
  // Where agents may write (crew.config.json "local"): empty list = no folder rule.
  let writeFolders = [], extraWrite = [];
  try {
    const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'crew.config.json'), 'utf8'));
    const loc = conf.local || {};
    const ctx0 = { home };
    writeFolders = expandWriteFolders(loc.writeFolders, ctx0);
    // Extra folders the owner approved for one agent: the agent named in CREW_AGENT, else every agent whose folder holds the cwd.
    const here = cwd || process.cwd();
    const mine = (conf.agents || []).filter((a) => process.env.CREW_AGENT ? a.id === process.env.CREW_AGENT : a.cwd && under(here, path.resolve(ROOT, a.cwd)));
    for (const a of mine) extraWrite.push(...expandWriteFolders((loc.extraWriteFolders || {})[a.id], ctx0));
  } catch {}
  return { home, cwd: cwd || process.cwd(), projects, scratch, homeOk, allow, writeFolders, extraWrite };
}

// Turn a command-line path word into an absolute path, or null if it can't be known (a variable).
function resolveWord(w, ctx) {
  let s = String(w).replace(/^["']|["']$/g, '');
  if (!s) return null;
  s = s.replace(/^(~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|%USERPROFILE%|\$env:HOME)(?=$|[\\/])/i, ctx.home.replace(/\\/g, '/'));
  if (/[$%]/.test(s)) return null;
  if (/^[a-z]:/i.test(s) || /^[\\/]/.test(s)) return s;
  return path.resolve(ctx.cwd, s);
}
const inProject = (p, ctx) => [...ctx.projects, ...ctx.scratch].some((r) => under(p, r));
const inHomeOutside = (p, ctx) => under(p, ctx.home) && !inProject(p, ctx) && !ctx.homeOk.some((r) => under(p, r)) && !(ctx.extraWrite || []).some((r) => under(p, r));
const isSave = (p) => SAVE_RE.test(String(p).replace(/["']/g, ''));

// ---------- command parsing ----------
// Split on ; && || | and newlines, outside quotes.
function segments(cmd) {
  const out = [];
  let cur = '', q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ';' || c === '\n' || c === '|' || (c === '&' && cmd[i + 1] === '&')) {
      if (cmd[i + 1] === c) i++;
      out.push(cur); cur = ''; continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}
function words(seg) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(seg))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const PS_RECURSE = /^-(r|re|rec|recu|recur|recurs|recurse)$/i;
function checkSegment(seg, ctx, depth) {
  const w = words(seg);
  if (!w.length) return null;
  // Skip leading env assignments, sudo, and "cd x &&" leftovers.
  while (w.length && (/^\w+=/.test(w[0]) || /^(sudo|command|exec|&)$/i.test(w[0]))) w.shift();
  const verb = (w[0] || '').toLowerCase().replace(/\.exe$/, '');
  if (/^(ssh|plink|scp|rsync|docker|wsl)$/.test(verb)) return null; // another machine or sandbox, not this PC's files
  // Look inside powershell -Command "..." / cmd /c "..." / bash -c "..."
  if (depth < 3 && /^(powershell|pwsh|cmd|bash|sh)$/.test(verb)) {
    const i = w.findIndex((x, k) => k > 0 && /^(-command|-c|\/c|\/k)$/i.test(x));
    if (i > 0) return checkCommand(w.slice(i + 1).join(' '), ctx, depth + 1);
  }
  const args = w.slice(1);

  // Redirect into a file: > file or >> file
  const redir = /(?:^|[^0-9&])>{1,2}\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g;
  let m;
  while ((m = redir.exec(seg))) {
    const t = m[1];
    if (/^&?\d$/.test(t) || /^\/dev\/null$/i.test(t) || /^\$null$/i.test(t) || /^nul$/i.test(t)) continue;
    const p = resolveWord(t, ctx);
    if (p && isSave(p)) return `It would overwrite a game save file (${path.basename(p)}).`;
    if (p && inHomeOutside(p, ctx)) return `It would overwrite a file in your user folder outside the project folders (${p}).`;
  }

  const isRm = /^(rm|del|erase|rmdir|rd|remove-item|ri|unlink)$/.test(verb);
  const isMove = /^(mv|move|move-item|mi)$/.test(verb);
  const isCopy = /^(cp|copy|copy-item|cpi|xcopy|robocopy)$/.test(verb);
  const isWriteCmd = /^(set-content|sc|out-file|clear-content|clc|add-content|ac|truncate)$/.test(verb);
  if (!isRm && !isMove && !isCopy && !isWriteCmd) return null;

  // cmd.exe style commands take /s /q switches; elsewhere "/c" is a path (Git Bash drive).
  const cmdStyle = /^(del|erase|rmdir|rd|copy|move|xcopy|robocopy)$/.test(verb);
  const isFlag = (x) => x.startsWith('-') || cmdStyle && /^\/[a-z]+$/i.test(x);
  const plain = args.filter((x) => !isFlag(x));
  const flags = args.filter(isFlag);

  if (isRm) {
    const recursive = flags.some((f) => /^-[a-z]{1,3}$/i.test(f) && /r/i.test(f) || f === '--recursive' || PS_RECURSE.test(f) || /^\/s$/i.test(f));
    for (const t of plain) {
      const p = resolveWord(t, ctx);
      if (!p) continue;
      if (isSave(p)) return `It would delete a game save file (${path.basename(p)}).`;
      const base = p.replace(/[\\/]\*.*$/, '') || p;
      if (recursive && (isRoot(p) || isRoot(base))) return `It would delete a whole drive (${t}).`;
      if (recursive && norm(base) === norm(ctx.home)) return 'It would delete your whole user folder.';
      if (inHomeOutside(base, ctx)) return `It would delete from your user folder outside the project folders (${p}).`;
      if (recursive && !inProject(base, ctx)) return `It would delete a folder outside the project folders (${p}).`;
    }
    return null;
  }
  // Move: the source is removed and the target overwritten. Copy and write: only the target.
  const list = isMove ? plain : plain.slice(isCopy ? -1 : 0, isCopy ? undefined : 1);
  for (const t of list) {
    const p = resolveWord(t, ctx);
    if (!p) continue;
    if (isSave(p)) return `It would ${isMove ? 'move or overwrite' : 'overwrite'} a game save file (${path.basename(p)}).`;
    if (inHomeOutside(p, ctx)) return `It would change a file in your user folder outside the project folders (${p}).`;
  }
  return null;
}

// ---------- agents write only inside the allowed folders ----------
// the owner's rule (2026-11-24): agents save only in C:\Claude Code, the .claude folder and the Diablo Modding
// folder on the NAS (plus a per-agent extra folder he approves). The list lives in crew.config.json under
// local.writeFolders (and local.extraWriteFolders { agentId: [folders] }); with no list, only the
// relative-Blender-output rule applies. Reads are never touched. A program's own temp and cache files are
// not seen here; an agent choosing temp (or /tmp) as its OUTPUT place is refused. This cannot be approved.
const HARD_TAG = 'scratch\\ folder';
const isHard = (why) => !!why && why.includes(HARD_TAG);
const useScratch = `Use a full path inside the project's ${HARD_TAG}, for example C:\\Claude Code\\<project>\\scratch\\<dated name>\\.`;

const NAMED = /^(mkdir|md|touch|ni|new-item|set-content|sc|out-file|add-content|ac|tee|tee-object|clear-content|clc|cp|copy|copy-item|cpi|mv|move|move-item|mi|xcopy|robocopy|rename-item|ren)$/;
const FIRST_ONLY = /^(set-content|sc|out-file|add-content|ac|clear-content|clc|rename-item|ren)$/;
const VALUE_FLAG = /^-(value|encoding|itemtype|type|name|stream|width|inputobject|filter|include|exclude|newname)$/i;
const PATH_FLAG = /^-(path|filepath|literalpath)$/i;
const OUT_FLAG = /^-{1,2}(o|out|output|outfile|out-file|outdir|out-dir|output-dir|outputdir|output_dir|outputpath|output-path|destination|destinationpath|dest|render-output)$/i;
const WRITE_CODE = /\b(open\s*\([^)]*['"][wax]\+?b?['"]|write|writeFile|appendFile|mkdir|makedirs|mkdirSync|save|copyfile|copy2|copytree|shutil|rename|dump|to_csv|to_json|tofile|savefig|imwrite|Out-File|Set-Content)\b/i;
const NULLDEV = /^(\/dev\/(null|stdout|stderr|tty)|\$null|nul|con|&?\d)$/i;

function expandWriteFolders(list, ctx) {
  return (list || []).map((f) => String(f).replace(/^~(?=$|[\\/])/, ctx.home.replace(/\\/g, '/')).replace(/\\/g, '/'));
}
function writeRoots(ctx) {
  return ctx.writeFolders && ctx.writeFolders.length ? [...ctx.writeFolders, ...(ctx.extraWrite || [])] : null;
}
// Follow junctions and symlinks: resolve the deepest existing parent, then add the rest back.
function realish(p) {
  let cur = p; const rest = [];
  for (let i = 0; i < 40; i++) {
    try { return path.join(fs.realpathSync.native(cur), ...rest.reverse()); } catch {}
    const up = path.dirname(cur);
    if (up === cur) break;
    rest.push(path.basename(cur)); cur = up;
  }
  return p;
}
// Turn a word into an absolute Windows path, or null when it can't be known (variable) or is a null device.
function toAbs(word, ctx, cwd) {
  let s = String(word || '').replace(/^["']|["']$/g, '');
  if (!s || NULLDEV.test(s) || /[*?<>|]/.test(s)) return null;
  s = s.replace(/^(~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|%USERPROFILE%|\$env:HOME)(?=$|[\\/])/i, ctx.home.replace(/\\/g, '/'));
  if (/[$%`]/.test(s)) return null;
  s = s.replace(/^\/([a-z])(?=\/|$)/i, (_, d) => `${d.toUpperCase()}:`);
  if (/^\/tmp(\/|$)/i.test(s)) return path.join('C:\\', s); // what Windows python/node make of it
  if (/^[\\/](?![\\/])/.test(s)) return path.resolve((/^[a-z]:/i.test(cwd) ? cwd.slice(0, 2) : 'C:') + s);
  return path.resolve(cwd, s);
}
// Returns a refusal reason when abs is outside the allowed folders, else null.
function outsideWhy(abs, ctx) {
  const roots = writeRoots(ctx);
  if (!roots || !abs) return null;
  const inside = (p) => roots.some((r) => under(p, r));
  if (inside(abs) && inside(realish(abs))) return null;
  const list = ctx.writeFolders.map((f) => f.replace(/\//g, '\\')).concat((ctx.extraWrite || []).map((f) => f.replace(/\//g, '\\'))).join(', ');
  return `It would write to ${abs.replace(/\//g, '\\')}, outside the folders agents may save in (${list}). ${useScratch}`;
}

function blenderWhy(tokens, ctx, cwd) {
  const absolute = (v) => /^[a-z]:[\\/]/i.test(v) || /^\/[a-z]\//i.test(v) || /^\\\\/.test(v) || /[$%~]/.test(v);
  const OUT = /^-{1,2}(o|out|output|outdir|out-dir|output-dir|output_dir|dir|folder|path|dest|destination|save|render|render-output|export|prefix)[\w-]*$/i;
  const bad = (v) => `It runs Blender with a relative output ("${v}"), which lands at the root of C:\\ or in a random folder, wherever Blender was started. ${useScratch}`;
  const check = (v) => (!absolute(v) ? bad(v) : outsideWhy(toAbs(v, ctx, cwd), ctx));
  const dd = tokens.indexOf('--');
  const before = dd < 0 ? tokens : tokens.slice(0, dd);
  for (let i = 0; i < before.length; i++) {
    const t = before[i];
    const v = /^(-o|--render-output)$/.test(t) ? before[i + 1] : /^(-o|--render-output)=/.test(t) ? t.slice(t.indexOf('=') + 1) : null;
    const why = v && check(v);
    if (why) return why;
  }
  if (dd >= 0) {
    const after = tokens.slice(dd + 1);
    for (let i = 0; i < after.length; i++) {
      const t = after[i], prev = i ? after[i - 1] : '';
      let why = null;
      if (/^-/.test(t)) {
        const eq = t.indexOf('=');
        if (eq > 0 && OUT.test(t.slice(0, eq))) why = check(t.slice(eq + 1));
      } else if (/^-/.test(prev)) {
        if (OUT.test(prev)) why = check(t);
      } else if (!/^[\d.,+-]+$|^(true|false|yes|no|on|off)$/i.test(t)) {
        why = check(t); // a bare word after "--" is treated as an output name
      }
      if (why) return why;
    }
  }
  return null;
}

// Every place this command line would write to (absolute, resolved against the folder it runs in).
function writeTargets(verb, w, seg, ctx, cwd) {
  const out = [];
  const add = (x) => { if (x != null) out.push(x); };
  const args = w.slice(1);
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (/^-/.test(x)) {
      const eq = x.indexOf('=');
      if (eq > 0 && OUT_FLAG.test(x.slice(0, eq))) add(x.slice(eq + 1));
      else if (OUT_FLAG.test(x) && !(x === '-o' && /^(grep|rg|ssh|git|tar)$/.test(verb))) { if (args[i + 1] != null) add(args[++i]); }
      else if (PATH_FLAG.test(x) && NAMED.test(verb)) { if (args[i + 1] != null) add(args[++i]); }
      else if (VALUE_FLAG.test(x)) i++;
      else if (/^-o.+/.test(x) && /^(7z|7za)$/.test(verb)) add(x.slice(2));
      continue;
    }
    pos.push(x);
  }
  if (NAMED.test(verb)) {
    const copy = /^(cp|copy|copy-item|cpi|mv|move|move-item|mi|xcopy|robocopy)$/.test(verb);
    if (copy) { if (!out.length && pos.length) add(/^robocopy$|^xcopy$/.test(verb) ? pos[1] ?? pos[0] : pos[pos.length - 1]); }
    else if (FIRST_ONLY.test(verb)) { if (!out.length && pos.length) add(pos[0]); }
    else for (const p of pos) add(p);
  }
  if (/^(scp|rsync)$/.test(verb) && pos.length > 1) {
    const last = pos[pos.length - 1];
    if (!/^[\w.@-]{2,}:(?![\\/])/.test(last)) add(last);
  }
  if (verb === 'git') {
    const gi = pos.findIndex((x) => /^(clone|init|worktree)$/.test(x));
    if (gi >= 0 && pos[gi] === 'clone' && pos.length > gi + 2) add(pos[pos.length - 1]);
    else if (gi >= 0 && pos[gi] === 'init' && pos[gi + 1]) add(pos[gi + 1]);
    else if (gi >= 0 && pos[gi] === 'worktree' && pos[gi + 1] === 'add' && pos[gi + 2]) add(pos[gi + 2]);
  }
  if (/^(unzip|tar|7z|7za|expand-archive)$/.test(verb)) {
    const f = args.findIndex((x) => /^(-d|-C|--directory)$/.test(x));
    if (f >= 0 && args[f + 1]) add(args[f + 1]);
  }
  if (verb === 'wget') { const f = args.findIndex((x) => /^-(O|P)$/.test(x)); if (f >= 0 && args[f + 1]) add(args[f + 1]); }
  return out;
}

function writeCheck(cmd, ctx) {
  let cwd = ctx.cwd;
  for (const seg of segments(stripHeredocs(cmd))) {
    const w = words(seg);
    while (w.length && (/^\w+=/.test(w[0]) || /^(sudo|command|exec|&|start|call)$/i.test(w[0]) || /^\/(wait|b|min|max)$/i.test(w[0]))) w.shift();
    if (!w.length) continue;
    const verb = w[0].toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, '');
    // Blender, wherever it sits on the line.
    const bi = w.findIndex((x) => /^blender(-launcher)?(\.exe)?$/i.test(x.replace(/^.*[\\/]/, '')));
    if (bi >= 0) {
      const why = blenderWhy(w.slice(bi + 1).flatMap((x) => (/^-/.test(x) && /\s/.test(x) ? x.split(/\s+/) : [x])), ctx, cwd);
      if (why) return why;
    }
    if (/^(cd|chdir|pushd|set-location|sl)$/.test(verb)) {
      const t = w.slice(1).find((x) => !/^\/d$/i.test(x) && !/^-/.test(x));
      const p = t && toAbs(t, ctx, cwd);
      if (p) cwd = p;
      continue;
    }
    // Redirects: > file (the verb does not matter).
    const redir = /(?:^|[^0-9&>=-])>{1,2}\s*("[^"]+"|'[^']+'|[^\s;&|)]+)/g; let m;
    const segQ = seg.replace(/(>\s*)?("[^"]*"|'[^']*')/g, (all, p) => (p ? all : '""'));
    while ((m = redir.exec(segQ))) {
      const why = outsideWhy(toAbs(m[1], ctx, cwd), ctx);
      if (why) return why;
    }
    const rest = /^(ssh|plink|docker|wsl|govc)$/.test(verb) ? [] : writeTargets(verb, w, seg, ctx, cwd);
    for (const t of rest) {
      const why = outsideWhy(toAbs(t, ctx, cwd), ctx);
      if (why) return why;
    }
    // Inline python / node code: a write call plus a path outside the list.
    if (/^(python|python3|py|pythonw|node|deno|bun|perl|ruby)$/.test(verb) && /\s(-c|-e|-p|--eval)\s/.test(seg)) {
      if (/(^|[\s"'=(,])\/tmp(\/|\\|\b)/i.test(seg) && WRITE_CODE.test(seg)) return outsideWhy(path.join('C:\\', 'tmp'), ctx) || null;
      if (WRITE_CODE.test(seg)) {
        const re = /(?:[a-z]:|\\\\[\w.-]+)[\\/]+[^\s"'<>|*?]*/gi; let p;
        while ((p = re.exec(seg))) {
          const why = outsideWhy(toAbs(p[0].replace(/\\\\/g, '\\'), ctx, cwd), ctx);
          if (why) return why;
        }
      }
    }
  }
  return null;
}
// Heredoc bodies are file contents, not commands: drop them before reading the command.
function stripHeredocs(cmd) {
  return String(cmd || '').replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?(\n\s*\2\s*(?=\n|$)|$)/g, '\n');
}

function currentBranch(cmd, ctx) {
  const m = /git\s+-C\s+("[^"]+"|'[^']+'|\S+)/.exec(cmd);
  const dir = m ? resolveWord(m[1], ctx) : ctx.cwd;
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

function checkCommand(cmd, ctx, depth = 0) {
  const c = String(cmd || '');
  // Whole-command rules (also apply inside ssh, since they hit the VMs or the disk).
  if (/\bdiskpart\b/i.test(c)) return 'diskpart can wipe disks.';
  if (/(^|[\s;&|"'(])format(\.com)?\s+[a-z]:/i.test(c) || /\b(Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\b/i.test(c)) return 'It would format or wipe a disk.';
  if (/\bgovc\s+(vm\.(power|destroy|unregister)|host\.(shutdown|reboot|maintenance\.enter)|datastore\.rm|pool\.destroy|folder\.destroy|object\.destroy)\b/i.test(c)) return 'It would power off, restart or destroy a VM or the ESXi host.';
  if (/\bvim-cmd\s+(vmsvc\/(power\.|destroy|unregister)|hostsvc\/(maintenance_mode_enter|shutdown|reboot))/i.test(c) || /\besxcli\s+system\s+(shutdown|maintenanceMode)/i.test(c) || /\b(Stop-VM|Remove-VM|Restart-VM|Stop-VMHost|Restart-VMHost)\b/i.test(c)) return 'It would power off, restart or destroy a VM or the ESXi host.';
  if (/\breg(\.exe)?\s+delete\b/i.test(c) || /\b(Remove-Item|ri|rm|del|Remove-ItemProperty|rp|Clear-ItemProperty|Clear-Item)\b[^;|&\n]*\b(HKLM|HKCU|HKCR|HKU|HKCC|HKEY_[A-Z_]+|Registry)::?/i.test(c)) return 'It would delete from the Windows registry.';
  if (/\bgit\b[^;&|\n]*\bpush\b/i.test(c)) {
    for (const seg of segments(c)) {
      if (!/\bgit\b[^;&|\n]*\bpush\b/i.test(seg)) continue;
      const force = /(\s--force(-with-lease)?\b|\s-[a-zA-Z]*f\b|\s\+\S+)/.test(seg);
      if (!force) continue;
      const after = seg.replace(/^.*?\bpush\b/i, '');
      const refs = words(after).filter((x) => !x.startsWith('-'));
      const branches = refs.slice(1).map((r) => r.replace(/^\+/, '').split(':').pop());
      if (!branches.length) {
        const b = currentBranch(seg, ctx);
        if (!b || /^(main|master)$/.test(b)) return `Force-pushing ${b || 'the current branch'} rewrites shared history.`;
      } else if (branches.some((b) => /^(refs\/heads\/)?(main|master)$/.test(b))) return 'Force-pushing main or master rewrites shared history.';
    }
  }
  if (/\bgit\b[^;&|\n]*\breset\b[^;&|\n]*--hard\b/i.test(c)) {
    const b = currentBranch(c, ctx);
    if (!b || /^(main|master)$/.test(b)) return `git reset --hard on ${b || 'this branch'} throws away uncommitted work.`;
  }
  const rw = writeCheck(c, ctx);
  if (rw) return rw;
  for (const seg of segments(c)) {
    const why = checkSegment(seg, ctx, depth);
    if (why) return why;
  }
  return null;
}

function checkFile(p, ctx) {
  const full = path.resolve(ctx.cwd, String(p || ''));
  const nr = outsideWhy(toAbs(String(p || ''), ctx, ctx.cwd), ctx);
  if (nr) return nr;
  if (isSave(full) && fs.existsSync(full)) return `It would overwrite a game save file (${path.basename(full)}).`;
  if (inHomeOutside(full, ctx)) return `It would change a file in your user folder outside the project folders (${full}).`;
  return null;
}

// ---------- approvals ----------
function ruleFor(name, input, cwd) {
  if (name === 'Bash' || name === 'PowerShell') return `${name}(${input.command})`;
  const p = input.file_path || input.notebook_path;
  if (!p) return name;
  const full = path.resolve(cwd, String(p)).replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_, d) => `//${d.toLowerCase()}/`);
  return `Edit(${full})`;
}
function approved(name, input, ctx) {
  const rule = ruleFor(name, input, ctx.cwd);
  return ctx.allow.some((a) => {
    if (a === rule) return true;
    const m = /^(Bash|PowerShell)\((.*):\*\)$/s.exec(a);
    return !!m && rule.startsWith(`${m[1]}(${m[2]}`);
  });
}

// Returns a plain one-line reason to refuse, or null to let it run.
function check(name, input = {}, cwd, ctxOverride) {
  const ctx = { ...(ctxOverride || context(cwd)), tool: name };
  let why = null;
  if (name === 'Bash' || name === 'PowerShell') why = checkCommand(input.command, ctx);
  else if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) why = checkFile(input.file_path || input.notebook_path, ctx);
  if (!why || (!isHard(why) && approved(name, input, ctx))) return null; // the C:\ root rules cannot be approved
  return why;
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let ev = {};
    try { ev = JSON.parse(raw); } catch { process.exit(0); }
    let why = null;
    try { why = check(ev.tool_name, ev.tool_input || {}, ev.cwd); } catch { why = null; }
    if (!why) process.exit(0);
    const hard = isHard(why);
    const reason = hard ? `Crew guard: ${why}` : `Crew guard: ${why} Ask the owner to approve it on the "Permission needed" card.`;
    if (process.env.CREW_GUARD_LOG && !hard) {
      try { fs.appendFileSync(process.env.CREW_GUARD_LOG, JSON.stringify({ tool_name: ev.tool_name, tool_input: ev.tool_input, reason: why }) + '\n'); } catch {}
    }
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
    process.exit(0);
  });
}

module.exports = { check, context, checkCommand, isHard };
