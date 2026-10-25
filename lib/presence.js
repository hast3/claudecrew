'use strict';
// Machines + presence: which computers run Crew, and whether they are online right now.
// One Crew install is the hub. Other installs pair once with a short code, then send a
// small signed-in heartbeat every 30 s. A machine is "online" if the hub heard from it
// in the last 90 s. Stored in data/presence.json (hub) and data/presence-client.json (client).

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const ONLINE_MS = 90e3;
const BEAT_MS = 30e3;
const PAIR_TTL = 10 * 60e3;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const clean = (s, n = 80) => String(s || '').replace(/[^\w.\-@ ()]+/g, '').trim().slice(0, n);

function createPresence({ file, selfId, selfName, version }) {
  let db = { machines: {} };
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  db.machines = db.machines || {};
  const save = () => fs.writeFileSync(file, JSON.stringify(db, null, 2));
  let pairing = null; // { code, exp }  (memory only: a restart cancels it)
  let fails = { n: 0, until: 0 };
  const hubInfo = { activity: '' };

  function newPairCode() {
    pairing = { code: crypto.randomBytes(4).toString('hex').toUpperCase(), exp: Date.now() + PAIR_TTL };
    return { code: pairing.code, expiresAt: pairing.exp };
  }

  function pair({ code, name, os: osName, version: v }) {
    if (Date.now() < fails.until) throw new Error('Too many wrong codes. Try again in a few minutes.');
    const ok = pairing && Date.now() < pairing.exp && String(code || '').toUpperCase() === pairing.code;
    if (!ok) {
      if (++fails.n >= 5) fails = { n: 0, until: Date.now() + 10 * 60e3 };
      throw new Error('That pairing code is wrong or expired.');
    }
    fails.n = 0;
    pairing = null; // one use
    const id = crypto.randomUUID();
    const secret = crypto.randomBytes(24).toString('base64url');
    db.machines[id] = {
      name: clean(name) || 'Computer', os: clean(osName), version: clean(v, 20), activity: '',
      pairedAt: Date.now(), lastSeen: Date.now(), secretHash: sha(secret),
    };
    save();
    return { id, secret };
  }

  function beat({ id, secret, name, os: osName, version: v, activity }) {
    const m = db.machines[String(id)];
    const a = Buffer.from(sha(secret)), b = Buffer.from(m ? m.secretHash : sha('x'));
    if (!m || !crypto.timingSafeEqual(a, b)) throw new Error('unknown machine');
    m.lastSeen = Date.now();
    if (name) m.name = clean(name) || m.name;
    m.os = clean(osName) || m.os;
    m.version = clean(v, 20) || m.version;
    m.activity = clean(activity, 60);
    save();
  }

  const remove = (id) => { delete db.machines[id]; save(); };

  function list() {
    const now = Date.now();
    const rows = Object.entries(db.machines).map(([id, m]) => ({
      id, name: m.name, os: m.os, version: m.version, activity: m.activity,
      lastSeen: m.lastSeen, online: now - m.lastSeen < ONLINE_MS, hub: false,
    }));
    rows.sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
    return [{
      id: selfId, name: selfName, os: `${os.type()} ${os.release()}`, version, activity: hubInfo.activity,
      lastSeen: now, online: true, hub: true,
    }, ...rows];
  }

  return { newPairCode, pair, beat, remove, list, setActivity: (t) => { hubInfo.activity = clean(t, 60); } };
}

// Client side: send heartbeats to the hub. Pairs itself the first time using the code.
function startClient({ hubUrl, pairCode, cfClientId, cfClientSecret, file, name, version, activity, log }) {
  hubUrl = String(hubUrl).replace(/\/+$/, '');
  let creds = null;
  try { creds = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not paired yet */ }
  const hdr = { 'Content-Type': 'application/json', 'X-Crew': '1' };
  // Only needed when the hub is behind Cloudflare Access (a "service token" lets a machine through).
  if (cfClientId && cfClientSecret) { hdr['CF-Access-Client-Id'] = cfClientId; hdr['CF-Access-Client-Secret'] = cfClientSecret; }
  const info = () => ({ name, os: `${os.type()} ${os.release()}`, version, activity: activity() });

  async function post(p, body) {
    const r = await fetch(hubUrl + p, { method: 'POST', headers: hdr, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status });
    return j;
  }

  async function tick() {
    try {
      if (!creds) {
        if (!pairCode) return;
        creds = await post('/api/presence/pair', { code: pairCode, ...info() });
        fs.writeFileSync(file, JSON.stringify(creds));
        log(`  Paired with the Crew hub at ${hubUrl}`);
      }
      await post('/api/presence/beat', { ...creds, ...info() });
    } catch (e) {
      if (e.status === 401 && creds) { creds = null; try { fs.unlinkSync(file); } catch { /* gone */ } }
      log(`  Presence: ${e.message}`);
    }
  }
  tick();
  return setInterval(tick, BEAT_MS).unref();
}

module.exports = { createPresence, startClient };
