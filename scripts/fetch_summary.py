#!/usr/bin/env python
"""定时抓取入口：调用项目抓取管线拉取一次 summary 数据并落盘。

设计给 GitHub Actions 的 ``schedule`` 定时任务使用：

    python scripts/fetch_summary.py

成功后会更新根目录 ``summary.json``（与数据源同构的原始数组）以及
``data/snapshots/`` 下的带时间戳快照，由工作流提交回仓库。

可用环境变量（与 app/config.py 一致）：
    POE2_API_URL        数据源地址
    POE2_API_TIMEOUT    单次请求超时（秒）
    POE2_API_RETRIES    失败重试次数
"""
from __future__ import annotations

import sys
from pathlib import Path

# 无论从何处运行，都能 import 到项目根的 app 包
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import fetcher  # noqa: E402


def main() -> int:
    status = fetcher.fetch_and_store_sync(source="github-actions")
    if status.get("ok"):
        print(
            "✅ 抓取成功：条目 {item_count} / 错误 {error_count}，"
            "汇率 d→e={d_to_e}，快照 {snapshot_file}".format(**status)
        )
        return 0
    print(f"❌ 抓取失败：{status.get('error')}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
