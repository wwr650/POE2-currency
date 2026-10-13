"""价格看板与历史趋势 API。"""
from __future__ import annotations

import csv
import io
import logging
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from .. import config, reposync, storage

log = logging.getLogger(__name__)
router = APIRouter()


# ------------------------------------------------------------------ 元信息
@router.get("/meta")
def get_meta() -> dict:
    """看板顶部概览：汇率、更新时间、抓取状态、条目统计。"""
    snap = storage.latest_snapshot()
    rate = storage.latest_rate()
    from .. import scheduler

    if not snap:
        return {
            "ok": False,
            "message": "暂无数据，请点击顶部“同步数据”或等待定时同步拉取 GitHub 仓库（Actions）抓取的数据",
            "rate": {"d_to_e": None, "source": None, "fetched_at": None},
            "fetch": storage.latest_fetch_log(),
            "categories": [],
            "item_count": 0,
            "error_count": 0,
            "snapshot_id": None,
        }

    return {
        "ok": True,
        "snapshot_id": snap["id"],
        "fetched_at": snap["fetched_at"],
        "source": snap["source"],
        "item_count": snap["item_count"],
        "error_count": snap["error_count"],
        "snapshot_total": storage.snapshot_count(),
        "rate": {
            "d_to_e": snap["d_to_e"],
            "source": snap["rate_source"],
            "fetched_at": snap["fetched_at"],
            "previous": rate["d_to_e"] if rate else None,
        },
        "fetch": storage.latest_fetch_log(),
        "scheduler": scheduler.status(),
        "categories": storage.list_categories(),
    }


# ------------------------------------------------------------------ 价格列表
def _decorate(item: dict, d_to_e: float | None) -> dict:
    """附加“以 d 计价”的等值字段，供前端单位切换即时换算。"""
    item = dict(item)
    unit = item.get("unit")
    for field in ("buy_avg", "sell_avg", "buy_avg_12h", "sell_avg_12h", "buy_avg_24h", "sell_avg_24h",
                  "latest_buy1", "latest_sell1", "buy_avg_yesterday", "sell_avg_yesterday"):
        item["d_" + field] = _to_d(item.get(field), unit, d_to_e)
    return item


def _to_d(value: float | None, unit: str | None, d_to_e: float | None) -> float | None:
    if value is None:
        return None
    rate = d_to_e or config.FALLBACK_D_TO_E
    if unit == "d":
        return round(float(value), 6)
    if not rate:
        return None
    return round(float(value) / rate, 6)


@router.get("/prices")
def get_prices(
    category: str | None = Query(None, description="分类名称，缺省=全部"),
    search: str | None = Query(None, description="中英文/分类模糊匹配"),
    sort: str = Query("name", pattern="^(name|engname|category|buy|sell|buy_ratio|sell_ratio|latest)$"),
    order: str = Query("asc", pattern="^(asc|desc)$"),
    only_error: bool = Query(False),
    limit: int | None = Query(None, ge=1, le=5000),
    offset: int = Query(0, ge=0),
) -> dict:
    snap = storage.latest_snapshot()
    if not snap:
        raise HTTPException(status_code=503, detail="暂无快照数据")
    d_to_e = snap.get("d_to_e")
    rows = storage.get_prices(
        snap["id"], category=category, search=search, sort=sort, order=order,
        only_error=only_error, limit=limit, offset=offset,
    )
    return {
        "snapshot_id": snap["id"],
        "fetched_at": snap["fetched_at"],
        "d_to_e": d_to_e,
        "count": len(rows),
        "category": category or "全部",
        "items": [_decorate(r, d_to_e) for r in rows],
    }


@router.get("/options")
def get_options(limit: int = Query(3000, ge=1, le=10000)) -> dict:
    """道具选择器数据（去重，含当前价）。"""
    snap = storage.latest_snapshot()
    d_to_e = snap.get("d_to_e") if snap else None
    items = storage.price_options()[:limit]
    return {"d_to_e": d_to_e, "count": len(items),
            "items": [_decorate(i, d_to_e) for i in items]}


# ------------------------------------------------------------------ 历史
@router.get("/history")
def get_history(
    item: str | None = Query(None, description="道具英文名（唯一键）"),
    items: str | None = Query(None, description="多道具对比，逗号分隔，最多 5 个"),
    hours: int = Query(168, ge=1, le=8760),
    unit: str = Query("source", pattern="^(source|d|e)$"),
) -> dict:
    """单道具/多道具价格时间序列。"""
    hours = int(hours)
    wanted: list[str] = []
    if items:
        wanted = [s.strip() for s in items.split(",") if s.strip()][:5]
    elif item:
        wanted = [item.strip()]
    if not wanted:
        raise HTTPException(status_code=400, detail="缺少 item 或 items 参数")

    rate_rows = storage.rate_history(hours)
    series = []
    for name in wanted:
        rows = storage.price_history(name, hours)
        points = []
        for r in rows:
            buy, sell = _pick_series(r, unit)
            points.append({
                "t": r["t"],
                "buy_avg": buy,
                "sell_avg": sell,
                "unit": unit if unit != "source" else r["unit"],
                "raw_unit": r["unit"],
            })
        meta = rows[-1] if rows else {}
        series.append({
            "engname": name,
            "name": _lookup_name(name) or name,
            "unit": unit if unit != "source" else (meta.get("unit") or "e"),
            "points": points,
        })

    return {
        "hours": hours,
        "unit": unit,
        "rate": [{"t": r["t"], "d_to_e": r["d_to_e"], "source": r["source"]} for r in rate_rows],
        "series": series,
    }


def _pick_series(row: dict, unit: str) -> tuple[float | None, float | None]:
    if unit == "e":
        return row.get("e_buy_avg"), row.get("e_sell_avg")
    if unit == "d":
        rate = row.get("rate") or config.FALLBACK_D_TO_E
        buy, sell = row.get("e_buy_avg"), row.get("e_sell_avg")
        return (round(buy / rate, 6) if buy is not None else None,
                round(sell / rate, 6) if sell is not None else None)
    return row.get("buy_avg"), row.get("sell_avg")


def _lookup_name(engname: str) -> str | None:
    for it in storage.price_options():
        if it["engname"] == engname:
            return it["item_name"]
    return None


@router.get("/history/rate")
def get_rate_history(hours: int = Query(168, ge=1, le=8760)) -> dict:
    rows = storage.rate_history(int(hours))
    return {"hours": hours, "count": len(rows), "points": rows}


@router.get("/history/items")
def get_history_items(hours: int = Query(720, ge=1, le=8760), limit: int = Query(400, ge=1, le=2000)) -> dict:
    return {"items": storage.history_items(int(hours), int(limit))}


# ------------------------------------------------------------------ 运维
@router.post("/sync-repo")
async def manual_sync_repo() -> dict:
    """手动从 GitHub 仓库拉取 Actions 更新的数据。

    本地直接抓取已移除：数据统一来自 GitHub Actions 定时抓取并提交回仓库的快照。
    本接口会：
    * 增量回填仓库 ``data/snapshots/`` 中本地缺失的历史快照（补齐趋势图）；
    * 再兜底拉取最新一份 ``summary.json``（不比本地新则不入库）。
    """
    result = await reposync.sync_once()
    if not result.get("ok"):
        raise HTTPException(status_code=502, detail=f"仓库同步失败：{result.get('reason')}")
    return result


@router.get("/export.csv")
def export_csv(category: str | None = None, search: str | None = None) -> StreamingResponse:
    snap = storage.latest_snapshot()
    rows = storage.get_prices(snap["id"], category=category, search=search) if snap else []
    d_to_e = snap.get("d_to_e") if snap else None

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow([
        "分类", "中文名", "英文名", "单位", "买入均价", "卖出均价",
        "买涨跌%", "卖涨跌%", "24h买入均价", "24h卖出均价",
        "最新买1", "最新卖1", "折算d买入", "折算d卖出", "更新时间", "异常", "异常信息",
    ])
    for r in rows:
        item = _decorate(r, d_to_e)
        writer.writerow([
            item.get("category"), item.get("item_name"), item.get("engname"), item.get("unit"),
            item.get("buy_avg"), item.get("sell_avg"), item.get("buy_ratio"), item.get("sell_ratio"),
            item.get("buy_avg_24h"), item.get("sell_avg_24h"),
            item.get("latest_buy1"), item.get("latest_sell1"),
            item.get("d_buy_avg"), item.get("d_sell_avg"),
            item.get("latest_datetime"), "是" if item.get("error") else "否", item.get("error_info"),
        ])
    buffer.seek(0)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return StreamingResponse(
        iter([buffer.getvalue().encode("utf-8-sig")]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="poe2_prices_{stamp}.csv"'},
    )


@router.get("/snapshots")
def get_snapshots(limit: int = Query(200, ge=1, le=2000)) -> dict:
    index = storage.read_json(config.INDEX_JSON, []) or []
    return {"count": len(index), "items": list(reversed(index))[:limit]}
