"""收益分析 API：计算、保存、加载、删除配置。"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import config, profit, storage, store

log = logging.getLogger(__name__)
router = APIRouter()


# ------------------------------------------------------------------ 模型
class TicketEntry(BaseModel):
    engname: str | None = None
    name: str | None = None
    qty: float = 1
    price_source: str = "sell_avg"
    custom: bool | None = False
    custom_name: str | None = None
    unit: str | None = None
    price: float | None = None


class DropEntry(TicketEntry):
    chance: float = 100.0              # 掉落概率（百分数 0~100）
    enabled: bool = True


class ProfitPayload(BaseModel):
    display_unit: str = "d"
    minutes_per_run: float = 0
    ticket: list[TicketEntry] = Field(default_factory=list)
    drops: list[DropEntry] = Field(default_factory=list)


class ProfitConfig(ProfitPayload):
    id: str | None = None
    name: str = "未命名配置"
    created_at: str | None = None
    updated_at: str | None = None


# ------------------------------------------------------------------ 计算
@router.post("/calculate")
def calculate(payload: ProfitPayload) -> dict:
    result = profit.calculate(payload.model_dump())
    result["rate"] = {"d_to_e": result["d_to_e"]}
    return result


@router.get("/rate")
def get_rate() -> dict:
    rate = storage.latest_rate()
    return {"d_to_e": profit.latest_rate(), "source": (rate or {}).get("source"),
            "fetched_at": (rate or {}).get("fetched_at")}


# ------------------------------------------------------------------ 配置 CRUD
def _load_all() -> list[dict[str, Any]]:
    data = store.load(config.PROFIT_CONFIGS, [])
    return data if isinstance(data, list) else []


@router.get("/configs")
def list_configs() -> dict:
    configs = sorted(_load_all(), key=lambda c: str(c.get("updated_at") or c.get("created_at") or ""), reverse=True)
    return {"count": len(configs), "items": configs}


@router.post("/save")
def save_config(cfg: ProfitConfig) -> dict:
    configs = _load_all()
    now = store.now_iso()
    data = cfg.model_dump()
    data["id"] = cfg.id or store.new_id()
    data["created_at"] = cfg.created_at or now
    data["updated_at"] = now

    replaced = False
    for i, existing in enumerate(configs):
        if existing.get("id") == data["id"]:
            configs[i] = data
            replaced = True
            break
    if not replaced:
        configs.append(data)
    store.save(config.PROFIT_CONFIGS, configs)
    log.info("收益配置已保存：%s (%s)", data.get("name"), data["id"])
    return {"ok": True, "id": data["id"], "replaced": replaced, "config": data}


@router.get("/load/{config_id}")
def load_config(config_id: str) -> dict:
    for cfg in _load_all():
        if cfg.get("id") == config_id:
            return {"ok": True, "config": cfg}
    raise HTTPException(status_code=404, detail=f"配置不存在：{config_id}")


@router.post("/load/{config_id}")
def load_config_post(config_id: str) -> dict:
    return load_config(config_id)


@router.delete("/configs/{config_id}")
def delete_config(config_id: str) -> dict:
    configs = _load_all()
    remaining = [c for c in configs if c.get("id") != config_id]
    if len(remaining) == len(configs):
        raise HTTPException(status_code=404, detail=f"配置不存在：{config_id}")
    store.save(config.PROFIT_CONFIGS, remaining)
    return {"ok": True, "id": config_id, "count": len(remaining)}


@router.get("/presets")
def presets() -> dict:
    """常用门票/掉落预设（基于当前价格库道具名，缺失时前端会提示）。"""
    return {
        "items": [
            {"engname": "Divine Orb", "name": "神圣石"},
            {"engname": "Chaos Orb", "name": "混沌石"},
            {"engname": "Exalted Orb", "name": "崇高石"},
        ]
    }
