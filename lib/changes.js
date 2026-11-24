'use strict';
// "What changed" + undo for agent turns, using git.
//
// Before a turn: snapshot the folder with `git stash create` (records the working tree,
// including uncommitted edits, without touching anything) and note untracked files.
// After the turn: list files that differ from that snapshot, with a hash of each so an
// undo can refuse to clobber a file that changed again afterwards.
// Undo restores each file from the snapshot (or deletes it if the turn created it).
// Folders that aren't git repositories get no snapshot; the UI then lists edited files only.

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GIT_TIMEOUT = 30e3;
const MAX_DIFF = 200e3;

function git(cwd, args, { input, maxBuffer = 20e6 } = {}) {
  return new Promise((resolve, reject) => {
    const p = execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, timeout: GIT_TIMEOUT, maxBuffer, windowsHide: true, encoding: 'buffer' },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(stdout)));
    if (input) p.stdin.end(input);
  });
}
const text = (buf) => buf.toString('utf8');
const zsplit = (buf) => text(buf).split('\0').filter(Boolean);

function hashFile(file) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } // null = gone
}

async function snapshot(cwd) {
  let top;
  try {
    top = text(await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return null; // not a git folder
  }
  if (!top) return null;
  // Git briefly locks its index after other git commands; try twice before giving up.
  // Giving up is the safe failure: the turn gets a file list but no undo, rather than an
  // undo that could also revert your own uncommitted work.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      let ref = text(await git(top, ['stash', 'create'])).trim();
      if (!ref) ref = text(await git(top, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => Buffer.from(''))).trim();
      if (!ref) return null; // empty repo with no commits
      const untracked = zsplit(await git(top, ['ls-files', '-z', '--others', '--exclude-standard']));
      return { top, ref, untracked };
    } catch (e) {
      if (attempt === 2) { console.error(`Couldn't snapshot ${top} for undo: ${e.message.split('\n')[0]}`); return null; }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return null;
}

async function collect(snap) {
  if (!snap) return null;
  try {
    const files = [];
    const parts = zsplit(await git(snap.top, ['diff', '--name-status', '-z', '--no-renames', snap.ref]));
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const code = parts[i][0];
      files.push({ path: parts[i + 1], status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified' });
    }
    const before = new Set(snap.untracked);
    for (const f of zsplit(await git(snap.top, ['ls-files', '-z', '--others', '--exclude-standard']))) {
      if (!before.has(f)) files.push({ path: f, status: 'added', untracked: true });
    }
    if (!files.length) return { repo: snap.top, ref: snap.ref, files: [] };
    for (const f of files) f.hash = hashFile(path.join(snap.top, f.path));
    return { repo: snap.top, ref: snap.ref, files: files.slice(0, 200), more: Math.max(0, files.length - 200) };
  } catch {
    return null;
  }
}

function safeJoin(repo, rel) {
  const full = path.resolve(repo, rel);
  if (!full.startsWith(path.resolve(repo) + path.sep)) throw new Error('path outside repository');
  return full;
}

async function diff(changes, rel) {
  const f = changes.files.find((x) => x.path === rel);
  if (!f) throw new Error('file not part of this change');
  if (f.untracked) {
    const full = safeJoin(changes.repo, rel);
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) return `New binary file: ${rel}`;
    const body = text(buf.subarray(0, MAX_DIFF));
    return `--- /dev/null\n+++ b/${rel}\n` + body.split('\n').map((l) => '+' + l).join('\n') + (buf.length > MAX_DIFF ? '\n… (truncated)' : '');
  }
  const out = text(await git(changes.repo, ['diff', '--no-color', '--no-renames', changes.ref, '--', rel]));
  return out.length > MAX_DIFF ? out.slice(0, MAX_DIFF) + '\n… (truncated)' : out || '(no differences any more)';
}

async function undo(changes) {
  const done = [];
  const skipped = [];
  for (const f of changes.files) {
    const full = safeJoin(changes.repo, f.path);
    if (hashFile(full) !== f.hash) { skipped.push({ path: f.path, why: 'changed again since this turn' }); continue; }
    try {
      if (f.status === 'added') {
        fs.rmSync(full, { force: true });
      } else {
        await git(changes.repo, ['restore', `--source=${changes.ref}`, '--worktree', '--', f.path]);
      }
      done.push(f.path);
    } catch (e) {
      skipped.push({ path: f.path, why: e.message });
    }
  }
  return { done, skipped };
}

module.exports = { snapshot, collect, diff, undo };
