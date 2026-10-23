import { Trainer, HRMonitor, bleSupported } from './ble.js';
import { World } from './world.js';
import { SAMPLES, parseWorkoutFile, targetAt, totalTSS, dateFromName } from './workout.js';

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
  tab: 'today',
  sched: load('sched', []),
};

// ---------- 藍牙 ----------
const trainer = new Trainer({
  onData: (x) => {
    if (x.power != null) S.d.power = x.power;
    if (x.cadence != null) S.d.cadence = x.cadence;
    if (x.speed != null) S.d.speed = x.speed;
    if (x.hr && !S.hrFromStrap) S.d.hr = x.hr;
  },
  onStatus: (s) => { $('btnTrainer').classList.toggle('on', trainer.connected); setStatus('訓練台：' + s); },
});
const hrm = new HRMonitor({
  onHR: (v) => { S.d.hr = v; S.hrFromStrap = true; },
  onStatus: (s) => { $('btnHR').classList.toggle('on', hrm.connected); setStatus('心率帶：' + s); },
});

function setStatus(s) { $('status').textContent = s; }
async function connect(dev, label) {
  if (!bleSupported()) return alert('此瀏覽器不支援 Web Bluetooth，請使用 Chrome 或 Edge（需 https 或 localhost）。');
  try { await dev.connect(); } catch (e) { if (e.name !== 'NotFoundError') setStatus(label + '連線失敗：' + e.message); }
}
$('btnTrainer').onclick = async () => { await connect(trainer, '訓練台'); S.lastSent = null; };
$('btnHR').onclick = () => connect(hrm, '心率帶');
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
  $('btnStart').textContent = '▶ 開始';
  $('wname').textContent = w ? `${w.name} · ${fmt(w.total)}` : '自由騎乘 · ERG';
  renderList();
}

function computeTarget() {
  const w = S.workout;
  if (w && S.running) {
    const info = targetAt(w, S.t);
    if (info) return { watts: Math.round(info.frac * S.ftp) + S.offset, info };
    S.running = false; // 課表結束
    $('btnStart').textContent = '▶ 開始';
    $('step').textContent = '完成！';
  }
  return { watts: S.manual, info: null };
}

function sendErg(watts, now) {
  if (!trainer.connected) return;
  if (watts !== S.lastSent || now - S.lastSentAt > 5000) {
    trainer.setTargetPower(watts);
    S.lastSent = watts; S.lastSentAt = now;
  }
}

function adjust(dw) {
  if (S.workout && S.running) S.offset += dw; else S.manual = Math.max(0, S.manual + dw);
}
document.querySelectorAll('[data-adj]').forEach((b) => (b.onclick = () => adjust(+b.dataset.adj)));

function toggleRun() {
  if (S.workout && !S.running && targetAt(S.workout, S.t) === null) S.t = 0; // 重新開始
  S.running = !S.running;
  $('btnStart').textContent = S.running ? '⏸ 暫停' : '▶ 繼續';
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

// ---------- HUD ----------
function updateHud(info, now) {
  const d = S.d, pw = S.sim && !trainer.connected ? d.simPower ?? 0 : d.power;
  const el = $('powerV');
  el.firstChild.nodeValue = trainer.connected || S.sim ? Math.round(pw) : '--';
  el.style.color = zoneColor(pw / S.ftp);
  $('tgt').textContent = S.target;
  $('hrV').firstChild.nodeValue = d.hr ? Math.round(d.hr) : '--';
  $('cadV').firstChild.nodeValue = d.cadence ? Math.round(d.cadence) : '--';
  $('spdV').firstChild.nodeValue = d.speed.toFixed(1);
  $('distV').textContent = S.dist.toFixed(2);
  $('elapsed').textContent = fmtHMS(S.t);
  $('clock').textContent = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (info) {
    $('step').textContent = `${S.target} W · 剩 ${fmt(info.remain)}`;
    $('stepNext').textContent = info.next ? `下一段 ${Math.round(info.next.a * S.ftp)} W` : '最後一段';
  } else if (!S.workout) {
    $('step').textContent = `手動 ERG ${S.manual} W`;
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
  if (!wk) return;
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
  if (!items.length) list.innerHTML = '<p class="hint">這段時間沒有課表，請在下方匯入，或到「範例」挑一個。</p>';
  for (const { w, e } of items) {
    const div = document.createElement('div');
    div.className = 'item' + (S.workout?.name === w.name ? ' sel' : '');
    const info = document.createElement('div');
    info.innerHTML = `<b></b><small>${e ? e.date + ' · ' : ''}${Math.round(w.total / 60)} 分 · TSS≈${totalTSS(w)}</small>`;
    info.firstChild.textContent = w.name;
    div.append(info);
    div.onclick = () => selectWorkout(w);
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
$('btnPanel').onclick = () => $('panel').classList.toggle('open');
$('ftp').value = S.ftp;
$('ftp').onchange = (e) => { S.ftp = Math.max(50, +e.target.value || 200); store('ftp', S.ftp); };
$('impDate').value = dateKey(new Date());
// 課表檔的 FTP 與 App 不同時，詢問是否改用檔案的 FTP（ERG 檔的瓦特數依此換算）
function checkFtp(w, file) {
  if (!w.ftp || w.ftp === S.ftp) return;
  if (confirm(`${file} 的 FTP 是 ${w.ftp}W，App 目前是 ${S.ftp}W。\n要把 FTP 改成 ${w.ftp}W 嗎？\n（不改的話，課表目標功率會依 ${S.ftp}W 等比例調整）`)) {
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
  if (added) { store('sched', S.sched); store('folderSeen', seen); renderList(); setStatus(`已從 workout 資料夾載入 ${added} 個課表`); }
}

// ---------- 視角 / 快捷鍵 ----------
const world = new World($('c'));
function setView(v, instant) {
  world.setView(v, instant);
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
}
document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => setView(b.dataset.view)));
$('mapSel').value = world.map;
$('mapSel').onchange = (e) => { const u = new URL(location.href); u.searchParams.set('map', e.target.value); location.href = u; };
if (world.map === 'yuanshan') $('osmCredit').style.display = 'block';
const KEYS = ['back', 'side', 'front', 'front34', 'top'];
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key >= '1' && e.key <= '5') setView(KEYS[+e.key - 1]);
  else if (e.code === 'Space') { e.preventDefault(); toggleRun(); }
  else if (e.key === 'ArrowUp') adjust(5);
  else if (e.key === 'ArrowDown') adjust(-5);
});

// ---------- 主迴圈 ----------
let last = performance.now(), hudAt = 0;
function frame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;

  const { watts, info } = computeTarget();
  S.target = Math.max(0, watts);
  sendErg(S.target, now);
  if (S.sim && !trainer.connected) simulate(dt, S.target);
  if (!trainer.connected && !S.sim) { S.d.power = 0; S.d.cadence = 0; S.d.speed = 0; }

  if (S.running) { S.t += dt; S.dist += (S.d.speed / 3600) * dt; }
  world.update(dt, { speed: S.d.speed / 3.6, cadence: S.d.cadence });
  world.render();

  if (now - hudAt > 100) { hudAt = now; updateHud(info, now); }
  requestAnimationFrame(frame);
}

selectWorkout(null);
renderList();
scanWorkoutFolder();

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
if (params.has('crank')) world.crank = (+params.get('crank') * Math.PI) / 180;
setStatus(bleSupported() ? '尚未連接裝置（可先用「模擬模式」預覽）' : '此瀏覽器不支援 Web Bluetooth，請用 Chrome / Edge');
requestAnimationFrame(frame);
