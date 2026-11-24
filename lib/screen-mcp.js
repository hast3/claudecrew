#!/usr/bin/env node
'use strict';
// Crew "screen" MCP server: lets an agent see and drive the Windows desktop.
// screenshot -> decide -> act -> repeat. Registered for every agent by server.js (mcpConfigFor).
// Stdio JSON-RPC, no dependencies. Every tool refuses while Computer control is OFF.
// Crew runs in session 0, which cannot see the desktop ("The handle is invalid"), so the Win32 work
// happens in lib/screen-helper.ps1: a small bridge on 127.0.0.1:7790 that runs on the owner's desktop as
// the "CrewScreen" scheduled task (Interactive only, at logon). We create/start that task as needed.
// Click/scroll/drag coordinates are in the pixels of the LAST screenshot, mapped back to the screen.

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const CONTROL_FILE = process.env.CREW_CONTROL_FILE || path.join(DATA, 'computer-control.json');
const TOKEN_FILE = path.join(DATA, 'screen-token.txt');
const PORT = Number(process.env.CREW_SCREEN_PORT) || 7790;
const TASK = 'CrewScreen';
const REVIEW_DIR = process.env.CREW_REVIEW_DIR || path.join(require('os').homedir(), 'td_review');
const AGENT = (process.env.CREW_AGENT || 'agent').replace(/[^a-z0-9-]/gi, '') || 'agent';
// Saved shots are temporary: Crew wipes crew-tmp\<agent> when the agent's turn ends,
// and sweeps the whole crew-tmp folder at startup and hourly.
const TMP_DIR = path.join(REVIEW_DIR, 'crew-tmp', AGENT);
const MAX_W = 1280;

// ---------------------------------------------------------------- bridge on the owner's desktop
function token() {
  try { const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); if (t) return t; } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, t);
  return t;
}

function send(req, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: PORT });
    let buf = '';
    let done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(t); sock.destroy(); err ? reject(err) : resolve(val); };
    const t = setTimeout(() => finish(Object.assign(new Error('The screen bridge did not answer in time.'), { timeout: true })), timeoutMs);
    sock.setEncoding('ascii');
    sock.on('connect', () => sock.write(`${token()} ${Buffer.from(JSON.stringify(req), 'utf8').toString('base64')}\n`));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      try { finish(null, JSON.parse(buf.slice(0, i))); } catch { finish(new Error('The screen bridge sent bad data.')); }
    });
    sock.on('error', (e) => finish(e));
    sock.on('close', () => finish(new Error('The screen bridge closed the connection.')));
  });
}

const run = (file, args) => new Promise((resolve) => execFile(file, args, { windowsHide: true }, (err, out, errOut) => resolve({ err, out: `${out}${errOut}` })));

// Start the bridge in the owner's session through the scheduled task, creating the task if missing.
async function startBridge() {
  let r = await run('schtasks', ['/run', '/tn', TASK]);
  if (r.err) {
    const ps = path.join(__dirname, 'screen-helper.ps1');
    const tr = `conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps}" -Port ${PORT}`;
    r = await run('schtasks', ['/create', '/tn', TASK, '/sc', 'onlogon', '/it', '/rl', 'limited', '/f', '/tr', tr]);
    if (r.err) throw new Error(`Could not set up the screen bridge task: ${r.out.trim()}`);
    r = await run('schtasks', ['/run', '/tn', TASK]);
    if (r.err) throw new Error(`Could not start the screen bridge: ${r.out.trim()}`);
  }
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { await send({ cmd: 'ping' }, 3000); return; } catch {}
  }
  throw new Error('The screen bridge did not start. Is the owner logged in to Windows?');
}

async function ask(req, timeoutMs = 30000) {
  let r;
  try {
    r = await send(req, timeoutMs);
  } catch (e) {
    if (e.timeout || e.code !== 'ECONNREFUSED') throw e;
    await startBridge();
    r = await send(req, timeoutMs);
  }
  if (r && r.error) throw new Error(r.error);
  return r;
}

// ---------------------------------------------------------------- rules
function controlOn() {
  try { return !!JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8')).on; } catch { return false; }
}
const OFF_MSG = 'Computer control is OFF: the owner is at the computer. No screenshots, clicks or keys. Work from files and logs, and leave in-game checks as a list for the owner.';

// One Game.exe rule: never drive input while more than one copy is running.
async function oneGameOk() {
  const { count } = await ask({ cmd: 'games' });
  if (count > 1) throw new Error(`${count} copies of Game.exe are running. Only one is allowed: close the one you started, then try again.`);
}

// ---------------------------------------------------------------- screenshot state
let last = null; // { hwnd, title, ox, oy, scale, sw, sh }

async function resolveWindow(title) {
  if (!title) return 0;
  const { hwnd } = await ask({ cmd: 'find', title });
  if (!hwnd) throw new Error(`No open window matches "${title}". Use list_windows to see the titles.`);
  return hwnd;
}

async function shoot({ window: title, save, region } = {}) {
  const hwnd = title !== undefined ? await resolveWindow(title) : (last ? last.hwnd : 0);
  // Zoom: region {x,y,w,h} is in the LAST screenshot's pixels; convert to real screen pixels.
  let rg = { rx: 0, ry: 0, rw: 0, rh: 0 };
  if (region) {
    if (!last) throw new Error('Take a screenshot first: the region is in the last screenshot\'s pixels.');
    if (title !== undefined && hwnd !== last.hwnd) throw new Error('A region zooms into the last screenshot, so leave window off (or use the same window).');
    const { x, y, w, h } = region;
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) throw new Error('region needs x, y, w, h (w and h above 0).');
    if (x < 0 || y < 0 || x + w > last.sw + 1 || y + h > last.sh + 1) throw new Error(`Region ${x},${y} ${w}x${h} is outside the last screenshot (${last.sw}x${last.sh}).`);
    rg = { rx: Math.floor(last.ox + x / last.scale), ry: Math.floor(last.oy + y / last.scale), rw: Math.ceil(w / last.scale), rh: Math.ceil(h / last.scale) };
  }
  let file = '';
  if (save) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = typeof save === 'string' && /^[\w-]+$/.test(save) ? save : `screen-${AGENT}-${stamp}`;
    file = path.join(TMP_DIR, `${name}.png`);
  }
  const r = await ask({ cmd: 'capture', hwnd, maxW: MAX_W, save: file, ...rg });
  last = { hwnd, title: title || (last && last.hwnd === hwnd ? last.title : ''), ox: r.ox, oy: r.oy, scale: r.scale, sw: r.sw, sh: r.sh };
  const what = hwnd ? `window "${last.title || hwnd}"` : 'full desktop';
  const text = `${region ? 'Zoomed ' : ''}Screenshot of ${what}: ${r.sw}x${r.sh} (real size ${r.w}x${r.h}${region ? `, scale ${Number(r.scale).toFixed(2)}x` : ''}). Click, scroll and drag take x,y in THIS image's pixels.${r.saved ? ` Saved to ${r.saved}.` : ''}`;
  return [{ type: 'text', text }, { type: 'image', data: r.jpeg, mimeType: 'image/jpeg' }];
}

function toScreen(x, y) {
  if (!last) throw new Error('Take a screenshot first: x,y are positions in the last screenshot.');
  if (!(x >= 0 && y >= 0 && x <= last.sw && y <= last.sh)) throw new Error(`(${x},${y}) is outside the last screenshot (${last.sw}x${last.sh}).`);
  return { x: Math.round(last.ox + x / last.scale), y: Math.round(last.oy + y / last.scale) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function after(args, msg) {
  if (!args.screenshot) return [{ type: 'text', text: msg }];
  await sleep(Math.min(Math.max(Number(args.wait_ms) || 400, 0), 5000));
  return [{ type: 'text', text: msg }, ...(await shoot({}))];
}

// ---------------------------------------------------------------- tools
const AFTER = {
  screenshot: { type: 'boolean', description: 'Also return a fresh screenshot after the action (default false).' },
  wait_ms: { type: 'number', description: 'Wait this long before that screenshot (default 400, max 5000).' },
};
const TOOLS = [
  {
    name: 'screenshot',
    description: 'See the screen. Captures the full desktop, or one window by title (partial match, or a process name like "Game"), downscaled to at most 1280px wide, and returns it as an image. Later clicks use this image\'s pixel coordinates. With no window given it re-captures the same target as last time (full desktop at first).',
    inputSchema: { type: 'object', properties: {
      window: { type: 'string', description: 'Window title (or part of it) or process name. Use "" for the full desktop.' },
      region: { type: 'object', description: 'Zoom: x, y, w, h in the LAST screenshot\'s pixels. Re-captures just that area of the same target at native resolution (up to 2x if small). Clicks after it use the zoomed image\'s pixels. Take a normal screenshot (no region) to go back to the full view.', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }, required: ['x', 'y', 'w', 'h'] },
      save: { type: ['boolean', 'string'], description: 'Only when you will send this picture to the owner: also save a PNG (true, or a file name without extension). The file is temporary and deleted when your task ends. Leave this off to just look.' },
    } },
  },
  {
    name: 'list_windows',
    description: 'List open top-level windows: title, process, position, size, minimized and focused.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'focus_window',
    description: 'Bring a window to the front (restores it if minimized).',
    inputSchema: { type: 'object', properties: { window: { type: 'string', description: 'Window title (or part) or process name.' }, ...AFTER }, required: ['window'] },
  },
  {
    name: 'click',
    description: 'Click at x,y in the last screenshot\'s coordinates.',
    inputSchema: { type: 'object', properties: {
      x: { type: 'number' }, y: { type: 'number' },
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      double: { type: 'boolean', description: 'Double-click.' }, ...AFTER,
    }, required: ['x', 'y'] },
  },
  {
    name: 'move',
    description: 'Move the mouse to x,y in the last screenshot\'s coordinates (hover).',
    inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, ...AFTER }, required: ['x', 'y'] },
  },
  {
    name: 'drag',
    description: 'Left-drag from x,y to x2,y2 (last screenshot\'s coordinates).',
    inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, ...AFTER }, required: ['x', 'y', 'x2', 'y2'] },
  },
  {
    name: 'type',
    description: 'Type text into the focused window (Unicode; \\n presses Enter).',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, ...AFTER }, required: ['text'] },
  },
  {
    name: 'key',
    description: 'Press a key or hotkey, e.g. "enter", "esc", "f5", "ctrl+s", "alt+tab", "ctrl+shift+esc". Optional repeat count.',
    inputSchema: { type: 'object', properties: { keys: { type: 'string' }, repeat: { type: 'number' }, ...AFTER }, required: ['keys'] },
  },
  {
    name: 'scroll',
    description: 'Scroll the mouse wheel at x,y (last screenshot\'s coordinates). down: notches down (negative = up). right: notches right (negative = left).',
    inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, down: { type: 'number' }, right: { type: 'number' }, ...AFTER }, required: ['x', 'y'] },
  },
];

async function call(name, args) {
  if (!controlOn()) throw new Error(OFF_MSG);
  switch (name) {
    case 'screenshot': return shoot({ window: args.window, save: args.save, region: args.region });
    case 'list_windows': {
      const { windows } = await ask({ cmd: 'list' });
      const lines = windows.map((w) => `${w.focused ? '* ' : '  '}"${w.title}" [${w.process}] ${w.w}x${w.h} at ${w.x},${w.y}${w.minimized ? ' (minimized)' : ''}`);
      return [{ type: 'text', text: lines.join('\n') || 'No windows.' }];
    }
    case 'focus_window': {
      const hwnd = await resolveWindow(args.window);
      const r = await ask({ cmd: 'focus', hwnd });
      last = null; // the window may have moved or restored; take a new screenshot before clicking
      const res = await after({}, r.focused ? `Focused "${args.window}".` : `Asked Windows to focus "${args.window}", but it is not in front yet.`);
      if (!args.screenshot) return res;
      await sleep(Math.min(Math.max(Number(args.wait_ms) || 400, 0), 5000));
      return [...res, ...(await shoot({ window: args.window }))];
    }
  }
  await oneGameOk();
  switch (name) {
    case 'click': {
      const p = toScreen(args.x, args.y);
      await ask({ cmd: 'click', ...p, button: args.button || 'left', count: args.double ? 2 : 1 });
      return after(args, `${args.double ? 'Double-clicked' : 'Clicked'} ${args.button || 'left'} at ${args.x},${args.y}.`);
    }
    case 'move': {
      await ask({ cmd: 'move', ...toScreen(args.x, args.y) });
      return after(args, `Mouse at ${args.x},${args.y}.`);
    }
    case 'drag': {
      const a = toScreen(args.x, args.y);
      const b = toScreen(args.x2, args.y2);
      await ask({ cmd: 'drag', x: a.x, y: a.y, x2: b.x, y2: b.y });
      return after(args, `Dragged from ${args.x},${args.y} to ${args.x2},${args.y2}.`);
    }
    case 'type': {
      await ask({ cmd: 'type', text: String(args.text || '') }, 120000);
      return after(args, `Typed ${String(args.text || '').length} characters.`);
    }
    case 'key': {
      const n = Math.min(Math.max(Number(args.repeat) || 1, 1), 50);
      for (let i = 0; i < n; i++) await ask({ cmd: 'key', keys: String(args.keys || '') });
      return after(args, `Pressed ${args.keys}${n > 1 ? ` x${n}` : ''}.`);
    }
    case 'scroll': {
      await ask({ cmd: 'scroll', ...toScreen(args.x, args.y), down: Math.round(Number(args.down) || 0), right: Math.round(Number(args.right) || 0) });
      return after(args, `Scrolled at ${args.x},${args.y}.`);
    }
    default: throw new Error(`Unknown tool ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC over stdio
function reply(id, result, error) {
  process.stdout.write(JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }) + '\n');
}
async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification
  try {
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'crew-screen', version: '1.0.0' },
        instructions: 'See and drive the Windows desktop: screenshot, decide, act, repeat. Only while Computer control is ON.',
      });
    }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: TOOLS });
    if (method === 'tools/call') {
      try {
        const content = await call(params.name, params.arguments || {});
        return reply(id, { content });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: e.message }], isError: true });
      }
    }
    return reply(id, null, { code: -32601, message: `Method not found: ${method}` });
  } catch (e) {
    return reply(id, null, { code: -32603, message: e.message });
  }
}

let inBuf = '';
let chain = Promise.resolve(); // one request at a time: the mouse can only be in one place
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  inBuf += d;
  let i;
  while ((i = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, i).trim();
    inBuf = inBuf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    chain = chain.then(() => handle(msg)).catch(() => {});
  }
});
process.stdin.on('end', () => process.exit(0));
