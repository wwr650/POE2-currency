"""全局配置：数据源、路径、抓取间隔。"""
from __future__ import annotations

import os
from pathlib import Path

# ---------------------------------------------------------------- 路径
BASE_DIR = Path(__file__).resolve().parent.parent

DATA_DIR = BASE_DIR / "data"
SNAPSHOT_DIR = DATA_DIR / "snapshots"
TEMPLATE_DIR = Path(__file__).resolve().parent / "templates"
STATIC_DIR = Path(__file__).resolve().parent / "static"

#: 最新快照（项目根目录，需求指定，便于用户直接查看）
LATEST_JSON = BASE_DIR / "summary.json"
#: 带元数据的最新快照
LATEST_META_JSON = DATA_DIR / "summary.json"
#: 历史快照索引
INDEX_JSON = DATA_DIR / "index.json"
#: SQLite 主存储
DB_PATH = DATA_DIR / "prices.db"
#: 收益配置
PROFIT_CONFIGS = DATA_DIR / "profit_configs.json"
#: 自定义道具
CUSTOM_ITEMS = DATA_DIR / "custom_items.json"
#: 日志
LOG_DIR = DATA_DIR / "logs"
LOG_FILE = LOG_DIR / "app.log"

for _d in (DATA_DIR, SNAPSHOT_DIR, LOG_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------- 数据源
API_URL = os.getenv("POE2_API_URL", "https://poecurrency.top/api/summary?version=2")
API_TIMEOUT = float(os.getenv("POE2_API_TIMEOUT", "15"))
API_RETRIES = int(os.getenv("POE2_API_RETRIES", "3"))
API_BACKOFF = float(os.getenv("POE2_API_BACKOFF", "2.0"))  # 指数退避基数（秒）
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0 Safari/537.36 PoE2Dashboard/1.0"
)

# ---------------------------------------------------------------- 调度
FETCH_INTERVAL_HOURS = float(os.getenv("POE2_FETCH_INTERVAL_HOURS", "1"))
FETCH_ON_STARTUP = os.getenv("POE2_FETCH_ON_STARTUP", "1") not in ("0", "false", "False")

# ---------------------------------------------------------------- 服务
HOST = os.getenv("POE2_HOST", "127.0.0.1")
PORT = int(os.getenv("POE2_PORT", "8000"))
REQUEST_TIMEOUT_MS = 10_000

# ---------------------------------------------------------------- 汇率
#: 计算 d->e 汇率时优先使用的道具（英文名）
RATE_ITEM_ORDER = ("Divine Orb", "Chaos Orb", "Mirror of Kalandra")
#: 兜底汇率（仅当历史中完全没有可用汇率时使用）
FALLBACK_D_TO_E = 800.0

#: 历史折线图可选时间窗（小时）
HISTORY_WINDOWS = {"24h": 24, "7d": 168, "30d": 720, "all": 24 * 365}


def ensure_dirs() -> None:
    for _d in (DATA_DIR, SNAPSHOT_DIR, LOG_DIR):
        _d.mkdir(parents=True, exist_ok=True)
