// Builds public/brand/crew-icon.svg: a ship finishing a "C" of tapered exhaust trail.
const fs = require('fs');
const path = require('path');

const cx = 236, cy = 258, r = 150;
const start = 318, end = 42;           // degrees; trail runs counterclockwise: top-right -> top -> left -> bottom -> lower right
const sweep = (start - end);           // 276 degrees
const N = 120;
const sky = [22, 21, 42];
const lo = [170, 88, 64], mid = [217, 119, 87], hi = [255, 214, 170];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
const ease = t => t * t * (3 - 2 * t);

function pt(deg, rad) { const a = deg * Math.PI / 180; return [cx + rad * Math.cos(a), cy + rad * Math.sin(a)]; }
const f = n => n.toFixed(1);

function band(widthAt, colorAt, from = 0) {
  let out = '';
  for (let i = Math.floor(from * N); i < N; i++) {
    const t0 = i / N, t1 = (i + 1) / N, tm = (t0 + t1) / 2;
    const a0 = start - sweep * t0, a1 = start - sweep * t1 - 0.4; // tiny overlap hides seams
    const w0 = widthAt(t0) / 2, w1 = widthAt(t1) / 2;
    const p = [pt(a0, r + w0), pt(a1, r + w1), pt(a1, r - w1), pt(a0, r - w0)];
    out += `<path d="M${p.map(q => f(q[0]) + ' ' + f(q[1])).join(' L')}Z" fill="${colorAt(tm)}"/>`;
  }
  return out;
}

const trailW = t => 12 + 30 * ease(t);
const trailC = t => {
  const c = t < 0.6 ? mix(lo, mid, t / 0.6) : mix(mid, hi, (t - 0.6) / 0.4);
  return hex(mix(sky, c, Math.min(1, 0.5 + t * 1.0)));
};
const coreW = t => 2 + 12 * ease((t - 0.45) / 0.55);
const coreC = t => hex(mix([233, 150, 112], [255, 247, 232], (t - 0.45) / 0.55));

// ship: nose points along the direction of travel at the end of the trail
const [px, py] = pt(end, r);
const dirDeg = end;                    // counterclockwise travel at angle a points (sin a, -cos a) => rotate(a)
const s = 1.25;
const d = [Math.sin(end * Math.PI / 180), -Math.cos(end * Math.PI / 180)];
const shipX = px + d[0] * 40 * s, shipY = py + d[1] * 40 * s;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="sky" cx="38%" cy="30%" r="85%">
      <stop offset="0" stop-color="#2b2a40"/><stop offset=".55" stop-color="#16152a"/><stop offset="1" stop-color="#0b0a14"/>
    </radialGradient>
    <linearGradient id="hull" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset=".6" stop-color="#d9dbe6"/><stop offset="1" stop-color="#8f93a8"/>
    </linearGradient>
    <radialGradient id="flame" cx="50%" cy="35%" r="65%">
      <stop offset="0" stop-color="#fffaf0"/><stop offset=".4" stop-color="#ffc58a"/><stop offset="1" stop-color="#d97757" stop-opacity="0"/>
    </radialGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="10"/></filter>
  </defs>
  <rect width="512" height="512" rx="${process.argv[3] === 'square' ? 0 : 112}" fill="url(#sky)"/>
  <g fill="#fff">
    <circle cx="92" cy="106" r="2.2" opacity=".75"/><circle cx="318" cy="70" r="1.7" opacity=".6"/><circle cx="448" cy="160" r="2.4" opacity=".8"/>
    <circle cx="430" cy="430" r="1.5" opacity=".5"/><circle cx="128" cy="440" r="1.8" opacity=".55"/><circle cx="58" cy="290" r="1.3" opacity=".5"/>
    <circle cx="250" cy="250" r="1.4" opacity=".35"/><circle cx="470" cy="330" r="1.2" opacity=".45"/>
  </g>
  <g filter="url(#glow)" opacity=".45">${band(t => trailW(t) * 1.6, t => hex(mix(sky, mid, Math.min(1, t * 1.3))), 0.25)}</g>
  <circle cx="${f(pt(start, r)[0])}" cy="${f(pt(start, r)[1])}" r="${trailW(0) / 2}" fill="${trailC(0)}"/>
  <g>${band(trailW, trailC)}</g>
  <g>${band(coreW, coreC, 0.46)}</g>
  <circle cx="${f(px + d[0] * 10)}" cy="${f(py + d[1] * 10)}" r="30" fill="#ffb070" opacity=".35" filter="url(#glow)"/>
  <g transform="translate(${f(shipX)} ${f(shipY)}) rotate(${dirDeg}) scale(${s})">
    <ellipse cx="0" cy="44" rx="12" ry="22" fill="url(#flame)"/>
    <path d="M0 -70 C9 -48 13 -20 14 6 L44 34 L46 42 L14 30 L10 36 L-10 36 L-14 30 L-46 42 L-44 34 L-14 6 C-13 -20 -9 -48 0 -70Z" fill="url(#hull)"/>
    <path d="M14 8 L44 34 L46 42 L14 30Z" fill="#d97757"/><path d="M-14 8 L-44 34 L-46 42 L-14 30Z" fill="#b8613f"/>
    <path d="M0 -70 C9 -48 13 -20 14 6 L0 2Z" fill="#ffffff" opacity=".5"/>
    <path d="M0 -46 C5 -36 6 -26 5 -16 L-5 -16 C-6 -26 -5 -36 0 -46Z" fill="#1d1c33"/>
    <path d="M-1 -40 C1 -34 1 -28 0 -22" stroke="#9fb4ff" stroke-width="2" fill="none" opacity=".85"/>
    <rect x="-9" y="33" width="18" height="6" rx="2.5" fill="#5b5f78"/>
  </g>
</svg>
`;
const out = process.argv[2] || path.join(__dirname, '..', 'public', 'brand', 'crew-icon.svg');
fs.writeFileSync(out, svg);
console.log('wrote', out);
