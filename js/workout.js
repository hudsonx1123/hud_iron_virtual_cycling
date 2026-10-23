// 課表：segs = [{d: 秒, a: 起始 %FTP(0~)，b: 結束 %FTP}]，a≠b 為漸變

const seg = (min, a, b = a) => ({ d: min * 60, a, b });
const build = (name, segs) => ({ name, segs, total: segs.reduce((s, x) => s + x.d, 0) });
const repeat = (n, ...parts) => Array.from({ length: n }, () => parts).flat();

export const SAMPLES = [
  build('輕鬆有氧 40 分', [seg(5, 0.45, 0.62), seg(30, 0.65), seg(5, 0.6, 0.4)]),
  build('甜蜜點 2×15', [
    seg(10, 0.5, 0.75),
    ...repeat(2, seg(15, 0.9), seg(5, 0.55)),
    seg(5, 0.6, 0.4),
  ]),
  build('VO2max 5×3', [
    seg(10, 0.5, 0.8),
    ...repeat(5, seg(3, 1.15), seg(3, 0.5)),
    seg(5, 0.6, 0.4),
  ]),
  build('鐵三 FTP 輸出 3×12', [
    seg(10, 0.5, 0.75),
    ...repeat(3, seg(12, 0.95), seg(4, 0.55)),
    seg(5, 0.6, 0.4),
  ]),
];

export const totalTSS = (w) =>
  Math.round(w.segs.reduce((s, x) => s + (x.d * (((x.a + x.b) / 2) ** 2)) / 3600 * 100, 0));

export function targetAt(w, t) {
  let start = 0;
  for (let i = 0; i < w.segs.length; i++) {
    const s = w.segs[i];
    if (t < start + s.d) {
      const k = (t - start) / s.d;
      return { frac: s.a + (s.b - s.a) * k, idx: i, remain: start + s.d - t, next: w.segs[i + 1] };
    }
    start += s.d;
  }
  return null; // 課表結束
}

// ---- 檔案匯入 ----
function parseZwo(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('ZWO 格式錯誤');
  const name = doc.querySelector('name')?.textContent?.trim() || 'ZWO 課表';
  const segs = [];
  const num = (el, k, def) => (el.hasAttribute(k) ? parseFloat(el.getAttribute(k)) : def);
  for (const el of doc.querySelector('workout').children) {
    const d = num(el, 'Duration', 0);
    switch (el.tagName) {
      case 'Warmup': case 'Cooldown': case 'Ramp':
        segs.push({ d, a: num(el, 'PowerLow', 0.5), b: num(el, 'PowerHigh', 0.75) });
        break;
      case 'SteadyState': {
        const p = num(el, 'Power', 0.6);
        segs.push({ d, a: p, b: p });
        break;
      }
      case 'FreeRide':
        segs.push({ d, a: 0.55, b: 0.55 });
        break;
      case 'IntervalsT': {
        const n = num(el, 'Repeat', 1);
        const on = num(el, 'OnPower', 1), off = num(el, 'OffPower', 0.5);
        for (let i = 0; i < n; i++) {
          segs.push({ d: num(el, 'OnDuration', 60), a: on, b: on });
          segs.push({ d: num(el, 'OffDuration', 60), a: off, b: off });
        }
        break;
      }
    }
  }
  return { name, segs: segs.filter((s) => s.d > 0) };
}

// MRC：[COURSE DATA] 每行 "分鐘 %FTP"；ERG（瓦特）以檔頭的 FTP 換算（沒有才用 App 的 FTP）
function parseMrc(name, text, ftp) {
  const isWatts = /\bWATTS\b/i.test(text) && !/\bPERCENT\b/i.test(text);
  const fileFtp = +(text.match(/^\s*FTP\s*=\s*(\d+(?:\.\d+)?)/im)?.[1] || 0);
  const desc = text.match(/^\s*DESCRIPTION\s*=\s*(.+)$/im)?.[1]?.trim();
  if (isWatts && fileFtp) ftp = fileFtp;
  const pts = [];
  let inData = false;
  for (const line of text.split(/\r?\n/)) {
    if (/\[COURSE DATA\]/i.test(line)) { inData = true; continue; }
    if (/\[END COURSE DATA\]/i.test(line)) break;
    if (!inData) continue;
    const [m, p] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(m) && Number.isFinite(p)) pts.push([m * 60, isWatts ? p / ftp : p / 100]);
  }
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const d = pts[i + 1][0] - pts[i][0];
    if (d > 0) segs.push({ d, a: pts[i][1], b: pts[i + 1][1] });
  }
  return { name: desc || name.replace(/\.[^.]+$/, ''), segs, ftp: isWatts ? ftp : fileFtp || null };
}

export function parseWorkoutFile(filename, text, ftp) {
  const ext = filename.split('.').pop().toLowerCase();
  let w;
  if (ext === 'zwo') w = parseZwo(text);
  else if (ext === 'mrc' || ext === 'erg') w = parseMrc(filename, text, ftp);
  else if (ext === 'json') w = JSON.parse(text);
  else throw new Error('不支援的格式：' + ext);
  if (!w.segs?.length) throw new Error('課表內沒有可用的區段');
  return { ...build(w.name || filename, w.segs), ftp: w.ftp || null };
}

// 檔名開頭的日期（TrainingPeaks 匯出格式：2026-10-24_BikeLongAe.erg）
export const dateFromName = (name) => name.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || null;
