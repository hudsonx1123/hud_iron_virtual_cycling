import * as THREE from 'three';
import { canvasTex } from './geom.js';

// 實景路線的資料層：內政部 20m DTM 地形、國土測繪中心正射航照（執行時即時載入，不存進 repo）、
// OpenStreetMap 房屋 / 道路 / 溪流。座標同 route.js（以路線起點為原點，x 向東、z 向南、y 為相對起點高度）。
const NLSC = (z, y, x) => `https://wmts.nlsc.gov.tw/wmts/PHOTO2/default/GoogleMapsCompatible/${z}/${y}/${x}`;

export function makeTerrain(r, dem) {
  const raw = atob(dem.h), h = new Int16Array(raw.length / 2);
  for (let i = 0; i < h.length; i++) h[i] = raw.charCodeAt(2 * i) | (raw.charCodeAt(2 * i + 1) << 8);
  const toLL = (x, z) => [r.lat0 - z / r.kz, r.lon0 + x / r.kx];
  const demY = (x, z) => {
    const [lat, lon] = toLL(x, z);
    const fx = Math.min(dem.nx - 1.001, Math.max(0, (lon - dem.lon0) / dem.dlon));
    const fy = Math.min(dem.ny - 1.001, Math.max(0, (lat - dem.lat0) / dem.dlat));
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j, k = j * dem.nx + i;
    const a = h[k] * (1 - u) + h[k + 1] * u, b = h[k + dem.nx] * (1 - u) + h[k + dem.nx + 1] * u;
    return (a * (1 - v) + b * v) / 10 - r.ele0;
  };
  const bounds = {
    x0: (dem.lon0 - r.lon0) * r.kx, x1: (dem.lon0 + (dem.nx - 1) * dem.dlon - r.lon0) * r.kx,
    z0: -(dem.lat0 + (dem.ny - 1) * dem.dlat - r.lat0) * r.kz, z1: -(dem.lat0 - r.lat0) * r.kz,
  };
  return { demY, bounds, toLL };
}

// 拼接正射航照：在 4096px 以內選最高的縮放層級；失敗（離線）時回傳 null
export async function loadAerial(r, terrain, renderer) {
  const { x0, x1, z0, z1 } = terrain.bounds;
  const [n, w] = terrain.toLL(x0, z0), [s, e] = terrain.toLL(x1, z1);
  const px = (lon, z) => ((lon + 180) / 360) * 2 ** z * 256;
  const py = (lat, z) => { const t = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(t) + 1 / Math.cos(t)) / Math.PI) / 2) * 2 ** z * 256; };
  let z = 18;
  while (z > 12 && Math.max(px(e, z) - px(w, z), py(s, z) - py(n, z)) > 4096) z--;
  const X0 = px(w, z), Y0 = py(n, z), W = Math.ceil(px(e, z) - X0), H = Math.ceil(py(s, z) - Y0);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const jobs = [];
  for (let ty = Math.floor(Y0 / 256); ty <= Math.floor((Y0 + H) / 256); ty++)
    for (let tx = Math.floor(X0 / 256); tx <= Math.floor((X0 + W) / 256); tx++) jobs.push([tx, ty]);
  let ok = 0;
  const load = ([tx, ty]) => new Promise((done) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => { img.src = ''; done(); }, 15000);
    img.onload = () => { clearTimeout(timer); ctx.drawImage(img, tx * 256 - X0, ty * 256 - Y0); ok++; done(); };
    img.onerror = () => { clearTimeout(timer); done(); };
    img.src = NLSC(z, ty, tx);
  });
  const queue = jobs.slice();
  await Promise.all(Array.from({ length: 10 }, async () => { while (queue.length) await load(queue.shift()); }));
  if (ok < jobs.length * 0.5) return null;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const img = ctx.getImageData(0, 0, W, H).data;
  const toPix = (x, zz) => { const [lat, lon] = terrain.toLL(x, zz); return [px(lon, z) - X0, py(lat, z) - Y0]; };
  return {
    tex,
    uv: (x, zz) => { const [u, v] = toPix(x, zz); return [u / W, 1 - v / H]; },
    // 植被程度（綠色、偏暗）：用來決定哪裡種樹
    veg: (x, zz) => {
      const [u, v] = toPix(x, zz);
      const i = (Math.min(H - 1, Math.max(0, v | 0)) * W + Math.min(W - 1, Math.max(0, u | 0))) * 4;
      const R = img[i], G = img[i + 1], B = img[i + 2], L = (R + G + B) / 3;
      return G >= R * 0.97 && G >= B * 0.9 && L < 170 ? 1 : 0;
    },
  };
}

// 地面材質：航照提供顏色分布（森林、房屋、溪流），草地貼圖的明暗提供近看的細節；航照偏灰暗，稍微提亮、加飽和。
// 頂點屬性 aNear（離路近 = 1）：路旁改用草地，避免近看到被拉糊的航照
export function aerialMaterial(aerial, detailTex) {
  const m = new THREE.MeshStandardMaterial({ map: aerial.tex, roughness: 1, envMapIntensity: 0.5 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.detailMap = { value: detailTex };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aNear;\nvarying vec2 vDetailUv;\nvarying float vNear;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDetailUv = position.xz / 4.0;\nvNear = aNear;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D detailMap;\nvarying vec2 vDetailUv;\nvarying float vNear;')
      .replace('#include <map_fragment>', `
        vec3 aer = texture2D(map, vMapUv, 1.5).rgb;
        float al = dot(aer, vec3(0.299, 0.587, 0.114));
        aer = mix(vec3(al), aer, 1.4) * 1.35;
        vec3 det = texture2D(detailMap, vDetailUv).rgb;
        float dl = dot(det, vec3(0.299, 0.587, 0.114));
        vec3 grass = det * vec3(0.62, 1.0, 0.5) * 1.15;
        diffuseColor.rgb *= mix(aer * (0.45 + dl * 1.3), grass, vNear);`);
  };
  return m;
}

// 依 OSM 折線鋪帶狀面（側路、溪流），離主路線太近的部分截斷
function ribbons(lines, r, ground, cut, width, lift) {
  const pos = [], uv = [], idx = [];
  for (const { pts, w } of lines) {
    const P = pts.map(([lat, lon]) => [(lon - r.lon0) * r.kx, -(lat - r.lat0) * r.kz]);
    const dense = [];
    for (let i = 0; i < P.length - 1; i++) {
      const [ax, az] = P[i], [bx, bz] = P[i + 1], L = Math.hypot(bx - ax, bz - az), m = Math.max(1, Math.ceil(L / 4));
      for (let k = 0; k < m; k++) dense.push([ax + ((bx - ax) * k) / m, az + ((bz - az) * k) / m]);
    }
    dense.push(P[P.length - 1]);
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        let s = 0;
        run.forEach(([x, z], i) => {
          const [px, pz] = run[Math.max(0, i - 1)], [nx, nz] = run[Math.min(run.length - 1, i + 1)];
          const dx = nx - px, dz = nz - pz, l = Math.hypot(dx, dz) || 1, ox = (dz / l) * (w ?? width) / 2, oz = (-dx / l) * (w ?? width) / 2;
          if (i) s += Math.hypot(x - run[i - 1][0], z - run[i - 1][1]);
          const base = pos.length / 3;
          for (const sd of [1, -1]) {
            const X = x + ox * sd, Z = z + oz * sd;
            pos.push(X, ground(X, Z) + lift, Z);
            uv.push(sd > 0 ? 0 : (w ?? width) / 3.5, s / 3.5);
          }
          if (i) idx.push(base - 2, base - 1, base, base - 1, base + 1, base);
        });
      }
      run = [];
    };
    for (const p of dense) {
      if (cut(p[0], p[1])) flush(); else run.push(p);
    }
    flush();
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const ROAD_W = { primary: 8, secondary: 7, tertiary: 6, unclassified: 5, residential: 5, living_street: 4, service: 3.5 };
const toXZ = (r) => ([lat, lon]) => [(lon - r.lon0) * r.kx, -(lat - r.lat0) * r.kz];
const inPoly = (P, x, z) => {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++)
    if (P[i][1] > z !== P[j][1] > z && x < ((P[j][0] - P[i][0]) * (z - P[i][1])) / (P[j][1] - P[i][1]) + P[i][0]) inside = !inside;
  return inside;
};
const segD = (x, z, [ax, az], [bx, bz]) => {
  const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(x - ax - dx * t, z - az - dz * t);
};
const ring = (p, r) => { const P = p.map(toXZ(r)); return P.length > 2 && P[0][0] === P.at(-1)[0] && P[0][1] === P.at(-1)[1] ? P.slice(0, -1) : P; };

// 是否落在房屋內或離牆 buf 公尺內（種樹時避開；路旁的樹會用較大的 buf，讓有房子的路段樹少一點）
export function buildingBlocker(r, scene) {
  const polys = scene.buildings.map((b) => {
    const P = ring(b.p, r), xs = P.map((p) => p[0]), zs = P.map((p) => p[1]);
    return { P, x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
  });
  return (x, z, buf = 2) => polys.some(({ P, x0, x1, z0, z1 }) => {
    if (x < x0 - buf || x > x1 + buf || z < z0 - buf || z > z1 + buf) return false;
    if (inPoly(P, x, z)) return true;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) if (segD(x, z, P[i], P[j]) < buf) return true;
    return false;
  });
}

// 招牌貼圖
function signTex(w, h, draw) {
  const t = canvasTex(w, h, draw);
  t.anisotropy = 8;
  return t;
}
// 面向道路的看板（中心 p、寬 w、高 h，法線指向 (nx, nz)）
function board(tex, w, h, x, y, z, nx, nz, back = 0x6b7076) {
  const g = new THREE.Group();
  const front = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }));
  const rear = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ color: back, roughness: 0.8 }));
  rear.rotation.y = Math.PI;
  g.add(front, rear);
  g.position.set(x, y, z);
  g.rotation.y = Math.atan2(nx, nz);
  return g;
}

// 地標：路段名稱與在路線上的距離，供 HUD 顯示
export function landmarkMarks(r, scene, nearest) {
  const marks = [];
  for (const [s0, s1, name] of scene.route?.bridges ?? []) if (name) marks.push({ s: (s0 + s1) / 2, label: name, kind: 'bridge' });
  for (const l of scene.landmarks ?? []) {
    if (!['police', 'school', 'turning', 'shelter', 'inscription'].includes(l.t)) continue;
    const P = ring(l.p, r);
    const q = P.map(([x, z]) => nearest(x, z)).reduce((a, b) => (b.d < a.d ? b : a));
    const trail = l.t === 'turning' && scene.landmarks.find((x) => x.t === 'trail');
    const label = trail ? `${l.name}・${trail.name}` : l.t === 'inscription' ? `「${l.name}」字岩壁` : l.name;
    marks.push({ s: r.s[q.i], label, kind: l.t });
  }
  return marks.sort((a, b) => a.s - b.s);
}

// 平坦區（公車迴轉場）：回傳包裝過的地形函式與是否在區內的判斷
export function turningArea(r, scene, hw) {
  const l = (scene.landmarks ?? []).find((x) => x.t === 'turning');
  if (!l) return null;
  const n = r.s.length, [px, pz] = toXZ(r)(l.p[0]);
  const ex = r.tx[n - 1], ez = r.tz[n - 1]; // 終點行進方向
  const L = 28, W = 20, cx = px + ex * 6, cz = pz + ez * 6, y = r.y[n - 1];
  const local = (x, z) => [(x - cx) * ex + (z - cz) * ez, (x - cx) * ez - (z - cz) * ex]; // 沿路 / 側向
  const dist = (x, z) => { const [a, b] = local(x, z); return Math.max(Math.abs(a) - L / 2, Math.abs(b) - W / 2); };
  // 步道入口石碑：立在步道離開迴轉場處的旁邊，周圍淨空（不種樹、不長草）
  const tl = (scene.landmarks ?? []).find((x) => x.t === 'trail');
  let stone = null;
  if (tl) {
    const P = tl.p.map(toXZ(r));
    for (let i = 1; i < P.length && !stone; i++) {
      const [ax, az] = P[i - 1], [bx, bz] = P[i], len = Math.hypot(bx - ax, bz - az);
      for (let t = 0; t <= len; t += 0.5) {
        const x = ax + ((bx - ax) * t) / len, z = az + ((bz - az) * t) / len;
        if (dist(x, z) < 1.5) continue;
        const dx = (bx - ax) / len, dz = (bz - az) / len;
        stone = { name: tl.name, x: x + dz * 3.2, z: z - dx * 3.2 }; // 步道右側
        break;
      }
    }
  }
  // 流動廁所兩座（OSM 有標廁所時）：迴轉場左側柏油邊緣（黃框外）、終點前方，騎到終點時在左前方看得到；門朝迴轉場
  const toilets = (scene.landmarks ?? []).some((x) => x.t === 'toilets')
    ? [-0.7, 0.7].map((d) => ({ x: cx + ex * (L / 2 - 4 + d) + ez * (W / 2 + 1), z: cz + ez * (L / 2 - 4 + d) - ex * (W / 2 + 1) }))
    : null;
  const near = (p, x, z, rad) => p && Math.hypot(x - p.x, z - p.z) < rad;
  const inside = (x, z, buf = 0) => dist(x, z) < buf || near(stone, x, z, 1.8 + buf) || (toilets ?? []).some((p) => near(p, x, z, 1.2 + buf));
  return { cx, cz, ex, ez, L, W, y, name: l.name, dist, inside, stone, toilets };
}

// 不種樹、不長草的範圍：終點迴轉場、涼亭與題字岩壁周圍，以及它們到路線之間（涼亭看終點、岩壁看最近的路段），騎過時看得到
export function keepClear(r, scene, turning) {
  const n = r.s.length;
  const zones = (scene.landmarks ?? []).filter((l) => l.t === 'shelter' || l.t === 'inscription').map((l) => {
    const P = ring(l.p, r), c = [P.reduce((a, p) => a + p[0], 0) / P.length, P.reduce((a, p) => a + p[1], 0) / P.length];
    let k = n - 1;
    if (l.t === 'inscription') for (let i = 0; i < n; i++) if (Math.hypot(r.x[i] - c[0], r.z[i] - c[1]) < Math.hypot(r.x[k] - c[0], r.z[k] - c[1])) k = i;
    return { P, c, to: [r.x[k], r.z[k]], pad: l.t === 'inscription' ? 5 : 2.5 };
  });
  if (!turning && !zones.length) return null;
  return (x, z, buf = 0) => !!turning?.inside(x, z, buf) || zones.some(({ P, c, to, pad }) =>
    (P.length > 2 && inPoly(P, x, z)) || P.some((a, i) => segD(x, z, a, P[(i + 1) % P.length]) < pad + buf) || segD(x, z, c, to) < 10 + buf);
}

// 沿路線掃出截面（橋面、護牆），sec = [[側向 o, 高度差], ...]
function sweep(ctx, i0, i1, sec) {
  const { r, tx, tz } = ctx, pos = [], idx = [];
  for (let i = i0; i <= i1; i++) {
    const nx = tz[i], nz = -tx[i];
    for (const [o, dy] of sec(i)) pos.push(r.x[i] + nx * o, r.y[i] + dy, r.z[i] + nz * o);
    if (i > i0) {
      const m = sec(i).length, a = (i - i0 - 1) * m, b = (i - i0) * m;
      for (let k = 0; k < m - 1; k++) idx.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildBridges(ctx, group) {
  const { r, hw, onBridge, demY, n } = ctx;
  const concrete = new THREE.MeshStandardMaterial({ color: 0xb9b6ae, roughness: 0.9, side: THREE.DoubleSide });
  for (let i = 0; i < n; i++) {
    if (!onBridge[i] || (i && onBridge[i - 1])) continue;
    let j = i;
    while (j + 1 < n && onBridge[j + 1]) j++;
    // 橋面板（側面與底面）
    const deck = sweep(ctx, i, j, (k) => [[hw[k] + 0.45, -0.02], [hw[k] + 0.45, -1.1], [-hw[k] - 0.45, -1.1], [-hw[k] - 0.45, -0.02]]);
    const dm = new THREE.Mesh(deck, concrete); dm.castShadow = dm.receiveShadow = true; group.add(dm);
    // 兩側護牆
    for (const sd of [1, -1]) {
      const wall = sweep(ctx, i, j, (k) => [[sd * hw[k], 0], [sd * hw[k], 1.05], [sd * (hw[k] + 0.4), 1.05], [sd * (hw[k] + 0.4), -0.05]]);
      const wm = new THREE.Mesh(wall, concrete); wm.castShadow = wm.receiveShadow = true; group.add(wm);
    }
    // 橋墩
    const span = r.s[j] - r.s[i], cnt = Math.max(1, Math.round(span / 16) - 1);
    for (let c = 1; c <= cnt; c++) {
      const k = Math.round(i + ((j - i) * c) / (cnt + 1)), top = r.y[k] - 1.1, bot = demY(r.x[k], r.z[k]) - 1;
      if (top - bot < 1) continue;
      const pier = new THREE.Mesh(new THREE.BoxGeometry(hw[k] * 1.4, top - bot, 1.2), concrete);
      pier.position.set(r.x[k], (top + bot) / 2, r.z[k]);
      pier.rotation.y = Math.atan2(ctx.tx[k], ctx.tz[k]);
      pier.castShadow = pier.receiveShadow = true;
      group.add(pier);
    }
  }
}

export function buildRealObjects(world, ctx) {
  const { r, scene, ground, nearest, hw, onBridge, turning } = ctx;
  const group = new THREE.Group();
  const nearRoad = (x, z, extra) => { const q = nearest(x, z); return q.d < hw[q.i] + extra; };
  // 側路
  const roadMat = world.roadMat.clone();
  Object.assign(roadMat, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const rg = ribbons(scene.roads.map((x) => ({ pts: x.p, w: ROAD_W[x.t] ?? 4 })), r, ground, (x, z) => nearRoad(x, z, 1.2) || turning?.inside(x, z, 1), 4, 0.08);
  if (rg) { const m = new THREE.Mesh(rg, roadMat); m.receiveShadow = true; group.add(m); }
  // 溪流（從橋下穿過的部分保留）
  const waterMat = new THREE.MeshStandardMaterial({ color: 0x47605a, roughness: 0.1, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const sg = ribbons(scene.streams.map((x) => ({ pts: x.p, w: x.t === 'river' ? 12 : 3 })), r, ground, (x, z) => { const q = nearest(x, z); return !onBridge[q.i] && q.d < hw[q.i] + 2; }, 3, 0.15);
  if (sg) group.add(new THREE.Mesh(sg, waterMat));
  buildBridges(ctx, group);

  // 房屋：一般住宅、派出所（白牆藍帶）、學校（暖色外牆）
  const marks = scene.landmarks ?? [];
  const police = marks.filter((l) => l.t === 'police').map((l) => ({ ...l, P: ring(l.p, r) }));
  const schools = marks.filter((l) => l.t === 'school').map((l) => ({ ...l, P: ring(l.p, r) }));
  const wallTex = (base, band, win) => {
    const t = canvasTex(128, 128, (c, w, h) => {
      c.fillStyle = base; c.fillRect(0, 0, w, h);
      c.fillStyle = band; c.fillRect(0, h * 0.84, w, h * 0.16);
      c.fillStyle = win; c.fillRect(w * 0.2, h * 0.22, w * 0.6, h * 0.46);
      c.fillStyle = 'rgba(255,255,255,.18)'; c.fillRect(w * 0.2, h * 0.22, w * 0.6, h * 0.08);
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  };
  // 雙面材質：OSM 外框繞向不一，three 會依正反面自動翻轉法線
  const styles = {
    house: { mat: new THREE.MeshStandardMaterial({ map: wallTex('#d9d4ca', '#c8c2b6', '#3b4650'), vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }), roof: 0x8a8781 },
    police: { mat: new THREE.MeshStandardMaterial({ map: wallTex('#f2f2ee', '#1f4e9c', '#2c3a48'), vertexColors: true, roughness: 0.6, side: THREE.DoubleSide }), roof: 0x9aa0a6 },
    school: { mat: new THREE.MeshStandardMaterial({ map: wallTex('#e9b98a', '#f4efe6', '#33424f'), vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }), roof: 0xa4553f },
  };
  const buckets = Object.fromEntries(Object.keys(styles).map((k) => [k, { wp: [], wu: [], wc: [], rp: [], ri: [] }]));
  const tint = new THREE.Color();
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const b of scene.buildings) {
    const P = ring(b.p, r);
    if (P.length < 3 || P.some(([x, z]) => nearRoad(x, z, 1))) continue;
    const cx = P.reduce((a, p) => a + p[0], 0) / P.length, cz = P.reduce((a, p) => a + p[1], 0) / P.length;
    const pol = police.find((l) => inPoly(l.P, cx, cz) || inPoly(P, ...l.P[0]) || Math.hypot(l.P[0][0] - P[0][0], l.P[0][1] - P[0][1]) < 1); // OSM 派出所可能是外框或單點
    const style = pol ? 'police' : schools.some((l) => inPoly(l.P, cx, cz)) ? 'school' : 'house';
    const B = buckets[style];
    const gs = P.map(([x, z]) => ground(x, z));
    const lo = Math.min(...gs), base = lo - 0.3, top = Math.max(lo + b.h, Math.max(...gs) + 2.5); // 斜坡上的房子：高側至少露出 2.5m
    if (style === 'house') tint.setHSL(0.08 + rnd() * 0.06, 0.12 + rnd() * 0.15, 0.82 + rnd() * 0.12); else tint.setRGB(1, 1, 1);
    let u = 0;
    for (let i = 0; i < P.length; i++) {
      const [ax, az] = P[i], [bx, bz] = P[(i + 1) % P.length], L = Math.hypot(bx - ax, bz - az);
      const quad = [[ax, base, az, u, 0], [bx, base, bz, u + L / 3, 0], [bx, top, bz, u + L / 3, (top - base) / 3.2], [ax, top, az, u, (top - base) / 3.2]];
      for (const k of [0, 1, 2, 0, 2, 3]) { const q = quad[k]; B.wp.push(q[0], q[1], q[2]); B.wu.push(q[3], q[4]); B.wc.push(tint.r, tint.g, tint.b); }
      u += L / 3;
    }
    const tri = THREE.ShapeUtils.triangulateShape(P.map(([x, z]) => new THREE.Vector2(x, -z)), []);
    const o = B.rp.length / 3;
    for (const [x, z] of P) B.rp.push(x, top, z);
    for (const [a, b2, c] of tri) B.ri.push(o + a, o + c, o + b2);
    if (pol) policeSign(group, pol.name, P, top, nearest, ground);
  }
  for (const [k, B] of Object.entries(buckets)) {
    if (!B.wp.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(B.wp, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(B.wu, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(B.wc, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, styles[k].mat); m.castShadow = m.receiveShadow = true; group.add(m);
    const rgeo = new THREE.BufferGeometry();
    rgeo.setAttribute('position', new THREE.Float32BufferAttribute(B.rp, 3));
    rgeo.setIndex(B.ri);
    rgeo.computeVertexNormals();
    const roof = new THREE.Mesh(rgeo, new THREE.MeshStandardMaterial({ color: styles[k].roof, roughness: 0.95, side: THREE.DoubleSide }));
    roof.castShadow = roof.receiveShadow = true; group.add(roof);
  }

  for (const s of schools) buildSchool(group, s, marks, ctx);
  if (turning) buildTurning(group, turning, world);
  else buildJunction(group, ctx, world);
  if (turning?.stone) buildTrailStone(group, turning, ctx);
  if (turning?.toilets) buildToilets(group, turning, ctx);
  for (const l of marks.filter((x) => x.t === 'bus')) busStop(group, l, ctx);
  for (const l of marks.filter((x) => x.t === 'shelter')) buildShelter(group, l, ctx);
  for (const l of marks.filter((x) => x.t === 'inscription')) buildInscription(group, l, ctx);
  return group;
}

// 派出所：面向道路那面牆掛藍底白字招牌，屋頂紅藍警示燈
function policeSign(group, name, P, top, nearest, ground) {
  let best = null;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length], mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, d = nearest(mx, mz).d;
    if (!best || d < best.d) best = { a, b, mx, mz, d };
  }
  const { a, b, mx, mz } = best, L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let nx = (b[1] - a[1]) / L, nz = -(b[0] - a[0]) / L;
  if (nearest(mx + nx * 3, mz + nz * 3).d > best.d) { nx = -nx; nz = -nz; } // 法線朝向道路
  const w = Math.min(L * 0.9, 8), y = Math.min(top - 0.8, ground(mx + nx * 2, mz + nz * 2) + 3.6); // 招牌掛在面向道路那側地面上方
  const tex = signTex(512, 128, (c, W, H) => {
    c.fillStyle = '#1f4e9c'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = 'bold 26px sans-serif'; c.fillText('臺北市政府警察局', W / 2, H * 0.22);
    c.font = 'bold 58px sans-serif'; c.fillText(name, W / 2, H * 0.62);
    c.font = 'bold 18px sans-serif'; c.fillText('POLICE', W / 2, H * 0.92);
  });
  group.add(board(tex, w, w / 4, mx + nx * 0.15, y, mz + nz * 0.15, nx, nz));
  const cx = P.reduce((s, p) => s + p[0], 0) / P.length, cz = P.reduce((s, p) => s + p[1], 0) / P.length;
  for (const [col, off] of [[0xff2020, -0.35], [0x2050ff, 0.35]]) {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.3), new THREE.MeshBasicMaterial({ color: col }));
    lamp.position.set(cx + nz * off, top + 0.15, cz - nx * off);
    lamp.rotation.y = Math.atan2(nx, nz);
    group.add(lamp);
  }
}

// 學校：圍牆、面向道路的校門招牌、球場與遊戲場
function buildSchool(group, s, marks, ctx) {
  const { r, ground, nearest, hw } = ctx, P = s.P;
  const fenceTex = signTex(128, 64, (c, W, H) => {
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#4f6b5a';
    c.fillRect(0, 0, W, 5); c.fillRect(0, H * 0.55, W, 4);
    for (let x = 4; x < W; x += 12) c.fillRect(x, 0, 3, H);
  });
  fenceTex.wrapS = THREE.RepeatWrapping;
  const fenceMat = new THREE.MeshStandardMaterial({ map: fenceTex, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.6 });
  const pos = [], uv = [];
  let gate = null;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]), m = Math.max(1, Math.ceil(L / 3));
    for (let k = 0; k < m; k++) {
      const x0 = a[0] + ((b[0] - a[0]) * k) / m, z0 = a[1] + ((b[1] - a[1]) * k) / m;
      const x1 = a[0] + ((b[0] - a[0]) * (k + 1)) / m, z1 = a[1] + ((b[1] - a[1]) * (k + 1)) / m;
      const q = nearest((x0 + x1) / 2, (z0 + z1) / 2);
      if (!gate || q.d < gate.q.d) gate = { q, x: (x0 + x1) / 2, z: (z0 + z1) / 2 };
      if (q.d < hw[q.i] + 1.5) continue; // 圍牆不擋到路
      const y0 = ground(x0, z0), y1 = ground(x1, z1), l = Math.hypot(x1 - x0, z1 - z0) / 2.5;
      pos.push(x0, y0, z0, x1, y1, z1, x1, y1 + 1.8, z1, x0, y0, z0, x1, y1 + 1.8, z1, x0, y0 + 1.8, z0);
      uv.push(0, 0, l, 0, l, 1, 0, 0, l, 1, 0, 1);
    }
  }
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  fg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  fg.computeVertexNormals();
  group.add(new THREE.Mesh(fg, fenceMat));
  // 校門招牌：立在最靠近道路的圍牆處，面向道路
  if (gate) {
    const i = gate.q.i, sd = Math.sign(gate.q.o) || 1, nx = r.tz[i] * sd, nz = -r.tx[i] * sd;
    const off = hw[i] + 1.8, x = r.x[i] + nx * off, z = r.z[i] + nz * off, y = ground(x, z);
    const tex = signTex(512, 128, (c, W, H) => {
      c.fillStyle = '#f7f3e8'; c.fillRect(0, 0, W, H);
      c.strokeStyle = '#2f6b3d'; c.lineWidth = 8; c.strokeRect(4, 4, W - 8, H - 8);
      c.fillStyle = '#2f6b3d'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = 'bold 62px sans-serif'; c.fillText(s.name, W / 2, H * 0.42);
      c.font = 'bold 20px sans-serif'; c.fillText('ELEMENTARY SCHOOL', W / 2, H * 0.82);
    });
    // 看板轉向迎面而來的騎士（介於面向道路與面向來車之間）
    let fx = -nx - r.tx[i], fz = -nz - r.tz[i];
    const fl = Math.hypot(fx, fz); fx /= fl; fz /= fl;
    group.add(board(tex, 4.4, 1.1, x, y + 2.4, z, fx, fz));
    const postMat = new THREE.MeshStandardMaterial({ color: 0x8c8f93, roughness: 0.6 });
    for (const e of [-2.1, 2.1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.95, 0.18), postMat);
      post.position.set(x + fz * e, y + 1.47, z - fx * e);
      group.add(post);
    }
  }
  // 球場（綠色、白邊線）與遊戲場（紅色地墊）
  for (const l of marks) {
    if (l.t !== 'pitch' && l.t !== 'playground' && l.t !== 'track') continue;
    const Q = ring(l.p, r);
    if (Q.length < 3) continue;
    const ys = Q.map(([x, z]) => ground(x, z)), y = ys.reduce((a, b) => a + b, 0) / ys.length + 0.1;
    const tri = THREE.ShapeUtils.triangulateShape(Q.map(([x, z]) => new THREE.Vector2(x, -z)), []);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(Q.flatMap(([x, z]) => [x, y, z]), 3));
    g.setIndex(tri.flatMap(([a, b, c]) => [a, c, b]));
    g.computeVertexNormals();
    const col = l.t === 'playground' ? 0xc0503a : l.t === 'track' ? 0xb0453a : 0x2f7d5a;
    group.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: col, roughness: 0.9, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })));
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Q.map(([x, z]) => new THREE.Vector3(x, y + 0.02, z))), new THREE.LineBasicMaterial({ color: 0xffffff }));
    group.add(line);
  }
}

// 公車迴轉場：大片柏油加黃色網狀線
function buildTurning(group, T, world) {
  const ang = Math.atan2(T.ex, T.ez);
  const asphalt = world.roadMat.clone();
  asphalt.map = asphalt.map.clone(); asphalt.map.repeat.set(T.W / 3.5, T.L / 3.5); asphalt.map.needsUpdate = true;
  Object.assign(asphalt, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const pad = new THREE.Mesh(new THREE.PlaneGeometry(T.W + 4, T.L + 4).rotateX(-Math.PI / 2), asphalt);
  pad.position.set(T.cx, T.y + 0.02, T.cz); pad.rotation.y = ang; pad.receiveShadow = true;
  const px = 24; // 每公尺像素
  const tex = signTex(T.W * px, T.L * px, (c, W, H) => {
    c.clearRect(0, 0, W, H);
    c.strokeStyle = '#f2c230'; c.lineWidth = 0.3 * px;
    c.strokeRect(0.3 * px, 0.3 * px, W - 0.6 * px, H - 0.6 * px);
    c.save(); c.beginPath(); c.rect(0, 0, W, H); c.clip();
    c.lineWidth = 0.15 * px;
    for (let d = -H; d < W + H; d += 2.2 * px) {
      c.beginPath(); c.moveTo(d, 0); c.lineTo(d + H, H); c.stroke();
      c.beginPath(); c.moveTo(d, H); c.lineTo(d + H, 0); c.stroke();
    }
    c.restore();
  });
  const grid = new THREE.Mesh(new THREE.PlaneGeometry(T.W, T.L).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
  grid.position.set(T.cx, T.y + 0.04, T.cz); grid.rotation.y = ang; grid.receiveShadow = true;
  // 四周擋土牆：迴轉場是山坡上整平的平台，下坡側露出水泥牆面（上坡側埋在地形裡）
  const concrete = new THREE.MeshStandardMaterial({ color: 0xa9a59c, roughness: 0.95 }), none = new THREE.MeshBasicMaterial({ visible: false });
  const wall = new THREE.Mesh(new THREE.BoxGeometry(T.W + 4, 8, T.L + 4), [concrete, concrete, none, none, concrete, concrete]);
  wall.position.set(T.cx, T.y - 4.02, T.cz); wall.rotation.y = ang; wall.receiveShadow = true;
  group.add(pad, grid, wall);
}

// 沒有迴轉場的終點（路口）：路的盡頭鋪一塊柏油，接上 OSM 的岔路
function buildJunction(group, ctx, world) {
  const { r, hw, n } = ctx, R = hw[n - 1] + 3;
  const asphalt = world.roadMat.clone();
  asphalt.map = asphalt.map.clone(); asphalt.map.repeat.set((R * 2) / 3.5, (R * 2) / 3.5); asphalt.map.needsUpdate = true;
  Object.assign(asphalt, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const pad = new THREE.Mesh(new THREE.CircleGeometry(R, 32).rotateX(-Math.PI / 2), asphalt);
  pad.position.set(r.x[n - 1] + r.tx[n - 1] * (R - 1), r.y[n - 1] + 0.01, r.z[n - 1] + r.tz[n - 1] * (R - 1)); // 從路的盡頭往前鋪，不蓋到路面標線
  pad.receiveShadow = true;
  group.add(pad);
}

// 步道入口石碑：花崗岩碑身刻紅字，下有水泥基座，面向迴轉場
function buildTrailStone(group, T, ctx) {
  const ground = ctx.surface ?? ctx.ground, { x, z, name } = T.stone;
  let fx = T.cx - x, fz = T.cz - z;
  const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
  const y = Math.min(...[[0, 0], [1, 0], [-1, 0], [0, 0.4], [0, -0.4]].map(([a, b]) => ground(x + fz * a + fx * b, z - fx * a + fz * b)));
  const granite = signTex(256, 256, (c, w, h) => {
    c.fillStyle = '#8f8b84'; c.fillRect(0, 0, w, h);
    for (let k = 0; k < 2500; k++) { const g = 100 + Math.random() * 90; c.fillStyle = `rgb(${g},${g - 3},${g - 8})`; c.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
  });
  const face = signTex(640, 300, (c, w, h) => {
    c.drawImage(granite.image, 0, 0, w, h);
    c.fillStyle = '#c8261c'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = 'bold 136px serif'; c.fillText(name, w / 2, h * 0.5);
  });
  const rock = new THREE.MeshStandardMaterial({ map: granite, roughness: 0.75 });
  const W = 2.8, H = 1.3, D = 0.6;
  const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), [rock, rock, rock, rock, new THREE.MeshStandardMaterial({ map: face, roughness: 0.6 }), rock]);
  const base = new THREE.Mesh(new THREE.BoxGeometry(W + 0.4, 0.5, D + 0.4), new THREE.MeshStandardMaterial({ color: 0x9d9a93, roughness: 0.9 }));
  base.position.y = y + 0.05; // 埋入地面一半，斜坡上也不會懸空
  body.position.y = y + 0.3 + H / 2;
  for (const m of [body, base]) {
    m.position.x = x; m.position.z = z; m.rotation.y = Math.atan2(fx, fz);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }
}

// 流動廁所：藍色塑膠外殼、白色屋頂與通風管，正面是門（WC 標示、門把、使用中指示）
function buildToilets(group, T, ctx) {
  const fx = -T.ez, fz = T.ex; // 門朝迴轉場；放在迴轉場柏油上
  const door = signTex(256, 512, (c, w, h) => {
    c.fillStyle = '#1d5fc4'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#174c9e'; c.lineWidth = 10; c.strokeRect(28, 30, w - 56, h - 40);
    for (let y = 60; y < 110; y += 12) { c.fillStyle = '#123f86'; c.fillRect(70, y, w - 140, 6); } // 通風百葉
    c.fillStyle = '#fff'; c.fillRect(78, 150, w - 156, 92);
    c.fillStyle = '#1d5fc4'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = 'bold 56px sans-serif'; c.fillText('WC', w / 2, 198);
    c.fillStyle = '#d8d8d8'; c.fillRect(196, 270, 18, 60); // 門把
    c.fillStyle = '#2fa84f'; c.fillRect(186, 236, 38, 20); // 使用中指示（綠：無人）
  });
  const blue = new THREE.MeshStandardMaterial({ color: 0x1d5fc4, roughness: 0.45 });
  const white = new THREE.MeshStandardMaterial({ color: 0xe8ecef, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.9 });
  const doorMat = new THREE.MeshStandardMaterial({ map: door, roughness: 0.45 });
  for (const { x, z } of T.toilets) {
    const y = T.y + 0.02, unit = new THREE.Group();
    const parts = [
      [new THREE.BoxGeometry(1.2, 0.1, 1.25), dark, 0.05], // 底座
      [new THREE.BoxGeometry(1.1, 2.15, 1.15), [blue, blue, blue, blue, doorMat, blue], 1.275],
      [new THREE.BoxGeometry(1.2, 0.12, 1.25), white, 2.41],
      [new THREE.CylinderGeometry(0.06, 0.06, 0.45, 10), white, 2.6, -0.35, -0.38], // 通風管
    ];
    for (const [g, m, py, px = 0, pz = 0] of parts) {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(px, py, pz); mesh.castShadow = mesh.receiveShadow = true;
      unit.add(mesh);
    }
    unit.position.set(x, y, z); unit.rotation.y = Math.atan2(fx, fz);
    group.add(unit);
  }
}

// 公車站牌：路邊立桿，藍底站名
function busStop(group, l, ctx) {
  const { r, ground, nearest, hw } = ctx;
  const [x0, z0] = toXZ(r)(l.p[0]), q = nearest(x0, z0), i = q.i, sd = Math.sign(q.o) || -1;
  const nx = r.tz[i] * sd, nz = -r.tx[i] * sd, off = hw[i] + 0.9, x = r.x[i] + nx * off, z = r.z[i] + nz * off, y = ground(x, z);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.7, 8), new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.4 }));
  pole.position.set(x, y + 1.35, z);
  const tex = signTex(192, 256, (c, W, H) => {
    c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#1f5fae'; c.fillRect(0, 0, W, H * 0.3);
    c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = 'bold 40px sans-serif'; c.fillText('公車', W / 2, H * 0.15);
    c.fillStyle = '#1f2a36';
    const nm = l.name || '';
    c.font = `bold ${nm.length > 5 ? 26 : 34}px sans-serif`;
    c.fillText(nm.slice(0, 7), W / 2, H * 0.5);
    if (nm.length > 7) c.fillText(nm.slice(7, 14), W / 2, H * 0.68);
  });
  group.add(pole, board(tex, 0.45, 0.6, x, y + 2.35, z, -r.tx[i], -r.tz[i]));
}

// 涼亭：石砌平台、木紋柱與坐椅、四面翹角的瓦頂，面向道路那側掛匾額（OSM 只有外框，外觀為一般山區涼亭的樣式）
function buildShelter(group, l, ctx) {
  const { r, nearest } = ctx, ground = ctx.surface ?? ctx.ground, P = ring(l.p, r);
  if (P.length < 3) return;
  // 外框的最小外接矩形（取最長邊的方向）
  let ax = 1, az = 0, best = 0;
  P.forEach((a, i) => { const b = P[(i + 1) % P.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L > best) { best = L; ax = (b[0] - a[0]) / L; az = (b[1] - a[1]) / L; } });
  const bx = -az, bz = ax, us = P.map(([x, z]) => x * ax + z * az), vs = P.map(([x, z]) => x * bx + z * bz);
  const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
  const hu = Math.max(1.8, (u1 - u0) / 2), hv = Math.max(1.8, (v1 - v0) / 2), cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  const cx = cu * ax + cv * bx, cz = cu * az + cv * bz;
  const W = (a, b) => [cx + ax * a + bx * b, cz + az * a + bz * b]; // 區域座標 → 世界
  const gs = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]].map(([a, b]) => ground(...W(a * (hu + 0.6), b * (hv + 0.6))));
  const top = (Math.max(...gs) + Math.min(...gs)) / 2 + 0.35, bottom = Math.min(...gs) - 4; // 斜坡上：上坡側埋進地面、下坡側露出石砌
  const g = new THREE.Group();
  g.position.set(cx, 0, cz); g.rotation.y = Math.atan2(-az, ax); // 區域 x = 長邊 (ax, az)、區域 z = (bx, bz)
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; g.add(m); return m; };

  // 平台：石塊砌面，頂面鋪石板
  const stoneTex = signTex(256, 128, (c, w, h) => {
    c.fillStyle = '#8d877c'; c.fillRect(0, 0, w, h);
    for (let row = 0; row < 4; row++) for (let k = -1; k < 5; k++) {
      const x = k * 64 + (row % 2) * 32, v = 120 + ((row * 7 + k * 13) % 5) * 9;
      c.fillStyle = `rgb(${v},${v - 4},${v - 12})`; c.fillRect(x + 2, row * 32 + 2, 60, 28);
    }
  });
  stoneTex.wrapS = stoneTex.wrapT = THREE.RepeatWrapping; stoneTex.repeat.set(3, (top - bottom) / 1.2);
  const stone = new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 0.95 });
  const slab = new THREE.MeshStandardMaterial({ color: 0xa8a39a, roughness: 0.85 });
  add(new THREE.BoxGeometry(hu * 2 + 1.2, top - bottom, hv * 2 + 1.2), [stone, stone, slab, stone, stone, stone], 0, (top + bottom) / 2, 0);

  // 柱子（長邊超過 5m 時中間再加一根）與柱頂橫樑
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b3f26, roughness: 0.7 });
  const beam = new THREE.MeshStandardMaterial({ color: 0x8c2f22, roughness: 0.6 });
  const H = 2.9, cols = hu * 2 > 5 ? [-1, 0, 1] : [-1, 1];
  for (const a of cols) for (const b of [-1, 1]) add(new THREE.CylinderGeometry(0.13, 0.15, H, 12), wood, a * hu, top + H / 2, b * hv);
  for (const b of [-1, 1]) add(new THREE.BoxGeometry(hu * 2 + 0.3, 0.32, 0.22), beam, 0, top + H - 0.16, b * hv);
  for (const a of [-1, 1]) add(new THREE.BoxGeometry(0.22, 0.32, hv * 2 + 0.3), beam, a * hu, top + H - 0.16, 0);
  // 坐椅：兩長邊與一短邊，靠道路的短邊留空當入口
  const q = nearest(cx, cz), toRoad = Math.sign((r.x[q.i] - cx) * ax + (r.z[q.i] - cz) * az) || 1;
  for (const b of [-1, 1]) add(new THREE.BoxGeometry(hu * 2 - 0.3, 0.08, 0.42), wood, 0, top + 0.45, b * (hv - 0.25));
  add(new THREE.BoxGeometry(0.42, 0.08, hv * 2 - 0.9), wood, -toRoad * (hu - 0.25), top + 0.45, 0);
  for (const a of [-0.6, 0.6]) for (const b of [-1, 1]) add(new THREE.BoxGeometry(0.1, 0.45, 0.36), wood, a * hu, top + 0.22, b * (hv - 0.25));

  // 屋頂：四坡內凹、四角起翹；上面瓦片、底面木色
  const ov = 0.9, A = hu + ov, B = hv + ov, rl = Math.max(0.3, hu - hv * 0.8), eave = top + H + 0.05, ridge = eave + Math.min(2.2, hv * 0.9);
  const faces = [ // [屋簷起點, 屋簷終點, 屋脊起點, 屋脊終點]
    [[-A, -B], [A, -B], [-rl, 0], [rl, 0]], [[A, B], [-A, B], [rl, 0], [-rl, 0]],
    [[-A, B], [-A, -B], [-rl, 0], [-rl, 0]], [[A, -B], [A, B], [rl, 0], [rl, 0]],
  ];
  const tilePos = [], tileUv = [], tileIdx = [], N = 10;
  for (const [e0, e1, r0, r1] of faces) {
    const base = tilePos.length / 3, eLen = Math.hypot(e1[0] - e0[0], e1[1] - e0[1]);
    for (let j = 0; j <= N; j++) for (let k = 0; k <= N; k++) {
      const u = k / N, v = j / N, ex = e0[0] + (e1[0] - e0[0]) * u, ez = e0[1] + (e1[1] - e0[1]) * u;
      const rx = r0[0] + (r1[0] - r0[0]) * u, rz = r0[1] + (r1[1] - r0[1]) * u;
      const lift = 0.45 * Math.abs(2 * u - 1) ** 4 * (1 - v) ** 2; // 四角起翹
      tilePos.push(ex + (rx - ex) * v, eave + (ridge - eave) * v ** 1.7 + lift, ez + (rz - ez) * v);
      tileUv.push(u * eLen / 0.3, v * 6);
    }
    for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) {
      const a = base + j * (N + 1) + k, b = a + 1, c = a + N + 1, d = c + 1;
      tileIdx.push(a, b, c, b, d, c);
    }
  }
  const roofGeo = new THREE.BufferGeometry();
  roofGeo.setAttribute('position', new THREE.Float32BufferAttribute(tilePos, 3));
  roofGeo.setAttribute('uv', new THREE.Float32BufferAttribute(tileUv, 2));
  roofGeo.setIndex(tileIdx);
  roofGeo.computeVertexNormals();
  if (roofGeo.attributes.normal.getY(N + 2) < 0) { roofGeo.setIndex(tileIdx.map((_, i) => tileIdx[i - (i % 3) + [0, 2, 1][i % 3]])); roofGeo.computeVertexNormals(); }
  const tileTex = signTex(64, 64, (c, w, h) => {
    c.fillStyle = '#2f4a3a'; c.fillRect(0, 0, w, h);
    const grd = c.createLinearGradient(0, 0, w, 0);
    grd.addColorStop(0, '#22382b'); grd.addColorStop(0.5, '#4b6b55'); grd.addColorStop(1, '#22382b');
    c.fillStyle = grd; c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(0,0,0,.25)'; c.fillRect(0, h - 6, w, 6);
  });
  tileTex.wrapS = tileTex.wrapT = THREE.RepeatWrapping;
  add(roofGeo, new THREE.MeshStandardMaterial({ map: tileTex, roughness: 0.55, metalness: 0.05 }), 0, 0, 0);
  const under = add(roofGeo, new THREE.MeshStandardMaterial({ color: 0x5a3b28, roughness: 0.9, side: THREE.BackSide }), 0, -0.08, 0);
  under.castShadow = false;
  add(new THREE.BoxGeometry(rl * 2 + 0.4, 0.22, 0.26), new THREE.MeshStandardMaterial({ color: 0x24362b, roughness: 0.6 }), 0, ridge + 0.08, 0); // 屋脊

  // 匾額：掛在面向道路的長邊橫樑下
  const sd = Math.sign((r.x[q.i] - cx) * bx + (r.z[q.i] - cz) * bz) || 1, text = l.name.replace(/涼亭$/, '') || l.name;
  const plaque = signTex(384, 128, (c, w, h) => {
    c.fillStyle = '#5a2418'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#d4a548'; c.lineWidth = 8; c.strokeRect(6, 6, w - 12, h - 12);
    c.fillStyle = '#e8c15a'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = 'bold 76px serif'; c.fillText(text, w / 2, h * 0.54);
  });
  const pm = add(new THREE.PlaneGeometry(1.5, 0.5), new THREE.MeshStandardMaterial({ map: plaque, roughness: 0.6 }), 0, top + H - 0.6, sd * (hv + 0.13));
  pm.rotation.y = sd > 0 ? 0 : Math.PI;
  group.add(g);
}

// 題字岩壁：OSM 岩壁外框處立一面粗糙的岩塊，面向最近的路段，正面刻大紅字（例如風櫃嘴前的「佛」）
function buildInscription(group, l, ctx) {
  const { r, nearest } = ctx, ground = ctx.surface ?? ctx.ground, P = ring(l.p, r);
  const cx = P.reduce((a, p) => a + p[0], 0) / P.length, cz = P.reduce((a, p) => a + p[1], 0) / P.length, q = nearest(cx, cz);
  let fx = r.x[q.i] - cx, fz = r.z[q.i] - cz;
  const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
  const span = P.length > 2 ? Math.max(...P.map(([x, z]) => Math.abs((x - cx) * fz - (z - cz) * fx))) * 2 : 0;
  const W = Math.min(16, Math.max(9, span * 1.2)), H = W * 0.55, D = 5;
  const gs = [-1, 0, 1].map((t) => ground(cx + fz * t * W / 2, cz - fx * t * W / 2));
  const base = Math.min(...gs) - 2.5, top = Math.max(...gs) + H, Ht = top - base;
  // 岩塊：細分的方塊依位置雜訊推擠（同一位置推擠量相同，面與面的接縫不會裂開），正面推得少、保持平整好刻字；
  // 上窄下寬、頂部參差、整面往後傾，看起來像山坡露出的岩壁而不是方塊
  const geo = new THREE.BoxGeometry(W, Ht, D, 16, 12, 5), pos = geo.attributes.position;
  const nz = (x, y, z) => Math.sin(x * 1.7 + y * 0.9) * Math.cos(z * 1.3 - y * 1.1) + Math.sin(x * 0.6 - z * 2.1 + y * 0.4) * 0.6;
  const ridge = (x) => Math.sin(x * 0.9) * 0.6 + Math.sin(x * 2.3 + 1) * 0.35 - Math.abs(x / (W / 2)) ** 2 * 1.8;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), t = y / Ht + 0.5, front = z > D / 2 - 0.01 ? 0.25 : 1;
    const k = nz(x, y, z) * 0.6 * front;
    pos.setXYZ(i, x * (1 - 0.3 * t) + k * 0.3, y + t * t * ridge(x) + k * 0.4 * t, z + k - t * 1.6);
  }
  geo.computeVertexNormals();
  const rockTex = signTex(256, 256, (c, w, h) => {
    c.fillStyle = '#7d786e'; c.fillRect(0, 0, w, h);
    for (let k = 0; k < 3000; k++) { const g = 90 + Math.random() * 70; c.fillStyle = `rgba(${g},${g - 2},${g - 10},.8)`; c.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 3, 2); }
    c.strokeStyle = 'rgba(40,38,34,.35)'; c.lineWidth = 2;
    for (let k = 0; k < 14; k++) { c.beginPath(); c.moveTo(Math.random() * w, 0); c.lineTo(Math.random() * w, h); c.stroke(); } // 岩縫
  });
  rockTex.wrapS = rockTex.wrapT = THREE.RepeatWrapping;
  const rock = new THREE.MeshStandardMaterial({ map: rockTex, roughness: 0.95 });
  const face = signTex(512, 512, (c, w, h) => {
    c.drawImage(rockTex.image, 0, 0, w, h);
    c.fillStyle = '#b3261e'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `bold ${l.name.length > 1 ? Math.floor(380 / l.name.length) : 380}px serif`;
    c.fillText(l.name, w / 2, h * 0.47);
    c.fillStyle = 'rgba(120,115,105,.35)'; // 風化：字面上零星褪色
    for (let k = 0; k < 400; k++) c.fillRect(Math.random() * w, Math.random() * h, 3, 3);
  });
  const faceMat = new THREE.MeshStandardMaterial({ map: face, roughness: 0.85 });
  const m = new THREE.Mesh(geo, [rock, rock, rock, rock, faceMat, rock]);
  // 字只佔正面上半部：正面 UV 的 v 從底到頂，把字壓在地面以上
  const uv = geo.attributes.uv, frontStart = geo.groups[4].start, frontCount = geo.groups[4].count, idx = geo.index;
  const lo = (Math.max(...gs) - base) / (top - base);
  for (let i = frontStart; i < frontStart + frontCount; i++) { const v = idx.getX(i); uv.setY(v, Math.max(0, (pos.getY(v) / (top - base) + 0.5 - lo) / (1 - lo))); }
  m.position.set(cx, (top + base) / 2, cz);
  m.rotation.y = Math.atan2(fx, fz);
  m.castShadow = m.receiveShadow = true;
  group.add(m);
}
