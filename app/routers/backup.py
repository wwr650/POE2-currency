"""数据备份与恢复：把用户数据（自定义道具 / 收益配置）导出成一个 JSON 文件，
   或从该文件恢复。用于长期保存、换机器、防止误删。"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, store

log = logging.getLogger(__name__)
router = APIRouter()

FORMAT = "poe2-dashboard-backup"
VERSION = 1

#: 导出/导入涉及的文档
DOCS = (
    ("custom_items", config.CUSTOM_ITEMS, "自定义道具"),
    ("profit_configs", config.PROFIT_CONFIGS, "收益配置"),
)


class Backup(BaseModel):
    format: str = FORMAT
    version: int = VERSION
    exported_at: str = ""
    custom_items: list[dict[str, Any]] | None = None
    profit_configs: list[dict[str, Any]] | None = None
    #: 导入模式：merge（按 id 合并，默认）| replace（整体覆盖）
    mode: str = "merge"


@router.get("/export")
def export_data() -> dict[str, Any]:
    data: dict[str, Any] = {
        "format": FORMAT,
        "version": VERSION,
        "exported_at": store.now_iso(),
    }
    counts = {}
    for key, path, label in DOCS:
        items = store.load(path, [])
        data[key] = items if isinstance(items, list) else []
        counts[label] = len(data[key])
    data["counts"] = counts
    return data


@router.post("/import")
def import_data(payload: Backup) -> dict[str, Any]:
    if payload.format != FORMAT:
        raise HTTPException(status_code=400, detail=f"备份格式不匹配（需要 {FORMAT}）")
    if payload.version > VERSION:
        raise HTTPException(status_code=400, detail=f"备份版本过新（{payload.version} > {VERSION}）")
    mode = payload.mode if payload.mode in ("merge", "replace") else "merge"

    result: dict[str, Any] = {"ok": True, "mode": mode, "imported": {}, "skipped": {}}
    incoming = {
        "custom_items": payload.custom_items,
        "profit_configs": payload.profit_configs,
    }

    for key, path, label in DOCS:
        items = incoming.get(key)
        if items is None:
            result["skipped"][label] = "备份中没有该部分"
            continue
        if mode == "replace":
            store.save(path, items)
            result["imported"][label] = {"total": len(items), "added": len(items), "updated": 0}
            continue
        # merge：按 id 合并，缺少 id 的视为新增
        current = store.load(path, [])
        current = current if isinstance(current, list) else []
        by_id = {str(it.get("id")): i for i, it in enumerate(current) if isinstance(it, dict) and it.get("id")}
        added = updated = 0
        for it in items:
            if not isinstance(it, dict):
                continue
            rid = str(it.get("id") or "")
            if rid and rid in by_id:
                current[by_id[rid]] = it
                updated += 1
            else:
                if not rid:
                    it = dict(it, id=store.new_id())
                current.append(it)
                added += 1
        store.save(path, current)
        result["imported"][label] = {"total": len(current), "added": added, "updated": updated}

    log.info("数据导入完成：%s", result["imported"])
    return result


@router.get("/counts")
def counts() -> dict[str, int]:
    out = {}
    for key, path, _label in DOCS:
        items = store.load(path, [])
        out[key] = len(items) if isinstance(items, list) else 0
    return out
