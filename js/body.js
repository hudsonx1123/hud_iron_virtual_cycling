import * as THREE from 'three';
import { V, orient, keyed, path } from './geom.js';

// 一體成形的騎士身體：以 SDF 平滑聯集各部位 → Surface Nets 網格化 → 腿部骨架蒙皮。
// 車衣圖案以頂點色程序化產生。座標與 rider.js 相同（車頭 +Z、騎士右側 -X）。

const smin = (a, b, k) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
const sm = (v) => { v = Math.min(1, Math.max(0, v)); return v * v * (3 - 2 * v); };
const hh = (n) => {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};

// iq 的 round cone SDF
function roundCone(a, b, r1, r2) {
  const bx = b.x - a.x, by = b.y - a.y, bz = b.z - a.z;
  const l2 = bx * bx + by * by + bz * bz, rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  return (x, y, z) => {
    const px = x - a.x, py = y - a.y, pz = z - a.z;
    const yy = px * bx + py * by + pz * bz, zz = yy - l2;
    const qx = px * l2 - bx * yy, qy = py * l2 - by * yy, qz = pz * l2 - bz * yy;
    const x2 = qx * qx + qy * qy + qz * qz, y2 = yy * yy * l2, z2 = zz * zz * l2;
    const k = Math.sign(rr) * rr * rr * x2;
    if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
    if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
    return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
  };
}

// 橢球（可繞 X 軸俯仰 pitch，長軸沿局部 Z）
function ellipsoid(c, r, pitch = 0) {
  const cs = Math.cos(pitch), sn = Math.sin(pitch);
  return (x, y, z) => {
    const px = x - c.x, dy = y - c.y, dz = z - c.z;
    const py = dy * cs - dz * sn, pz = dy * sn + dz * cs;
    const k0 = Math.hypot(px / r.x, py / r.y, pz / r.z);
    const k1 = Math.hypot(px / (r.x * r.x), py / (r.y * r.y), pz / (r.z * r.z));
    return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(r.x, r.y, r.z);
  };
}

// ---------- Surface Nets（含窄頻加速） ----------
function surfaceNets(sdf, lo, hi, h) {
  const nx = Math.ceil((hi.x - lo.x) / h) + 1, ny = Math.ceil((hi.y - lo.y) / h) + 1, nz = Math.ceil((hi.z - lo.z) / h) + 1;
  const C = 4, cnx = Math.ceil((nx - 1) / C) + 1, cny = Math.ceil((ny - 1) / C) + 1, cnz = Math.ceil((nz - 1) / C) + 1;
  const coarse = new Float32Array(cnx * cny * cnz);
  for (let k = 0; k < cnz; k++) for (let j = 0; j < cny; j++) for (let i = 0; i < cnx; i++)
    coarse[i + cnx * (j + cny * k)] = sdf(lo.x + i * C * h, lo.y + j * C * h, lo.z + k * C * h);
  const F = new Float32Array(nx * ny * nz), band = 5 * h;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const cv = coarse[Math.round(i / C) + cnx * (Math.round(j / C) + cny * Math.round(k / C))];
    F[i + nx * (j + ny * k)] = Math.abs(cv) > band ? cv : sdf(lo.x + i * h, lo.y + j * h, lo.z + k * h);
  }

  const cid = (i, j, k) => i + (nx - 1) * (j + (ny - 1) * k);
  const vid = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const pos = [];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const cv = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      cv[c] = F[(i + (c & 1)) + nx * ((j + ((c >> 1) & 1)) + ny * (k + ((c >> 2) & 1)))];
      if (cv[c] < 0) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of edges) {
      if ((cv[a] < 0) === (cv[b] < 0)) continue;
      const t = cv[a] / (cv[a] - cv[b]);
      sx += (a & 1) + t * ((b & 1) - (a & 1));
      sy += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1));
      sz += ((a >> 2) & 1) + t * (((b >> 2) & 1) - ((a >> 2) & 1));
      n++;
    }
    vid[cid(i, j, k)] = pos.length / 3;
    pos.push(lo.x + (i + sx / n) * h, lo.y + (j + sy / n) * h, lo.z + (k + sz / n) * h);
  }

  const idx = [], A = V(), B = V(), Cc = V(), N = V();
  const quad = (a, b, c, d, out) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    A.fromArray(pos, a * 3); B.fromArray(pos, b * 3); Cc.fromArray(pos, c * 3);
    N.subVectors(B, A).cross(Cc.sub(A));
    if (N.dot(out) >= 0) idx.push(a, b, c, a, c, d);
    else idx.push(a, c, b, a, d, c);
  };
  const ox = V(), oy = V(), oz = V();
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const f0 = F[i + nx * (j + ny * k)], s = f0 < 0 ? 1 : -1;
    if (i < nx - 1 && j > 0 && k > 0 && (f0 < 0) !== (F[i + 1 + nx * (j + ny * k)] < 0))
      quad(vid[cid(i, j - 1, k - 1)], vid[cid(i, j, k - 1)], vid[cid(i, j, k)], vid[cid(i, j - 1, k)], ox.set(s, 0, 0));
    if (j < ny - 1 && i > 0 && k > 0 && (f0 < 0) !== (F[i + nx * (j + 1 + ny * k)] < 0))
      quad(vid[cid(i - 1, j, k - 1)], vid[cid(i, j, k - 1)], vid[cid(i, j, k)], vid[cid(i - 1, j, k)], oy.set(0, s, 0));
    if (k < nz - 1 && i > 0 && j > 0 && (f0 < 0) !== (F[i + nx * (j + ny * (k + 1))] < 0))
      quad(vid[cid(i - 1, j - 1, k)], vid[cid(i, j - 1, k)], vid[cid(i, j, k)], vid[cid(i - 1, j, k)], oz.set(0, 0, s));
  }
  return { pos, idx };
}

// ---------- 車衣配色 ----------
const SKIN = new THREE.Color('#c49274'), DARK = new THREE.Color('#1d1a28');
const grad = (stops) => {
  const s = stops.map(([v, c]) => [v, new THREE.Color(c)]);
  return (v, out) => {
    if (v <= s[0][0]) return out.copy(s[0][1]);
    for (let i = 1; i < s.length; i++)
      if (v <= s[i][0]) return out.copy(s[i - 1][1]).lerp(s[i][1], (v - s[i - 1][0]) / (s[i][0] - s[i - 1][0]));
    return out.copy(s[s.length - 1][1]);
  };
};
const torsoGrad = grad([[0, '#1d1a28'], [0.12, '#1d1a28'], [0.2, '#ff4a2e'], [0.32, '#ff3f6e'], [0.45, '#ff5aa5'], [0.6, '#fbe9f1'], [0.7, '#ffffff'], [1, '#ffffff']]);
const sleeveGrad = grad([[0, '#ffffff'], [0.3, '#ffe3ef'], [0.55, '#ff4f9a'], [0.6, '#ff4f9a'], [0.62, '#c49274'], [1, '#c49274']]);
const shortsGrad = grad([[0, '#1d1a28'], [0.35, '#2a1f33'], [0.55, '#ff3d4a'], [0.7, '#ff5a7a'], [0.72, '#c49274'], [1, '#c49274']]);
const pinks = ['#ff5aa5', '#ff7cbc', '#ffd0e4'].map((c) => new THREE.Color(c));
const reds = ['#ff3a3a', '#ff6a2a', '#ff3f6e'].map((c) => new THREE.Color(c));
const BLUE = new THREE.Color('#2b3fbf'), BLUE_D = new THREE.Color('#1f2f96');

// Zoot 漸層像素直條：在 [v0, v1] 帶內，依欄位隨機往下延伸
function bars(out, u, v, v0, v1, cols, palette, seed) {
  if (v < v0 || v > v1) return;
  const c = Math.floor(u * cols) + seed;
  if (hh(c + 99) < 0.35) return;
  if (v < v0 + hh(c) * (v1 - v0)) out.lerp(palette[Math.floor(hh(c + 7) * palette.length)], 0.85);
}

// ---------- 主程式 ----------
export function buildBody({ legs, arms, thigh, shin }) {
  const prims = [];
  const P = (f, k, grp, reg, seg) => prims.push({ f, k, grp, reg, seg });

  // 軀幹：沿脊椎路徑的一串橢球
  const tw = keyed([[0, 0.26], [0.15, 0.31], [0.4, 0.27], [0.65, 0.32], [0.85, 0.37], [1, 0.3]]);
  const td = keyed([[0, 0.2], [0.2, 0.21], [0.45, 0.19], [0.7, 0.23], [0.88, 0.19], [1, 0.14]]);
  const spine = new THREE.CatmullRomCurve3([V(0, 1.0, -0.4), V(0, 1.065, -0.33), V(0, 1.135, -0.18), V(0, 1.172, -0.02), V(0, 1.18, 0.1), V(0, 1.16, 0.18)]);
  for (let i = 0; i <= 10; i++) {
    const t = i / 10, c = spine.getPointAt(t), tg = spine.getTangentAt(t);
    P(ellipsoid(c, V(tw(t) / 2, td(t) / 2, 0.075), -Math.atan2(tg.y, tg.z)), 0.06, 0, 'torso');
  }
  const spinePts = spine.getSpacedPoints(60), spineTan = spinePts.map((_, i) => spine.getTangentAt(i / 60));
  for (const s of [-1, 1]) P(ellipsoid(V(s * 0.068, 0.995, -0.372), V(0.085, 0.078, 0.09)), 0.04, 0, 'glute');
  P(roundCone(V(0, 1.14, 0.14), V(0, 1.225, 0.27), 0.052, 0.046), 0.04, 0, 'skin'); // 頸

  // 手臂（固定在手靠與延伸把上）
  for (const a of arms) {
    P(ellipsoid(a.sh, V(0.062, 0.066, 0.07)), 0.05, 0, 'uarm', [a.sh, a.el]);
    P(roundCone(a.sh, a.el, 0.058, 0.04), 0.04, 0, 'uarm', [a.sh, a.el]);
    P(roundCone(a.el, a.wr, 0.041, 0.028), 0.03, 0, 'skin');
    P(ellipsoid(a.hand, V(0.04, 0.032, 0.058)), 0.03, 0, 'skin');
  }

  // 腿（靜止姿勢）：大腿、膝、小腿含小腿肚
  legs.forEach((L, li) => {
    const gT = 1 + li * 2, gS = 2 + li * 2;
    P(roundCone(L.hip, L.K, 0.086, 0.054), 0.05, gT, 'thigh', [L.hip, L.K]);
    const q = V().lerpVectors(L.hip, L.K, 0.35), toward = V().subVectors(L.K, L.hip).normalize();
    P(roundCone(q, V().copy(q).addScaledVector(toward, 0.16), 0.08, 0.06), 0.06, gT, 'thigh', [L.hip, L.K]); // 股四頭肌
    P(roundCone(L.K, L.A, 0.05, 0.031), 0.03, gS, 'shin', [L.K, L.A]);
    const sd = V().subVectors(L.A, L.K).normalize(), back = V(0, 0, -1).addScaledVector(sd, sd.z).normalize();
    const cm = V().lerpVectors(L.K, L.A, 0.3).addScaledVector(back, 0.018);
    P(roundCone(V().lerpVectors(L.K, L.A, 0.12).addScaledVector(back, 0.01), V().lerpVectors(L.K, L.A, 0.55).addScaledVector(back, 0.008), 0.05, 0.036), 0.04, gS, 'shin', [L.K, L.A]);
    P(ellipsoid(cm, V(0.046, 0.06, 0.05)), 0.04, gS, 'shin', [L.K, L.A]);
  });

  let nearest = 0;
  const sdf = (x, y, z) => {
    let d = 1e9, best = 1e9;
    for (let i = 0; i < prims.length; i++) {
      const di = prims[i].f(x, y, z);
      d = smin(d, di, prims[i].k);
      if (di < best) { best = di; nearest = i; }
    }
    return d;
  };

  const h = 0.0065;
  const { pos, idx } = surfaceNets(sdf, V(-0.27, 0.28, -0.53), V(0.27, 1.3, 0.66), h);
  const n = pos.length / 3;

  // 法線（SDF 梯度）、頂點色、蒙皮權重
  const nrm = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const skinIdx = new Uint16Array(n * 4), skinW = new Float32Array(n * 4);
  const c = new THREE.Color(), p = V(), tmp = V(), e = h * 0.5, X = V(1, 0, 0), Nv = V();
  const segParam = (a, b, q) => { tmp.subVectors(b, a); return tmp.dot(V().subVectors(q, a)) / tmp.lengthSq(); };
  const around = (a, b, q) => { // 肢段周向座標 u
    const d = V().subVectors(b, a).normalize(), r = V(1, 0, 0).addScaledVector(d, -d.x).normalize();
    const w = V().subVectors(q, a); w.addScaledVector(d, -w.dot(d));
    return (Math.atan2(w.dot(V().crossVectors(d, r)), w.dot(r)) / (Math.PI * 2) + 1) % 1;
  };
  for (let i = 0; i < n; i++) {
    p.fromArray(pos, i * 3);
    // 沿梯度把頂點投影到等值面上，去除網格化造成的細小起伏
    for (let it = 0; it < 3; it++) {
      const gx = sdf(p.x + e, p.y, p.z) - sdf(p.x - e, p.y, p.z);
      const gy = sdf(p.x, p.y + e, p.z) - sdf(p.x, p.y - e, p.z);
      const gz = sdf(p.x, p.y, p.z + e) - sdf(p.x, p.y, p.z - e);
      tmp.set(gx, gy, gz).normalize();
      if (it < 2) p.addScaledVector(tmp, -sdf(p.x, p.y, p.z));
    }
    if (!Number.isFinite(tmp.x)) tmp.set(0, 1, 0);
    p.toArray(pos, i * 3);
    tmp.toArray(nrm, i * 3);
    sdf(p.x, p.y, p.z);
    const pr = prims[nearest];

    // 配色
    if (pr.reg === 'torso') {
      let bi = 0, bd = 1e9;
      for (let k = 0; k < spinePts.length; k++) { const dd = spinePts[k].distanceToSquared(p); if (dd < bd) { bd = dd; bi = k; } }
      const v = bi / 60, T = spineTan[bi];
      Nv.crossVectors(T, X);
      tmp.subVectors(p, spinePts[bi]);
      const u = (Math.atan2(tmp.dot(Nv), tmp.x) / (Math.PI * 2) + 1) % 1;
      torsoGrad(v, c);
      bars(c, u, v, 0.4, 0.66, 70, pinks, 0);
      bars(c, u, v, 0.16, 0.36, 70, reds, 500);
      const du = Math.min(u, Math.abs(u - 0.5), 1 - u);
      if (v < 0.75) c.lerp(DARK, 0.95 * (1 - sm((du - 0.035) / 0.03)) * sm((0.75 - v) / 0.12));
    } else if (pr.reg === 'glute') c.copy(DARK);
    else if (pr.reg === 'uarm') {
      const v = Math.max(0, segParam(pr.seg[0], pr.seg[1], p));
      sleeveGrad(v, c);
      bars(c, around(pr.seg[0], pr.seg[1], p), v, 0.3, 0.58, 30, pinks, 900);
    } else if (pr.reg === 'thigh') {
      const v = Math.max(0, segParam(pr.seg[0], pr.seg[1], p));
      shortsGrad(v, c);
      if (v < 0.7) bars(c, around(pr.seg[0], pr.seg[1], p), v, 0.3, 0.7, 34, [...reds, pinks[0]], 1300);
    } else if (pr.reg === 'shin') {
      const v = segParam(pr.seg[0], pr.seg[1], p);
      c.copy(SKIN).lerp(BLUE, sm((v - 0.12) / 0.04)).lerp(BLUE_D, 0.35 * sm((v - 0.6) / 0.4));
    } else c.copy(SKIN);
    c.toArray(col, i * 3);

    // 蒙皮：0 = 根，1/2 = 右大腿/小腿，3/4 = 左大腿/小腿
    if (pr.grp === 0) { skinIdx[i * 4] = 0; skinW[i * 4] = 1; continue; }
    const li = (pr.grp - 1) >> 1, L = legs[li];
    const t1 = segParam(L.hip, L.K, p), t2 = Math.min(1, Math.max(0, segParam(L.K, L.A, p)));
    const d1 = tmp.lerpVectors(L.hip, L.K, Math.min(1, Math.max(0, t1))).distanceTo(p);
    const d2 = tmp.lerpVectors(L.K, L.A, t2).distanceTo(p);
    const s = d1 < d2 ? t1 * thigh : thigh + t2 * shin;
    const wRoot = 1 - sm((s + 0.02) / 0.1), wShin = sm((s - thigh + 0.05) / 0.1), wThigh = Math.max(0, 1 - wRoot - wShin);
    const sum = wRoot + wThigh + wShin;
    skinIdx.set([0, 1 + li * 2, 2 + li * 2, 0], i * 4);
    skinW.set([wRoot / sum, wThigh / sum, wShin / sum, 0], i * 4);
  }

  // 以 SDF 梯度法線校正每個三角形的繞序（避免背面剔除造成破洞）
  const ta = V(), tb = V(), tc = V(), tn = V(), vn = V();
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, cc] = [idx[i], idx[i + 1], idx[i + 2]];
    ta.fromArray(pos, a * 3); tb.fromArray(pos, b * 3); tc.fromArray(pos, cc * 3);
    tn.subVectors(tb, ta).cross(tc.sub(ta));
    vn.fromArray(nrm, a * 3).add(tmp.fromArray(nrm, b * 3)).add(tmp.fromArray(nrm, cc * 3));
    if (tn.dot(vn) < 0) { idx[i + 1] = cc; idx[i + 2] = b; }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIdx, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinW, 4));
  geo.setIndex(idx);

  const mat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.58, sheen: 0.45, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xffffff) });
  const mesh = new THREE.SkinnedMesh(geo, mat);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  // 扁平骨架：每根骨頭直接以絕對姿態掛在 mesh 下
  const bones = Array.from({ length: 5 }, () => new THREE.Bone());
  bones.forEach((b) => mesh.add(b));
  const FWD = V(0, 0, 1);
  const pose = (ls) => ls.forEach((L, li) => {
    orient(bones[1 + li * 2], L.hip, L.K, FWD);
    orient(bones[2 + li * 2], L.K, L.A, FWD);
  });
  pose(legs);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));

  return { mesh, pose };
}
