import * as THREE from 'three';

export const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// ---------- 截面輪廓（x = 橫向、y = 弦向，+y 為前緣），統一為逆時針 ----------
function ccw(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a < 0 ? pts.reverse() : pts;
}

export const ellipse = (n = 24) =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [Math.cos(a), Math.sin(a)];
  });

// NACA 00xx 翼型，tail < 1 時為截尾（Kamm tail，Specialized 空力管型）
export function airfoil(n = 32, tail = 0.82) {
  const t = (s) => 0.2969 * Math.sqrt(s) - 0.126 * s - 0.3516 * s * s + 0.2843 * s ** 3 - 0.1015 * s ** 4;
  const half = n >> 1, up = [], lo = [];
  for (let i = 0; i <= half; i++) {
    const s = (tail * (1 - Math.cos((Math.PI * i) / half))) / 2;
    const x = t(s) / 0.1003, y = 1 - (2 * s) / tail;
    up.push([x, y]);
    if (i > 0) lo.push([-x, y]);
  }
  return ccw([...up, ...lo.reverse()]);
}

// ---------- 掃掠：沿路徑放置截面 ----------
// size(t) → [橫向寬, 弦長]；opt.lateral 為橫向參考軸；opt.lead 讓翼型前緣朝向該方向
export function sweep(points, profile, size, opt = {}) {
  const lat = opt.lateral || V(1, 0, 0);
  const ts = opt.ts || points.map((_, i) => i / (points.length - 1));
  const n = points.length, m = profile.length;
  const pos = [], uv = [], idx = [];
  const T = V(), B = V(), N = V(), P = V();
  for (let i = 0; i < n; i++) {
    if (i === 0) T.subVectors(points[1], points[0]);
    else if (i === n - 1) T.subVectors(points[n - 1], points[n - 2]);
    else T.subVectors(points[i + 1], points[i - 1]);
    T.normalize();
    B.copy(lat).addScaledVector(T, -lat.dot(T)).normalize();
    N.crossVectors(T, B);
    if (opt.lead && N.dot(opt.lead) < 0) { N.negate(); B.negate(); }
    const [w, h] = size(ts[i]);
    for (let j = 0; j < m; j++) {
      const [px, py] = profile[j];
      P.copy(points[i]).addScaledVector(B, (px * w) / 2).addScaledVector(N, (py * h) / 2);
      pos.push(P.x, P.y, P.z);
      uv.push(j / m, ts[i]);
    }
  }
  for (let i = 0; i < n - 1; i++)
    for (let j = 0; j < m; j++) {
      const a = i * m + j, b = i * m + ((j + 1) % m), c = a + m, d = b + m;
      idx.push(a, b, c, b, d, c);
    }
  if (opt.caps !== false) {
    for (const [ring, flip] of [[0, true], [n - 1, false]]) {
      const c = pos.length / 3;
      const p = points[ring];
      pos.push(p.x, p.y, p.z);
      uv.push(0.5, ts[ring]);
      for (let j = 0; j < m; j++) {
        const a = ring * m + j, b = ring * m + ((j + 1) % m);
        flip ? idx.push(c, b, a) : idx.push(c, a, b);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// 兩端加密的取樣
export const cosSpace = (n) => Array.from({ length: n }, (_, i) => (1 - Math.cos((Math.PI * i) / (n - 1))) / 2);

// 圓頭收尾係數
export const roundEnds = (t, c0 = 0.1, c1 = 0.1) => {
  if (t < c0) return Math.sqrt(1 - ((c0 - t) / c0) ** 2);
  if (t > 1 - c1) return Math.sqrt(Math.max(0, 1 - ((t - 1 + c1) / c1) ** 2));
  return 1;
};

// 關鍵點平滑插值：keys = [[t, v], ...]
export const keyed = (keys) => (t) => {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1], [t1, v1] = keys[i];
      const k = (t - t0) / (t1 - t0), s = k * k * (3 - 2 * k);
      return v0 + (v1 - v0) * s;
    }
  }
  return keys[keys.length - 1][1];
};

// 管路徑（Catmull-Rom）
export const path = (pts, n = 24) => new THREE.CatmullRomCurve3(pts).getPoints(n - 1);

// 沿局部 +Y 長度 L 的肢段，w(t)/h(t) 為直徑
export function limbGeo(L, w, h, n = 26, m = 22) {
  const ts = cosSpace(n);
  return sweep(ts.map((t) => V(0, t * L, 0)), ellipse(m), (t) => [w(t), h(t)], { ts, lateral: V(1, 0, 0) });
}

// 讓局部 +Y 指向 a→b，局部 +Z 盡量朝 ref
const _x = V(), _y = V(), _z = V(), _m = new THREE.Matrix4();
export function orient(obj, a, b, ref) {
  _y.subVectors(b, a).normalize();
  _z.copy(ref).addScaledVector(_y, -ref.dot(_y)).normalize();
  _x.crossVectors(_y, _z);
  _m.makeBasis(_x, _y, _z);
  obj.quaternion.setFromRotationMatrix(_m);
  obj.position.copy(a);
}

// ---------- 貼圖 ----------
export function canvasTex(w, h, draw, { repeat, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.repeat.set(...repeat);
  return t;
}

export function speckle(ctx, w, h, n, size, colors) {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = colors[(Math.random() * colors.length) | 0];
    const s = size * (0.5 + Math.random());
    ctx.fillRect(Math.random() * w, Math.random() * h, s, s);
  }
}

// ---------- 雜訊 ----------
function hash(x, y, s = 0) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
export function noise2(x, y, s = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x, y, oct = 4, s = 0) {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { v += amp * noise2(x * f, y * f, s + i); f *= 2; amp *= 0.5; }
  return v;
}

// 可重現的亂數
export function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
