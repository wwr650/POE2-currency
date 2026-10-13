#!/usr/bin/env python
"""一键启动脚本自检（无需网络、无需浏览器）。

检查项：
1. ``start.bat`` 只含 ASCII 字节、且引用了 launcher.py；
2. ``launcher.py`` 的参数解析（offline / no-browser / reload / --port）；
3. 依赖探测函数在虚拟环境可用时返回「无缺失」；
4. ``run.py`` 的 open_when_ready 会在端口可连后才打开浏览器，
   且 0.0.0.0 会被换成 127.0.0.1。

运行：``.venv\\Scripts\\python.exe tests\\one_click.py``
"""
from __future__ import annotations

import socket
import os
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))

import launcher  # noqa: E402
import run as run_mod  # noqa: E402

ok = 0
fail: list[str] = []


def check(name: str, cond: bool) -> None:
    global ok
    if cond:
        ok += 1
    else:
        fail.append(name)


# 1) start.bat 必须纯 ASCII（含中文会被某些控制台代码页解析成乱码命令）
bat = (BASE / "start.bat").read_bytes()
check("start.bat 存在", bool(bat))
check("start.bat 全 ASCII", all(b < 128 for b in bat))
check("start.bat CRLF 换行", b"\r\n" in bat)
text = bat.decode("ascii")
check("start.bat 调用 launcher.py", "launcher.py" in text)
check("start.bat 找不到 Python 时提示", ":no_python" in text)
check("start.bat 失败时保留窗口", "pause" in text)

# 2) 参数解析
saved_port = os.environ.get("POE2_PORT")
try:
    args, off = launcher.parse_args([])
    check("默认打开浏览器", args == ["--open"] and off is False)
    args, off = launcher.parse_args(["offline"])
    check("offline 不同步仓库", off is True)
    args, off = launcher.parse_args(["no-browser"])
    check("no-browser 去掉 --open", args == [])
    args, _ = launcher.parse_args(["reload"])
    check("reload 透传", "--reload" in args and "--open" in args)
    args, _ = launcher.parse_args(["--port", "9010"])
    check("--port 生效", os.environ.get("POE2_PORT") == "9010")
finally:
    if saved_port is None:
        os.environ.pop("POE2_PORT", None)
    else:
        os.environ["POE2_PORT"] = saved_port
    os.environ.pop("POE2_SYNC_REPO_ON_STARTUP", None)

# 3) 依赖探测（虚拟环境已就绪时不应缺失）
py = launcher.venv_python()
check("venv python 存在", py.exists())
check("依赖探测无缺失", launcher.deps_missing(py) == [])
check("launcher 仅用标准库", "import fastapi" not in (BASE / "launcher.py").read_text(encoding="utf-8"))

# 4) 端口就绪后才打开浏览器（先取一个空闲端口，监听后才会触发打开）
opened: list[str] = []
real_open = run_mod.webbrowser.open
run_mod.webbrowser.open = lambda url: opened.append(url)  # type: ignore
probe = socket.socket()
probe.bind(("127.0.0.1", 0))
port = probe.getsockname()[1]
probe.close()  # 此时无人监听，连接会被拒绝
srv = None
try:
    run_mod.open_when_ready("0.0.0.0", port, timeout=10)
    time.sleep(1.0)
    check("服务未就绪时不打开浏览器", opened == [])
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port))
    srv.listen(1)
    for _ in range(60):
        if opened:
            break
        time.sleep(0.1)
    check("端口就绪后自动打开浏览器", opened == [f"http://127.0.0.1:{port}"])
    check("监听地址 0.0.0.0 换算为 127.0.0.1", all("0.0.0.0" not in u for u in opened))
finally:
    run_mod.webbrowser.open = real_open  # type: ignore
    if srv is not None:
        srv.close()

print(f"一键启动自检：通过 {ok} 项，失败 {len(fail)} 项")
for name in fail:
    print("  ✗", name)
sys.exit(1 if fail else 0)
