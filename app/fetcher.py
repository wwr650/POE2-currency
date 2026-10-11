"""抓取器：带超时、重试与指数退避的 API 拉取，并落盘持久化。"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import httpx

from . import config, parser, storage

log = logging.getLogger(__name__)


class FetchError(RuntimeError):
    """抓取失败（已耗尽重试）。"""


async def fetch_raw(url: str | None = None, retries: int | None = None) -> Any:
    """拉取原始 JSON，失败重试 ``retries`` 次（指数退避）。

    校验：响应必须是合法 JSON 且为非空数组（或含非空 data 数组的包装对象）。
    """
    url = url or config.API_URL
    retries = config.API_RETRIES if retries is None else retries
    last_error: Exception | None = None

    headers = {"User-Agent": config.USER_AGENT, "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=config.API_TIMEOUT, follow_redirects=True, headers=headers) as client:
        for attempt in range(1, retries + 1):
            try:
                response = await client.get(url)
                response.raise_for_status()
                payload = response.json()
                data = parser.data_of(payload)
                if not isinstance(data, list) or not data:
                    raise ValueError("响应不是合法 JSON 非空数组")
                log.info("抓取成功（第 %s 次尝试，%s 条分类）", attempt, len(data))
                return payload
            except Exception as exc:  # noqa: BLE001 - 需要覆盖 httpx/JSON 全部异常
                last_error = exc
                if attempt >= retries:
                    break
                delay = config.API_BACKOFF ** attempt
                log.warning("抓取失败（第 %s/%s 次）：%s；%.1fs 后重试", attempt, retries, exc, delay)
                await asyncio.sleep(delay)

    raise FetchError(f"抓取失败，已重试 {retries} 次：{last_error}")


async def fetch_and_store(url: str | None = None, source: str = "api") -> dict[str, Any]:
    """抓取 + 入库；异常不向外抛出（调度器不中断），返回状态字典。"""
    started = storage.now_iso()
    try:
        payload = await fetch_raw(url)
        summary = storage.save_groups(payload, source=source)
        status = {"ok": True, "at": storage.now_iso(), "started_at": started, **summary}
    except Exception as exc:  # noqa: BLE001
        log.error("抓取任务失败：%s", exc)
        status = {
            "ok": False,
            "at": storage.now_iso(),
            "started_at": started,
            "error": str(exc),
            "error_type": type(exc).__name__,
        }
    storage.write_fetch_status(status)
    return status


def fetch_and_store_sync(url: str | None = None, source: str = "api") -> dict[str, Any]:
    """同步入口，供启动阶段与手动刷新使用。"""
    return asyncio.run(fetch_and_store(url=url, source=source))


async def load_local_file(path) -> dict[str, Any]:
    """离线导入本地 JSON 快照（网络不可用时的手动补给）。"""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        data = parser.data_of(payload)
        summary = storage.save_groups(data, source=f"file:{path.name}")
        status = {"ok": True, "at": storage.now_iso(), **summary}
    except Exception as exc:  # noqa: BLE001
        status = {"ok": False, "at": storage.now_iso(), "error": str(exc)}
    storage.write_fetch_status(status)
    return status
