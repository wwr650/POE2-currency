# PoE2 通货价格看板与收益分析工具

本地运行的《流放之路2》通货价格监控 + 收益测算工具。价格数据统一来自
由 GitHub Actions 定时抓取 [poecurrency.top](https://poecurrency.top) 并提交回仓库的历史快照，
本地服务不再直接抓取 API（无需代理/VPN，只要能访问 GitHub），提供：

- **价格看板**：分类 Tab、搜索、排序、涨跌着色、异常标记、单位切换（d / e）、导出 CSV
- **历史趋势**：汇率折线 + 单/多道具价格折线（最多 5 个对比）、快照索引列表
- **收益分析**：门票成本 + 掉落概率 → 期望收益 / 净收益 / ROI / 每分钟收益，配置可保存加载
- **自定义道具**：补充 API 未覆盖的私有价格，可与价格库道具混合参与计算

前端零外部依赖（自研 SVG 图表，无需 CDN），离线环境同样可用。

---

## 1. 快速开始

### 方式一：一键启动（Windows，推荐）

双击项目根目录的 **`start.bat`**，剩下的全自动：

1. 找不到 `.venv` 就用系统 Python 自动创建；
2. 依赖不全自动 `pip install -r requirements.txt`（已装好则跳过，不联网）；
3. 启动时从 GitHub 仓库拉取 Actions 定时抓取的最新数据（见 [1.1](#11-仓库数据同步本地唯一数据来源)）；
4. 启动服务，并在端口就绪后自动打开浏览器 <http://127.0.0.1:8000>。

启动日志里的每一个阶段（虚拟环境、依赖、服务启动）与失败原因都会用中文写清楚，
出错时会 `pause` 停住不闪退；停止服务按 `Ctrl + C` 或直接关掉窗口。

想换启动方式，给 `start.bat` 传参即可（同样的参数也能直接给 `python launcher.py`）：

| 命令 | 效果 |
| --- | --- |
| `start.bat` | 默认：同步仓库数据（Actions 抓取）+ 自动开浏览器 |
| `start.bat offline` | 离线模式，启动时不同步仓库数据（只看本地已有数据） |
| `start.bat no-browser` | 启动但不自动打开浏览器 |
| `start.bat reload` | 开发用，代码改动自动热重载 |
| `start.bat --port 9000` | 换端口（等价于环境变量 `POE2_PORT`） |
| `start.bat offline no-browser` | 参数可组合 |

> 只想用命令行也可以直接 `python launcher.py`（用系统 Python 跑即可，它自己会找到虚拟环境）。
> 双击时若被 Windows SmartScreen 拦下，选择「仍要运行」；也可以右键 `start.bat` → 发送到 → 桌面快捷方式，
> 做一个桌面启动图标。

### 方式二：手动分步

```bash
# 1) 安装依赖（建议虚拟环境）
python -m venv .venv
.venv\Scripts\activate            # Windows；Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt

# 2) 启动（先导入已有 summary.json 作为基线快照，再从 GitHub 仓库同步 Actions 抓取的最新数据）
python run.py            # 加 --open 可在启动后自动打开浏览器
```

浏览器打开 <http://127.0.0.1:8000> 。

> 说明：本地服务不直接抓取 `poecurrency.top`（无需代理/VPN），
> 数据统一来自 GitHub Actions 定时抓取并提交回仓库的快照；
> 启动时会**自动把仓库已随 clone 到本地的历史快照一次性回填进库**（补齐趋势图），
> 并拉取最新一份；之后每小时增量同步一次，也可点击顶部「同步数据」手动拉取。

### 1.1 仓库数据同步（本地唯一数据来源）

仓库已配置 GitHub Actions（`.github/workflows/fetch-summary.yml`）每小时 :30 抓取一次，
并把结果提交回仓库：根目录 `summary.json`（最新一份）+ `data/snapshots/`（逐小时历史快照，
每份都是带 `fetched_at` / `source` / `data` 的完整信封）。**本地服务不再直接抓取 API**，
统一消费这份数据，分两条链路：

**A. 一次性历史回填（补齐趋势图历史点）**

Actions 积累的逐小时历史随仓库 clone 到本地 `data/snapshots/`。`reposync.backfill_from_local()`
把它们按 `fetched_at` 去重后一次性写入 SQLite（**纯本地读取、无需网络、可重复执行幂等**），
让历史趋势图立刻拥有完整数据点。触发方式：

- **启动即自动回填**：服务启动时 `startup_sync()` 会先跑一遍本地回填（秒级，已入库的时间点自动跳过），
  因此全新 clone 后首次启动就自带完整历史，无需手动操作；
- **手动执行**：`python scripts\backfill_snapshots.py`（打印扫描/新增/跳过/失败统计）；
- **接口触发**：`POST /api/sync-repo` 会顺带增量回填。

**B. 持续同步（Action 每次抓取成功后自动入库）**

1. 识别仓库：读 `.git/config` 里的 `origin`（也可用 `POE2_REPO_URL` 直接指定）；
2. 通过 GitHub Contents API 列出仓库 `data/snapshots/`，**只下载并入库本地缺失的快照**
   （Action 每成功抓取一次就多提交一份，下一次同步即自动拉取入库；停机期间的历史缺口也会被补齐）；
3. 再兜底纯 HTTP GET 拉取最新一份 `data/summary.json` / `summary.json`，仅当比本地最新**更新**时入库
   （列出目录失败时仍能拿到最新，**不需要 git 权限**）；
4. 去重以快照 `fetched_at` 的秒级标识为键，同秒视为同一份数据不重复入库；
5. 拉不到（无网络 / 非 GitHub 仓库 / 已关闭开关）只记一条日志，服务照常启动。

可用开关：

```powershell
$env:POE2_SYNC_REPO_ON_STARTUP = "0"        # 关闭启动时的仓库同步（定时同步仍会执行）
$env:POE2_REPO_SYNC_INTERVAL_HOURS = "1"    # 定时同步间隔（小时，支持小数；0 以下则不启用定时同步）
$env:POE2_REPO_SYNC_HISTORY = "0"           # 关闭历史目录增量回填（只同步最新一份 summary.json）
$env:POE2_GITHUB_TOKEN = "ghp_..."          # 可选：提升 Contents API 速率限制（匿名 60/小时 → 带 Token 5000/小时）
$env:POE2_REPO_URL = "https://github.com/owner/repo"   # 手动指定仓库
$env:POE2_REPO_BRANCH = "main"             # 分支（默认 main）
```

也可以随时手动拉一次：点顶部「同步数据」按钮、调用 `POST /api/sync-repo`，
或 `python -c "from app import reposync; print(reposync.sync_once_sync())"`。

> `offline` 启动模式（`start.bat offline`）等价于 `POE2_SYNC_REPO_ON_STARTUP=0`：
> 启动时不发任何网络请求，只看本地已有数据。

---

## 2. 页面与功能对照

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 价格看板 | 概览卡（汇率 / 更新时间 / 同步状态 / 条目数 / 快照数）、分类 Tab、搜索、排序、单位切换、异常高亮、点击行看详情与 7 天走势、导出 CSV |
| `/trends` | 历史趋势 | 汇率折线（24h / 7d / 30d / 全部）、道具价格折线（最多 5 个对比，单位 d / e / 源单位）、**买入/卖出用两种高对比颜色区分**、按分类筛选 + 中文/英文/分类名过滤、区间涨跌统计、快照索引 |
| `/profit` | 收益分析 | 门票（成本）＋掉落（概率）→ 期望收益、净收益、ROI、每分钟/每小时收益；**门票/掉落选择器支持分类分组 + 直接搜索**；每行显示所选价格来源的单价；概率可手填（0~100%，输入框前有「概率」指示，数量固定为 1 故不需输入）；每行可删除、可一键清空；自定义道具可一键「加入门票」或「加入掉落」；配置保存/加载/删除/导入导出；**切换页面后自动恢复上次的门票/掉落配置** |
| `/docs` | 接口文档 | FastAPI 自动生成的 OpenAPI 文档 |

### 单位与汇率

- 数据源中 `currency_unit` 为 `d`（神圣石）或 `e`（崇高石）；
- 基准汇率 `1 Divine = X Exalted` 由 `app/parser.py::extract_rate` 从快照中提取，
  优先级：神圣石以 e 计价 → 混沌石 e/d 交叉 → 魔镜锚点交叉 → 回退上一次成功值 → 兜底常量；
- 看板与收益页所有金额均可切换 `d` / `e` 显示，切换只做换算，不改原始数据。

### 收益计算口径

```
收益分析：期望收益 = Σ(单价 × 概率)      （数量固定为 1，界面上不输入数量）
          净收益   = 期望收益 − 门票成本
          ROI      = 净收益 / 门票成本 × 100%（门票为 0 时显示 —）
```

- **概率为手动填写**：每条掉落行在输入框前有「概率」指示文字，取值范围 0~100%（支持小数），
  填写超过 100 会自动收敛为 100，负数收敛为 0；
- 每条掉落行会显示**当前所选价格来源的单价**（切换「卖出均价 / 买入均价 / 24h / 最新买1卖1」即时更新），
  门票行同理，便于核对成本；
- 每行掉落可单独启用/停用，切换价格来源即时生效；
- 自定义掉落可直接填写名称 + 单价 + 单位，不依赖价格库；
- 自定义道具（`data/custom_items.json`）在左侧列表里有两个按钮：**加入门票** 与 **加入掉落**，
  单价按你填写的单位参与计算；
- 每行右侧 ✕ 可删除该条目，面板右下角「清空全部条目」可一次清掉门票与掉落；
- 价格缺失（0）的条目会在结果面板给出黄色告警提示，但仍以 0 参与计算，方便用户手动排除。

---

## 3. 项目结构

```
POE2-currency/
├── app/
│   ├── main.py               FastAPI 入口：路由、静态资源、生命周期
│   ├── config.py             配置（仓库同步、路径、端口；API 地址仅 Actions 脚本用）
│   ├── fetcher.py            抓取管线（httpx，重试退避；仅供 GitHub Actions 脚本使用）
│   ├── reposync.py           从 GitHub 仓库同步 Actions 数据 + 历史回填（本地唯一数据来源）
│   ├── parser.py             JSON 解析 + 汇率提取
│   ├── storage.py            SQLite 主存储 + JSON 快照/索引
│   ├── store.py              JSON 文档存储（配置、自定义道具）
│   ├── profit.py             收益计算引擎
│   ├── scheduler.py          APScheduler（启动本地回填+同步最新，每小时增量回填仓库历史）
│   ├── routers/
│   │   ├── prices.py         /api/prices /api/history /api/meta /api/sync-repo /api/export.csv
│   │   ├── profit.py         /api/profit/*
│   │   ├── custom.py         /api/custom-items
│   │   └── backup.py         /api/backup（导出 / 导入 / 计数）
│   ├── templates/            Jinja2 页面（base / dashboard / trends / profit）
│   ├── static/               css + js（自研图表 charts.js、可搜索选择器 searchselect.js、
│   │                         行渲染 shared.js、自定义道具 custom.js，均无 CDN）
├── data/
│   ├── snapshots/            历史快照 summary_YYYYMMDD_HHMMSS.json
│   ├── summary.json          带元数据的最新快照
│   ├── index.json            历史索引（供折线图查询）
│   ├── prices.db             SQLite（snapshots / prices / rates）
│   ├── profit_configs.json   收益配置
│   ├── custom_items.json     自定义道具
│   └── fetch_status.json     最近一次同步状态
├── summary.json              最新快照（API 原始数组，便于直接查看）
├── requirements.txt
├── run.py                    启动脚本
├── start.bat                 一键启动入口（双击即可，文件本身只用 ASCII，避免代码页乱码）
├── launcher.py               一键启动引导器（纯标准库：建虚拟环境 → 装依赖 → 拉起 run.py）
├── tests/
│   ├── acceptance.py            后端端到端验收（80 项）
│   ├── frontend-smoke.js        前端无浏览器冒烟测试（41 项）
│   ├── render-check.js          真实数据渲染检查（10 项）
│   ├── profit-interaction.js    收益页交互测试（43 项）
│   ├── unit-price-regression.js 首屏单价回归测试（9 项）
│   ├── one_click.py             一键启动脚本自检（17 项）
│   ├── repo_sync.py             仓库数据同步自检（41 项，无需网络）
│   ├── dashboard-columns.js     看板表头/列对齐回归（9 项）
│   └── data_keep.py             数据保全自检（24 项：测试不得删除用户数据）
└── README.md
```

> 根目录 `summary.json` 是 GitHub Actions 的抓取产物，本地同步**从不回写**它，
> 不会弄脏工作区；本地数据全部落在 `data/`（SQLite + `data/snapshots/` + `index.json`）。
> Actions 端若因受管环境文件权限无法覆盖 `summary.json`，抓取脚本会照常入库并
> 额外写出 `summary.json.new` 供手动替换（见 `app/storage.py`）。

---

## 4. 数据流

1. GitHub Actions 每小时的 :30 执行 `scripts/fetch_summary.py`（调用 `app/fetcher.py`
   抓取管线）→ 把最新数据提交回仓库（根目录 `summary.json` + 逐小时历史 `data/snapshots/`）。
2. 本地服务启动时先导入已有 `summary.json` 作为基线快照，再执行 `reposync.startup_sync()`：
   **先把仓库已随 clone 到本地的 `data/snapshots/` 历史快照一次性去重回填进 SQLite**
   （`backfill_from_local`，无网络、幂等，补齐趋势图），再拉取一次最新一份；
   之后 `BackgroundScheduler` 每 1 小时执行 `sync_once`：**列出仓库历史目录、仅下载并入库
   本地缺失的快照**（Action 每次抓取成功后自动落入），再兜底同步最新一份（可用环境变量调整/关闭）。
3. 入库 → 解析 → 提取汇率 → 写入 SQLite（`snapshots` / `prices` / `rates`）；
   去重以 `fetched_at` 秒级标识为键，同秒不重复入库（回填与增量都幂等）。
4. 拉取失败或无更新：记录日志与 `fetch_status.json`（同步状态），调度不中断，
   看板继续展示上一次数据。
5. 看板每 60 秒轮询 `/api/prices` 刷新，概览卡每 30 秒刷新相对时间。
6. 点击顶部「同步数据」（`POST /api/sync-repo`）= 手动跑一次带历史增量回填的同步，与定时任务同一实现；
   本地同步**从不回写**根目录 `summary.json`（那是 Actions 的产物，避免本地修改弄脏工作区）。

---

## 4.1 自检（共 346 项检查，全部通过）

```powershell
# 1) 后端端到端：页面、API、汇率、收益计算、配置、自定义道具、CSV（72 项）
#    需先启动服务：start.bat offline no-browser
.venv\Scripts\python.exe tests\acceptance.py

# 2) 前端冒烟：无需浏览器，用最小 DOM 桩验证格式化、单位换算、图表配色与页面脚本（41 项）
node tests\frontend-smoke.js

# 3) 真实数据渲染：读取线上快照，验证模板字段与折线渲染（10 项）
node tests\render-check.js

# 4) 收益页交互：可搜索选择器、概率手填与收敛、行内单价、添加/删除、状态持久化（43 项）
node tests\profit-interaction.js

# 5) 首屏单价回归：本地已存配置 + 价格库异步加载时，行内单价不得为 0.00（9 项）
node tests\unit-price-regression.js

# 6) 一键启动自检：无需网络与浏览器，验证 start.bat 纯 ASCII/调用引导器、
#    参数解析（offline / no-browser / reload / --port）、依赖探测、端口就绪后才开浏览器（17 项）
.venv\Scripts\python.exe tests\one_click.py

# 6.1) 仓库数据同步自检：无需网络，验证仓库地址识别/URL 拼接/新旧判定/只入库一次/开关与降级（33 项）
.venv\Scripts\python.exe tests\repo_sync.py

# 7) 看板列对齐回归：表头列数必须与单元格列数一致、逐列 left 对齐（9 项）
#    默认只跑「源码级不变量」（无需浏览器）；加 --geometry 才做无头浏览器几何测量
node tests\dashboard-columns.js

# 8) 数据保全：造一条哨兵数据 → 跑完上面所有套件 → 检查它仍在；
#    并验证 JSON 存储的原子写入 / 备份 / 自动恢复与导出导入（24 项）
.venv\Scripts\python.exe tests\data_keep.py
```

### 价格看板（`/`）

| 区域 | 说明 |
| --- | --- |
| 概览卡片 | 实时汇率（含「以崇高石计价」换算）、最后更新时间、抓取状态、道具总数 / 异常数、历史快照数 |
| 分类 Tab | 全部分类 + 各分类（含数量与异常标记）；选中某分类后表格才显示「分类」列 |
| 工具栏 | 搜索（中文名 / 英文名 / 分类）、仅异常、排序字段与方向、d / e 单位切换、自动刷新、导出 CSV |
| 表格 | 图标 · 中文名 · 英文名 · 分类（按分类筛选时）· 买入均价 · 卖出均价 · 买入涨跌 · 卖出涨跌 · 24h 买/卖 · 最新 买1/卖1 · 单位 · 价格时间 · 状态 |

> **「分类」列的隐藏规则**：分类列由表格类名 `hide-category` 控制，CSS 同时隐藏
> `thead th:nth-child(4)` 与 `tbody td:nth-child(4)`。**必须成对隐藏** —— 只隐藏表头会让
> 表头少一列、内容仍是满列，从而整体错位（曾出现过的 BUG，现由
> `tests/dashboard-columns.js` 守着）。

### 自定义道具

`app/static/js/custom.js` 为收益分析提供自定义道具控制器：

- **数据源**：`data/custom_items.json`；
- **同一套界面**：左侧「自定义道具」面板 —— 列表（名称/英文名/单价/更新时间）、
  「加入门票」「加入掉落」「✕ 删除」，以及「新增自定义道具」表单（名称、单价、单位、英文名）；
- **同一套行为**：
  - 从选择器的「自定义道具」分组选中后，点「设为门票 / 添加掉落」即可加入；
  - 也可在面板里直接点「加入门票 / 加入掉落」（取用**当前最新**单价，而不是加列表时的快照）；
  - 自定义条目的单价按你填写的单位参与成本/收益计算；
  - 在收益分析里点「保存」会写入 `profit_configs.json`。

### 长效保存与备份

`data/custom_items.json`（以及 `profit_configs.json`）是持久化文件，
关掉服务、重启电脑、重新拉取价格都不会丢失。为防意外，存储层还做了三层保护
（`app/store.py`）：

| 机制 | 说明 |
|---|---|
| 原子写入 | 先写 `.json.tmp` 并 `fsync`，再用 `os.replace` 替换，避免断电/中断留下半截文件 |
| 自动备份 | 每次写入后留一份 `.json.bak`（与主文件同内容） |
| 自动恢复 | 读取时若主文件损坏/被截断，自动改用 `.bak`，并在日志里提示 |

面板右上角的 **「导出备份 / 导入备份」** 可把两类数据打包成一个 JSON 文件：

- **导出**：下载 `poe2-backup-<时间>.json`，内含 `custom_items` / `profit_configs` 与数量汇总，可用于长期归档或换机器；
- **导入**：选择备份文件即可恢复，默认按 `id` **合并**（已有条目更新、新条目追加），
  不会删除你现有的其他数据。

对应接口：`GET /api/backup/export`、`POST /api/backup/import`、`GET /api/backup/counts`。

> 测试套件也会动这些文件（造数据/删数据），所以所有套件都只清理**自己创建的**
> 条目（名字含「自测」/「哨兵」），绝不触碰你自己的数据；`tests/data_keep.py`
> 专门守着这条底线：先造一条哨兵数据，跑完全部套件后检查它是否仍在。

### 道具选择器（收益页）

门票与掉落的选择器不是原生下拉框，而是自研组件（`app/static/js/searchselect.js`）：

- **分类分组**：按 `category_label` 分组显示（自定义道具单独置顶为一组），组标题吸顶；
- **直接搜索**：输入中文名、英文名或分类名即时过滤，例如输入「神圣」「chaos」「精华」；
- **显示价格**：每项右侧显示当前单位的卖出/买入价，切换展示单位后价格同步刷新；
- **键盘操作**：`Enter` 选中第一条结果，`Esc` 关闭。

### 趋势图配色

买入与卖出不再用同色虚线区分，而是每个道具一对高对比颜色（青/橙、绿/玫红、紫/黄…），
线宽 2.6px，图例直接标明「买入均价 / 卖出均价」。

### 数值精度

页面所有展示数值（价格、金额、概率、合计）**最多保留 2 位小数**，输入框步进为 0.01；
后端存储保留原始精度，只在展示层收敛。

### 页面状态保持

三个页面各自使用独立的浏览器本地存储键（`poe2.state.dashboard` / `poe2.state.trends`
/ `poe2.state.profit`），互不覆盖：

- **看板**：分类、搜索词、排序方式、方向、仅异常
- **趋势**：时间窗、单位、分类筛选、已选道具（返回后图表自动重绘）
- **收益**：展示单位、单次耗时、门票与掉落全部条目（含自定义条目、数量、概率、启用状态）

它们只保存在浏览器本地；需要跨设备/长期保存请用各页的「保存」写入
`data/profit_configs.json`。想回到干净状态可点「新建」或「清空条目」。

---

## 5. API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/meta` | 概览：汇率、更新时间、同步状态、分类统计、调度信息 |
| GET | `/api/prices` | 价格列表（`category` / `search` / `sort` / `order` / `only_error` / `limit` / `offset`） |
| GET | `/api/options` | 去重道具列表（选择器用） |
| GET | `/api/history?item=Divine Orb&hours=168&unit=d` | 单/多道具时间序列（`items=a,b,c` 最多 5 个） |
| GET | `/api/history/rate?hours=168` | 汇率时间序列 |
| GET | `/api/history/items?hours=720` | 历史中出现过的道具 |
| GET | `/api/snapshots` | 快照索引 |
| POST | `/api/sync-repo` | 立即从 GitHub 仓库拉取 Actions 更新的数据（不比本地新则不入库；本地唯一的数据刷新入口） |
| GET | `/api/export.csv` | 导出 CSV（UTF-8 BOM，Excel 可直接打开） |
| POST | `/api/profit/calculate` | 收益计算 |
| GET | `/api/profit/configs` | 配置列表 |
| POST | `/api/profit/save` | 保存配置（带 `id` 则覆盖） |
| GET/POST | `/api/profit/load/{id}` | 加载配置 |
| DELETE | `/api/profit/configs/{id}` | 删除配置 |
| GET | `/api/profit/rate` | 当前汇率 |
| GET/POST | `/api/custom-items` | 自定义道具列表 / 新增 |
| PUT/DELETE | `/api/custom-items/{id}` | 修改 / 删除 |
| GET | `/api/backup/export` | 导出全部用户数据（自定义道具 / 收益配置）为一个 JSON |
| POST | `/api/backup/import` | 从备份 JSON 恢复（`mode`: `merge` 按 id 合并 / `replace` 覆盖） |
| GET | `/api/backup/counts` | 两类数据的当前条数 |
| GET | `/api/health` | 健康检查（快照数、汇率、调度状态） |

### 收益配置结构

```json
{
  "id": "uuid",
  "name": "裂隙刷图",
  "created_at": "2026-10-03T10:00:00+08:00",
  "display_unit": "d",
  "minutes_per_run": 5,
  "ticket": [{ "engname": "Divine Orb", "qty": 1, "price_source": "sell_avg" }],
  "drops": [
    { "engname": "Chaos Orb", "qty": 3, "chance": 45.5, "price_source": "sell_avg", "enabled": true },
    { "custom": true, "custom_name": "自定义宝珠", "unit": "d", "price": 2.5, "qty": 1, "chance": 10, "enabled": true }
  ]
}
```

> `chance` 为掉落概率（百分数，0~100），后端据此计算期望收益。

---

## 6. 配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `POE2_HOST` | `127.0.0.1` | 监听地址（`0.0.0.0` 可供局域网访问） |
| `POE2_PORT` | `8000` | 监听端口 |
| `POE2_REPO_SYNC_INTERVAL_HOURS` | `1` | 仓库数据同步间隔（小时，支持小数；`<=0` 则不启用定时同步） |
| `POE2_SYNC_REPO_ON_STARTUP` | `1` | 设为 `0` 则启动时不拉取 GitHub 仓库数据（定时同步仍生效） |
| `POE2_REPO_URL` | 自动从 `git remote` 识别 | 形如 `https://github.com/owner/repo`，非 git 克隆目录时手动指定 |
| `POE2_REPO_BRANCH` | `main` | 仓库同步读取的分支 |
| `POE2_REPO_SYNC_HISTORY` | `1` | 设为 `0` 则关闭历史目录（`data/snapshots/`）增量回填，只同步最新一份 |
| `POE2_GITHUB_TOKEN` / `GITHUB_TOKEN` | 空 | 可选；提升 GitHub Contents API 速率限制（匿名 60/小时 → 5000/小时） |
| `POE2_API_TIMEOUT` | `15` | 单次请求超时（秒，仓库同步与 Actions 抓取脚本共用） |
| `POE2_API_URL` / `POE2_API_RETRIES` / `POE2_API_BACKOFF` | 见 `app/config.py` | 仅 GitHub Actions 抓取脚本（`scripts/fetch_summary.py`）使用，本地服务不再直接抓 API |

示例（完全离线 / 只看本地数据）：

```powershell
$env:POE2_SYNC_REPO_ON_STARTUP = "0"    # 启动时不发网络请求
$env:POE2_REPO_SYNC_INTERVAL_HOURS = "0"  # 再加一行则连定时同步也关闭
python run.py
```

等价的一键写法：`start.bat offline`（仅关启动时同步；连定时同步也想关需先设上面两个变量再跑 `start.bat`）。

---

## 7. 数据维护

- **手动补充历史**：把符合数据源格式的 JSON 放到任意位置，然后在 Python 中调用
  `app.fetcher.load_local_file(Path("xxx.json"))`，或直接替换根目录 `summary.json` 后删除
  `data/prices.db` 重新启动（会重新导入基线快照）。
- **从仓库补数据**：启动时与每小时自动执行（见 [1.1](#11-仓库数据同步本地唯一数据来源)），也可随时
  `POST /api/sync-repo`（或点顶部「同步数据」）手动拉一次。
- **清空历史**：删除 `data/prices.db`、`data/snapshots/`、`data/index.json` 后重启。
- **备份**：整个 `data/` 目录 + 根目录 `summary.json` 即为全部持久化数据，重启不丢失。
- **日志**：`data/logs/app.log`（滚动，单个最大 2 MB，保留 3 份）。

---

## 8. 常见问题

**Q：双击 `start.bat` 提示未找到 Python？**
A：本机没有可用的 Python 3.9+（`py` 与 `python` 都不在 PATH 里）。去
<https://www.python.org/downloads/> 安装，安装时勾选 **Add Python to PATH**，
装完重新双击即可。

**Q：双击 `start.bat` 后卡在「正在安装依赖」？**
A：`pip` 需要访问 PyPI，网络受限时会重试很久。窗口关掉后手动指定镜像源：
`".venv\Scripts\python.exe" -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple`，
装好后再双击 `start.bat`（此时会直接跳过安装）。依赖已存在时一键脚本不会联网。

**Q：双击 `start.bat` 窗口一闪就没了？**
A：正常不会——失败路径都带 `pause`。若确实闪退，请在资源管理器里双击，
或在 PowerShell 中执行 `.\start.bat` 以便把错误留在屏幕上。

**Q：浏览器没自动打开 / 打开后是「无法访问」？**
A：一键启动会等端口能连上才开浏览器；如果浏览器被系统默认程序设置干扰，
手动访问 <http://127.0.0.1:8000> 即可。端口被占可用 `start.bat --port 9000`。

**Q：启动后概览卡显示「本地数据」，但一切都正常？**
A：说明还没有成功的仓库同步记录，当前展示的是导入的已有 `summary.json`。点顶部「同步数据」
即可拉取仓库里 Actions 已抓好的最新数据；本机若无法访问 GitHub，历史数据、看板与收益计算仍然完全可用。

**Q：顶部提示「根目录 summary.json 为只读」？**
A：该文件是 Actions 的抓取产物，本地同步从不回写它。若 Actions 端写入被拒，所有数据仍然完整落库（SQLite + `data/`），
同时会写出 `summary.json.new`。删除根目录 `summary.json` 后重跑抓取即可恢复自动更新。

**Q：趋势图只有一个点 / 是空的？**
A：趋势图按快照累积。首次导入记 1 个点，之后每小时同步时，只要仓库里有 Actions 新抓取的数据就会增加 1 个点
（数据源本身约每小时更新一次价格）；同一份数据不会重复入库，因此长时间没有新提交就没有新点属正常现象。

**Q：本机访问不了 `poecurrency.top`（需要代理/VPN），能用到最新价格吗？**
A：能。本地从不直连该站点：GitHub Actions 在云端每小时抓一次并提交回仓库，
本地启动时与每小时把这份数据同步下来入库（见 [1.1](#11-仓库数据同步本地唯一数据来源)）。看板概览卡的「更新时间」下方
会显示来源 `repo:github(...)`，表示当前展示的是仓库里最新的一份数据。

**Q：同步失败提示连接被关闭？**
A：本机网络无法访问 GitHub（raw.githubusercontent.com）。历史数据、
看板与收益计算不受影响，网络恢复后点「同步数据」即可续上。

**Q：启动日志提示「仓库数据同步跳过」是否正常？**
A：正常。多数原因是「仓库数据不比本地更新」（Actions 还没有新的提交），
或是拉不到仓库（无网络 / 不是 GitHub 克隆目录）。后者可设 `POE2_REPO_URL` 手动指定，
完全不需要这个功能则设 `POE2_SYNC_REPO_ON_STARTUP=0`；两种情况都不会影响服务启动。

**Q：为什么同一条道具在数据源里有 `d` 和 `e` 两种单位？**
A：数据源按道具常用计价习惯给出单位。看板统一换算到用户选择的单位显示，
汇率来源会显示在汇率卡的悬浮提示中。

**Q：收益页显示「价格缺失」警告？**
A：该道具当前快照的对应价格字段为 0（交易量不足或数据源异常）。可以改用其它价格来源，
或把该条目停用后再计算。

**Q：删不掉门票/掉落条目？**
A：请确认页面已刷新到最新代码（服务已禁用静态资源强缓存，普通刷新即可）。
每行最右侧的 ✕ 为该行的删除按钮，落点在按钮正中；若仍有问题，可用面板右下角的
「清空全部条目」一次性清空，或在浏览器控制台执行 `localStorage.removeItem('poe2.state.profit')`
后刷新页面。

**Q：掉落的概率怎么填？**
A：在掉落行的「概率」输入框里直接填百分比（0~100，支持小数），例如填 `45.5` 表示 45.5%；
超过 100 会自动收敛为 100，负数收敛为 0。想表达「8 局掉 1 次」时，按 1 ÷ 8 = 12.5 填写即可。

**Q：怎么确认某条掉落用的是哪个价格？**
A：每条门票/掉落行都会在价格来源下拉框右侧直接显示该来源当前对应的单价
（例如选择「卖出均价」时显示 `0.147 d`）；切换来源或切换展示单位，单价即时更新。

**Q：切换页面后配置会丢吗？**
A：不会。门票/掉落/单位/耗时都按页面独立保存在浏览器本地存储里，切到看板再切回会自动恢复
（趋势页的分类、时间窗与已选道具同理）。需要长期保存请点「保存」。

---

*本工具仅供个人参考，交易风险自负。数据版权归 poecurrency.top 所有。*
