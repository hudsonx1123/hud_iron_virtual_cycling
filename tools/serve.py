#!/usr/bin/env python3
"""本機開發伺服器：與 python3 -m http.server 相同，但要求瀏覽器不要快取，
修改程式後重新整理就一定會載入最新版本。

用法：python3 tools/serve.py [port]   （預設 8000，在專案根目錄提供檔案）
"""
import functools, http.server, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(('', port), handler) as httpd:
        print(f'http://localhost:{port}')
        httpd.serve_forever()
