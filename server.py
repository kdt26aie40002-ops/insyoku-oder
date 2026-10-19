"""飲食店テーブルオーダーシステムの HTTP サーバー（Python 標準ライブラリのみで動作）。

    python server.py            # http://localhost:8000
    python server.py --reset    # データベースを初期データで作り直す
"""

import argparse
import json
import queue
import socket
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import api
import db

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DEFAULT_DB = BASE_DIR / "data" / "insyoku.db"
MAX_BODY_BYTES = 64 * 1024
SSE_KEEPALIVE_SECONDS = 15

PAGE_ALIASES = {
    "/": "index.html",
    "/table": "table.html",
    "/kitchen": "kitchen.html",
    "/staff": "staff.html",
}
# Windows ではレジストリ次第で mimetypes が .js を text/plain にすることがあるため固定で持つ
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class EventBus:
    """SSE 購読者ごとのキューへイベントを配る。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._subscribers = set()

    def subscribe(self):
        q = queue.Queue(maxsize=200)
        with self._lock:
            self._subscribers.add(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            self._subscribers.discard(q)

    def publish(self, event):
        message = f"data: {json.dumps(event, ensure_ascii=False)}\n\n".encode("utf-8")
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            try:
                q.put_nowait(message)
            except queue.Full:
                pass  # 詰まった端末は再接続時に全件再取得するので捨ててよい


class OrderServer(ThreadingHTTPServer):
    daemon_threads = True
    log_requests = True

    def __init__(self, address, db_path):
        self.db_path = Path(db_path)
        self.bus = EventBus()
        self.closing = threading.Event()
        super().__init__(address, RequestHandler)

    def server_close(self):
        self.closing.set()
        super().server_close()


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "InsyokuOrder/0.1"

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def _dispatch(self, method):
        path = urlparse(self.path).path
        try:
            if path == "/api/events":
                if method != "GET":
                    raise api.ApiError(405, "許可されていないメソッドです")
                self._stream_events()
            elif path.startswith("/api/"):
                self._handle_api(method, path)
            elif method == "GET":
                self._serve_static(path)
            else:
                raise api.ApiError(405, "許可されていないメソッドです")
        except api.ApiError as e:
            self._send_json(e.status, {"error": e.message})

    def _handle_api(self, method, path):
        handler, params = api.resolve(method, path)
        body = self._read_json() if method in ("POST", "PATCH") else None
        conn = db.connect(self.server.db_path)
        try:
            ctx = api.Context(conn, params, body)
            try:
                with conn:  # 正常終了でコミット、例外でロールバック
                    result = handler(ctx)
            except sqlite3.IntegrityError as e:
                raise api.ApiError(409, "他の端末の操作と競合しました。もう一度お試しください") from e
        finally:
            conn.close()
        # コミット後に配信するので、受け取った端末が再取得すると必ず新しい状態が見える
        for event in ctx.events:
            self.server.bus.publish(event)
        self._send_json(200, result)

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise api.ApiError(400, "Content-Length が不正です")
        if length > MAX_BODY_BYTES:
            raise api.ApiError(413, "リクエストが大きすぎます")
        if length == 0:
            return {}
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise api.ApiError(400, "JSON の形式が正しくありません")
        if not isinstance(data, dict):
            raise api.ApiError(400, "JSON オブジェクトを送信してください")
        return data

    def _send_json(self, status, obj):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _serve_static(self, path):
        name = PAGE_ALIASES.get(path, path.lstrip("/"))
        file = (STATIC_DIR / name).resolve()
        if not file.is_relative_to(STATIC_DIR) or not file.is_file():
            raise api.ApiError(404, "ページが見つかりません")
        payload = file.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(file.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(payload)

    def _stream_events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        q = self.server.bus.subscribe()
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while not self.server.closing.is_set():
                try:
                    message = q.get(timeout=SSE_KEEPALIVE_SECONDS)
                except queue.Empty:
                    message = b": ping\n\n"
                self.wfile.write(message)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            self.server.bus.unsubscribe(q)
            self.close_connection = True

    def log_message(self, format, *args):
        if self.server.log_requests and self.path != "/api/events":
            super().log_message(format, *args)


def _lan_address():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 80))  # パケットは送られない。経路選択に使われる自 IP を得るだけ
            return s.getsockname()[0]
    except OSError:
        return None


def main(argv=None):
    parser = argparse.ArgumentParser(description="テーブルオーダーシステムのサーバー")
    parser.add_argument("--host", default="0.0.0.0", help="待ち受けアドレス（既定: 0.0.0.0）")
    parser.add_argument("--port", type=int, default=8000, help="ポート番号（既定: 8000）")
    parser.add_argument("--db", default=str(DEFAULT_DB), help="SQLite ファイルのパス")
    parser.add_argument("--reset", action="store_true", help="データベースを削除して初期データで作り直す")
    args = parser.parse_args(argv)

    db_path = Path(args.db)
    if args.reset:
        for suffix in ("", "-wal", "-shm"):
            Path(f"{db_path}{suffix}").unlink(missing_ok=True)
    db.init_db(db_path)

    server = OrderServer((args.host, args.port), db_path)
    port = server.server_address[1]
    print(f"テーブルオーダーシステムを起動しました: http://localhost:{port}/")
    lan = _lan_address()
    if lan and args.host in ("0.0.0.0", ""):
        print(f"  同じネットワークのタブレットからは http://{lan}:{port}/ を開いてください")
    print("  終了するには Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
