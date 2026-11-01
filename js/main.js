import { Trainer, HRMonitor, bleSupported } from './ble.js';
import { World } from './world.js';
import { SAMPLES, parseWorkoutFile, targetAt, totalTSS, dateFromName } from './workout.js';
import { t, lang, setLang, applyI18n, onLangChange } from './i18n.js';
import { BUILTIN_ROUTES, parseGpx, compactPts, buildRoute, routeAt, gradeColor } from './route.js';

const $ = (id) => document.getElementById(id);
const store = (k, v) => { try { localStorage[k] = JSON.stringify(v); } catch {} };
const load = (k, def) => { try { return JSON.parse(localStorage[k]); } catch { return def; } };

const S = {
  ftp: load('ftp', 200),
  workout: null,
  running: false,
  t: 0,          // 課表/騎乘計時（秒）
  dist: 0,       // km
  manual: 100,   // 無課表時的 ERG 目標
  offset: 0,     // 課表目標微調（W）
  sim: false,
  target: 100,
  d: { power: 0, cadence: 0, hr: 0, speed: 0 },
  hrFromStrap: false,
  lastSent: null,
  lastSentAt: 0,
  lastSegIdx: -1,
  tab: 'today',
  sched: load('sched', []),
  route: null,   // 騎乘中的 GPX 路線
  routeD: 0,     // 路線上的距離（m）
  v: 0,          // 路線模式的虛擬速度（m/s，依功率與坡度計算）
  preview: 0,    // 快轉預覽倍數（0 = 關閉；1 倍 = 30 km/h）
};

// ---------- 藍牙 ----------
const trainer = new Trainer({
  onData: (x) => {
    if (x.power != null) S.d.power = x.power;
    if (x.cadence != null) S.d.cadence = x.cadence;
    if (x.speed != null) S.d.speed = x.speed;
    if (x.hr && !S.hrFromStrap) S.d.hr = x.hr;
  },
  onStatus: (s) => { $('btnTrainer').classList.toggle('on', trainer.connected); setStatus(() => `${t('trainer')}: ${s ?? t('disconnected')}`); },
});
const hrm = new HRMonitor({
  onHR: (v) => { S.d.hr = v; S.hrFromStrap = true; },
  onStatus: (s) => { $('btnHR').classList.toggle('on', hrm.connected); setStatus(() => `${t('hrm')}: ${s ?? t('disconnected')}`); },
});

// 狀態列文字以函式保存，切換語言時重算
let statusFn = () => '';
function setStatus(fn) { statusFn = typeof fn === 'function' ? fn : () => fn; $('status').textContent = statusFn(); }
async function connect(dev, label) {
  if (!bleSupported()) return alert(t('noBle'));
  try { await dev.connect(); } catch (e) { if (e.name !== 'NotFoundError') setStatus(() => t('connFail', { d: t(label), e: e.message })); }
}
$('btnTrainer').onclick = async () => { await connect(trainer, 'trainer'); S.lastSent = null; S.lastSegIdx = -1; };
$('btnHR').onclick = () => connect(hrm, 'hrm');
$('btnSim').onclick = () => { S.sim = !S.sim; $('btnSim').classList.toggle('on', S.sim); };

// ---------- 課表 / ERG ----------
const fmt = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(x).padStart(2, '0');
};
const fmtHMS = (s) => {
  s = Math.round(s);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
};
const zoneColor = (f) =>
  f < 0.55 ? '#9aa7b3' : f < 0.75 ? '#3b9cff' : f < 0.9 ? '#3ddc84' : f < 1.05 ? '#ffd23f' : f < 1.2 ? '#ff8a1f' : '#ff3b3b';

function selectWorkout(w) {
  S.workout = w; S.t = 0; S.offset = 0; S.running = false; S.dist = 0;
  S.lastSent = null; S.lastSegIdx = -1;
  updateLabels();
  renderList();
}

const wName = (w) => (lang === 'en' && w.nameEn) || w.name;
// 依狀態而變的按鈕與標題文字
function updateLabels() {
  const w = S.workout;
  $('btnStart').textContent = t(S.running ? 'pause' : S.t > 0 && (!w || targetAt(w, S.t)) ? 'resume' : 'start');
  const R = S.route;
  $('wname').textContent = w ? `${wName(w)} · ${fmt(w.total)}` : R ? `📍 ${wName(R)} · ${(R.total / 1000).toFixed(1)} km` : t('freeRide');
  const opt = $('mapRoute');
  opt.hidden = !R;
  if (R) opt.textContent = '📍 ' + wName(R);
  if (!R) S.preview = 0;
  const pb = $('btnPreview');
  pb.hidden = !R;
  pb.textContent = S.preview ? `⏩ ×${S.preview}` : t('preview');
  pb.classList.toggle('on', !!S.preview);
  chart.classList.toggle('seek', !!R && !w);
}

// 有選課表時 ERG 一律依課表瓦數（開始前、暫停中都是目前位置的目標）；沒有課表才用手動目標
function computeTarget() {
  const w = S.workout;
  if (!w) return { watts: S.manual, info: null };
  const info = targetAt(w, S.t);
  if (info) return { watts: Math.round(info.frac * S.ftp) + S.offset, info };
  if (S.running) { // 課表結束：停止計時，維持最後一段結束時的瓦數
    S.running = false;
    updateLabels();
  }
  return { watts: Math.round(w.segs[w.segs.length - 1].b * S.ftp) + S.offset, info: null, done: true };
}

function sendErg(watts) {
  trainer.setTargetPower(watts);
}

function adjust(dw) {
  if (S.workout) S.offset += dw; else S.manual = Math.max(0, S.manual + dw);
}
document.querySelectorAll('[data-adj]').forEach((b) => (b.onclick = () => adjust(+b.dataset.adj)));

function toggleRun() {
  if (S.workout && !S.running && targetAt(S.workout, S.t) === null) S.t = 0; // 重新開始
  if (!S.workout && S.route && S.routeD >= S.route.total) { S.routeD = 0; S.v = 0; S.t = 0; } // 路線騎完：從頭再騎
  S.running = !S.running;
  updateLabels();
}
$('btnStart').onclick = toggleRun;

// ---------- 模擬模式（沒有訓練台時預覽用） ----------
function powerToSpeed(p) { // 解 P = v(0.5·ρ·CdA·v² + Crr·m·g)，回傳 km/h
  let lo = 0, hi = 25;
  for (let i = 0; i < 30; i++) {
    const v = (lo + hi) / 2;
    (v * (0.5 * 1.226 * 0.24 * v * v + 0.004 * 82 * 9.81) < p ? (lo = v) : (hi = v));
  }
  return lo * 3.6;
}
function simulate(dt, target) {
  const d = S.d, k = Math.min(1, dt * 1.5);
  d.power += (target - d.power) * k;
  const pw = Math.max(0, d.power + (Math.random() - 0.5) * 8);
  const cad = pw > 5 ? 88 + Math.sin(performance.now() / 4000) * 4 : 0;
  d.cadence += (cad - d.cadence) * k;
  d.speed += (powerToSpeed(pw) - d.speed) * Math.min(1, dt * 0.8);
  if (!S.hrFromStrap && d.hr < 60) d.hr = 65; // 模擬心率從靜止心率起算
  if (!S.hrFromStrap) d.hr += ((pw > 5 ? 75 + pw * 0.45 : 70) - d.hr) * Math.min(1, dt * 0.03);
  d.simPower = pw;
}

// ---------- 路線騎乘物理 ----------
// m·dv/dt = P/v − (½ρ·CdA·v² + Crr·m·g·cosθ + m·g·sinθ)；騎士+車 82kg、CdA 0.24（三鐵車空力姿勢）、Crr 0.004
function ridePhysics(v, P, grade, dt) {
  const m = 82, g = 9.81, th = Math.atan(grade / 100);
  const drive = P / Math.max(v, 0.5); // 低速時推力 = P/v（下限 0.5 m/s，避免起步除以零；太高會讓陡坡爬不上去）
  const resist = 0.5 * 1.226 * 0.24 * v * v * Math.sign(v) + 0.004 * m * g * Math.cos(th) + m * g * Math.sin(th);
  return Math.max(0, v + ((drive - resist) / (m + 1.5)) * dt);
}

// ---------- HUD ----------
function updateHud(info, now) {
  const d = S.d, pw = S.sim && !trainer.connected ? d.simPower ?? 0 : d.power;
  const el = $('powerV');
  el.firstChild.nodeValue = trainer.connected || S.sim ? Math.round(pw) : '--';
  el.style.color = zoneColor(pw / S.ftp);
  const R = S.route, here = R && routeAt(R, S.routeD), simMode = R && !S.workout;
  $('tgtLabel').textContent = t(simMode ? 'grade' : 'ergTarget');
  $('tgt').textContent = simMode ? here.grade.toFixed(1) : S.target;
  $('tgtUnit').textContent = simMode ? '%' : 'W';
  $('hrV').firstChild.nodeValue = d.hr ? Math.round(d.hr) : '--';
  $('cadV').firstChild.nodeValue = d.cadence ? Math.round(d.cadence) : '--';
  $('spdV').firstChild.nodeValue = d.speed.toFixed(1);
  $('distV').textContent = (R ? S.routeD / 1000 : S.dist).toFixed(2);
  $('elapsed').textContent = fmtHMS(S.t);
  $('clock').textContent = new Date().toLocaleTimeString(lang === 'en' ? 'en-GB' : 'zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (info) {
    const state = S.running ? '' : S.t > 0 ? '⏸ ' : t('ready');
    $('step').textContent = lang === 'en' ? `${state}${S.target} W · ${fmt(info.remain)} ${t('remain')}` : `${state}${S.target} W · ${t('remain')} ${fmt(info.remain)}`;
    $('stepNext').textContent = info.next ? t('next', { w: Math.round(info.next.a * S.ftp) + S.offset }) : t('lastSeg');
  } else if (S.workout) {
    $('step').textContent = t('done', { w: S.target });
    $('stepNext').textContent = t('again');
  } else if (R) {
    const done = S.routeD >= R.total;
    $('step').textContent = done ? t('routeDone', { n: wName(R) }) : `${here.grade.toFixed(1)}% · ${t('remainKm', { d: ((R.total - S.routeD) / 1000).toFixed(2) })}`;
    const mark = R.marks?.find((m) => m.s - S.routeD < 150 && m.s - S.routeD > -30); // 前方 150m 內的地標
    const info = t('climbInfo', { a: Math.round(here.climbed), b: Math.round(R.gain), e: Math.round(here.ele) });
    $('stepNext').textContent = done ? t('routeAgain') : mark ? `📍 ${['turning', 'shelter'].includes(mark.kind) ? t('finishAt') : ''}${mark.label} · ${info}` : info;
  } else {
    $('step').textContent = t('manual', { w: S.manual });
    $('stepNext').textContent = '';
  }
  drawChart();
}

const chart = $('chart');
function drawChart() {
  const w = (chart.width = chart.clientWidth * devicePixelRatio);
  const h = (chart.height = chart.clientHeight * devicePixelRatio);
  const ctx = chart.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const wk = S.workout;
  if (!wk) { if (S.route) drawProfile(ctx, w, h, S.route); return; }
  const max = Math.max(1.3, ...wk.segs.map((s) => Math.max(s.a, s.b))) ;
  let x = 0;
  for (const s of wk.segs) {
    const sw = (s.d / wk.total) * w;
    const ha = (s.a / max) * h, hb = (s.b / max) * h;
    ctx.fillStyle = zoneColor((s.a + s.b) / 2);
    ctx.beginPath();
    ctx.moveTo(x, h); ctx.lineTo(x, h - ha); ctx.lineTo(x + sw, h - hb); ctx.lineTo(x + sw, h);
    ctx.fill();
    x += sw;
  }
  const px = Math.min(1, S.t / wk.total) * w;
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(0, 0, px, h);
  ctx.fillStyle = '#fff'; ctx.fillRect(px - 1.5, 0, 3, h);
  ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.setLineDash([6, 6]);
  const fy = h - (1 / max) * h;
  ctx.beginPath(); ctx.moveTo(0, fy); ctx.lineTo(w, fy); ctx.stroke(); // FTP 線
}

// 快轉預覽：30 → 120 → 480 km/h → 關閉（只在騎路線時出現）
const PREVIEW = [0, 1, 4, 16];
function cyclePreview() {
  if (!S.route) return;
  S.preview = PREVIEW[(PREVIEW.indexOf(S.preview) + 1) % PREVIEW.length];
  if (S.preview && S.routeD >= S.route.total) S.routeD = 0; // 已在終點就從頭預覽
  if (!S.preview) S.v = 0;
  updateLabels();
}
$('btnPreview').onclick = cyclePreview;
// 點或拖曳高度圖：跳到路線上的該位置（沒選課表時）
chart.addEventListener('pointerdown', (e) => {
  if (!S.route || S.workout) return;
  const seek = (ev) => {
    const b = chart.getBoundingClientRect();
    S.routeD = Math.min(1, Math.max(0, (ev.clientX - b.left) / b.width)) * S.route.total;
    if (!S.preview) S.v = 0;
  };
  seek(e);
  chart.setPointerCapture(e.pointerId);
  chart.onpointermove = (ev) => { if (ev.buttons) seek(ev); };
  chart.onpointerup = () => { chart.onpointermove = chart.onpointerup = null; };
});

// 路線高度剖面（依坡度上色）與目前位置
function drawProfile(ctx, w, h, R) {
  let lo = Infinity, hi = -Infinity;
  for (const e of R.ele) { lo = Math.min(lo, e); hi = Math.max(hi, e); }
  const span = Math.max(30, hi - lo), n = R.s.length, bw = 2 * devicePixelRatio;
  for (let px = 0; px < w; px += bw) {
    const i = Math.min(n - 1, Math.round((px / w) * (n - 1)));
    const hh = (0.12 + (0.83 * (R.ele[i] - lo)) / span) * h;
    ctx.fillStyle = gradeColor(R.grade[i]);
    ctx.fillRect(px, h - hh, bw + 0.5, hh);
  }
  const px = Math.min(1, S.routeD / R.total) * w;
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(0, 0, px, h);
  ctx.fillStyle = '#fff'; ctx.fillRect(px - 1.5, 0, 3, h);
}

// ---------- 課表面板 ----------
const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

function visibleWorkouts() {
  const now = new Date();
  if (S.tab === 'sample') return SAMPLES.map((w) => ({ w }));
  let keys;
  if (S.tab === 'today') keys = [dateKey(now)];
  else if (S.tab === 'tomorrow') keys = [dateKey(addDays(now, 1))];
  else {
    const mon = addDays(now, -((now.getDay() + 6) % 7));
    keys = Array.from({ length: 7 }, (_, i) => dateKey(addDays(mon, i)));
  }
  return S.sched.filter((e) => keys.includes(e.date)).sort((a, b) => a.date.localeCompare(b.date)).map((e) => ({ w: e.w, e }));
}

function renderList() {
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  const list = $('list');
  list.textContent = '';
  const items = visibleWorkouts();
  if (!items.length) list.innerHTML = `<p class="hint">${t('noWorkouts')}</p>`;
  for (const { w, e } of items) {
    const div = document.createElement('div');
    div.className = 'item' + (S.workout?.name === w.name ? ' sel' : '');
    const info = document.createElement('div');
    info.innerHTML = `<b></b><small>${e ? e.date + ' · ' : ''}${Math.round(w.total / 60)} ${t('min')} · TSS≈${totalTSS(w)}</small>`;
    info.firstChild.textContent = wName(w);
    div.append(info);
    div.onclick = () => { selectWorkout(w); closePanel(); };
    if (e) {
      const x = document.createElement('span');
      x.className = 'x'; x.textContent = '✕';
      x.onclick = (ev) => { ev.stopPropagation(); S.sched = S.sched.filter((s) => s !== e); store('sched', S.sched); renderList(); };
      div.append(x);
    }
    list.append(div);
  }
}

document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; renderList(); }));
const panel = $('panel');
const closePanel = () => panel.classList.remove('open');
$('btnPanel').onclick = (e) => { e.stopPropagation(); panel.classList.toggle('open'); };
$('btnPanelClose').onclick = closePanel;
// 點側邊欄裡的空白處（非按鈕、輸入框、課表項目）也會收起
panel.addEventListener('click', (e) => { if (!e.target.closest('button, input, select, label, .item, .tabs')) closePanel(); });
// 點側邊欄外面也會收起（側邊欄打開時會蓋住「課表」按鈕）
document.addEventListener('pointerdown', (e) => { if (panel.classList.contains('open') && !panel.contains(e.target) && e.target !== $('btnPanel')) closePanel(); });
$('ftp').value = S.ftp;
$('ftp').onchange = (e) => { S.ftp = Math.max(50, +e.target.value || 200); store('ftp', S.ftp); };
$('impDate').value = dateKey(new Date());
// 課表檔的 FTP 與 App 不同時，詢問是否改用檔案的 FTP（ERG 檔的瓦特數依此換算）
function checkFtp(w, file) {
  if (!w.ftp || w.ftp === S.ftp) return;
  if (confirm(t('ftpAsk', { f: file, a: w.ftp, b: S.ftp }))) {
    S.ftp = w.ftp; store('ftp', S.ftp); $('ftp').value = S.ftp;
  }
}

function addWorkout(file, text, date) {
  const w = parseWorkoutFile(file, text, S.ftp);
  S.sched = S.sched.filter((e) => e.file !== file); // 同檔名覆蓋
  S.sched.push({ date: dateFromName(file) || date, w, file });
  return w;
}

$('impFile').onchange = async (e) => {
  for (const f of e.target.files) {
    try { checkFtp(addWorkout(f.name, await f.text(), $('impDate').value || dateKey(new Date())), f.name); }
    catch (err) { alert(`${f.name}：${err.message}`); }
  }
  store('sched', S.sched);
  e.target.value = '';
  S.tab = 'today';
  renderList();
};

// 自動讀取 workout/ 資料夾（依本機伺服器的目錄列表）；新檔或內容改變才加入
async function scanWorkoutFolder() {
  let html;
  try { const r = await fetch('workout/', { cache: 'no-store' }); if (!r.ok) return; html = await r.text(); } catch { return; }
  const files = [...html.matchAll(/href="([^"?]+\.(?:erg|mrc|zwo|json))"/gi)].map((m) => decodeURIComponent(m[1]));
  const seen = load('folderSeen', {});
  let added = 0;
  for (const f of files) {
    try {
      const text = await (await fetch('workout/' + encodeURIComponent(f), { cache: 'no-store' })).text();
      if (seen[f] === text.length + ':' + text.slice(-64)) continue;
      checkFtp(addWorkout(f, text, dateKey(new Date())), f);
      seen[f] = text.length + ':' + text.slice(-64);
      added++;
    } catch (err) { console.warn('workout file', f, err); }
  }
  if (added) { store('sched', S.sched); store('folderSeen', seen); renderList(); setStatus(() => t('folderLoaded', { n: added })); }
}

// ---------- 視角 / 快捷鍵 ----------
const world = new World($('c'));
function setView(v, instant) {
  world.setView(v, instant);
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
}
document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => setView(b.dataset.view)));
const setUrlMap = (map) => { const u = new URL(location.href); u.searchParams.set('map', map); history.replaceState(null, '', u); };
const showCredit = () => {
  const real = world.map === 'route' && S.route?.real;
  $('osmCredit').textContent = t(real ? 'creditReal' : 'osm');
  $('osmCredit').style.display = world.map === 'yuanshan' || (world.map === 'route' && S.route?.osm) ? 'block' : 'none';
};
async function switchMap(map) {
  const sel = $('mapSel');
  if (map === 'route') {
    const e = routeEntries.find((x) => x.key === load('routeKey', null));
    if (e) return selectRoute(e);
    map = 'mountain';
  }
  S.route = null; updateLabels(); renderRoutes();
  sel.disabled = true; sel.blur();
  setStatus(() => t('mapLoading'));
  try {
    await world.setMap(map);
    setUrlMap(map);
    setStatus(() => t('mapDone'));
  } catch (err) { console.warn('map', err); setStatus(() => t('mapFail', { e: err.message })); }
  sel.value = world.map; sel.disabled = false;
  showCredit();
}
$('mapSel').value = world.map;
$('mapSel').onchange = (e) => switchMap(e.target.value);
showCredit();

// ---------- 路線（GPX） ----------
const routeEntries = []; // { key, name, nameEn, pts, osm, user, km, gain }
function addRouteEntry(e) {
  try { const r = buildRoute(e); e.km = r.total / 1000; e.gain = r.gain; } catch { return false; }
  const i = routeEntries.findIndex((x) => x.key === e.key);
  if (i >= 0) routeEntries[i] = e; else routeEntries.push(e);
  return true;
}
async function loadRouteCatalog() {
  for (const b of BUILTIN_ROUTES) {
    try {
      const g = parseGpx(await (await fetch(b.file)).text());
      addRouteEntry({ key: 'b:' + b.file, name: b.name, nameEn: b.nameEn, pts: g.pts, osm: true, scene: b.scene });
    } catch (err) { console.warn('route', b.file, err); }
  }
  for (const u of load('routes', [])) addRouteEntry({ ...u, user: true });
  // routes/ 資料夾（個人路線，不進版本控制）
  let html;
  try { const r = await fetch('routes/', { cache: 'no-store' }); if (r.ok) html = await r.text(); } catch {}
  let n = 0;
  for (const f of html ? [...html.matchAll(/href="([^"?]+\.gpx)"/gi)].map((m) => decodeURIComponent(m[1])) : []) {
    try {
      const g = parseGpx(await (await fetch('routes/' + encodeURIComponent(f), { cache: 'no-store' })).text(), f);
      if (addRouteEntry({ key: 'f:' + f, name: g.name, pts: g.pts })) n++;
    } catch (err) { console.warn('route', f, err); }
  }
  if (n) setStatus(() => t('routesLoaded', { n }));
  renderRoutes();
}
function renderRoutes() {
  const list = $('routeList');
  list.textContent = '';
  for (const e of [{ key: null }, ...routeEntries]) {
    const div = document.createElement('div');
    div.className = 'item' + ((S.route?.key ?? null) === e.key ? ' sel' : '');
    const info = document.createElement('div');
    if (e.key) {
      info.innerHTML = `<b></b><small>${e.km.toFixed(1)} km · ↑${Math.round(e.gain)} m</small>`;
      info.firstChild.textContent = '📍 ' + wName(e);
    } else info.innerHTML = `<b>${t('noRoute')}</b>`;
    div.append(info);
    div.onclick = () => { closePanel(); if (e.key) selectRoute(e); else if (S.route) switchMap('mountain'); };
    if (e.user) {
      const x = document.createElement('span');
      x.className = 'x'; x.textContent = '✕';
      x.onclick = (ev) => {
        ev.stopPropagation();
        routeEntries.splice(routeEntries.indexOf(e), 1);
        store('routes', load('routes', []).filter((u) => u.key !== e.key));
        renderRoutes();
      };
      div.append(x);
    }
    list.append(div);
  }
}
async function selectRoute(e) {
  const r = buildRoute(e);
  r.key = e.key; r.osm = !!e.osm;
  if (e.scene) { // 實景資料（地形、房屋、道路）
    try { e.real ||= await (await fetch(e.scene)).json(); r.real = e.real; } catch (err) { console.warn('scene', err); }
  }
  S.route = r; S.routeD = 0; S.v = 0;
  store('routeKey', e.key);
  updateLabels(); renderRoutes();
  const sel = $('mapSel');
  sel.disabled = true;
  setStatus(() => t('routeLoading'));
  await new Promise((ok) => setTimeout(ok, 30)); // 先讓狀態文字顯示，再建場景
  try {
    await world.setRoute(r);
    setUrlMap('route');
    setStatus(() => t('routeReady', { n: wName(r), d: (r.total / 1000).toFixed(1), g: Math.round(r.gain) }));
  } catch (err) { console.warn('route', err); setStatus(() => t('mapFail', { e: err.message })); }
  sel.value = world.map; sel.disabled = false;
  showCredit();
}
$('impGpx').onchange = async (e) => {
  const saved = load('routes', []);
  let lastKey = null;
  for (const f of e.target.files) {
    try {
      const g = parseGpx(await f.text(), f.name);
      const entry = { key: 'u:' + f.name, name: g.name, pts: compactPts(g.pts) };
      if (!addRouteEntry({ ...entry, user: true })) throw new Error('GPX');
      saved.splice(0, saved.length, ...saved.filter((u) => u.key !== entry.key), entry);
      lastKey = entry.key;
    } catch { alert(t('gpxErr', { f: f.name })); }
  }
  store('routes', saved);
  e.target.value = '';
  renderRoutes();
  if (lastKey) { closePanel(); selectRoute(routeEntries.find((x) => x.key === lastKey)); }
};
// ---------- 語言 ----------
applyI18n();
$('btnLang').onclick = () => setLang(lang === 'zh' ? 'en' : 'zh');
onLangChange(() => { updateLabels(); renderList(); renderRoutes(); showCredit(); $('status').textContent = statusFn(); updateHud(computeTarget().info); });

const KEYS = ['back', 'side', 'front', 'front34', 'top'];
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return closePanel();
  if (e.target.tagName === 'INPUT') return;
  if (e.key >= '1' && e.key <= '5') setView(KEYS[+e.key - 1]);
  else if (e.code === 'Space') { e.preventDefault(); toggleRun(); }
  else if (e.key === 'ArrowUp') adjust(5);
  else if (e.key === 'ArrowDown') adjust(-5);
  else if (e.key === 'l' || e.key === 'L') $('btnLang').click();
  else if (e.key === 'p' || e.key === 'P') cyclePreview();
});

// ---------- 主迴圈 ----------
let last = performance.now(), hudAt = 0;
function frame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;

  const { watts, info } = computeTarget();
  S.target = Math.max(0, watts);
  const R = S.route && world.map === 'route' ? S.route : null;
  const grade = R ? routeAt(R, S.routeD).grade : 0;
  // 有課表：ERG 依課表瓦數；只騎路線：SIM 依坡度（預覽快轉時設為平路）；都沒有：手動 ERG
  if (R && !S.workout) trainer.setGrade(S.preview ? 0 : grade); else sendErg(S.target, info, now);
  if (S.sim && !trainer.connected) simulate(dt, S.target);
  if (!trainer.connected && !S.sim) { S.d.power = 0; S.d.cadence = 0; S.d.speed = 0; }

  if (R) { // 路線：速度由功率與坡度決定（不用訓練台回報的速度）
    const P = trainer.connected ? S.d.power : S.sim ? S.d.simPower ?? 0 : 0;
    S.v = S.preview ? (30 / 3.6) * S.preview : ridePhysics(S.v, P, grade, dt);
    S.d.speed = S.v * 3.6;
    S.routeD = Math.min(R.total, S.routeD + (S.v * dt) / Math.hypot(1, grade / 100));
    if (S.preview && S.routeD >= R.total) { S.preview = 0; S.v = 0; updateLabels(); } // 預覽到終點自動停止
  }
  if (S.running) { S.t += dt; S.dist += (S.d.speed / 3600) * dt; }
  world.update(dt, { speed: S.d.speed / 3.6, cadence: S.preview ? 90 : S.d.cadence, routeD: S.routeD });
  world.render();

  if (now - hudAt > 100) { hudAt = now; updateHud(info, now); }
  requestAnimationFrame(frame);
}

selectWorkout(null);
renderList();
scanWorkoutFolder();
loadRouteCatalog().then(() => {
  const g = new URLSearchParams(location.search).get('gpx'); // 測試用：?gpx=0 直接騎第 0 條路線
  if (g != null && routeEntries[+g]) selectRoute(routeEntries[+g]);
  else if (world.map === 'route') switchMap('route');
});

// 測試參數：?sim=1&view=side&hud=0&start=1
const params = new URLSearchParams(location.search);
if (params.has('sim')) $('btnSim').click();
if (params.has('view')) setView(params.get('view'), true);
if (params.get('hud') === '0') document.body.classList.add('nohud');
if (params.has('start')) { selectWorkout(SAMPLES[1]); toggleRun(); }
if (params.has('fps')) { // 效能量測：每 2 秒輸出平均 FPS 與繪製統計
  let n = 0, t0 = performance.now();
  const tick = () => { n++; const t = performance.now(); if (t - t0 > 2000) { const i = world.renderer.info.render; console.log('fps', (n * 1000 / (t - t0)).toFixed(1), 'dpr', world.dpr.toFixed(2), 'tris', i.triangles, 'calls', i.calls); n = 0; t0 = t; } requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
if (params.has('route')) world.routeS = +params.get('route');
if (params.has('wt')) { window.__seek = (t) => { S.t = t; }; window.__routeD = (d) => { S.routeD = d; }; window.__world = world; } // 測試用：跳到課表某秒 / 路線某處
if (params.has('crank')) world.crank = (+params.get('crank') * Math.PI) / 180;
setStatus(() => t(bleSupported() ? 'idle' : 'noBleShort'));
requestAnimationFrame(frame);
