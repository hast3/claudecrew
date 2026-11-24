'use strict';
// App previews: dev servers Crew starts and stops for agents building web apps,
// and the proxy that shows them inside Crew (PC and phone) at /preview/<id>/.
//
// A preview is { id, name, agent, cwd, command, port }. Agents add them with
// tools/preview.js (which calls /api/previews/* on localhost). They are saved in
// data/previews.json; ones that were running come back after a Crew restart.
//
// Proxy rules:
//   /preview/<id>/rest  ->  http://127.0.0.1:<port>/rest   (sets cookie crew_preview=<id>)
//   any other path Crew doesn't own, with that cookie -> the same preview. That covers
//   apps that load "/assets/x.js" or open a websocket at "/" (Vite, Next, etc.).

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, execFile } = require('child_process');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const LOG_LINES = 300;

function createPreviews({ dataDir, onChange = () => {} }) {
  const file = path.join(dataDir, 'previews.json');
  const items = new Map(); // id -> { def, proc, pid, status, log[], startedAt, exit }

  function save() {
    const out = [...items.values()].map((p) => ({ ...p.def, running: p.status === 'running', pid: p.pid || null }));
    try { fs.writeFileSync(file, JSON.stringify(out, null, 2)); } catch (e) { console.error('previews: save failed', e.message); }
  }
  function load() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  }

  function killTree(pid) {
    return new Promise((resolve) => {
      if (!pid) return resolve();
      if (process.platform !== 'win32') { try { process.kill(-pid); } catch {} try { process.kill(pid); } catch {} return resolve(); }
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    });
  }

  function addLog(p, chunk) {
    const lines = String(chunk).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).filter((l) => l.trim());
    p.log.push(...lines.map((l) => l.slice(0, 500)));
    if (p.log.length > LOG_LINES) p.log.splice(0, p.log.length - LOG_LINES);
  }

  function info(p) {
    return {
      ...p.def, status: p.status, pid: p.pid || null, startedAt: p.startedAt || null,
      exit: p.exit ?? null, ready: !!p.ready, failed: !!p.failed, url: `/preview/${p.def.id}/`, local: `http://localhost:${p.def.port}/`,
    };
  }

  // Watch the port after a start: ready when it answers, failed after the timeout.
  const START_TIMEOUT = 120000;
  function watchPort(p, proc) {
    p.ready = false; p.failed = false;
    const t0 = Date.now();
    const tick = () => {
      if (p.proc !== proc) return;
      const s = net.connect({ host: '127.0.0.1', port: p.def.port });
      s.setTimeout(1500);
      const next = (ok) => {
        s.destroy();
        if (p.proc !== proc) return;
        if (ok) { p.ready = true; onChange(); return; }
        if (Date.now() - t0 > START_TIMEOUT) { p.failed = true; addLog(p, '[crew] gave up waiting for the app to answer'); onChange(); return; }
        setTimeout(tick, 700);
      };
      s.on('connect', () => next(true)); s.on('error', () => next(false)); s.on('timeout', () => next(false));
    };
    tick();
  }

  function validate(d) {
    const def = {
      id: String(d.id || '').toLowerCase().trim(),
      name: String(d.name || d.id || '').trim().slice(0, 60),
      agent: String(d.agent || '').trim().slice(0, 40),
      cwd: String(d.cwd || '').trim(),
      command: String(d.command || '').trim(),
      port: Number(d.port),
    };
    if (!ID_RE.test(def.id)) throw new Error('id must be lowercase letters, digits and dashes');
    if (!def.command) throw new Error('command is required (e.g. "npm run dev")');
    if (!def.cwd || !fs.existsSync(def.cwd)) throw new Error(`folder not found: ${def.cwd}`);
    if (!Number.isInteger(def.port) || def.port < 1024 || def.port > 65535) throw new Error('port must be 1024-65535');
    if ([7777, 7778].includes(def.port)) throw new Error('that port is Crew itself');
    for (const p of items.values()) if (p.def.id !== def.id && p.def.port === def.port) throw new Error(`port ${def.port} is already used by preview "${p.def.id}"`);
    return def;
  }

  function upsert(d) {
    const def = validate(d);
    const p = items.get(def.id);
    if (p) p.def = def; else items.set(def.id, { def, status: 'stopped', log: [] });
    save(); onChange();
    return info(items.get(def.id));
  }

  async function start(id) {
    const p = items.get(id);
    if (!p) throw new Error(`no preview "${id}"`);
    if (p.status === 'running') return info(p);
    p.log = [];
    p.exit = null; p.ready = false; p.failed = false;
    addLog(p, `[crew] starting: ${p.def.command}  (in ${p.def.cwd}, PORT=${p.def.port})`);
    const env = { ...process.env, PORT: String(p.def.port), BROWSER: 'none', FORCE_COLOR: '0' };
    delete env.CLAUDECODE;
    const proc = spawn(p.def.command, { cwd: p.def.cwd, env, shell: true, windowsHide: true, detached: process.platform !== 'win32' });
    p.proc = proc; p.pid = proc.pid; p.status = 'running'; p.startedAt = Date.now();
    proc.stdout.on('data', (c) => addLog(p, c));
    proc.stderr.on('data', (c) => addLog(p, c));
    proc.on('error', (e) => addLog(p, `[crew] failed to start: ${e.message}`));
    proc.on('exit', (code) => {
      if (p.proc !== proc) return;
      addLog(p, `[crew] stopped (exit ${code})`);
      p.proc = null; p.pid = null; p.status = 'stopped'; p.exit = code; p.ready = false;
      save(); onChange();
    });
    save(); onChange();
    watchPort(p, proc);
    return info(p);
  }

  async function stop(id) {
    const p = items.get(id);
    if (!p) throw new Error(`no preview "${id}"`);
    const pid = p.pid;
    p.proc = null; p.pid = null; p.status = 'stopped'; p.ready = false; p.failed = false;
    await killTree(pid);
    addLog(p, '[crew] stopped by request');
    save(); onChange();
    return info(p);
  }

  async function restart(id) { await stop(id); return start(id); }

  async function remove(id) {
    if (!items.has(id)) return;
    await stop(id);
    items.delete(id);
    save(); onChange();
  }

  // On boot: kill anything left over from the last run, then bring back what was running.
  async function boot() {
    for (const d of load()) {
      try {
        const def = validate(d);
        items.set(def.id, { def, status: 'stopped', log: [] });
        if (d.pid) await killTree(d.pid);
        if (d.running) await start(def.id);
      } catch (e) { console.error(`previews: skipped "${d && d.id}": ${e.message}`); }
    }
  }

  async function stopAll() { for (const id of items.keys()) if (items.get(id).status === 'running') await stop(id); }

  // ---- proxy

  // How a request maps to a preview: its path (/preview/<id>/...), the page that asked for
  // it (Referer inside /preview/<id>/, so an app's own "/api/x" calls reach the app), or the
  // crew_preview cookie (websockets and anything without a Referer; never for Crew's own paths).
  function previewFor(req, pathname, crewPath = false) {
    const m = pathname.match(/^\/preview\/([a-z0-9-]+)(\/.*)?$/);
    if (m) return { p: items.get(m[1]), rest: m[2] || '/', id: m[1], prefixed: true };
    let ref = '';
    try { ref = new URL(String(req.headers.referer || '')).pathname; } catch {}
    const r = ref.match(/^\/preview\/([a-z0-9-]+)\//);
    if (r && items.has(r[1])) return { p: items.get(r[1]), rest: pathname, id: r[1], prefixed: false };
    if (crewPath) return null;
    const c = String(req.headers.cookie || '').match(/(?:^|;\s*)crew_preview=([a-z0-9-]+)/);
    if (c && items.has(c[1])) return { p: items.get(c[1]), rest: pathname, id: c[1], prefixed: false };
    return null;
  }

  function stripCrewCookies(h) {
    if (!h.cookie) return;
    const kept = h.cookie.split(/;\s*/).filter((c) => !/^(crew_key|crew_preview|CF_Authorization)=/.test(c));
    if (kept.length) h.cookie = kept.join('; '); else delete h.cookie;
  }

  function proxyHeaders(req, port) {
    const h = { ...req.headers, host: `127.0.0.1:${port}` };
    stripCrewCookies(h);
    delete h['cf-access-jwt-assertion'];
    delete h.origin; // dev servers often reject a foreign origin; the browser's real origin is Crew's
    delete h['accept-encoding']; // keep it simple: no compressed bodies to rewrite
    return h;
  }

  function notRunningPage(p, id) {
    const why = !p ? `There is no preview called "${id}".` : `"${p.def.name}" isn't running. Start it from Crew's Preview panel.`;
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:15px system-ui;background:#141413;color:#ddd;display:grid;place-items:center;min-height:90vh;text-align:center;padding:16px">${why.replace(/</g, '&lt;')}</body>`;
  }

  function startingPage(name) {
    const n = String(name).replace(/</g, '&lt;');
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:15px system-ui;background:#141413;color:#ddd;display:grid;place-items:center;min-height:90vh;text-align:center;padding:16px;margin:0}.b{display:flex;gap:6px;justify-content:center;margin-bottom:16px}.b i{width:10px;height:10px;border-radius:50%;background:#d97757;animation:p 1.2s infinite ease-in-out}.b i:nth-child(2){animation-delay:.15s}.b i:nth-child(3){animation-delay:.3s}@keyframes p{0%,80%,100%{opacity:.2;transform:scale(.7)}40%{opacity:1;transform:scale(1.15)}}</style><body><div><div class="b"><i></i><i></i><i></i></div>Starting up ${n}…<br><small style="color:#888">This page will refresh by itself.</small></div><script>setTimeout(function(){location.reload()},2000)</script></body>`;
  }

  // Returns true if it handled the request.
  function handle(req, res, url, crewPath) {
    const hit = previewFor(req, url.pathname, crewPath);
    if (!hit) return false;
    const { p, rest, id, prefixed } = hit;
    // "/preview/x" -> "/preview/x/" so relative links resolve inside the prefix.
    if (prefixed && !url.pathname.match(/^\/preview\/[a-z0-9-]+\//)) {
      res.writeHead(302, { Location: `/preview/${id}/${url.search}` });
      res.end(); return true;
    }
    const setCookie = prefixed ? [`crew_preview=${id}; Path=/; SameSite=Lax; HttpOnly`] : [];
    if (!p || p.status !== 'running') {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': setCookie });
      res.end(notRunningPage(p, id)); return true;
    }
    const up = http.request({ host: '127.0.0.1', port: p.def.port, method: req.method, path: rest + url.search, headers: proxyHeaders(req, p.def.port) }, (r) => {
      const h = { ...r.headers };
      delete h['x-frame-options'];
      if (h['content-security-policy']) h['content-security-policy'] = String(h['content-security-policy']).replace(/frame-ancestors[^;]*;?/i, '');
      if (h.location && /^\//.test(h.location) && !h.location.startsWith('//')) h.location = `/preview/${id}${h.location}`;
      const sc = [].concat(h['set-cookie'] || [], setCookie);
      if (sc.length) h['set-cookie'] = sc;
      res.writeHead(r.statusCode, h);
      r.pipe(res);
    });
    up.on('error', (e) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': setCookie });
      if (p.failed) res.end(notRunningPage(null, id).replace(/There is no preview called[^<]*/, `"${p.def.name}" didn't start. Check its log in Crew's Preview panel.`));
      else res.end(startingPage(p.def.name));
    });
    req.pipe(up);
    return true;
  }

  // Websocket upgrades (hot reload). Crew itself has no websockets, so anything that maps to a preview goes there.
  function handleUpgrade(req, socket, head, url) {
    const hit = previewFor(req, url.pathname, false);
    if (!hit || !hit.p || hit.p.status !== 'running') { socket.destroy(); return; }
    const up = http.request({ host: '127.0.0.1', port: hit.p.def.port, method: req.method, path: hit.rest + url.search, headers: proxyHeaders(req, hit.p.def.port) });
    up.on('upgrade', (r, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${r.statusCode} ${r.statusMessage}`];
      for (let i = 0; i < r.rawHeaders.length; i += 2) lines.push(`${r.rawHeaders[i]}: ${r.rawHeaders[i + 1]}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upHead && upHead.length) socket.write(upHead);
      if (head && head.length) upSocket.write(head);
      upSocket.pipe(socket); socket.pipe(upSocket);
      upSocket.on('error', () => socket.destroy()); socket.on('error', () => upSocket.destroy());
    });
    up.on('response', () => socket.destroy());
    up.on('error', () => socket.destroy());
    up.end();
  }

  return {
    boot, stopAll, upsert, start, stop, restart, remove, handle, handleUpgrade,
    list: () => [...items.values()].map(info),
    get: (id) => (items.has(id) ? info(items.get(id)) : null),
    logs: (id, n = 100) => (items.has(id) ? items.get(id).log.slice(-n) : null),
  };
}

module.exports = { createPreviews };
