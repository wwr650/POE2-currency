"""轻量 JSON 文档存储（自定义道具、收益配置）。

长效保存措施
------------
1. **原子替换**：先写 ``<name>.json.tmp`` 并 fsync，再 ``os.replace``，避免半截文件；
2. **自动备份**：每次成功写入后留一份 ``<name>.json.bak``；
3. **自动恢复**：读取时主文件损坏（JSON 解析失败/被截断）则自动改用 ``.bak``；
4. **原地回退**：受管环境禁止替换既有文件时退回原地覆盖（仍会写备份）。
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)
_LOCK = threading.RLock()


def now_iso() -> str:
    return datetime.now().astimezone().replace(microsecond=0).isoformat()


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def backup_path(path: Path) -> Path:
    return path.with_suffix(path.suffix + ".bak")


def _atomic_write(path: Path, text: str) -> bool:
    """先写临时文件（落盘）再替换；失败时退回原地覆盖。"""
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        return True
    except OSError as exc:
        log.debug("原子写入 %s 失败：%s", path.name, exc)
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass
    try:
        path.write_text(text, encoding="utf-8")
        return True
    except OSError as exc:
        log.error("写入 %s 失败：%s", path, exc)
        return False


def load(path: Path, default: Any) -> Any:
    """读取 JSON；主文件损坏时自动回退到备份。"""
    with _LOCK:
        for candidate in (path, backup_path(path)):
            try:
                text = candidate.read_text(encoding="utf-8")
            except FileNotFoundError:
                continue
            except OSError as exc:
                log.warning("读取 %s 失败：%s", candidate, exc)
                continue
            try:
                data = json.loads(text)
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                log.error("%s 解析失败（%s）", candidate.name, exc)
                continue
            if candidate != path:
                log.warning("已从备份 %s 恢复数据", candidate.name)
            return data
        return default


def save(path: Path, obj: Any) -> None:
    """原子写入并保留一份备份；失败抛 OSError（调用方可见）。"""
    with _LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(obj, ensure_ascii=False, indent=2)
        if not _atomic_write(path, text):
            raise OSError(f"无法写入 {path}")
        backup = backup_path(path)
        try:
            shutil.copyfile(path, backup)          # 备份与主文件内容一致
        except OSError:
            try:
                backup.write_text(text, encoding="utf-8")
            except OSError as exc:
                log.warning("备份 %s 失败：%s", backup.name, exc)
