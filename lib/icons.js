'use strict';
// Draws Crew's app icon (a brass gear with a compass rose, matching the agent avatars)
// and writes it as PNGs for the phone home screen. Run: node lib/icons.js
// No image libraries: a tiny supersampled rasterizer and a minimal PNG encoder.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * Math.min(1, Math.max(0, t)));

const BG = hex('#1F1E1D');
const BRASS_LIGHT = hex('#F7DC8C');
const BRASS_DARK = hex('#6B4413');
const RING = hex('#3A2410');
const RIM = hex('#E8C26A');
const FACE_IN = hex('#1F3A3A');
const FACE_OUT = hex('#0C1A1C');
const GOLD_LIGHT = hex('#FFE9A8');
const GOLD_DARK = hex('#C98A2A');
const HUB = hex('#2A1A08');

function gearRadius(theta, n, r, R) {
  const period = (Math.PI * 2) / n;
  const ph = (((theta % period) + period) % period) / period;
  const u = Math.min(ph, 1 - ph) * 2; // 0 at tooth centre, 1 midway between teeth
  if (u < 0.3) return R;
  if (u < 0.5) return R + (r - R) * ((u - 0.3) / 0.2);
  return r;
}

// Colour at normalised point (x, y) in [0, 1].
function shade(x, y) {
  const dx = x - 0.5;
  const dy = y - 0.5;
  const d = Math.hypot(dx, dy);
  const th = Math.atan2(dy, dx);

  if (d < 0.03) return d < 0.022 ? HUB : GOLD_DARK;
  // Compass rose: four diamond points around the hub.
  const along = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = along[i];
    const a = dx * ax + dy * ay;
    const p = Math.abs(dx * -ay + dy * ax);
    const len = 0.19;
    if (a >= 0 && a <= len && p <= 0.05 * (1 - a / len)) {
      return mix(GOLD_LIGHT, GOLD_DARK, (i % 2 ? 0.55 : 0) + a / len * 0.45);
    }
  }
  if (d < 0.255) return mix(FACE_IN, FACE_OUT, (d / 0.255) + (dx + dy) * 0.6);
  if (d < 0.262) return hex('#8A5A1C');
  if (d < 0.305) return RING;
  if (d < 0.312) return RIM;
  if (d <= gearRadius(th, 14, 0.36, 0.43)) return mix(BRASS_LIGHT, BRASS_DARK, 0.45 + (dx + dy) * 1.2 + (d - 0.36) * 1.5);
  return BG;
}

function render(size, ss = 4) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
        }
      }
      const i = (y * size + x) * 4;
      px[i] = Math.round(acc[0] / (ss * ss));
      px[i + 1] = Math.round(acc[1] / (ss * ss));
      px[i + 2] = Math.round(acc[2] / (ss * ss));
      px[i + 3] = 255;
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (require.main === module) {
  const out = path.join(__dirname, '..', 'public');
  for (const [name, size] of [['icon-512.png', 512], ['icon-192.png', 192], ['apple-touch-icon.png', 180], ['badge-96.png', 96]]) {
    fs.writeFileSync(path.join(out, name), png(size, render(size)));
    console.log('wrote', name);
  }
}

module.exports = { render, png };
