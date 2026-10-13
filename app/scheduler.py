"""APScheduler 封装：每小时同步一次 GitHub 仓库（Actions）抓取的数据，启动时同步一次。

本地直接抓取已移除：数据统一来自 ``.github/workflows/fetch-summary.yml``
定时抓取并提交回仓库的快照，本模块只负责把那份数据拉进本地库。
"""
from __future__ import annotations

import asyncio
import logging

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

from . import config, reposync, storage

log = logging.getLogger(__name__)

_scheduler: BackgroundScheduler | None = None

JOB_ID = "poe2-repo-sync"


def _job() -> None:
    """定时任务（运行在 APScheduler 的工作线程中，可安全使用 asyncio.run）。"""
    result = reposync.sync_once_sync()
    if result.get("skipped"):
        level = log.info if result.get("ok") else log.warning
        level("定时同步跳过：%s", result.get("reason"))
    elif result.get("ok"):
        log.info("定时同步完成：%s 条，汇率 %s", result.get("item_count"), result.get("d_to_e"))
    else:
        log.warning("定时同步失败：%s", result.get("reason"))


def _add_job(scheduler: BackgroundScheduler) -> None:
    if config.REPO_SYNC_INTERVAL_HOURS <= 0:
        log.info("定时仓库同步已禁用（POE2_REPO_SYNC_INTERVAL_HOURS <= 0），启动/手动同步仍可用")
        scheduler.start()
        return
    scheduler.add_job(
        _job,
        trigger=IntervalTrigger(hours=config.REPO_SYNC_INTERVAL_HOURS),
        id=JOB_ID,
        name=f"每 {config.REPO_SYNC_INTERVAL_HOURS} 小时同步 GitHub 仓库（Actions）数据",
        max_instances=1,
        coalesce=True,
        misfire_grace_time=600,
        replace_existing=True,
    )
    scheduler.start()


def seed_baseline() -> None:
    """把已有的 summary.json 导入为基线快照（幂等）。"""
    seeded = storage.seed_from_existing()
    if seeded:
        log.info("已导入基线快照：%s 条", seeded["item_count"])


def _log_repo_sync(result: dict) -> None:
    if result.get("skipped"):
        level = log.info if result.get("ok") else log.warning
        level("仓库数据同步跳过：%s", result.get("reason"))
    else:
        log.info("仓库数据同步完成：%s 条，汇率 %s（来自 %s）",
                 result.get("item_count"), result.get("d_to_e"), result.get("file"))


async def sync_repo_updates() -> dict:
    """启动时拉取 GitHub 仓库（Actions）更新的数据，失败不阻止服务。

    走启动专用链路：先用本地已 clone 的历史快照回填数据库（无网络、秒级），
    再同步最新一份；历史目录的增量拉取由定时/手动任务（``sync_once``）负责。
    """
    if not config.SYNC_REPO_ON_STARTUP:
        return {"ok": True, "skipped": True, "reason": "已禁用（POE2_SYNC_REPO_ON_STARTUP=0）"}
    try:
        return await reposync.startup_sync()
    except Exception as exc:  # noqa: BLE001
        log.warning("仓库数据同步异常：%s", exc)
        return {"ok": False, "skipped": True, "reason": str(exc)}


async def start_async() -> BackgroundScheduler:
    """异步启动：在同一事件循环内完成仓库同步，避免 ``asyncio.run`` 嵌套报错。"""
    global _scheduler
    if _scheduler and _scheduler.running:
        return _scheduler

    seed_baseline()

    _log_repo_sync(await sync_repo_updates())

    scheduler = BackgroundScheduler(timezone="UTC", daemon=True)
    _add_job(scheduler)
    _scheduler = scheduler
    log.info("调度器已启动（仓库同步），间隔 %.1f 小时；下次执行 %s",
             config.REPO_SYNC_INTERVAL_HOURS, next_run_time())
    return scheduler


def start() -> BackgroundScheduler:
    """同步启动（供脚本 / 非异步上下文使用）。"""
    global _scheduler
    if _scheduler and _scheduler.running:
        return _scheduler

    seed_baseline()

    _log_repo_sync(asyncio.run(sync_repo_updates()))

    scheduler = BackgroundScheduler(timezone="UTC", daemon=True)
    _add_job(scheduler)
    _scheduler = scheduler
    log.info("调度器已启动（仓库同步），间隔 %.1f 小时；下次执行 %s",
             config.REPO_SYNC_INTERVAL_HOURS, next_run_time())
    return scheduler


def trigger_now() -> dict:
    """立即执行一次仓库同步任务（与定时任务同一实现，便于验证调度链路）。"""
    return reposync.sync_once_sync()


def shutdown() -> None:
    global _scheduler
    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)
        log.info("调度器已停止")
    _scheduler = None


def status() -> dict:
    jobs = []
    if _scheduler:
        for job in _scheduler.get_jobs():
            jobs.append({
                "id": job.id,
                "name": job.name,
                "next_run": job.next_run_time.isoformat() if job.next_run_time else None,
                "interval_hours": config.REPO_SYNC_INTERVAL_HOURS,
            })
    return {"running": bool(_scheduler and _scheduler.running), "jobs": jobs}


def next_run_time() -> str | None:
    if not _scheduler:
        return None
    job = _scheduler.get_job(JOB_ID)
    if job and job.next_run_time:
        return job.next_run_time.isoformat()
    return None
