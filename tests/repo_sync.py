#!/usr/bin/env python
"""仓库数据同步自检（无需网络）。

检查项：
1. 仓库地址识别：``POE2_REPO_URL`` 环境变量、``.git/config`` 的 origin、非法值；
2. 原始文件 URL 拼接与分支覆盖；
3. 「仓库数据是否比本地新」的判定（更新 / 更旧 / 相同 / 非法 / 跨时区）；
4. 导入行为：用假响应跑一遍 ``sync_once``，只入库一次、重复调用跳过、
   拉取失败不入库也不抛异常；
5. 启动流程：``scheduler`` 只做仓库同步（本地抓取已移除）；
   ``POE2_SYNC_REPO_ON_STARTUP=0`` 时不发请求。
6. 启动链路会向仓库比对并补拉缺失的历史快照（受 ``POE2_REPO_SYNC_STARTUP_HISTORY``
   上限约束），且「最新一份」按 ``fetched_at`` 取，补入旧快照不会让看板回退。

运行：``.venv\\Scripts\\python.exe tests\\repo_sync.py``
"""
from __future__ import annotations

import asyncio
import gc
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))

# 失败列表里有「✗」，GBK 控制台下直接 print 会报错并遮没真正的问题
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - 已被重定向等场景，忽略
        pass

ok = 0
fail: list[str] = []


def check(name: str, cond) -> None:
    global ok
    if cond is True:
        ok += 1
    else:
        fail.append(f"{name}（实际：{cond!r}）")


class temp_env:
    """临时设置/清除环境变量（值为 None 表示清除）。"""

    def __init__(self, **keys: str | None):
        self.keys = keys

    def __enter__(self):
        self.saved = {k: os.environ.get(k) for k in self.keys}
        for k, v in self.keys.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        return self

    def __exit__(self, *exc):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        return False


from app import config, reposync, scheduler, storage  # noqa: E402

# ------------------------------------------------------------------ 1) 地址识别
with temp_env(POE2_REPO_URL=None, POE2_REPO_SLUG=None):
    slug = reposync.detect_slug()
    check("从 .git/config 识别仓库", bool(slug) and "/" in str(slug))

with temp_env(POE2_REPO_URL="https://github.com/owner/repo.git", POE2_REPO_SLUG=None):
    check("POE2_REPO_URL（含 .git）优先", reposync.detect_slug() == "owner/repo")

with temp_env(POE2_REPO_URL="https://github.com/owner/repo/", POE2_REPO_SLUG="a/b"):
    check("结尾斜杠被清理", reposync.detect_slug() == "owner/repo")

with temp_env(POE2_REPO_URL="owner/repo", POE2_REPO_SLUG=None):
    check("直接给 owner/repo", reposync.detect_slug() == "owner/repo")

with temp_env(POE2_REPO_URL="not a url", POE2_REPO_SLUG=None):
    check("非法值不误判", reposync.env_repo_slug() is None)

check("ssh 形式也能识别",
      reposync._slug_from_text("git@github.com:wwr650/POE2-currency.git") == "wwr650/POE2-currency")

# ------------------------------------------------------------------ 2) URL 拼接
real_branch = config.REPO_BRANCH
try:
    config.REPO_BRANCH = "main"
    check("默认分支 main", reposync.raw_url("o/r", "summary.json").endswith("/main/summary.json"))
    config.REPO_BRANCH = "dev"
    check("分支可覆盖", reposync.raw_url("o/r", "data/summary.json").endswith("/dev/data/summary.json"))
    check("拼接完整地址", reposync.raw_url("o/r", "summary.json")
          == "https://raw.githubusercontent.com/o/r/dev/summary.json")
finally:
    config.REPO_BRANCH = real_branch

# 快照文件名时间戳解析与 API 地址拼接（纯函数，无需网络/数据库）
check("文件名时间戳解析",
      reposync._name_stamp("summary_20261013_133124.json") == "2026-10-13T13:31:24")
check("文件名时间戳（含随机后缀）",
      reposync._name_stamp("summary_20261013_133124_abcd.json") == "2026-10-13T13:31:24")
check("Contents API 地址", "/contents/data/snapshots?ref=" in reposync.api_contents_url("o/r"))

# ------------------------------------------------------------------ 3) 新旧判定
real_latest = storage.latest_snapshot
storage.latest_snapshot = lambda: {"fetched_at": "2026-10-11T12:00:00+08:00"}
try:
    check("仓库更旧则跳过", reposync._newer_than_local("2026-10-11T10:00:00+08:00") is False)
    check("仓库更新则导入", reposync._newer_than_local("2026-10-11T14:00:00+08:00") is True)
    check("时间相同不重复入库", reposync._newer_than_local("2026-10-11T12:00:00+08:00") is False)
    check("无时间不入库", reposync._newer_than_local(None) is False)
    check("非法时间不入库", reposync._newer_than_local("昨天") is False)
    # 跨时区比较：04:30Z = 12:30+08:00（更新），03:00Z = 11:00+08:00（更旧）
    check("跨时区按绝对时刻比较",
          reposync._newer_than_local("2026-10-11T04:30:00+00:00") is True
          and reposync._newer_than_local("2026-10-11T03:00:00+00:00") is False)
finally:
    storage.latest_snapshot = real_latest


def drop_tmp(directory: Path) -> None:
    """清理临时目录（先收回可能还持着数据库文件引用的对象）。"""
    gc.collect()
    for _ in range(10):
        shutil.rmtree(directory, ignore_errors=True)
        if not directory.exists():
            return
        time.sleep(0.2)


# ------------------------------------------------------------------ 4) 导入行为（隔离到临时目录，用完自动清理）
tmp = Path(tempfile.mkdtemp(prefix="poe2_repo_sync_"))
PATH_ATTRS = ("DATA_DIR", "SNAPSHOT_DIR", "LOG_DIR", "DB_PATH",
              "INDEX_JSON", "LATEST_JSON", "LATEST_META_JSON")
real_paths = {a: getattr(config, a) for a in PATH_ATTRS}
config.DATA_DIR = tmp
config.SNAPSHOT_DIR = tmp / "snapshots"
config.LOG_DIR = tmp / "logs"
config.DB_PATH = tmp / "prices.db"
config.INDEX_JSON = tmp / "index.json"
config.LATEST_JSON = tmp / "summary.json"
config.LATEST_META_JSON = tmp / "data_summary.json"
config.SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)

#: 与数据源同构的最小快照（裸数组，无元数据，与仓库根 summary.json 一致）
FAKE_GROUPS = [
    {"category_label": "通货仓库", "items": [
        {"item_name": "神圣石", "engname": "Divine Orb", "currency_unit": "e",
         "buy_avg": 1000, "sell_avg": 1010, "latest_datetime": "2026-10-11 10:00:00"},
        {"item_name": "混沌石", "engname": "Chaos Orb", "currency_unit": "d",
         "buy_avg": 1, "sell_avg": 1, "latest_datetime": "2026-10-11 09:50:00"},
    ]},
    {"category_label": "装备", "items": [
        {"item_name": "卡兰德的魔镜", "engname": "Mirror of Kalandra", "currency_unit": "e",
         "buy_avg": 20000, "sell_avg": 21000, "latest_datetime": "2026-10-11 10:00:00"},
    ]},
]


async def fake_found(slug, payload=FAKE_GROUPS, path="summary.json"):
    return {"path": path, "payload": payload}


async def fake_missing(slug):
    return None


async def boom(slug):
    raise AssertionError("开关关闭时不应访问仓库")


async def fake_no_names(slug):
    """默认不让历史目录同步走真实网络（自检标榜“无需网络”）。"""
    return []


def boom_now(*_a, **_kw):
    raise AssertionError("开关关闭时不应访问仓库")


storage.init_db()
count0 = storage.snapshot_count()
real_slug, real_fetch = reposync.detect_slug, reposync.fetch_repo_payload
real_list = reposync._list_snapshot_names
real_flag = config.SYNC_REPO_ON_STARTUP
try:
    reposync.detect_slug = lambda: "o/r"
    reposync.fetch_repo_payload = fake_found
    reposync._list_snapshot_names = fake_no_names

    r1 = asyncio.run(reposync.sync_once())
    check("空库时导入仓库数据", r1.get("ok") is True and "skipped" not in r1)
    check("条目数正确", r1.get("item_count") == 3)
    check("来源标记为仓库", str(r1.get("source")).startswith("repo:github"))
    check("快照数 +1", storage.snapshot_count() == count0 + 1)
    check("抓取时间取自 latest_datetime",
          str(storage.latest_snapshot()["fetched_at"]).startswith("2026-10-11T10:00"))
    check("不回写根 summary.json（仓库产物不动）", not config.LATEST_JSON.exists())
    check("汇率仍被提取", (storage.latest_snapshot()["d_to_e"] or 0) > 0)

    r2 = asyncio.run(reposync.sync_once())
    check("重复同步跳过", r2.get("ok") is True and r2.get("skipped") is True)
    check("跳过时不新增快照", storage.snapshot_count() == count0 + 1)

    reposync.fetch_repo_payload = fake_missing
    r3 = asyncio.run(reposync.sync_once())
    check("拉取失败时不入库", r3.get("ok") is False and r3.get("skipped") is True)
    check("失败原因可读", bool(r3.get("reason")))
    check("失败不新增快照", storage.snapshot_count() == count0 + 1)

    # 带元数据的 data/summary.json：直接用 fetched_at，不靠 latest_datetime 推算
    async def fake_meta(slug):
        return {"path": "data/summary.json", "payload": {
            "fetched_at": "2026-10-11T18:30:00+08:00", "source": "github-actions", "data": FAKE_GROUPS}}

    reposync.fetch_repo_payload = fake_meta
    r4 = asyncio.run(reposync.sync_once())
    check("优先采用元数据时间", r4.get("ok") is True
          and str(r4.get("fetched_at")).startswith("2026-10-11T18:30"))

    # 关闭开关：启动流程不发任何请求
    reposync.fetch_repo_payload = boom
    reposync.detect_slug = boom_now
    config.SYNC_REPO_ON_STARTUP = False
    r5 = asyncio.run(scheduler.sync_repo_updates())
    check("开关关闭时跳过", r5.get("ok") is True and r5.get("skipped") is True)
    check("开关关闭时未访问仓库", "不应访问仓库" not in str(r5.get("reason")))

    # 同步过程中抛异常也不能拖垮启动流程
    config.SYNC_REPO_ON_STARTUP = True
    r6 = asyncio.run(scheduler.sync_repo_updates())
    check("同步异常被吞掉并降级", r6.get("ok") is False and r6.get("skipped") is True)
finally:
    reposync.detect_slug, reposync.fetch_repo_payload = real_slug, real_fetch
    reposync._list_snapshot_names = real_list
    config.SYNC_REPO_ON_STARTUP = real_flag
    for attr, value in real_paths.items():
        setattr(config, attr, value)
    drop_tmp(tmp)

# ------------------------------------------------- 4b) 启动补拉缺失历史 + 「最新一份」按时间取
tmp2 = Path(tempfile.mkdtemp(prefix="poe2_startup_sync_"))
config.DATA_DIR = tmp2
config.SNAPSHOT_DIR = tmp2 / "snapshots"
config.LOG_DIR = tmp2 / "logs"
config.DB_PATH = tmp2 / "prices.db"
config.INDEX_JSON = tmp2 / "index.json"
config.LATEST_JSON = tmp2 / "summary.json"
config.LATEST_META_JSON = tmp2 / "data_summary.json"
config.SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)


def envelope(stamp: str) -> dict:
    """造一份与仓库 ``data/snapshots/`` 同构的信封（带 fetched_at 元数据）。"""
    d, t = stamp.split("_")
    return {
        "fetched_at": f"{d[0:4]}-{d[4:6]}-{d[6:8]}T{t[0:2]}:{t[2:4]}:{t[4:6]}+08:00",
        "source": "github-actions", "data": FAKE_GROUPS,
    }


STAMPS3 = ["20261011_080000", "20261011_090000", "20261011_100000"]
STAMPS5 = ["20261011_060000", "20261011_070000"] + STAMPS3


async def names_of(*stamps: str):
    return [f"summary_{s}.json" for s in stamps[0]]


async def download_of(*stamps: str):
    return envelope(str(stamps[1])[len("summary_"):-len(".json")])


real_download = reposync._download_snapshot
real_limit = config.REPO_SYNC_STARTUP_HISTORY
try:
    reposync.detect_slug = lambda: "o/r"
    reposync.fetch_repo_payload = fake_missing  # 根 summary 拉不到：只能靠历史比对
    reposync._list_snapshot_names = lambda slug: names_of(STAMPS3)
    reposync._download_snapshot = lambda slug, name: download_of(STAMPS3, name)
    storage.init_db()

    r = asyncio.run(reposync.startup_sync())
    check("启动会补拉仓库缺失的历史快照", r.get("history_ingested") == 3 and storage.snapshot_count() == 3)
    check("补拉即视为同步成功（根文件拉不到也不跳过）", r.get("ok") is True and not r.get("skipped"))
    check("同步来源标注为快照目录", str(r.get("file")).startswith("data/snapshots"))
    check("最新一份按时间而非入库顺序",
          str(storage.latest_snapshot()["fetched_at"]).startswith("2026-10-11T10:00"))
    check("最新汇率同样按时间取",
          str((storage.latest_rate() or {}).get("fetched_at")).startswith("2026-10-11T10:00"))

    r = asyncio.run(reposync.startup_sync())
    check("重复启动不重复下载", r.get("history_ingested") == 0 and storage.snapshot_count() == 3)

    # 仓库确实无新增（根文件不比本地新）时，跳过原因要说明「已经比对过仓库」
    reposync.fetch_repo_payload = fake_found
    r = asyncio.run(reposync.startup_sync())
    check("无新增时仍为一次成功同步", r.get("ok") is True and r.get("skipped") is True)
    check("无新增时说明已比对仓库", "已比对仓库 3 份" in str(r.get("reason")))
    reposync.fetch_repo_payload = fake_missing

    # 上限生效：只补拉最近 N 份，且补入更早的快照不会让「最新一份」回退
    config.DB_PATH = tmp2 / "prices2.db"
    config.REPO_SYNC_STARTUP_HISTORY = 2
    reposync._list_snapshot_names = lambda slug: names_of(STAMPS5)
    reposync._download_snapshot = lambda slug, name: download_of(STAMPS5, name)
    storage.init_db()

    r = asyncio.run(reposync.startup_sync())
    check("启动补拉受上限约束", r.get("history_ingested") == 2 and storage.snapshot_count() == 2)
    check("上限内优先补最新的", sorted(storage.existing_snapshot_stamps())
          == ["2026-10-11T09:00:00", "2026-10-11T10:00:00"])
    r = asyncio.run(reposync.startup_sync())
    check("下一轮继续补更早的缺口", r.get("history_ingested") == 2 and storage.snapshot_count() == 4)
    check("补入更早快照后最新一份不回退",
          str(storage.latest_snapshot()["fetched_at"]).startswith("2026-10-11T10:00"))

    # 上限为 0：启动不列历史目录，只同步最新一份
    config.DB_PATH = tmp2 / "prices3.db"
    config.REPO_SYNC_STARTUP_HISTORY = 0
    storage.init_db()

    listed: list[str] = []

    async def spy_list(slug):
        listed.append(slug)
        return []

    reposync._list_snapshot_names = spy_list
    r = asyncio.run(reposync.startup_sync())
    check("上限为 0 时不列历史目录", not listed and r.get("history_checked") == 0)
    check("上限为 0 时仍会兜底拉最新一份", r.get("ok") is False and bool(r.get("reason")))
finally:
    reposync.detect_slug, reposync.fetch_repo_payload = real_slug, real_fetch
    reposync._list_snapshot_names, reposync._download_snapshot = real_list, real_download
    config.REPO_SYNC_STARTUP_HISTORY = real_limit
    for attr, value in real_paths.items():
        setattr(config, attr, value)
    drop_tmp(tmp2)

# ------------------------------------------------------------------ 5) 调度器只接入仓库同步（本地抓取已移除）
src = (BASE / "app" / "scheduler.py").read_text(encoding="utf-8")
check("调度器不再依赖 fetcher（本地抓取已移除）", "fetcher" not in src)
check("定时任务为仓库同步", "reposync.sync_once_sync()" in src
      and "REPO_SYNC_INTERVAL_HOURS" in src)
check("异步启动接入仓库同步", "await sync_repo_updates()" in src)
check("同步启动同样接入", src.count("_log_repo_sync(") >= 2)
rsrc = (BASE / "app" / "reposync.py").read_text(encoding="utf-8")
check("同步结果写入 fetch_status", "write_fetch_status" in rsrc)
check("同步会增量回填历史目录", "_sync_history" in rsrc and "_list_snapshot_names" in rsrc)
check("提供本地历史一次性回填入口",
      "def backfill_from_local" in rsrc and "existing_snapshot_stamps" in rsrc)
check("启动走本地回填+仓库历史比对",
      "startup_sync" in src and "backfill_from_local()" in rsrc
      and "history_limit=config.REPO_SYNC_STARTUP_HISTORY" in rsrc)
check("启动补拉份数可配置", "REPO_SYNC_STARTUP_HISTORY" in (BASE / "app" / "config.py").read_text(encoding="utf-8"))

print(f"仓库数据同步自检：通过 {ok} 项，失败 {len(fail)} 项")
for name in fail:
    print("  ✗", name)
sys.exit(1 if fail else 0)
