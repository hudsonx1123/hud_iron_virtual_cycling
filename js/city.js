import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { V, canvasTex, rng } from './geom.js';

// 依 OpenStreetMap 資料生成真實地點的城市場景（座標：x 向東、z 向南，單位公尺）。
// 地圖資料 © OpenStreetMap contributors（ODbL）。
const LAYER_H = 6.5;   // 每層高架的高度
const GRADE = 0.05;    // 高架引道最大坡度
const FLOOR_H = 3.3;
const LIM_X = 1800, LIM_Z = 1880; // 只使用資料範圍內（道路會延伸到範圍外）
const inside = ([x, z]) => Math.abs(x) < LIM_X && Math.abs(z) < LIM_Z;

const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

// ---------- 貼圖 ----------
// 立面：一格 = 一個開間 × 一層樓；8×8 格隨機變化後重複
function facadeTex() {
  const rand = rng(7), N = 8, C = 64;
  const t = canvasTex(N * C, N * C, (ctx) => {
    ctx.fillStyle = '#d8d4cc'; ctx.fillRect(0, 0, N * C, N * C);
    for (let fy = 0; fy < N; fy++) for (let bx = 0; bx < N; bx++) {
      const x = bx * C, y = fy * C;
      ctx.fillStyle = `rgba(0,0,0,${0.02 + rand() * 0.05})`; ctx.fillRect(x, y, C, C);
      const kind = rand();
      if (kind < 0.12) continue; // 實牆
      const lit = rand() < 0.15;
      const g = lit ? 150 + rand() * 60 : 40 + rand() * 50;
      const wx = x + C * (kind < 0.5 ? 0.12 : 0.2), ww = C * (kind < 0.5 ? 0.76 : 0.6);
      ctx.fillStyle = `rgb(${g * 0.85},${g * 0.95},${g + 15})`;
      ctx.fillRect(wx, y + C * 0.18, ww, C * 0.55);
      ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(wx, y + C * 0.18, ww, C * 0.08);
      if (rand() < 0.35) { ctx.fillStyle = 'rgba(70,70,70,0.6)'; ctx.fillRect(wx - 2, y + C * 0.7, ww + 4, 3); } // 鐵窗 / 陽台
      if (rand() < 0.2) { ctx.fillStyle = '#9aa0a6'; ctx.fillRect(wx + ww * 0.6, y + C * 0.76, C * 0.22, C * 0.14); } // 冷氣機
    }
  });
  return t;
}

function laneTex(lanes) {
  const t = canvasTex(256, 512, (ctx, w, h) => {
    const line = (cx, lw, dash, color) => {
      ctx.fillStyle = color;
      if (!dash) ctx.fillRect(cx * w - lw / 2, 0, lw, h);
      else for (let y = 0; y < h; y += 512 / 2) ctx.fillRect(cx * w - lw / 2, y, lw, 512 * 0.2);
    };
    line(0.025, 5, false, 'rgba(240,240,232,0.95)');
    line(0.975, 5, false, 'rgba(240,240,232,0.95)');
    for (let i = 1; i < lanes; i++) line(i / lanes, 4, true, 'rgba(240,240,232,0.9)');
  });
  return t;
}

// ---------- 幾何工具 ----------
// 沿折線建帶狀面（含每點高度），回傳 position/uv 陣列
function ribbon(pts, hs, width, yOff, { uMetric = 3.5, vLen = 3.5, side = 0 } = {}) {
  const n = pts.length, pos = [], uvA = [], uvB = [], idx = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    const rx = -dz, rz = dx; // 行進方向右側
    if (i > 0) acc += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
    const y = hs[i] + yOff;
    const hw = width / 2;
    const o = side * hw;
    pos.push(p[0] + rx * (o - hw), y, p[1] + rz * (o - hw), p[0] + rx * (o + hw), y, p[1] + rz * (o + hw));
    uvA.push(0, acc / vLen, width / uMetric, acc / vLen);
    uvB.push(0, acc / 14, 1, acc / 14);
    if (i < n - 1) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); } // 法線朝上
  }
  return { pos, uvA, uvB, idx };
}

function geo(pos, idx, uv) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function polyShape(o, inner = []) {
  const s = new THREE.Shape(o.map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const h of inner) if (h.length > 2) s.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, -z))));
  return s;
}

// 平面多邊形（y 高度）
function flatPoly(polys, y, uvScale) {
  const geos = [];
  for (const p of polys) {
    if (!p.o || p.o.length < 3) continue;
    try {
      const g = new THREE.ShapeGeometry(polyShape(p.o, p.i || []));
      g.rotateX(-Math.PI / 2);
      g.translate(0, y, 0);
      const pa = g.attributes.position, uv = g.attributes.uv;
      for (let i = 0; i < pa.count; i++) uv.setXY(i, pa.getX(i) / uvScale, pa.getZ(i) / uvScale);
      geos.push(g);
    } catch { /* 非法多邊形略過 */ }
  }
  return geos.length ? mergeGeometries(geos) : null;
}

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// ---------- 高架高度：橋梁節點取 layer 高度，接地處依坡度漸降 ----------
function nodeHeights(data) {
  const target = new Map(), ground = new Set(), adj = new Map();
  const P = (id) => data.nodes[id];
  for (const r of data.roads) {
    if (r.tn) continue;
    const h = r.br ? Math.max(1, r.l) * LAYER_H : 0;
    for (const id of r.nd) {
      if (!r.br) ground.add(id);
      target.set(id, Math.max(target.get(id) ?? 0, h));
    }
    for (let i = 0; i < r.nd.length - 1; i++) {
      const a = r.nd[i], b = r.nd[i + 1], [ax, az] = P(a), [bx, bz] = P(b), d = Math.hypot(ax - bx, az - bz);
      (adj.get(a) || adj.set(a, []).get(a)).push([b, d]);
      (adj.get(b) || adj.set(b, []).get(b)).push([a, d]);
    }
  }
  // 由接地節點出發的 Dijkstra：h = min(目標高度, 距接地點距離 × 坡度)
  const dist = new Map(), heap = [];
  const push = (d, v) => { heap.push([d, v]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const t = heap[0], l = heap.pop(); if (heap.length) { heap[0] = l; let i = 0; for (;;) { const a = 2 * i + 1, b = a + 1; let m = i; if (a < heap.length && heap[a][0] < heap[m][0]) m = a; if (b < heap.length && heap[b][0] < heap[m][0]) m = b; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return t; };
  for (const id of ground) { dist.set(id, 0); push(0, id); }
  while (heap.length) {
    const [d, v] = pop();
    if (d > (dist.get(v) ?? Infinity)) continue;
    for (const [u, w] of adj.get(v) || []) {
      const nd = d + w;
      if (nd < (dist.get(u) ?? Infinity)) { dist.set(u, nd); push(nd, u); }
    }
  }
  const H = new Map();
  for (const [id, t] of target) H.set(id, Math.min(t, (dist.get(id) ?? Infinity) * GRADE));
  return H;
}

// ---------- 騎乘路線：最長的一條中山高主線（單向車道）鏈 ----------
function buildRoute(data, H) {
  const mw = data.roads.filter((r) => r.t === 'motorway' && r.ow && !r.tn);
  const byStart = new Map();
  for (const r of mw) (byStart.get(r.nd[0]) || byStart.set(r.nd[0], []).get(r.nd[0])).push(r);
  const ends = new Set(mw.map((r) => r.nd[r.nd.length - 1]));
  const P = (id) => data.nodes[id];
  const dir = (a, b) => { const [ax, az] = P(a), [bx, bz] = P(b), l = Math.hypot(bx - ax, bz - az) || 1; return [(bx - ax) / l, (bz - az) / l]; };
  let best = null;
  for (const start of mw.filter((r) => !ends.has(r.nd[0]))) {
    const chain = [start], seen = new Set([start]);
    for (;;) {
      const cur = chain[chain.length - 1], last = cur.nd[cur.nd.length - 1];
      const d0 = dir(cur.nd[cur.nd.length - 2], last);
      const next = (byStart.get(last) || []).filter((r) => !seen.has(r))
        .map((r) => ({ r, s: (() => { const d1 = dir(r.nd[0], r.nd[1]); return d0[0] * d1[0] + d0[1] * d1[1] + (r.ref === cur.ref ? 0.5 : 0); })() }))
        .sort((a, b) => b.s - a.s)[0];
      if (!next || next.s < 0.3) break;
      chain.push(next.r); seen.add(next.r);
    }
    const all = chain.flatMap((r, i) => (i ? r.nd.slice(1) : r.nd));
    // 取範圍內最長的連續一段
    let runs = [[]];
    for (const id of all) { if (inside(P(id))) runs[runs.length - 1].push(id); else if (runs[runs.length - 1].length) runs.push([]); }
    for (const ids of runs) {
      let len = 0;
      for (let i = 1; i < ids.length; i++) { const [ax, az] = P(ids[i - 1]), [bx, bz] = P(ids[i]); len += Math.hypot(bx - ax, bz - az); }
      if (ids.length > 2 && (!best || len > best.len)) best = { ids, len, width: chain[0].w };
    }
  }
  if (!best) return null;
  // 右側車道中心：往行進方向右側偏移（車道寬一半 − 1.8m）
  const off = best.width / 2 - 1.8;
  const pts = best.ids.map((id, i) => {
    const a = best.ids[Math.max(0, i - 1)], b = best.ids[Math.min(best.ids.length - 1, i + 1)];
    const [dx, dz] = dir(a, b), [x, z] = P(id);
    return V(x - dz * off, (H.get(id) ?? 0) + 0.06, z + dx * off);
  });
  // 去除過近的點，避免曲線打結
  const clean = [pts[0]];
  for (const p of pts.slice(1)) if (p.distanceTo(clean[clean.length - 1]) > 4) clean.push(p);
  const curve = new THREE.CatmullRomCurve3(clean, false, 'centripetal');
  return { curve, length: curve.getLength() };
}

// ---------- 地標 ----------
function taipei101(mat) {
  const parts = [];
  parts.push(new THREE.BoxGeometry(60, 25, 60).translate(0, 12.5, 0));                 // 裙樓
  parts.push(new THREE.CylinderGeometry(26, 32, 90, 4, 1).rotateY(Math.PI / 4).translate(0, 70, 0)); // 基座
  for (let i = 0; i < 8; i++) {                                                        // 八節「竹節」
    const y0 = 115 + i * 34;
    parts.push(new THREE.CylinderGeometry(25, 19, 34, 4, 1).rotateY(Math.PI / 4).translate(0, y0 + 17, 0));
  }
  parts.push(new THREE.CylinderGeometry(12, 15, 40, 4).rotateY(Math.PI / 4).translate(0, 407, 0));
  parts.push(new THREE.CylinderGeometry(2.5, 4, 75, 8).translate(0, 464, 0));         // 塔尖
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}

// 中國宮殿式屋頂（廡殿頂）：底部矩形向上收成屋脊
function palaceRoof(w, d, h, eave) {
  const W = w / 2 + eave, D = d / 2 + eave, rx = W * 0.62, ry = h;
  const p = [
    [-W, 0, -D], [W, 0, -D], [W, 0, D], [-W, 0, D], // 0-3 簷口
    [-rx, ry, 0], [rx, ry, 0],                       // 4-5 屋脊
  ];
  const f = [[0, 1, 5], [0, 5, 4], [2, 3, 4], [2, 4, 5], [1, 2, 5], [3, 0, 4]];
  const pos = [];
  for (const t of f) for (const k of t) pos.push(...p[k]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export async function buildCity(world, url) {
  const data = await (await fetch(url)).json();
  const scene = world.scene, group = new THREE.Group();
  scene.add(group);
  const H = nodeHeights(data);
  const P = (id) => data.nodes[id];
  const maxAniso = world.renderer.capabilities.getMaxAnisotropy();

  // 地面
  const groundMat = new THREE.MeshStandardMaterial({ color: 0xb8b5ad, roughness: 0.95, map: world.roadMat.map, normalMap: world.roadMat.normalMap, polygonOffset: true, polygonOffsetFactor: 6, polygonOffsetUnits: 6 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000).rotateX(-Math.PI / 2), groundMat);
  const gu = ground.geometry.attributes.uv;
  for (let i = 0; i < gu.count; i++) gu.setXY(i, gu.getX(i) * 9000 / 6, gu.getY(i) * 9000 / 6);
  ground.receiveShadow = true;
  group.add(ground);

  // 綠地、樹林、水域
  const grassMat = new THREE.MeshStandardMaterial({ color: 0x7fa060, map: world.groundMat.map, normalMap: world.groundMat.normalMap, roughness: 1, polygonOffset: true, polygonOffsetFactor: 3, polygonOffsetUnits: 3 });
  const g1 = flatPoly(data.green, 0.02, 5), g2 = flatPoly(data.wood, 0.025, 5);
  for (const g of [g1, g2]) if (g) { const m = new THREE.Mesh(g, grassMat); m.receiveShadow = true; group.add(m); }
  const waterMat = new THREE.MeshStandardMaterial({ color: 0x3d5a5c, roughness: 0.08, metalness: 0.2, envMapIntensity: 1.0, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
  const wg = flatPoly(data.water, 0.035, 10);
  if (wg) group.add(new THREE.Mesh(wg, waterMat));

  // 道路
  const roadParts = [], laneParts = new Map(), deckParts = [], parapetParts = [], pierParts = [];
  const yOff = { motorway: 0.09, trunk: 0.085, motorway_link: 0.08, trunk_link: 0.078, primary: 0.07, primary_link: 0.068, secondary: 0.06 };
  const pieces = [];
  for (const r of data.roads) {
    if (r.tn) continue;
    let cur = [];
    for (const id of r.nd) { if (inside(P(id))) cur.push(id); else { if (cur.length > 1) pieces.push({ ...r, nd: cur }); cur = []; } }
    if (cur.length > 1) pieces.push({ ...r, nd: cur });
  }
  for (const r of pieces) {
    const pts = r.nd.map(P), hs = r.nd.map((id) => H.get(id) ?? 0);
    const rb = ribbon(pts, hs, r.w, yOff[r.t] ?? 0.05);
    roadParts.push(geo(rb.pos, rb.idx, rb.uvA));
    if (['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link'].includes(r.t)) {
      const lanes = Math.max(1, Math.min(5, Math.round(r.w / 3.5)));
      const ln = ribbon(pts, hs, r.w, (yOff[r.t] ?? 0.05) + 0.01);
      (laneParts.get(lanes) || laneParts.set(lanes, []).get(lanes)).push(geo(ln.pos, ln.idx, ln.uvB));
    }
    // 高架：橋面版側面、護欄、橋墩
    if (hs.some((h) => h > 0.6)) {
      for (const side of [-1, 1]) {
        const par = ribbon(pts, hs.map((h) => h), 0.35, 0, { side: side * (r.w / 0.35) }), pos = [], idx = [];
        // 護欄：在路緣兩側立起 0.9m 的牆（以帶狀面上下兩條邊組成）
        const n = pts.length;
        for (let i = 0; i < n; i++) {
          const k = side < 0 ? 0 : 3;
          const x = par.pos[i * 6 + k], z = par.pos[i * 6 + k + 2], y = hs[i] + 0.09;
          pos.push(x, y, z, x, y + 0.95, z, x, y - 1.3, z);
          if (i < n - 1) {
            const a = i * 3, b = a + 3;
            idx.push(a, b, a + 1, a + 1, b, b + 1);       // 護欄
            idx.push(a + 2, b + 2, a, a, b + 2, b);       // 橋面版側面
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setIndex(idx);
        g.computeVertexNormals();
        parapetParts.push(g);
      }
      const under = ribbon(pts, hs, r.w, -1.3);
      deckParts.push(geo(under.pos, under.idx.map((v, i, a) => (i % 3 === 1 ? a[i + 1] : i % 3 === 2 ? a[i - 1] : v)), null));
      let acc = 15;
      for (let i = 1; i < pts.length; i++) {
        const [ax, az] = pts[i - 1], [bx, bz] = pts[i], seg = Math.hypot(bx - ax, bz - az);
        for (; acc < seg; acc += 32) {
          const t = acc / seg, h = hs[i - 1] + (hs[i] - hs[i - 1]) * t;
          if (h < 3) continue;
          const ang = Math.atan2(bx - ax, bz - az);
          pierParts.push(new THREE.BoxGeometry(Math.min(r.w * 0.6, 6), h - 1.3, 1.8).translate(0, (h - 1.3) / 2, 0).rotateY(ang).translate(ax + (bx - ax) * t, 0, az + (bz - az) * t));
        }
        acc -= seg;
      }
    }
  }
  const roadMat = world.roadMat.clone();
  roadMat.color = new THREE.Color(0xb0b0b0);
  const addMerged = (parts, mat, cast = true) => {
    if (!parts.length) return null;
    const m = new THREE.Mesh(mergeGeometries(parts.map((p) => (p.index ? p : p))), mat);
    m.receiveShadow = true; m.castShadow = cast;
    group.add(m);
    return m;
  };
  addMerged(roadParts, roadMat, false);
  for (const [lanes, parts] of laneParts) {
    const t = laneTex(lanes); t.anisotropy = maxAniso;
    addMerged(parts, new THREE.MeshStandardMaterial({ map: t, transparent: true, depthWrite: false, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), false);
  }
  const concrete = new THREE.MeshStandardMaterial({ color: 0xb9b6ad, roughness: 0.9 });
  addMerged(parapetParts.map((g) => { g.deleteAttribute('uv'); return g; }), new THREE.MeshStandardMaterial({ color: 0xc9c6bd, roughness: 0.85, side: THREE.DoubleSide }));
  addMerged(deckParts, concrete);
  addMerged(pierParts.map((g) => { g.deleteAttribute('uv'); g.deleteAttribute('normal'); return g; }).map((g) => { g.computeVertexNormals(); return g; }), concrete);

  // 捷運淡水線高架
  const railParts = [];
  for (const r of data.rail) {
    if (r.tn || r.pts.length < 2 || !r.br) continue;
    const hs = r.pts.map(() => Math.max(1, r.l) * 8);
    const rb = ribbon(r.pts, hs, 9, 0);
    railParts.push(geo(rb.pos, rb.idx, null));
    const und = ribbon(r.pts, hs, 9, -1.6);
    railParts.push(geo(und.pos, und.idx, null));
  }
  if (railParts.length) addMerged(railParts, concrete);

  // 建築
  const fac = facadeTex(); fac.anisotropy = maxAniso;
  const bMat = new THREE.MeshStandardMaterial({ map: fac, vertexColors: true, roughness: 0.82 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x77736c, roughness: 0.95 });
  const tints = ['#e8e2d6', '#d9d6d0', '#c9c2b4', '#efe9df', '#bfc4c8', '#d8cbb8', '#a9aaa6', '#e4ddd2'].map((c) => new THREE.Color(c));
  const wallPos = [], wallUv = [], wallCol = [], wallIdx = [], roofGeos = [];
  let grand = null;
  for (const b of data.buildings) {
    const o = b.o.slice(0, b.o[0][0] === b.o[b.o.length - 1][0] && b.o[0][1] === b.o[b.o.length - 1][1] ? -1 : undefined);
    if (o.length < 3) continue;
    let area = 0;
    for (let i = 0; i < o.length; i++) { const [x1, z1] = o[i], [x2, z2] = o[(i + 1) % o.length]; area += x1 * z2 - x2 * z1; }
    area /= 2;
    if (Math.abs(area) < 12) continue;
    if (area < 0) o.reverse(); // 統一繞向，牆面法線朝外
    const hs = hashStr(String(o[0]));
    const h = b.h || (Math.abs(area) < 60 ? 2 + (hs % 3) : 4 + (hs % 9)) * FLOOR_H;
    const y0 = b.mh || 0;
    if (/圓山大飯店|Grand Hotel/i.test(b.n) || (b.n === '主樓' && b.k === 'hotel')) { grand = { o, h: Math.max(h, 60) }; continue; }
    const tint = tints[hs % tints.length];
    let u = 0;
    for (let i = 0; i < o.length; i++) {
      const [x1, z1] = o[i], [x2, z2] = o[(i + 1) % o.length], len = Math.hypot(x2 - x1, z2 - z1);
      const k = wallPos.length / 3, u0 = u / 3.6, u1 = (u + len) / 3.6;
      wallPos.push(x1, y0, z1, x2, y0, z2, x2, h, z2, x1, h, z1);
      wallUv.push(u0 / 8, y0 / FLOOR_H / 8, u1 / 8, y0 / FLOOR_H / 8, u1 / 8, h / FLOOR_H / 8, u0 / 8, h / FLOOR_H / 8);
      for (let q = 0; q < 4; q++) wallCol.push(tint.r, tint.g, tint.b);
      wallIdx.push(k, k + 2, k + 1, k, k + 3, k + 2);
      u += len;
    }
    try {
      const rg = new THREE.ShapeGeometry(polyShape(o));
      rg.rotateX(-Math.PI / 2).translate(0, h, 0);
      rg.deleteAttribute('uv');
      roofGeos.push(rg);
    } catch { /* 略過 */ }
  }
  const walls = new THREE.BufferGeometry();
  walls.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3));
  walls.setAttribute('uv', new THREE.Float32BufferAttribute(wallUv, 2));
  walls.setAttribute('color', new THREE.Float32BufferAttribute(wallCol, 3));
  walls.setIndex(wallIdx);
  walls.computeVertexNormals();
  const wm = new THREE.Mesh(walls, bMat); wm.castShadow = wm.receiveShadow = true; group.add(wm);
  if (roofGeos.length) { const rm = new THREE.Mesh(mergeGeometries(roofGeos), roofMat); rm.receiveShadow = true; rm.castShadow = true; group.add(rm); }

  // 圓山大飯店：紅柱紅牆、金黃琉璃瓦屋頂（位置依 OSM；找不到時用旅館 POI）
  const hotelAt = grand ? (() => { let x = 0, z = 0; for (const [a, c] of grand.o) { x += a; z += c; } return [x / grand.o.length, z / grand.o.length]; })()
    : data.poi.find((p) => /圓山大飯店/.test(p.n))?.p;
  if (hotelAt) {
    const hg = new THREE.Group();
    const red = new THREE.MeshStandardMaterial({ color: 0xb3261e, roughness: 0.6 });
    const gold = new THREE.MeshStandardMaterial({ color: 0xd9a22b, roughness: 0.4, metalness: 0.25 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(140, 46, 26).translate(0, 23 + 16, 0), red);
    const base = new THREE.Mesh(new THREE.BoxGeometry(170, 16, 50).translate(0, 8, 0), new THREE.MeshStandardMaterial({ color: 0xd9d2c3, roughness: 0.8 }));
    const roof = new THREE.Mesh(palaceRoof(140, 26, 14, 5).translate(0, 62, 0), gold);
    const roof2 = new THREE.Mesh(palaceRoof(150, 34, 4, 4).translate(0, 44, 0), gold);
    for (const m of [body, base, roof, roof2]) { m.castShadow = m.receiveShadow = true; hg.add(m); }
    hg.position.set(hotelAt[0], 25, hotelAt[1]); // 飯店建在山坡上
    if (grand) { // 依建築輪廓最長邊決定朝向
      let best = 0, ang = 0;
      for (let i = 0; i < grand.o.length; i++) {
        const [x1, z1] = grand.o[i], [x2, z2] = grand.o[(i + 1) % grand.o.length], l = Math.hypot(x2 - x1, z2 - z1);
        if (l > best) { best = l; ang = Math.atan2(-(z2 - z1), x2 - x1); }
      }
      hg.rotation.y = ang;
    }
    const hill = new THREE.Mesh(new THREE.ConeGeometry(260, 60, 24, 1, true).translate(0, 30 - 5, 0), grassMat);
    hill.position.set(hotelAt[0], 0, hotelAt[1] - 40);
    group.add(hill, hg);
  }

  // 台北 101（真實方位，約東南 6km；不受霧影響，以淡藍灰色表現空氣透視）
  const lat0 = data.center[0], lon0 = data.center[1];
  const x101 = (121.5645 - lon0) * 111320 * Math.cos((lat0 * Math.PI) / 180), z101 = -(25.0339 - lat0) * 110574;
  const t101 = taipei101(new THREE.MeshBasicMaterial({ color: 0x8fa3b0, fog: false }));
  t101.position.set(x101, 0, z101);
  group.add(t101);

  // 公園與樹林裡的樹（實例化，取自山路場景的樹種）
  const rand = rng(99), kinds = world.treeKinds.slice(0, 4);
  const tm = kinds.map((k) => ({ leaves: new THREE.InstancedMesh(k.leaves, k.leafMat, 1500), wood: k.wood && new THREE.InstancedMesh(k.wood, k.bark, 1500), n: 0 }));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = V(), pp = V(), up = V(0, 1, 0);
  for (const polys of [data.wood, data.green]) {
    for (const p of polys) {
      const o = p.o; if (!o || o.length < 3) continue;
      let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
      for (const [x, z] of o) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); minz = Math.min(minz, z); maxz = Math.max(maxz, z); }
      const area = (maxx - minx) * (maxz - minz), count = Math.min(polys === data.wood ? 400 : 120, Math.floor(area / (polys === data.wood ? 90 : 350)));
      for (let i = 0; i < count; i++) {
        const x = minx + rand() * (maxx - minx), z = minz + rand() * (maxz - minz);
        if (!pointInPoly(x, z, o)) continue;
        const t = tm[(rand() * (polys === data.wood ? 4 : 3)) | 0];
        if (t.n >= 1500) continue;
        q.setFromAxisAngle(up, rand() * 6.28);
        m4.compose(pp.set(x, 0, z), q, sc.setScalar(0.7 + rand() * 0.6));
        t.leaves.setMatrixAt(t.n, m4); if (t.wood) t.wood.setMatrixAt(t.n, m4);
        t.n++;
      }
    }
  }
  for (const t of tm) for (const m of [t.leaves, t.wood]) {
    if (!m) continue;
    m.count = t.n; m.castShadow = m.receiveShadow = true; m.computeBoundingSphere(); group.add(m);
  }

  const route = buildRoute(data, H);
  console.log(`city: roads ${data.roads.length}, buildings ${data.buildings.length}, route ${route ? Math.round(route.length) : 0} m`);
  return { group, route };
}
