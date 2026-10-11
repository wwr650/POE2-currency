"""收益计算引擎：门票成本 + 掉落期望收益 + ROI。

``display_unit`` 为展示单位（``d`` 或 ``e``），所有输出金额统一换算到该单位。
"""
from __future__ import annotations

from typing import Any

from . import config, storage

#: 允许的价格来源字段
PRICE_SOURCES = ("sell_avg", "buy_avg", "sell_avg_24h", "buy_avg_24h", "latest_sell1", "latest_buy1", "latest_buy1")

_SOURCE_LABEL = {
    "sell_avg": "卖出均价",
    "buy_avg": "买入均价",
    "sell_avg_24h": "卖出24h均价",
    "buy_avg_24h": "买入24h均价",
    "latest_sell1": "最新卖1",
    "latest_buy1": "最新买1",
}


def _num(value: Any, default: float = 0.0) -> float:
    if value is None or isinstance(value, bool):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def latest_rate() -> float:
    rate = storage.latest_rate()
    if rate and rate.get("d_to_e"):
        return float(rate["d_to_e"])
    snap = storage.latest_snapshot()
    if snap and snap.get("d_to_e"):
        return float(snap["d_to_e"])
    return config.FALLBACK_D_TO_E


def _price_index() -> dict[str, dict[str, Any]]:
    return {it["engname"].lower(): it for it in storage.price_options() if it.get("engname")}


def convert(amount: float, src_unit: str, dst_unit: str, d_to_e: float) -> float:
    """单位换算（d <-> e）。"""
    if src_unit == dst_unit:
        return amount
    if src_unit == "e" and dst_unit == "d":
        return amount / d_to_e if d_to_e else amount
    if src_unit == "d" and dst_unit == "e":
        return amount * d_to_e
    return amount


def _resolve_price(entry: dict[str, Any], index: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """解析单条门票/掉落的价格信息。"""
    unit_out = entry.get("display_unit") or entry.get("unit")
    source = entry.get("price_source") or "sell_avg"
    engname = (entry.get("engname") or "").strip()

    if entry.get("custom") or (not engname and entry.get("custom_name")):
        # 自定义道具：单位与单价由用户直接给出
        return {
            "kind": "custom",
            "name": entry.get("custom_name") or entry.get("name") or "自定义道具",
            "engname": "",
            "category": "自定义",
            "icon": "",
            "unit": unit_out or "d",
            "price": _num(entry.get("price")),
            "price_source": "自定义单价",
            "found": True,
        }

    meta = index.get(engname.lower())
    if not meta:
        return {
            "kind": "market",
            "name": entry.get("name") or engname or "未知道具",
            "engname": engname,
            "category": "",
            "icon": "",
            "unit": unit_out or "d",
            "price": 0.0,
            "price_source": _SOURCE_LABEL.get(source, source),
            "found": False,
            "warning": f"价格库中找不到“{engname or entry.get('name')}”",
        }

    price = meta.get(source)
    if price is None or price == 0:
        # 依次回退到其它可用价格
        for fallback in ("sell_avg", "buy_avg", "sell_avg_24h", "buy_avg_24h", "latest_sell1", "latest_buy1"):
            if meta.get(fallback):
                price = meta[fallback]
                source = fallback
                break
    price = _num(price)

    return {
        "kind": "market",
        "name": meta.get("item_name") or entry.get("name") or engname,
        "engname": meta.get("engname") or engname,
        "category": meta.get("category") or "",
        "icon": meta.get("icon") or "",
        "unit": meta.get("unit") or "e",
        "price": price,
        "price_source": _SOURCE_LABEL.get(source, source),
        "found": True,
        "warning": None if price else f"“{meta.get('item_name') or engname}”价格缺失（0）",
        "error": bool(meta.get("error")),
        "error_info": meta.get("error_info") or "",
    }


def calculate(payload: dict[str, Any]) -> dict[str, Any]:
    """执行收益计算。

    ``payload`` 结构见 README / 前端；返回总额、逐行明细与告警。
    """
    display_unit = (payload.get("display_unit") or "d").lower()
    if display_unit not in ("d", "e"):
        display_unit = "d"
    d_to_e = latest_rate()
    index = _price_index()
    warnings: list[str] = []

    # ---------------------------------------------------------- 门票（成本）
    ticket_lines: list[dict[str, Any]] = []
    total_cost = 0.0
    for entry in payload.get("ticket") or []:
        entry = dict(entry)
        entry["display_unit"] = display_unit
        info = _resolve_price(entry, index)
        qty = _num(entry.get("qty"), 1.0)
        unit_price = convert(info["price"], info["unit"], display_unit, d_to_e)
        subtotal = unit_price * qty
        total_cost += subtotal
        if info.get("warning"):
            warnings.append(f"门票：{info['warning']}")
        ticket_lines.append({
            **{k: info.get(k) for k in ("name", "engname", "category", "icon", "kind", "price_source", "found")},
            "qty": qty,
            "unit": display_unit,
            "source_unit": info["unit"],
            "unit_price": round(unit_price, 6),
            "subtotal": round(subtotal, 6),
            "warning": info.get("warning"),
        })

    # ---------------------------------------------------------- 掉落（收益）
    drop_lines: list[dict[str, Any]] = []
    expected_total = 0.0
    max_total = 0.0
    for entry in payload.get("drops") or []:
        entry = dict(entry)
        entry["display_unit"] = display_unit
        enabled = entry.get("enabled", True)
        info = _resolve_price(entry, index)
        qty = _num(entry.get("qty"), 1.0)
        chance_pct = _num(entry.get("chance"), 100.0)
        chance = max(0.0, min(1.0, chance_pct / 100.0))
        unit_price = convert(info["price"], info["unit"], display_unit, d_to_e)
        expected = unit_price * qty * chance if enabled else 0.0
        maximum = unit_price * qty if enabled else 0.0
        expected_total += expected
        max_total += maximum
        if info.get("warning") and enabled:
            warnings.append(f"掉落：{info['warning']}")
        drop_lines.append({
            **{k: info.get(k) for k in ("name", "engname", "category", "icon", "kind", "price_source", "found")},
            "qty": qty,
            "chance": chance_pct,
            "enabled": bool(enabled),
            "unit": display_unit,
            "source_unit": info["unit"],
            "unit_price": round(unit_price, 6),
            "expected": round(expected, 6),
            "max": round(maximum, 6),
            "warning": info.get("warning"),
        })

    # ---------------------------------------------------------- 汇总
    net = expected_total - total_cost
    roi = (net / total_cost * 100.0) if total_cost > 0 else None
    minutes = _num(payload.get("minutes_per_run"), 0.0)
    per_run = net
    per_minute = (net / minutes) if minutes > 0 else None
    per_hour = (net / minutes * 60.0) if minutes > 0 else None

    return {
        "display_unit": display_unit,
        "d_to_e": d_to_e,
        "ticket": ticket_lines,
        "drops": drop_lines,
        "summary": {
            "total_cost": round(total_cost, 4),
            "expected_revenue": round(expected_total, 4),
            "max_revenue": round(max_total, 4),
            "net": round(net, 4),
            "roi": round(roi, 2) if roi is not None else None,
            "per_run": round(per_run, 4),
            "per_minute": round(per_minute, 4) if per_minute is not None else None,
            "per_hour": round(per_hour, 4) if per_hour is not None else None,
            "minutes_per_run": minutes,
            "ticket_kinds": len(ticket_lines),
            "drop_kinds": len(drop_lines),
        },
        "warnings": warnings,
    }
