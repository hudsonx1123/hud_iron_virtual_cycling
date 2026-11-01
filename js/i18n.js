// 中英文介面：t(key, vars) 取字串；HTML 以 data-i18n / data-i18n-html / data-i18n-title 標記，setLang() 即時切換

const DICT = {
  zh: {
    title: '哈鐵 · Hud Iron',
    clock: '現在時間', elapsed: '騎乘時間', dist: '距離 KM',
    power: '功率 POWER', ergTarget: 'ERG 目標', hr: '心率 HEART RATE', cad: '踏頻 CADENCE', spd: '速度 SPEED',
    start: '▶ 開始', pause: '⏸ 暫停', resume: '▶ 繼續',
    connTrainer: '🔌 連接訓練台', connHR: '❤ 連接心率帶', sim: '模擬模式',
    vBack: '後方 1', vSide: '側邊 2', vFront: '前方 3', vFront34: '前斜 4', vTop: '上空 5',
    workouts: '📅 課表', scene: '場景', mapMountain: '🌲 山路', mapYuanshan: '🏙 圓山交流道',
    langBtn: 'EN', langTitle: 'Switch to English (L)',
    close: '關閉（Esc）', panelTitle: '課表',
    today: '今天', tomorrow: '明天', week: '本週', sample: '範例',
    importTitle: '匯入課表', date: '日期', chooseFile: '📂 選擇課表檔',
    importHint: '把 TrainingPeaks 匯出的 .erg / .mrc / .zwo 放進專案的 <b>workout</b> 資料夾，開啟時會自動載入，檔名開頭的日期（如 2026-10-24_…）即課表日期。也可以用上面的按鈕手動匯入。',
    osm: '地圖資料 © OpenStreetMap contributors',
    freeRide: '自由騎乘 · ERG',
    ready: '準備 ', remain: '剩', next: '下一段 {w} W', lastSeg: '最後一段',
    done: '完成！ {w} W', again: '按開始可重新騎一次', manual: '手動 ERG {w} W',
    noWorkouts: '這段時間沒有課表，請在下方匯入，或到「範例」挑一個。', min: '分',
    trainer: '訓練台', hrm: '心率帶', disconnected: '已斷線', connFail: '{d}連線失敗：{e}',
    noBle: '此瀏覽器不支援 Web Bluetooth，請使用 Chrome 或 Edge（需 https 或 localhost）。',
    noBleShort: '此瀏覽器不支援 Web Bluetooth，請用 Chrome / Edge',
    idle: '尚未連接裝置（可先用「模擬模式」預覽）',
    ftpAsk: '{f} 的 FTP 是 {a}W，App 目前是 {b}W。\n要把 FTP 改成 {a}W 嗎？\n（不改的話，課表目標功率會依 {b}W 等比例調整）',
    folderLoaded: '已從 workout 資料夾載入 {n} 個課表',
    mapLoading: '載入場景中…', mapDone: '場景已切換', mapFail: '場景載入失敗：{e}',
    routes: '路線', importGpx: '📂 匯入 GPX', preview: '⏩ 預覽', previewTitle: '快轉預覽路線（P）：30 → 120 → 480 km/h → 關閉；也可以點下方高度圖跳到任一位置', noRoute: '不使用路線（一般場景）',
    routeHint: '把 .gpx 路線檔放進專案的 <b>routes</b> 資料夾，開啟時會自動載入；也可以用上面的按鈕匯入。騎路線時速度依功率與坡度計算；沒選課表時訓練台阻力跟著坡度變化（SIM 模式），有選課表則仍以課表瓦數為準（ERG）。',
    grade: '坡度', remainKm: '剩 {d} km', climbInfo: '爬升 {a} / {b} m · 海拔 {e} m', routeDone: '完成 {n}！', routeAgain: '按開始可從頭再騎', finishAt: '終點：',
    routeLoading: '建立路線場景中（實景會載入地形與航照）…',
    creditReal: '航照 © 內政部國土測繪中心 · 地形 © 內政部 20m DTM · 地圖資料 © OpenStreetMap contributors', routeReady: '路線：{n}（{d} km，爬升 {g} m）', gpxErr: '無法讀取 GPX：{f}',
    routesLoaded: '已從 routes 資料夾載入 {n} 條路線',
    errZwo: 'ZWO 格式錯誤', zwoName: 'ZWO 課表', errExt: '不支援的格式：{x}', errEmpty: '課表內沒有可用的區段',
  },
  en: {
    title: 'Hud Iron',
    clock: 'TIME', elapsed: 'ELAPSED', dist: 'DISTANCE KM',
    power: 'POWER', ergTarget: 'ERG target', hr: 'HEART RATE', cad: 'CADENCE', spd: 'SPEED',
    start: '▶ Start', pause: '⏸ Pause', resume: '▶ Resume',
    connTrainer: '🔌 Trainer', connHR: '❤ HR', sim: 'Simulate',
    vBack: 'Rear 1', vSide: 'Side 2', vFront: 'Front 3', vFront34: 'Front¾ 4', vTop: 'Top 5',
    workouts: '📅 Workouts', scene: 'Scene', mapMountain: '🌲 Mountain', mapYuanshan: '🏙 Yuanshan',
    langBtn: '中', langTitle: '切換為中文 (L)',
    close: 'Close (Esc)', panelTitle: 'Workouts',
    today: 'Today', tomorrow: 'Tomorrow', week: 'This week', sample: 'Samples',
    importTitle: 'Import workout', date: 'Date', chooseFile: '📂 Choose files',
    importHint: 'Put .erg / .mrc / .zwo files exported from TrainingPeaks into the project\'s <b>workout</b> folder and they load automatically. A date at the start of the file name (e.g. 2026-10-24_…) sets the workout date. You can also import manually with the button above.',
    osm: 'Map data © OpenStreetMap contributors',
    freeRide: 'Free ride · ERG',
    ready: 'Ready ', remain: 'left', next: 'Next {w} W', lastSeg: 'Last interval',
    done: 'Done! {w} W', again: 'Press Start to ride it again', manual: 'Manual ERG {w} W',
    noWorkouts: 'No workouts in this period. Import one below or pick one from Samples.', min: 'min',
    trainer: 'Trainer', hrm: 'HR strap', disconnected: 'disconnected', connFail: '{d} connection failed: {e}',
    noBle: 'This browser does not support Web Bluetooth. Use Chrome or Edge (https or localhost required).',
    noBleShort: 'Web Bluetooth not supported. Use Chrome / Edge',
    idle: 'No devices connected (try Simulate to preview)',
    ftpAsk: '{f} uses an FTP of {a}W, the app is set to {b}W.\nChange FTP to {a}W?\n(If not, workout targets scale to {b}W.)',
    folderLoaded: 'Loaded {n} workout(s) from the workout folder',
    mapLoading: 'Loading scene…', mapDone: 'Scene switched', mapFail: 'Scene failed to load: {e}',
    routes: 'Routes', importGpx: '📂 Import GPX', preview: '⏩ Preview', previewTitle: 'Fast-forward preview (P): 30 → 120 → 480 km/h → off. You can also click the elevation chart to jump anywhere', noRoute: 'No route (regular scenes)',
    routeHint: 'Put .gpx route files into the project\'s <b>routes</b> folder and they load automatically, or import them with the button above. On a route your speed comes from power and gradient. Without a workout the trainer resistance follows the gradient (SIM mode); with a workout it still holds the workout watts (ERG).',
    grade: 'Grade', remainKm: '{d} km left', climbInfo: 'Climbed {a} / {b} m · Elev {e} m', routeDone: 'Finished {n}!', routeAgain: 'Press Start to ride it again', finishAt: 'Finish: ',
    routeLoading: 'Building route scene (real routes load terrain and aerial imagery)…',
    creditReal: 'Imagery © NLSC, Ministry of the Interior · Terrain © MOI 20m DTM · Map data © OpenStreetMap contributors', routeReady: 'Route: {n} ({d} km, {g} m climbing)', gpxErr: 'Could not read GPX: {f}',
    routesLoaded: 'Loaded {n} route(s) from the routes folder',
    errZwo: 'Invalid ZWO file', zwoName: 'ZWO workout', errExt: 'Unsupported format: {x}', errEmpty: 'Workout has no usable intervals',
  },
};

const saved = (() => { try { return localStorage.getItem('lang'); } catch { return null; } })();
export let lang = DICT[saved] ? saved : /^zh/i.test(navigator.language) ? 'zh' : 'en';

export const t = (key, vars = {}) =>
  (DICT[lang][key] ?? DICT.zh[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

const listeners = [];
export const onLangChange = (fn) => listeners.push(fn);

export function applyI18n(root = document) {
  document.documentElement.lang = lang === 'zh' ? 'zh-Hant' : 'en';
  document.title = t('title');
  root.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  root.querySelectorAll('[data-i18n-html]').forEach((el) => (el.innerHTML = t(el.dataset.i18nHtml)));
  root.querySelectorAll('[data-i18n-title]').forEach((el) => (el.title = t(el.dataset.i18nTitle)));
}

export function setLang(l) {
  if (!DICT[l]) return;
  lang = l;
  try { localStorage.setItem('lang', l); } catch {}
  applyI18n();
  for (const fn of listeners) fn(l);
}
