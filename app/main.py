"""FastAPI 入口：挂载路由、静态资源与调度器。"""
from __future__ import annotations

import logging
import sys
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import config, scheduler, storage
from .routers import backup as backup_router
from .routers import custom as custom_router
from .routers import prices as prices_router
from .routers import profit as profit_router

# ------------------------------------------------------------------ 日志
def setup_logging() -> None:
    config.ensure_dirs()
    root = logging.getLogger()
    if root.handlers:
        return
    root.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s", "%Y-%m-%d %H:%M:%S")

    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(fmt)
    root.addHandler(stream)

    file_handler = RotatingFileHandler(config.LOG_FILE, maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    file_handler.setFormatter(fmt)
    root.addHandler(file_handler)

    logging.getLogger("apscheduler.executors.default").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)


setup_logging()
log = logging.getLogger("app")

try:
    from jinja2 import Environment, FileSystemLoader, select_autoescape
    _env = Environment(
        loader=FileSystemLoader(str(config.TEMPLATE_DIR)),
        autoescape=select_autoescape(["html"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )
except Exception as exc:  # noqa: BLE001 - 缺 jinja2 时退回静态页
    _env = None
    log.warning("Jinja2 不可用（%s），将直接返回静态 HTML", exc)

PAGES = {
    "/": "dashboard.html",
    "/trends": "trends.html",
    "/profit": "profit.html",
}


def render(name: str, **context) -> HTMLResponse:
    path = config.TEMPLATE_DIR / name
    if not path.exists():
        return HTMLResponse(f"<h1>模板缺失：{name}</h1>", status_code=500)
    if _env is not None:
        return HTMLResponse(_env.get_template(name).render(**context))
    return HTMLResponse(path.read_text(encoding="utf-8"))


# ------------------------------------------------------------------ 生命周期
@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("=" * 68)
    log.info("PoE2 通货价格看板启动中 ……")
    storage.init_db()
    log.info("数据库就绪：%s（历史快照 %s 份）", config.DB_PATH, storage.snapshot_count())
    try:
        await scheduler.start_async()
    except Exception as exc:  # noqa: BLE001 - 调度失败不应阻止服务
        log.error("调度器启动失败：%s", exc)
    log.info("服务地址：http://%s:%s", config.HOST, config.PORT)
    log.info("=" * 68)
    try:
        yield
    finally:
        scheduler.shutdown()
        log.info("服务已停止")


app = FastAPI(
    title="PoE2 通货价格看板",
    description="poecurrency.top 价格监控、历史趋势与收益分析",
    version="1.0.0",
    lifespan=lifespan,
)

app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static")
app.include_router(prices_router.router, prefix="/api", tags=["prices"])
app.include_router(profit_router.router, prefix="/api/profit", tags=["profit"])
app.include_router(custom_router.router, prefix="/api/custom-items", tags=["custom-items"])
app.include_router(backup_router.router, prefix="/api/backup", tags=["backup"])


# ------------------------------------------------------------------ 中间件
@app.middleware("http")
async def no_cache_for_shell(request: Request, call_next):
    """页面与前端资源禁用强缓存，避免改版后浏览器继续执行旧 JS。"""
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/static/") or path in ("/", "/trends", "/profit"):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


# ------------------------------------------------------------------ 页面
@app.get("/", response_class=HTMLResponse, include_in_schema=False)
def page_dashboard(request: Request) -> HTMLResponse:
    return render(PAGES["/"], page="dashboard", title="价格看板", api_prefix="/api")


@app.get("/trends", response_class=HTMLResponse, include_in_schema=False)
def page_trends(request: Request) -> HTMLResponse:
    return render(PAGES["/trends"], page="trends", title="历史趋势", api_prefix="/api")


@app.get("/profit", response_class=HTMLResponse, include_in_schema=False)
def page_profit(request: Request) -> HTMLResponse:
    return render(PAGES["/profit"], page="profit", title="收益分析", api_prefix="/api")


@app.get("/api/health", tags=["system"])
def health() -> dict:
    snap = storage.latest_snapshot()
    return {
        "ok": True,
        "snapshots": storage.snapshot_count(),
        "latest_fetched_at": snap["fetched_at"] if snap else None,
        "d_to_e": snap["d_to_e"] if snap else None,
        "scheduler": scheduler.status(),
    }


@app.exception_handler(StarletteHTTPException)
async def http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    """统一错误响应为 JSON，前端可直接读取 detail 展示提示。"""
    if isinstance(exc.detail, (dict, list)):
        return JSONResponse(status_code=exc.status_code, content=exc.detail)
    return JSONResponse(
        status_code=exc.status_code,
        content={"ok": False, "detail": exc.detail, "path": request.url.path},
    )
