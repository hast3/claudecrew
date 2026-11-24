// Heavy background programs on this PC, attributed to the agent that owns them.
// An agent owns a process if it descends from that agent's live claude process,
// or (for detached servers that outlive the turn) if its command line points into
// the agent's folder. Shared folders go to whichever of those agents ran last.
const { execFile } = require('child_process');

const MIN_BYTES = 200 * 1024 * 1024;
const localCfg = require('./local-config');
const ALWAYS = localCfg.rx(localCfg.load().keepAliveProcs) || /^(game|python\d*|pythonw)\.exe$/i;
const SKIP = /^(claude|node|conhost|powershell|pwsh|cmd|bash|git|msedgewebview2|chrome|msedge|explorer)\.exe$/i;

const PS = `Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p=$_.ProcessId; pp=$_.ParentProcessId; n=$_.Name; m=$_.WorkingSetSize; c=$_.CommandLine } } | ConvertTo-Json -Compress`;

function scan() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    execFile('powershell', ['-NoProfile', '-Command', PS], { windowsHide: true, timeout: 20000, maxBuffer: 32 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(null);
      try { const j = JSON.parse(out); resolve(Array.isArray(j) ? j : [j]); } catch { resolve(null); }
    });
  });
}

const norm = (s) => String(s || '').toLowerCase().replace(/\//g, '\\');

function friendly(p) {
  const c = String(p.c || '');
  const script = c.match(/["']?([^"'\s]+\.(?:py|ps1|js|bat|cmd))["']?/i) || c.match(/"[^"]*\\([^"\\]+\.(?:py|ps1|js))"/i);
  const name = p.n.replace(/\.exe$/i, '');
  if (script) return `${name}: ${script[1].split(/[\\/]/).pop()}`;
  return name;
}

// agents: [{id, cwd, pid, lastActive}]
function attribute(list, agents) {
  const byPid = new Map(list.map((p) => [p.p, p]));
  const owner = new Map();
  const live = agents.filter((a) => a.pid);
  for (const p of list) {
    // Walk up the parent chain looking for a live agent process.
    let q = p, hops = 0;
    while (q && hops++ < 30) {
      const hit = live.find((a) => a.pid === q.p);
      if (hit) { owner.set(p.p, hit.id); break; }
      q = byPid.get(q.pp);
    }
  }
  const out = {};
  for (const p of list) {
    if (SKIP.test(p.n)) continue;
    if (!(p.m >= MIN_BYTES || (ALWAYS.test(p.n) && p.m >= 50 * 1048576))) continue;
    let id = owner.get(p.p);
    if (!id) {
      const c = norm(p.c);
      if (!c) continue;
      let best = [], len = 0;
      for (const a of agents) {
        const d = norm(a.cwd).replace(/\\+$/, '');
        if (!d || !c.includes(d)) continue;
        if (d.length > len) { best = [a]; len = d.length; } else if (d.length === len) best.push(a);
      }
      if (!best.length) continue;
      id = best.sort((x, y) => (y.lastActive || 0) - (x.lastActive || 0))[0].id;
    }
    (out[id] ||= []).push({ pid: p.p, name: friendly(p), mb: Math.round((p.m || 0) / 1048576) });
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => b.mb - a.mb);
  return out;
}

function createProcWatch({ getAgents, onChange, everyMs = 20000 }) {
  let last = '{}', current = {}, timer = null, busy = false;
  async function tick() {
    if (busy) return; busy = true;
    try {
      const list = await scan();
      if (list) {
        current = attribute(list, getAgents());
        const s = JSON.stringify(current);
        if (s !== last) { last = s; onChange(current); }
      }
    } finally { busy = false; }
  }
  timer = setInterval(tick, everyMs); timer.unref?.();
  tick();
  return { get: () => current, poke: () => setTimeout(tick, 1500) };
}

module.exports = { createProcWatch };
