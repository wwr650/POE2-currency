"""持久化层：SQLite 主存储 + JSON 快照/索引。

表结构
------
* ``snapshots(id, fetched_at, source, item_count, error_count, d_to_e, rate_source)``
* ``prices(id, snapshot_id, category, item_name, engname, icon, unit, ...)``
* ``rates(snapshot_id, d_to_e, source, fetched_at)``
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

from . import config, parser

log = logging.getLogger(__name__)

_LOCK = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshots (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    fetched_at   TEXT    NOT NULL,
    source       TEXT,
    item_count   INTEGER NOT NULL DEFAULT 0,
    error_count  INTEGER NOT NULL DEFAULT 0,
    d_to_e       REAL,
    rate_source  TEXT
);
CREATE TABLE IF NOT EXISTS prices (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id         INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    category            TEXT,
    item_name           TEXT,
    engname             TEXT,
    icon                TEXT,
    unit                TEXT,
    buy_avg             REAL,
    sell_avg            REAL,
    buy_avg_yesterday   REAL,
    sell_avg_yesterday  REAL,
    buy_ratio           REAL,
    sell_ratio          REAL,
    latest_buy1         REAL,
    latest_sell1        REAL,
    latest_datetime     TEXT,
    buy_avg_12h         REAL,
    sell_avg_12h        REAL,
    buy_avg_24h         REAL,
    sell_avg_24h        REAL,
    error               INTEGER DEFAULT 0,
    error_info          TEXT,
    anomaly_count       INTEGER DEFAULT 0,
    e_buy_avg           REAL,
    e_sell_avg          REAL
);
CREATE TABLE IF NOT EXISTS rates (
    snapshot_id INTEGER PRIMARY KEY REFERENCES snapshots(id) ON DELETE CASCADE,
    d_to_e      REAL,
    source      TEXT,
    fetched_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_prices_snap   ON prices(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_prices_eng    ON prices(engname);
CREATE INDEX IF NOT EXISTS idx_prices_key    ON prices(engname, snapshot_id);
CREATE INDEX IF NOT EXISTS idx_snap_fetched  ON snapshots(fetched_at);
"""

_ITEM_COLUMNS = (
    "category", "item_name", "engname", "icon", "unit",
    "buy_avg", "sell_avg", "buy_avg_yesterday", "sell_avg_yesterday",
    "buy_ratio", "sell_ratio", "latest_buy1", "latest_sell1", "latest_datetime",
    "buy_avg_12h", "sell_avg_12h", "buy_avg_24h", "sell_avg_24h",
    "error", "error_info", "anomaly_count", "e_buy_avg", "e_sell_avg",
)


# ------------------------------------------------------------------ 基础
def now_iso() -> str:
    return datetime.now().astimezone().replace(microsecond=0).isoformat()


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(config.DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    with _LOCK, connect() as conn:
        conn.executescript(SCHEMA)


def _write_json(path: Path, obj: Any) -> tuple[bool, bool]:
    """写 JSON，返回 ``(是否留下了数据, 是否写入了目标路径)``。

    依次尝试三种方式，兼容严格权限 / 沙箱环境：

    1. 临时文件 + ``os.replace``（原子，最安全）；
    2. 直接原地覆盖；
    3. 写到 ``<name>.new`` 并保留（目标文件受保护时，至少留下最新内容）。

    全部失败时返回 ``(False, False)`` 并记录日志；调用方（快照入库）不因此中断，
    因为 SQLite 与 data/ 目录中的快照仍然完整。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, ensure_ascii=False, indent=2)

    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
        return True, True
    except OSError as exc:
        log.debug("原子写入 %s 失败：%s", path.name, exc)
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass

    try:
        path.write_text(text, encoding="utf-8")
        return True, True
    except OSError as exc:
        log.warning("无法更新 %s（%s）；受管环境下该文件可能仅允许读取", path.name, exc)

    alt = path.with_suffix(path.suffix + ".new")
    try:
        alt.write_text(text, encoding="utf-8")
        log.warning("已改为写入 %s，可自行替换 %s", alt.name, path.name)
        return True, False
    except OSError as exc:
        log.error("写入 %s 也失败：%s", alt, exc)
        return False, False


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        log.warning("读取 %s 失败: %s", path, exc)
        return default


def read_raw_latest() -> Any:
    """读取最新快照原始 JSON（优先带元数据的 data/summary.json）。"""
    for path in (config.LATEST_META_JSON, config.LATEST_JSON):
        payload = read_json(path)
        if payload:
            return payload
    return None


# ------------------------------------------------------------------ 写入
def _insert_snapshot(conn: sqlite3.Connection, fetched_at: str, source: str,
                     groups: Sequence[tuple[str, list[dict[str, Any]]]],
                     d_to_e: float | None, rate_source: str) -> int:
    items = [it for _, bucket in groups for it in bucket]
    error_count = sum(1 for it in items if it.get("error"))
    cur = conn.execute(
        "INSERT INTO snapshots (fetched_at, source, item_count, error_count, d_to_e, rate_source)"
        " VALUES (?,?,?,?,?,?)",
        (fetched_at, source, len(items), error_count, d_to_e, rate_source),
    )
    snap_id = int(cur.lastrowid)

    placeholders = ",".join("?" * (len(_ITEM_COLUMNS) + 1))
    rows = []
    for it in items:
        values = []
        for col in _ITEM_COLUMNS:
            v = it.get(col)
            values.append(v)
        rows.append([snap_id, *values])
    conn.executemany(
        f"INSERT INTO prices (snapshot_id,{','.join(_ITEM_COLUMNS)}) VALUES ({placeholders})",
        rows,
    )
    conn.execute(
        "INSERT OR REPLACE INTO rates (snapshot_id, d_to_e, source, fetched_at) VALUES (?,?,?,?)",
        (snap_id, d_to_e, rate_source, fetched_at),
    )
    return snap_id


def _append_index(entry: dict[str, Any]) -> None:
    index = read_json(config.INDEX_JSON, []) or []
    index = [e for e in index if e.get("file") != entry.get("file")]
    index.append(entry)
    index.sort(key=lambda e: str(e.get("fetched_at") or ""))
    _write_json(config.INDEX_JSON, index)


def save_groups(
    payload: Any,
    *,
    source: str = "api",
    fetched_at: str | None = None,
    write_snapshot_file: bool = True,
    write_latest: bool = True,
) -> dict[str, Any]:
    """解析并持久化一份快照，同时更新 summary.json / 索引 / SQLite。

    ``write_latest=False`` 用于导入既有文件时避免重复回写同一份数据。
    返回写库摘要（含 ``snapshot_id``、``item_count``、``d_to_e`` 等）。
    """
    fetched_at = fetched_at or now_iso()
    groups = parser.parse_snapshot(payload)
    d_to_e, rate_source = parser.extract_rate(groups)
    if not parser.rate_is_sane(d_to_e):
        previous = latest_rate()
        if previous and previous.get("d_to_e"):
            d_to_e, rate_source = float(previous["d_to_e"]), f"回退上一次成功值（{rate_source}）"
        else:
            d_to_e, rate_source = config.FALLBACK_D_TO_E, "兜底常量（无历史可用汇率）"

    # 回填折算为崇高石的有效价
    for _, bucket in groups:
        for it in bucket:
            it["e_buy_avg"] = parser._round(parser._to_exalted(it.get("buy_avg"), it["unit"], d_to_e))
            it["e_sell_avg"] = parser._round(parser._to_exalted(it.get("sell_avg"), it["unit"], d_to_e))

    item_count = parser.count_items(groups)
    error_count = parser.error_items(groups)
    warnings: list[str] = []

    # 1) SQLite
    init_db()
    with _LOCK, connect() as conn:
        snap_id = _insert_snapshot(conn, fetched_at, source, groups, d_to_e, rate_source)
        row = conn.execute("SELECT COUNT(*) AS n FROM snapshots").fetchone()
        snapshot_total = int(row["n"]) if row else 1

    # 2) 历史快照文件（同一秒内多次入仓时附加随机后缀，避免覆盖）
    stamp = datetime.fromisoformat(fetched_at).strftime("%Y%m%d_%H%M%S")
    snap_name = f"summary_{stamp}.json"
    snap_path = config.SNAPSHOT_DIR / snap_name
    if snap_path.exists():
        snap_name = f"summary_{stamp}_{uuid.uuid4().hex[:4]}.json"
        snap_path = config.SNAPSHOT_DIR / snap_name

    category_array = _rebuild_category_array(groups)
    envelope = {
        "fetched_at": fetched_at,
        "source": source,
        "item_count": item_count,
        "error_count": error_count,
        "d_to_e": d_to_e,
        "rate_source": rate_source,
        "data": category_array,
    }
    if write_snapshot_file:
        _write_json(snap_path, envelope)

    # 3) 根目录 summary.json（兼容：写入 API 原始数组，保持与数据源同构）
    latest_written = True
    if write_latest:
        raw_array = payload if isinstance(payload, list) else category_array
        written, latest_written = _write_json(config.LATEST_JSON, raw_array)
        if not latest_written:
            warnings.append(
                "根目录 summary.json 为只读（受管文件权限），最新数据已写入 "
                "data/summary.json、data/snapshots/ 与 summary.json.new"
            )
        elif not written:
            warnings.append("根目录 summary.json 写入失败，最新数据仍在 data/ 目录中")

    # 4) 带元数据的最新快照
    _write_json(config.LATEST_META_JSON, envelope)

    # 5) 索引
    _append_index({
        "file": f"snapshots/{snap_name}",
        "fetched_at": fetched_at,
        "item_count": item_count,
        "error_count": error_count,
        "d_to_e": d_to_e,
        "snapshot_id": snap_id,
    })

    summary = {
        "snapshot_id": snap_id,
        "fetched_at": fetched_at,
        "source": source,
        "item_count": item_count,
        "error_count": error_count,
        "d_to_e": d_to_e,
        "rate_source": rate_source,
        "snapshot_file": f"data/snapshots/{snap_name}",
        "snapshot_total": snapshot_total,
        "latest_json_updated": latest_written,
        "warnings": warnings,
    }
    log.info("快照已保存 #%s 条目=%s 汇率=%s (%s)", snap_id, item_count, d_to_e, rate_source)
    return summary


def flat_raw(groups: Sequence[tuple[str, list[dict[str, Any]]]]) -> list[dict[str, Any]]:
    """还原为分类数组形态（用于 payload 不是列表时的落盘）。"""
    out = []
    for label, bucket in groups:
        items = []
        for it in bucket:
            raw = {k: v for k, v in it.items() if k not in ("category", "e_buy_avg", "e_sell_avg")}
            raw["category_label"] = label
            items.append(raw)
        out.append({"category_label": label, "items": items})
    return out


def _rebuild_category_array(groups: Sequence[tuple[str, list[dict[str, Any]]]]) -> list[dict[str, Any]]:
    return flat_raw(groups)


# ------------------------------------------------------------------ 读取
def latest_snapshot() -> dict[str, Any] | None:
    with _LOCK, connect() as conn:
        row = conn.execute("SELECT * FROM snapshots ORDER BY id DESC LIMIT 1").fetchone()
    return dict(row) if row else None


def latest_rate() -> dict[str, Any] | None:
    with _LOCK, connect() as conn:
        row = conn.execute(
            "SELECT r.snapshot_id, r.d_to_e, r.source, r.fetched_at FROM rates r"
            " JOIN snapshots s ON s.id = r.snapshot_id WHERE r.d_to_e IS NOT NULL"
            " ORDER BY r.snapshot_id DESC LIMIT 1"
        ).fetchone()
    return dict(row) if row else None


def list_categories() -> list[dict[str, Any]]:
    snap = latest_snapshot()
    if not snap:
        return []
    with _LOCK, connect() as conn:
        rows = conn.execute(
            "SELECT category, COUNT(*) AS count,"
            " SUM(CASE WHEN error = 1 THEN 1 ELSE 0 END) AS errors"
            " FROM prices WHERE snapshot_id = ? GROUP BY category ORDER BY COUNT(*) DESC",
            (snap["id"],),
        ).fetchall()
    return [dict(r) for r in rows]


def get_prices(
    snapshot_id: int | None = None,
    *,
    category: str | None = None,
    search: str | None = None,
    sort: str = "name",
    order: str = "asc",
    only_error: bool = False,
    limit: int | None = None,
    offset: int = 0,
) -> list[dict[str, Any]]:
    snap = latest_snapshot() if snapshot_id is None else {"id": snapshot_id}
    if not snap:
        return []

    sort_map = {
        "name": "item_name",
        "engname": "engname",
        "category": "category",
        "buy": "e_buy_avg",
        "sell": "e_sell_avg",
        "buy_ratio": "buy_ratio",
        "sell_ratio": "sell_ratio",
        "latest": "latest_datetime",
    }
    column = sort_map.get(sort, "item_name")
    direction = "DESC" if str(order).lower() == "desc" else "ASC"

    where = ["snapshot_id = ?"]
    params: list[Any] = [snap["id"]]
    if category and category != "全部":
        where.append("category = ?")
        params.append(category)
    if search:
        where.append("(item_name LIKE ? OR engname LIKE ? OR category LIKE ?)")
        like = f"%{search}%"
        params.extend([like, like, like])
    if only_error:
        where.append("error = 1")

    sql = (
        f"SELECT * FROM prices WHERE {' AND '.join(where)}"
        f" ORDER BY {column} IS NULL, {column} {direction}, item_name ASC"
    )
    if limit:
        sql += " LIMIT ? OFFSET ?"
        params.extend([int(limit), int(offset)])

    with _LOCK, connect() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def price_options() -> list[dict[str, Any]]:
    """供选择器使用的轻量道具列表（最新快照去重）。"""
    snap = latest_snapshot()
    if not snap:
        return []
    with _LOCK, connect() as conn:
        rows = conn.execute(
            "SELECT engname, item_name, category, icon, unit, buy_avg, sell_avg,"
            " e_buy_avg, e_sell_avg, error FROM prices"
            " WHERE snapshot_id = ? AND engname <> '' ORDER BY item_name ASC",
            (snap["id"],),
        ).fetchall()
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for r in rows:
        key = r["engname"].lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(dict(r))
    return out


def history_items(hours: int = 168, limit: int = 400) -> list[dict[str, Any]]:
    """历史中出现过的道具列表（按最近一次出现排序）。"""
    cutoff = (datetime.now().astimezone() - timedelta(hours=hours)).replace(microsecond=0).isoformat()
    with _LOCK, connect() as conn:
        rows = conn.execute(
            "SELECT p.engname, p.item_name, p.category, p.icon, p.unit, MAX(s.fetched_at) AS last_seen,"
            " COUNT(DISTINCT p.snapshot_id) AS points"
            " FROM prices p JOIN snapshots s ON s.id = p.snapshot_id"
            " WHERE s.fetched_at >= ? AND p.engname <> ''"
            " GROUP BY p.engname ORDER BY last_seen DESC LIMIT ?",
            (cutoff, int(limit)),
        ).fetchall()
    return [dict(r) for r in rows]


def price_history(engname: str, hours: int = 168) -> list[dict[str, Any]]:
    cutoff = (datetime.now().astimezone() - timedelta(hours=hours)).replace(microsecond=0).isoformat()
    with _LOCK, connect() as conn:
        rows = conn.execute(
            "SELECT s.fetched_at AS t, s.d_to_e AS rate, p.buy_avg, p.sell_avg, p.unit,"
            " p.buy_avg_24h, p.sell_avg_24h, p.e_buy_avg, p.e_sell_avg"
            " FROM prices p JOIN snapshots s ON s.id = p.snapshot_id"
            " WHERE p.engname = ? AND s.fetched_at >= ?"
            " ORDER BY s.fetched_at ASC",
            (engname, cutoff),
        ).fetchall()
    return [dict(r) for r in rows]


def rate_history(hours: int = 168) -> list[dict[str, Any]]:
    cutoff = (datetime.now().astimezone() - timedelta(hours=hours)).replace(microsecond=0).isoformat()
    with _LOCK, connect() as conn:
        rows = conn.execute(
            "SELECT s.fetched_at AS t, r.d_to_e, r.source FROM rates r"
            " JOIN snapshots s ON s.id = r.snapshot_id"
            " WHERE s.fetched_at >= ? AND r.d_to_e IS NOT NULL ORDER BY s.fetched_at ASC",
            (cutoff,),
        ).fetchall()
    return [dict(r) for r in rows]


def snapshot_count() -> int:
    with _LOCK, connect() as conn:
        try:
            row = conn.execute("SELECT COUNT(*) AS n FROM snapshots").fetchone()
        except sqlite3.OperationalError:
            return 0  # 数据库尚未初始化
    return int(row["n"]) if row else 0


def latest_fetch_log() -> dict[str, Any] | None:
    return read_json(config.DATA_DIR / "fetch_status.json", None)


def write_fetch_status(status: dict[str, Any]) -> None:
    _write_json(config.DATA_DIR / "fetch_status.json", status)


# ------------------------------------------------------------------ 引导导入
def seed_from_existing() -> dict[str, Any] | None:
    """首次启动时把根目录已有的 summary.json 导入为基线快照。"""
    init_db()
    if snapshot_count() > 0:
        return None
    payload = None
    for path in (config.LATEST_JSON, config.LATEST_META_JSON):
        raw = read_json(path)
        if raw:
            payload = parser.data_of(raw)
            if payload:
                log.info("使用 %s 作为基线快照", path.name)
                break
    if not payload:
        return None
    source = "seed:summary.json"
    fetched_at = None
    meta = parser.meta_of(read_json(config.LATEST_META_JSON) or {})
    if meta.get("fetched_at"):
        fetched_at = str(meta["fetched_at"])
    else:
        # 无元数据：用数据中最新的一条 latest_datetime 作为近似时间
        candidate = _max_latest_datetime(payload)
        fetched_at = candidate or now_iso()
        source = "seed:summary.json(时间取自 latest_datetime)"
    try:
        return save_groups(payload, source=source, fetched_at=fetched_at,
                           write_snapshot_file=True, write_latest=False)
    except Exception as exc:  # noqa: BLE001
        log.error("基线快照导入失败: %s", exc)
        return None


def iso_from_latest_datetime(payload: Any) -> str:
    """用数据中最新的一条 ``latest_datetime`` 作为近似抓取时间（无则当前时间）。"""
    candidate = _max_latest_datetime(payload)
    return candidate or now_iso()


def _max_latest_datetime(payload: Any) -> str | None:
    best: str | None = None
    groups = payload if isinstance(payload, list) else []
    for node in groups:
        if not isinstance(node, dict):
            continue
        for it in node.get("items") or []:
            dt = str(it.get("latest_datetime") or "").strip()
            if dt and (best is None or dt > best):
                best = dt
    if not best:
        return None
    try:
        parsed = datetime.strptime(best, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    # latest_datetime 是数据源的本地时间，按本机时区落库
    return parsed.astimezone().replace(microsecond=0).isoformat()
