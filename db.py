"""SQLite のスキーマ定義・接続・初期データ投入。"""

import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS tables (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);

-- 1 回の来店（着席〜会計完了）。会計が終わると closed_at が入り、端末の表示はリセットされる。
CREATE TABLE IF NOT EXISTS sessions (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id              INTEGER NOT NULL REFERENCES tables(id),
    guests                INTEGER NOT NULL,
    started_at            TEXT NOT NULL,
    checkout_requested_at TEXT,
    closed_at             TEXT
);
-- 1 テーブルにつき利用中のセッションは 1 つだけ
CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_open_per_table
    ON sessions(table_id) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS categories (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menu_items (
    id          INTEGER PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price       INTEGER NOT NULL,          -- 税込価格（円）
    icon        TEXT NOT NULL DEFAULT '🍽️',
    sold_out    INTEGER NOT NULL DEFAULT 0,
    sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    created_at TEXT NOT NULL
);

-- 商品名と単価は注文時点の値を複製して保持する（後でメニューを変更しても過去の注文額は変わらない）
CREATE TABLE IF NOT EXISTS order_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id     INTEGER NOT NULL REFERENCES orders(id),
    menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
    name         TEXT NOT NULL,
    unit_price   INTEGER NOT NULL,
    quantity     INTEGER NOT NULL CHECK (quantity > 0),
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'cooking', 'served', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS calls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id    INTEGER NOT NULL REFERENCES tables(id),
    kind        TEXT NOT NULL CHECK (kind IN ('staff', 'water', 'checkout')),
    created_at  TEXT NOT NULL,
    resolved_at TEXT
);
"""

TABLE_COUNT = 8

CATEGORIES = [
    (1, "ハンバーグ・ステーキ"),
    (2, "パスタ・ドリア"),
    (3, "サラダ・スープ"),
    (4, "サイドメニュー"),
    (5, "デザート"),
    (6, "ドリンク"),
]

# (category_id, name, description, price, icon)
MENU_ITEMS = [
    (1, "チーズインハンバーグ", "とろけるチーズを包んだ定番ハンバーグ", 899, "🧀"),
    (1, "和風おろしハンバーグ", "大根おろしと特製ポン酢でさっぱりと", 799, "🍖"),
    (1, "サーロインステーキ 200g", "肉汁あふれる厚切りサーロイン", 1699, "🥩"),
    (1, "ミックスグリル", "ハンバーグ・チキン・ソーセージの盛り合わせ", 1299, "🍗"),
    (2, "カルボナーラ", "濃厚な卵とチーズのクリームソース", 799, "🍝"),
    (2, "ミートソース", "じっくり煮込んだ牛ひき肉のソース", 699, "🍝"),
    (2, "ミラノ風ドリア", "ミートソースとホワイトソースの焼きドリア", 399, "🍲"),
    (2, "エビグラタン", "ぷりぷりのエビが入ったグラタン", 699, "🦐"),
    (3, "シーザーサラダ", "パルメザンチーズとクルトンのサラダ", 499, "🥗"),
    (3, "コーンポタージュ", "甘みたっぷりのクリーミーなスープ", 299, "🌽"),
    (3, "ミネストローネ", "野菜たっぷりのトマトスープ", 349, "🍅"),
    (4, "フライドポテト", "外はカリッと中はホクホク", 349, "🍟"),
    (4, "から揚げ（5個）", "ジューシーな若鶏のから揚げ", 499, "🍗"),
    (4, "ライス", "国産米使用", 199, "🍚"),
    (4, "パン（2個）", "焼きたてのテーブルロール", 199, "🥖"),
    (5, "チョコレートパフェ", "チョコソースとアイスの贅沢パフェ", 599, "🍫"),
    (5, "バニラアイス", "なめらかなバニラアイス", 299, "🍨"),
    (5, "ティラミス", "マスカルポーネのほろ苦デザート", 399, "🍰"),
    (6, "ドリンクバー", "ソフトドリンク・コーヒー飲み放題", 399, "🥤"),
    (6, "ホットコーヒー", "香り高いブレンドコーヒー", 299, "☕"),
    (6, "オレンジジュース", "果汁100%", 299, "🍊"),
    (6, "生ビール", "キンキンに冷えた生ビール", 499, "🍺"),
]


def connect(path):
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(path):
    """スキーマを作成し、空のデータベースなら初期データを投入する。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = connect(path)
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        if conn.execute("SELECT COUNT(*) FROM tables").fetchone()[0] == 0:
            with conn:
                _seed(conn)
    finally:
        conn.close()


def _seed(conn):
    conn.executemany(
        "INSERT INTO tables (id, name) VALUES (?, ?)",
        [(i, f"テーブル {i}") for i in range(1, TABLE_COUNT + 1)],
    )
    conn.executemany(
        "INSERT INTO categories (id, name, sort) VALUES (?, ?, ?)",
        [(cid, name, cid) for cid, name in CATEGORIES],
    )
    conn.executemany(
        "INSERT INTO menu_items (category_id, name, description, price, icon, sort)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        [(*item, sort) for sort, item in enumerate(MENU_ITEMS)],
    )
