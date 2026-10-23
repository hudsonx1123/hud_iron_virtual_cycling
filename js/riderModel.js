import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { V } from './geom.js';
import { pedalPos } from './bike.js';

// 照片生成的騎士模型（Tripo，H2.5）：自動綁骨架並擺成 Shiv 空力騎姿。
// 原始模型是跑步姿勢、無骨架、高度正規化為 1；關節位置由網格截面分析估得（模型座標，臉朝 +Z）。
const HEIGHT = 1.72;
const J0 = {
  pelvis: [0, 0.52, 0.08], chest: [0, 0.66, 0.09], neck: [0.005, 0.81, 0.11], head: [0.01, 0.87, 0.145], headTop: [0.013, 0.99, 0.15],
  shoulderR: [-0.13, 0.785, 0.09], elbowR: [-0.16, 0.66, 0.11], wristR: [-0.075, 0.62, 0.195],
  shoulderL: [0.13, 0.785, 0.08], elbowL: [0.17, 0.685, 0.02], wristL: [0.145, 0.62, 0.165],
  hipR: [-0.055, 0.5, 0.07], kneeR: [-0.045, 0.31, -0.02], ankleR: [-0.058, 0.19, -0.245], toeR: [-0.067, 0.11, -0.3],
  hipL: [0.055, 0.5, 0.09], kneeL: [0.04, 0.27, 0.15], ankleL: [0.035, 0.065, 0.165], toeL: [0.03, 0.02, 0.27],
};
for (const s of ['R', 'L']) { // 手掌末端：沿前臂延伸 6cm（模型單位）
  const e = V(...J0['elbow' + s]), w = V(...J0['wrist' + s]);
  J0['hand' + s] = w.clone().add(w.clone().sub(e).normalize().multiplyScalar(0.06)).toArray();
}

// [骨頭, 起點關節, 終點關節, 父骨頭, 肢段半徑（模型單位，用於權重的距離正規化）]
const BONES = [
  ['pelvis', 'pelvis', 'chest', null, 0.1], ['spine', 'chest', 'neck', 'pelvis', 0.11],
  ['neck', 'neck', 'head', 'spine', 0.04], ['head', 'head', 'headTop', 'neck', 0.075],
  ['uarmR', 'shoulderR', 'elbowR', 'spine', 0.042], ['farmR', 'elbowR', 'wristR', 'uarmR', 0.034], ['handR', 'wristR', 'handR', 'farmR', 0.036],
  ['uarmL', 'shoulderL', 'elbowL', 'spine', 0.042], ['farmL', 'elbowL', 'wristL', 'uarmL', 0.034], ['handL', 'wristL', 'handL', 'farmL', 0.036],
  ['thighR', 'hipR', 'kneeR', 'pelvis', 0.075], ['shinR', 'kneeR', 'ankleR', 'thighR', 0.048], ['footR', 'ankleR', 'toeR', 'shinR', 0.04],
  ['thighL', 'hipL', 'kneeL', 'pelvis', 0.075], ['shinL', 'kneeL', 'ankleL', 'thighL', 0.048], ['footL', 'ankleL', 'toeL', 'shinL', 0.04],
];
const BI = Object.fromEntries(BONES.map((b, i) => [b[0], i]));

const DEBUG_LABELS = typeof location !== 'undefined' && /[?&]labels=1/.test(location.search);
const REST_POSE = typeof location !== 'undefined' && /[?&]rest=1/.test(location.search);
const LEG = new Set(['thighR', 'shinR', 'footR', 'thighL', 'shinL', 'footL'].map((b) => BI[b]));
const ARM = new Set(['uarmR', 'farmR', 'handR', 'uarmL', 'farmL', 'handL'].map((b) => BI[b]));
const sm = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

// 點到線段的參數 t 與距離
function segInfo(px, py, pz, a, b) {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
  const l2 = bx * bx + by * by + bz * bz;
  const t = ((px - a[0]) * bx + (py - a[1]) * by + (pz - a[2]) * bz) / l2;
  const tc = Math.min(1, Math.max(0, t));
  const dx = px - a[0] - bx * tc, dy = py - a[1] - by * tc, dz = pz - a[2] - bz * tc;
  return [t, Math.sqrt(dx * dx + dy * dy + dz * dz), Math.sqrt(l2)];
}

// ---------- 去除水壺（青綠色）與遮陽帽、頭頂（由 TT 帽覆蓋） ----------
function trimMesh(geo, map) {
  const c = document.createElement('canvas');
  c.width = map.image.width; c.height = map.image.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(map.image, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height).data;
  const pos = geo.attributes.position, uv = geo.attributes.uv, idx = geo.index.array;
  const flipY = map.flipY;
  const texel = (u, v) => {
    const x = Math.min(c.width - 1, Math.max(0, Math.floor(u * c.width)));
    const y = Math.min(c.height - 1, Math.max(0, Math.floor((flipY ? 1 - v : v) * c.height)));
    const i = (y * c.width + x) * 4;
    return [img[i], img[i + 1], img[i + 2]];
  };
  const keep = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], d = idx[t + 2];
    const y = (pos.getY(a) + pos.getY(b) + pos.getY(d)) / 3, z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(d)) / 3;
    const x = (pos.getX(a) + pos.getX(b) + pos.getX(d)) / 3;
    const [r, g, bl] = texel((uv.getX(a) + uv.getX(b) + uv.getX(d)) / 3, (uv.getY(a) + uv.getY(b) + uv.getY(d)) / 3);
    const skin = r > 110 && r > g * 1.08 && g > bl * 0.95 && r - bl > 35;
    const teal = g > 120 && bl > 110 && g - r > 40 && bl - r > 30;
    const nearHandR = x < 0.02 && x > -0.13 && y > 0.5 && y < 0.7 && z > 0.12;
    if (nearHandR && (teal || !skin)) continue;   // 水壺（保留手的膚色部分）
    if (y > 0.935) continue;                       // 頭頂、遮陽帽（TT 帽覆蓋）
    if (y > 0.9 && z > 0.205) continue;            // 帽簷
    keep.push(a, b, d);
  }
  geo.setIndex(keep);
}

// 網格鄰接（CSR）
function adjacency(n, idx) {
  const deg = new Uint32Array(n);
  for (let t = 0; t < idx.length; t++) deg[idx[t]] += 2;
  const start = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
  const nbr = new Uint32Array(start[n]), fill = start.slice(0, n);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    nbr[fill[a]++] = b; nbr[fill[a]++] = c; nbr[fill[b]++] = a; nbr[fill[b]++] = c; nbr[fill[c]++] = a; nbr[fill[c]++] = b;
  }
  return { start, nbr };
}

// 多源 Dijkstra：未標記頂點取表面距離最近之已標記頂點的標籤（雙精度距離，每頂點只展開一次）
function geodesicFill(label, pos, { start, nbr }) {
  const n = label.length, dist = new Float64Array(n).fill(Infinity), done = new Uint8Array(n);
  let hd = new Float64Array(1 << 16), hv = new Int32Array(1 << 16), size = 0; // 二元堆積
  const push = (d, v) => {
    if (size === hd.length) {
      const nd = new Float64Array(size * 2), nv = new Int32Array(size * 2);
      nd.set(hd); nv.set(hv); hd = nd; hv = nv;
    }
    let i = size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hd[p] <= d) break;
      hd[i] = hd[p]; hv[i] = hv[p]; i = p;
    }
    hd[i] = d; hv[i] = v;
  };
  const pop = () => {
    const v = hv[0], ld = hd[--size], lv = hv[size];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= size) break;
      const c = l + 1 < size && hd[l + 1] < hd[l] ? l + 1 : l;
      if (hd[c] >= ld) break;
      hd[i] = hd[c]; hv[i] = hv[c]; i = c;
    }
    hd[i] = ld; hv[i] = lv;
    return v;
  };
  for (let i = 0; i < n; i++) if (label[i] >= 0) { dist[i] = 0; push(0, i); }
  while (size) {
    const v = pop();
    if (done[v]) continue;
    done[v] = 1;
    const vx = pos.getX(v), vy = pos.getY(v), vz = pos.getZ(v), dv = dist[v];
    for (let q = start[v]; q < start[v + 1]; q++) {
      const u = nbr[q];
      if (done[u]) continue;
      const nd = dv + Math.hypot(pos.getX(u) - vx, pos.getY(u) - vy, pos.getZ(u) - vz);
      if (nd < dist[u]) { dist[u] = nd; label[u] = label[v]; push(nd, u); }
    }
  }
  for (let i = 0; i < n; i++) if (label[i] < 0) label[i] = 0;
}

// 由交界頂點出發、只在同一標籤區域內傳播的表面距離
function boundaryDistance(dist, other, label, pos, { start, nbr }) {
  const n = label.length, done = new Uint8Array(n);
  const order = [];
  for (let i = 0; i < n; i++) if (dist[i] === 0) order.push(i);
  // 標籤區域內多源 Dijkstra（簡化：以排序佇列分層處理，邊長差異小時足夠精確）
  let hd = new Float64Array(1 << 16), hv = new Int32Array(1 << 16), size = 0;
  const push = (d, v) => {
    if (size === hd.length) { const a = new Float64Array(size * 2), b = new Int32Array(size * 2); a.set(hd); b.set(hv); hd = a; hv = b; }
    let i = size++;
    while (i > 0) { const p = (i - 1) >> 1; if (hd[p] <= d) break; hd[i] = hd[p]; hv[i] = hv[p]; i = p; }
    hd[i] = d; hv[i] = v;
  };
  const pop = () => {
    const v = hv[0], ld = hd[--size], lv = hv[size];
    let i = 0;
    for (;;) { const l = 2 * i + 1; if (l >= size) break; const c = l + 1 < size && hd[l + 1] < hd[l] ? l + 1 : l; if (hd[c] >= ld) break; hd[i] = hd[c]; hv[i] = hv[c]; i = c; }
    hd[i] = ld; hv[i] = lv;
    return v;
  };
  for (const v of order) push(0, v);
  while (size) {
    const v = pop();
    if (done[v]) continue;
    done[v] = 1;
    const vx = pos.getX(v), vy = pos.getY(v), vz = pos.getZ(v);
    for (let q = start[v]; q < start[v + 1]; q++) {
      const u = nbr[q];
      if (done[u] || label[u] !== label[v]) continue;
      const nd = dist[v] + Math.hypot(pos.getX(u) - vx, pos.getY(u) - vy, pos.getZ(u) - vz);
      if (nd < dist[u]) { dist[u] = nd; other[u] = other[v]; push(nd, u); }
    }
  }
}

// 每根骨頭只保留網格上相連的最大一塊；其餘零星區塊（例如跑姿時貼近手的肚皮）改由相鄰區域的多數標籤接手
function cleanLabels(label, { start, nbr }, nb) {
  const n = label.length, comp = new Int32Array(n).fill(-1), sizes = [], compLabel = [];
  const stack = [];
  for (let i = 0; i < n; i++) {
    if (comp[i] >= 0) continue;
    const id = sizes.length; let size = 0;
    comp[i] = id; stack.push(i);
    while (stack.length) {
      const v = stack.pop(); size++;
      for (let q = start[v]; q < start[v + 1]; q++) {
        const u = nbr[q];
        if (comp[u] < 0 && label[u] === label[i]) { comp[u] = id; stack.push(u); }
      }
    }
    sizes.push(size); compLabel.push(label[i]);
  }
  const biggest = new Int32Array(nb).fill(-1);
  sizes.forEach((sz, id) => { const l = compLabel[id]; if (biggest[l] < 0 || sz > sizes[biggest[l]]) biggest[l] = id; });
  const orphan = new Uint8Array(n);
  let left = 0;
  for (let i = 0; i < n; i++) if (biggest[label[i]] !== comp[i]) { orphan[i] = 1; left++; }
  const votes = new Int32Array(nb);
  for (let pass = 0; pass < 200 && left > 0; pass++) {
    const fixed = [];
    for (let i = 0; i < n; i++) {
      if (!orphan[i]) continue;
      votes.fill(0); let any = false;
      for (let q = start[i]; q < start[i + 1]; q++) { const u = nbr[q]; if (!orphan[u]) { votes[label[u]]++; any = true; } }
      if (!any) continue;
      let bl = 0; for (let k = 1; k < nb; k++) if (votes[k] > votes[bl]) bl = k;
      fixed.push(i, bl);
    }
    if (!fixed.length) break;
    for (let f = 0; f < fixed.length; f += 2) { label[fixed[f]] = fixed[f + 1]; orphan[fixed[f]] = 0; left--; }
  }
}

// ---------- 自動蒙皮權重 ----------
// 交界混合帶半寬（模型單位）：依相鄰兩骨頭決定，肩膀轉動最大故最寬
const BLEND = { 'spine|uarmR': 0.055, 'spine|uarmL': 0.055, 'pelvis|thighR': 0.045, 'pelvis|thighL': 0.045, 'pelvis|spine': 0.06,
  'spine|neck': 0.035, 'neck|head': 0.03, 'uarmR|farmR': 0.03, 'uarmL|farmL': 0.03, 'farmR|handR': 0.02, 'farmL|handL': 0.02,
  'thighR|shinR': 0.035, 'thighL|shinL': 0.035, 'shinR|footR': 0.025, 'shinL|footL': 0.025 };
const blendWidth = (a, b) => BLEND[`${BONES[a][0]}|${BONES[b][0]}`] ?? BLEND[`${BONES[b][0]}|${BONES[a][0]}`] ?? 0.012;

export function computeWeights(geo) {
  const pos = geo.attributes.position, nAll = pos.count, nb = BONES.length;
  // 合併 UV 接縫處位置相同的重複頂點，鄰接關係才會連續
  const canon = new Int32Array(nAll), key = new Map(), cp = [];
  for (let i = 0; i < nAll; i++) {
    const k = `${pos.getX(i)},${pos.getY(i)},${pos.getZ(i)}`;
    let c = key.get(k);
    if (c === undefined) { c = cp.length / 3; key.set(k, c); cp.push(pos.getX(i), pos.getY(i), pos.getZ(i)); }
    canon[i] = c;
  }
  const n = cp.length / 3, P = { getX: (i) => cp[i * 3], getY: (i) => cp[i * 3 + 1], getZ: (i) => cp[i * 3 + 2] };
  const src = geo.index.array, cidx = new Uint32Array(src.length);
  for (let t = 0; t < src.length; t++) cidx[t] = canon[src[t]];
  const nbrs = adjacency(n, cidx), { start, nbr } = nbrs;
  const segs = BONES.map(([, a, b]) => [J0[a], J0[b]]);

  // 1) 只標記沒有爭議的頂點（最近骨頭的正規化距離明顯小於次近者）作為種子
  const label = new Int16Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const px = cp[i * 3], py = cp[i * 3 + 1], pz = cp[i * 3 + 2];
    let best = 0, bs = 1e9, second = 1e9;
    // 跑姿時手肘在背後、拳頭貼著肚子：軀幹範圍內不允許標成手臂
    const inTorso = Math.abs(px) < 0.098 && pz > 0.0 && pz < 0.182 && py > 0.47 && py < 0.8;
    const aboveHips = py > 0.505 && Math.abs(px) < 0.12; // 腰部以上不歸腿（臀部、下背屬骨盆）
    for (let k = 0; k < nb; k++) {
      if (inTorso && ARM.has(k)) continue;
      if (aboveHips && LEG.has(k)) continue;
      const sc = segInfo(px, py, pz, segs[k][0], segs[k][1])[1] / BONES[k][4];
      if (sc < bs) { second = bs; bs = sc; best = k; } else if (sc < second) second = sc;
    }
    if (second > bs * 1.25) label[i] = best;
  }
  // 2) 沿網格表面（測地距離）擴散；每根骨頭只保留相連的最大區塊
  geodesicFill(label, P, nbrs);
  cleanLabels(label, nbrs, nb);

  // 3) 從標籤交界沿表面量距離，在混合帶內平滑過渡兩根骨頭的權重
  const dist = new Float64Array(n).fill(Infinity), other = new Int16Array(n).fill(-1), seed = new Int16Array(n).fill(-1);
  for (let v = 0; v < n; v++)
    for (let q = start[v]; q < start[v + 1]; q++)
      if (label[nbr[q]] !== label[v]) { dist[v] = 0; other[v] = label[nbr[q]]; break; }
  boundaryDistance(dist, other, label, P, nbrs);
  const W = new Float32Array(n * nb);
  for (let v = 0; v < n; v++) {
    const o = v * nb, l = label[v];
    if (other[v] < 0) { W[o + l] = 1; continue; }
    const w = 0.5 * (1 - sm(dist[v] / blendWidth(l, other[v])));
    W[o + l] = 1 - w; W[o + other[v]] += w;
  }

  // 4) 輕度擴散平滑
  let cur = W, nxt = new Float32Array(W.length);
  for (let it = 0; it < 3; it++) {
    for (let i = 0; i < n; i++) {
      const o = i * nb, s0 = start[i], e = start[i + 1], cnt = e - s0;
      for (let k = 0; k < nb; k++) {
        let acc = 0;
        for (let q = s0; q < e; q++) acc += cur[nbr[q] * nb + k];
        nxt[o + k] = cnt ? 0.5 * cur[o + k] + (0.5 * acc) / cnt : cur[o + k];
      }
    }
    [cur, nxt] = [nxt, cur];
  }

  // 每頂點保留權重最大的 4 根骨頭（重複頂點沿用合併後的權重）
  const si = new Uint16Array(nAll * 4), sw = new Float32Array(nAll * 4);
  const order = new Array(nb);
  for (let i = 0; i < nAll; i++) {
    const o = canon[i] * nb;
    for (let k = 0; k < nb; k++) order[k] = k;
    order.sort((a, b) => cur[o + b] - cur[o + a]);
    let sum = 0;
    for (let q = 0; q < 4; q++) sum += cur[o + order[q]];
    for (let q = 0; q < 4; q++) { si[i * 4 + q] = order[q]; sw[i * 4 + q] = sum > 0 ? cur[o + order[q]] / sum : q === 0 ? 1 : 0; }
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  if (DEBUG_LABELS) { // 除錯：依主要骨頭著色
    const col = new Float32Array(nAll * 3), c = new THREE.Color();
    for (let i = 0; i < nAll; i++) { c.setHSL((si[i * 4] * 0.618) % 1, 0.85, 0.5); c.toArray(col, i * 3); }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
}

// ---------- 姿勢工具 ----------
const X = V(1, 0, 0);
function basis(dir, out) { // Y = dir，Z = 橫向軸（X）去掉 dir 分量，X' = Y × Z
  const y = dir.clone().normalize();
  let z = X.clone().addScaledVector(y, -X.dot(y));
  if (z.lengthSq() < 1e-6) z = V(0, 0, 1).addScaledVector(y, -y.z);
  z.normalize();
  const x = V().crossVectors(y, z);
  return out.makeBasis(x, y, z);
}

// 兩節 IK：回傳中間關節位置
function ik2(a, target, l1, l2, pole) {
  const d = V().subVectors(target, a), dist = Math.min(d.length(), (l1 + l2) * 0.999);
  d.normalize();
  const along = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(l1 * l1 - along * along, 0));
  const p = pole.clone().addScaledVector(d, -pole.dot(d)).normalize();
  return V().copy(a).addScaledVector(d, along).addScaledVector(p, h);
}

export async function loadRiderModel(url) {
  const gltf = await new GLTFLoader().loadAsync(url);
  let src;
  gltf.scene.traverse((o) => { if (o.isMesh) src = o; });
  const geo = src.geometry;
  trimMesh(geo, src.material.map);
  computeWeights(geo);
  geo.scale(HEIGHT, HEIGHT, HEIGHT);

  const mat = DEBUG_LABELS ? new THREE.MeshBasicMaterial({ vertexColors: true }) : src.material;
  mat.envMapIntensity = 0.7;
  const mesh = new THREE.SkinnedMesh(geo, mat);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  const R = (k) => V(...J0[k]).multiplyScalar(HEIGHT); // 靜止姿勢關節（公尺）
  const bones = BONES.map(() => new THREE.Bone());
  bones.forEach((b, i) => { b.position.copy(R(BONES[i][1])); mesh.add(b); });
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));

  const restBasis = BONES.map(([, a, b]) => basis(V().subVectors(R(b), R(a)), new THREE.Matrix4()));
  const len = (a, b) => R(a).distanceTo(R(b));
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  const rot = BONES.map(() => new THREE.Matrix4());
  bones.forEach((b) => (b.matrixAutoUpdate = false));
  const S = new THREE.Matrix4(), BrT = new THREE.Matrix4();
  // 骨頭世界矩陣 = T(at) · B(dir) · 沿骨頭方向縮放 · B_rest^T；骨頭長度與模型不符時以伸縮吻合
  const setBone = (name, at, dir, stretch = 1) => {
    const i = BI[name];
    BrT.copy(restBasis[i]).transpose();
    basis(dir, m);
    rot[i].copy(m).multiply(BrT);
    S.makeScale(1, stretch, 1);
    bones[i].matrix.copy(m).multiply(S).multiply(BrT).setPosition(at);
    bones[i].matrixWorldNeedsUpdate = true;
  };
  const carry = (parent, jointKey, parentJointKey, parentAt) => // 隨父骨頭剛性移動的關節位置
    V().subVectors(R(jointKey), R(parentJointKey)).applyMatrix4(rot[BI[parent]]).add(parentAt);

  // 上半身固定的空力姿勢（座標同 bike.js：車頭 +Z、騎士右側 -X）
  const P = V(0, 1.0, -0.31);
  const dPelvis = V(0, 0.3, 0.95), dSpine = V(0, 0.08, 1), dNeck = V(0, 0.5, 0.87), dHead = V(0, 0.93, 0.36);
  const head = { pos: V(), quat: new THREE.Quaternion() };
  const legs = {};
  const poseUpper = () => {
    setBone('pelvis', P, dPelvis);
    const C = V().copy(P).addScaledVector(dPelvis.clone().normalize(), len('pelvis', 'chest'));
    setBone('spine', C, dSpine);
    const N = V().copy(C).addScaledVector(dSpine.clone().normalize(), len('chest', 'neck'));
    setBone('neck', N, dNeck);
    const Hd = V().copy(N).addScaledVector(dNeck.clone().normalize(), len('neck', 'head'));
    setBone('head', Hd, dHead);
    q.setFromRotationMatrix(rot[BI.head]);
    head.quat.copy(q);
    head.pos.copy(carry('head', 'headTop', 'head', Hd)).lerp(Hd, 0.62);

    for (const s of ['R', 'L']) {
      const sx = s === 'R' ? -1 : 1;
      const Sh = carry('spine', 'shoulder' + s, 'chest', C);
      const E = V(sx * 0.098, 0.925, 0.27), Wr = V(sx * 0.074, 0.875, 0.5); // 手肘在手靠、手腕在延伸把
      setBone('uarm' + s, Sh, V().subVectors(E, Sh), Sh.distanceTo(E) / len('shoulder' + s, 'elbow' + s));
      setBone('farm' + s, E, V().subVectors(Wr, E), E.distanceTo(Wr) / len('elbow' + s, 'wrist' + s));
      setBone('hand' + s, Wr, V(-sx * 0.05, -0.12, 1));
      legs[s] = { hip: carry('pelvis', 'hip' + s, 'pelvis', P) };
    }
  };
  poseUpper();
  if (REST_POSE) bones.forEach((b, i) => { b.matrix.makeTranslation(R(BONES[i][1])); b.matrixWorldNeedsUpdate = true; });

  const tmp = V();
  const rotX = (y, z, phi) => V(0, y * Math.cos(phi) - z * Math.sin(phi), y * Math.sin(phi) + z * Math.cos(phi));
  const footLen = (len('ankleR', 'toeR') + len('ankleL', 'toeL')) / 2;
  const ankleAt = (side, theta) => {
    const th = theta + (side < 0 ? 0 : Math.PI);
    const Pd = pedalPos(side, theta, V());
    Pd.x = side * 0.105;
    const phi = 0.1 + 0.12 * Math.sin(th - 0.4);       // 腳踝擺動
    return { A: Pd.add(rotX(0.085, -0.065, phi)), phi };
  };
  let reach = 0;
  for (let k = 0; k < 72; k++) reach = Math.max(reach, legs.R.hip.distanceTo(ankleAt(-1, (k / 72) * Math.PI * 2).A));
  const thigh0 = (len('hipR', 'kneeR') + len('hipL', 'kneeL')) / 2, shin0 = (len('kneeR', 'ankleR') + len('kneeL', 'ankleL')) / 2;
  const legScale = reach / (0.97 * (thigh0 + shin0));
  const thighL = thigh0 * legScale, shinL = shin0 * legScale;

  return {
    mesh,
    head,
    update(theta) {
      if (REST_POSE) return;
      for (const s of ['R', 'L']) {
        const side = s === 'R' ? -1 : 1;
        const { A, phi } = ankleAt(side, theta);
        const T = V().copy(A).addScaledVector(rotX(-0.3, 0.95, phi).normalize(), footLen);
        const hip = legs[s].hip;
        const K = ik2(hip, A, thighL, shinL, V(side * 0.15, 0, 1));
        setBone('thigh' + s, hip, V().subVectors(K, hip), thighL / len('hip' + s, 'knee' + s));
        const Ae = V().copy(K).addScaledVector(V().subVectors(A, K).normalize(), shinL);
        setBone('shin' + s, K, V().subVectors(Ae, K), shinL / len('knee' + s, 'ankle' + s));
        setBone('foot' + s, Ae, V().subVectors(T, A), footLen / len('ankle' + s, 'toe' + s));
      }
    },
  };
}
