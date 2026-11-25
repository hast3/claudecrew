'use strict';
// Tripwire for places agents may not save in. The guard hook (lib/guard.js) refuses most writes outside
// the allowed folders, but not all (a script that writes its own path, a program left running). So Crew
// lists the root of C:\ and the top level of the user folder, Documents, Desktop and Downloads when an agent
// run starts and ends. A new entry is reported to Assistant (woken) and to every agent whose run could have
// made it, with the name and the time. Overlapping runs are all listed as candidates; nothing is guessed.
// Programs and the owner also write there, so it only reports. It never deletes or moves anything.

const fs = require('fs');
const path = require('path');
const os = require('os');

const IGNORE_ROOT = /^(\$.*|System Volume Information|Recovery|Windows|Windows\.old|ProgramData|Program Files( \(x86\))?|Users|Documents and Settings|PerfLogs|Config\.Msi|MSOCache|pagefile\.sys|hiberfil\.sys|swapfile\.sys|DumpStack\.log(\.tmp)?|desktop\.ini|inetpub|OneDriveTemp|Intel|AMD|NVIDIA|found\.\d+)$/i;
// Entries Windows and programs keep at the top of the user folder, Documents, Desktop and Downloads.
const IGNORE_HOME = /^(desktop\.ini|~\$.*|\..*|NTUSER.*|ntuser.*|AppData|Application Data|Local Settings|NetHood|PrintHood|Recent|SendTo|Start Menu|Templates|Cookies|My Documents|My Music|My Pictures|My Videos|Searches|Contacts|Links|Favorites|Saved Games|3D Objects|Music|Pictures|Videos|OneDrive.*|Documents|Desktop|Downloads|IntelGraphicsProfiles.*|MicrosoftEdgeBackups|td_review|Thumbs\.db)$/i;

function defaultWatched() {
  const h = os.homedir();
  return [
    { dir: 'C:\\', ignore: IGNORE_ROOT },
    { dir: h, ignore: IGNORE_HOME },
    ...['Documents', 'Desktop', 'Downloads'].map((d) => ({ dir: path.join(h, d), ignore: IGNORE_HOME })),
  ];
}

function stamp(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// opts: watched [{dir, ignore}], list(dir) override, now, nameOf(id), wake(toId, text), assistant (id), log
function createRootWatch(opts = {}) {
  const watched = opts.watched || defaultWatched();
  const now = opts.now || Date.now;
  const list = opts.list || ((dir) => { try { return fs.readdirSync(dir); } catch { return []; } });
  const log = opts.log || (() => {});
  const assistant = opts.assistant || 'assistant';
  const nameOf = opts.nameOf || ((id) => id);
  const known = new Map(watched.map((w) => [w.dir, new Set(list(w.dir))]));
  const active = new Map(); // agent id -> start time
  let ended = [];           // { id, start, end } since the previous listing
  let lastScan = now();
  const found = [];         // everything reported, newest last

  function scan() {
    const t = now();
    const fresh = [];
    for (const w of watched) {
      const seen = known.get(w.dir);
      for (const n of list(w.dir)) {
        if (seen.has(n)) continue;
        seen.add(n);
        if (!w.ignore.test(n)) fresh.push(path.join(w.dir, n));
      }
    }
    const cands = new Map();
    for (const [id, start] of active) cands.set(id, { id, start, end: null });
    for (const e of ended) cands.set(e.id, e);
    ended = [];
    const since = lastScan;
    lastScan = t;
    if (!fresh.length) return [];
    const who = [...cands.values()];
    if (!who.length) { log(`New entry outside the allowed folders with no agent run active: ${fresh.join(', ')}`); return []; }
    const names = fresh.map((n) => `"${n}"`).join(', ');
    const runs = who.map((c) => `@${c.id} (${nameOf(c.id)}, run from ${stamp(c.start)}${c.end ? ` to ${stamp(c.end)}` : ', still running'})`).join('; ');
    const sure = who.length === 1;
    found.push({ at: t, since, names: fresh, candidates: who.map((c) => c.id) });
    const rule = 'Do NOT delete or move it; the owner removes it (programs and the owner also write there, so it may not be an agent). Agents save only in C:\\Claude Code, the .claude folder and the Diablo Modding folder on the NAS: always use a full path inside the project\'s scratch\\ folder (a Blender -o or script output path must be absolute too).';
    const toAssistant = `Crew's tripwire: new entry outside the allowed folders, found ${stamp(t)}: ${names}. ${sure ? 'The run it appeared in' : 'Runs that overlapped it (cause not known)'}: ${runs}. Tell ${sure ? 'that agent' : 'the likely agent'} if it has not been told, find the command that made it in that agent's last work, and fix the cause. ${rule} Then stop.`;
    const toAgent = (c) => `Crew's tripwire: ${names} appeared outside the allowed folders at ${stamp(t)}, during your run (${stamp(c.start)} to ${c.end ? stamp(c.end) : 'now'}).${sure ? '' : ` Other runs overlapped, so it may not be yours: ${who.filter((x) => x.id !== c.id).map((x) => '@' + x.id).join(', ')}.`} Look at what you ran (Blender, python, node, mkdir, or a tool with a relative output path) and say in your reply whether it was you and what made it. ${rule} Then stop.`;
    for (const c of who) if (c.id !== assistant) { try { opts.wake && opts.wake(c.id, toAgent(c)); } catch {} }
    try { opts.wake && opts.wake(assistant, toAssistant); } catch {}
    return fresh;
  }

  return {
    begin(id) { scan(); active.set(id, now()); },
    end(id) {
      const start = active.get(id);
      active.delete(id);
      if (start != null) ended.push({ id, start, end: now() });
      scan();
    },
    scan,
    found,
    known,
  };
}

module.exports = { createRootWatch, defaultWatched, IGNORE_ROOT, IGNORE_HOME };
