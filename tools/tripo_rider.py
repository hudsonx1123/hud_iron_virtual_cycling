#!/usr/bin/env python3
"""用 Tripo API（v3）從照片生成騎士 3D 模型並自動加骨架。

用法：
  python3 tools/tripo_rider.py 正面照.jpg
  python3 tools/tripo_rider.py --check      # 只驗證金鑰並顯示點數餘額（免費）

- API 金鑰（tsk_ 開頭）讀取順序：環境變數 TRIPO_API_KEY → 專案根目錄 .env 的 TRIPO_API_KEY
  （也接受先前誤放在 MESHY_API_KEY 的 Tripo 金鑰）。
- 任務 ID 記在 assets/models/rider/tasks.json，中斷後重跑會接續，不會重複扣點數。
- 產出：assets/models/rider/rider.glb（未綁骨架）、rider_rigged.glb（已綁骨架）、preview.*（預覽圖）。
- 端點與欄位依官方 SDK：github.com/Tripo-Developer/tripo-python-sdk
"""
import json, mimetypes, os, sys, time, urllib.error, urllib.request, uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'models' / 'rider'
TASKS = OUT / 'tasks.json'
API = 'https://openapi.tripo3d.ai'
GEN_MODEL = 'v3.0-20250812'
RIG_MODEL = 'v2.5-20260210'
UA = 'hud-iron-virtual-cycling/1.0'


def api_key():
    key = os.environ.get('TRIPO_API_KEY')
    env = ROOT / '.env'
    if not key and env.exists():
        vals = {}
        for line in env.read_text().splitlines():
            if '=' in line and not line.strip().startswith('#'):
                k, v = line.split('=', 1)
                vals[k.strip()] = v.strip().strip('"\'')
        key = vals.get('TRIPO_API_KEY') or vals.get('MESHY_API_KEY')
    if not key:
        sys.exit('找不到 TRIPO_API_KEY（請在專案根目錄 .env 寫入 TRIPO_API_KEY=tsk_...）')
    if not key.startswith('tsk_'):
        sys.exit('金鑰格式不對：Tripo API 金鑰應以 tsk_ 開頭')
    return key


def _open(req):
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            payload = json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors='replace')[:600]
        hint = {401: '金鑰無效', 402: '點數不足', 403: '沒有權限（方案不支援此功能？）', 429: '請求太頻繁，稍後再試'}.get(e.code, '')
        sys.exit(f'Tripo API 錯誤 HTTP {e.code} {hint}\n{body}')
    code = payload.get('code')
    if (code is not None and code != 0) or payload.get('status') == 'error':
        sys.exit(f'Tripo API 錯誤 code={code}：{payload.get("message")}\n建議：{payload.get("suggestion")}')
    return payload.get('data', payload)


def headers(extra=None):
    h = {'Authorization': f'Bearer {api_key()}', 'Accept': 'application/json', 'User-Agent': UA, 'X-Tripo-Trace-ID': str(uuid.uuid4())}
    h.update(extra or {})
    return h


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    return _open(urllib.request.Request(API + path, method=method, data=data,
                                        headers=headers({'Content-Type': 'application/json'} if data else None)))


def upload(path):
    boundary = uuid.uuid4().hex
    mime = mimetypes.guess_type(str(path))[0] or 'image/jpeg'
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{Path(path).name}"\r\n'
            f'Content-Type: {mime}\r\n\r\n').encode() + Path(path).read_bytes() + f'\r\n--{boundary}--\r\n'.encode()
    d = _open(urllib.request.Request(API + '/v3/files', method='POST', data=body,
                                     headers=headers({'Content-Type': f'multipart/form-data; boundary={boundary}'})))
    return d['file_token']


def submit(path, payload):
    return call('POST', path, payload)['task_id']


def wait(task_id, label):
    last = None
    while True:
        t = call('GET', f'/v3/tasks/{task_id}')
        st, pr = t.get('status'), t.get('progress')
        if (st, pr) != last:
            print(f'  {label} {st} {pr}%', flush=True)
            last = (st, pr)
        if st == 'success':
            return t
        if st in ('failed', 'cancelled', 'banned', 'expired', 'unknown'):
            sys.exit(f'{label} 任務失敗（{st}）：{t.get("error_msg") or t.get("error_code")}')
        time.sleep(6)


def output_url(t, *keys):
    out = t.get('output') or {}
    for k in keys:
        if out.get(k):
            return out[k]
    return None


def download(url, dest):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=300) as r:
        dest.write_bytes(r.read())
    print(f'  已下載 {dest.relative_to(ROOT)}（{dest.stat().st_size / 1e6:.1f} MB）')


def check_key():
    b = call('GET', '/v3/account/balance')
    print(f'金鑰有效，點數餘額 {b.get("balance")}（凍結中 {b.get("frozen")}）')


def main():
    args = sys.argv[1:]
    if args == ['--check']:
        return check_key()
    if len(args) != 1 or not Path(args[0]).exists():
        sys.exit(__doc__)
    check_key()
    OUT.mkdir(parents=True, exist_ok=True)
    tasks = json.loads(TASKS.read_text()) if TASKS.exists() else {}
    save = lambda: TASKS.write_text(json.dumps(tasks, indent=2))

    # 1. 照片 → 3D（PBR 貼圖、約 3 萬面，網頁即時渲染負擔合理）
    if 'model' not in tasks:
        print('上傳照片…')
        token = upload(args[0])
        print('建立 image-to-model 任務…')
        tasks['model'] = submit('/v3/generation/image-to-model', {
            'input': token, 'model': GEN_MODEL, 'texture': True, 'pbr': True,
            'face_limit': 30000, 'texture_quality': 'detailed',
        })
        save()
    t = wait(tasks['model'], '建模')
    if not (OUT / 'rider.glb').exists():
        download(output_url(t, 'model_url', 'pbr_model_url', 'pbr_model', 'model'), OUT / 'rider.glb')
    prev = output_url(t, 'rendered_image_url', 'rendered_image')
    if prev and not list(OUT.glob('preview.*')):
        download(prev, OUT / ('preview' + (Path(prev.split('?')[0]).suffix or '.webp')))

    # 2. 檢查可否綁骨架
    if 'check' not in tasks:
        print('檢查模型能否綁骨架…')
        tasks['check'] = submit('/v3/animations/rig-check', {'input': tasks['model']})
        save()
    c = wait(tasks['check'], '骨架檢查')
    out = c.get('output') or {}
    print(f'  riggable={out.get("riggable")} 骨架類型={out.get("rig_type") or out.get("topology")}')
    if out.get('riggable') is False:
        sys.exit('Tripo 判斷這個模型無法自動綁骨架，已保留未綁骨架的 rider.glb')

    # 3. 綁骨架（人形 biped）
    if 'rig' not in tasks:
        print('建立 rig 任務…')
        tasks['rig'] = submit('/v3/animations/rig', {
            'input': tasks['model'], 'model': RIG_MODEL, 'rig_type': 'biped', 'out_format': 'glb',
        })
        save()
    r = wait(tasks['rig'], '綁骨架')
    download(output_url(r, 'model_url', 'model'), OUT / 'rider_rigged.glb')
    print('完成。')


if __name__ == '__main__':
    main()
