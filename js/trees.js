import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { V, sweep, path, ellipse, canvasTex, rng } from './geom.js';

// 遊戲常用的「葉片卡」樹：程式生成樹幹與枝條，樹冠由大量帶 alpha 的葉叢面片組成。
// 葉片法線朝樹冠中心外指（球面法線），光照柔和有體積感；內層與下方以頂點色壓暗。

// ---------- 葉叢貼圖（2×2 圖集，四種變化） ----------
function leafCluster(ctx, cx, cy, R, rand, needle) {
  // 底層柔邊葉團：讓貼圖縮小（mipmap）後仍保有足夠不透明度，遠處樹冠不會變稀疏
  for (let i = 0; i < 7; i++) {
    const a = rand() * Math.PI * 2, d = R * 0.35 * rand(), r = R * (0.45 + rand() * 0.25);
    const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const base = needle ? '28,52,34' : '44,78,30';
    g.addColorStop(0, `rgba(${base},0.95)`); g.addColorStop(0.6, `rgba(${base},0.8)`); g.addColorStop(1, `rgba(${base},0)`);
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // 細枝
  ctx.strokeStyle = 'rgba(74,58,40,0.9)';
  for (let i = 0; i < 6; i++) {
    const a = rand() * Math.PI * 2;
    ctx.lineWidth = 2 + rand() * 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * R * 0.8, cy + Math.sin(a) * R * 0.8); ctx.stroke();
  }
  const n = needle ? 700 : 420;
  for (let i = 0; i < n; i++) {
    const r = R * Math.sqrt(rand()) * 0.95, a = rand() * Math.PI * 2;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    const rot = a + (rand() - 0.5) * 1.6;
    const h = needle ? 150 + rand() * 25 : 78 + rand() * 40;
    const s = needle ? 30 + rand() * 20 : 38 + rand() * 25;
    const l = (needle ? 16 : 20) + rand() * 26 * (0.6 + (1 - r / R) * 0.4);
    ctx.save();
    ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = `hsl(${h},${s}%,${l}%)`;
    ctx.beginPath();
    if (needle) {
      ctx.fillRect(-1, -9 - rand() * 6, 2, 18 + rand() * 10);
    } else {
      const len = 12 + rand() * 11, wid = 5 + rand() * 5;
      ctx.moveTo(-len, 0);
      ctx.quadraticCurveTo(0, -wid, len, 0);
      ctx.quadraticCurveTo(0, wid, -len, 0);
      ctx.fill();
      ctx.strokeStyle = `hsla(${h},${s}%,${l + 14}%,0.6)`;
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(-len * 0.8, 0); ctx.lineTo(len * 0.8, 0); ctx.stroke();
    }
    ctx.restore();
  }
}

export function leafAtlas(needle) {
  const rand = rng(needle ? 71 : 37);
  const t = canvasTex(1024, 1024, (ctx, w) => {
    for (let q = 0; q < 4; q++) leafCluster(ctx, (q % 2) * 512 + 256, Math.floor(q / 2) * 512 + 256, 235, rand, needle);
  });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// ---------- 面片 ----------
const _q = new THREE.Quaternion(), _e = new THREE.Euler();
function addCard(buf, center, crownC, size, rand, shade, tilt) {
  const quad = rand() * 4 | 0, u0 = (quad % 2) * 0.5, v0 = (quad >> 1) * 0.5;
  _e.set(tilt != null ? tilt + (rand() - 0.5) * 0.5 : rand() * Math.PI, rand() * Math.PI * 2, tilt != null ? (rand() - 0.5) * 0.4 : rand() * Math.PI);
  _q.setFromEuler(_e);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const base = buf.pos.length / 3;
  const hue = 0.88 + rand() * 0.24;
  for (const [cx, cy] of corners) {
    const p = V(cx * size / 2, cy * size / 2, 0).applyQuaternion(_q).add(center);
    buf.pos.push(p.x, p.y, p.z);
    const n = V().subVectors(p, crownC).normalize();
    buf.nrm.push(n.x, n.y, n.z);
    buf.uv.push(u0 + (cx + 1) * 0.25, v0 + (cy + 1) * 0.25);
    buf.col.push(shade * hue, shade, shade * (0.9 + rand() * 0.15));
  }
  buf.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function cardsGeo(buf) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
  g.setIndex(buf.idx);
  return g;
}

const newBuf = () => ({ pos: [], nrm: [], uv: [], col: [], idx: [] });

// 枝幹（含微彎、根部外擴）
function limb(a, b, r0, r1, bend, rand) {
  const mid = V().lerpVectors(a, b, 0.5).add(V((rand() - 0.5) * bend, 0, (rand() - 0.5) * bend));
  return sweep(path([a, mid, b], 5), ellipse(6), (t) => { const r = r0 + (r1 - r0) * t; return [r * 2, r * 2]; }, { lateral: V(1, 0, 0.3).normalize() });
}

// ---------- 闊葉樹 ----------
export function broadleaf(seed, { height = 9, crownR = 3.2, cards = 150 } = {}) {
  const rand = rng(seed);
  const trunkTop = V((rand() - 0.5) * 0.6, height * 0.55, (rand() - 0.5) * 0.6);
  const crownC = V(trunkTop.x, height * 0.66, trunkTop.z);
  const R = V(crownR, crownR * 0.72, crownR * (0.85 + rand() * 0.3));
  const wood = [limb(V(0, -0.3, 0), trunkTop, 0.28 * height / 9, 0.16 * height / 9, 0.5, rand)];
  for (let i = 0; i < 4; i++) { // 根部外擴
    const a = (i / 4) * Math.PI * 2 + rand();
    wood.push(limb(V(Math.cos(a) * 0.35, -0.1, Math.sin(a) * 0.35), V(0, 0.9, 0), 0.12, 0.05, 0.1, rand));
  }
  const tips = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + rand() * 0.6;
    const tip = V(Math.cos(a) * R.x * 0.75, (rand() * 0.6 - 0.1) * R.y, Math.sin(a) * R.z * 0.75).add(crownC);
    const from = V().lerpVectors(V(0, height * 0.35, 0), trunkTop, rand());
    wood.push(limb(from, tip, 0.11 * height / 9, 0.03, 0.8, rand));
    tips.push(tip);
  }
  const buf = newBuf();
  for (let i = 0; i < cards; i++) {
    let p;
    if (i < tips.length * 6) p = V((rand() - 0.5) * 1.6, (rand() - 0.3) * 1.2, (rand() - 0.5) * 1.6).add(tips[i % tips.length]);
    else {
      const d = V(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize(), k = 0.45 + 0.55 * Math.sqrt(rand());
      p = V(d.x * R.x * k, d.y * R.y * k, d.z * R.z * k).add(crownC);
    }
    const rel = V().subVectors(p, crownC), radial = Math.min(1, Math.hypot(rel.x / R.x, rel.y / R.y, rel.z / R.z));
    const shade = (0.45 + 0.55 * radial) * (0.75 + 0.25 * Math.min(1, Math.max(0, rel.y / R.y + 0.5)));
    addCard(buf, p, crownC, (1.5 + rand() * 0.9) * crownR / 3.2, rand, shade);
  }
  return { wood: mergeGeometries(wood), leaves: cardsGeo(buf) };
}

// ---------- 針葉樹（台灣杉 / 柳杉風格的層狀樹冠） ----------
export function conifer(seed, { height = 13, radius = 2.4, cards = 170 } = {}) {
  const rand = rng(seed);
  const wood = [limb(V(0, -0.3, 0), V(0, height, 0), 0.26, 0.04, 0.2, rand)];
  const buf = newBuf(), axisC = V();
  for (let i = 0; i < cards; i++) {
    const t = Math.pow(rand(), 0.8), y = height * (0.22 + 0.78 * t);
    const r = radius * (1 - t) * (0.35 + 0.65 * Math.sqrt(rand())) + 0.3;
    const a = rand() * Math.PI * 2;
    const p = V(Math.cos(a) * r, y, Math.sin(a) * r);
    axisC.set(0, y - 0.8, 0);
    const shade = 0.5 + 0.5 * (r / (radius * (1 - t) + 0.3)) * (0.7 + 0.3 * t);
    addCard(buf, p, axisC, 1.3 + rand() * 0.8, rand, shade, -Math.PI / 2 + 0.35);
  }
  return { wood: mergeGeometries(wood), leaves: cardsGeo(buf) };
}

// ---------- 灌木 ----------
export function bush(seed, { radius = 1.1, cards = 45 } = {}) {
  const rand = rng(seed), buf = newBuf(), c = V(0, radius * 0.55, 0);
  for (let i = 0; i < cards; i++) {
    const d = V(rand() * 2 - 1, rand() * 1.4 - 0.4, rand() * 2 - 1).normalize(), k = 0.3 + 0.7 * Math.sqrt(rand());
    const p = V(d.x * radius * k, Math.max(0.15, d.y * radius * 0.7 * k + radius * 0.5), d.z * radius * k);
    addCard(buf, p, c, 0.9 + rand() * 0.5, rand, 0.5 + 0.5 * k);
  }
  return { wood: null, leaves: cardsGeo(buf) };
}
