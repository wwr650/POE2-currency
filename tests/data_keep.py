#!/usr/bin/env python
"""数据保全自检：确认测试套件**不会删除用户的自定义道具 / 收益配置**。

背景：早期版本的测试为了断言干净会清空 custom_items.json，导致用户的
自定义道具“自己消失”。本自检先造一条用户数据（哨兵），跑完所有套件后
再检查它是否仍在，并顺带验证 JSON 存储的备份与恢复能力。

运行：``.venv\\Scripts\\python.exe tests\\data_keep.py``
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))

import httpx  # noqa: E402

from app import config  # noqa: E402

API = "http://127.0.0.1:8000"
PY = str(BASE / ".venv" / "Scripts" / "python.exe")
if not Path(PY).exists():
    PY = sys.executable

ok = 0
fail: list[str] = []


def check(name: str, cond: bool, extra: str = "") -> None:
    global ok
    if cond:
        ok += 1
    else:
        fail.append(name + (f"（{extra}）" if extra else ""))


def run(cmd: list[str]) -> int:
    return subprocess.run(cmd, cwd=str(BASE), capture_output=True, text=True,
                          encoding="utf-8", errors="replace").returncode


with httpx.Client(base_url=API, timeout=60) as c:
    # 0) 服务在线
    try:
        health = c.get("/api/health").json()
        check("服务在线", health.get("ok") is True)
    except Exception as exc:  # noqa: BLE001
        print(f"服务不可用（请先启动）：{exc}")
        raise SystemExit(2)

    # 1) 哨兵数据：一条自定义道具 + 一个收益配置
    sentinel_name = "哨兵-请勿删除"
    for it in c.get("/api/custom-items").json()["items"]:
        if it["name"] == sentinel_name:
            c.delete("/api/custom-items/" + it["id"])
    sentinel = c.post("/api/custom-items", json={
        "name": sentinel_name, "engname": "Sentinel Item", "unit": "d", "price": 9.99,
    }).json()["item"]
    check("已建立哨兵自定义道具", bool(sentinel.get("id")))

    cfg = c.post("/api/profit/save", json={
        "name": "哨兵配置", "display_unit": "d", "minutes_per_run": 5,
        "ticket": [{"engname": "Divine Orb", "qty": 1, "price_source": "sell_avg"}],
        "drops": [{"engname": "Chaos Orb", "qty": 1, "chance": 10, "price_source": "sell_avg", "enabled": True}],
    }).json()
    check("已建立哨兵收益配置", bool(cfg.get("id")))

    # 2) 磁盘上应有主文件与备份文件
    for path, label in ((config.CUSTOM_ITEMS, "自定义道具"),):
        check(f"{label} 主文件存在", path.exists())
        check(f"{label} 备份文件存在", path.with_suffix(path.suffix + ".bak").exists())
    on_disk = json.loads(config.CUSTOM_ITEMS.read_text(encoding="utf-8"))
    check("哨兵已落盘", any(i.get("name") == sentinel_name for i in on_disk))

    # 3) 主文件损坏 → 自动从备份恢复
    original = config.CUSTOM_ITEMS.read_text(encoding="utf-8")
    config.CUSTOM_ITEMS.write_text('{"corrupted": ', encoding="utf-8")
    recovered = c.get("/api/custom-items").json()
    check("主文件损坏后可自动从备份恢复",
          any(i.get("name") == sentinel_name for i in recovered.get("items", [])),
          f"读到 {recovered.get('count')} 个")
    config.CUSTOM_ITEMS.write_text(original, encoding="utf-8")

    # 4) 导出 / 导入（长效保存契约）
    exported = c.get("/api/backup/export").json()
    check("导出备份格式正确", exported.get("format") == "poe2-dashboard-backup")
    check("导出包含自定义道具", any(i.get("name") == sentinel_name for i in exported.get("custom_items", [])))
    check("导出包含收益配置", any(x.get("name") == "哨兵配置" for x in exported.get("profit_configs", [])))

    # 5) 跑所有测试套件（这些套件绝不能动用户数据）
    suites = [
        ([PY, "-X", "utf8", "tests/acceptance.py"], "后端端到端"),
        ([PY, "-X", "utf8", "tests/one_click.py"], "一键启动自检"),
        (["node", "tests/frontend-smoke.js"], "前端冒烟"),
        (["node", "tests/render-check.js"], "真实数据渲染"),
        (["node", "tests/profit-interaction.js"], "收益页交互"),
        (["node", "tests/unit-price-regression.js"], "首屏单价回归"),
    ]
    for cmd, label in suites:
        code = run(cmd)
        check(f"{label} 套件本身通过", code == 0, f"exit={code}")

    # 6) 关键：跑完之后用户数据仍在
    items = c.get("/api/custom-items").json()["items"]
    check("跑完所有套件后 哨兵自定义道具仍在",
          any(i["name"] == sentinel_name for i in items),
          f"现有 {[i['name'] for i in items]}")
    configs = c.get("/api/profit/configs").json()["items"]
    check("跑完所有套件后 哨兵收益配置仍在", any(x.get("name") == "哨兵配置" for x in configs))

    # 7) 收尾：只清理哨兵自己
    c.delete("/api/custom-items/" + sentinel["id"])
    if cfg.get("id"):
        c.delete("/api/profit/configs/" + cfg["id"])
    check("哨兵已清理", not any(i["name"] == sentinel_name
                            for i in c.get("/api/custom-items").json()["items"]))

print(f"数据保全自检：通过 {ok} 项，失败 {len(fail)} 项")
for name in fail:
    print("  ✗", name)
sys.exit(1 if fail else 0)
