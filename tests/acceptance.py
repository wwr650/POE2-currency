"""端到端验收脚本：逐项检查 API 与页面（离线执行，不依赖外网）。"""
from __future__ import annotations

import io
import json
import sys

import httpx

BASE = "http://127.0.0.1:8000"
out = io.StringIO()


def log(msg: str = "") -> None:
    out.write(msg + "\n")


def check(name: str, cond: bool, extra: str = "") -> bool:
    log(f"[{'PASS' if cond else 'FAIL'}] {name}{(' — ' + extra) if extra else ''}")
    return cond


ok = True
with httpx.Client(base_url=BASE, timeout=25) as c:
    # ---------------------------------------------------------- 页面
    log("== 页面路由 ==")
    for path, needle in (("/", "priceTable"), ("/trends", "rateChart"), ("/profit", "ticketList")):
        r = c.get(path)
        ok &= check(f"GET {path} 200 且包含 {needle}", r.status_code == 200 and needle in r.text,
                    f"status={r.status_code} len={len(r.text)}")
    r = c.get("/static/js/charts.js")
    ok &= check("静态资源 charts.js", r.status_code == 200 and "LineChart" in r.text)
    r = c.get("/static/css/app.css")
    ok &= check("静态资源 app.css", r.status_code == 200 and "--gold" in r.text)

    # ---------------------------------------------------------- meta / health
    log("\n== 概览与健康 ==")
    meta = c.get("/api/meta").json()
    ok &= check("meta.ok", meta.get("ok") is True)
    ok &= check("meta 汇率合理 (700~900)", 700 <= (meta["rate"]["d_to_e"] or 0) <= 900, f"rate={meta['rate']['d_to_e']}")
    ok &= check("meta 条目数 = 559", meta.get("item_count") == 559, f"item_count={meta.get('item_count')}")
    ok &= check("meta 分类数 = 20", len(meta.get("categories") or []) == 20, f"n={len(meta.get('categories') or [])}")
    ok &= check("meta 调度器运行中", meta["scheduler"]["running"] is True,
                f"next={meta['scheduler']['jobs'][0]['next_run'] if meta['scheduler']['jobs'] else None}")
    log(f"    汇率来源：{meta['rate']['source']}")

    # ---------------------------------------------------------- prices
    log("\n== 价格列表 ==")
    p = c.get("/api/prices").json()
    ok &= check("全部条目 559", p["count"] == 559, f"count={p['count']}")
    base = c.get("/api/meta").json()
    n_error = base["error_count"]
    n_snap = base["snapshot_total"]
    first = p["items"][0]
    ok &= check("条目含 d 折算字段", "d_buy_avg" in first and "d_sell_avg" in first)
    ok &= check("条目含中文名/英文名", bool(first["item_name"]) and bool(first["engname"]),
                f"{first['item_name']} / {first['engname']}")

    r5 = c.get("/api/prices", params={"category": "通货仓库"}).json()
    ok &= check("分类过滤（通货仓库 33 条）", r5["count"] == 33, f"count={r5['count']}")
    r5b = c.get("/api/prices", params={"category": "符文"}).json()
    ok &= check("分类过滤（符文 132 条）", r5b["count"] == 132, f"count={r5b['count']}")
    r5c = c.get("/api/prices", params={"category": "精华"}).json()
    ok &= check("分类过滤（精华 63 条）", r5c["count"] == 63, f"count={r5c['count']}")
    rs = c.get("/api/prices", params={"search": "Divine"}).json()
    ok &= check("英文搜索 Divine", rs["count"] >= 1, f"count={rs['count']}")
    rs2 = c.get("/api/prices", params={"search": "神圣石"}).json()
    ok &= check("中文搜索 神圣石", rs2["count"] >= 1, f"count={rs2['count']}")
    re_ = c.get("/api/prices", params={"only_error": "true"}).json()
    ok &= check(f"仅异常 {n_error} 条与概览一致", re_["count"] == n_error, f"count={re_['count']}")
    rsort = c.get("/api/prices", params={"sort": "sell", "order": "desc", "limit": 3}).json()
    vals = [i["e_sell_avg"] for i in rsort["items"]]
    ok &= check("按卖出均价降序", vals == sorted(vals, reverse=True), f"{vals}")

    opts = c.get("/api/options").json()
    ok &= check("道具选择器去重后数量合理", 300 <= opts["count"] <= 559, f"count={opts['count']}")

    # ---------------------------------------------------------- history
    log("\n== 历史 ==")
    h = c.get("/api/history", params={"item": "Divine Orb", "hours": 168}).json()
    ok &= check("单道具历史返回 1 条序列", len(h["series"]) == 1)
    ok &= check(f"历史点数 = {n_snap}（与快照数一致）", len(h["series"][0]["points"]) == n_snap,
                f"points={len(h['series'][0]['points'])} snapshots={n_snap}")
    hr = c.get("/api/history/rate", params={"hours": 168}).json()
    ok &= check(f"汇率历史点数 = {n_snap}", hr["count"] == n_snap, f"count={hr['count']}")
    hi = c.get("/api/history/items").json()
    ok &= check("历史道具列表非空", len(hi["items"]) > 0, f"n={len(hi['items'])}")
    hm = c.get("/api/history", params={"items": "Divine Orb,Chaos Orb", "hours": 24}).json()
    ok &= check("多道具对比返回 2 条序列", len(hm["series"]) == 2)
    hd = c.get("/api/history", params={"item": "Divine Orb", "unit": "d"}).json()
    pt = hd["series"][0]["points"][0]
    ok &= check("以 d 为单位的历史点 < 原值", (pt["sell_avg"] or 0) < 5,
                f"d_sell={pt['sell_avg']}")

    snaps = c.get("/api/snapshots").json()
    ok &= check("快照索引非空", snaps["count"] >= 1, f"count={snaps['count']}")

    # ---------------------------------------------------------- 收益计算
    log("\n== 收益计算 ==")
    payload = {
        "display_unit": "d",
        "minutes_per_run": 5,
        "ticket": [{"engname": "Divine Orb", "qty": 1, "price_source": "sell_avg"}],
        "drops": [
            {"engname": "Chaos Orb", "qty": 3, "chance": 50, "price_source": "sell_avg", "enabled": True},
            {"custom": True, "custom_name": "自定义宝珠", "unit": "d", "price": 2, "qty": 1, "chance": 100, "enabled": True},
            {"engname": "Mirror of Kalandra", "qty": 1, "chance": 100, "price_source": "sell_avg", "enabled": False},
        ],
    }
    calc = c.post("/api/profit/calculate", json=payload).json()
    s = calc["summary"]
    rate = calc["d_to_e"]
    # 期望值由当前价格库实时计算，避免依赖固定价格
    def sell_e(eng: str) -> float:
        row = c.get("/api/prices", params={"search": eng, "sort": "name"}).json()["items"]
        return [r for r in row if r["engname"] == eng][0]["sell_avg"]

    divine_e, chaos_e = sell_e("Divine Orb"), sell_e("Chaos Orb")
    expect_cost = round(divine_e / rate, 4)
    expect_rev = round(chaos_e / rate * 3 * 0.5 + 2, 4)
    ok &= check("门票成本 = 神圣石卖出均价折算",
                abs(s["total_cost"] - expect_cost) < 5e-3,
                f"cost={s['total_cost']} expect={expect_cost}（{divine_e} e / {rate}）")
    ok &= check("期望收益与手算一致", abs(s["expected_revenue"] - expect_rev) < 5e-3,
                f"got={s['expected_revenue']} expect={expect_rev}（混沌石 {chaos_e} e）")
    ok &= check("净收益 = 期望 − 成本", abs(s["net"] - (expect_rev - expect_cost)) < 5e-3, f"net={s['net']}")
    ok &= check("ROI 计算", abs(s["roi"] - (s["net"] / s["total_cost"] * 100)) < 0.02, f"roi={s['roi']}%")
    ok &= check("停用条目不计入期望收益", s["expected_revenue"] < 100,
                f"revenue={s['expected_revenue']}（未包含数千 d 的魔镜）")
    ok &= check("停用条目仍记录在明细中", calc["drops"][2]["enabled"] is False)
    ok &= check("每分钟收益", abs(s["per_minute"] - s["net"] / 5) < 1e-3, f"per_min={s['per_minute']}")
    ok &= check("明细行数 = 1 门票 + 3 掉落", len(calc["ticket"]) == 1 and len(calc["drops"]) == 3)
    ok &= check("自定义道具被识别", calc["drops"][1]["kind"] == "custom", f"kind={calc['drops'][1]['kind']}")
    ok &= check("无价格缺失警告", calc["warnings"] == [], f"warnings={calc['warnings']}")

    p_e = dict(payload, display_unit="e")
    calc_e = c.post("/api/profit/calculate", json=p_e).json()
    ok &= check("切换单位到 e 后成本 = 神圣石 e 报价",
                abs(calc_e["summary"]["total_cost"] - divine_e) < 1e-3,
                f"cost={calc_e['summary']['total_cost']} divine_e={divine_e}")

    bad = c.post("/api/profit/calculate", json={"ticket": [{"engname": "不存在的道具", "qty": 1}], "drops": []}).json()
    ok &= check("不存在道具产生警告", len(bad["warnings"]) >= 1, f"{bad['warnings']}")

    # ---------------------------------------------------------- 配置保存/加载
    log("\n== 收益配置 ==")
    saved = c.post("/api/profit/save", json=dict(payload, name="验收-裂隙刷图")).json()
    cfg_id = saved["id"]
    ok &= check("保存配置返回 id", bool(cfg_id), f"id={cfg_id} replaced={saved['replaced']}")
    lst = c.get("/api/profit/configs").json()
    ok &= check("配置列表包含新配置", any(x["id"] == cfg_id for x in lst["items"]), f"n={lst['count']}")
    one = c.get(f"/api/profit/load/{cfg_id}").json()
    ok &= check("加载配置名称一致", one["config"]["name"] == "验收-裂隙刷图")
    one2 = c.post(f"/api/profit/load/{cfg_id}").json()
    ok &= check("POST 方式加载同样成功", one2["ok"] is True)
    again = c.post("/api/profit/save", json=dict(payload, name="验收-裂隙刷图", id=cfg_id)).json()
    ok &= check("同 id 保存为覆盖", again["replaced"] is True)
    n_before = c.get("/api/profit/configs").json()["count"]
    d = c.delete(f"/api/profit/configs/{cfg_id}").json()
    ok &= check("删除配置", d["ok"] and c.get("/api/profit/configs").json()["count"] == n_before - 1)
    ok &= check("删除不存在的配置返回 404", c.delete("/api/profit/configs/nope").status_code == 404)

    # ---------------------------------------------------------- 自定义道具
    log("\n== 自定义道具 ==")
    ci = c.post("/api/custom-items", json={"name": "验收宝珠", "engname": "Acceptance Orb", "unit": "d", "price": 3.5}).json()
    ci_id = ci["item"]["id"]
    ok &= check("新增自定义道具", bool(ci_id), f"id={ci_id}")
    items = c.get("/api/custom-items").json()
    ok &= check("列表包含新道具", any(i["id"] == ci_id for i in items["items"]), f"n={items['count']}")
    up = c.put(f"/api/custom-items/{ci_id}", json={"name": "验收宝珠改", "unit": "e", "price": 900}).json()
    ok &= check("修改自定义道具", up["item"]["price"] == 900 and up["item"]["unit"] == "e")
    de = c.delete(f"/api/custom-items/{ci_id}").json()
    ok &= check("删除自定义道具", de["ok"] is True)

    # ---------------------------------------------------------- 导出
    log("\n== 导出 ==")
    csv = c.get("/api/export.csv")
    text = csv.content.decode("utf-8-sig")
    lines = text.strip().splitlines()
    ok &= check("CSV 表头 + 行数 = 560", len(lines) == 560, f"lines={len(lines)}")
    ok &= check("CSV 含中文名", "神圣石" in text)

    log("\n== 错误处理 ==")
    ok &= check("不存在的分类返回空列表而非 500",
                c.get("/api/prices", params={"category": "不存在"}).json()["count"] == 0)

log("\n" + "=" * 46)
log(f"总体结果：{'全部通过' if ok else '存在失败项'}")
report = out.getvalue()
open("data/logs/acceptance.txt", "w", encoding="utf-8").write(report)
print(report)
sys.exit(0 if ok else 1)
