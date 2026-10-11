
# Agent目标：PoE2 通货价格看板与收益分析工具

## 1. 项目概述

构建一个本地运行的 Web 应用，用于监控《流放之路2》(PoE2) 通货价格、分析刷图收益。系统定时抓取 poecurrency.top 的价格 API，保存历史数据，提供实时价格看板、历史趋势折线图和可配置的收益计算器。

**技术栈**：Python 3.10+ / FastAPI / Uvicorn / APScheduler / Jinja2 或前端静态页 / Chart.js / SQLite（或 JSON 文件）

**数据来源**：`https://poecurrency.top/api/summary?version=2`

---

## 2. 功能模块与目标

### 模块 A：数据采集器（Scheduler + Fetcher）

**目标**：每小时自动抓取一次价格数据并持久化。

**要求**：

1. **定时任务**

   - 使用 APScheduler 的 `BackgroundScheduler`，间隔 1 小时执行一次（`interval` 触发器）。
   - 应用启动时立即执行一次抓取，避免等待首个小时。
   - 任务需容错：网络失败时记录日志，不中断调度。
2. **抓取逻辑**

   - 使用 `httpx.AsyncClient` 或 `requests` 调用 API，超时 15s，失败重试 3 次（指数退避）。
   - 校验响应为合法 JSON 且非空数组。
3. **文件保存**

   - 每次抓取保存到 `data/summary_YYYYMMDD_HHMMSS.json`（历史快照）。
   - 同时覆盖写入 `summary.json`（当前最新，路径为项目根目录，便于用户直接查看）。
   - 保存内容需附加元数据：`{"fetched_at": "...", "source": "...", "data": [...]}`；若为兼容考虑，也可保留纯数组格式并用单独文件记录时间戳。
4. **历史索引**

   - 维护 `data/index.json`：`[{"file": "...", "fetched_at": "...", "item_count": N}, ...]`，供折线图查询。

---

### 模块 B：数据解析与结构化存储

**目标**：将原始 JSON 转为可查询的结构，支持历史查询。

**要求**：

1. **解析字段**

   - `category_label`：分类（通货仓库、催化剂、先驱徽记、凝视、合金通货、圣典、地图碎片、星辉矿石等）。
   - `item_name` / `engname` / `item_icon`。
   - `buy_avg` / `sell_avg` / `buy_avg_yesterday` / `sell_avg_yesterday`。
   - `buy_avg_ratio` / `sell_avg_ratio`（涨跌幅）。
   - `latest_buy1` / `latest_sell1` / `latest_datetime`。
   - `buy_avg_12h` / `sell_avg_12h` / `buy_avg_24h` / `sell_avg_24h`。
   - `currency_unit`（`d` 或 `e`）—— **关键**：用于汇率换算。
   - `error` / `error_info` / `anomaly_count`。
2. **汇率提取**

   - 从数据中识别 `d` 与 `e` 的兑换关系。通常表现为：
     - 以 `e` 为单位的"神圣石"价格（如 829）≈ 1 神圣石 = N 崇高石。
     - 以 `d` 为单位的"混沌石"价格（如 110）≈ 1 混沌石 = N 神圣石。
   - 定义基准：**1 Divine (d) = X Exalted (e)**，从 `currency_unit == "d"` 的条目中反推（例如"神圣石"若以 e 计价则为 e/d 汇率；或"混沌石"以 e 计价与 d 计价的交叉比值）。
   - 实现 `get_rate_d_to_e(snapshot)` 函数，返回 `float`。若无法计算，回退到上一次成功值。
3. **存储**

   - 主存储：SQLite `data/prices.db`
     - 表 `snapshots(id, fetched_at)`
     - 表 `prices(id, snapshot_id, category, item_name, engname, icon, unit, buy_avg, sell_avg, buy_avg_yesterday, sell_avg_yesterday, buy_ratio, sell_ratio, latest_buy1, latest_sell1, latest_datetime, buy_avg_12h, sell_avg_12h, buy_avg_24h, sell_avg_24h, error, error_info)`
     - 表 `rates(snapshot_id, d_to_e)` —— 每小时的汇率，用于折线图。
   - 备选：纯 JSON 查询层。若追求简单，可用 `data/history/<item_key>.json` 按道具聚合时间序列。

---

### 模块 C：价格看板页面（Dashboard）

**目标**：可视化当前价格，支持搜索、筛选、排序、涨跌高亮。

**页面路由**：`GET /`（HTML） + `GET /api/prices`（JSON）

**要求**：

1. **顶部概览卡**

   - 显示当前汇率：`1 Divine = X Exalted`。
   - 数据最后更新时间。
   - 抓取状态（正常/失败/上次错误信息）。
   - 道具总数、异常条目数（`error == true`）。
2. **分类 Tab**

   - 按 `category_label` 生成 Tab：通货仓库 / 催化剂 / 先驱徽记 / 凝视 / 合金通货 / 圣典 / 地图碎片 / 星辉矿石。
   - 默认显示"全部"。
3. **价格表格**

   - 列：图标、中文名、英文名、买入均价、卖出均价、涨跌幅（买/卖）、24h 均价、最新买1/卖1、单位、更新时间、状态。
   - **单位换算**：所有价格提供切换开关 "显示为 d / 显示为 e"，使用当前汇率换算。
   - **涨跌幅着色**：正数绿色、负数红色、`null` 灰色。
   - **异常标记**：`error == true` 的行加橙色警示图标，hover 显示 `error_info`。
   - 支持按列排序（名称、价格、涨跌幅）。
   - 支持搜索框（中英文模糊匹配）。
4. **自动刷新**

   - 前端每 60s 轮询 `/api/prices` 更新数据，或使用 SSE/WebSocket（可选）。

---

### 模块 D：历史折线图（Trend Charts）

**目标**：基于每小时快照绘制价格/汇率走势。

**页面路由**：`GET /trends` + `GET /api/history?item=<engname>&hours=168`

**要求**：

1. **汇率折线图**

   - X 轴：时间（每小时一个点）。
   - Y 轴：`d_to_e` 汇率。
   - 默认展示最近 7 天（168 点），支持切换 24h / 7d / 30d / 全部。
2. **单道具价格折线图**

   - 用户选择道具（下拉搜索）。
   - 展示 `buy_avg` 与 `sell_avg` 两条线，单位可切换 d/e。
   - 若该道具在多个分类中重名，需用 `engname` 作为唯一键。
3. **多道具对比（可选加分）**

   - 允许同时选择最多 5 个道具，归一化后对比涨跌趋势。
4. **实现**

   - 后端提供 `/api/history`，从 SQLite 或历史 JSON 文件聚合时间序列。
   - 前端用 Chart.js 渲染。

---

### 模块 E：收益分析页面（Profit Calculator）

**目标**：用户配置"门票成本 + 掉落收益 + 掉落概率"，计算期望收益。

**页面路由**：`GET /profit` + `POST /api/profit/save` + `POST /api/profit/calculate`

**要求**：

1. **门票（成本）配置**

   - 用户从价格库中选择一个或多个道具作为门票，输入数量。
   - 自动读取当前 `sell_avg`（或 `buy_avg`，可切换）计算总成本。
   - 单位统一换算为 d 或 e（用户可选显示单位）。
2. **掉落（收益）配置**

   - 用户添加多个掉落条目：道具（从价格库选择） + 数量 + **掉落概率（0~100%）**。
   - 概率支持小数。
   - 每个掉落条目可单独启用/禁用。
3. **自定义道具**

   - 允许用户手动输入道具名 + 单价 + 单位（d/e），加入掉落列表（不依赖价格库）。
   - 自定义道具也需支持概率。
4. **收益计算**

   - 期望收益 = Σ(掉落单价 × 数量 × 概率)
   - 净收益 = 期望收益 − 门票成本
   - ROI = 净收益 / 门票成本 × 100%
   - 显示：总成本、期望收益、净收益、ROI、每分钟收益（可选，用户输入单次耗时）。
5. **保存/加载配置**

   - `POST /api/profit/save`：保存当前配置到 `data/profit_configs.json`，带名称与时间戳。
   - `GET /api/profit/configs`：列出已保存配置。
   - `POST /api/profit/load/{id}`：加载配置。
   - 配置结构示例：
     ```json
     {
       "id": "uuid",
       "name": "裂隙刷图",
       "created_at": "...",
       "display_unit": "d",
       "ticket": [{"engname": "...", "qty": 1, "price_source": "sell_avg"}],
       "drops": [
         {"engname": "...", "qty": 1, "chance": 0.05, "price_source": "sell_avg"},
         {"custom_name": "自定义宝珠", "unit": "d", "price": 2.5, "qty": 1, "chance": 0.1}
       ],
       "minutes_per_run": 5
     }
     ```
6. **前端交互**

   - 门票/掉落选择器：带搜索的下拉，展示图标与当前价格。
   - 实时计算：输入变化时即时重算（前端或调用 `/api/profit/calculate`）。
   - 保存按钮 + 配置列表侧栏。

---

### 模块 F：自定义道具与价格覆盖

**目标**：允许用户维护自己的道具价格表，补充 API 未覆盖或用户私有数据。

**要求**：

1. `data/custom_items.json`：
   ```json
   [{"name": "自定义物品A", "engname": "Custom A", "unit": "d", "price": 3.5, "updated_at": "..."}]
   ```
2. CRUD API：`GET/POST/PUT/DELETE /api/custom-items`。
3. 在收益分析中，自定义道具与价格库道具可混合使用。
4. 价格看板可选显示自定义道具（独立分组）。

---

## 3. 项目结构

```
poe2-dashboard/
├── app/
│   ├── main.py                 # FastAPI 入口，挂载路由与调度器
│   ├── config.py               # 配置（API URL、间隔、路径）
│   ├── fetcher.py              # 抓取与保存
│   ├── parser.py               # JSON 解析、汇率提取
│   ├── storage.py              # SQLite / JSON 读写
│   ├── scheduler.py            # APScheduler 封装
│   ├── routers/
│   │   ├── prices.py           # /api/prices, /api/history
│   │   ├── profit.py           # /api/profit/*
│   │   └── custom.py           # /api/custom-items
│   ├── templates/              # Jinja2 页面（或纯静态）
│   │   ├── dashboard.html
│   │   ├── trends.html
│   │   └── profit.html
│   └── static/
│       ├── js/  css/
├── data/
│   ├── summary.json            # 最新快照（根目录也保留一份）
│   ├── snapshots/              # 历史快照
│   ├── index.json
│   ├── prices.db
│   ├── profit_configs.json
│   └── custom_items.json
├── summary.json                # 当前最新（需求指定）
├── requirements.txt
├── run.py                      # uvicorn 启动脚本
└── README.md
```

---

## 4. 关键实现细节

### 4.1 汇率提取逻辑

API 中 `currency_unit` 为 `d` 或 `e`。观察数据：

- "神圣石" buy_avg=829, unit=`e` → 1 Divine ≈ 829 Exalted（但注意这可能是"以 e 计价的神圣石"，即 1 神圣石 = 829 e）。
- "混沌石" buy_avg=110, unit=`e`；另一条"混沌石" buy_avg 未在 d 单位出现。

更稳妥的方式：找同一道具同时以 d 和 e 出现的情况计算交叉汇率；若无，则取"神圣石"的 e 价格作为 `d_to_e`，并取"混沌石"等作为校验。需在 parser 中实现并记录 `rate_source`。

### 4.2 时间序列聚合

`/api/history?item=Divine Orb&hours=168`：

- 查询最近 168 小时内所有 snapshot。
- 每个 snapshot 中匹配 `engname`，返回 `[{t, buy_avg, sell_avg, unit}, ...]`。
- 若某小时缺失，前端折线图断开（`spanGaps: false`）。

### 4.3 概率计算注意

- 概率输入为百分比，存储为 0~1 小数。
- 期望值计算使用浮点，展示保留 2 位小数。
- 支持"必掉"（概率 100%）与"保底"逻辑（可选进阶：min/max 掉落数）。

### 4.4 错误与异常处理

- API 返回中 `error: true` 的条目在看板标记，但收益计算默认使用其价格（用户可手动排除）。
- 若某道具 `buy_avg == 0 && sell_avg == 0`，在收益计算中提示"价格缺失"。

---

## 5. 交付标准（验收清单）

- [ ] 启动 `python run.py` 后，服务监听 `http://127.0.0.1:8000`。
- [ ] 启动后 10 秒内完成首次抓取，`summary.json` 存在且为最新数据。
- [ ] 每小时自动抓取，`data/snapshots/` 下按时间生成文件，`index.json` 递增。
- [ ] 看板页展示所有分类、排序、搜索、单位切换、涨跌着色、异常标记正常。
- [ ] 汇率卡片显示当前 `1 d = X e`。
- [ ] 趋势页可选择道具并绘制最近 7 天折线，汇率折线可独立查看。
- [ ] 收益页可配置门票+掉落+概率，实时计算净收益与 ROI，配置可保存/加载。
- [ ] 自定义道具可添加并在收益页使用。
- [ ] 所有数据持久化在 `data/` 与根目录 `summary.json`，重启不丢失。
- [ ] README 含安装、启动、配置说明。

---

## 6. 依赖清单（requirements.txt 建议）

```
fastapi
uvicorn[standard]
httpx
apscheduler
jinja2
pydantic
python-multipart
```

前端 Chart.js 通过 CDN 引入，无需构建工具。

---

## 7. 可选扩展（非必须）

- 价格预警：用户设定阈值，触发时浏览器通知。
- 数据导出 CSV。
- Docker 化部署。
- 多语言（中/英）切换。
- 登录保护（本地单用户可省略）。

---

**一句话总结**：本 Agent 的目标是交付一个可本地运行、每小时自动采集 PoE2 通货价格、支持历史折线图、并能让用户灵活配置门票/掉落/概率进行收益测算的全栈 Web 工具，核心难点在于汇率提取、时间序列存储与收益计算器的可配置性。
