'use strict';
// Claude Crew — a local chat room where several Claude Code agents work in
// their own project folders and can hand work to each other.
// No dependencies: Node's standard library plus the `claude` CLI you already use.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { createUsage } = require('./lib/usage');
const changes = require('./lib/changes');
const activity = require('./lib/activity');
const watchdog = require('./lib/watchdog');
const credentials = require('./lib/credentials');
const localCfg = require('./lib/local-config');
const { createScheduler } = require('./lib/scheduler');
const { createPush } = require('./lib/webpush');
const { createUpdater } = require('./lib/update');
const { createIntegrations } = require('./lib/integrations');
const { createPresence, startClient, pairOnce } = require('./lib/presence');
const { createAutomations } = require('./lib/automations');
const statusLib = require('./lib/status');
const { createProcWatch } = require('./lib/procs');
const { checkPage } = require('./lib/check');
const { createPreviews } = require('./lib/previews');
const freezer = require('./lib/freeze');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PROMPT_DIR = path.join(DATA_DIR, 'prompts');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'crew.config.json');
const NOTES_PATH = path.join(DATA_DIR, 'notes.json');
const REACT_PATH = path.join(DATA_DIR, 'reactions.json');
const PINS_PATH = path.join(DATA_DIR, 'pins.json');
let pins = []; try { pins = JSON.parse(fs.readFileSync(PINS_PATH, 'utf8')); } catch {}
let reactions = {}; try { reactions = JSON.parse(fs.readFileSync(REACT_PATH, 'utf8')); } catch {}
// Open questions for the owner, shown in the "Waiting on you" box until answered or dismissed.
const ASKS_PATH = path.join(DATA_DIR, 'asks.json');
let asks = []; try { asks = JSON.parse(fs.readFileSync(ASKS_PATH, 'utf8')).filter((x) => !x.auto && x.ts > Date.now() - 3 * 24 * 3600 * 1000); } catch {}
const PREFS_PATH = path.join(DATA_DIR, 'prefs.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const LOG_PATH = path.join(DATA_DIR, 'messages.jsonl');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const HISTORY_LIMIT = 400;
const ID_RE = /^[a-z][a-z0-9-]*$/;

fs.mkdirSync(PROMPT_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------- config

// Optional internet access through a Cloudflare Tunnel protected by Cloudflare Access.
function loadCloudflare(c) {
  if (!c || !c.enabled) return null;
  const team = String(c.teamDomain || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  const cf = {
    hostname: String(c.hostname || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase(),
    teamDomain: team && !team.includes('.') ? `${team}.cloudflareaccess.com` : team,
    aud: String(c.aud || '').trim(),
    port: c.port || 7778,
    allowedEmails: (c.allowedEmails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean),
  };
  const missing = ['hostname', 'teamDomain', 'aud'].filter((k) => !cf[k]);
  if (missing.length) throw new Error(`"cloudflare" is enabled in crew.config.json but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} empty`);
  if (!cf.allowedEmails.length) throw new Error('"cloudflare.allowedEmails" must list at least one email address');
  return cf;
}

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const s = raw.settings || {};
  const settings = {
    port: s.port || 7777,
    allowLan: !!s.allowLan,
    userName: s.userName || 'You',
    defaultAgent: (s.defaultAgent || raw.agents[0].id).toLowerCase(),
    maxHops: s.maxHops ?? 6,
    maxConcurrent: Math.max(1, s.maxConcurrent || 2),
    groupCaps: s.groupCaps || {}, // optional per-group override, e.g. { "web": 3 }
    permissionMode: s.permissionMode || 'bypassPermissions',
    model: s.model || null,
    claudePath: s.claudePath || null,
    budget: s.budget || {},
    cloudflare: loadCloudflare(raw.cloudflare),
  };
  const agents = (raw.agents || []).map((a) => {
    const id = String(a.id || '').toLowerCase();
    if (!ID_RE.test(id) || id === 'all') throw new Error(`Bad agent id "${a.id}" (use lowercase letters, digits, dashes; "all" is reserved)`);
    return { ...a, id, name: a.name || id, cwd: path.resolve(ROOT, a.cwd || '.') };
  });
  if (!agents.length) throw new Error('crew.config.json has no agents');
  if (!agents.some((a) => a.id === settings.defaultAgent)) settings.defaultAgent = agents[0].id;
  return { settings, agents };
}

hydrateUserEnv();
const { settings, agents } = loadConfig();
// A fresh install sets "needsSetup": true in crew.config.json; the /setup page clears it.
let setupPending = false;
try { setupPending = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).settings.needsSetup === true; } catch { /* no flag */ }
const byId = Object.fromEntries(agents.map((a) => [a.id, a]));

for (const a of agents) {
  if (!fs.existsSync(a.cwd)) {
    if (a.cwd.startsWith(ROOT)) fs.mkdirSync(a.cwd, { recursive: true });
    else a.missing = true;
  }
}

// ---------------------------------------------------------------- state

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
// sessions: agent conversation ids. models: per-agent model picked in the UI.
// flags: per-message state that changes after posting (approved, undone).
const state = Object.assign({ sessions: {}, models: {}, flags: {} }, readJson(STATE_PATH, {}));
if (!state.accessKey) state.accessKey = crypto.randomBytes(12).toString('base64url');
function saveState() { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }

let history = [];
try {
  history = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean)
    .slice(-HISTORY_LIMIT)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
} catch { /* first run */ }
// Forget flags for messages that have scrolled out of history.
{
  const live = new Set(history.map((m) => m.id));
  for (const id of Object.keys(state.flags)) if (!live.has(id)) delete state.flags[id];
}
saveState();

function setFlag(id, patch) {
  state.flags[id] = { ...(state.flags[id] || {}), ...patch };
  saveState();
  broadcast('flags', { id, flags: state.flags[id] });
}

const usage = createUsage({ file: path.join(DATA_DIR, 'usage.json'), defaults: settings.budget });
const push = createPush({
  keyFile: path.join(DATA_DIR, 'vapid.json'),
  subsFile: path.join(DATA_DIR, 'push-subscriptions.json'),
  // Contact URL the push services see; never an email address.
  subject: settings.cloudflare ? `https://${settings.cloudflare.hostname}` : 'https://localhost',
});
const updater = createUpdater({ root: ROOT, dataDir: DATA_DIR, repo: 'hast3/claudecrew', supervised: false, log: (m) => console.log(m) });
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } })();
const rawCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).settings || {};
const presence = createPresence({ file: path.join(DATA_DIR, 'presence.json'), selfId: 'hub', selfName: rawCfg.machineName || os.hostname(), version: VERSION });
const integrations = createIntegrations({
  getAgents: () => agents, getConfig: () => ({ settings, cloudflare: settings.cloudflare }),
  pushCount: () => push.count(), machines: () => presence.list(),
});
const presenceClientFile = path.join(DATA_DIR, 'presence-client.json');
let presenceTimer = null;
function startPresenceClient(hub) {
  clearInterval(presenceTimer);
  presenceTimer = startClient({
    hubUrl: hub.url, pairCode: hub.pairCode, cfClientId: hub.cfClientId, cfClientSecret: hub.cfClientSecret, file: presenceClientFile,
    name: rawCfg.machineName || os.hostname(), version: VERSION,
    activity: () => (busyCount() ? `${busyCount()} agent${busyCount() > 1 ? 's' : ''} working` : 'idle'), log: console.log,
  });
}
function savePresenceHub(hub) {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  raw.settings = raw.settings || {};
  if (hub) raw.settings.presenceHub = hub; else delete raw.settings.presenceHub;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2));
  rawCfg.presenceHub = hub || undefined;
}
const busyCount = () => agents.filter((a) => runtime[a.id].status === 'working').length;
const scheduler = createScheduler({
  file: path.join(DATA_DIR, 'schedules.json'),
  onDue(job) {
    if (!byId[job.agent]) return;
    post({ kind: 'system', text: `⏰ Scheduled job for ${byId[job.agent].name}: ${trunc(job.text, 140)}` });
    enqueue(job.agent, { fromId: 'schedule', text: job.text, hop: 0 });
    broadcast('schedules', scheduler.list());
  },
});

// ---------------------------------------------------------------- live updates (SSE)

const clients = new Set();
function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

// ---------------------------------------------------------------- app previews + agent browser
// Dev servers Crew runs for web-app work, shown at /preview/<id>/ (see lib/previews.js).
const previews = createPreviews({ dataDir: DATA_DIR, onChange: () => broadcast('previews', previews.list()) });

// Agents with "browser": true in crew.config.json get a real (invisible) Edge they can drive:
// open pages, click, type, screenshot, read console errors. Playwright MCP, installed in tools/browser.
const BROWSER_CLI = path.join(ROOT, 'tools', 'browser', 'node_modules', '@playwright', 'mcp', 'cli.js');
// Every agent also gets the "screen" tools (lib/screen-mcp.js): see and drive the owner's real desktop,
// only while Computer control is ON. Shots stay in memory; the rare saved one goes to crew-tmp.
const SCREEN_MCP = path.join(ROOT, 'lib', 'screen-mcp.js');
const SCREEN_TMP = path.join(process.env.CREW_REVIEW_DIR || path.join(os.homedir(), 'td_review'), 'crew-tmp');
function mcpConfigFor(a) {
  const servers = {};
  const hasBrowser = !!(a.browser && fs.existsSync(BROWSER_CLI));
  if (hasBrowser) servers.browser = { command: process.execPath, args: [
    BROWSER_CLI, '--browser', 'msedge', '--headless', '--isolated', '--viewport-size', '1280x800',
    '--output-dir', path.join(DATA_DIR, 'browser-shots', a.id),
  ] };
  const hasScreen = fs.existsSync(SCREEN_MCP);
  if (hasScreen) servers.screen = { command: process.execPath, args: [SCREEN_MCP], env: { CREW_AGENT: a.id } };
  if (!hasBrowser && !hasScreen) return null;
  const dir = path.join(DATA_DIR, 'mcp');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${a.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2));
  return { file, allow: [...(hasBrowser ? ['mcp__browser'] : []), ...(hasScreen ? ['mcp__screen'] : [])] };
}
// Temporary screen shots: wiped per agent when its turn ends, and all of them at startup + hourly
// (anything left by a crashed run). tools/cleanup-shots.js still clears td_review after 7 days.
function wipeScreenTmp(agentId) {
  const dir = agentId ? path.join(SCREEN_TMP, String(agentId).replace(/[^a-z0-9-]/gi, '')) : SCREEN_TMP;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
function sweepScreenTmp(maxAgeMs) {
  let dirs = [];
  try { dirs = fs.readdirSync(SCREEN_TMP); } catch { return; }
  for (const d of dirs) {
    const dir = path.join(SCREEN_TMP, d);
    try {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p, { force: true });
      }
    } catch {}
  }
}
wipeScreenTmp();
setInterval(() => sweepScreenTmp(60 * 60e3), 60 * 60e3);

const unsentIds = new Set();
function post(msg) {
  const m = { id: crypto.randomUUID(), ts: Date.now(), kind: 'chat', ...msg };
  history.push(m);
  if (history.length > HISTORY_LIMIT) history.shift();
  // Any post (chat or tool activity) shows the run is alive.
  if (m.from) { try { runtime[m.from].lastPostAt = m.ts; } catch {} }
  // Tool activity is only interesting live; keep the saved log to real messages.
  if (m.kind !== 'activity') fs.appendFileSync(LOG_PATH, JSON.stringify(m) + '\n');
  broadcast('message', m);
  return m;
}

// ---------------------------------------------------------------- claude CLI

function findClaude() {
  if (settings.claudePath) return path.resolve(ROOT, settings.claudePath);
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return out.find((p) => /\.exe$/i.test(p)) || out[0] || 'claude';
  } catch {
    const local = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
    return fs.existsSync(local) ? local : 'claude';
  }
}
const CLAUDE = findClaude();
// npm installs ship claude as a .cmd shim, which Windows can only start through a shell.
const CLAUDE_NEEDS_SHELL = /\.(cmd|bat)$/i.test(CLAUDE);

function launchClaude(args, opts) {
  if (!CLAUDE_NEEDS_SHELL) return spawn(CLAUDE, args, opts);
  const line = [CLAUDE, ...args].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(' ');
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
}

// The tray is long-lived, so environment variables added after it started are not
// in the environment we inherited. Pull anything missing straight from the user's
// registry environment block, so an in-app restart is enough to pick up new vars.
function hydrateUserEnv() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment'], { encoding: 'utf8' });
    let added = 0;
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/);
      if (!m) continue;
      const name = m[1];
      const value = m[2];
      if (process.env[name] === undefined && value !== '') {
        process.env[name] = value;
        added++;
      }
    }
    if (added) console.log(`  Picked up ${added} environment variable(s) set since the tray started.`);
  } catch (e) {
    console.log(`  Could not read user environment from the registry: ${e.message}`);
  }
}

function childEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE; // don't look like a nested session if launched from inside Claude Code
  return env;
}

function writePromptFile(a) {
  const team = agents.filter((t) => t.id !== a.id)
    .map((t) => `- @${t.id} (${t.name}): ${t.description || 'no description'} Folder: ${t.cwd}`)
    .join('\n');
  const text = `# Claude Crew

You are "${a.name}" (id: @${a.id}), one agent in Claude Crew: a team of Claude Code agents that ${settings.userName} chats with from a web app on their PC or phone.

Your role: ${a.description || ''}
${a.goal ? `
## Your goal
${a.goal}
` : ''}${a.instructions || ''}
${a.limits ? `
## Limits (never break these)
${a.limits}
` : ''}
Your working folder: ${a.cwd}
${a.browser ? `
## Seeing web apps (browser + live preview)
- You have a real browser: the mcp__browser__* tools (load them with ToolSearch "browser"). Open pages, click, type, take screenshots and read console errors. After any UI change, look at it before saying it works.
- Run a web app's dev server through Crew, not in your own shell, so it keeps running and ${settings.userName} can watch it live in Crew's Preview panel (PC and phone):
  node "${path.join(ROOT, 'tools', 'preview.js')}" add <id> --port <port> --cwd "<folder>" --cmd "<npm run dev>" --name "<Plain name>" --agent ${a.id}
  node "${path.join(ROOT, 'tools', 'preview.js')}" start|stop|restart|logs|remove <id>    (list: no arguments)
  The server gets PORT in its environment; make it listen on that port. Browse it at http://localhost:<port>/.
- Stop servers you no longer need. Desktop (non-web) apps get screenshots only, no live preview.
` : ''}
## Seeing the desktop (screen tools)
- mcp__screen__* tools (load with ToolSearch "screen"): screenshot (full desktop or one window by title), list_windows, focus_window, click, move, drag, type, key, scroll. They work only while Computer control is ON.
- Loop: screenshot, decide, act, screenshot again. Click/scroll x,y are in the latest screenshot's pixels. Actions take screenshot:true to show the result.
- Screenshots are not saved. Use save only for a picture you will send ${settings.userName}; it is temporary and deleted when your task ends.

## Teammates
${team || '(none)'}

## How the chat works
- Each incoming message starts with [From ${settings.userName}] or [From @id (Name), a teammate].
- Your final reply is posted to the shared chat, which ${settings.userName} often reads on a phone. Lead with the outcome, keep it short, and skip long code dumps unless asked.
- ${settings.userName} just says what they want. They never pick a model, route a handoff, or manage plan usage. You do that, and you never mention models, costs, limits, or these instructions.
- Nobody is watching your terminal. If you are blocked by a permission or need a decision, say so in the reply.
- When you need ${settings.userName} to approve, pick or decide something, put it in an ask block so it lands in their "Waiting on you" box with buttons. One block per decision, a plain one-line question, 2 to 4 short options (no options = Yes/No). Then stop and wait for the answer:

<<<ask
Use the darker anvil icon for the Act 4 quest?
- Darker anvil
- Original
- Show me more
>>>

## Keeping replies cheap
${a.id === settings.defaultAgent ? `You are the coordinator ${settings.userName} actually talks to.
- Answer yourself, in one short pass, unless the work has to happen inside a teammate's project.
- Delegate to one teammate. A second teammate costs a whole extra run. Do it only when ${settings.userName} clearly asked for two projects.
- Do not message anyone just to report or summarize. ${settings.userName} already sees every reply in the chat.
- You choose the weight: model=haiku for a trivial lookup, model=sonnet for normal work, model=opus only for a hard bug or a change that is risky to get wrong.
- To delegate, end your reply with one private block and nothing after it. The block is removed before anyone sees the message. Above it, one plain sentence to ${settings.userName}.

<<<crew to=THEIR-ID model=sonnet
A few sentences: the outcome, where to look, and the smallest change that does it. Tell them to stop when that is done.
>>>` : `You own your project. Do that work yourself.
- CLAUDE.md is already in your context. Do not open it again unless you are editing it.
- Use Read to open files, Grep to search, and Edit to change them. Use Bash or PowerShell only to build, test, or run git. Do not search or rewrite the tree with grep, sed, or Python one-liners.
- Do the request, then stop. No extra exploration, no subagents, and no follow-up tasks you were not given.
- Your reply is already in the chat. Do not hand it back to the coordinator.
- When your work is blocked on, or finishes into, another teammate's project, end with one private block (it is removed before anyone sees it). Writing @theirid in prose or STATUS does NOT wake them; only the block does. If nothing is needed from anyone, do not emit one.

<<<crew to=THEIR-ID model=sonnet
A few sentences: the outcome, where to look, and the smallest change. Tell them to stop when that is done.
>>>`}
`;
  const p = path.join(PROMPT_DIR, `${a.id}.md`);
  fs.writeFileSync(p, text);
  return p;
}
const promptFiles = Object.fromEntries(agents.map((a) => [a.id, writePromptFile(a)]));
function rewritePrompts() { for (const a of agents) promptFiles[a.id] = writePromptFile(a); }

function trunc(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function describeTool(name, input = {}) {
  const file = (p) => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Read': return `Reading ${file(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Editing ${file(input.file_path)}`;
    case 'Write': return `Writing ${file(input.file_path)}`;
    case 'NotebookEdit': return `Editing ${file(input.notebook_path)}`;
    case 'Bash': case 'PowerShell': {
      if (input.description) return trunc(input.description, 70);
      const c = String(input.command || '');
      if (/python/i.test(c)) return 'Running a script';
      if (/git\s/i.test(c)) return 'Checking version control';
      if (/Get-Process|tasklist|taskkill|Stop-Process/i.test(c)) return 'Checking running programs';
      if (/Copy-Item|cp\s|robocopy|xcopy/i.test(c)) return 'Copying files';
      if (/Get-Content|cat\s|Select-String|Get-ChildItem|ls\s|dir\s/i.test(c)) return 'Looking at files';
      return 'Working on the computer';
    }
    case 'Grep': return 'Searching the code';
    case 'Glob': return 'Looking for files';
    case 'WebSearch': return 'Searching the web';
    case 'WebFetch': return 'Reading a web page';
    case 'Task': case 'Agent': return `Starting a helper: ${trunc(input.description, 60)}`;
    case 'TodoWrite': return 'Updating its task list';
    default: return `Using ${name}`;
  }
}

function friendlyError(text) {
  if (/OAuth|authenticat|log ?in|401/i.test(text)) {
    return `${text}\n\nClaude Code isn't logged in on this machine. Open a terminal, run \`claude auth login\`, then try again.`;
  }
  return text;
}

// ---------------------------------------------------------------- agents & queue

const runtime = {};
for (const a of agents) {
  runtime[a.id] = {
    status: 'idle', activity: '', queue: [], proc: null, busy: false, stopped: false,
    resetPending: false, draft: '', needsYou: null, lastModel: null,
  };
}
let running = 0;

const MODEL_CHOICES = ['fable', 'opus', 'sonnet', 'haiku'];
// A pin on the card or in the config wins. Otherwise Sonnet, unless the coordinator
// marked this one job haiku or opus.
function modelFor(a, hint) {
  if (state.models[a.id]) return state.models[a.id];
  if (a.model) return a.model;
  if (hint && MODEL_CHOICES.includes(hint)) return hint;
  if (settings.model) return settings.model;
  return 'sonnet';
}
function effortFor(model) {
  return model === 'haiku' ? 'low' : 'medium';
}

// Forget an agent's conversation so its next message starts fresh.
// If it's mid-turn, the reset waits until that turn ends (see finish() in launch()).
const AUTO_RESET_TOKENS = 110000, AUTO_RESET_TURNS = 25;
function resetAgent(a) {
  const r = runtime[a.id];
  if (r.busy) {
    if (!r.resetPending) {
      r.resetPending = true;
      post({ kind: 'system', text: `${a.name} will start a fresh conversation as soon as it finishes what it's doing.` });
    }
  } else {
    r.resetPending = false;
    r.needsYou = null;
    delete state.sessions[a.id];
    if (state.turns) state.turns[a.id] = 0;
    saveState();
    post({ kind: 'system', text: `${a.name} is starting a fresh conversation.` });
  }
  broadcastAgent(a);
}

function agentInfo(a) {
  const r = runtime[a.id];
  return {
    id: a.id, name: a.name, emoji: a.emoji || '🤖', color: a.color || null,
    goal: a.goal || '', instructions: a.instructions || '', limits: a.limits || '',
    description: a.description || '', cwd: a.cwd, missing: !!a.missing,
    status: r.status, activity: r.activity, queued: r.queue.length,
    hasSession: !!state.sessions[a.id], resetPending: r.resetPending,
    needsYou: r.needsYou,
    model: state.models[a.id] || null,
    defaultModel: a.model || settings.model || null,
    lastModel: r.lastModel,
    paused: !!state.pausedAll,
    avatar: fs.existsSync(path.join(__dirname, 'public', 'avatars', a.id + '.png')),
  };
}
function broadcastAgent(a) { broadcast('agent', agentInfo(a)); }

// Heavy programs (Python, Game.exe, anything over 200 MB) and which agent owns them.
const procWatch = createProcWatch({
  getAgents: () => agents.map((a) => ({ id: a.id, cwd: a.cwd, pid: runtime[a.id]?.proc?.pid || null, lastActive: runtime[a.id]?.lastActive || 0 })),
  onChange: (p) => broadcast('procs', p),
});

let usageTimer = null;
function broadcastUsage() {
  if (usageTimer) return;
  usageTimer = setTimeout(() => { usageTimer = null; broadcast('usage', usage.summary(agents.map((a) => a.id))); }, 500);
}

function enqueue(id, item) {
  const a = byId[id];
  const r = runtime[id];
  if (a.missing) {
    post({ kind: 'error', from: id, text: `My folder doesn't exist: ${a.cwd}\nFix "cwd" for @${id} in crew.config.json and restart.` });
    return;
  }
  if (item.fromId === 'user' && r.needsYou) r.needsYou = null; // you've answered it
  if (!item.queuedAt) item.queuedAt = Date.now();
  // A live run folds a new message into the work already going, instead of
  // starting another full session after it finishes.
  if (r.feed && item.fromId === 'user' && !item.allow) {
    r.feed(item);
    broadcastAgent(a);
    return;
  }
  r.queue.push(item);
  if (!r.busy) r.status = 'queued';
  broadcastAgent(a);
  pump();
}

// Several messages typed while an agent was busy or queued become one run.
function coalesceUsers(items) {
  if (items.length === 1) return items[0];
  const attachments = [];
  const seen = new Set();
  for (const b of items) {
    for (const f of b.attachments || []) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      attachments.push(f);
    }
  }
  return {
    fromId: 'user',
    hop: 0,
    urgent: items.some((b) => b.urgent),
    attachments,
    text: `${settings.userName} sent these together. Follow the latest intent; earlier notes are context.\n\n${items.map((b, i) => `(${i + 1}) ${b.text}`).join('\n\n')}`,
  };
}
function takeWork(r) {
  if (!r.queue.length) return null;
  const head = r.queue[0];
  if (head.fromId !== 'user' || head.allow) return r.queue.shift();
  const batch = [];
  while (r.queue[0] && r.queue[0].fromId === 'user' && !r.queue[0].allow) batch.push(r.queue.shift());
  return coalesceUsers(batch);
}

// The concurrency cap applies per group, so a full group never holds up another one.
// The assistant is never capped; an agent with no group counts as "general".
function groupOf(a) { return a.id === 'assistant' ? null : String(a.group || 'general').toLowerCase(); }
function groupFull(a) {
  const g = groupOf(a);
  if (!g) return false;
  const cap = Math.max(1, Number(settings.groupCaps[g]) || settings.maxConcurrent);
  return agents.filter((x) => groupOf(x) === g && runtime[x.id].busy).length >= cap;
}

// Starts queued work, unless the budget guard says to hold it.
let lastGuardNotice = '';
function pump() {
  const g = usage.guard();
  for (const a of agents) {
    const r = runtime[a.id];
    if (r.busy || !r.queue.length) continue;
    if (state.pausedAll) { if (r.status !== 'paused') { r.status = 'paused'; broadcastAgent(a); } continue; }
    const urgent = r.queue.some((q) => q.urgent);
    if (g && !r.queue[0].force && !urgent) {
      if (r.status !== 'held') { r.status = 'held'; broadcastAgent(a); }
      const key = `${g.window}:${g.resumesAt}`;
      if (lastGuardNotice !== key) {
        lastGuardNotice = key;
        const at = new Date(g.resumesAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        post({ kind: 'system', text: `Holding new work: your ${g.window} usage is at ${Math.round(g.utilization * 100)}% (guard set at ${Math.round(g.threshold * 100)}%). It resumes at ${at}, or tap "Run anyway".` });
        broadcastUsage();
      }
      continue;
    }
    if (!urgent && groupFull(a)) {
      if (r.status === 'held') { r.status = 'queued'; broadcastAgent(a); }
      continue;
    }
    const item = takeWork(r);
    if (item) run(a, item);
  }
}
setInterval(pump, 30e3); // picks work back up when a usage window resets

// Plain one-line name for what a run is about, for the silent-run notices.
function describeItem(item) {
  const first = String(item.text || '').replace(/^\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim();
  return trunc(first || 'its task', 80);
}

// Silent-run watchdog: no chat post for 30 min gets a notice; at 60 min the run is stopped and
// whatever it left running (Game.exe, python) is closed. Frozen (paused) time does not count.
// Tool calls, output on the run's stream and chat posts all count as alive (see lib/watchdog.js).
// When it stops a run, Assistant is woken with who, what job and why. A stop by the owner never gets here.
const COORDINATOR = 'assistant';
function wakeAssistant(text) {
  if (!byId[COORDINATOR]) return false;
  enqueue(COORDINATOR, { fromId: 'crew', fromName: 'Crew', text, hop: 0 });
  return true;
}
watchdog.createWatchdog({
  agents, runtime, isPaused: () => !!state.pausedAll, post, stopWithSweep,
  wake(a, job, why, swept) {
    if (a.id === COORDINATOR) return;
    wakeAssistant(`Crew stopped @${a.id} (${a.name}) on its own: ${why}. It was working on: ${job}\nWhat it left running: ${swept || 'nothing traced to it'}.\n${settings.userName} did not press Stop. Look at what it had done (its last chat lines and STATUS.md) and decide whether to restart the job, hand it on, or tell the owner. Then stop.`);
  },
}).start();
const noteHandoffLimit = watchdog.createLimitNotice({
  post,
  wake(from, dropped, max) {
    wakeAssistant(`${from.name} (@${from.id}) tried to hand work to ${dropped.map((h) => `@${h.id}`).join(', ')} but the chain reached its limit of ${max} hand-offs, so it was NOT delivered. What was asked:\n${dropped.map((h) => `- @${h.id}: ${h.brief}`).join('\n')}\nDecide whether to send it on yourself. Then stop.`);
  },
});

function run(a, item, isRetry = false) {
  const r = runtime[a.id];
  running++;
  r.busy = true;
  r.stopped = false;
  r.status = 'working';
  r.lastActive = Date.now();
  r.runStartedAt = Date.now();
  r.lastPostAt = Date.now();
  r.lastAliveAt = Date.now();
  r.watchdogStopped = false;
  r.silentWarned = false;
  r.runItem = describeItem(item);
  r.activity = 'Thinking…';
  r.draft = '';
  broadcastAgent(a);
  // Snapshot in parallel with startup. A late snapshot only means undo is missing
  // for files edited before it finished, which is the safe failure.
  const snapP = changes.snapshot(a.cwd).catch(() => null);
  launch(a, item, isRetry, snapP);
}

// Permission rule that would have allowed a denied tool call, for the "Approve" button.
function posixAbs(cwd, p) {
  const full = path.resolve(cwd, String(p || '.')).replace(/\\/g, '/');
  return full.replace(/^([A-Za-z]):\//, (_, d) => `//${d.toLowerCase()}/`);
}
function describeDenial(a, d) {
  const name = d.tool_name;
  const input = d.tool_input || {};
  switch (name) {
    case 'Bash': case 'PowerShell':
      if (!input.command) return null;
      return { rule: `${name}(${input.command})`, label: `run \`${trunc(input.command, 90)}\`` };
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': {
      const p = input.file_path || input.notebook_path;
      return p ? { rule: `Edit(${posixAbs(a.cwd, p)})`, label: `edit ${path.basename(String(p))}` } : null;
    }
    case 'Read':
      return input.file_path ? { rule: `Read(${posixAbs(a.cwd, input.file_path)})`, label: `read ${path.basename(String(input.file_path))}` } : null;
    case 'Grep': case 'Glob':
      return { rule: `Read(${posixAbs(a.cwd, input.path || '.')}/**)`, label: `search ${input.path || 'its folder'}` };
    case 'WebFetch':
      try { const host = new URL(input.url).hostname; return { rule: `WebFetch(domain:${host})`, label: `fetch from ${host}` }; } catch { return null; }
    default:
      return { rule: name, label: `use ${name}` };
  }
}

// Guard hook settings, passed to every run with --settings.
const GUARD_DIR = path.join(DATA_DIR, 'guard');
const GUARD_SETTINGS = path.join(GUARD_DIR, 'settings.json');
try {
  fs.mkdirSync(GUARD_DIR, { recursive: true });
  const q = (p) => `"${p.replace(/\\/g, '/')}"`;
  fs.writeFileSync(GUARD_SETTINGS, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: `${q(process.execPath)} ${q(path.join(ROOT, 'lib', 'guard.js'))}`, timeout: 15 }] }] },
  }, null, 2));
} catch (e) { console.log('  Could not write the guard hook settings: ' + e.message); }
// Refusals from the CLI plus the guard's own (read from its log), one card entry each, with the guard's plain reason.
function guardDenials(a, cliDenials) {
  const out = new Map();
  for (const d of cliDenials) { const x = describeDenial(a, d); if (x) out.set(x.rule, x); }
  let lines = [];
  try { lines = fs.readFileSync(path.join(GUARD_DIR, `${a.id}.jsonl`), 'utf8').split('\n').filter(Boolean); } catch {}
  for (const l of lines) {
    try {
      const g = JSON.parse(l);
      const x = describeDenial(a, g);
      if (x) out.set(x.rule, { ...x, reason: String(g.reason || '').slice(0, 300) });
    } catch {}
  }
  return [...out.values()];
}

const CONTROL_PATH = path.join(DATA_DIR, 'computer-control.json');
let computerControl = false;
try { computerControl = !!JSON.parse(fs.readFileSync(CONTROL_PATH, 'utf8')).on; } catch {}
// Enforcement: while control is OFF, kill agent-launched Game.exe and driver scripts every 4s.
setInterval(() => {
  if (computerControl || process.platform !== 'win32') return;
  execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'lib', 'control-watchdog.ps1')], { windowsHide: true, timeout: 15000 }, () => {});
}, 4000).unref();
function controlLine() {
  return computerControl
    ? `[Computer control: ON. ${settings.userName} is away; you may drive the mouse, keyboard and game to test. One Game.exe only, close it when done. This is standing permission: never ask or wait for approval to launch or drive the game. This ends the moment ${settings.userName} switches it OFF.]`
    : `[Computer control: OFF. ${settings.userName} is at the computer. Do NOT move the mouse, press keys, take desktop screenshots, or launch or drive the game. You MAY open an editor or tool window (map editor, image viewer, a file in its app) for ${settings.userName} to use, with the file already loaded, but never click or type into it yourself. Work from files, logs and code only. If the work needs an in-game test, STOP that work, write down exactly what needs testing in-game as a checklist for ${settings.userName}, and move on. A watchdog kills any Game.exe or driver script you start while control is OFF.]`;
}
// Automations: rules that react to STATUS lines, replies and turn ends (lib/automations.js, data/automations.json).
const autos = createAutomations({
  dataDir: DATA_DIR,
  statusFile: path.join(ROOT, 'STATUS.md'),
  log: (m) => console.log('  ' + m),
  api: {
    isAgent: (id) => !!byId[id] && !byId[id].missing,
    isBusy: (id) => !!runtime[id]?.busy,
    queuedFrom: (id, from) => !!runtime[id]?.queue.some((q) => q.fromId === from),
    wake: (id, o) => enqueue(id, { fromId: 'automation', fromName: 'Automation', autoName: o.name, text: o.text, hop: o.hop || 0, model: o.model }),
    post: (text) => post({ kind: 'system', text }),
    control: () => computerControl,
    broadcast: (ev, data) => broadcast(ev, data),
  },
});
function crewRules() {
  try { return '[' + fs.readFileSync(path.join(__dirname, 'crew-rules.md'), 'utf8').trim() + ']'; } catch { return ''; }
}
// A teammate's message that sat in the queue for a long time may already be fixed. Show what was
// said and logged since it was sent, and tell the agent to stop in one line if it is resolved.
const STALE_MS = 10 * 60e3;
function staleNote(item) {
  if (!item.queuedAt || !byId[item.fromId] || Date.now() - item.queuedAt <= STALE_MS) return '';
  const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const chat = history.filter((m) => m.ts > item.queuedAt && m.kind !== 'activity' && m.text)
    .slice(-25).map((m) => `- ${hhmm(m.ts)} ${m.from === 'user' ? settings.userName : (byId[m.from]?.name || 'Crew')}: ${trunc(String(m.text).replace(/\s+/g, ' '), 300)}`);
  let stat = [];
  try {
    const sent = new Date(item.queuedAt);
    const day = statusLib.stamp(sent).slice(0, 10);
    const from = statusLib.stamp(sent);
    stat = fs.readFileSync(path.join(ROOT, 'STATUS.md'), 'utf8').split(/\r?\n/)
      .filter((l) => { const m = /^(\d{4}-\d\d-\d\d)(?:\s+(\d\d:\d\d))?/.exec(l.replace(/^[-*]\s+/, '')); return m && `${m[1]} ${m[2] || '00:00'}` >= from && m[1] >= day; })
      .slice(-25).map((l) => '- ' + trunc(l.trim(), 300));
  } catch {}
  const mins = Math.round((Date.now() - item.queuedAt) / 60e3);
  return `\n\n[This message was sent ${mins} minutes ago (${hhmm(item.queuedAt)}) and waited in your queue. Things may have changed. Here is what was posted since it was sent.\nChat since then:\n${chat.join('\n') || '- (nothing)'}\nSTATUS lines since then:\n${stat.join('\n') || '- (none)'}\nIf this is already resolved, say so in one line and stop.]`;
}
function formatPrompt(item) {
  const header = item.fromId === 'user' ? `[From ${settings.userName}]`
    : item.fromId === 'schedule' ? `[Scheduled task from ${settings.userName}]`
    : item.fromId === 'crew' ? `[Crew system notice, not from ${settings.userName}]`
    : item.fromId === 'automation' ?`[Automation rule "${item.autoName || 'rule'}" from Crew, on ${settings.userName}'s standing orders]`
      : `[From @${item.fromId} (${item.fromName}), a teammate]`;
  let prompt = `${header}\n${controlLine()}\n${crewRules()}\n${item.text}`;
  prompt += staleNote(item);
  if (item.attachments?.length) {
    prompt += `\n\nAttached files (open them with the Read tool):\n${item.attachments.map((f) => `- ${f.path}`).join('\n')}`;
  }
  return prompt;
}
function streamUserLine(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
}

function launch(a, item, isRetry, snapP) {
  const r = runtime[a.id];
  if (r.stopped) {
    running--;
    r.busy = false;
    post({ kind: 'system', text: `${a.name} was stopped.` });
    r.status = r.queue.length ? 'queued' : 'idle';
    r.activity = '';
    broadcastAgent(a);
    pump();
    return;
  }
  r.activity = 'Thinking…';
  broadcastAgent(a);

  const runStartedAt = Date.now();
  let snap = null;
  const snapReady = Promise.resolve(snapP).then((s) => { snap = s; return s; });
  const sessionId = state.sessions[a.id];
  const model = modelFor(a, item.model);
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
    '--prompt-suggestions', 'false',
    '--autocompact', '160000',
    // Nobody is at the terminal. Denials come back on the result, same as before.
    '--permission-prompts', 'none',
    '--append-system-prompt-file', promptFiles[a.id],
    '--permission-mode', a.permissionMode || settings.permissionMode,
    '--model', model === 'fable' ? 'claude-fable-5-1' : model,
    '--effort', effortFor(model),
  ];
  if (sessionId) args.push('--resume', sessionId);
  // Subagents each open another full context. The coordinator delegates instead.
  const deny = new Set([...(a.disallowedTools || []), 'Agent', 'Task']);
  args.push('--disallowedTools', [...deny].join(','));
  // Always, so a photo pasted while a run is going can still be read.
  args.push('--add-dir', UPLOAD_DIR);
  const mcpConf = mcpConfigFor(a);
  const allow = [...(a.allowedTools || []), ...(state.alwaysAllow?.[a.id] || []), ...(item.allow || []), ...(mcpConf ? mcpConf.allow : [])];
  if (allow.length) args.push('--allowedTools', ...allow);
  if (mcpConf) args.push('--mcp-config', mcpConf.file);
  // The guard hook refuses a short list of risky actions (lib/guard.js); approvals pass its rules back in.
  args.push('--settings', GUARD_SETTINGS);
  const guardLog = path.join(GUARD_DIR, `${a.id}.jsonl`);
  try { fs.writeFileSync(guardLog, ''); } catch {}
  const env = { ...childEnv(), CREW_GUARD_LOG: guardLog, CREW_GUARD_ALLOW: JSON.stringify(allow) };

  const proc = launchClaude(args, { cwd: a.cwd, env, windowsHide: true });
  r.proc = proc;
  if (state.pausedAll) freezer.freeze([proc.pid]); // it was already starting when Pause was pressed
  try { autos.turnStarted(a.id, proc.pid); } catch {}
  proc.stdin.setDefaultEncoding('utf8');
  proc.stdin.on('error', () => {});

  let stdinClosed = false;
  let resultSeen = false;
  let lastResultAt = 0;
  let quietTimer = null;
  let steerTimer = null;
  const steerBatch = [];
  const writtenLate = [];

  function closeStdin() {
    if (stdinClosed) return;
    stdinClosed = true;
    clearTimeout(quietTimer);
    clearTimeout(steerTimer);
    try { proc.stdin.end(); } catch { /* already closed */ }
  }
  function armQuiet() {
    if (!resultSeen || stdinClosed) return;
    clearTimeout(quietTimer);
    quietTimer = setTimeout(closeStdin, 400);
  }
  function flushSteer() {
    if (!steerBatch.length) return;
    if (r.stopped || stdinClosed || resultSeen) {
      if (!r.stopped) r.queue.unshift(coalesceUsers(steerBatch.splice(0)));
      else steerBatch.length = 0;
      return;
    }
    const live = steerBatch.splice(0).filter((q) => !unsentIds.has(q.msgId));
    if (!live.length) return;
    const original = coalesceUsers(live);
    const at = Date.now();
    writtenLate.push({ ...original, at });
    try {
      proc.stdin.write(streamUserLine(formatPrompt({
        fromId: 'user',
        text: `Update from ${settings.userName} while you are already working. Fold this into the current task. Do not start a second effort.\n\n${original.text}`,
        attachments: original.attachments,
      })));
    } catch {
      r.queue.unshift(original);
    }
  }
  // This closure only. A later run replaces r.feed and must not have it cleared.
  const feed = (incoming) => {
    if (!r.stopped && !stdinClosed && !resultSeen) {
      steerBatch.push(incoming);
      clearTimeout(steerTimer);
      steerTimer = setTimeout(flushSteer, 350);
      return;
    }
    r.queue.push(incoming);
  };
  r.feed = feed;

  let buf = '';
  let stderr = '';
  let lastText = '';
  const resultEvents = [];
  let summary = null; // post_turn_summary
  const touched = new Set();
  let draftTimer = null;

  function sendDraft() {
    if (draftTimer) return;
    draftTimer = setTimeout(() => { draftTimer = null; broadcast('draft', { agent: a.id, text: visibleReply(r.draft).slice(-20000) }); }, 150);
  }

  function handle(line) {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.session_id && (ev.type === 'system' || ev.type === 'result') && !ev.is_error) {
      if (state.sessions[a.id] !== ev.session_id) { state.sessions[a.id] = ev.session_id; saveState(); }
    }
    if (ev.type === 'system' && ev.subtype === 'init' && ev.model) {
      r.lastModel = ev.model;
      broadcastAgent(a);
    }
    if (ev.type === 'system' && ev.subtype === 'post_turn_summary') summary = ev;
    if (ev.type === 'rate_limit_event') { usage.recordLimits(ev.rate_limit_info); broadcastUsage(); }
    if (ev.type === 'stream_event' && ev.event) {
      const e = ev.event;
      if (e.type === 'message_start') { r.draft = ''; sendDraft(); }
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') { r.draft += e.delta.text; sendDraft(); }
      if (resultSeen) armQuiet();
    }
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const c of ev.message.content) {
        if (c.type === 'text' && c.text?.trim()) lastText = c.text;
        if (c.type === 'tool_use') {
          r.activity = describeTool(c.name, c.input);
          broadcastAgent(a);
          post({ kind: 'activity', from: a.id, text: r.activity });
          const f = c.input?.file_path || c.input?.notebook_path;
          if (f && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name)) touched.add(String(f));
        }
      }
    }
    if (ev.type === 'result') {
      resultEvents.push(ev);
      resultSeen = true;
      lastResultAt = Date.now();
      clearTimeout(steerTimer);
      if (steerBatch.length && !r.stopped) r.queue.unshift(coalesceUsers(steerBatch.splice(0)));
      armQuiet();
    }
  }

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    r.lastAliveAt = Date.now();
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handle(line);
    }
    if (resultSeen) armQuiet();
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); r.lastAliveAt = Date.now(); });
  let first = formatPrompt(item);
  if (!sessionId && state.carry?.[a.id]) {
    first = `[Fresh conversation. Your previous one ended with this reply, for continuity; rely on CLAUDE.md, memory and files for anything else:
${state.carry[a.id]}]

` + first;
    delete state.carry[a.id]; saveState();
  }
  try { proc.stdin.write(streamUserLine(first)); }
  catch { closeStdin(); }

  let finished = false;
  async function finish(code, spawnError) {
    if (finished) return;
    finished = true;
    stdinClosed = true;
    clearTimeout(quietTimer);
    clearTimeout(steerTimer);
    clearTimeout(draftTimer);
    wipeScreenTmp(a.id); // task over: its temporary screen shots go too
    if (buf.trim()) handle(buf.trim());
    if (r.feed === feed) r.feed = null;
    if (!r.stopped) {
      const missed = writtenLate.filter((s) => s.at > lastResultAt).map(({ at, ...rest }) => rest);
      const back = [...missed, ...steerBatch.splice(0)];
      if (back.length) r.queue.unshift(back.length === 1 ? back[0] : coalesceUsers(back));
    } else {
      steerBatch.length = 0;
    }
    r.draft = '';
    broadcast('draft', { agent: a.id, text: '' });
    r.proc = null;
    const raw = resultEvents[resultEvents.length - 1] || null;
    const result = raw ? {
      text: typeof raw.result === 'string' && raw.result.trim() ? raw.result : lastText,
      isError: !!raw.is_error || (raw.subtype && raw.subtype !== 'success'),
    } : null;
    for (const ev of resultEvents) usage.recordRun(a.id, ev);
    if (resultEvents.length) broadcastUsage();

    if (!snap) snap = await snapReady;
    // What did this turn change?
    let changed = null;
    if (snap) {
      r.activity = 'Checking what changed…';
      broadcastAgent(a);
      changed = await changes.collect(snap).catch(() => null);
    } else if (touched.size) {
      changed = { repo: null, files: [...touched].map((p) => ({ path: path.relative(a.cwd, path.resolve(a.cwd, p)) || p, status: 'modified' })) };
    }
    activity.record(path.join(DATA_DIR, 'activity.jsonl'), { agent: a.id, cwd: a.cwd, text: item.text, changed, touched, since: runStartedAt });
    if (changed && !changed.files.length) changed = null;

    running--;
    r.busy = false;

    if (r.stopped) {
      post({ kind: 'system', text: `${a.name} was stopped.`, from: a.id, changes: changed || undefined });
    } else if (spawnError) {
      post({ kind: 'error', from: a.id, text: `Couldn't start Claude Code (${CLAUDE}): ${spawnError.message}` });
    } else if (!result || result.isError) {
      const why = result?.text || stderr.trim() || `Claude Code exited with code ${code}.`;
      if (sessionId && !isRetry && /no conversation found|session/i.test(why)) {
        delete state.sessions[a.id];
        saveState();
        post({ kind: 'system', text: `${a.name} couldn't reopen its last conversation, so it's starting a fresh one.` });
        run(a, item, true);
        return;
      }
      const m = post({ kind: 'error', from: a.id, text: friendlyError(why), changes: changed || undefined });
      notifyPhone(a, m);
    } else {
      const asked = parseAskBlocks(result.text);
      const delivered = deliverHandoffs(a, asked.text, item.hop || 0, item);
      const denials = guardDenials(a, resultEvents.flatMap((ev) => ev.permission_denials || []));
      // "Needs you" is only for real decisions: a refused tool call or an explicit ask block.
      // The turn summary's needs_action guess is ignored; it was mostly informational noise.
      void summary;
      const needs = denials.length ? `Needs your OK to ${denials.map((d) => d.reason ? `${d.label}: ${d.reason.replace(/\.$/, '')}` : d.label).join('; ')}`
        : asked.asks.length ? asked.asks[0].q : '';
      const m = post({
        from: a.id, text: delivered.show || '(no reply)', to: delivered.targets, hop: item.hop,
        changes: changed || undefined,
        denials: denials.length ? denials : undefined,
        needs: needs || undefined,
        model: r.lastModel || undefined,
        stats: resultEvents.length ? {
          ms: resultEvents.reduce((s, e) => s + (e.duration_ms || 0), 0),
          costUSD: resultEvents.reduce((s, e) => s + (e.total_cost_usd || 0), 0),
          turns: resultEvents.reduce((s, e) => s + (e.num_turns || 0), 0),
        } : undefined,
      });
      r.needsYou = needs ? { text: needs, msgId: m.id, perm: !!denials.length } : null;
      // the owner already talked to this agent since its older questions, so they are stale: drop them.
      const before = asks.length;
      if (item.fromId === 'user') asks = asks.filter((x) => x.agent !== a.id);
      for (const k of asked.asks) addAsk(a.id, m.id, k.q, k.options);
      if (asked.asks.length || asks.length !== before) saveAsks();
      notifyPhone(a, m);
      try { autos.replied(a.id, String(result.text || ''), delivered.targets, item.hop || 0); } catch {}
    }

    // Automatic fresh conversation: when the context is heavy or the session is long, reset quietly at a clean boundary.
    if (!r.stopped && result && !result.isError && !r.resetPending) {
      const u = raw?.usage || {};
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      state.turns = state.turns || {};
      state.turns[a.id] = (state.turns[a.id] || 0) + 1;
      if (ctx > AUTO_RESET_TOKENS || state.turns[a.id] >= AUTO_RESET_TURNS) {
        state.carry = state.carry || {};
        state.carry[a.id] = String(result.text || '').slice(0, 1500);
        state.turns[a.id] = 0;
        r.resetPending = true;
        post({ kind: 'system', text: `${a.name} auto-refreshed its conversation to keep things fast (it keeps its notes and CLAUDE.md).` });
      }
      saveState();
    }
    // Apply a reset that was requested mid-turn, before anything else queued for this agent runs.
    if (r.resetPending) resetAgent(a);

    r.status = r.queue.length ? 'queued' : 'idle';
    r.activity = '';
    broadcastAgent(a);
    try { autos.turnEnded(a.id, !!result && !result.isError, item.hop || 0); } catch {}
    pump();
  }
  proc.on('error', (err) => finish(null, err));
  proc.on('close', (code) => finish(code));
}

function stopAgent(id) {
  const r = runtime[id];
  r.queue.length = 0;
  if (r.proc) {
    r.stopped = true;
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(r.proc.pid), '/T', '/F'], () => {});
    else r.proc.kill('SIGTERM');
  } else if (r.busy) {
    r.stopped = true; // still getting ready; launch() will see this
  } else {
    r.status = 'idle';
  }
  broadcastAgent(byId[id]);
}

// Stops one agent and closes the Game.exe / python it started, so nothing keeps running unseen.
function stopWithSweep(id) {
  const busy = runtime[id].busy;
  const swept = busy ? Promise.resolve(autos.sweepNow(id)).catch(() => null) : Promise.resolve();
  stopAgent(id);
  return swept;
}

// The owner typing "stop webapp" (or "stop webapp and docs", "@webapp stop") stops exactly those agents.
// It never goes to an agent to act on, so Assistant keeps running.
function stopTargets(text) {
  const t = String(text).trim().replace(/[.!\s]+$/, '');
  let list = null;
  let m = /^(?:please\s+)?(?:stop|halt|cancel|kill)\s+(.+)$/i.exec(t);
  if (m) list = m[1];
  else if ((m = /^@([a-z][a-z0-9-]*)\s+(?:stop|halt)$/i.exec(t))) list = m[1];
  if (!list) return null;
  const ids = [];
  for (const raw of list.split(/\s*(?:,|&|\band\b)\s*/i)) {
    const w = raw.replace(/^@/, '').replace(/\s+agent$/i, '').trim().toLowerCase();
    const a = byId[w] || agents.find((x) => String(x.name).toLowerCase() === w);
    if (!a) return null;
    ids.push(a.id);
  }
  return ids.length ? [...new Set(ids)] : null;
}

// Pause all: freeze every running agent (and anything it started, like Game.exe) in place,
// hold all queued work, schedules, handoffs and automations. Resume carries on from the same spot.
async function setPausedAll(on) {
  const pids = agents.map((a) => runtime[a.id].proc?.pid).filter(Boolean);
  if (on) {
    state.pausedAll = true;
    state.autoWasPaused = autos.paused();
    if (!state.autoWasPaused) autos.setPaused(true);
    state.frozenPids = pids;
    saveState();
    await freezer.freeze(pids);
    for (const a of agents) { const r = runtime[a.id]; if (!r.busy && r.queue.length) r.status = 'paused'; broadcastAgent(a); }
    post({ kind: 'system', text: 'Everything is paused. Running agents are frozen mid-step; nothing new starts until you press Resume.' });
  } else {
    state.pausedAll = false;
    if (!state.autoWasPaused) autos.setPaused(false);
    delete state.autoWasPaused;
    await freezer.thaw([...new Set([...(state.frozenPids || []), ...pids])]);
    delete state.frozenPids;
    saveState();
    for (const a of agents) { const r = runtime[a.id]; if (r.status === 'paused') r.status = r.queue.length ? 'queued' : 'idle'; broadcastAgent(a); }
    post({ kind: 'system', text: 'Resumed. Agents pick up where they left off.' });
    pump();
  }
  broadcast('pauseall', { paused: !!state.pausedAll });
}
// A restart while paused would leave orphaned frozen processes; let them go.
if (state.frozenPids?.length) { freezer.thaw(state.frozenPids); delete state.frozenPids; saveState(); }
// Queued work saved by /api/restart goes back in line; pump() starts it once the server is up.
if (state.carryQueues) {
  for (const [id, items] of Object.entries(state.carryQueues)) {
    if (!runtime[id] || !Array.isArray(items)) continue;
    runtime[id].queue.push(...items);
    runtime[id].status = 'queued';
  }
  delete state.carryQueues;
  saveState();
}

// Restart: queued work (handoffs, messages) comes back afterwards; run-crew.cmd starts the server again.
let restartWhenIdle = false;
function doRestart() {
  console.log(`Restart requested at ${new Date().toLocaleString()}`);
  const carry = {};
  for (const a of agents) if (runtime[a.id].queue.length) carry[a.id] = runtime[a.id].queue.slice();
  if (Object.keys(carry).length) { state.carryQueues = carry; saveState(); }
  for (const a of agents) stopAgent(a.id);
  setTimeout(() => process.exit(0), 1500);
}
setInterval(() => {
  if (!restartWhenIdle || state.pausedAll) return;
  if (agents.some((a) => runtime[a.id].busy || runtime[a.id].queue.length)) return;
  restartWhenIdle = false;
  post({ kind: 'system', text: 'Restarting Crew now (nobody was working). Back in a few seconds.' });
  setTimeout(doRestart, 800);
}, 3000).unref();

// Phone notification for an agent's reply (if any device has turned them on).
function notifyPhone(a, m) {
  if (!push.count()) return;
  const body = String(m.text || '').replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim();
  push.notify({
    title: m.needs ? `${a.name} needs you` : m.kind === 'error' ? `${a.name}: problem` : a.name,
    body: (m.needs ? `${m.needs} — ` : '') + (body.length > 220 ? body.slice(0, 219) + '…' : body),
    tag: `crew-${a.id}`,
    url: '/',
  }).catch(() => {});
}

// ---------------------------------------------------------------- routing

// Private delegation block. Stripped before the reply is shown.
function parseCrewBlocks(text) {
  const handoffs = [];
  const dropped = [];
  const visible = String(text || '').replace(/<<<crew\b([^\n]*)\n?([\s\S]*?)(?:>>>|$)/g, (full, header, body) => {
    const to = /(?:^|\s)to=([a-z][a-z0-9-]*)/i.exec(header || '');
    const model = /(?:^|\s)model=(opus|sonnet|haiku)/i.exec(header || '');
    const id = to ? to[1].toLowerCase() : '';
    const brief = String(body || '').trim().slice(0, 2000);
    if (id && byId[id] && brief) handoffs.push({ id, model: model ? model[1].toLowerCase() : null, brief });
    else if (brief) dropped.push(brief);
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { visible, handoffs, dropped };
}
// Question block for the owner: <<<ask, a question line, optional "- option" lines, >>>.
// It stays visible in the chat as one line and also goes into the "Waiting on you" box.
function parseAskBlocks(text) {
  const found = [];
  const rest = String(text || '').replace(/<<<ask\b[^\n]*\n?([\s\S]*?)(?:>>>|$)/g, (full, body) => {
    const lines = String(body || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const options = lines.filter((l) => /^[-*•]\s+/.test(l)).map((l) => l.replace(/^[-*•]\s+/, '').slice(0, 80)).slice(0, 6);
    const q = lines.filter((l) => !/^[-*•]\s+/.test(l)).join(' ').slice(0, 400);
    if (!q) return '';
    found.push({ q, options: options.length ? options : ['Yes', 'No'] });
    return `**Your call:** ${q}${options.length ? ` (${options.join(' / ')})` : ''}`;
  });
  return { text: rest, asks: found };
}
function saveAsks() {
  try { fs.writeFileSync(ASKS_PATH, JSON.stringify(asks)); } catch {}
  broadcast('asks', asks);
}
const ASK_MAX_AGE = 3 * 24 * 3600 * 1000;
const askKey = (q) => String(q || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Old auto-made "Proceed / hold off" items and anything older than 3 days are dropped.
function pruneAsks() {
  const cutoff = Date.now() - ASK_MAX_AGE;
  asks = asks.filter((x) => !x.auto && x.ts > cutoff);
}
function addAsk(agentId, msgId, q, options) {
  // Same question from the same agent again: keep only the newest copy.
  asks = asks.filter((x) => !(x.agent === agentId && askKey(x.q) === askKey(q)));
  asks.push({ id: crypto.randomUUID(), agent: agentId, msgId, q, options, ts: Date.now() });
  pruneAsks();
  if (asks.length > 50) asks = asks.slice(-50);
}
function visibleReply(text) {
  const { visible } = parseCrewBlocks(parseAskBlocks(text).text);
  const cut = visible.search(/<<<(crew|ask)\b/);
  return (cut === -1 ? visible : visible.slice(0, cut)).replace(/\n{3,}/g, '\n\n').trim();
}
function deliverHandoffs(from, text, hop, item) {
  const { visible, handoffs, dropped } = parseCrewBlocks(text);
  const merged = new Map();
  if (hop < settings.maxHops) {
    for (const h of handoffs) {
      if (h.id === from.id) continue;
      const prev = merged.get(h.id);
      if (prev) prev.brief = `${prev.brief}\n\n${h.brief}`.slice(0, 2000);
      else merged.set(h.id, { ...h });
    }
  }
  const sent = [...merged.values()];
  if (hop >= settings.maxHops) {
    const refused = handoffs.filter((h) => h.id !== from.id).map((h) => ({ ...h, name: byId[h.id].name }));
    try { noteHandoffLimit(from, item, refused, settings.maxHops); } catch {}
  }
  for (const h of sent) {
    // Night-only agents (local.nightOnlyAgents) run off-hours: daytime handoffs wait in their QUEUE.md for the 11 PM run.
    if (localCfg.load().nightOnlyAgents.includes(h.id) && !localCfg.isNight()) {
      try {
        const d = new Date(), p = (n) => String(n).padStart(2, '0');
        const line = `- ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} | from ${from.name} | ${String(h.brief).replace(/\s+/g, ' ').trim().slice(0, 900)}\n`;
        const qf = path.join(ROOT, 'workspace', h.id, 'QUEUE.md');
        fs.mkdirSync(path.dirname(qf), { recursive: true });
        fs.appendFileSync(qf, line);
        post({ kind: 'system', text: `${byId[h.id].name} only runs at night, so ${from.name}'s request is saved in its queue for the 11 PM run.` });
      } catch (e) { console.log('  night queue failed: ' + e.message); }
      h.held = true;
      continue;
    }
    enqueue(h.id, { fromId: from.id, fromName: from.name, text: h.brief, hop: hop + 1, model: h.model });
    try { autos.noteHandoff(from.id, h.id); } catch {}
  }
  let show = visible;
  if (!show) {
    if (sent.length === 1 && sent[0].held) show = `${byId[sent[0].id].name} is off-hours only, so that is queued for tonight.`;
    else if (sent.length === 1) show = `${byId[sent[0].id].name} is on that.`;
    else if (sent.length > 1) show = `${sent.map((h) => byId[h.id].name).join(' and ')} are on that.`;
    else if (handoffs.length) show = handoffs.map((h) => h.brief).join('\n\n');
    else if (dropped.length) show = dropped.join('\n\n');
  }
  return { show, targets: sent.filter((h) => !h.held).map((h) => h.id) };
}

// @handles anywhere in your own message pick who gets it.
function userTargets(text) {
  const out = new Set();
  for (const m of text.matchAll(/(^|[\s(,])@([a-z][a-z0-9-]*)\b/gi)) {
    const id = m[2].toLowerCase();
    if (id === 'all') agents.forEach((a) => out.add(a.id));
    else if (byId[id]) out.add(id);
  }
  if (!out.size) out.add(settings.defaultAgent);
  return [...out];
}

// ---------------------------------------------------------------- HTTP
//
// Two entrances, each with its own rules:
//   "local": http://localhost:<port> on this PC, plus your Wi-Fi when allowLan is on
//            (other devices need the access key).
//   "cloudflare": a second port that only the Cloudflare Tunnel connects to. Every request
//            must carry a valid Cloudflare Access login token for an allowed email.
//            The tunnel connects from this PC, so "it came from localhost" means nothing there.

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
if (settings.allowLan) {
  lanAddresses().forEach((ip) => localHosts.add(ip));
  localHosts.add(os.hostname().toLowerCase());
}
const cf = settings.cloudflare;
const cloudflareHosts = new Set(cf ? [cf.hostname] : []);

function isLocal(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}
function hostOf(req) {
  return String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
}
function cookie(req, name) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function keyMatches(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(state.accessKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- Cloudflare Access token check (RS256 JWT signed by your team's rotating keys)

const accessKeys = { byKid: new Map(), fetchedAt: 0 };
async function loadAccessKeys(force) {
  const age = Date.now() - accessKeys.fetchedAt;
  if (accessKeys.byKid.size && (force ? age < 60e3 : age < 3600e3)) return;
  const r = await fetch(`https://${cf.teamDomain}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`Couldn't fetch Cloudflare Access keys (HTTP ${r.status})`);
  const { keys = [] } = await r.json();
  const byKid = new Map();
  for (const k of keys) byKid.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' }));
  accessKeys.byKid = byKid;
  accessKeys.fetchedAt = Date.now();
}

async function verifyAccess(req, allowService = false) {
  const token = req.headers['cf-access-jwt-assertion'] || cookie(req, 'CF_Authorization');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  } catch { return null; }
  if (header.alg !== 'RS256') return null;

  await loadAccessKeys(false);
  if (!accessKeys.byKid.has(header.kid)) await loadAccessKeys(true); // keys rotate every few weeks
  const key = accessKeys.byKid.get(header.kid);
  if (!key) return null;
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  if (!crypto.verify('RSA-SHA256', signed, key, Buffer.from(parts[2], 'base64url'))) return null;

  const now = Date.now() / 1000;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== `https://${cf.teamDomain}`) return null;
  if (!aud.includes(cf.aud)) return null;
  if (typeof claims.exp !== 'number' || claims.exp < now - 30) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > now + 30) return null;
  // A Cloudflare service token (a machine, not a person) has no email. Only presence endpoints accept one.
  if (allowService && !claims.email && claims.common_name) return claims;
  if (!cf.allowedEmails.includes(String(claims.email || '').toLowerCase())) return null;
  return claims;
}

// ---- helpers

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
// ---- page safety net
// A single code error in index.html stops its whole script and leaves a blank web UI.
// So the page is checked whenever it changes: a good page is saved as the last working
// copy; a broken one is replaced by that copy, with a red banner saying what's wrong.
const LAST_GOOD_PAGE = path.join(DATA_DIR, 'index.last-good.html');
let pageCache = { key: '', html: '', err: null };
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function currentPage() {
  const file = path.join(PUBLIC_DIR, 'index.html');
  const st = fs.statSync(file);
  const key = `${st.mtimeMs}:${st.size}`;
  if (pageCache.key !== key) {
    const html = fs.readFileSync(file, 'utf8');
    const err = checkPage(html);
    pageCache = { key, html, err };
    if (err) {
      console.error(`public/index.html has a code error (line ${err.line}: ${err.message}). Serving the last working page instead.`);
    } else {
      try {
        if (!fs.existsSync(LAST_GOOD_PAGE) || fs.readFileSync(LAST_GOOD_PAGE, 'utf8') !== html) fs.writeFileSync(LAST_GOOD_PAGE, html);
      } catch (e) { console.error('Could not save the last working page:', e.message); }
    }
  }
  if (!pageCache.err) return pageCache.html;

  let fallback = null;
  let savedAt = null;
  try { fallback = fs.readFileSync(LAST_GOOD_PAGE, 'utf8'); savedAt = fs.statSync(LAST_GOOD_PAGE).mtime; } catch { /* none saved yet */ }
  const e = pageCache.err;
  const banner = `<div role="alert" style="position:sticky;top:0;z-index:99999;background:#b3412f;color:#fff;padding:8px 14px;font:14px/1.45 system-ui,sans-serif">`
    + `⚠ Crew's page has a code error: public/index.html line ${e.line}, ${escHtml(e.message)}. `
    + (fallback ? `You're seeing the last working version, saved ${escHtml(savedAt.toLocaleString())}.` : 'No working version was saved earlier, so parts of the page may not load.')
    + ` Fix the file and run <code>npm run check</code>; this banner goes away on the next refresh.</div>`;
  return (fallback || pageCache.html).replace(/<body[^>]*>/i, (m) => m + banner);
}

// Private per-install bits (built-in drawings, default groups, control-off stop rule) are filled into the page
// here, so the public page source never names real agents.
function withLocal(html) {
  const l = localCfg.load();
  let extra = {};
  try { extra = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'avatar-extras.json'), 'utf8')); } catch { /* none */ }
  const data = { avatars: { ...extra, ...l.avatars }, groups: l.defaultGroups, stop: l.stopOnControlOff };
  return html.replace('const CREW_LOCAL = {};', () => 'const CREW_LOCAL = ' + JSON.stringify(data).replace(/</g, '\\u003c') + ';');
}

const STATIC_FILES = {
  '/sw.js': ['sw.js', 'application/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/icon-maskable-512.png': ['icon-maskable-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/badge-96.png': ['badge-96.png', 'image/png'],
};
// Uploads are served back with these types; anything else downloads as a file.
// (No SVG/HTML: those could run script.)
const UPLOAD_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8', json: 'text/plain; charset=utf-8',
};
const MAX_UPLOAD = 15 * 1024 * 1024;

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error(`File is too large (max ${Math.round(limit / 1048576)} MB)`)); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const PAGE_STYLE = `body{font:16px system-ui;background:#141413;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
form,.box{display:grid;gap:12px;width:100%;max-width:340px}input,button{font:inherit;padding:12px;border-radius:10px;border:1px solid #444;background:#222;color:#eee}button{background:#d97757;border:0;color:#fff}a{color:#d97757}`;
const LOGIN_PAGE = (failed) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Crew</title><style>${PAGE_STYLE}</style></head>
<body><form method="post" action="/login"><h2 style="margin:0">Claude Crew</h2><div>Enter the access key shown on the PC running Crew.</div>
${failed ? '<div style="color:#f88">That key didn\'t match.</div>' : ''}<input name="key" type="password" autocomplete="current-password" autofocus><button>Open</button></form></body></html>`;
const DENIED_PAGE = () => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Crew</title><style>${PAGE_STYLE}</style></head>
<body><div class="box"><h2 style="margin:0">Claude Crew</h2><div>You're not signed in, or this account isn't allowed.</div>
<a href="/cdn-cgi/access/logout">Sign out and try a different account</a></div></body></html>`;

// ---- the app

function isCrewPath(p) {
  return p === '/' || p === '/index.html' || p === '/setup' || p === '/events' || p === '/login' || !!STATIC_FILES[p]
    || p.startsWith('/api/') || p.startsWith('/uploads/') || p.startsWith('/avatars/') || p.startsWith('/cdn-cgi/');
}

// Websockets only exist for previews (hot reload). Same login rules as the page.
function makeUpgradeHandler(entrance) {
  const viaCloudflare = entrance === 'cloudflare';
  const hosts = viaCloudflare ? cloudflareHosts : localHosts;
  return async (req, socket, head) => {
    socket.on('error', () => {});
    try {
      if (!hosts.has(hostOf(req))) return socket.destroy();
      const url = new URL(req.url, 'http://local');
      const ok = viaCloudflare
        ? !!(await verifyAccess(req).catch(() => null))
        : (isLocal(req) || keyMatches(cookie(req, 'crew_key')));
      if (!ok) return socket.destroy();
      previews.handleUpgrade(req, socket, head, url);
    } catch { socket.destroy(); }
  };
}

function makeHandler(entrance) {
  const viaCloudflare = entrance === 'cloudflare';
  const hosts = viaCloudflare ? cloudflareHosts : localHosts;

  return async (req, res) => {
    try {
      // Only answer to names we actually serve on (blocks DNS-rebinding tricks).
      if (!hosts.has(hostOf(req))) return send(res, 403, 'Unknown host', 'text/plain');
      const url = new URL(req.url, 'http://local');
      const wantsJson = url.pathname.startsWith('/api') || url.pathname === '/events';

      // Machines pair and send heartbeats with their own secret, not the browser login.
      if (req.method === 'POST' && url.pathname.startsWith('/api/presence/')) {
        if (req.headers['x-crew'] !== '1') return send(res, 403, { error: 'missing header' });
        const b = JSON.parse((await readBody(req, 8192)) || '{}');
        if (url.pathname === '/api/presence/pair') {
          try { return send(res, 200, presence.pair(b)); } catch (e) { return send(res, 403, { error: e.message }); }
        }
        if (url.pathname === '/api/presence/beat') {
          try { presence.beat(b); } catch (e) { return send(res, 401, { error: e.message }); }
          return send(res, 200, { ok: true });
        }
        return send(res, 404, { error: 'not found' });
      }

      let identity = null;
      if (viaCloudflare) {
        const presencePath = req.method === 'POST' && /^\/api\/presence\/(pair|beat)$/.test(url.pathname);
        identity = await verifyAccess(req, presencePath).catch((err) => { console.error(err.message); return null; });
        if (!identity) {
          return wantsJson
            ? send(res, 401, { error: 'login required' })
            : send(res, 403, DENIED_PAGE(), 'text/html; charset=utf-8');
        }
      } else {
        if (url.pathname === '/login' && req.method === 'POST') {
          const key = new URLSearchParams(await readBody(req, 4096)).get('key');
          if (!keyMatches(key)) return send(res, 401, LOGIN_PAGE(true), 'text/html; charset=utf-8');
          res.writeHead(303, {
            'Set-Cookie': `crew_key=${encodeURIComponent(state.accessKey)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
            Location: '/',
          });
          return res.end();
        }
        if (!isLocal(req) && !keyMatches(cookie(req, 'crew_key'))) {
          return wantsJson
            ? send(res, 401, { error: 'login required' })
            : send(res, 200, LOGIN_PAGE(false), 'text/html; charset=utf-8');
        }
      }

      // ---- app previews (dev servers shown inside Crew); Crew's own paths stay Crew's
      if (previews.handle(req, res, url, isCrewPath(url.pathname))) return;

      // ---- page + app files (icons, manifest, service worker for phone notifications)
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        if (setupPending && !viaCloudflare && isLocal(req)) { res.writeHead(302, { Location: '/setup' }); return res.end(); }
        return send(res, 200, withLocal(currentPage()), 'text/html; charset=utf-8');
      }
      // ---- first-run setup page (this PC only)
      if (req.method === 'GET' && url.pathname === '/setup') {
        if (viaCloudflare || !isLocal(req)) return send(res, 403, 'Setup is only available on the PC Crew runs on.', 'text/plain');
        return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'setup.html'), 'utf8'), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/setup/info') {
        if (viaCloudflare || !isLocal(req)) return send(res, 403, { error: 'this PC only' });
        let claude = { found: true, ok: false };
        try {
          const out = await new Promise((resolve, reject) => {
            const p = launchClaude(['-p', 'Reply with exactly: ok'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            let t = '';
            const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } reject(new Error('timeout')); }, 60000);
            p.stdout.on('data', (d) => { t += d; });
            p.on('error', (e) => { clearTimeout(timer); reject(e); });
            p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(t) : reject(new Error('exit ' + code)); });
          });
          claude.ok = /ok/i.test(out);
        } catch (e) { if (e.code === 'ENOENT') claude.found = false; }
        return send(res, 200, { needsSetup: setupPending, userName: settings.userName === 'You' ? os.userInfo().username : settings.userName, claude });
      }
      if (req.method === 'POST' && (url.pathname === '/api/setup/install-claude' || url.pathname === '/api/setup/signin')) {
        if (viaCloudflare || !isLocal(req) || req.headers['x-crew'] !== '1') return send(res, 403, { error: 'this PC only' });
        if (process.platform !== 'win32') return send(res, 400, { error: 'Install Claude Code from https://claude.ai/download, then press Check again.' });
        if (url.pathname === '/api/setup/signin') {
          spawn('cmd.exe', ['/c', 'start', 'Sign in to Claude', 'cmd.exe', '/k', '"' + CLAUDE + '"'], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
          return send(res, 200, { ok: true });
        }
        const ps = "$ErrorActionPreference='Stop';irm https://claude.ai/install.ps1 | iex";
        const failed = await new Promise((resolve) => {
          execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true, timeout: 240000 }, (err) => resolve(err));
        });
        if (failed) return send(res, 500, { error: 'The automatic install did not finish. Open PowerShell and run: irm https://claude.ai/install.ps1 | iex' });
        send(res, 200, { ok: true });
        setTimeout(doRestart, 400);
        return;
      }
      // Built-in agent pictures (public/avatars/<name>.png), used as agent icons.
      const av = req.method === 'GET' && url.pathname.match(/^\/avatars\/([a-z0-9-]{1,40})\.png$/);
      if (av) {
        const f = path.join(__dirname, 'public', 'avatars', av[1] + '.png');
        if (!fs.existsSync(f)) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
        return fs.createReadStream(f).pipe(res);
      }
      if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
        const [file, type] = STATIC_FILES[url.pathname];
        const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
        if (url.pathname === '/sw.js') headers['Service-Worker-Allowed'] = '/';
        res.writeHead(200, headers);
        return res.end(fs.readFileSync(path.join(PUBLIC_DIR, file)));
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        // Don't let a live stream outlast the Cloudflare login that opened it.
        if (identity) {
          const t = setTimeout(() => res.end(), Math.max(0, identity.exp * 1000 - Date.now()));
          req.on('close', () => clearTimeout(t));
        }
        return;
      }
      // Live install is the source of truth: report the public version, never self-overwrite from it.
      if (req.method === 'GET' && url.pathname === '/api/update') return send(res, 200, { ...updater.status(), canApply: false });
      if (req.method === 'GET' && url.pathname === '/api/previews') return send(res, 200, previews.list());
      if (req.method === 'GET' && url.pathname === '/api/previews/logs') {
        const lines = previews.logs(String(url.searchParams.get('id') || ''), Number(url.searchParams.get('n')) || 100);
        return lines ? send(res, 200, { lines }) : send(res, 404, { error: 'no such preview' });
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const live = new Set(history.map((m) => m.id));
        return send(res, 200, {
          userName: settings.userName, defaultAgent: settings.defaultAgent,
          agents: agents.map(agentInfo), history,
          pins,
          asks,
          reactions: Object.fromEntries(Object.entries(reactions).filter(([id]) => live.has(id))),
          flags: Object.fromEntries(Object.entries(state.flags).filter(([id]) => live.has(id))),
          procs: procWatch.get(),
          drafts: Object.fromEntries(agents.filter((a) => runtime[a.id].draft).map((a) => [a.id, runtime[a.id].draft])),
          usage: usage.summary(agents.map((a) => a.id)),
          schedules: scheduler.list(),
          modelChoices: MODEL_CHOICES,
          computerControl,
          pausedAll: !!state.pausedAll,
          pushKey: push.publicKey,
          signedInAs: identity?.email || null,
          signOutUrl: viaCloudflare ? '/cdn-cgi/access/logout' : null,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/settings') {
        const s = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).settings || {};
        return send(res, 200, {
          values: {
            userName: s.userName || '', defaultAgent: s.defaultAgent || agents[0].id,
            maxHops: s.maxHops ?? 6, maxConcurrent: s.maxConcurrent || 2,
            permissionMode: s.permissionMode || 'bypassPermissions', model: s.model || '',
            port: s.port || 7777, allowLan: !!s.allowLan, claudePath: s.claudePath || '',
          },
          agents: agents.map((a) => ({ id: a.id, name: a.name })),
          canEditAdvanced: !viaCloudflare && isLocal(req),
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/machines/link')return send(res, 200, { url: rawCfg.presenceHub?.url || '' });
      if (req.method === 'GET' && url.pathname === '/api/machines') {
        presence.setActivity(busyCount() ? `${busyCount()} agent${busyCount() > 1 ? 's' : ''} working` : 'idle');
        return send(res, 200, presence.list());
      }
      if (req.method === 'GET' && url.pathname === '/api/integrations') {
        return send(res, 200, await integrations.get(url.searchParams.get('refresh') === '1'));
      }
      if (req.method === 'GET' && url.pathname === '/api/credentials') {
        try { return send(res, 200, credentials.list()); } catch (e) { return send(res, 500, { error: 'Could not read the credentials folder.' }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/notes') {
        try { return send(res, 200, JSON.parse(fs.readFileSync(NOTES_PATH, 'utf8'))); } catch { return send(res, 200, {}); }
      }
      if (req.method === 'GET' && url.pathname === '/api/prefs') {
        try { return send(res, 200, JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8'))); } catch { return send(res, 200, {}); }
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const s = statusLib.read(path.join(ROOT, 'STATUS.md'), agents.map((a) => a.id), settings.userName);
        const nm = (id) => byId[id]?.name || id;
        const fix = (x) => ({ ...x, name: nm(x.id), onName: x.on === 'user' ? settings.userName : x.on ? nm(x.on) : '' });
        return send(res, 200, { feed: s.feed.map(fix), blocked: s.blocked.map(fix) });
      }
      if (req.method === 'GET' && url.pathname === '/api/automations') return send(res, 200, { rules: autos.list(), paused: autos.paused(), active: autos.active() });
      if (req.method === 'GET' && url.pathname === '/api/automation-runs') return send(res, 200, autos.runs(Number(url.searchParams.get('n')) || 50));
      if (req.method === 'GET' && url.pathname === '/api/usage') {
        return send(res, 200, usage.summary(agents.map((a) => a.id)));
      }
      let mm;
      if (req.method === 'GET' && (mm = url.pathname.match(/^\/api\/changes\/([\w-]+)\/diff$/))) {
        const m = history.find((x) => x.id === mm[1]);
        if (!m?.changes?.repo) return send(res, 404, { error: 'No diff available for this message.' });
        return send(res, 200, { diff: await changes.diff(m.changes, url.searchParams.get('path') || '') });
      }
      if (req.method === 'GET' && (mm = url.pathname.match(/^\/api\/uploads\/([\w-]+)$/))) {
        const name = fs.readdirSync(UPLOAD_DIR).find((f) => f.startsWith(mm[1] + '__'));
        if (!name) return send(res, 404, { error: 'not found' });
        const ext = path.extname(name).slice(1).toLowerCase();
        const type = UPLOAD_TYPES[ext];
        res.writeHead(200, {
          'Content-Type': type || 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': 'sandbox',
          'Cache-Control': 'private, max-age=86400',
          ...(type && type.startsWith('image/') ? {} : { 'Content-Disposition': `attachment; filename="${name.split('__')[1].replace(/"/g, '')}"` }),
        });
        return res.end(fs.readFileSync(path.join(UPLOAD_DIR, name)));
      }

      if (req.method === 'POST') {
        // Custom header + JSON body: a random web page can't forge these without a CORS preflight we never answer.
        if (req.headers['x-crew'] !== '1') return send(res, 403, { error: 'missing header' });
        const origin = req.headers.origin;
        if (origin) {
          let originHost = '';
          try { originHost = new URL(origin).hostname.toLowerCase(); } catch { /* "null" etc. */ }
          if (!hosts.has(originHost)) return send(res, 403, { error: 'bad origin' });
        }

        // Attachments arrive as raw bytes, not JSON.
        if (url.pathname === '/api/upload') {
          const original = decodeURIComponent(String(req.headers['x-filename'] || 'file')).replace(/[^\w.\- ]+/g, '_').slice(-80) || 'file';
          const data = await readRaw(req, MAX_UPLOAD);
          if (!data.length) return send(res, 400, { error: 'empty file' });
          const id = crypto.randomUUID();
          const file = path.join(UPLOAD_DIR, `${id}__${original}`);
          fs.writeFileSync(file, data);
          return send(res, 200, { id, name: original, size: data.length, type: UPLOAD_TYPES[path.extname(original).slice(1).toLowerCase()] || 'application/octet-stream' });
        }

        const body = JSON.parse((await readBody(req)) || '{}');

        if (url.pathname === '/api/control') {
          const wasOn = computerControl;
          computerControl = !!body.on;
          fs.writeFileSync(CONTROL_PATH, JSON.stringify({ on: computerControl }));
          if (wasOn !== computerControl) {
            const ua = String(req.headers['user-agent'] || '');
            const dev = /iPhone|iPad|Android|Mobile/i.test(ua) ? 'a phone' : /Windows|Macintosh|Linux|X11/i.test(ua) ? 'a computer browser' : 'an unknown client';
            const where = viaCloudflare ? `remote${identity?.email ? ' (' + identity.email + ')' : ''}` : isLocal(req) ? 'this PC' : 'the home network';
            post({ kind: 'system', text: `Computer control turned ${computerControl ? 'ON' : 'OFF'} from ${dev}, ${where}.` });
          }
          if (!computerControl) {
            // Only stop agents that can be driving the game, not everyone.
            { const lc = localCfg.load(); for (const a of agents) if (localCfg.stopsOnControlOff(lc, a.id)) stopAgent(a.id); }
            try { require('child_process').exec('taskkill /IM Game.exe /F'); } catch {}
          }
          broadcast('control', { on: computerControl });
          return send(res, 200, { ok: true, on: computerControl });
        }
        if (url.pathname === '/api/credentials/save') {
          try { return send(res, 200, { ok: true, ...credentials.save(body) }); } catch (e) { return send(res, 400, { error: e.message }); }
        }
        if (url.pathname === '/api/credentials/delete') {
          try { credentials.remove(String(body.name || '')); return send(res, 200, { ok: true }); } catch (e) { return send(res, 400, { error: e.message }); }
        }
        if (url.pathname === '/api/automations/toggle') {
          const list = autos.list();
          if (!list.some((r) => r.id === body.id)) return send(res, 404, { ok: false });
          autos.save(list.map((r) => r.id === body.id ? { ...r, enabled: !!body.enabled } : r));
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/automations/save') {
          try { return send(res, 200, { ok: true, rule: autos.upsert(body.rule) }); }
          catch (e) { return send(res, 400, { ok: false, error: e.message }); }
        }
        if (url.pathname === '/api/automations/delete') {
          return send(res, autos.remove(String(body.id || '')) ? 200 : 404, { ok: true });
        }
        if (url.pathname === '/api/automations/pause') {
          autos.setPaused(!!body.paused);
          return send(res, 200, { ok: true, paused: autos.paused() });
        }
        if (url.pathname === '/api/pauseall') {
          const want = !!body.paused;
          if (want !== !!state.pausedAll) await setPausedAll(want);
          return send(res, 200, { ok: true, paused: !!state.pausedAll });
        }
        if (url.pathname === '/api/stopall') {
          for (const a of agents) stopAgent(a.id);
          autos.cancelAll();
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/send') {
          let text = String(body.text || '').trim();
          // A leading "!" makes the message urgent: it skips the concurrency cap.
          const urgent = text.startsWith('!');
          if (urgent) text = text.replace(/^!+\s*/, '');
          const attachments = (Array.isArray(body.attachments) ? body.attachments : []).slice(0, 10).map((id) => {
            const name = /^[\w-]+$/.test(String(id)) && fs.readdirSync(UPLOAD_DIR).find((f) => f.startsWith(id + '__'));
            if (!name) return null;
            const full = path.join(UPLOAD_DIR, name);
            return { id, name: name.split('__')[1], path: full, size: fs.statSync(full).size, type: UPLOAD_TYPES[path.extname(name).slice(1).toLowerCase()] || null };
          }).filter(Boolean);
          if (!text && !attachments.length) return send(res, 400, { error: 'empty' });
          const stopIds = stopTargets(text);
          if (stopIds && !attachments.length) {
            const sent = post({ from: 'user', text, to: stopIds });
            for (const id of stopIds) {
              const was = runtime[id].busy || runtime[id].queue.length;
              stopWithSweep(id);
              if (!was) post({ kind: 'system', text: `${byId[id].name} wasn't running.` });
            }
            return send(res, 200, { ok: true, to: stopIds, id: sent.id, stopped: true });
          }
          const to = userTargets(text);
          const shown = attachments.map(({ path: _p, ...rest }) => rest);
          const sent = post({ from: 'user', text: text || '(attachment)', to, attachments: shown.length ? shown : undefined });
          for (const id of to) enqueue(id, { fromId: 'user', text: text || 'Please look at the attached file(s).', hop: 0, attachments, urgent, msgId: sent.id });
          return send(res, 200, { ok: true, to, id: sent.id });
        }
        // Unsend: remove one of the owner's messages. Anything still waiting in an agent's queue is
        // dropped before they see it; an agent already working on it is told to disregard it.
        if (url.pathname === '/api/unsend') {
          const id = String(body.id || '');
          const at = history.findIndex((m) => m.id === id);
          if (at < 0 || history[at].from !== 'user') return send(res, 404, { error: 'message not found' });
          const m = history[at];
          history.splice(at, 1);
          unsentIds.add(id);
          try {
            const keep = fs.readFileSync(LOG_PATH, 'utf8').split(String.fromCharCode(10)).filter((l) => l && !l.includes(JSON.stringify(id)));
            fs.writeFileSync(LOG_PATH, keep.length ? keep.join(String.fromCharCode(10)) + String.fromCharCode(10) : '');
          } catch {}
          const told = [];
          for (const aid of m.to || []) {
            const r = runtime[aid];
            if (!r) continue;
            const before = r.queue.length;
            r.queue = r.queue.filter((q) => q.msgId !== id);
            if (r.queue.length < before) { if (!r.busy && !r.queue.length) r.status = 'idle'; broadcastAgent(byId[aid]); continue; }
            if (r.busy) {
              told.push(aid);
              enqueue(aid, { fromId: 'user', text: `[${settings.userName} unsent his last message, so disregard it and do not act on it: "${String(m.text).slice(0, 300)}"]`, hop: 0 });
            }
          }
          broadcast('unsent', { id });
          return send(res, 200, { ok: true, told });
        }
        // Settings page in the menu. Basic fields from any signed-in device; port, phone access and Claude path only from this PC.
        if (url.pathname === '/api/settings') {
          const advanced = !viaCloudflare && isLocal(req);
          const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
          const s = raw.settings = raw.settings || {};
          const intIn = (v, lo, hi, label) => {
            const n = Number(v);
            if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${label} must be a whole number from ${lo} to ${hi}.`);
            return n;
          };
          try {
            if (body.userName !== undefined) {
              const n = String(body.userName).trim().slice(0, 40);
              if (!n) throw new Error('Your name cannot be empty.');
              s.userName = n;
            }
            if (body.defaultAgent !== undefined) {
              const d = String(body.defaultAgent).toLowerCase();
              if (!agents.some((a) => a.id === d)) throw new Error('Pick an agent that exists as the main helper.');
              s.defaultAgent = d;
            }
            if (body.maxHops !== undefined) s.maxHops = intIn(body.maxHops, 0, 20, 'Hand-off depth');
            if (body.maxConcurrent !== undefined) s.maxConcurrent = intIn(body.maxConcurrent, 1, 10, 'Agents at once');
            if (body.permissionMode !== undefined) {
              const m = String(body.permissionMode);
              if (!['bypassPermissions', 'acceptEdits', 'default', 'plan'].includes(m)) throw new Error('Unknown permission mode.');
              s.permissionMode = m;
            }
            if (body.model !== undefined) s.model = String(body.model).trim() || null;
            if (advanced) {
              if (body.port !== undefined) s.port = intIn(body.port, 1024, 65535, 'Port');
              if (body.allowLan !== undefined) s.allowLan = !!body.allowLan;
              if (body.claudePath !== undefined) s.claudePath = String(body.claudePath).trim() || null;
            }
          } catch (e) { return send(res, 400, { error: e.message }); }
          fs.copyFileSync(CONFIG_PATH, path.join(DATA_DIR, 'crew.config.before-settings.json'));
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2));
          return send(res, 200, { ok: true, needsRestart: true });
        }
        // Used by the tray icon. This PC only: never over the tunnel or from other devices.
        if (url.pathname === '/api/setup/save') {
          if (viaCloudflare || !isLocal(req)) return send(res, 403, { error: 'this PC only' });
          const name = String(body.name || '').trim().slice(0, 40);
          if (!name) return send(res, 400, { error: 'Please type your name.' });
          const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
          const taken = new Set(raw.agents.map((a) => String(a.id).toLowerCase()));
          const add = [];
          for (const h of Array.isArray(body.helpers) ? body.helpers.slice(0, 8) : []) {
            const folder = String(h.cwd || '').trim().replace(/^["']|["']$/g, '');
            if (!folder) return send(res, 400, { error: 'A helper needs a folder path.' });
            let st;
            try { st = fs.statSync(folder); } catch { return send(res, 400, { error: `I can't find the folder ${folder}. Check the path.` }); }
            if (!st.isDirectory()) return send(res, 400, { error: `${folder} is a file, not a folder.` });
            const nm = String(h.name || '').trim().slice(0, 40) || path.basename(folder);
            let id = nm.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            if (!/^[a-z]/.test(id)) id = ('project-' + id).replace(/-+$/, '');
            if (id === 'all') id = 'all-projects';
            id = id.slice(0, 26);
            const base = id;
            let n = 2;
            while (taken.has(id)) id = `${base}-${n++}`;
            taken.add(id);
            add.push({ id, name: nm, emoji: '📁', cwd: folder.split('\\').join('/'), description: `Works on the ${nm} folder: answers questions, makes changes and reports back.`, instructions: `Tell ${name} plainly what you changed. Ask before deleting anything.` });
          }
          fs.copyFileSync(CONFIG_PATH, path.join(DATA_DIR, 'crew.config.before-setup.json'));
          raw.settings = raw.settings || {};
          raw.settings.userName = name;
          raw.settings.allowLan = !!body.allowLan;
          delete raw.settings.needsSetup;
          raw.agents.push(...add);
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2));
          setupPending = false;
          let phoneUrl = '';
          if (body.allowLan) {
            const ip = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
            if (ip) phoneUrl = `http://${ip.address}:${settings.port}`;
          }
          if (body.autostart && process.platform === 'win32') {
            try {
              const q = (v) => String(v).replace(/'/g, "''");
              const ps = "$sh=New-Object -ComObject WScript.Shell;"
                + "$l=$sh.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude Crew tray.lnk'));"
                + "$l.TargetPath=$env:WINDIR+'\\System32\\conhost.exe';"
                + `$l.Arguments='--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "${q(path.join(ROOT, 'crew-tray.ps1'))}"';`
                + `$l.WorkingDirectory='${q(ROOT)}';$l.Save()`;
              execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 20000 });
            } catch { /* start-with-Windows is optional */ }
          }
          send(res, 200, { ok: true, phoneUrl, added: add.length });
          setTimeout(doRestart, 300);
          return;
        }
        if (url.pathname === '/api/restart' && !viaCloudflare && isLocal(req) && !body.whenIdle) {
          send(res, 200, { ok: true });
          doRestart();
          return;
        }
        // Restart the moment no agent is mid-turn (any device, including the phone). Nobody gets cut off.
        if (url.pathname === '/api/restart') {
          if (!restartWhenIdle) {
            restartWhenIdle = true;
            post({ kind: 'system', text: 'Crew will restart by itself as soon as no agent is working.' });
          }
          send(res, 200, { ok: true, whenIdle: true, waiting: busyCount() });
          return;
        }

        // ---- agents: create / edit / delete profile
        if (url.pathname.startsWith('/api/previews/')) {
          const act = url.pathname.slice('/api/previews/'.length);
          const id = String(body.id || '').toLowerCase();
          try {
            if (act === 'add') return send(res, 200, previews.upsert(body));
            if (act === 'start') return send(res, 200, await previews.start(id));
            if (act === 'stop') return send(res, 200, await previews.stop(id));
            if (act === 'restart') return send(res, 200, await previews.restart(id));
            if (act === 'remove') { await previews.remove(id); return send(res, 200, { ok: true }); }
          } catch (e) { return send(res, 400, { error: e.message }); }
          return send(res, 404, { error: 'not found' });
        }
        if (url.pathname === '/api/agents/save') {
          const id = String(body.id || '').trim().toLowerCase();
          const clean = (v, n) => String(v ?? '').trim().slice(0, n);
          const existing = byId[id];
          if (!existing && (!ID_RE.test(id) || id === 'all' || id.length > 30)) return send(res, 400, { error: 'ID: lowercase letters, digits, dashes; start with a letter ("all" is reserved)' });
          const name = clean(body.name, 40) || id;
          let cwdRaw = clean(body.cwd, 400);
          if (!cwdRaw) cwdRaw = existing ? existing.cwdRaw || existing.cwd : `workspace/${id}`;
          const cwd = path.resolve(ROOT, cwdRaw);
          const fields = { name, emoji: clean(body.emoji, 8) || '🤖', description: clean(body.description, 600), goal: clean(body.goal, 3000), instructions: clean(body.instructions, 6000), limits: clean(body.limits, 3000) };
          if (body.model !== undefined) fields.model = MODEL_CHOICES.includes(body.model) ? body.model : undefined;
          const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
          fs.copyFileSync(CONFIG_PATH, path.join(DATA_DIR, 'crew.config.before-last-profile-edit.json'));
          let rec = raw.agents.find((x) => String(x.id).toLowerCase() === id);
          if (!rec) { rec = { id, cwd: cwdRaw }; raw.agents.push(rec); }
          Object.assign(rec, fields, { cwd: cwdRaw });
          for (const k of Object.keys(rec)) if (rec[k] === undefined || (['goal', 'limits'].includes(k) && !rec[k])) delete rec[k];
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2));
          let a = existing;
          if (!a) {
            a = { ...rec, id, cwd };
            agents.push(a); byId[id] = a;
            runtime[id] = { status: 'idle', activity: '', queue: [], proc: null, busy: false, stopped: false, resetPending: false, draft: '', needsYou: null, lastModel: null };
          } else Object.assign(a, rec, { id, cwd });
          delete a.missing;
          if (!fs.existsSync(cwd)) { if (cwd.startsWith(ROOT)) fs.mkdirSync(cwd, { recursive: true }); else a.missing = true; }
          if (!fs.existsSync(path.join(cwd, 'CLAUDE.md')) && !a.missing && !existing) {
            try { fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), `# ${name}

${fields.description}
`); } catch {}
          }
          rewritePrompts();
          for (const x of agents) broadcastAgent(x);
          return send(res, 200, { ok: true, id, created: !existing });
        }
        if (url.pathname === '/api/agents/delete') {
          const id = String(body.id || '');
          if (!byId[id]) return send(res, 404, { error: 'no such agent' });
          if (id === settings.defaultAgent) return send(res, 400, { error: 'The default agent cannot be deleted' });
          stopAgent(id);
          const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
          fs.copyFileSync(CONFIG_PATH, path.join(DATA_DIR, 'crew.config.before-last-profile-edit.json'));
          raw.agents = raw.agents.filter((x) => String(x.id).toLowerCase() !== id);
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2));
          agents.splice(agents.findIndex((x) => x.id === id), 1);
          delete byId[id]; delete runtime[id]; delete promptFiles[id]; delete state.sessions[id]; delete state.models[id];
          saveState(); rewritePrompts();
          broadcast('agentgone', { id });
          return send(res, 200, { ok: true });
        }

        // ---- agents: stop, reset, model
        if ((mm = url.pathname.match(/^\/api\/agents\/([a-z0-9-]+)\/(stop|reset|model)$/)) && byId[mm[1]]) {
          const a = byId[mm[1]];
          if (mm[2] === 'stop') stopWithSweep(a.id);
          else if (mm[2] === 'reset') resetAgent(a);
          else {
            const choice = body.model || null;
            if (choice && !MODEL_CHOICES.includes(choice)) return send(res, 400, { error: 'unknown model' });
            if (choice) state.models[a.id] = choice; else delete state.models[a.id];
            saveState();
            broadcastAgent(a);
          }
          return send(res, 200, { ok: true, pending: runtime[a.id].resetPending });
        }

        // ---- answer or dismiss a question in the "Waiting on you" box
        if (url.pathname === '/api/ask/answer' || url.pathname === '/api/ask/dismiss') {
          const k = asks.find((x) => x.id === body.id);
          if (!k) return send(res, 404, { error: 'That question was already answered.' });
          asks = asks.filter((x) => x.id !== k.id);
          saveAsks();
          if (url.pathname === '/api/ask/dismiss' || !byId[k.agent]) return send(res, 200, { ok: true });
          const choice = String(body.choice || '').trim().slice(0, 500);
          if (!choice) return send(res, 400, { error: 'empty' });
          const text = `@${k.agent} Re "${trunc(k.q, 120)}": ${choice}`;
          const sent = post({ from: 'user', text, to: [k.agent] });
          enqueue(k.agent, { fromId: 'user', hop: 0, msgId: sent.id,
            text: `Answer to your question "${k.q}": ${choice}. Act on it now; do not ask again.` });
          return send(res, 200, { ok: true });
        }

        // ---- approve a permission an agent was refused, and let it continue
        if (url.pathname === '/api/approve') {
          const m = history.find((x) => x.id === body.id);
          if (!m?.denials?.length || !byId[m.from]) return send(res, 404, { error: 'Nothing to approve on that message.' });
          if (state.flags[m.id]?.approved) return send(res, 409, { error: 'Already approved.' });
          const a = byId[m.from];
          setFlag(m.id, { approved: Date.now() });
          const labels = m.denials.map((d) => d.label).join(', ');
          if (body.always) {
            // Remember it for good (this agent only): broaden a script run to "that script, any arguments".
            state.alwaysAllow = state.alwaysAllow || {};
            const list = state.alwaysAllow[a.id] = state.alwaysAllow[a.id] || [];
            for (const d of m.denials) {
              let rule = d.rule;
              const bm = /^(Bash|PowerShell)\((.*)\)$/s.exec(rule);
              if (bm) {
                const t = bm[2].trim().split(/\s+/);
                if (/^(python3?|py|node)$/i.test(t[0]) && t[1] && !t[1].startsWith('-')) rule = `${bm[1]}(${t[0]} ${t[1]}:*)`;
              }
              if (!list.includes(rule)) list.push(rule);
            }
            saveState();
          }
          post({ from: 'user', text: `✅ ${body.always ? 'Always allowed' : 'Approved'} for ${a.name}: ${labels}`, to: [a.id] });
          enqueue(a.id, {
            fromId: 'user', hop: 0, allow: m.denials.map((d) => d.rule),
            text: `Approved: you may now ${labels}. Please continue where you left off.`,
          });
          return send(res, 200, { ok: true });
        }
        // ---- Blocked board: wake the teammate a stuck item is waiting on
        if (url.pathname === '/api/status/nudge') {
          const t = byId[body.agent];
          if (!t) return send(res, 404, { error: 'Unknown agent.' });
          const note = String(body.note || '').slice(0, 600);
          const text = `${settings.userName} pressed "Wake" on the Blocked board: someone is waiting on you. ${note ? `The STATUS line says: "${note}". ` : ''}Check STATUS.md (tail -30), do the part that is yours, and stop when done.`;
          if (localCfg.load().nightOnlyAgents.includes(t.id) && !localCfg.isNight()) {
            return send(res, 409, { error: `${t.name} only runs at night. Its queue is worked at 11 PM.` });
          }
          post({ from: 'user', text: `⏰ Woke ${t.name} from the Blocked board.`, to: [t.id] });
          enqueue(t.id, { fromId: 'user', hop: 0, text });
          return send(res, 200, { ok: true });
        }
        // ---- say no to a refused tool call: just clears it from "Waiting on you"
        if (url.pathname === '/api/deny') {
          const m = history.find((x) => x.id === body.id);
          if (!m?.denials?.length || !byId[m.from]) return send(res, 404, { error: 'Nothing to deny on that message.' });
          if (!state.flags[m.id]?.approved) setFlag(m.id, { denied: Date.now() });
          const r = runtime[m.from];
          if (r.needsYou?.msgId === m.id) { r.needsYou = null; broadcastAgent(byId[m.from]); }
          return send(res, 200, { ok: true });
        }

        // ---- undo a turn's file changes
        if ((mm = url.pathname.match(/^\/api\/changes\/([\w-]+)\/undo$/))) {
          const m = history.find((x) => x.id === mm[1]);
          if (!m?.changes?.repo) return send(res, 404, { error: 'Undo isn\'t available for this message.' });
          if (state.flags[m.id]?.undone) return send(res, 409, { error: 'Already undone.' });
          const a = byId[m.from];
          if (a && runtime[a.id].busy) return send(res, 409, { error: `${a.name} is working right now. Stop it or wait, then undo.` });
          const result = await changes.undo(m.changes);
          setFlag(m.id, { undone: { at: Date.now(), ...result } });
          const skipped = result.skipped.length ? ` Skipped ${result.skipped.length}: ${result.skipped.map((s) => `${s.path} (${s.why})`).join('; ')}.` : '';
          post({ kind: 'system', text: `↩ Undid ${result.done.length} file change(s) from ${a?.name || 'that'} turn.${skipped}` });
          return send(res, 200, { ok: true, ...result });
        }

        // ---- usage budget guard
        if (url.pathname === '/api/prefs') {
          const k = String(body.key || '');
          if (!/^crew-[\w-]{1,40}$/.test(k) || typeof body.value !== 'string' || body.value.length > 20000) return send(res, 400, { error: 'bad pref' });
          let all = {}; try { all = JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')); } catch {}
          all[k] = body.value;
          fs.writeFileSync(PREFS_PATH, JSON.stringify(all, null, 2));
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/pin') {
          const id = String(body.id || '');
          if (!id) return send(res, 400, { error: 'id required' });
          const at = pins.findIndex((p) => p.id === id);
          if (at >= 0) pins.splice(at, 1);
          else {
            const pm = history.find((m) => m.id === id);
            if (!pm) return send(res, 404, { error: 'message not found' });
            pins.unshift({ id, from: pm.from, ts: pm.ts, text: String(pm.text || '').slice(0, 20000), pinnedAt: Date.now() });
          }
          try { fs.writeFileSync(PINS_PATH, JSON.stringify(pins)); } catch {}
          broadcast('pins', pins);
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/react') {
          const id = String(body.id || ''), emoji = String(body.emoji || '').slice(0, 8);
          if (!id || !emoji) return send(res, 400, { error: 'id and emoji required' });
          const cur = new Set(reactions[id] || []);
          if (cur.has(emoji)) cur.delete(emoji); else cur.add(emoji);
          if (cur.size) reactions[id] = [...cur]; else delete reactions[id];
          try { fs.writeFileSync(REACT_PATH, JSON.stringify(reactions)); } catch {}
          broadcast('reactions', { id, list: reactions[id] || [] });
          // Agents see it: a reaction the owner ADDS to an agent's message is delivered to that agent.
          const rm = history.find((m) => m.id === id);
          if (rm && cur.has(emoji) && rm.from && rm.from !== 'user' && byId[rm.from] && !byId[rm.from].missing) {
            const meaning = { '👍': 'yes / approved / go ahead', '❤️': 'love it, great work', '😂': 'funny', '🎉': 'celebrate, nicely done', '👀': 'seen, looking at it', '🤔': 'unsure, needs a rethink or explanation', '🔥': 'excellent', '😬': 'concern, that worries me' }[emoji] || '';
            const quote = String(rm.text || '').replace(/\s+/g, ' ').slice(0, 300);
            enqueue(rm.from, { fromId: 'user', text: `[the owner reacted ${emoji}${meaning ? ' (' + meaning + ')' : ''} to your message: "${quote}"]
Treat this as the owner's answer to that message. If it was a question or plan awaiting approval, 👍 means yes: proceed. Reply only if you take action or need to clarify; do not just acknowledge.`, hop: 0 });
          }
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/notes') {
          const g = String(body.group || '').slice(0, 60), items = Array.isArray(body.items) ? body.items.slice(0, 500) : null;
          if (!g || !items) return send(res, 400, { error: 'group and items required' });
          let all = {}; try { all = JSON.parse(fs.readFileSync(NOTES_PATH, 'utf8')); } catch {}
          all[g] = items.map((i) => ({ text: String(i.text || '').slice(0, 500), done: !!i.done }));
          fs.writeFileSync(NOTES_PATH, JSON.stringify(all, null, 2));
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/budget') {
          usage.setBudget(body);
          pump();
          broadcastUsage();
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/budget/override') {
          usage.override();
          post({ kind: 'system', text: 'Running held work anyway, until this usage window resets.' });
          pump();
          broadcastUsage();
          return send(res, 200, { ok: true });
        }

        // ---- scheduled jobs
        const ids = agents.map((a) => a.id);
        if (url.pathname === '/api/schedules') {
          try { scheduler.add(body, ids); } catch (e) { return send(res, 400, { error: e.message }); }
          broadcast('schedules', scheduler.list());
          return send(res, 200, { ok: true });
        }
        if ((mm = url.pathname.match(/^\/api\/schedules\/([\w-]+)(?:\/(delete|run))?$/))) {
          try {
            if (mm[2] === 'delete') scheduler.remove(mm[1]);
            else if (mm[2] === 'run') scheduler.runNow(mm[1]);
            else scheduler.update(mm[1], body, ids);
          } catch (e) { return send(res, 400, { error: e.message }); }
          broadcast('schedules', scheduler.list());
          return send(res, 200, { ok: true });
        }

        // ---- phone notifications
        if (url.pathname === '/api/machines/pair') return send(res, 200, presence.newPairCode());
        if (url.pathname === '/api/machines/connect') {
          try {
            const hubUrl = await pairOnce({ hubUrl: body.url, pairCode: body.code, cfClientId: body.cfClientId, cfClientSecret: body.cfClientSecret,
              file: presenceClientFile, name: rawCfg.machineName || os.hostname(), version: VERSION, activity: () => 'idle' });
            const hub = { url: hubUrl };
            if (body.cfClientId && body.cfClientSecret) { hub.cfClientId = body.cfClientId; hub.cfClientSecret = body.cfClientSecret; }
            savePresenceHub(hub);
            startPresenceClient(hub);
            return send(res, 200, { ok: true, url: hubUrl });
          } catch (e) { return send(res, 400, { error: e.message }); }
        }
        if (url.pathname === '/api/machines/disconnect') {
          clearInterval(presenceTimer);
          try { fs.unlinkSync(presenceClientFile); } catch { /* not paired */ }
          savePresenceHub(null);
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/machines/remove') { presence.remove(String(body.id || '')); return send(res, 200, { ok: true }); }
        if (url.pathname === '/api/push/subscribe') {
          try { push.subscribe(body.subscription || {}, body.label); } catch (e) { return send(res, 400, { error: e.message }); }
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/push/unsubscribe') {
          push.unsubscribe(String(body.endpoint || ''));
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/push/test') {
          if (!push.has(String(body.endpoint || ''))) return send(res, 404, { error: 'This device isn\'t subscribed.' });
          const r = await push.notify({ title: 'Claude Crew', body: 'Notifications are working on this device. 🎉', tag: 'crew-test', url: '/' }, { only: body.endpoint });
          return send(res, 200, { ok: true, status: r[0] });
        }
      }
      send(res, 404, { error: req.method === 'POST' && wantsJson ? 'Crew needs a restart to use this.' : 'not found' });
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  };
}

function listen(server, port, host, what) {
  return new Promise((resolve) => {
    server.on('error', (err) => {
      console.error(err.code === 'EADDRINUSE'
        ? `Port ${port} (${what}) is already in use. Is Crew already running? Otherwise change it in crew.config.json.`
        : err);
      process.exit(1);
    });
    server.listen(port, host, resolve);
  });
}

(async () => {
  const local = `http://localhost:${settings.port}`;
  const localServer = http.createServer(makeHandler('local'));
  localServer.on('upgrade', makeUpgradeHandler('local'));
  await listen(localServer, settings.port, settings.allowLan ? '0.0.0.0' : '127.0.0.1', 'local');
  if (cf) {
    // Loopback only: the tunnel runs on this PC, nothing else should reach this port.
    const cfServer = http.createServer(makeHandler('cloudflare'));
    cfServer.on('upgrade', makeUpgradeHandler('cloudflare'));
    await listen(cfServer, cf.port, '127.0.0.1', 'Cloudflare');
  }
  previews.boot().catch((err) => console.log('  !! previews failed to start: ' + err.message));

  scheduler.start();
  try {
    const st = autos.start();
    post({ kind: 'system', text: `⚡ Automations live: ${st.rules} rules on${st.resumed ? `, ${st.resumed} waits resumed` : ''}.` });
  } catch (err) { console.log('  !! automations failed to start: ' + err.message); }
  updater.start();
  pump(); // anything carried over from a restart
  if (rawCfg.presenceHub?.url) startPresenceClient(rawCfg.presenceHub);
  console.log(`\n  Claude Crew is running: ${local}`);
  console.log(`  Claude Code: ${CLAUDE}`);
  for (const a of agents) console.log(`  ${a.missing ? '!!' : '  '} @${a.id.padEnd(12)} ${a.cwd}${a.missing ? '  (folder not found)' : ''}`);
  if (settings.allowLan) {
    console.log('\n  From your phone (same Wi-Fi):');
    for (const ip of lanAddresses()) console.log(`    http://${ip}:${settings.port}`);
    console.log(`  Access key: ${state.accessKey}`);
  }
  if (cf) {
    console.log(`\n  Internet: https://${cf.hostname}  (Cloudflare tunnel -> http://localhost:${cf.port})`);
    console.log(`  Allowed: ${cf.allowedEmails.join(', ')}`);
    try {
      await loadAccessKeys(false);
      console.log(`  Cloudflare Access keys loaded from ${cf.teamDomain}`);
    } catch (err) {
      console.log(`  !! ${err.message}. Check "teamDomain" in crew.config.json.`);
    }
  }
  console.log(process.stdout.isTTY
    ? '\n  Leave this window open. Close it (or Ctrl+C) to stop Crew.\n'
    : '\n  Running in the background. Use the Crew tray icon to open or restart it.\n');
  if (process.argv.includes('--open') && process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', local], () => {});
  }
})();
