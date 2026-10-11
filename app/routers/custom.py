"""自定义道具 CRUD。"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, store

log = logging.getLogger(__name__)
router = APIRouter()


class CustomItem(BaseModel):
    id: str | None = None
    name: str
    engname: str = ""
    unit: str = "d"
    price: float = 0
    category: str = "自定义"
    icon: str = ""
    note: str = ""
    updated_at: str | None = None


def _load() -> list[dict]:
    data = store.load(config.CUSTOM_ITEMS, [])
    return data if isinstance(data, list) else []


def _save(items: list[dict]) -> None:
    store.save(config.CUSTOM_ITEMS, items)


@router.get("")
def list_items() -> dict:
    items = sorted(_load(), key=lambda i: str(i.get("name") or ""))
    return {"count": len(items), "items": items}


@router.post("")
def create_item(item: CustomItem) -> dict:
    items = _load()
    data = item.model_dump()
    data["id"] = item.id or store.new_id()
    data["updated_at"] = store.now_iso()
    items.append(data)
    _save(items)
    return {"ok": True, "item": data}


@router.put("/{item_id}")
def update_item(item_id: str, item: CustomItem) -> dict:
    items = _load()
    for i, existing in enumerate(items):
        if existing.get("id") == item_id:
            data = item.model_dump()
            data["id"] = item_id
            data["updated_at"] = store.now_iso()
            items[i] = data
            _save(items)
            return {"ok": True, "item": data}
    raise HTTPException(status_code=404, detail=f"自定义道具不存在：{item_id}")


@router.delete("/{item_id}")
def delete_item(item_id: str) -> dict:
    items = _load()
    remaining = [i for i in items if i.get("id") != item_id]
    if len(remaining) == len(items):
        raise HTTPException(status_code=404, detail=f"自定义道具不存在：{item_id}")
    _save(remaining)
    return {"ok": True, "id": item_id, "count": len(remaining)}
