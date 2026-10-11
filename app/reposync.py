"""仓库数据同步：启动时拉取 GitHub Actions 定时抓取的最新数据。

GitHub Actions（``.github/workflows/fetch-summary.yml``）每小时抓取一次
poecurrency.top 并把 ``summary.json`` / ``data/snapshots/`` 提交回仓库。
本地实例可能因停机或网络不通而缺少这些时段的数据，本模块在**启动时**
（两种方式：``start.bat``/``launcher.py`` 与 ``python run.py`` 都会经过
调度器的启动流程）从仓库拉取最新快照：

* 仓库地址自动从 ``git remote origin`` 识别，也可用环境变量覆盖：
    POE2_REPO_URL   形如 https://github.com/owner/repo（优先使用）
    POE2_REPO_BRANCH 分支名（默认 main）
    POE2_SYNC_REPO_ON_STARTUP=0  关闭仓库同步
* 仅当仓库数据的 ``fetched_at`` 比本地库中最新快照更新时才入库，
  避免每次启动重复写入同一份数据；
* 纯 HTTP GET（raw.githubusercontent.com），不需要 git push 权限。
"""
from __future__ import annotations

import logging
import os
import re
from datetime import datetime
from typing import Any

import httpx

from . import config, parser, storage

log = logging.getLogger(__name__)

#: 依次尝试的仓库文件（带元数据的优先，可拿到准确 fetched_at）
_REPO_PATHS = ("data/summary.json", "summary.json")

_GITHUB_URL_RE = re.compile(
    r"github\.com[:/]([^/\s]+/[^\s/]+?)(?:\.git)?/?$", re.IGNORECASE | re.MULTILINE
)


def _slug_from_text(text: str) -> str | None:
    """从任意文本（单行 URL 或 .git/config 全文）里取 owner/repo。"""
    for line in str(text).splitlines():
        m = _GITHUB_URL_RE.search(line.strip())
        if m:
            return m.group(1)
    return None


def detect_slug() -> str | None:
    """owner/repo：环境变量优先，其次读 ``.git/config`` 的 origin，最后走 ``git remote``。"""
    env = env_repo_slug()
    if env:
        return env
    try:
        text = (config.BASE_DIR / ".git" / "config").read_text(encoding="utf-8", errors="ignore")
        slug = _slug_from_text(text)
        if slug:
            return slug
    except OSError:
        pass
    try:
        import subprocess

        out = subprocess.run(
            ["git", "-C", str(config.BASE_DIR), "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=10,
        )
        return _slug_from_text(out.stdout or "")
    except Exception:  # noqa: BLE001 - 无 git / 非仓库目录时静默降级
        return None


def env_repo_slug() -> str | None:
    """``POE2_REPO_URL``（或 ``POE2_REPO_SLUG``）→ owner/repo。"""
    raw = os.getenv("POE2_REPO_URL") or os.getenv("POE2_REPO_SLUG") or ""
    raw = raw.strip().rstrip("/")
    if not raw:
        return None
    if "/" in raw and "github.com" not in raw:
        return raw  # 直接给了 owner/repo
    return _slug_from_text(raw)


def raw_url(slug: str, path: str) -> str:
    branch = config.REPO_BRANCH or "main"
    return f"https://raw.githubusercontent.com/{slug}/{branch}/{path}"


async def fetch_repo_payload(slug: str) -> dict[str, Any] | None:
    """下载仓库快照，返回 ``{"path":..., "payload":...}``；全部失败返回 None。"""
    headers = {"User-Agent": config.USER_AGENT, "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=config.API_TIMEOUT, follow_redirects=True, headers=headers) as client:
        for path in _REPO_PATHS:
            try:
                response = await client.get(raw_url(slug, path))
                response.raise_for_status()
                payload = response.json()
            except Exception as exc:  # noqa: BLE001
                log.debug("拉取仓库 %s 失败：%s", path, exc)
                continue
            meta = parser.meta_of(payload)
            if meta.get("fetched_at") or parser.data_of(payload):
                return {"path": path, "payload": payload}
    return None


def _to_aware(value: Any) -> datetime | None:
    try:
        dt = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo else dt.astimezone()


def _newer_than_local(repo_fetched_at: str | None) -> bool:
    """仓库数据是否比本地最新快照更新（本地无数据时视为需要导入）。"""
    if not repo_fetched_at:
        return False
    repo_dt = _to_aware(repo_fetched_at)
    if repo_dt is None:
        return False
    snap = storage.latest_snapshot()
    if not snap or not snap.get("fetched_at"):
        return True
    local_dt = _to_aware(snap["fetched_at"])
    if local_dt is None:
        return True
    return repo_dt > local_dt


async def sync_once() -> dict[str, Any]:
    """执行一次仓库同步，返回状态字典（不抛异常）。"""
    slug = detect_slug()
    if not slug:
        return {"ok": False, "skipped": True, "reason": "未能识别 GitHub 仓库地址（可设置 POE2_REPO_URL）"}
    found = await fetch_repo_payload(slug)
    if not found:
        return {"ok": False, "skipped": True, "reason": f"无法从仓库 {slug} 拉取数据"}
    payload = found["payload"]
    data = parser.data_of(payload)
    meta = parser.meta_of(payload)
    repo_fetched_at = str(meta.get("fetched_at") or "") or None
    if not repo_fetched_at:
        # 根目录 summary.json 无元数据（与数据源同构的裸数组）：
        # 用条目里最新的 latest_datetime 近似抓取时间
        repo_fetched_at = storage.iso_from_latest_datetime(data)
    if not _newer_than_local(repo_fetched_at):
        return {"ok": True, "skipped": True,
                "reason": f"仓库数据（{repo_fetched_at}）不比本地更新"}
    summary = storage.save_groups(
        data,
        source=f"repo:github({found['path']})",
        fetched_at=repo_fetched_at,
        write_snapshot_file=True,
        write_latest=False,
    )
    return {"ok": True, "slug": slug, "file": found["path"], **summary}


def sync_once_sync() -> dict[str, Any]:
    """同步入口（供线程池 / 脚本调用）。"""
    import asyncio

    return asyncio.run(sync_once())
