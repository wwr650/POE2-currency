#!/usr/bin/env python
"""启动脚本：``python run.py`` → http://127.0.0.1:8000

可用环境变量覆盖：
    POE2_HOST / POE2_PORT          监听地址与端口
    POE2_API_URL                   数据源地址
    POE2_FETCH_INTERVAL_HOURS      抓取间隔（小时，默认 1）
    POE2_FETCH_ON_STARTUP=0        启动时不立即抓取
    POE2_SYNC_REPO_ON_STARTUP=0    启动时不拉取 GitHub 仓库（Actions）更新的数据
    POE2_API_TIMEOUT / POE2_API_RETRIES
"""
from __future__ import annotations

import socket
import sys
import threading
import time
import webbrowser

import uvicorn

from app import config


def open_when_ready(host: str, port: int, timeout: float = 30.0) -> None:
    """后台等待端口可连接后再打开浏览器（一键启动时避免看到「无法访问」页）。

    监听地址为 0.0.0.0 / :: 时改用 127.0.0.1 探测并打开。
    """
    probe = "127.0.0.1" if host in ("0.0.0.0", "", "::", "::1") else host
    url = f"http://{probe}:{port}"

    def worker() -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                with socket.create_connection((probe, port), timeout=0.5):
                    break
            except OSError:
                time.sleep(0.3)
        try:
            webbrowser.open(url)
        except Exception:
            print(f"无法自动打开浏览器，请手动访问 {url}")

    threading.Thread(target=worker, daemon=True).start()


def main() -> int:
    banner = f"""
============================================================
  PoE2 通货价格看板  →  http://{config.HOST}:{config.PORT}
  数据源   : {config.API_URL}
  仓库同步 : {'启动时拉取 GitHub 仓库数据' if config.SYNC_REPO_ON_STARTUP else '已关闭'}
  抓取间隔 : 每 {config.FETCH_INTERVAL_HOURS} 小时
  数据库   : {config.DB_PATH}
  停止服务 : Ctrl + C
============================================================
"""
    print(banner)
    if "--open" in sys.argv:
        open_when_ready(config.HOST, config.PORT)
    uvicorn.run(
        "app.main:app",
        host=config.HOST,
        port=config.PORT,
        reload="--reload" in sys.argv,
        log_level="info",
        access_log=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
