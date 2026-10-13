"""仓库数据同步：本地服务的唯一数据来源——消费 GitHub Actions 定时抓取的数据。

GitHub Actions（``.github/workflows/fetch-summary.yml``）每小时抓取一次
poecurrency.top，并把最新 ``summary.json`` 与逐小时历史 ``data/snapshots/``
提交回仓库。本地不再直接抓取 API，统一从仓库取数，分两条链路：

* **一次性回填**（``backfill_from_local``）：把仓库已 clone 到本地的
  ``data/snapshots/*.json`` 历史快照按时间去重后全部写入 SQLite，
  无需网络，一次即可补齐趋势图历史（由 ``scripts/backfill_snapshots.py`` 触发）。
* **持续同步**（``sync_once``）：启动/定时/手动时执行——
    - 通过 GitHub Contents API 列出仓库 ``data/snapshots/``，仅下载并入库
      本地库缺失的快照（Action 每次抓取成功后都会新增一份，自动被拉取入库）；
    - 再兜底拉取根 ``summary.json`` 最新一份（列出目录失败时仍能拿到最新）。

配置（环境变量）：
    POE2_REPO_URL / POE2_REPO_SLUG   仓库地址，缺省自动从 ``git remote origin`` 识别
    POE2_REPO_BRANCH                 分支名（默认 main）
    POE2_SYNC_REPO_ON_STARTUP=0      关闭启动同步
    POE2_REPO_SYNC_HISTORY=0         关闭历史目录增量回填（只同步最新一份）
    POE2_GITHUB_TOKEN                提升 Contents API 速率限制（可选）

去重以快照 ``fetched_at`` 的秒级标识为键，同秒视为同一份数据不重复入库；
纯 HTTP GET（raw.githubusercontent.com / api.github.com），不需要 git push 权限。
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


_SNAPSHOT_NAME_RE = re.compile(r"summary_(\d{8})_(\d{6})")


def _name_stamp(name: str) -> str | None:
    """快照文件名里的时间戳 -> ``YYYY-MM-DDTHH:MM:SS``（与 ``fetched_at`` 前 19 位同构）。"""
    m = _SNAPSHOT_NAME_RE.search(str(name))
    if not m:
        return None
    d, t = m.group(1), m.group(2)
    return f"{d[0:4]}-{d[4:6]}-{d[6:8]}T{t[0:2]}:{t[2:4]}:{t[4:6]}"


def api_contents_url(slug: str) -> str:
    """GitHub Contents API：列出仓库历史快照目录。"""
    branch = config.REPO_BRANCH or "main"
    return f"https://api.github.com/repos/{slug}/contents/{config.SNAPSHOT_REPO_DIR}?ref={branch}"


def _ingest_snapshot(payload: Any, existing: set[str], *, source: str) -> dict[str, Any] | None:
    """把一份快照（信封或裸数组）入库；同秒已存在则跳过（去重，不重复写文件）。"""
    data = parser.data_of(payload)
    if not data:
        return None
    meta = parser.meta_of(payload)
    fetched_at = str(meta.get("fetched_at") or "") or storage.iso_from_latest_datetime(data)
    key = str(fetched_at)[:19]
    if key and key in existing:
        return {"skipped_dup": True, "fetched_at": fetched_at}
    summary = storage.save_groups(
        data, source=source, fetched_at=fetched_at,
        write_snapshot_file=False, write_latest=False,
    )
    if key:
        existing.add(key)
    return summary


async def _list_snapshot_names(slug: str) -> list[str]:
    """通过 GitHub Contents API 列出仓库 ``data/snapshots/`` 下的快照文件名。"""
    if not config.REPO_SYNC_HISTORY:
        return []
    headers = {"User-Agent": config.USER_AGENT, "Accept": "application/vnd.github+json"}
    if config.GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {config.GITHUB_TOKEN}"
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            response = await client.get(api_contents_url(slug), headers=headers)
            if response.status_code != 200:
                log.debug("列出仓库快照目录失败（HTTP %s）", response.status_code)
                return []
            entries = response.json()
    except Exception as exc:  # noqa: BLE001
        log.debug("列出仓库快照目录异常：%s", exc)
        return []
    if not isinstance(entries, list):
        return []
    names = [
        str(e.get("name")) for e in entries
        if isinstance(e, dict) and e.get("type") == "file"
        and str(e.get("name", "")).startswith("summary_")
        and str(e.get("name", "")).endswith(".json")
    ]
    return sorted(names)


async def _download_snapshot(slug: str, name: str) -> Any | None:
    """下载仓库中单个历史快照（raw，无速率限制）。"""
    url = raw_url(slug, f"{config.SNAPSHOT_REPO_DIR}/{name}")
    headers = {"User-Agent": config.USER_AGENT, "Accept": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=config.API_TIMEOUT, follow_redirects=True) as client:
            response = await client.get(url, headers=headers)
            response.raise_for_status()
            return response.json()
    except Exception as exc:  # noqa: BLE001
        log.debug("下载快照 %s 失败：%s", name, exc)
        return None


async def _sync_history(slug: str) -> dict[str, Any]:
    """增量回填：仅下载并入库本地库缺失的仓库历史快照（Action 新抓取即被拉取）。"""
    names = await _list_snapshot_names(slug)
    if not names:
        return {"history_checked": 0, "history_ingested": 0}
    storage.init_db()
    existing = storage.existing_snapshot_stamps()
    todo = [n for n in names if (_name_stamp(n) or "") not in existing]
    ingested = 0
    for name in todo:
        payload = await _download_snapshot(slug, name)
        if payload is None:
            continue
        try:
            res = _ingest_snapshot(payload, existing, source=f"repo:snapshot({name})")
        except Exception as exc:  # noqa: BLE001
            log.warning("入库快照 %s 失败：%s", name, exc)
            continue
        if res and not res.get("skipped_dup"):
            ingested += 1
    if ingested:
        log.info("历史快照增量回填：新增 %s 条（待补 %s 份）", ingested, len(todo))
    return {"history_checked": len(names), "history_pending": len(todo), "history_ingested": ingested}


async def _sync_latest(slug: str) -> dict[str, Any]:
    """兜底同步根目录最新一份 summary.json（仅当比本地新才入库）。"""
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


async def sync_once(*, history: bool = True) -> dict[str, Any]:
    """执行一次仓库同步并记录同步状态，返回状态字典（不抛异常）。

    ``history=True``：先增量回填缺失历史，再兜底同步最新一份；
    ``history=False``：只同步最新一份（启动路径用，避免首屏大量下载）。
    """
    result = await _sync_once(history=history)
    _write_sync_status(result)
    return result


async def _sync_once(*, history: bool = True) -> dict[str, Any]:
    slug = detect_slug()
    if not slug:
        return {"ok": False, "skipped": True, "reason": "未能识别 GitHub 仓库地址（可设置 POE2_REPO_URL）"}
    hist: dict[str, Any] = {"history_checked": 0, "history_ingested": 0}
    if history:
        try:
            hist = await _sync_history(slug)
        except Exception as exc:  # noqa: BLE001
            log.debug("历史增量回填跳过：%s", exc)
    latest = await _sync_latest(slug)
    merged = {**latest, **hist}
    # 历史有新入库即视为一次成功同步（即便根 summary 不比本地新）
    if hist.get("history_ingested"):
        merged["ok"] = True
        merged.pop("skipped", None)
        merged.setdefault("slug", slug)
    return merged


def _write_sync_status(result: dict[str, Any]) -> None:
    """把同步结果写入 fetch_status.json，供看板「同步状态」展示。

    跳过（仓库不比本地新 / 拉取失败）时不重置已有的条目数与汇率，
    改从本地最新快照补齐，避免概览卡显示成 0 条。
    """
    status: dict[str, Any] = {
        "ok": bool(result.get("ok")),
        "at": storage.now_iso(),
        "source": "repo-sync",
        "skipped": bool(result.get("skipped")),
        "item_count": result.get("item_count"),
        "d_to_e": result.get("d_to_e"),
    }
    if status["item_count"] is None or status["d_to_e"] is None:
        snap = storage.latest_snapshot() or {}
        status["item_count"] = snap.get("item_count")
        status["d_to_e"] = snap.get("d_to_e")
    if not result.get("ok"):
        status["error"] = result.get("reason") or "仓库同步失败"
    storage.write_fetch_status(status)


def sync_once_sync(*, history: bool = True) -> dict[str, Any]:
    """同步入口（供线程池 / 定时任务 / 脚本调用）。"""
    import asyncio

    return asyncio.run(sync_once(history=history))


async def startup_sync() -> dict[str, Any]:
    """启动路径：先用本地已 clone 的历史快照快速回填（无网络），
    再同步最新一份；历史目录的增量回填交给定时/手动任务。"""
    backfill_from_local()
    return await sync_once(history=False)


def startup_sync_sync() -> dict[str, Any]:
    import asyncio

    return asyncio.run(startup_sync())


def backfill_from_local() -> dict[str, Any]:
    """一次性把本地 ``data/snapshots/*.json`` 历史快照去重写入 SQLite（无网络）。

    这些文件就是 Actions 提交回仓库、随仓库 clone 到本地的逐小时抓取结果；
    已入库的时间点会被跳过，因此可重复执行（幂等）。
    """
    storage.init_db()
    files = sorted(config.SNAPSHOT_DIR.glob("summary_*.json"))
    existing = storage.existing_snapshot_stamps()
    before = storage.snapshot_count()
    ingested = dup = failed = 0
    for f in files:
        payload = storage.read_json(f, None)
        if not payload:
            failed += 1
            continue
        try:
            res = _ingest_snapshot(payload, existing, source=f"backfill:{f.name}")
        except Exception as exc:  # noqa: BLE001
            log.warning("回填快照 %s 失败：%s", f.name, exc)
            failed += 1
            continue
        if res is None or res.get("skipped_dup"):
            dup += 1
        else:
            ingested += 1
    after = storage.snapshot_count()
    result = {
        "ok": True, "source": "backfill:local",
        "files": len(files), "ingested": ingested,
        "skipped": dup, "failed": failed,
        "snapshot_total": after, "net_new": after - before,
    }
    log.info("本地历史回填完成：文件 %s，新增入库 %s，跳过重复 %s，失败 %s",
             len(files), ingested, dup, failed)
    return result
