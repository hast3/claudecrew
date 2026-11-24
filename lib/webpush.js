'use strict';
// Web Push for Claude Crew, with no dependencies:
//   RFC 8291 message encryption (aes128gcm) + RFC 8292 VAPID signing.
// Your phone's browser gives us a "subscription" (a push-service URL plus keys);
// we encrypt each notification so only that browser can read it, and sign the
// request with our VAPID key so the push service knows it's from this server.

const crypto = require('crypto');
const fs = require('fs');

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function loadKeys(file) {
  try {
    const k = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (k.publicKey && k.privateKey) return k;
  } catch { /* create below */ }
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const k = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
  fs.writeFileSync(file, JSON.stringify(k, null, 2), { mode: 0o600 });
  return k;
}

function privateKeyObject(keys) {
  const pub = Buffer.from(keys.publicKey, 'base64url');
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
}

function vapidAuth(endpoint, keys, keyObj, subject) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: keyObj, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

// RFC 8291: encrypt `payload` for one browser subscription.
function encrypt(payload, subscription) {
  const uaPublic = Buffer.from(subscription.keys.p256dh, 'base64url');
  const authSecret = Buffer.from(subscription.keys.auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret,
    Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head.writeUInt8(asPublic.length, 20);
  return Buffer.concat([head, asPublic, body]);
}

function createPush({ keyFile, subsFile, subject }) {
  const keys = loadKeys(keyFile);
  const keyObj = privateKeyObject(keys);
  let subs = [];
  try { subs = JSON.parse(fs.readFileSync(subsFile, 'utf8')); } catch { /* none yet */ }
  const save = () => fs.writeFileSync(subsFile, JSON.stringify(subs, null, 2), { mode: 0o600 });

  function valid(s) {
    try {
      const u = new URL(s.endpoint);
      return u.protocol === 'https:' && Buffer.from(s.keys.p256dh, 'base64url').length === 65
        && Buffer.from(s.keys.auth, 'base64url').length >= 16;
    } catch { return false; }
  }

  async function sendOne(sub, payload) {
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
        Urgency: 'high',
        Authorization: vapidAuth(sub.endpoint, keys, keyObj, subject),
      },
      body: encrypt(payload, sub),
      signal: AbortSignal.timeout(15e3),
    });
    return r.status;
  }

  return {
    publicKey: keys.publicKey,
    count: () => subs.length,
    has: (endpoint) => subs.some((s) => s.endpoint === endpoint),
    subscribe(sub, label) {
      if (!valid(sub)) throw new Error('Invalid push subscription');
      subs = subs.filter((s) => s.endpoint !== sub.endpoint);
      subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, label: String(label || '').slice(0, 80), added: Date.now() });
      save();
    },
    unsubscribe(endpoint) {
      subs = subs.filter((s) => s.endpoint !== endpoint);
      save();
    },
    // payload: { title, body, tag, url }
    async notify(payload, { only } = {}) {
      const json = JSON.stringify(payload).slice(0, 3000);
      const targets = only ? subs.filter((s) => s.endpoint === only) : subs;
      const results = await Promise.all(targets.map(async (s) => {
        try {
          const status = await sendOne(s, json);
          if (status === 404 || status === 410) { subs = subs.filter((x) => x !== s); save(); }
          return status;
        } catch (e) {
          return e.message;
        }
      }));
      return results;
    },
  };
}

module.exports = { createPush, encrypt, _vapidAuth: vapidAuth, _privateKeyObject: privateKeyObject };
