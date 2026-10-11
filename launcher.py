#!/usr/bin/env python
"""一键启动引导器（仅用标准库，可用系统 Python 直接运行）。

职责：
1. 没有 ``.venv`` 就自动创建；
2. 依赖不全就自动 ``pip install -r requirements.txt``；
3. 用虚拟环境的 Python 启动 ``run.py``，并自动打开浏览器。

命令行（也可直接把参数写给 ``start.bat``）：
    python launcher.py                正常启动（抓取 + 打开浏览器）
    python launcher.py offline        离线模式，启动时不抓取
    python launcher.py no-browser     不自动打开浏览器
    python launcher.py reload         开启代码热重载
    python launcher.py --port 9000    指定端口（等价环境变量 POE2_PORT）
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
VENV_DIR = BASE_DIR / ".venv"
REQUIREMENTS = BASE_DIR / "requirements.txt"
#: 需要探测的第三方包（模块名 -> 安装名，二者一致即可）
DEPS = ("fastapi", "uvicorn", "httpx", "apscheduler", "jinja2", "pydantic", "multipart")


def venv_python() -> Path:
    if os.name == "nt":
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def log(msg: str) -> None:
    print(f"[启动] {msg}", flush=True)


def fail(msg: str, hint: str = "") -> int:
    print(f"\n[失败] {msg}", flush=True)
    if hint:
        print(hint, flush=True)
    if os.name == "nt":
        try:
            input("\n按回车键退出...")
        except Exception:
            pass
    return 1


# ---------------------------------------------------------------- 参数解析
def parse_args(argv: list[str]) -> tuple[list[str], bool]:
    """返回 (传给 run.py 的参数, 是否离线)。"""
    run_args: list[str] = ["--open"]
    offline = False
    i = 0
    while i < len(argv):
        a = argv[i].lower()
        if a == "offline":
            offline = True
        elif a in ("no-browser", "no_open"):
            run_args = [x for x in run_args if x != "--open"]
        elif a == "reload":
            run_args.append("--reload")
        elif a in ("--port", "-p") and i + 1 < len(argv):
            os.environ["POE2_PORT"] = argv[i + 1]
            i += 1
        elif a.startswith("--port="):
            os.environ["POE2_PORT"] = a.split("=", 1)[1]
        else:
            # 其余参数（含未知选项）原样转交给 run.py
            run_args.append(argv[i])
        i += 1
    return run_args, offline


# ---------------------------------------------------------------- 虚拟环境
def ensure_venv() -> int:
    py = venv_python()
    if py.exists():
        return 0
    log("首次运行：正在创建虚拟环境 .venv ...")
    cmd = [sys.executable, "-m", "venv", str(VENV_DIR)]
    if subprocess.call(cmd) != 0:
        return fail(
            "虚拟环境创建失败。",
            "请确认 Python 3.9+ 已正确安装，或手动执行：python -m venv .venv",
        )
    return 0


def deps_missing(py: Path) -> list[str]:
    """在目标解释器里检查依赖是否齐全（返回缺失的包名）。"""
    code = (
        "import importlib.util,sys;"
        "n=[m for m in sys.argv[1].split(',') if importlib.util.find_spec(m) is None];"
        "print(','.join(n));sys.exit(1 if n else 0)"
    )
    try:
        out = subprocess.run(
            [str(py), "-c", code, ",".join(DEPS)],
            capture_output=True, text=True, timeout=120,
        )
        missing = (out.stdout or "").strip().split(",")
        return [m for m in missing if m]
    except Exception:
        return list(DEPS)


def ensure_deps(py: Path) -> int:
    missing = deps_missing(py)
    if not missing:
        log("依赖已就绪")
        return 0
    log(f"正在安装依赖（缺少：{', '.join(missing)}），请耐心等待 ...")
    cmds = [
        [str(py), "-m", "pip", "install", "--upgrade", "pip"],
        [str(py), "-m", "pip", "install", "-r", str(REQUIREMENTS)],
    ]
    for c in cmds:
        if subprocess.call(c) != 0:
            return fail(
                "依赖安装失败，通常是网络无法访问 PyPI。",
                "可换镜像源手动安装：\n"
                f'  "{py}" -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple',
            )
    return 0


# ---------------------------------------------------------------- 主流程
def main() -> int:
    run_args, offline = parse_args(sys.argv[1:])
    if offline:
        os.environ["POE2_FETCH_ON_STARTUP"] = "0"
    port = os.environ.get("POE2_PORT", "8000")

    if sys.version_info < (3, 9):
        return fail(f"需要 Python 3.9 及以上，当前为 {sys.version.split()[0]}。")

    print("=" * 60)
    print("  PoE2 通货价格看板 · 一键启动")
    print(f"  项目目录 : {BASE_DIR}")
    print(f"  访问地址 : http://127.0.0.1:{port}")
    print("  运行模式 : " + ("离线（不抓取）" if offline else "在线（启动即抓取）"))
    print("  停止服务 : 按 Ctrl + C，或直接关闭本窗口")
    print("=" * 60, flush=True)

    if REQUIREMENTS.exists() is False:
        return fail("未找到 requirements.txt，请在项目根目录运行本脚本。")
    if ensure_venv():
        return 1
    py = venv_python()
    if not py.exists():
        return fail(f"虚拟环境缺少 {py}，请删除 .venv 目录后重试。")
    if ensure_deps(py):
        return 1

    log("正在启动服务 ... 首次启动会导入本地快照并抓取一次数据")
    time.sleep(0.5)
    target = str(BASE_DIR / "run.py")
    try:
        return subprocess.call([str(py), target, *run_args])
    except KeyboardInterrupt:
        print("\n[已停止] 收到 Ctrl+C，服务已退出。", flush=True)
        return 0
    except Exception as exc:  # pragma: no cover
        return fail(f"启动异常：{exc}")


if __name__ == "__main__":
    raise SystemExit(main())
