#!/usr/bin/env python3
"""依道路名稱從 OpenStreetMap 取得路線，查詢高度後輸出帶高度的 GPX 路線檔。

用法：
  /opt/homebrew/bin/python3 tools/make_route_gpx.py 中社路 --names 中社路一段,中社路二段 \
      --bbox 25.08,121.52,25.16,121.60 --title 中社路 --out assets/routes/zhongshe.gpx

- 路段：Overpass 抓取 bbox 內符合名稱的道路，依端點自動串接成一條線（從離其他路段最遠的端點開始）；
  同名道路有支線時加 --from / --to，改取兩點間的最短路徑
- 高度：OpenTopoData 的 SRTM 與 ASTER 30m 平均，再以約 60m 的高斯平滑去除地形雜訊
- 方向：預設由低往高（爬坡）；加 --downhill 反轉
- 實景場景（--dem 內政部 20m DTM 資料夾 + --scene 輸出檔）：路線高度改用 DTM，另輸出周邊地形格網與 OSM 房屋、道路
  DTM 下載：data.gov.tw「全臺灣20公尺網格數值地形模型DTM資料」→ 分幅_臺北市20MDEM(2024).zip，解壓到 .cache/dem/taipei
地圖資料 © OpenStreetMap contributors（ODbL）；高度資料 SRTM（公眾領域）、ASTER GDEM（NASA/METI）、
內政部 20m DTM（政府資料開放授權條款第 1 版）。
"""
import argparse, base64, hashlib, heapq, json, math, struct, sys, time, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / '.cache' / 'route'
UA = {'User-Agent': 'hud-iron-virtual-cycling/1.0'}
OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
            'https://overpass.kumi.systems/api/interpreter']


def cached(key, fn):
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / (hashlib.sha1(key.encode()).hexdigest()[:16] + '.json')
    if f.exists():
        return json.loads(f.read_text())
    v = fn()
    f.write_text(json.dumps(v))
    return v


def overpass(q):
    data = urllib.parse.urlencode({'data': q}).encode()
    for attempt in range(4):
        for url in OVERPASS:
            try:
                with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=UA), timeout=150) as r:
                    return json.load(r)
            except Exception as e:  # noqa: BLE001
                print(f'  {url} 失敗：{e}', file=sys.stderr)
                time.sleep(4)
    sys.exit('Overpass 皆無法連線')


def dist(a, b):
    la = math.radians((a[0] + b[0]) / 2)
    return math.hypot((b[1] - a[1]) * math.cos(la), b[0] - a[0]) * math.pi / 180 * 6371000


def chain(ways):
    """把多段 way 依端點串成一條線。點可帶第三個欄位（所屬 way 編號），線段歸屬於其終點所屬的 way。"""
    ways = [list(w) for w in ways]
    ends = [p for w in ways for p in (w[0], w[-1])]
    # 起點：離其他端點最遠的端點（道路的盡頭）
    def iso(p):
        return min((dist(p, q) for q in ends if q is not p), default=0)
    start_w = max(ways, key=lambda w: max(iso(w[0]), iso(w[-1])))
    if iso(start_w[-1]) > iso(start_w[0]):
        start_w.reverse()
    line = start_w[:]
    rest = [w for w in ways if w is not start_w]
    while rest:
        tail = line[-1]
        w = min(rest, key=lambda w: min(dist(tail, w[0]), dist(tail, w[-1])))
        rest.remove(w)
        if dist(tail, w[-1]) < dist(tail, w[0]):
            w.reverse()
        line += w[1:] if dist(tail, w[0]) < 1 else w
    return line


def shortest(ways, a, b):
    """在路網上找 a → b（經緯度）的最短路徑；點同 chain() 帶所屬 way 編號。適合同名道路有支線、只走其中一部分時。"""
    G = {}
    for w in ways:
        for p, q in zip(w, w[1:]):
            k1, k2, L = p[:2], q[:2], dist(p, q)
            G.setdefault(k1, []).append((k2, L, q[2]))
            G.setdefault(k2, []).append((k1, L, q[2]))
    s, t = min(G, key=lambda p: dist(p, a)), min(G, key=lambda p: dist(p, b))
    best, prev, pq = {s: 0}, {}, [(0, s)]
    while pq:
        c, u = heapq.heappop(pq)
        if u == t:
            break
        if c > best[u]:
            continue
        for v, L, wi in G[u]:
            if c + L < best.get(v, 1e18):
                best[v], prev[v] = c + L, (u, wi)
                heapq.heappush(pq, (c + L, v))
    if t not in prev:
        sys.exit('--from 與 --to 之間沒有相連的道路')
    line, u = [], t
    while u in prev:
        u0, wi = prev[u]
        line.append((*u, wi))
        u = u0
    line.append((*s, line[-1][2]))
    return line[::-1]


def resample(pts, step):
    L = [0.0]
    for i in range(1, len(pts)):
        L.append(L[-1] + dist(pts[i - 1], pts[i]))
    out, s, j = [], 0.0, 0
    while s < L[-1]:
        while L[j + 1] < s:
            j += 1
        t = (s - L[j]) / (L[j + 1] - L[j]) if L[j + 1] > L[j] else 0
        out.append((pts[j][0] + (pts[j + 1][0] - pts[j][0]) * t, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * t, *pts[j + 1][2:]))
        s += step
    out.append(pts[-1])
    return out


def road_width(tg):
    """路寬（m）：OSM width > lanes × 3m > 依道路等級估計（二段山路較窄、橋含人行道較寬）。"""
    try:
        return float(str(tg.get('width', '')).replace('m', ''))
    except ValueError:
        pass
    if str(tg.get('lanes', '')).isdigit():
        return int(tg['lanes']) * 3.0
    w = {'primary': 9, 'secondary': 8, 'tertiary': 7, 'unclassified': 6.5, 'residential': 6, 'service': 4}.get(tg.get('highway'), 6)
    if '二段' in tg.get('name', ''):
        w -= 1
    if tg.get('bridge') == 'yes':
        w += 1
    return w


def outer_rings(el):
    """way 或 multipolygon relation 的外框（串接 outer 成員）。"""
    if el['type'] == 'way':
        return [[(p['lat'], p['lon']) for p in el['geometry']]]
    segs = [[(p['lat'], p['lon']) for p in m['geometry']] for m in el.get('members', []) if m.get('role') == 'outer' and m.get('geometry')]
    rings = []
    while segs:
        ring = segs.pop(0)
        while ring[0] != ring[-1]:
            nxt = next((sg for sg in segs if sg[0] == ring[-1] or sg[-1] == ring[-1]), None)
            if not nxt:
                break
            segs.remove(nxt)
            ring += (nxt if nxt[0] == ring[-1] else nxt[::-1])[1:]
        rings.append(ring)
    return rings


def landmarks(pts, s, w, n, e):
    """路線旁的派出所、學校（含球場、遊戲場）、公車站牌，終點旁的公車迴轉道、步道入口、廁所與涼亭。"""
    bb = f'{s},{w},{n},{e}'
    q = (f'[out:json][timeout:120];(nwr["amenity"~"^(police|school)$"]({bb});way["leisure"~"^(pitch|playground|track)$"]({bb});'
         f'node["highway"~"^(turning_circle|turning_loop|bus_stop)$"]({bb});way["highway"~"^(path|footway|steps)$"]["name"~"步道"]({bb});'
         f'node["amenity"="toilets"]({bb});way["amenity"="shelter"]({bb});node["place"="locality"]({bb}););out geom;')
    res = cached(q, lambda: overpass(q))
    near = lambda ll: min(dist(ll, p) for p in pts[::2])
    R6 = lambda ring: [[round(a, 6), round(b, 6)] for a, b in ring]
    out, schools = [], []
    for el in res['elements']:
        tg = el.get('tags', {})
        ll = (el['lat'], el['lon']) if el['type'] == 'node' else None
        if tg.get('amenity') in ('police', 'school'):
            rings = [ll and [ll]] if ll else outer_rings(el)
            if not rings or not rings[0]:
                continue
            d = min(near(p) for p in rings[0])
            if d < (150 if tg['amenity'] == 'police' else 120):  # 學校要緊鄰路線（校門招牌立在路旁）
                out.append({'t': tg['amenity'], 'name': tg.get('name', ''), 'p': R6(rings[0])})
                if tg['amenity'] == 'school':
                    schools.append(rings[0])
        elif tg.get('highway') in ('turning_circle', 'turning_loop') and dist(ll, pts[-1]) < 60:  # 終點的迴轉道
            out.append({'t': 'turning', 'name': tg.get('name', ''), 'p': R6([ll])})
        elif tg.get('highway') == 'bus_stop' and near(ll) < 25:
            out.append({'t': 'bus', 'name': tg.get('name', ''), 'p': R6([ll])})
        elif tg.get('amenity') == 'toilets':
            if dist(ll, pts[-1]) < 60:  # 終點旁的廁所
                out.append({'t': 'toilets', 'p': R6([ll])})
        elif tg.get('amenity') == 'shelter' and el.get('geometry'):
            ring = outer_rings(el)[0]
            if min(dist(p, pts[-1]) for p in ring) < 60:  # 終點旁的涼亭；沒有名稱時用附近的地名（例如「風櫃嘴」）+「涼亭」
                place = min((x for x in res['elements'] if x.get('tags', {}).get('place') == 'locality'),
                            key=lambda x: dist((x['lat'], x['lon']), pts[-1]), default=None)
                name = tg.get('name') or (place and dist((place['lat'], place['lon']), pts[-1]) < 150 and place['tags']['name'] + '涼亭') or '涼亭'
                out.append({'t': 'shelter', 'name': name, 'p': R6(ring)})
        elif tg.get('highway') in ('path', 'footway', 'steps') and el.get('geometry'):
            g = [(p['lat'], p['lon']) for p in el['geometry']]
            if dist(g[-1], pts[-1]) < dist(g[0], pts[-1]):
                g.reverse()
            if dist(g[0], pts[-1]) > 40:  # 只要從終點出發的步道入口
                continue
            keep, L = [g[0]], 0
            for a, b in zip(g, g[1:]):
                if L > 120:
                    break
                L += dist(a, b)
                keep.append(b)
            out.append({'t': 'trail', 'name': tg['name'], 'p': R6(keep)})
    for el in res['elements']:  # 只留學校範圍內的球場、遊戲場
        tg = el.get('tags', {})
        if tg.get('leisure') and el.get('geometry'):
            ring = outer_rings(el)[0]
            c = (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))
            if any(min(r[0] for r in sc) <= c[0] <= max(r[0] for r in sc) and min(r[1] for r in sc) <= c[1] <= max(r[1] for r in sc) for sc in schools):
                out.append({'t': tg['leisure'], 'p': R6(ring)})
    print('地標：' + '、'.join(f"{x['t']}{(':' + x['name']) if x.get('name') else ''}" for x in out if x['t'] != 'bus') + f"，公車站 {sum(x['t'] == 'bus' for x in out)} 個")
    return out


def inscriptions(specs):
    """岩壁題字：OSM 不會記錄岩壁上寫的字，由參數指定位置與文字，外框取附近的 natural=cliff/rock。"""
    out = []
    for spec in specs:
        lat, lon, text = spec.split(',', 2)
        ll = (float(lat), float(lon))
        q = f'[out:json][timeout:60];way["natural"~"^(cliff|rock|bare_rock)$"](around:40,{lat},{lon});out geom;'
        rocks = [outer_rings(el)[0] for el in cached(q, lambda: overpass(q))['elements'] if el.get('geometry')]
        ring = min(rocks, key=lambda g: min(dist(p, ll) for p in g)) if rocks else [ll]
        out.append({'t': 'inscription', 'name': text, 'p': [[round(a, 6), round(b, 6)] for a, b in ring]})
        print(f'題字：{text}（{"OSM 岩壁" if rocks else "指定點"}）')
    return out


def elevations(pts, dataset):
    def fetch():
        e = []
        for i in range(0, len(pts), 100):
            loc = '|'.join(f'{a:.6f},{b:.6f}' for a, b in pts[i:i + 100])
            req = urllib.request.Request(f'https://api.opentopodata.org/v1/{dataset}', data=json.dumps({'locations': loc}).encode(),
                                         headers={**UA, 'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=60) as r:
                e += [x['elevation'] for x in json.load(r)['results']]
            time.sleep(1.1)  # 公開 API 限制每秒 1 次
        return e
    return cached(dataset + json.dumps(pts), fetch)


def smooth(v, sigma):
    k = [math.exp(-0.5 * (i / sigma) ** 2) for i in range(-3 * int(sigma), 3 * int(sigma) + 1)]
    h = len(k) // 2
    out = []
    for i in range(len(v)):
        s = w = 0
        for j, kj in enumerate(k):
            x = min(len(v) - 1, max(0, i + j - h))
            s += v[x] * kj; w += kj
        out.append(s / w)
    return out


# ---------- 內政部 20m DTM（TWD97 TM2 坐標，每行「E N H」） ----------
def tm2(lat, lon, lon0=121.0, k0=0.9999, fe=250000.0):
    a, f = 6378137.0, 1 / 298.257222101
    e2 = f * (2 - f); ep2 = e2 / (1 - e2)
    phi, lam = math.radians(lat), math.radians(lon - lon0)
    sp, cp, tp = math.sin(phi), math.cos(phi), math.tan(phi)
    N = a / math.sqrt(1 - e2 * sp * sp); T = tp * tp; C = ep2 * cp * cp; A = cp * lam
    M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * math.sin(2 * phi)
             + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * math.sin(4 * phi) - (35 * e2 ** 3 / 3072) * math.sin(6 * phi))
    x = fe + k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120)
    y = k0 * (M + N * tp * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720))
    return x, y


class Dem:
    """folders：一或多個解壓資料夾（路線跨縣市時，例如風櫃嘴東側屬新北市）；bbox：只留 TM2 範圍 (x0, y0, x1, y1) 內的點"""
    def __init__(self, folders, bbox=None):
        self.g = {}
        files = sorted(fp for f in folders for fp in Path(f).glob('*.grd'))
        if not files:
            sys.exit(f'{", ".join(map(str, folders))} 裡沒有 .grd 檔')
        x0, y0, x1, y1 = bbox or (-1e9, -1e9, 1e9, 1e9)
        for fp in files:
            for line in fp.read_text(errors='ignore').splitlines():
                v = line.split()
                if len(v) == 3:
                    x, y = float(v[0]), float(v[1])
                    if x0 <= x <= x1 and y0 <= y <= y1:
                        self.g[(round(x / 20), round(y / 20))] = float(v[2])
        print(f'DTM：{len(files)} 幅、{len(self.g)} 點')

    def at(self, lat, lon):
        x, y = tm2(lat, lon)
        i, j = math.floor(x / 20), math.floor(y / 20)
        fx, fy = x / 20 - i, y / 20 - j
        c = [self.g.get(k) for k in ((i, j), (i + 1, j), (i, j + 1), (i + 1, j + 1))]
        if None in c:
            got = [v for v in c if v is not None]
            return sum(got) / len(got) if got else None
        return (c[0] * (1 - fx) + c[1] * fx) * (1 - fy) + (c[2] * (1 - fx) + c[3] * fx) * fy


def dem_grid(dem, s, w, n, e, step=20.0):
    """在經緯度規則格網上取樣 DTM，回傳 int16（0.1m）base64；缺值以鄰近值補。"""
    dlat = step / 110574
    dlon = step / (111320 * math.cos(math.radians((s + n) / 2)))
    nx, ny = int((e - w) / dlon) + 1, int((n - s) / dlat) + 1
    h = [[dem.at(s + j * dlat, w + i * dlon) for i in range(nx)] for j in range(ny)]
    for _ in range(200):  # 由外往內補缺值
        miss = 0
        for j in range(ny):
            for i in range(nx):
                if h[j][i] is None:
                    nb = [h[y][x] for y, x in ((j - 1, i), (j + 1, i), (j, i - 1), (j, i + 1)) if 0 <= y < ny and 0 <= x < nx and h[y][x] is not None]
                    if nb:
                        h[j][i] = sum(nb) / len(nb)
                    else:
                        miss += 1
        if not miss:
            break
    flat = [round((v if v is not None else 0) * 10) for row in h for v in row]
    return {'lat0': s, 'lon0': w, 'dlat': dlat, 'dlon': dlon, 'nx': nx, 'ny': ny,
            'h': base64.b64encode(struct.pack(f'<{len(flat)}h', *flat)).decode()}


def osm_features(s, w, n, e, skip_ids):
    bb = f'{s},{w},{n},{e}'
    q = (f'[out:json][timeout:120];(way["building"]({bb});way["highway"]({bb});'
         f'way["natural"="water"]({bb});way["waterway"~"river|stream"]({bb}););out geom tags;')
    res = cached(q, lambda: overpass(q))
    P = lambda w_: [[round(p['lat'], 6), round(p['lon'], 6)] for p in w_['geometry']]
    out = {'buildings': [], 'roads': [], 'streams': []}
    for el in res['elements']:
        tg = el.get('tags', {})
        if not el.get('geometry'):
            continue
        if 'building' in tg:
            try:
                h = float(str(tg.get('height', '')).replace('m', '')) if tg.get('height') else float(tg.get('building:levels', 0)) * 3.2
            except ValueError:
                h = 0
            out['buildings'].append({'p': P(el), 'h': round(h or 7, 1)})
        elif 'highway' in tg and el['id'] not in skip_ids and tg['highway'] not in ('footway', 'path', 'steps', 'track', 'cycleway', 'bridleway', 'corridor', 'elevator', 'platform'):
            out['roads'].append({'t': tg['highway'], 'p': P(el)})
        elif tg.get('waterway') in ('river', 'stream'):
            out['streams'].append({'t': tg['waterway'], 'p': P(el)})
    print(f"OSM：房屋 {len(out['buildings'])}、道路 {len(out['roads'])}、溪流 {len(out['streams'])}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('name')
    ap.add_argument('--names', help='逗號分隔的道路名稱（預設同 name）')
    ap.add_argument('--bbox', required=True, help='south,west,north,east')
    ap.add_argument('--title')
    ap.add_argument('--out', required=True)
    ap.add_argument('--from', dest='from_', help='起點附近 lat,lon（與 --to 一起用：只取兩點間的最短路徑）')
    ap.add_argument('--to', help='終點附近 lat,lon')
    ap.add_argument('--step', type=float, default=20)
    ap.add_argument('--downhill', action='store_true')
    ap.add_argument('--dem', help='內政部 20m DTM 解壓資料夾（.grd），跨縣市時以逗號分隔多個')
    ap.add_argument('--scene', help='輸出實景場景 JSON（需 --dem）')
    ap.add_argument('--margin', type=float, default=1200, help='場景地形外擴（m）')
    ap.add_argument('--inscription', action='append', default=[], metavar='LAT,LON,文字',
                    help='岩壁題字：取該點附近 OSM 的岩壁（natural=cliff/rock）外框，沒有就用該點（例如風櫃嘴前的「佛」字）')
    ap.add_argument('--skip', default='', help='不要的地標名稱，逗號分隔（OSM 有標、但實際不在路旁的，例如風櫃嘴的溪山派出所）')
    ap.add_argument('--open', action='append', default=[], metavar='S0-S1:L|R',
                    help='路旁視野開闊、不種樹的路段（距起點公尺，L 左側 / R 右側；S1 省略表示到終點）')
    a = ap.parse_args()

    names = (a.names or a.name).split(',')
    bb = a.bbox
    q = '[out:json][timeout:90];(' + ''.join(f'way["highway"]["name"="{n}"]({bb});' for n in names) + ');out geom tags;'
    res = cached(q, lambda: overpass(q))
    els = [w for w in res['elements'] if w.get('geometry')]
    if not els:
        sys.exit('找不到道路')
    meta = [w.get('tags', {}) for w in els]
    lines = [[(p['lat'], p['lon'], wi) for p in w['geometry']] for wi, w in enumerate(els)]
    if a.from_ and a.to:
        ll = lambda v: tuple(map(float, v.split(',')))
        pts = resample(shortest(lines, ll(a.from_), ll(a.to)), a.step)
    else:
        pts = resample(chain(lines), a.step)
    owner = [p[2] for p in pts]
    pts = [(p[0], p[1]) for p in pts]
    dem = None
    if a.dem:
        xy = [tm2(lat, lon) for lat, lon in pts]
        m = a.margin + 200
        dem = Dem([ROOT / f for f in a.dem.split(',')], (min(p[0] for p in xy) - m, min(p[1] for p in xy) - m, max(p[0] for p in xy) + m, max(p[1] for p in xy) + m))
    if dem:
        raw = [dem.at(lat, lon) for lat, lon in pts]
        if None in raw:
            sys.exit('DTM 未涵蓋整條路線')
        # 橋面：不跟著溪谷往下，改用兩端橋頭的高度拉直線
        i = 0
        while i < len(pts):
            if meta[owner[i]].get('bridge') == 'yes':
                j = i
                while j + 1 < len(pts) and meta[owner[j + 1]].get('bridge') == 'yes':
                    j += 1
                a0, b0 = max(0, i - 1), min(len(pts) - 1, j + 1)
                for k in range(i, j + 1):
                    raw[k] = raw[a0] + (raw[b0] - raw[a0]) * (k - a0) / max(1, b0 - a0)
                i = j + 1
            else:
                i += 1
        ele = smooth(raw, sigma=30 / a.step)
        src = 'MOI Taiwan 20m DTM'
    else:
        e1, e2 = elevations(pts, 'srtm30m'), elevations(pts, 'aster30m')
        ele = smooth([(x + y) / 2 for x, y in zip(e1, e2)], sigma=60 / a.step)
        src = 'SRTM / ASTER GDEM via OpenTopoData'
    if (ele[-1] < ele[0]) != a.downhill:
        pts.reverse(); ele.reverse(); owner.reverse()

    total = sum(dist(pts[i - 1], pts[i]) for i in range(1, len(pts)))
    gain = sum(max(0, ele[i] - ele[i - 1]) for i in range(1, len(ele)))
    title = a.title or a.name
    out = ROOT / a.out
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n')
        f.write('<gpx version="1.1" creator="hud-iron-virtual-cycling" xmlns="http://www.topografix.com/GPX/1/1">\n')
        f.write(f'  <metadata><name>{title}</name>'
                '<copyright author="OpenStreetMap contributors"><license>https://opendatacommons.org/licenses/odbl/1-0/</license></copyright>'
                f'<desc>Route © OpenStreetMap contributors (ODbL); elevation from {src}</desc></metadata>\n')
        f.write(f'  <trk><name>{title}</name><trkseg>\n')
        for (lat, lon), h in zip(pts, ele):
            f.write(f'    <trkpt lat="{lat:.6f}" lon="{lon:.6f}"><ele>{h:.1f}</ele></trkpt>\n')
        f.write('  </trkseg></trk>\n</gpx>\n')
    print(f'{title}：{total / 1000:.2f} km，爬升 {gain:.0f} m，{ele[0]:.0f} → {ele[-1]:.0f} m，平均 {(ele[-1] - ele[0]) / total * 100:.1f}%')
    print(f'已寫入 {a.out}')

    if a.scene:
        if not dem:
            sys.exit('--scene 需要 --dem')
        lats, lons = [p[0] for p in pts], [p[1] for p in pts]
        mlat = a.margin / 110574
        mlon = a.margin / (111320 * math.cos(math.radians(lats[0])))
        s, n, w, e = min(lats) - mlat, max(lats) + mlat, min(lons) - mlon, max(lons) + mlon
        scene = {'dem': dem_grid(dem, s, w, n, e)}
        k = 500 / a.margin  # 房屋、道路只取路線外 500m 內
        # 側路不重畫路線本身：整條都在路線上的 way 略過（同名道路的支線、只走一部分的 way 仍畫出來，靠近路線處由前端截斷）
        def on_route(w_):
            return all(min(dist((p['lat'], p['lon']), q) for q in pts) < 12 for p in w_['geometry'])
        skip = {w_['id'] for w_ in els if on_route(w_)}
        scene.update(osm_features(min(lats) - mlat * k, min(lons) - mlon * k, max(lats) + mlat * k, max(lons) + mlon * k, skip))
        cum = [0.0]
        for i in range(1, len(pts)):
            cum.append(cum[-1] + dist(pts[i - 1], pts[i]))
        bridges, i = [], 0
        while i < len(pts):
            if meta[owner[i]].get('bridge') == 'yes':
                j = i
                while j + 1 < len(pts) and owner[j + 1] == owner[i]:
                    j += 1
                bridges.append([round(cum[max(0, i - 1)], 1), round(cum[j], 1), meta[owner[i]].get('name', '')])
                i = j + 1
            else:
                i += 1
        scene['route'] = {'s': [round(x, 1) for x in cum], 'w': [road_width(meta[o]) for o in owner], 'bridges': bridges}
        scene['landmarks'] = landmarks(pts, min(lats) - mlat * 0.25, min(lons) - mlon * 0.25, max(lats) + mlat * 0.25, max(lons) + mlon * 0.25)
        scene['landmarks'] += inscriptions(a.inscription)
        skip = set(filter(None, a.skip.split(',')))
        scene['landmarks'] = [l for l in scene['landmarks'] if l.get('name') not in skip]
        for o in a.open:  # 例如 5200-:L
            rng, side = o.split(':')
            s0, s1 = rng.split('-')
            scene['route'].setdefault('open', []).append([float(s0), float(s1) if s1 else round(total, 1), side.upper()])
        print('橋：' + '、'.join(f'{b[2]}（{b[0]:.0f}–{b[1]:.0f} m）' for b in bridges) + '；路寬 ' + '、'.join(sorted({f'{w:g}' for w in scene['route']['w']})) + ' m')
        scene['credits'] = ['© OpenStreetMap contributors (ODbL)', '地形：內政部 20m DTM（政府資料開放授權條款第 1 版）']
        sp = ROOT / a.scene
        sp.write_text(json.dumps(scene, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        print(f'已寫入 {a.scene}（{sp.stat().st_size / 1024:.0f} KB，地形 {scene["dem"]["nx"]}×{scene["dem"]["ny"]}）')


if __name__ == '__main__':
    main()
