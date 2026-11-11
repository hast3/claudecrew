'use strict';
// Integrations overview: what is linked to Crew and which agents can reach it.
// Read-only. Secret VALUES are never read out, only the names of variables that are set.
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const TTL = 120000;
const run = (cmd, args, opts = {}) => new Promise((res) => {
  execFile(cmd, args, { encoding: 'utf8', timeout: 45000, windowsHide: true, ...opts }, (e, out) => res(e && !out ? '' : String(out || '')));
});

// Which service a secret-looking variable name probably belongs to.
const SERVICE_HINTS = [
  [/ANTHROPIC|CLAUDE/i, 'Anthropic'], [/OPENAI/i, 'OpenAI'], [/XAI|GROK/i, 'xAI / Grok'], [/GEMINI|GOOGLE/i, 'Google'],
  [/LEONARDO/i, 'Leonardo AI'], [/TELEGRAM|TG_/i, 'Telegram'], [/HASS|HOME_?ASSISTANT|\bHA_/i, 'Home Assistant'],
];
const hint = (n) => (SERVICE_HINTS.find(([re]) => re.test(n)) || [0, ''])[1];

function parseMcp(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(.+?):\s+(.+?)\s+-\s+(.*)$/);
    if (!m || /^Checking/i.test(line)) continue;
    const st = m[3];
    out.push({
      name: m[1].trim(), target: m[2].trim(),
      status: /✔|connected/i.test(st) && !/not/i.test(st) ? 'ok' : /auth/i.test(st) ? 'auth' : 'bad',
      statusText: st.replace(/^[^\w]+/, '').trim(),
    });
  }
  return out;
}

function createIntegrations({ getAgents, getConfig, pushCount, machines }) {
  let cache = null; let at = 0; let pending = null;

  async function mcpFor(cwd) {
    const cfg = getConfig();
    const exe = cfg.settings?.claudePath || 'claude';
    const text = await run(exe, ['mcp', 'list'], { cwd, shell: /\.(cmd|bat)$/i.test(exe) });
    return parseMcp(text);
  }

  async function envKeys() {
    const names = new Set();
    for (const k of Object.keys(process.env)) names.add(k);
    const reg = await run('reg', ['query', 'HKCU\Environment']);
    for (const line of reg.split(/\r?\n/)) { const m = line.match(/^\s+(\S+)\s+REG_/); if (m) names.add(m[1]); }
    return [...names].filter((n) => /KEY|TOKEN|SECRET|PASSWORD|API/i.test(n) && !/^(PATH|PSModule|KEYBOARD)/i.test(n)).sort()
      .map((n) => ({ name: n, service: hint(n) }));
  }

  async function services() {
    const list = [];
    const cfg = getConfig();
    const cf = cfg.cloudflare || {};
    const sc = await run('sc', ['query', 'cloudflared']);
    const state = (sc.match(/STATE\s*:\s*\d+\s+(\w+)/) || [])[1] || 'NOT INSTALLED';
    list.push({
      name: 'Cloudflare tunnel', status: state === 'RUNNING' ? 'ok' : 'bad',
      detail: `${cf.hostname || ''} · service ${state.toLowerCase()}`,
      access: `Only ${(cf.allowedEmails || []).join(', ') || 'nobody'} can sign in (Cloudflare Access).`,
    });
    list.push({ name: 'Phone notifications (web push)', status: pushCount() ? 'ok' : 'idle', detail: `${pushCount()} device(s) subscribed`, access: 'Sends alerts to subscribed devices only.' });
    const ms = machines ? machines() : [];
    list.push({ name: 'Other PCs running Crew', status: ms.some((m) => m.online) ? 'ok' : 'idle', detail: `${ms.length} machine(s), ${ms.filter((m) => m.online).length} online`, access: 'Paired by one-time code.' });
    const st = await run('schtasks', ['/Query', '/FO', 'CSV', '/NH']);
    const tasks = st.split(/\r?\n/).map((l) => l.split('","').map((s) => s.replace(/"/g, ''))).filter((c) => /Crew/i.test(c[0] || ''));
    for (const t of tasks) list.push({ name: 'Task: ' + path.basename(t[0]), status: /disabled/i.test(t[2]) ? 'idle' : 'ok', detail: `next run ${t[1]} · ${t[2]}`, access: 'Windows scheduled task.' });
    return list;
  }

  async function build() {
    const agents = getAgents();
    const byCwd = new Map();
    for (const a of agents) {
      const cwd = path.resolve(a.cwd);
      if (!fs.existsSync(cwd)) continue;
      if (!byCwd.has(cwd)) byCwd.set(cwd, []);
      byCwd.get(cwd).push(a.id);
    }
    const mcp = new Map(); // server name -> { ...info, agents: [] }
    const entries = [...byCwd.entries()];
    for (let i = 0; i < entries.length; i += 3) { // 3 at a time
      await Promise.all(entries.slice(i, i + 3).map(async ([cwd, ids]) => {
        for (const s of await mcpFor(cwd)) {
          const cur = mcp.get(s.name) || { ...s, agents: [] };
          cur.agents.push(...ids);
          mcp.set(s.name, cur);
        }
      }));
    }
    const [keys, svc] = await Promise.all([envKeys(), services()]);
    return {
      builtAt: Date.now(),
      permissionMode: getConfig().settings?.permissionMode || 'default',
      allAgents: agents.map((a) => a.id),
      mcp: [...mcp.values()].map((m) => ({ ...m, agents: [...new Set(m.agents)] })),
      services: svc, keys,
    };
  }

  return {
    async get(force) {
      if (!force && cache && Date.now() - at < TTL) return cache;
      if (!pending) pending = build().then((r) => { cache = r; at = Date.now(); return r; }).finally(() => { pending = null; });
      return pending;
    },
  };
}

module.exports = { createIntegrations, parseMcp };
