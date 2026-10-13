#!/usr/bin/env python
"""一次性把 GitHub Actions 抓取的历史数据写入本地数据库。

Actions 每小时把抓取结果提交回仓库的 ``data/snapshots/``，随仓库 clone 到本地。
本脚本把这些历史快照按时间去重后全部写入 SQLite，补齐看板/趋势图的历史点，
不需要网络（读取的是本地已存在的快照文件），且可重复执行（幂等）。

运行：
    .venv\\Scripts\\python.exe scripts\\backfill_snapshots.py
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))

from app import reposync  # noqa: E402


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    result = reposync.backfill_from_local()
    print("本地历史快照回填完成：")
    print(f"  扫描文件 : {result['files']} 份")
    print(f"  新增入库 : {result['ingested']} 条")
    print(f"  跳过重复 : {result['skipped']} 条")
    print(f"  解析失败 : {result['failed']} 条")
    print(f"  库内快照 : {result['net_new']} (净增) → 共 {result['snapshot_total']} 条")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
