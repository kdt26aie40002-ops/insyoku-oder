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
    age_group             TEXT,   -- お客様が入力した代表者の年代（おすすめ用・任意）
    gender                TEXT,   -- 同じく性別（任意）
    allergens             TEXT NOT NULL DEFAULT '',  -- お客様が指定したアレルギー（カンマ区切り）
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
    recommended INTEGER NOT NULL DEFAULT 0,  -- テーブル端末の「本日のおすすめ」に表示
    tags        TEXT NOT NULL DEFAULT '',    -- おすすめ判定用の特徴（カンマ区切り。api.TAG_REASONS 参照）
    allergens   TEXT NOT NULL DEFAULT '',    -- 含まれるアレルゲン（カンマ区切り。api.ALLERGENS 参照）
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

# 初期データで「おすすめ」にする商品
RECOMMENDED_ITEMS = ("サーロインステーキ 200g", "チーズインハンバーグ", "カルボナーラ", "チョコレートパフェ")

# 年代・性別に合わせたおすすめに使う特徴タグ
MENU_ITEM_TAGS = {
    "チーズインハンバーグ": "hearty,kids",
    "和風おろしハンバーグ": "hearty,healthy",
    "サーロインステーキ 200g": "hearty",
    "ミックスグリル": "hearty",
    "カルボナーラ": "hearty",
    "ミートソース": "kids",
    "ミラノ風ドリア": "light,kids",
    "エビグラタン": "light",
    "シーザーサラダ": "healthy,light",
    "コーンポタージュ": "kids,light",
    "ミネストローネ": "healthy,light",
    "フライドポテト": "kids",
    "から揚げ（5個）": "hearty,kids",
    "チョコレートパフェ": "sweet,kids",
    "バニラアイス": "sweet,kids,light",
    "ティラミス": "sweet",
    "ドリンクバー": "kids",
    "ホットコーヒー": "light",
    "オレンジジュース": "kids,healthy",
    "生ビール": "alcohol",
}

# 各商品に含まれるアレルゲン（キーは api.ALLERGENS）。記載のない商品は該当なし
MENU_ITEM_ALLERGENS = {
    "チーズインハンバーグ": "egg,milk,wheat,soy,beef,pork",
    "和風おろしハンバーグ": "egg,milk,wheat,soy,beef,pork",
    "サーロインステーキ 200g": "wheat,soy,beef",
    "ミックスグリル": "egg,milk,wheat,soy,beef,pork,chicken",
    "カルボナーラ": "egg,milk,wheat,pork",
    "ミートソース": "milk,wheat,soy,beef,pork",
    "ミラノ風ドリア": "milk,wheat,beef,pork",
    "エビグラタン": "shrimp,milk,wheat",
    "シーザーサラダ": "egg,milk,wheat",
    "コーンポタージュ": "milk,wheat",
    "ミネストローネ": "wheat,pork",
    "から揚げ（5個）": "wheat,soy,chicken",
    "パン（2個）": "egg,milk,wheat",
    "チョコレートパフェ": "egg,milk,wheat,soy",
    "バニラアイス": "egg,milk",
    "ティラミス": "egg,milk,wheat",
    "オレンジジュース": "orange",
}


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
        _migrate(conn)
        if conn.execute("SELECT COUNT(*) FROM tables").fetchone()[0] == 0:
            with conn:
                _seed(conn)
    finally:
        conn.close()


def _columns(conn, table):
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}


def _migrate(conn):
    """古いバージョンで作られたデータベースに不足している列を追加する。"""
    menu_columns = _columns(conn, "menu_items")
    session_columns = _columns(conn, "sessions")
    with conn:
        if "recommended" not in menu_columns:
            conn.execute("ALTER TABLE menu_items ADD COLUMN recommended INTEGER NOT NULL DEFAULT 0")
            _mark_recommended(conn)
        if "tags" not in menu_columns:
            conn.execute("ALTER TABLE menu_items ADD COLUMN tags TEXT NOT NULL DEFAULT ''")
            _apply_tags(conn)
        if "allergens" not in menu_columns:
            conn.execute("ALTER TABLE menu_items ADD COLUMN allergens TEXT NOT NULL DEFAULT ''")
            _apply_allergens(conn)
        for column in ("age_group", "gender"):
            if column not in session_columns:
                conn.execute(f"ALTER TABLE sessions ADD COLUMN {column} TEXT")
        if "allergens" not in session_columns:
            conn.execute("ALTER TABLE sessions ADD COLUMN allergens TEXT NOT NULL DEFAULT ''")


def _mark_recommended(conn):
    conn.executemany(
        "UPDATE menu_items SET recommended = 1 WHERE name = ?", [(n,) for n in RECOMMENDED_ITEMS]
    )


def _apply_tags(conn):
    conn.executemany(
        "UPDATE menu_items SET tags = ? WHERE name = ?", [(t, n) for n, t in MENU_ITEM_TAGS.items()]
    )


def _apply_allergens(conn):
    conn.executemany(
        "UPDATE menu_items SET allergens = ? WHERE name = ?", [(a, n) for n, a in MENU_ITEM_ALLERGENS.items()]
    )


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
    _mark_recommended(conn)
    _apply_tags(conn)
    _apply_allergens(conn)
