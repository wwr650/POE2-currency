"""原始 JSON 解析与汇率（d -> e）提取。

数据源结构::

    [ { "category_label": "通货仓库", "items": [ {...}, ... ] }, ... ]

每个 item 的关键字段：``item_name`` / ``engname`` / ``item_icon`` / ``buy_avg`` /
``sell_avg`` / ``buy_avg_ratio`` / ``sell_avg_ratio`` / ``currency_unit`` /
``latest_buy1`` / ``latest_sell1`` / ``latest_datetime`` / ``error`` / ``error_info``。

单位约定
--------
* ``currency_unit == "d"`` → 价格以 **神圣石 (Divine)** 计价
* ``currency_unit == "e"`` → 价格以 **崇高石 (Exalted)** 计价

汇率基准为 ``1 Divine = X Exalted``（记作 ``d_to_e``）。
"""
from __future__ import annotations

import json
import logging
import math
from typing import Any, Iterable

from . import config

log = logging.getLogger(__name__)

#: 各道具在数据源中“以 e 计价”时的最低可信价格（避免把 0.x 的崇高价当成汇率）
_MIN_PLAUSIBLE_RATE = 2.0


# ------------------------------------------------------------------ 基础工具
def _num(value: Any) -> float | None:
    """尽量把任意值转成 float，失败返回 None。"""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        f = float(value)
    else:
        text = str(value).strip().replace(",", "")
        if not text:
            return None
        try:
            f = float(text)
        except ValueError:
            return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def _text(value: Any, default: str = "") -> str:
    if value is None:
        return default
    return str(value).strip()


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in ("1", "true", "yes", "y", "t")


def _round(value: float | None, digits: int = 6) -> float | None:
    if value is None:
        return None
    return round(value, digits)


# ------------------------------------------------------------------ 条目解析
def parse_item(raw: dict[str, Any], category: str) -> dict[str, Any]:
    """把一条原始记录规范化为入库字典。"""
    unit = _text(raw.get("currency_unit"), "e").lower()
    if unit not in ("d", "e"):
        unit = "e"

    buy_avg = _num(raw.get("buy_avg"))
    sell_avg = _num(raw.get("sell_avg"))

    engname = _text(raw.get("engname"))
    item_name = _text(raw.get("item_name"))

    return {
        "category": category,
        "item_name": item_name,
        "engname": engname,
        "icon": _text(raw.get("item_icon")),
        "unit": unit,
        "buy_avg": buy_avg,
        "sell_avg": sell_avg,
        "buy_avg_yesterday": _num(raw.get("buy_avg_yesterday")),
        "sell_avg_yesterday": _num(raw.get("sell_avg_yesterday")),
        "buy_ratio": _num(raw.get("buy_avg_ratio")),
        "sell_ratio": _num(raw.get("sell_avg_ratio")),
        "latest_buy1": _num(raw.get("latest_buy1")),
        "latest_sell1": _num(raw.get("latest_sell1")),
        "latest_datetime": _text(raw.get("latest_datetime")),
        "buy_avg_12h": _num(raw.get("buy_avg_12h")),
        "sell_avg_12h": _num(raw.get("sell_avg_12h")),
        "buy_avg_24h": _num(raw.get("buy_avg_24h")),
        "sell_avg_24h": _num(raw.get("sell_avg_24h")),
        "error": 1 if _truthy(raw.get("error")) else 0,
        "error_info": _text(raw.get("error_info")),
        "anomaly_count": int(_num(raw.get("anomaly_count")) or 0),
        # 便于前端/收益计算：以崇高石(e)为基准的有效均价
        "e_buy_avg": _round(_to_exalted(buy_avg, unit, None)),
        "e_sell_avg": _round(_to_exalted(sell_avg, unit, None)),
    }


def _to_exalted(value: float | None, unit: str, d_to_e: float | None) -> float | None:
    """把某单位价格折算为崇高石；``d_to_e`` 未知时按 1:1 占位（之后回填）。"""
    if value is None:
        return None
    if unit == "e":
        return value
    rate = d_to_e if d_to_e else 1.0
    return value * rate


def parse_category(node: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    label = _text(node.get("category_label"), "未分类")
    items = node.get("items") or []
    return label, [parse_item(it, label) for it in items if isinstance(it, dict)]


def parse_snapshot(payload: Any) -> list[tuple[str, list[dict[str, Any]]]]:
    """解析完整快照，返回 ``[(category, items), ...]``。

    兼容三种形态：分类数组、裸条目数组、``{"data": [...]}`` 包装。
    """
    if isinstance(payload, dict):
        for key in ("data", "items", "result"):
            if key in payload:
                return parse_snapshot(payload[key])
        if "category_label" in payload:
            return [parse_category(payload)]
        raise ValueError("无法识别的 JSON 结构（dict 中缺少 data/items 字段）")

    if not isinstance(payload, list) or not payload:
        raise ValueError("响应不是非空数组")

    out: list[tuple[str, list[dict[str, Any]]]] = []
    if all(isinstance(n, dict) and "items" in n for n in payload):
        for node in payload:
            label, items = parse_category(node)
            if items:
                out.append((label, items))
    elif all(isinstance(n, dict) for n in payload):
        buckets: dict[str, list[dict[str, Any]]] = {}
        for node in payload:
            label, items = parse_category({"category_label": node.get("category_label"), "items": [node]})
            buckets.setdefault(label, []).extend(items)
        out = list(buckets.items())
    else:
        raise ValueError("数组元素不是对象")

    if not out:
        raise ValueError("解析后没有任何条目")
    return out


# ------------------------------------------------------------------ 汇率提取
def extract_rate(groups: Iterable[tuple[str, list[dict[str, Any]]]]) -> tuple[float | None, str]:
    """从快照中提取 ``1 Divine = X Exalted``。

    策略（按优先级）：

    1. **神圣石以 e 计价**：直接就是 e/d 汇率（首选，最稳）。
    2. **神圣石以 d 计价 + 已知 e 价**：交叉换算。
    3. **混沌石以 e 计价**：``e/d = (e/c) / (d/c)``；后者取混沌石在 d 单位的
       报价，缺省用该道具 ``buy_avg_yesterday/24h`` 交叉；再缺省则与
       神圣石的 d 价交叉。
    4. **卡兰德的魔镜等高价锚点** 与神圣石的比值兜底。
    5. 全无 → ``(None, "unavailable")``，由调用方回退到上一次成功值。

    返回 ``(d_to_e, rate_source)``。
    """
    items: list[dict[str, Any]] = [it for _, bucket in groups for it in bucket]
    by_eng: dict[str, list[dict[str, Any]]] = {}
    for it in items:
        key = (it.get("engname") or it.get("item_name") or "").lower()
        by_eng.setdefault(key, []).append(it)

    def pick(name: str) -> list[dict[str, Any]]:
        return by_eng.get(name.lower(), [])

    def exalted_value(entries: list[dict[str, Any]]) -> float | None:
        """取某道具以 e 计价的可信均价（buy/sell 均值优先）。"""
        cands: list[float] = []
        for it in entries:
            if it["unit"] != "e":
                continue
            for key in ("sell_avg", "buy_avg", "sell_avg_24h", "buy_avg_24h"):
                v = it.get(key)
                if v and v >= _MIN_PLAUSIBLE_RATE:
                    cands.append(float(v))
        if not cands:
            return None
        cands.sort()
        # 取中位数附近的稳健值（首尾各去掉一个极端值）
        trimmed = cands[1:-1] if len(cands) > 3 else cands
        return sum(trimmed) / len(trimmed)

    def divine_value(entries: list[dict[str, Any]]) -> float | None:
        """取某道具以 d 计价的可信均价。"""
        cands: list[float] = []
        for it in entries:
            if it["unit"] != "d":
                continue
            for key in ("sell_avg", "buy_avg", "sell_avg_24h", "buy_avg_24h"):
                v = it.get(key)
                if v and v > 0:
                    cands.append(float(v))
        if not cands:
            return None
        return sum(cands) / len(cands)

    # 1) 神圣石以 e 计价 —— 最直接的汇率
    divine = pick("Divine Orb")
    if divine:
        rate = exalted_value(divine)
        if rate:
            return _round(rate, 4), "Divine Orb 以崇高石计价"

    # 2/3) 混沌石以 e 计价：需要“混沌石 = 多少神圣石”
    chaos = pick("Chaos Orb")
    if chaos:
        chaos_e = exalted_value(chaos)
        chaos_d = divine_value(chaos)
        if chaos_e and chaos_d:
            return _round(chaos_e / chaos_d, 4), "混沌石 e/d 交叉汇率"
        if chaos_e:
            # 用“神圣石以 d 计价”的报价交叉（罕见）
            divine_d = divine_value(divine) if divine else None
            if divine_d:
                return _round(chaos_e / divine_d, 4), "混沌石 e 价 / 神圣石 d 价"

    # 4) 高价锚点：魔镜 或 神圣石自身 24h 值
    for anchor in ("Mirror of Kalandra",):
        entries = pick(anchor)
        if not entries:
            continue
        rate = exalted_value(entries)
        if rate:
            # 魔镜以 e 计价时数值远大于汇率，仅在看起来合理时才用
            mirror_d = divine_value(entries)
            if mirror_d:
                return _round(rate / mirror_d, 4), f"{anchor} e/d 交叉汇率"

    # 5) 兜底：从任意“以 e 计价的 d 单位经典通货”反推不可行 → 交给上一次成功值
    return None, "unavailable"


def rate_is_sane(value: float | None) -> bool:
    return value is not None and 10.0 <= value <= 100_000.0


def normalize_payload(payload: Any) -> list[list[dict[str, Any]]] | None:
    """宽松解析：失败返回 None（不抛异常），用于兜底导入。"""
    try:
        groups = parse_snapshot(payload)
    except Exception as exc:  # noqa: BLE001
        log.warning("解析失败: %s", exc)
        return None
    return [items for _, items in groups]


def dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2)


def data_of(payload: Any) -> Any:
    """取出快照中的纯数据部分（兼容带元数据的包装格式）。"""
    if isinstance(payload, dict) and "data" in payload:
        return payload["data"]
    return payload


def meta_of(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict):
        return {k: v for k, v in payload.items() if k != "data"}
    return {}


def count_items(groups: Iterable[tuple[str, list[dict[str, Any]]]]) -> int:
    return sum(len(bucket) for _, bucket in groups)


def error_items(groups: Iterable[tuple[str, list[dict[str, Any]]]]) -> int:
    return sum(1 for _, bucket in groups for it in bucket if it.get("error"))


def __getattr__(name: str) -> Any:  # pragma: no cover - 兼容旧引用
    if name == "FALLBACK_D_TO_E":
        return config.FALLBACK_D_TO_E
    raise AttributeError(name)
