// GPX 路線：解析、投影成公尺座標、平滑高度、計算坡度
// route = { name, total(水平公尺), gain, ele0, step, s/x/y/z/ele/grade: Float32Array }，x 向東、z 向南、y 為相對起點高度

export const BUILTIN_ROUTES = [
  { file: 'assets/routes/zhongshe.gpx', scene: 'assets/routes/zhongshe.scene.json', name: '中社路', nameEn: 'Zhongshe Rd climb' },
  { file: 'assets/routes/fengguizui.gpx', scene: 'assets/routes/fengguizui.scene.json', name: '風櫃嘴', nameEn: 'Fengguizui climb' },
];

export function parseGpx(text, fallbackName = 'GPX') {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('GPX');
  let nodes = [...doc.getElementsByTagName('trkpt')];
  if (nodes.length < 2) nodes = [...doc.getElementsByTagName('rtept')];
  const pts = nodes
    .map((n) => [+n.getAttribute('lat'), +n.getAttribute('lon'), +(n.getElementsByTagName('ele')[0]?.textContent ?? NaN)])
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length < 2) throw new Error('GPX');
  const name = (doc.querySelector('trk > name') || doc.querySelector('metadata > name') || doc.querySelector('rte > name'))?.textContent?.trim();
  return { name: name || fallbackName.replace(/\.[^.]+$/, ''), pts };
}

// 點數太多時抽稀（存進 localStorage 用）
export function compactPts(pts, max = 4000) {
  if (pts.length <= max) return pts;
  const k = pts.length / max;
  return Array.from({ length: max }, (_, i) => pts[Math.min(pts.length - 1, Math.round(i * k))]).concat([pts[pts.length - 1]]);
}

function gauss(v, sigma) {
  if (sigma < 0.5) return Float32Array.from(v);
  const r = Math.ceil(sigma * 3), k = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-0.5 * (i / sigma) ** 2));
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) {
    let s = 0, w = 0;
    for (let j = -r; j <= r; j++) {
      const x = Math.min(v.length - 1, Math.max(0, i + j));
      s += v[x] * k[j + r]; w += k[j + r];
    }
    out[i] = s / w;
  }
  return out;
}

export function buildRoute({ name, nameEn, pts }) {
  const lat0 = pts[0][0], lon0 = pts[0][1];
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), kz = 110574;
  const P = pts.map(([la, lo, e]) => [(lo - lon0) * kx, -(la - lat0) * kz, e]);
  // 缺高度的點用前後內插
  const known = P.map((p, i) => (Number.isFinite(p[2]) ? i : -1)).filter((i) => i >= 0);
  if (!known.length) P.forEach((p) => (p[2] = 0));
  else P.forEach((p, i) => {
    if (Number.isFinite(p[2])) return;
    const b = known.find((k) => k > i), a = [...known].reverse().find((k) => k < i);
    p[2] = a == null ? P[b][2] : b == null ? P[a][2] : P[a][2] + ((P[b][2] - P[a][2]) * (i - a)) / (b - a);
  });
  // 去掉重複點，累計水平距離
  const Q = [P[0]], L = [0];
  for (let i = 1; i < P.length; i++) {
    const d = Math.hypot(P[i][0] - Q[Q.length - 1][0], P[i][1] - Q[Q.length - 1][1]);
    if (d < 0.5) continue;
    Q.push(P[i]); L.push(L[L.length - 1] + d);
  }
  const total = L[L.length - 1];
  if (total < 50) throw new Error('GPX');
  // 等距重新取樣（長路線放寬間距，控制場景大小）
  const step = Math.max(5, total / 6000), n = Math.floor(total / step) + 1;
  const s = new Float32Array(n), x = new Float32Array(n), z = new Float32Array(n), raw = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++) {
    const d = Math.min(total, i * step);
    while (j < L.length - 2 && L[j + 1] < d) j++;
    const t = L[j + 1] > L[j] ? (d - L[j]) / (L[j + 1] - L[j]) : 0;
    s[i] = d;
    x[i] = Q[j][0] + (Q[j + 1][0] - Q[j][0]) * t;
    z[i] = Q[j][1] + (Q[j + 1][1] - Q[j][1]) * t;
    raw[i] = Q[j][2] + (Q[j + 1][2] - Q[j][2]) * t;
  }
  // 平面路徑稍微平滑（地圖折線的尖角、GPS 抖動），高度平滑（GPS / DEM 雜訊約 30m 尺度），坡度取前後 ±20m
  x.set(gauss(x, 8 / step)); z.set(gauss(z, 8 / step));
  const ele = gauss(raw, 30 / step);
  const grade = new Float32Array(n), h = Math.max(1, Math.round(20 / step));
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h), b = Math.min(n - 1, i + h);
    grade[i] = b > a ? ((ele[b] - ele[a]) / (s[b] - s[a])) * 100 : 0;
  }
  const y = ele.map((e) => e - ele[0]);
  const cgain = new Float32Array(n); // 累計爬升
  for (let i = 1; i < n; i++) cgain[i] = cgain[i - 1] + Math.max(0, ele[i] - ele[i - 1]);
  return { name, nameEn, total, gain: cgain[n - 1], ele0: ele[0], step, s, x, y, z, ele, grade, cgain, lat0, lon0, kx, kz };
}

// 某距離處的位置、坡度、高度（線性內插）
export function routeAt(r, d) {
  const f = Math.min(r.s.length - 1.0001, Math.max(0, d / r.step)), i = Math.floor(f), t = f - i;
  const lerp = (a) => a[i] + (a[i + 1] - a[i]) * t;
  return { grade: lerp(r.grade), ele: lerp(r.ele), climbed: lerp(r.cgain) };
}

// 依坡度上色（爬坡：綠→黃→橘→紅；下坡：藍）
export const gradeColor = (g) =>
  g < -2 ? '#3b9cff' : g < 2 ? '#9aa7b3' : g < 5 ? '#3ddc84' : g < 8 ? '#ffd23f' : g < 11 ? '#ff8a1f' : '#ff3b3b';
