# Hud Iron Virtual Cycling

瀏覽器版的智慧訓練台騎乘軟體（類似 Zwift / Rouvy 的第一版）。

## 功能
- Web Bluetooth 連接智慧訓練台（FTMS 協定）與心率帶
- 預設 ERG 模式，依課表自動控制訓練台功率
- 課表：把 TrainingPeaks 匯出的 `.erg` / `.mrc` / `.zwo` / `.json` 放進 `workout/` 資料夾即自動載入（檔名開頭日期如 `2026-10-24_…` 即課表日期；ERG 依檔內 FTP 換算），也可手動匯入；依今天、明天、本週分類，另附範例課表
- 大字體數據：功率（依區間變色）、ERG 目標、心率、踏頻、速度、距離、時間、目前區段剩餘時間、課表進度圖
- 3D 世界（Three.js）：三鐵車（Specialized Shiv）與騎士，踩踏動作跟隨踏頻；後方、側邊、前方、前斜、上空五種視角

## 執行
```bash
python3 -m http.server 8000
```
用 Chrome 或 Edge 開啟 http://localhost:8000 （Web Bluetooth 需要 localhost 或 https）。
沒有訓練台時可按「模擬模式」預覽。

快捷鍵：`1`–`5` 切換視角、空白鍵開始/暫停、上下方向鍵調整 ERG 目標 ±5W。

## 場景
- 🌲 山路：程式生成的無限延伸林蔭山路（預設）
- 🏙 圓山交流道（實驗）：依 OpenStreetMap 資料生成的台北圓山交流道一帶，沿中山高北上主線騎乘約 3.65 km。可用畫面左下角選單或網址 `?map=yuanshan` 切換。
  重新抓取地圖資料：`/opt/homebrew/bin/python3 tools/fetch_osm.py`

## 素材
`assets/` 中的 HDRI 天空、柏油/草地材質、草叢/蕨類/岩石模型來自 [Poly Haven](https://polyhaven.com)（CC0）。
地圖資料 © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors（ODbL）。
