"""注文システムの業務ロジックと API ルーティング。

各ハンドラは Context を受け取り、JSON 化できる値を返す。
エラーは ApiError を送出する（server.py が HTTP レスポンスに変換する）。
状態を変更したハンドラは ctx.emit() でイベントを積み、server.py がコミット後に
SSE で全端末へ配信する。端末はイベントを受けて API を再取得する。
"""

import re
from datetime import datetime

ITEM_STATUSES = ("pending", "cooking", "served", "cancelled")
ITEM_STATUS_LABELS = {"pending": "受付済", "cooking": "調理中", "served": "提供済", "cancelled": "取消"}
# 注文明細の状態遷移（served → cooking は誤操作の取り消し用）
STATUS_TRANSITIONS = {
    "pending": {"cooking", "cancelled"},
    "cooking": {"served", "pending", "cancelled"},
    "served": {"cooking"},
    "cancelled": set(),
}
CALL_KINDS = ("staff", "water")  # 'checkout' は request_checkout 経由でのみ作られる
MAX_GUESTS = 20
MAX_QTY_PER_ITEM = 20
MAX_LINES_PER_ORDER = 50


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Context:
    def __init__(self, conn, params, body):
        self.conn = conn
        self.params = params
        self.body = body if body is not None else {}
        self.events = []

    def emit(self, event_type, **data):
        self.events.append({"type": event_type, **data})


def now():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _int_value(value, name, minimum, maximum=None):
    # bool は int のサブクラスなので明示的に弾く
    if isinstance(value, bool) or not isinstance(value, int):
        raise ApiError(400, f"{name} は整数で指定してください")
    if value < minimum or (maximum is not None and value > maximum):
        upper = f"{maximum} 以下" if maximum is not None else ""
        raise ApiError(400, f"{name} は {minimum} 以上{upper}で指定してください")
    return value


# ---------------------------------------------------------------- メニュー

def _menu_item(row):
    return {
        "id": row["id"],
        "category_id": row["category_id"],
        "name": row["name"],
        "description": row["description"],
        "price": row["price"],
        "icon": row["icon"],
        "sold_out": bool(row["sold_out"]),
    }


def get_menu(ctx):
    conn = ctx.conn
    categories = [
        {"id": r["id"], "name": r["name"], "items": []}
        for r in conn.execute("SELECT id, name FROM categories ORDER BY sort, id")
    ]
    by_id = {c["id"]: c for c in categories}
    for r in conn.execute("SELECT * FROM menu_items ORDER BY sort, id"):
        by_id[r["category_id"]]["items"].append(_menu_item(r))
    return {"categories": categories}


def update_menu_item(ctx):
    item_id = int(ctx.params["item_id"])
    sold_out = ctx.body.get("sold_out")
    if not isinstance(sold_out, bool):
        raise ApiError(400, "sold_out は true / false で指定してください")
    cur = ctx.conn.execute("UPDATE menu_items SET sold_out = ? WHERE id = ?", (int(sold_out), item_id))
    if cur.rowcount == 0:
        raise ApiError(404, "商品が見つかりません")
    ctx.emit("menu")
    return _menu_item(ctx.conn.execute("SELECT * FROM menu_items WHERE id = ?", (item_id,)).fetchone())


# ---------------------------------------------------------------- テーブル

def _table_row(conn, table_id):
    row = conn.execute("SELECT id, name FROM tables WHERE id = ?", (table_id,)).fetchone()
    if row is None:
        raise ApiError(404, "テーブルが見つかりません")
    return row


def _open_session(conn, table_id):
    return conn.execute(
        "SELECT * FROM sessions WHERE table_id = ? AND closed_at IS NULL", (table_id,)
    ).fetchone()


def _require_open_session(conn, table_id):
    session = _open_session(conn, table_id)
    if session is None:
        raise ApiError(409, "このテーブルはご利用開始前です")
    return session


def _order_item(row):
    return {
        "id": row["id"],
        "menu_item_id": row["menu_item_id"],
        "name": row["name"],
        "unit_price": row["unit_price"],
        "quantity": row["quantity"],
        "status": row["status"],
        "subtotal": row["unit_price"] * row["quantity"],
    }


def _session_orders(conn, session_id):
    orders = [
        {"id": r["id"], "created_at": r["created_at"], "items": []}
        for r in conn.execute(
            "SELECT id, created_at FROM orders WHERE session_id = ? ORDER BY id", (session_id,)
        )
    ]
    by_id = {o["id"]: o for o in orders}
    for r in conn.execute(
        """SELECT oi.* FROM order_items oi JOIN orders o ON o.id = oi.order_id
           WHERE o.session_id = ? ORDER BY oi.id""",
        (session_id,),
    ):
        by_id[r["order_id"]]["items"].append(_order_item(r))
    return orders


def _total(orders):
    return sum(i["subtotal"] for o in orders for i in o["items"] if i["status"] != "cancelled")


def _open_calls(conn, table_id=None):
    sql = """SELECT c.id, c.table_id, t.name AS table_name, c.kind, c.created_at
             FROM calls c JOIN tables t ON t.id = c.table_id
             WHERE c.resolved_at IS NULL"""
    args = ()
    if table_id is not None:
        sql += " AND c.table_id = ?"
        args = (table_id,)
    return [dict(r) for r in conn.execute(sql + " ORDER BY c.id", args)]


def _table_view(conn, row):
    session = _open_session(conn, row["id"])
    orders = _session_orders(conn, session["id"]) if session else []
    if session is None:
        status = "vacant"
    elif session["checkout_requested_at"]:
        status = "checkout"
    else:
        status = "occupied"
    return {
        "id": row["id"],
        "name": row["name"],
        "status": status,
        "session": None if session is None else {
            "id": session["id"],
            "guests": session["guests"],
            "started_at": session["started_at"],
            "checkout_requested_at": session["checkout_requested_at"],
        },
        "orders": orders,
        "total": _total(orders),
        "calls": _open_calls(conn, row["id"]),
    }


def list_tables(ctx):
    rows = ctx.conn.execute("SELECT id, name FROM tables ORDER BY id").fetchall()
    return {"tables": [_table_view(ctx.conn, r) for r in rows]}


def get_table(ctx):
    return _table_view(ctx.conn, _table_row(ctx.conn, int(ctx.params["table_id"])))


def start_session(ctx):
    conn = ctx.conn
    table = _table_row(conn, int(ctx.params["table_id"]))
    guests = _int_value(ctx.body.get("guests"), "guests", 1, MAX_GUESTS)
    if _open_session(conn, table["id"]) is not None:
        raise ApiError(409, "このテーブルはすでに利用中です")
    conn.execute(
        "INSERT INTO sessions (table_id, guests, started_at) VALUES (?, ?, ?)",
        (table["id"], guests, now()),
    )
    ctx.emit("table", table_id=table["id"])
    return _table_view(conn, table)


def place_order(ctx):
    conn = ctx.conn
    table = _table_row(conn, int(ctx.params["table_id"]))
    lines = ctx.body.get("items")
    if not isinstance(lines, list) or not lines:
        raise ApiError(400, "注文する商品がありません")
    if len(lines) > MAX_LINES_PER_ORDER:
        raise ApiError(400, "一度に注文できる品目数を超えています")

    session = _require_open_session(conn, table["id"])
    if session["checkout_requested_at"]:
        raise ApiError(409, "お会計手続き中のため注文できません")

    # 同じ商品が複数行あればまとめる
    quantities = {}
    for line in lines:
        if not isinstance(line, dict):
            raise ApiError(400, "注文内容の形式が正しくありません")
        item_id = _int_value(line.get("menu_item_id"), "menu_item_id", 1)
        qty = _int_value(line.get("quantity"), "quantity", 1, MAX_QTY_PER_ITEM)
        quantities[item_id] = quantities.get(item_id, 0) + qty
        if quantities[item_id] > MAX_QTY_PER_ITEM:
            raise ApiError(400, f"1 品目あたりの数量は {MAX_QTY_PER_ITEM} までです")

    menu_rows = []
    for item_id in quantities:
        row = conn.execute("SELECT * FROM menu_items WHERE id = ?", (item_id,)).fetchone()
        if row is None:
            raise ApiError(400, "存在しない商品が含まれています")
        if row["sold_out"]:
            raise ApiError(409, f"「{row['name']}」は売り切れです")
        menu_rows.append(row)

    order_id = conn.execute(
        "INSERT INTO orders (session_id, created_at) VALUES (?, ?)", (session["id"], now())
    ).lastrowid
    conn.executemany(
        "INSERT INTO order_items (order_id, menu_item_id, name, unit_price, quantity)"
        " VALUES (?, ?, ?, ?, ?)",
        [(order_id, r["id"], r["name"], r["price"], quantities[r["id"]]) for r in menu_rows],
    )
    ctx.emit("table", table_id=table["id"])
    ctx.emit("kitchen")
    view = _table_view(conn, table)
    order = next(o for o in view["orders"] if o["id"] == order_id)
    return {"order": order, "table": view}


def create_call(ctx):
    conn = ctx.conn
    table = _table_row(conn, int(ctx.params["table_id"]))
    kind = ctx.body.get("kind")
    if kind not in CALL_KINDS:
        raise ApiError(400, "呼び出しの種類が正しくありません")
    existing = conn.execute(
        "SELECT id FROM calls WHERE table_id = ? AND kind = ? AND resolved_at IS NULL",
        (table["id"], kind),
    ).fetchone()
    if existing is None:
        conn.execute(
            "INSERT INTO calls (table_id, kind, created_at) VALUES (?, ?, ?)",
            (table["id"], kind, now()),
        )
        ctx.emit("calls")
        ctx.emit("table", table_id=table["id"])
    return _table_view(conn, table)


def request_checkout(ctx):
    conn = ctx.conn
    table = _table_row(conn, int(ctx.params["table_id"]))
    session = _require_open_session(conn, table["id"])
    if not session["checkout_requested_at"]:
        conn.execute(
            "UPDATE sessions SET checkout_requested_at = ? WHERE id = ?", (now(), session["id"])
        )
        conn.execute(
            "INSERT INTO calls (table_id, kind, created_at) VALUES (?, 'checkout', ?)",
            (table["id"], now()),
        )
        ctx.emit("calls")
        ctx.emit("table", table_id=table["id"])
    return _table_view(conn, table)


def close_session(ctx):
    """会計完了。セッションを閉じ、そのテーブルの未対応の呼び出しも片付ける。"""
    conn = ctx.conn
    table = _table_row(conn, int(ctx.params["table_id"]))
    session = _require_open_session(conn, table["id"])
    total = _total(_session_orders(conn, session["id"]))
    timestamp = now()
    conn.execute("UPDATE sessions SET closed_at = ? WHERE id = ?", (timestamp, session["id"]))
    conn.execute(
        "UPDATE calls SET resolved_at = ? WHERE table_id = ? AND resolved_at IS NULL",
        (timestamp, table["id"]),
    )
    ctx.emit("table", table_id=table["id"])
    ctx.emit("calls")
    ctx.emit("kitchen")
    return {
        "closed_session": {"id": session["id"], "guests": session["guests"], "total": total},
        "table": _table_view(conn, table),
    }


# ---------------------------------------------------------------- キッチン

def kitchen_queue(ctx):
    rows = ctx.conn.execute(
        """SELECT oi.id, oi.order_id, oi.name, oi.quantity, oi.status,
                  o.created_at, t.id AS table_id, t.name AS table_name
           FROM order_items oi
           JOIN orders o   ON o.id = oi.order_id
           JOIN sessions s ON s.id = o.session_id
           JOIN tables t   ON t.id = s.table_id
           WHERE s.closed_at IS NULL AND oi.status IN ('pending', 'cooking')
           ORDER BY o.id, oi.id"""
    ).fetchall()
    orders = {}
    for r in rows:
        order = orders.setdefault(r["order_id"], {
            "order_id": r["order_id"],
            "table_id": r["table_id"],
            "table_name": r["table_name"],
            "created_at": r["created_at"],
            "items": [],
        })
        order["items"].append(
            {"id": r["id"], "name": r["name"], "quantity": r["quantity"], "status": r["status"]}
        )
    return {"orders": list(orders.values())}


def update_order_item(ctx):
    conn = ctx.conn
    item_id = int(ctx.params["item_id"])
    status = ctx.body.get("status")
    if status not in ITEM_STATUSES:
        raise ApiError(400, "status が正しくありません")
    row = conn.execute(
        """SELECT oi.*, s.table_id, s.closed_at FROM order_items oi
           JOIN orders o   ON o.id = oi.order_id
           JOIN sessions s ON s.id = o.session_id
           WHERE oi.id = ?""",
        (item_id,),
    ).fetchone()
    if row is None:
        raise ApiError(404, "注文明細が見つかりません")
    if row["closed_at"]:
        raise ApiError(409, "会計済みの注文は変更できません")
    if status != row["status"]:
        if status not in STATUS_TRANSITIONS[row["status"]]:
            raise ApiError(
                409,
                f"「{ITEM_STATUS_LABELS[row['status']]}」から「{ITEM_STATUS_LABELS[status]}」には変更できません",
            )
        conn.execute("UPDATE order_items SET status = ? WHERE id = ?", (status, item_id))
        ctx.emit("kitchen")
        ctx.emit("table", table_id=row["table_id"])
    return _order_item(conn.execute("SELECT * FROM order_items WHERE id = ?", (item_id,)).fetchone())


# ---------------------------------------------------------------- 呼び出し

def list_calls(ctx):
    return {"calls": _open_calls(ctx.conn)}


def resolve_call(ctx):
    conn = ctx.conn
    call = conn.execute("SELECT * FROM calls WHERE id = ?", (int(ctx.params["call_id"]),)).fetchone()
    if call is None:
        raise ApiError(404, "呼び出しが見つかりません")
    if call["resolved_at"] is None:
        conn.execute("UPDATE calls SET resolved_at = ? WHERE id = ?", (now(), call["id"]))
        ctx.emit("calls")
        ctx.emit("table", table_id=call["table_id"])
    return {"id": call["id"], "resolved": True}


# ---------------------------------------------------------------- ルーティング

ROUTES = [
    ("GET", r"/api/menu", get_menu),
    ("PATCH", r"/api/menu/(?P<item_id>\d+)", update_menu_item),
    ("GET", r"/api/tables", list_tables),
    ("GET", r"/api/tables/(?P<table_id>\d+)", get_table),
    ("POST", r"/api/tables/(?P<table_id>\d+)/session", start_session),
    ("POST", r"/api/tables/(?P<table_id>\d+)/orders", place_order),
    ("POST", r"/api/tables/(?P<table_id>\d+)/calls", create_call),
    ("POST", r"/api/tables/(?P<table_id>\d+)/checkout-request", request_checkout),
    ("POST", r"/api/tables/(?P<table_id>\d+)/close", close_session),
    ("GET", r"/api/kitchen", kitchen_queue),
    ("PATCH", r"/api/order-items/(?P<item_id>\d+)", update_order_item),
    ("GET", r"/api/calls", list_calls),
    ("POST", r"/api/calls/(?P<call_id>\d+)/resolve", resolve_call),
]
_COMPILED = [(method, re.compile(pattern), handler) for method, pattern, handler in ROUTES]


def resolve(method, path):
    """(handler, params) を返す。該当なしは 404、メソッド違いは 405。"""
    path_matched = False
    for route_method, pattern, handler in _COMPILED:
        match = pattern.fullmatch(path)
        if match:
            if route_method == method:
                return handler, match.groupdict()
            path_matched = True
    if path_matched:
        raise ApiError(405, "許可されていないメソッドです")
    raise ApiError(404, "API が見つかりません")
