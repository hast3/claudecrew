#!/usr/bin/env node
'use strict';
// Manage app previews (dev servers Crew runs and shows at /preview/<id>/).
//   node tools/preview.js list
//   node tools/preview.js add <id> --port 5173 --cwd "C:\path" --cmd "npm run dev" [--name "Nice name"] [--agent webapp] [--no-start]
//   node tools/preview.js start|stop|restart|remove <id>
//   node tools/preview.js logs <id> [n]
const http = require('http');

const CREW_PORT = Number(process.env.CREW_PORT) || 7777;

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: CREW_PORT, method, path,
      headers: { 'x-crew': '1', 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let j; try { j = JSON.parse(buf); } catch { j = { error: buf.slice(0, 300) }; }
        if (res.statusCode >= 400) reject(new Error(j.error || `HTTP ${res.statusCode}`)); else resolve(j);
      });
    });
    req.on('error', (e) => reject(new Error(`Crew isn't reachable on port ${CREW_PORT}: ${e.message}`)));
    if (data) req.write(data);
    req.end();
  });
}

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-start') out.noStart = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

function line(p) {
  return `${p.id.padEnd(16)} ${p.status.padEnd(8)} port ${String(p.port).padEnd(6)} ${p.name}${p.agent ? `  (@${p.agent})` : ''}\n    ${p.local}  ·  in Crew: ${p.url}`;
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  const id = f._[0];
  try {
    if (!cmd || cmd === 'list') {
      const list = await call('GET', '/api/previews');
      console.log(list.length ? list.map(line).join('\n') : 'No previews yet.');
    } else if (cmd === 'add') {
      const p = await call('POST', '/api/previews/add', { id, port: Number(f.port), cwd: f.cwd, command: f.cmd, name: f.name || id, agent: f.agent || '' });
      const s = f.noStart ? p : await call('POST', '/api/previews/start', { id: p.id });
      console.log(line(s));
    } else if (['start', 'stop', 'restart'].includes(cmd)) {
      console.log(line(await call('POST', `/api/previews/${cmd}`, { id })));
    } else if (cmd === 'remove') {
      await call('POST', '/api/previews/remove', { id });
      console.log(`Removed ${id}.`);
    } else if (cmd === 'logs') {
      const r = await call('GET', `/api/previews/logs?id=${encodeURIComponent(id || '')}&n=${Number(f._[1]) || 60}`);
      console.log(r.lines.join('\n') || '(no output yet)');
    } else {
      console.log('Usage: preview.js list | add <id> --port N --cwd DIR --cmd "npm run dev" [--name X] [--agent id] [--no-start] | start|stop|restart|remove <id> | logs <id> [n]');
      process.exit(1);
    }
  } catch (e) {
    console.error('preview: ' + e.message);
    process.exit(1);
  }
})();
