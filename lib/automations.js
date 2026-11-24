// Crew automations: when <trigger>, if <conditions>, do <steps>.
// Design: docs/AUTOMATIONS.md. Rules live in data/automations.json (seeded from the
// starter pack on first run). Every firing is logged to data/automation-runs.jsonl.
//
// Events the server feeds in:
//   status.line   one per appended STATUS.md line (and one per "waiting on @x" target)
//   agent.reply   an agent's visible reply {agent, text, targets}
//   turn.end      {agent, ok}
//   control       {on}
//   file.status   STATUS.md changed {lines}
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MIN = 60e3;
function dur(s) {
  if (typeof s === 'number') return s;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)$/.exec(String(s || '').trim());
  if (!m) return 0;
  return Number(m[1]) * (m[2] === 's' ? 1e3 : m[2] === 'm' ? MIN : 60 * MIN);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fill(tpl, vars) {
  return String(tpl ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    let v = vars;
    for (const p of k.split('.')) v = v == null ? undefined : v[p];
    return v == null ? '' : Array.isArray(v) ? v.join(', ') : String(v);
  });
}
function fillDeep(o, vars) {
  if (typeof o === 'string') return fill(o, vars);
  if (Array.isArray(o)) return o.map((x) => fillDeep(x, vars));
  if (o && typeof o === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(o)) out[k] = (k === 'cond' || k === 'conditions') ? v : fillDeep(v, vars);
    return out;
  }
  return o;
}

// ---- STATUS.md parsing
function parseStatusLine(line, isAgent) {
  const text = line.replace(/^\s*-\s*/, '').trim();
  const at = [...text.matchAll(/@([a-z][a-z0-9-]*)/gi)].map((m) => m[1].toLowerCase());
  const head = text.slice(0, 60);
  const author = ([...head.matchAll(/@([a-z][a-z0-9-]*)/gi)].map((m) => m[1].toLowerCase()).find(isAgent))
    || (/^\S+\s+\S*\s*(?:\|\s*)?([A-Z][A-Za-z0-9]+):/.exec(text)?.[1] || '').toLowerCase() || null;
  const waitingOn = [];
  for (const m of text.matchAll(/waiting[\s-]*(?:on|for)\b[:\s]*([^|;\n]{0,80})/gi)) {
    for (const t of m[1].matchAll(/@([a-z][a-z0-9-]*)/gi)) {
      const id = t[1].toLowerCase();
      if (isAgent(id) && id !== author && !waitingOn.includes(id)) waitingOn.push(id);
    }
  }
  const done = /(^|\|)\s*done\b/i.test(text) || /\|\s*done\s*(\||$)/i.test(text);
  return { text, author: author && isAgent(author) ? author : null, waitingOn, done, mentions: at };
}

// Absolute Windows paths ending in a file extension (spaces allowed inside).
function extractPaths(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/(?<![A-Za-z])[A-Za-z]:[\\/](?:(?![A-Za-z]:[\\/])[^|\n"'`<>*?;,()])*?\.[A-Za-z][A-Za-z0-9]{0,5}(?=$|[\s|;,)'"`])/g)) out.add(m[0].trim());
  return [...out];
}

// ---- processes (one CIM query every 15 s while something needs it)
const PS_QUERY = "Get-CimInstance Win32_Process | ForEach-Object { $c = $null; if ($_.Name -like 'python*') { $c = $_.CommandLine }; [pscustomobject]@{i=[int]$_.ProcessId;p=[int]$_.ParentProcessId;n=$_.Name;c=$c;t=[int64]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()} } | ConvertTo-Json -Compress";
function listProcesses() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    execFile('powershell', ['-NoProfile', '-Command', PS_QUERY], { windowsHide: true, timeout: 20000, maxBuffer: 16 << 20 }, (err, out) => {
      if (err) return resolve(null);
      try { const j = JSON.parse(out); resolve(Array.isArray(j) ? j : [j]); } catch { resolve(null); }
    });
  });
}
// Python scripts the sweep never kills: "gateway" plus whatever this install lists under local.keepPython.
const KEEP_PY = require('./local-config').rx(['gateway', require('./local-config').load().keepPython].filter(Boolean).join('|'));

function createAutomations(o) {
  const { dataDir, statusFile, api } = o;
  const FILE = path.join(dataDir, 'automations.json');
  const HIST = path.join(dataDir, 'automations-history');
  const RUNS = path.join(dataDir, 'automation-runs.jsonl');
  const PENDING = path.join(dataDir, 'automation-pending.json');
  const STATE = path.join(dataDir, 'automations-state.json');
  const log = o.log || ((m) => console.log(m));

  let rules = [];
  let st = { paused: false };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) }; } catch {}
  const fired = {};          // auto id -> [ts]
  const targetFired = {};    // `${auto}:${target}` -> ts
  const handoffs = [];       // {from, to, ts}
  const statusLog = [];      // {ts, author, text}
  const active = new Map();  // run id -> run
  let procs = [];            // last process list
  const owned = {};          // agent -> Map(pid -> {name, cmd})
  const turnPid = {};        // agent -> claude pid
  const turnAt = {};         // agent -> when its turn started (ms)
  const tree = {};           // agent -> every pid seen under the turn, even ones that have since exited
  let lastKilled = new Set(); // pids the last sweep closed

  function load() {
    try { rules = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch {
      rules = require('./automations-starter.json');
      save(rules);
    }
    return rules;
  }
  function save(next) {
    fs.mkdirSync(HIST, { recursive: true });
    if (fs.existsSync(FILE)) {
      fs.copyFileSync(FILE, path.join(HIST, `automations-${Date.now()}.json`));
      const old = fs.readdirSync(HIST).sort();
      for (const f of old.slice(0, Math.max(0, old.length - 20))) fs.unlinkSync(path.join(HIST, f));
    }
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
    rules = next;
  }
  function saveState() { fs.writeFileSync(STATE, JSON.stringify(st)); }
  function writeRun(run) {
    const rec = { ts: run.ts, end: Date.now(), id: run.id, auto: run.auto.id, name: run.auto.name, trigger: run.summary, steps: run.steps, result: run.result };
    fs.appendFileSync(RUNS, JSON.stringify(rec) + '\n');
    api.broadcast?.('automation-run', rec);
  }
  function persistPending() {
    const list = [...active.values()].filter((r) => r.waiting).map((r) => ({ id: r.id, auto: r.auto.id, ts: r.ts, at: r.at, vars: r.vars, summary: r.summary, steps: r.steps, waitStarted: r.waitStarted }));
    try { fs.writeFileSync(PENDING, JSON.stringify(list)); } catch {}
  }

  // ---- conditions
  const procCount = (name) => procs.filter((p) => String(p.n).toLowerCase() === name.toLowerCase()).length;
  const COND = {
    not: (c, v) => !test(c.cond, v),
    and: (c, v) => (c.all || []).every((x) => test(x, v)),
    or: (c, v) => (c.any || []).some((x) => test(x, v)),
    isAgent: (c) => api.isAgent(c.agent),
    agentIdle: (c) => !api.isBusy(c.agent),
    control: (c) => api.control() === !!c.on,
    textMatches: (c, v) => new RegExp(c.re, c.flags ?? 'i').test(fill(c.text, v)),
    handoffSentRecently: (c) => {
      const since = Date.now() - dur(c.within || '20m');
      return handoffs.some((h) => h.to === c.to && h.ts >= since && (!c.from || h.from === c.from));
    },
    queuedFrom: (c) => api.queuedFrom(c.agent, c.from),
    statusSince: (c, v) => statusLog.some((s) => s.ts > (v.trigger?.ts || 0) && (!c.author || s.author === c.author) && new RegExp(c.re, 'i').test(s.text)),
    processCount: (c) => {
      const n = procCount(c.name);
      return c.op === '>' ? n > c.n : c.op === '<' ? n < c.n : n === c.n;
    },
    fileLines: (c) => { try { return fs.readFileSync(c.file, 'utf8').split('\n').filter(Boolean).length > c.over; } catch { return false; } },
    varTrue: (c, v) => !!fill(`{{${c.var}}}`, v) && fill(`{{${c.var}}}`, v) !== 'false',
  };
  function test(c, vars) {
    if (!c) return true;
    const f = COND[c.type];
    if (!f) throw new Error(`unknown condition ${c.type}`);
    return !!f(fillDeep(c, vars), vars);
  }

  // ---- steps
  const STEP = {
    async wait(s, run) { await waitFor(run, () => false, dur(s.for)); return `waited ${s.for}`; },
    async waitUntil(s, run) {
      const ok = await waitFor(run, () => test(s.cond, run.vars), dur(s.timeout || '1h'), dur(s.every || '30s'), !!s.process);
      if (!ok) { run.vars.timedOut = true; if (s.onTimeout === 'stop') throw stopRun(`timed out after ${s.timeout}`); return 'timed out'; }
      return 'condition met';
    },
    async stopIf(s, run) { if (test(s.cond, run.vars)) throw stopRun(fill(s.why || 'stop condition met', run.vars)); return 'continue'; },
    async wake(s, run) {
      const id = String(s.agent || '').replace(/^@/, '').toLowerCase();
      if (!api.isAgent(id)) throw new Error(`no agent ${id}`);
      api.wake(id, { text: s.brief, model: s.model || 'sonnet', name: run.auto.name, hop: run.vars.hop || 1 });
      if (s.announce !== false) api.post(fill(s.announce || `⚡ ${run.auto.name}: woke @${id}.`, run.vars));
      return `woke @${id}`;
    },
    async post(s) { api.post(s.text); return 'posted'; },
    async verifyPaths(s, run) {
      const paths = extractPaths(s.text);
      const missing = paths.filter((p) => !fs.existsSync(p));
      run.vars.verify = { ok: !missing.length, checked: paths, missing, any: paths.length > 0 };
      return paths.length ? `checked ${paths.length}, missing ${missing.length}` : 'no paths in line';
    },
    async sweepStray(s) {
      const id = s.agent;
      const mine = owned[id];
      delete owned[id];
      if (!mine || !mine.size) return 'nothing started';
      await refreshProcs();
      const alive = new Set(procs.map((p) => p.i));
      const killed = [];
      lastKilled = new Set();
      const games = procCount('Game.exe');
      for (const [pid, p] of mine) {
        if (!alive.has(pid)) continue;
        const isGame = /^game\.exe$/i.test(p.name);
        if (isGame && games <= 1 && !s.force) continue;
        if (!isGame && KEEP_PY.test(p.cmd || '')) continue;
        killed.push(`${p.name} (${pid})`);
        lastKilled.add(pid);
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      }
      if (killed.length) api.post(`🧹 Closed what @${id} left running: ${killed.join(', ')}.`);
      return killed.length ? `closed ${killed.join(', ')}` : 'nothing left running';
    },
    async trimFile(s) {
      const lines = fs.readFileSync(s.file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
      if (lines.length <= s.over) return `${lines.length} lines, under ${s.over}`;
      const move = lines.slice(0, lines.length - s.keep);
      fs.appendFileSync(s.archive, move.join('\n') + '\n');
      fs.writeFileSync(s.file, lines.slice(-s.keep).join('\n') + '\n');
      lastStatus = new Set(lines.slice(-s.keep));
      return `moved ${move.length} lines to archive`;
    },
  };
  function stopRun(why) { const e = new Error(why); e.stop = true; return e; }

  // Poll-based wait; survives restarts through automation-pending.json.
  async function waitFor(run, done, total, every = 15e3, needsProcs = false) {
    run.waiting = true;
    run.waitStarted = run.waitStarted || Date.now();
    persistPending();
    const until = run.waitStarted + total;
    let ok = false;
    while (!run.cancelled) {
      if (needsProcs) await refreshProcs();
      if (done()) { ok = true; break; }
      if (Date.now() >= until) break;
      await sleep(Math.min(every, Math.max(1000, until - Date.now())));
    }
    run.waiting = false;
    run.waitStarted = null;
    persistPending();
    if (run.cancelled) throw stopRun('cancelled');
    return ok;
  }

  async function execute(run) {
    active.set(run.id, run);
    try {
      for (; run.at < run.auto.steps.length; run.at++) {
        const raw = run.auto.steps[run.at];
        if (raw.if && !test(raw.if, run.vars)) { run.steps.push({ type: raw.type, ok: true, out: 'skipped' }); continue; }
        const s = fillDeep(raw, run.vars);
        try {
          const out = await STEP[s.type](s, run);
          run.steps.push({ type: s.type, ok: true, out });
        } catch (e) {
          run.steps.push({ type: s.type, ok: !!e.stop, out: e.message });
          if (e.stop) { run.result = `stopped: ${e.message}`; return; }
          throw e;
        }
      }
      run.result = 'ok';
    } catch (e) {
      run.result = `failed: ${e.message}`;
      api.post(`⚠️ Automation "${run.auto.name}" failed: ${e.message}`);
    } finally {
      active.delete(run.id);
      persistPending();
      writeRun(run);
    }
  }

  function limited(a, target) {
    const now = Date.now();
    const l = a.limits || {};
    const list = (fired[a.id] = (fired[a.id] || []).filter((t) => now - t < 60 * MIN));
    if (l.perHour && list.length >= l.perHour) return 'hourly limit';
    if (target && l.perTarget) {
      const last = targetFired[`${a.id}:${target}`];
      if (last && now - last < dur(l.perTarget)) return `already fired for ${target} recently`;
    }
    return null;
  }

  let runSeq = 0;
  function matches(a, ev) {
    const trig = Array.isArray(a.trigger) ? a.trigger : [a.trigger];
    return trig.find((t) => t.type === ev.type && Object.entries(t.match || {}).every(([k, want]) => {
      const got = ev[k];
      if (want === true) return Array.isArray(got) ? got.length > 0 : !!got;
      if (typeof want === 'string' && want.startsWith('/')) return new RegExp(want.slice(1, want.lastIndexOf('/')), want.slice(want.lastIndexOf('/') + 1)).test(String(got ?? ''));
      return got === want;
    }));
  }
  function emit(ev) {
    ev.ts = ev.ts || Date.now();
    if (st.paused) return;
    for (const a of rules) {
      if (!a.enabled || !matches(a, ev)) continue;
      const vars = { trigger: ev, ...ev, hop: (ev.hop || 0) + 1 };
      try { if (!(a.conditions || []).every((c) => test(c, vars))) continue; }
      catch (e) { log(`automation ${a.id}: ${e.message}`); continue; }
      const target = a.limits?.targetVar ? fill(`{{${a.limits.targetVar}}}`, vars) : null;
      if ((a.limits?.chainDepth || 3) < vars.hop) continue;
      const why = limited(a, target);
      if (why) { log(`automation ${a.id} skipped: ${why}`); continue; }
      fired[a.id].push(Date.now());
      if (target) targetFired[`${a.id}:${target}`] = Date.now();
      const run = { id: `r${Date.now().toString(36)}${(runSeq++).toString(36)}`, auto: a, ts: Date.now(), at: 0, vars, steps: [], summary: fill(a.summary || ev.type, vars).slice(0, 300) };
      execute(run);
    }
  }

  // ---- watchers
  let lastStatus = null;
  function readStatus() { try { return fs.readFileSync(statusFile, 'utf8').split(/\r?\n/).filter((l) => l.trim()); } catch { return null; } }
  function checkStatus() {
    const lines = readStatus();
    if (!lines) return;
    if (!lastStatus) { lastStatus = new Set(lines); return; }
    const fresh = lines.filter((l) => !lastStatus.has(l));
    lastStatus = new Set(lines);
    for (const l of fresh) {
      const p = parseStatusLine(l, api.isAgent);
      statusLog.push({ ts: Date.now(), author: p.author, text: p.text });
      if (statusLog.length > 200) statusLog.shift();
      emit({ type: 'status.line', line: p.text, author: p.author, done: p.done, waitingOn: p.waitingOn });
      for (const w of p.waitingOn) emit({ type: 'status.waiting', line: p.text, author: p.author, waitingOn: w });
    }
    emit({ type: 'file.status', lines: lines.length, file: statusFile, archive: statusFile.replace(/\.md$/i, '-archive.md') });
  }

  async function refreshProcs() {
    const list = await listProcesses();
    if (!list) return procs;
    procs = list;
    const kids = new Map();
    for (const p of list) { if (!kids.has(p.p)) kids.set(p.p, []); kids.get(p.p).push(p); }
    for (const [agent, root] of Object.entries(turnPid)) {
      const seen = owned[agent] || (owned[agent] = new Map());
      const known = tree[agent] || (tree[agent] = new Set([root]));
      // Start from every pid ever seen under this turn, so a Game.exe started detached by a
      // launcher that has already exited is still found (its parent pid stays in the list).
      const stack = [...known];
      const visited = new Set();
      while (stack.length) {
        const pid = stack.pop();
        if (visited.has(pid)) continue;
        visited.add(pid);
        for (const k of kids.get(pid) || []) {
          if (k.t && turnAt[agent] && k.t < turnAt[agent] - 2000) continue; // older than the turn: pid reuse, not ours
          known.add(k.i);
          if (/^(game\.exe|python[\w.]*\.exe)$/i.test(k.n)) seen.set(k.i, { name: k.n, cmd: k.c });
          stack.push(k.i);
        }
      }
    }
    return procs;
  }
  setInterval(() => { if (Object.keys(turnPid).length) refreshProcs(); }, 15e3).unref();

  function start() {
    load();
    checkStatus();
    fs.watchFile(statusFile, { interval: 3000 }, () => { try { checkStatus(); } catch (e) { log(`status watch: ${e.message}`); } });
    // Resume waits that were in flight before a restart.
    let resumed = 0;
    try {
      for (const p of JSON.parse(fs.readFileSync(PENDING, 'utf8'))) {
        const a = rules.find((x) => x.id === p.auto && x.enabled);
        if (!a) continue;
        resumed++;
        execute({ ...p, auto: a, steps: p.steps || [] });
      }
    } catch {}
    return { rules: rules.filter((r) => r.enabled).length, resumed };
  }

  // ---- rules made in the builder
  const TRIGGERS = ['status.line', 'status.waiting', 'reply.waiting', 'agent.reply', 'turn.end', 'file.status'];
  function checkCond(c, where) {
    if (!c || typeof c !== 'object' || !COND[c.type]) throw new Error(`${where}: unknown condition ${c && c.type}`);
    if (c.type === 'not') checkCond(c.cond, where);
    for (const x of c.all || c.any || []) checkCond(x, where);
  }
  function validate(r) {
    if (!r || typeof r !== 'object') throw new Error('no rule');
    if (!String(r.name || '').trim()) throw new Error('Give it a name.');
    const trig = Array.isArray(r.trigger) ? r.trigger : [r.trigger];
    if (!trig.length || trig.some((t) => !t || !TRIGGERS.includes(t.type))) throw new Error('Pick a "When" block.');
    (r.conditions || []).forEach((c, i) => checkCond(c, `condition ${i + 1}`));
    if (!Array.isArray(r.steps) || !r.steps.length) throw new Error('Add at least one "Then" block.');
    r.steps.forEach((st, i) => {
      if (!STEP[st.type]) throw new Error(`step ${i + 1}: unknown action ${st.type}`);
      if (st.cond) checkCond(st.cond, `step ${i + 1}`);
      if (st.if) checkCond(st.if, `step ${i + 1}`);
    });
  }
  function upsert(r) {
    validate(r);
    const id = String(r.id || '').trim() || (String(r.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'rule') + '-' + Date.now().toString(36);
    const clean = { ...r, id, name: String(r.name).trim().slice(0, 120), enabled: r.enabled !== false };
    const list = rules.slice();
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list[i] = clean; else list.push(clean);
    save(list);
    return clean;
  }
  function remove(id) {
    if (!rules.some((x) => x.id === id)) return false;
    save(rules.filter((x) => x.id !== id));
    return true;
  }

  return {
    start,
    emit,
    upsert,
    remove,
    list: () => rules,
    save,
    paused: () => st.paused,
    setPaused(v) { st.paused = !!v; saveState(); if (v) cancelAll(); },
    runs(n = 100) {
      try { return fs.readFileSync(RUNS, 'utf8').trim().split('\n').slice(-n).map((l) => JSON.parse(l)).reverse(); } catch { return []; }
    },
    active: () => [...active.values()].map((r) => ({ id: r.id, auto: r.auto.id, name: r.auto.name, summary: r.summary, at: r.at, waiting: !!r.waiting, since: r.ts })),
    noteHandoff(from, to) { handoffs.push({ from, to, ts: Date.now() }); if (handoffs.length > 300) handoffs.shift(); },
    turnStarted(agent, pid) { turnPid[agent] = pid; turnAt[agent] = Date.now(); tree[agent] = new Set([pid]); owned[agent] = new Map(); },
    turnEnded(agent, ok, hop) { delete turnPid[agent]; delete tree[agent]; emit({ type: 'turn.end', agent, ok, hop }); },
    // An agent's visible reply. "waiting on @x" with no handoff to x becomes reply.waiting.
    replied(agent, text, targets = [], hop = 0) {
      emit({ type: 'agent.reply', agent, text, targets, hop });
      const p = parseStatusLine(String(text || ''), api.isAgent);
      for (const w of p.waitingOn) if (w !== agent && !targets.includes(w)) emit({ type: 'reply.waiting', author: agent, line: String(text).slice(0, 600), waitingOn: w, hop });
    },
    // Close what this agent's run started right now (used when a silent run is cut off). Game.exe is closed even if it is the only one.
    // Resolves to short text. A Game.exe still running that cannot be traced to this agent is left
    // open (it may be the owner's own) and named in the text.
    async sweepNow(agent) {
      await refreshProcs();
      const out = await STEP.sweepStray({ agent, force: true });
      const left = procs.filter((p) => /^game\.exe$/i.test(p.n) && !lastKilled.has(p.i)).map((p) => p.i);
      return out + (left.length ? `; Game.exe still running, not traceable to ${agent} so left open: pid ${left.join(', ')}` : '');
    },
    cancelAll,
    _parse: parseStatusLine,
    _paths: extractPaths,
  };
  function cancelAll() { for (const r of active.values()) r.cancelled = true; }
}

module.exports = { createAutomations, parseStatusLine, extractPaths };
