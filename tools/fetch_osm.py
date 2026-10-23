#!/usr/bin/env python3
"""從 OpenStreetMap（Overpass API）抓取圓山交流道一帶的地圖資料，轉成場景用的精簡 JSON。

用法：python3 tools/fetch_osm.py   （需 OpenSSL 版 Python，例如 Homebrew 的 /opt/homebrew/bin/python3）
產出：assets/osm/yuanshan.json（座標已投影為以中心點為原點的公尺座標：x 向東、z 向南）

地圖資料 © OpenStreetMap contributors，ODbL 授權。
"""
import json, math, sys, time, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'osm' / 'yuanshan.json'
S, W, N, E = 25.056, 121.506, 25.092, 121.544
LAT0, LON0 = (S + N) / 2, (W + E) / 2
KX = 111320 * math.cos(math.radians(LAT0))
KZ = 110574
ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']


def proj(lat, lon):
    return [round((lon - LON0) * KX, 2), round(-(lat - LAT0) * KZ, 2)]


CACHE = ROOT / '.cache' / 'osm'


def overpass(q):
    import hashlib
    CACHE.mkdir(parents=True, exist_ok=True)
    cf = CACHE / (hashlib.sha1(q.encode()).hexdigest()[:16] + '.json')
    if cf.exists():
        return json.loads(cf.read_text())
    res = _overpass(q)
    cf.write_text(json.dumps(res))
    return res


def _overpass(q):
    data = urllib.parse.urlencode({'data': q}).encode()
    for url in ENDPOINTS:
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, data=data, headers={'User-Agent': 'hud-iron-virtual-cycling/1.0'})
                with urllib.request.urlopen(req, timeout=180) as r:
                    return json.load(r)
            except Exception as e:  # noqa: BLE001
                print(f'  {url} 第 {attempt + 1} 次失敗：{e}', file=sys.stderr)
                time.sleep(5 * (attempt + 1))
    sys.exit('Overpass 皆無法連線')


def num(v, default=None):
    try:
        return float(str(v).split(';')[0].replace('m', '').strip())
    except (TypeError, ValueError):
        return default


ROAD_W = {'motorway': 3.6, 'trunk': 3.5, 'primary': 3.4, 'secondary': 3.2, 'tertiary': 3.0,
          'motorway_link': 4.2, 'trunk_link': 4.0, 'primary_link': 3.8, 'secondary_link': 3.6,
          'residential': 3.0, 'unclassified': 3.0, 'service': 2.8, 'living_street': 2.8}
DEFAULT_LANES = {'motorway': 3, 'trunk': 2, 'primary': 2, 'secondary': 2, 'tertiary': 2}


def main():
    bbox = f'({S},{W},{N},{E})'
    print('抓取道路…')
    rd = overpass(f'[out:json][timeout:120];way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|residential|unclassified|living_street)$"]{bbox};out body;>;out skel qt;')
    print('抓取建築、水域、綠地、鐵道…')
    ar = overpass(f'''[out:json][timeout:180];(
      way["building"]{bbox};
      way["natural"="water"]{bbox}; relation["natural"="water"]{bbox};
      way["waterway"="riverbank"]{bbox}; relation["waterway"="riverbank"]{bbox};
      way["leisure"~"park|garden|pitch|golf_course"]{bbox}; way["landuse"~"grass|forest|recreation_ground|meadow"]{bbox};
      way["natural"="wood"]{bbox}; relation["natural"="wood"]{bbox}; relation["landuse"="forest"]{bbox};
      way["railway"~"subway|light_rail|rail"]{bbox};
      node["tourism"="hotel"]["name"~"圓山"]{bbox};
    );out geom;''')

    nodes = {e['id']: proj(e['lat'], e['lon']) for e in rd['elements'] if e['type'] == 'node'}
    used, roads = set(), []
    for e in rd['elements']:
        if e['type'] != 'way':
            continue
        t = e.get('tags', {})
        hw = t['highway']
        oneway = t.get('oneway') in ('yes', '1', '-1') or hw in ('motorway', 'motorway_link')
        lanes = num(t.get('lanes'), None)
        if lanes is None:
            lanes = DEFAULT_LANES.get(hw, 1 if hw.endswith('_link') else 2)
            if not oneway and hw in DEFAULT_LANES:
                lanes *= 2
        ids = e['nodes'][::-1] if t.get('oneway') == '-1' else e['nodes']
        bridge = t.get('bridge') not in (None, 'no')
        layer = int(num(t.get('layer'), 1 if bridge else 0))
        tunnel = t.get('tunnel') not in (None, 'no')
        roads.append({'t': hw, 'n': t.get('name', ''), 'ref': t.get('ref', ''), 'w': round(lanes * ROAD_W.get(hw, 3.0), 1),
                      'ow': 1 if oneway else 0, 'br': 1 if bridge else 0, 'tn': 1 if tunnel else 0, 'l': layer, 'nd': ids})
        used.update(ids)
    nodes = {str(k): v for k, v in nodes.items() if k in used}

    def ring(geom):
        return [proj(p['lat'], p['lon']) for p in geom if p]

    def assemble(segs):
        # 把關係（relation）的成員線段依端點接成封閉環
        segs = [s[:] for s in segs if len(s) > 1]
        rings = []
        while segs:
            cur = segs.pop(0)
            changed = True
            while cur[0] != cur[-1] and changed:
                changed = False
                for i, s in enumerate(segs):
                    if s[0] == cur[-1]: cur += s[1:]
                    elif s[-1] == cur[-1]: cur += s[::-1][1:]
                    elif s[-1] == cur[0]: cur = s[:-1] + cur
                    elif s[0] == cur[0]: cur = s[::-1][:-1] + cur
                    else: continue
                    segs.pop(i); changed = True; break
            if len(cur) > 3:
                rings.append(cur)
        return rings

    buildings, water, green, wood, rail, poi = [], [], [], [], [], []
    for e in ar['elements']:
        t = e.get('tags', {})
        if e['type'] == 'node':
            poi.append({'n': t.get('name', ''), 'p': proj(e['lat'], e['lon'])})
            continue
        if e['type'] == 'relation':
            outers = assemble([ring(m['geometry']) for m in e.get('members', []) if m.get('role') == 'outer' and m.get('geometry')])
            inners = assemble([ring(m['geometry']) for m in e.get('members', []) if m.get('role') == 'inner' and m.get('geometry')])
            polys = [{'o': o, 'i': inners} for o in outers if len(o) > 2]
        else:
            g = ring(e.get('geometry', []))
            polys = [{'o': g, 'i': []}] if len(g) > 2 else []
        if 'building' in t:
            if not polys:
                continue
            lv = num(t.get('building:levels'))
            h = num(t.get('height')) or (lv * 3.3 if lv else None)
            mn = num(t.get('min_height')) or ((num(t.get('building:min_level')) or 0) * 3.3)
            buildings.append({'o': polys[0]['o'], 'h': round(h, 1) if h else None, 'mh': round(mn, 1),
                              'n': t.get('name', ''), 'k': t.get('building')})
        elif t.get('natural') == 'water' or t.get('waterway') == 'riverbank':
            water += polys
        elif t.get('natural') == 'wood' or t.get('landuse') == 'forest':
            wood += polys
        elif 'railway' in t:
            g = ring(e.get('geometry', []))
            bridge = t.get('bridge') not in (None, 'no')
            rail.append({'pts': g, 'br': 1 if bridge else 0, 'tn': 1 if t.get('tunnel') not in (None, 'no') else 0,
                         'l': int(num(t.get('layer'), 1 if bridge else 0)), 't': t['railway']})
        else:
            green += polys

    OUT.parent.mkdir(parents=True, exist_ok=True)
    data = {'center': [LAT0, LON0], 'bbox': [S, W, N, E], 'attribution': '© OpenStreetMap contributors (ODbL)',
            'nodes': nodes, 'roads': roads, 'buildings': buildings, 'water': water, 'green': green, 'wood': wood,
            'rail': rail, 'poi': poi}
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
    print(f'道路 {len(roads)}、建築 {len(buildings)}、水域 {len(water)}、綠地 {len(green)}、樹林 {len(wood)}、鐵道 {len(rail)}、POI {len(poi)}')
    print(f'已寫入 {OUT.relative_to(ROOT)}（{OUT.stat().st_size / 1e6:.1f} MB）')


if __name__ == '__main__':
    main()
