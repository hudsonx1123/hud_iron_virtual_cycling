import * as THREE from 'three';
import { V, fbm, noise2, rng } from './geom.js';
import { buildRealObjects, aerialMaterial, buildingBlocker, keepClear, landmarkMarks, turningArea } from './realScene.js';

// GPX 路線場景：沿路線鋪路面，路旁地形以「路面高度 + 山坡」生成（一側上坡、一側下坡，隨路段變化），
// 再沿路分段種樹、草叢與護欄。座標同 route.js：x 向東、z 向南、y 為相對起點高度。
// 實景模式（real）：地形改用內政部 DTM、遠景貼正射航照、依航照決定哪裡種樹，並加入 OSM 房屋、側路與溪流。
// CORR：路廊（沿路的帶狀地形）半寬；BLEND：路肩接到真實地形的距離
const HALF = 3, CORR = 28, BLEND = 12, BLOCK = 250;

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export function buildRouteScene(world, r, real = null) {
  const group = new THREE.Group();
  world.scene.add(group);
  const n = r.s.length;

  // 平滑後的切線方向（水平），供路面、側向偏移與騎士朝向使用
  const tx = new Float32Array(n), tz = new Float32Array(n);
  const k = Math.max(2, Math.round(15 / r.step));
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - k), b = Math.min(n - 1, i + k);
    const dx = r.x[b] - r.x[a], dz = r.z[b] - r.z[a], l = Math.hypot(dx, dz) || 1;
    tx[i] = dx / l; tz[i] = dz / l;
  }
  r.tx = tx; r.tz = tz;
  // 側向（騎士左方 = 正）：(tz, -tx)
  const side = (i) => Math.max(-1, Math.min(1, (noise2(r.s[i] * 0.004, 0.5, 31) * 2 - 1) * 1.8));
  const sideArr = Float32Array.from({ length: n }, (_, i) => side(i));

  // 路面半寬：實景依 OSM 各路段的寬度，彎道再加寬（髮夾彎較寬），沿路平滑；橋段另外標記
  const hw = new Float32Array(n).fill(HALF), onBridge = new Uint8Array(n);
  const RW = real?.scene.route;
  if (RW) {
    for (let i = 0, j = 0; i < n; i++) {
      while (j < RW.s.length - 1 && RW.s[j + 1] <= r.s[i]) j++;
      hw[i] = RW.w[j] / 2;
      onBridge[i] = RW.bridges.some(([s0, s1]) => r.s[i] >= s0 && r.s[i] <= s1) ? 1 : 0;
    }
  }
  const kt = Math.max(2, Math.round(10 / r.step));
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - kt), b = Math.min(n - 1, i + kt);
    const ang = Math.acos(Math.min(1, tx[a] * tx[b] + tz[a] * tz[b])), curv = ang / Math.max(1, r.s[b] - r.s[a]);
    hw[i] += Math.min(1.2, curv * 25);
  }
  const hs = Float32Array.from(hw), ks = Math.max(1, Math.round(10 / r.step));
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - ks); j <= Math.min(n - 1, i + ks); j++) { sum += hs[j]; cnt++; }
    hw[i] = sum / cnt;
  }
  r.hw = hw;
  const he = (s) => hw[Math.min(n - 1, Math.max(0, Math.round(s / r.step)))];

  // 終點公車迴轉場：地形整平
  const turning = real && turningArea(r, real.scene, hw);
  const clear = real && keepClear(r, real.scene, turning); // 迴轉場、涼亭周圍不種樹
  if (turning) {
    const dem0 = real.demY;
    real = { ...real, demY: (x, z) => { const d = turning.dist(x, z), k = smooth(1 - d / 10); return k > 0 ? dem0(x, z) + (turning.y - 0.15 - dem0(x, z)) * k : dem0(x, z); } };
  } else if (real) {
    // 沒有迴轉場的終點（路口、埡口）：周圍地形順到路面高度，路的盡頭不會被 DTM 蓋住或破洞
    const dem0 = real.demY, ex = r.x[n - 1], ez = r.z[n - 1];
    real = { ...real, demY: (x, z) => {
      const k = smooth(1 - (Math.hypot(x - ex, z - ez) - 15) / 25), h = dem0(x, z);
      return k > 0 ? h + (r.y[nearest(x, z).i] - 0.15 - h) * k : h;
    } };
  }

  // 地形高度 = 路面高度 + 山坡（o 為帶號側向距離，i 為路段樣本）+ 起伏
  const slopeLift = (o, i) => {
    const a = Math.max(0, Math.abs(o) - 4);
    const shoulder = a < 2 ? (a * a) / 4 : a - 1;
    return Math.min(shoulder, 700) * (0.07 + 0.25 * Math.abs(sideArr[i])) * sideArr[i] * Math.sign(o);
  };
  const rough = (x, z, a) => (fbm(x * 0.005, z * 0.005, 4, 5) - 0.45) * Math.min(a, 400) * 0.35 * smooth(a / 30);
  const lift = (o, i, x, z) => slopeLift(o, i) + rough(x, z, Math.max(0, Math.abs(o) - 4));
  let offsArr = null; // 各樣本的截面（下方計算）；路廊被別段路截短時，地形要在較短的距離內接到真實地形
  const corridorH = (o, i, x, z) => {
    const a = Math.abs(o), e = hw[i] + 0.4;
    if (real && onBridge[i] && a < e + 6) return Math.min(real.demY(x, z), r.y[i] - 1.3); // 橋下露出溪谷
    if (a <= e) return r.y[i] - 0.12;
    const far = real ? real.demY(x, z) : terrainH(x, z, { d: a, i, o });
    const lim = offsArr ? Math.max(e + 1, Math.min(BLEND, o >= 0 ? offsArr[i].at(-1) : -offsArr[i][0])) : BLEND;
    return r.y[i] + (far - r.y[i]) * smooth((a - e) / (lim - e)); // 路肩往外接到地形（髮夾彎兩條腿在交界處都等於真實地形，不會一高一低懸空）
  };

  // ---------- 最近路段查詢（空間雜湊） ----------
  const segStep = Math.max(1, Math.round(10 / r.step)), segs = [];
  for (let i = 0; i < n - 1; i += segStep) segs.push([i, Math.min(n - 1, i + segStep)]);
  const CELL = 40, hash = new Map(), key = (cx, cz) => cx * 73856093 ^ cz * 19349663;
  segs.forEach(([a, b], si) => {
    const x0 = Math.floor(Math.min(r.x[a], r.x[b]) / CELL), x1 = Math.floor(Math.max(r.x[a], r.x[b]) / CELL);
    const z0 = Math.floor(Math.min(r.z[a], r.z[b]) / CELL), z1 = Math.floor(Math.max(r.z[a], r.z[b]) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const kk = key(cx, cz);
      if (!hash.has(kk)) hash.set(kk, []);
      hash.get(kk).push(si);
    }
  });
  const coarse = segs.filter((_, si) => si % 5 === 0);
  const segDist = ([a, b], x, z, out) => {
    const ax = r.x[a], az = r.z[a], dx = r.x[b] - ax, dz = r.z[b] - az, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(x - px, z - pz);
    if (d < out.d) {
      const i = Math.round(a + (b - a) * t);
      out.d = d; out.i = i;
      out.o = (x - px) * tz[i] - (z - pz) * tx[i]; // 帶號側向距離（左正）
    }
  };
  const nearest = (x, z) => {
    const out = { d: Infinity, i: 0, o: 0 };
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let ring = 0; ring <= 6; ring++) {
      for (let ix = -ring; ix <= ring; ix++) for (let iz = -ring; iz <= ring; iz++) {
        if (Math.max(Math.abs(ix), Math.abs(iz)) !== ring) continue;
        const list = hash.get(key(cx + ix, cz + iz));
        if (list) for (const si of list) segDist(segs[si], x, z, out);
      }
      if (out.d < ring * CELL) break; // 已找到，且更外圈不可能更近
    }
    if (out.d === Infinity) for (const sg of coarse) segDist(sg, x, z, out);
    return out;
  };
  // 離路較遠時改用附近各路段高度的加權平均，避免低處與高處路段的交界出現斷崖
  const idwStep = Math.max(1, Math.round(Math.max(40, r.total / 400) / r.step)), idwPts = [];
  for (let i = 0; i < n; i += idwStep) idwPts.push(i);
  const idwBase = (x, z) => {
    let sw = 0, sh = 0;
    for (const i of idwPts) {
      const dx = x - r.x[i], dz = z - r.z[i], w = 1 / (Math.hypot(dx, dz) + 15) ** 3;
      sw += w; sh += w * (r.y[i] + slopeLift(dx * tz[i] - dz * tx[i], i));
    }
    return sh / sw;
  };
  const terrainH = (x, z, q) => {
    if (real) return real.demY(x, z);
    const near = r.y[q.i] + slopeLift(q.o, q.i), k = smooth((q.d - BLEND) / 60);
    return (k > 0 ? near + (idwBase(x, z) - near) * k : near) + rough(x, z, Math.max(0, q.d - 4));
  };
  const groundAt = (x, z) => {
    const q = nearest(x, z);
    return q.d < CORR ? corridorH(q.o, q.i, x, z) : terrainH(x, z, q);
  };

  const tmp = new THREE.Color(), rock = new THREE.Color('#a49c8c');
  const shade = (geo, dirtNear) => {
    geo.computeVertexNormals();
    const p = geo.attributes.position, nr = geo.attributes.normal, cnt = p.count;
    const col = new Float32Array(cnt * 3), dirt = new Float32Array(cnt);
    for (let v = 0; v < cnt; v++) {
      const x = p.getX(v), z = p.getZ(v);
      const macro = fbm(x * 0.02, z * 0.02, 3, 5), micro = noise2(x * 0.25, z * 0.25, 9);
      const b = 0.72 + macro * 0.5 + (micro - 0.5) * 0.12;
      tmp.setRGB(b * 0.56, b * 0.92, b * 0.42);
      const steep = smooth((0.8 - nr.getY(v)) * 3);
      if (steep > 0) tmp.lerp(rock, steep * 0.6);
      col.set([tmp.r, tmp.g, tmp.b], v * 3);
      dirt[v] = Math.min(1, Math.max(dirtNear(v), smooth((macro - 0.55) * 5) * 0.7, steep * 0.8) * (0.75 + micro * 0.25));
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aDirt', new THREE.BufferAttribute(dirt, 1));
  };

  // 每側的截面位置；彎道內側限制在曲率半徑內，避免網格折疊交錯
  const sideOffs = (e, M) => {
    const out = [];
    for (const v of [e + 0.4, e + 1, Math.max(6, e + 2), Math.max(8.5, e + 4), 12, 16, 20, 24, CORR])
      out.push(Math.max(Math.min(v, M), (out.at(-1) ?? 0) + 0.02)); // 截短時全部擠在 M 以內（間距很小也沒關係），不越過別段路的中線
    return out;
  };
  const kc = Math.max(2, Math.round(10 / r.step));
  const offsAt = (i) => {
    const e = hw[i], a = Math.max(0, i - kc), b = Math.min(n - 1, i + kc);
    const dtx = tx[b] - tx[a], dtz = tz[b] - tz[a], ds = Math.max(1, r.s[b] - r.s[a]);
    const curv = Math.hypot(dtx, dtz) / ds, inner = Math.sign(dtx * tz[i] - dtz * tx[i]); // 切線變化指向彎道中心：+1 左側、-1 右側
    const M = curv > 1e-4 ? Math.max(e + 3, Math.min(CORR, 0.85 / curv)) : CORR;
    // 往外探測：附近有路線的其他路段（上下平行的山路）時，兩段路的地形帶在中間分界，不互相覆蓋
    const reach = (sd) => {
      // 探測點離別段路比離自己的路中心還近，就是越過了兩段路的中線（上下平行的山路、髮夾彎的兩條腿）；
      // 用二分法求出中線位置，兩段路的地形帶在同一條線上交會，高度一致
      const other = (o) => { const q = nearest(r.x[i] + tz[i] * o * sd, r.z[i] - tx[i] * o * sd); return Math.abs(r.s[q.i] - r.s[i]) > 12 && q.d < o; };
      let lo = 0;
      for (const o of [4, 6, 8, 10, 12, 16, 20, 24, CORR]) {
        if (!other(o)) { lo = o; continue; }
        let hi = o;
        for (let k = 0; k < 6; k++) { const m = (lo + hi) / 2; if (other(m)) hi = m; else lo = m; }
        return Math.max(e + 1, lo);
      }
      return CORR;
    };
    const L = sideOffs(e, Math.min(inner > 0 ? M : CORR, reach(1))), Rt = sideOffs(e, Math.min(inner < 0 ? M : CORR, reach(-1)));
    return [...Rt.reverse().map((v) => -v), 0, ...L];
  };
  const no = 19 + 2; // 兩側外緣各加一圈往下的裙邊，蓋住與遠景地形的接縫
  offsArr = Array.from({ length: n }, (_, i) => offsAt(i)); // 各樣本的截面（兩端即路廊實際範圍）

  // ---------- 遠景地形（規則網格；靠近道路的三角形挖掉，由路廊網格覆蓋） ----------
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, r.x[i]); maxX = Math.max(maxX, r.x[i]);
    minZ = Math.min(minZ, r.z[i]); maxZ = Math.max(maxZ, r.z[i]);
  }
  const M = 800;
  const X0 = real ? real.bounds.x0 : minX - M, X1 = real ? real.bounds.x1 : maxX + M;
  const Z0 = real ? real.bounds.z0 : minZ - M, Z1 = real ? real.bounds.z1 : maxZ + M;
  const G = Math.max(10, Math.max(X1 - X0, Z1 - Z0) / 320);
  const gx = Math.ceil((X1 - X0) / G) + 1, gz = Math.ceil((Z1 - Z0) / G) + 1;
  const gpos = new Float32Array(gx * gz * 3), guv = new Float32Array(gx * gz * 2), gnear = new Float32Array(gx * gz), gclear = new Float32Array(gx * gz);
  const aerial = real?.aerial, blocked = real && buildingBlocker(r, real.scene);
  for (let j = 0; j < gz; j++) for (let i = 0; i < gx; i++) {
    const v = j * gx + i, x = Math.min(X1, X0 + i * G), z = Math.min(Z1, Z0 + j * G);
    const q = nearest(x, z);
    // 頂點維持真實地形高度（路廊範圍內稍微下沉，避免與路廊重疊閃爍）
    const ext = q.o >= 0 ? offsArr[q.i].at(-1) : -offsArr[q.i][0];
    const y = terrainH(x, z, q) - (q.d < Math.min(CORR, ext) ? 0.25 : 0);
    gpos.set([x, y, z], v * 3); gclear[v] = q.d - hw[q.i]; guv.set(aerial ? aerial.uv(x, z) : [x / 5, z / 5], v * 2);
    gnear[v] = 1 - smooth((q.d - 10) / 25);
  }
  // 網格約 11m 一格、比路寬粗：靠近道路的三角形整個挖掉（由路廊網格補上），橫跨道路的斜面就不會戳出路面
  const gidx = [], P3 = (v) => [gpos[v * 3], gpos[v * 3 + 2]];
  const nearRoadTri = (A, B, C) => {
    if (Math.min(gclear[A], gclear[B], gclear[C]) > 3 + G * 1.2) return false; // 離路很遠，免檢查
    const [a, b, c] = [P3(A), P3(B), P3(C)];
    for (const [x, z] of [a, b, c, [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3],
      [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2], [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2]]) {
      const q = nearest(x, z), along = (x - r.x[q.i]) * tx[q.i] + (z - r.z[q.i]) * tz[q.i];
      if ((q.i === 0 && along < -0.5) || (q.i === n - 1 && along > 0.5)) return false; // 跨到起點之前、終點之後（沒有路廊）的三角形保留，免得路的盡頭破洞
      if (q.d < hw[q.i] + 3) return true;
    }
    return false;
  };
  const kept = new Uint8Array((gx - 1) * (gz - 1)); // 每格兩個三角形是否保留（bit 0：左上、bit 1：右下）
  for (let j = 0; j < gz - 1; j++) for (let i = 0; i < gx - 1; i++) {
    const a = j * gx + i, b = a + 1, c = a + gx, d = c + 1;
    if (!nearRoadTri(a, c, b)) { gidx.push(a, c, b); kept[j * (gx - 1) + i] |= 1; }
    if (!nearRoadTri(b, c, d)) { gidx.push(b, c, d); kept[j * (gx - 1) + i] |= 2; }
  }
  // 實際畫出來的地表高度（遠景網格三角形內插，或路廊）：讓步道等貼地物件跟著看得到的地面，而不是 DEM
  const surfaceY = (x, z) => {
    const fi = (x - X0) / G, fj = (z - Z0) / G, i = Math.floor(fi), j = Math.floor(fj);
    let y = -Infinity;
    if (i >= 0 && j >= 0 && i < gx - 1 && j < gz - 1) {
      const u = fi - i, v = fj - j, a = j * gx + i, Y = (k) => gpos[k * 3 + 1], t = kept[j * (gx - 1) + i];
      if (u + v <= 1) { if (t & 1) y = Y(a) + (Y(a + 1) - Y(a)) * u + (Y(a + gx) - Y(a)) * v; }
      else if (t & 2) y = Y(a + gx + 1) + (Y(a + gx) - Y(a + gx + 1)) * (1 - u) + (Y(a + 1) - Y(a + gx + 1)) * (1 - v);
    }
    const q = nearest(x, z), along = (x - r.x[q.i]) * tx[q.i] + (z - r.z[q.i]) * tz[q.i];
    const ext = q.o >= 0 ? offsArr[q.i].at(-1) : -offsArr[q.i][0];
    if (q.d < Math.min(CORR, ext) && !(q.i === n - 1 && along > 0.5) && !(q.i === 0 && along < -0.5)) y = Math.max(y, corridorH(q.o, q.i, x, z));
    return y > -Infinity ? y : groundAt(x, z);
  };
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.BufferAttribute(gpos, 3));
  gg.setAttribute('uv', new THREE.BufferAttribute(guv, 2));
  gg.setAttribute('aNear', new THREE.BufferAttribute(gnear, 1));
  gg.setIndex(gidx);
  shade(gg, () => 0);
  const farMat = aerial ? aerialMaterial(aerial, world.groundMat.map) : world.groundMat;
  const far = new THREE.Mesh(gg, farMat);
  far.receiveShadow = true;
  group.add(far);

  // ---------- 路廊（沿路線的帶狀地形）、路面、標線 ----------
  const cpos = new Float32Array(n * no * 3), cuv = new Float32Array(n * no * 2), cdirt = new Float32Array(n * no);
  const rpos = new Float32Array(n * 2 * 3), ruv = new Float32Array(n * 2 * 2), luv = new Float32Array(n * 2 * 2);
  for (let i = 0; i < n; i++) {
    const nx = tz[i], nz = -tx[i], offs = offsArr[i];
    for (let j = 0; j < no; j++) {
      // 外緣裙邊往外稍微下斜，藏在遠景地形之下、蓋住接縫
      // 被別段路或彎道截短的一側（髮夾彎內側）：裙邊直接垂直往下，不伸進另一段路的範圍、露出懸空的凸緣
      const skirt = j === 0 || j === no - 1, edge = j === 0 ? offs[0] : offs.at(-1), clipped = Math.abs(edge) < CORR - 0.01;
      const out = clipped ? 0 : 2, o = skirt ? edge + Math.sign(edge) * out : offs[j - 1];
      const x = r.x[i] + nx * o, z = r.z[i] + nz * o;
      const y = skirt ? corridorH(edge, i, r.x[i] + nx * edge, r.z[i] + nz * edge) - (clipped ? 3 : 1.2) : corridorH(o, i, x, z), v = i * no + j;
      cpos.set([x, y, z], v * 3); cuv.set(aerial ? aerial.uv(x, z) : [x / 5, z / 5], v * 2);
      cdirt[v] = smooth((hw[i] + 2.6 - Math.abs(o)) / 1.6);
    }
    for (const [j, o] of [[0, hw[i]], [1, -hw[i]]]) {
      const v = i * 2 + j;
      rpos.set([r.x[i] + nx * o, r.y[i] + 0.03, r.z[i] + nz * o], v * 3);
      ruv.set([(hw[i] - o) / 3.5, r.s[i] / 3.5], v * 2);
      luv.set([o > 0 ? 0 : 1, r.s[i] / 14], v * 2);
    }
  }
  // flip：截面由右到左排列時（路廊）要反轉繞向，三角形才會朝上
  const strip = (cols, flip = false) => {
    const idx = [];
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      if (flip) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
    }
    return idx;
  };
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.BufferAttribute(cpos, 3));
  cg.setAttribute('uv', new THREE.BufferAttribute(cuv, 2));
  cg.setAttribute('aNear', new THREE.BufferAttribute(new Float32Array(n * no).fill(1), 1));
  cg.setIndex(strip(no, true));
  shade(cg, (v) => cdirt[v]);
  const corridor = new THREE.Mesh(cg, farMat);
  corridor.receiveShadow = true;
  group.add(corridor);

  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.BufferAttribute(rpos, 3));
  rg.setAttribute('uv', new THREE.BufferAttribute(ruv, 2));
  rg.setIndex(strip(2));
  rg.computeVertexNormals();
  const road = new THREE.Mesh(rg, world.roadMat);
  road.receiveShadow = true;
  const lg = rg.clone();
  lg.setAttribute('uv', new THREE.BufferAttribute(luv, 2));
  const lines = new THREE.Mesh(lg, world.lineMat);
  lines.receiveShadow = true;
  group.add(road, lines);

  // ---------- 沿路分段：樹、草叢、蕨類、岩石、護欄 ----------
  const m4 = new THREE.Matrix4(), qt = new THREE.Quaternion(), qy = new THREE.Quaternion(), qx = new THREE.Quaternion();
  const sc = V(), p = V(), up = V(0, 1, 0), xAx = V(1, 0, 0);
  const blocks = [];
  const nb = Math.ceil(r.total / BLOCK);
  // 實景：路旁視野開闊、不種樹的路段（scene.route.open = [[s0, s1, 'L' | 'R']]，o > 0 為騎士左側）
  const openSide = (s, o) => !!RW?.open?.some(([s0, s1, sd]) => s >= s0 && s <= s1 && (sd === 'L' ? o > 0 : o < 0));
  for (let b = 0; b < nb; b++) {
    const rand = rng(b * 7919 + 101), blk = { s0: b * BLOCK, s1: (b + 1) * BLOCK, near: [], all: [] };
    const len = Math.min(BLOCK, r.total - b * BLOCK);
    const at = (s, o) => {
      const i = Math.min(n - 1, Math.round(s / r.step));
      return { x: r.x[i] + tz[i] * o, z: r.z[i] - tx[i] * o, i };
    };
    const make = (geo, mat, list, cast = true) => {
      if (!list.length) return null;
      const m = new THREE.InstancedMesh(geo, mat, list.length);
      m.castShadow = cast; m.receiveShadow = true;
      list.forEach(([x, y, z, ry, s, pitch = 0], i) => {
        qy.setFromAxisAngle(up, ry);
        if (pitch) qy.multiply(qx.setFromAxisAngle(xAx, pitch));
        m.setMatrixAt(i, m4.compose(p.set(x, y, z), qy, sc.set(s, s, s)));
      });
      m.computeBoundingSphere();
      group.add(m);
      blk.all.push(m);
      return m;
    };
    // 樹
    const trees = world.treeKinds.map(() => []);
    const plant = (kind, s, o, scl, extra) => {
      if (kind < 4 && openSide(s, o)) return; // 視野開闊的路段：只留矮灌木
      const { x, z } = at(s, o), q = nearest(x, z);
      if (q.d < hw[q.i] + extra || onBridge[q.i] && q.d < hw[q.i] + 8) return; // 彎道內側可能落到另一段路上；橋旁不種
      if (clear?.(x, z, 3)) return;
      if (kind < 4 && openSide(r.s[q.i], q.o)) return; // 依實際位置再判斷一次：髮夾彎時別段路的樹可能落到開闊的這一側
      if (blocked?.(x, z, Math.abs(o) < 12 ? 12 : 2)) return; // 實景：避開房屋；路旁有房子的地方不種行道樹
      if (aerial && Math.abs(o) > 12 && !aerial.veg(x, z)) return; // 實景：路旁以外，航照上不是植被就不種
      trees[kind].push([x, groundAt(x, z) - 0.2, z, rand() * Math.PI * 2, scl]);
    };
    const dens = real ? 2.2 : 1; // 實景：遠處的樹有一半會被航照過濾掉，先多撒一些
    for (let t = 0; t < (len / 4) * dens; t++) {
      const sd = rand() < 0.5 ? -1 : 1;
      const s = b * BLOCK + rand() * len;
      plant(rand() < 0.5 ? 1 : 0, s, sd * (he(s) + 3 + rand() * 4), 0.85 + rand() * 0.35, 2.5);
    }
    for (let t = 0; t < len * 0.8 * dens; t++) {
      const sd = rand() < 0.5 ? -1 : 1, q = rand();
      plant(q < 0.35 ? 0 : q < 0.5 ? 1 : q < 0.75 ? 2 : 3, b * BLOCK + rand() * len, sd * (9 + rand() ** 1.3 * 140), 0.8 + rand() * 0.6, 4);
    }
    for (let t = 0; t < len * 0.4 * dens; t++) {
      const sd = rand() < 0.5 ? -1 : 1;
      const s = b * BLOCK + rand() * len;
      plant(4, s, sd * (he(s) + 1.8 + rand() ** 1.5 * 30), 0.6 + rand() * 0.9, 1.4);
    }
    world.treeKinds.forEach((kd, j) => {
      make(kd.leaves, kd.leafMat, trees[j]);
      if (kd.wood) make(kd.wood, kd.bark, trees[j]);
    });
    // 草叢、蕨類、岩石（只在近處顯示）
    const scatter = (vars, count, oMin, spread, pw, sMin, sMax, cast) => vars.forEach((vr) => {
      const list = [];
      for (let t = 0; t < count; t++) {
        const s = b * BLOCK + rand() * len, sd = rand() < 0.5 ? -1 : 1, { x, z } = at(s, sd * (he(s) + oMin + rand() ** pw * spread));
        const q = nearest(x, z);
        if (q.d < hw[q.i] + 0.5 || onBridge[q.i] || clear?.(x, z, 1) || blocked?.(x, z, 0.5)) continue;
        list.push([x, groundAt(x, z) - 0.03, z, rand() * Math.PI * 2, sMin + rand() * (sMax - sMin)]);
      }
      const m = make(vr.geo, vr.mat, list, cast);
      if (m) blk.near.push(m);
    });
    scatter(world.grassVars, len * 1.1, 0.7, 14, 1.8, 1.1, 2.2, false);
    scatter(world.fernVars, len * 0.2, 1.4, 10, 1.5, 0.8, 1.5, false);
    scatter(world.rockVars, len * 0.012, 5, 25, 1, 0.8, 2.6, true);
    // 護欄：山坡往下的那一側
    const rails = [];
    for (let s = b * BLOCK + 1.2; s < b * BLOCK + len; s += 2.45) {
      const i = Math.min(n - 1, Math.round(s / r.step));
      if (onBridge[i] || clear?.(r.x[i], r.z[i], 2)) continue; // 橋上有護牆
      for (const sd of [-1, 1]) {
        if (real) {
          const { x, z } = at(s, sd * 9);
          if (real.demY(x, z) > r.y[i] - 2.5) continue; // 實景：路旁明顯下切的一側才有護欄
        } else if (sideArr[i] * sd > -0.35) continue;
        const { x, z } = at(s, sd * (hw[i] + 0.5));
        rails.push([x, r.y[i] - 0.03, z, Math.atan2(tx[i], tz[i]), 1, -Math.atan(r.grade[i] / 100)]);
      }
    }
    make(world.barrierGeo, world.barrierMat, rails);
    blocks.push(blk);
  }

  // 依騎士位置切換顯示：小型植被只在前後一小段，樹等其他物件只畫 420m 內的區塊（遠處已被霧遮住）
  for (const blk of blocks) {
    const box = new THREE.Box3();
    for (const m of blk.all) box.union(new THREE.Box3().setFromCenterAndSize(m.boundingSphere.center, V(1, 1, 1).multiplyScalar(m.boundingSphere.radius * 2)));
    blk.sphere = box.getBoundingSphere(new THREE.Sphere());
  }
  const rp = V();
  const updateNear = (d) => {
    const i = Math.min(n - 1, Math.round(d / r.step));
    rp.set(r.x[i], r.y[i], r.z[i]);
    for (const blk of blocks) {
      const far = blk.sphere.distanceToPoint(rp) > 420;
      for (const m of blk.all) m.visible = !far;
      if (far) continue;
      const vis = blk.s1 > d - 60 && blk.s0 < d + 260;
      for (const m of blk.near) m.visible = vis;
    }
  };
  updateNear(0);
  if (real) {
    group.add(buildRealObjects(world, { r, scene: real.scene, ground: groundAt, surface: surfaceY, nearest, hw, onBridge, turning, tx, tz, n, demY: real.demY }));
    r.marks = landmarkMarks(r, real.scene, nearest);
  }
  return { group, route: { fixed: true, data: r, updateNear } };
}
