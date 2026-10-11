"""APScheduler 封装：每小时抓取一次，启动时立即抓取一次。"""
from __future__ import annotations

import logging

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

from . import config, fetcher, storage

log = logging.getLogger(__name__)

_scheduler: BackgroundScheduler | None = None

JOB_ID = "poe2-price-fetch"


def _job() -> None:
    """定时任务（运行在 APScheduler 的工作线程中，可安全使用 asyncio.run）。"""
    status = fetcher.fetch_and_store_sync(source="scheduled")
    if status.get("ok"):
        log.info("定时抓取完成：%s 条，汇率 %s", status.get("item_count"), status.get("d_to_e"))
    else:
        log.warning("定时抓取失败：%s", status.get("error"))


def _add_job(scheduler: BackgroundScheduler) -> None:
    scheduler.add_job(
        _job,
        trigger=IntervalTrigger(hours=config.FETCH_INTERVAL_HOURS),
        id=JOB_ID,
        name=f"每 {config.FETCH_INTERVAL_HOURS} 小时抓取 PoE2 通货价格",
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


async def start_async() -> BackgroundScheduler:
    """异步启动：在同一事件循环内完成首抓，避免 ``asyncio.run`` 嵌套报错。"""
    global _scheduler
    if _scheduler and _scheduler.running:
        return _scheduler

    seed_baseline()

    if config.FETCH_ON_STARTUP:
        status = await fetcher.fetch_and_store(source="startup")
        if status.get("ok"):
            log.info("启动首抓完成：%s 条", status.get("item_count"))
        else:
            log.warning("启动首抓失败（保留本地数据继续服务）：%s", status.get("error"))

    scheduler = BackgroundScheduler(timezone="UTC", daemon=True)
    _add_job(scheduler)
    _scheduler = scheduler
    log.info("调度器已启动，间隔 %.1f 小时；下次执行 %s",
             config.FETCH_INTERVAL_HOURS, next_run_time())
    return scheduler


def start() -> BackgroundScheduler:
    """同步启动（供脚本 / 非异步上下文使用）。"""
    global _scheduler
    if _scheduler and _scheduler.running:
        return _scheduler

    seed_baseline()

    if config.FETCH_ON_STARTUP:
        status = fetcher.fetch_and_store_sync(source="startup")
        if status.get("ok"):
            log.info("启动首抓完成：%s 条", status.get("item_count"))
        else:
            log.warning("启动首抓失败（保留本地数据继续服务）：%s", status.get("error"))

    scheduler = BackgroundScheduler(timezone="UTC", daemon=True)
    _add_job(scheduler)
    _scheduler = scheduler
    log.info("调度器已启动，间隔 %.1f 小时；下次执行 %s",
             config.FETCH_INTERVAL_HOURS, next_run_time())
    return scheduler


def trigger_now() -> dict:
    """立即执行一次抓取任务（与定时任务同一实现，便于验证调度链路）。"""
    return fetcher.fetch_and_store_sync(source="trigger")


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
                "interval_hours": config.FETCH_INTERVAL_HOURS,
            })
    return {"running": bool(_scheduler and _scheduler.running), "jobs": jobs}


def next_run_time() -> str | None:
    if not _scheduler:
        return None
    job = _scheduler.get_job(JOB_ID)
    if job and job.next_run_time:
        return job.next_run_time.isoformat()
    return None
