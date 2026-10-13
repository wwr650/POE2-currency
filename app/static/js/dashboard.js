/* 价格看板页逻辑 */
(function () {
  'use strict';
  const P = window.PoE;
  const ui = P.ui;

  const els = {
    tabs: document.getElementById('categoryTabs'),
    table: document.getElementById('priceTable'),
    body: document.getElementById('priceBody'),
    empty: document.getElementById('emptyState'),
    search: document.getElementById('searchInput'),
    errorOnly: document.getElementById('errorOnly'),
    sort: document.getElementById('sortSelect'),
    order: document.getElementById('orderSelect'),
    unitSwitch: document.getElementById('unitSwitch'),
    exportBtn: document.getElementById('exportBtn'),
    auto: document.getElementById('autoRefresh'),
    autoCount: document.getElementById('autoCount'),
    categoryHead: document.getElementById('thCategory'),   // 表头「分类」列
    rate: document.getElementById('cardRate'),    rateSub: document.getElementById('cardRateSub'),
    updated: document.getElementById('cardUpdated'),
    updatedSub: document.getElementById('cardUpdatedSub'),
    status: document.getElementById('cardStatus'),
    statusSub: document.getElementById('cardStatusSub'),
    items: document.getElementById('cardItems'),
    itemsSub: document.getElementById('cardItemsSub'),
    snaps: document.getElementById('cardSnaps'),
    scrim: document.getElementById('scrim'),
    drawer: document.getElementById('drawer'),
    dName: document.getElementById('dName'),
    dEng: document.getElementById('dEng'),
    dIcon: document.getElementById('dIcon'),
    dKv: document.getElementById('dKv'),
    dWarn: document.getElementById('dWarn'),
    dSpark: document.getElementById('dSpark'),
    dChart: document.getElementById('dChart'),
    dHistory: document.getElementById('dHistory')
  };

  const store = ui.loadPageState();
  const state = {
    category: '全部',
    search: '',
    onlyError: false,
    sort: 'name',
    order: 'asc',
    items: [],
    visible: [],
    categories: [],
    meta: null,
    autoTimer: null,
    countdown: 60,
    drawerChart: null
  };

  const UNIT_LABEL = { d: 'd 神圣石', e: 'e 崇高石' };

  /* ---------------------------------------------------------- 单位 */
  function unit() { return ui.state.unit; }
  function rate() { return ui.state.rate || null; }

  /** 取得当前展示单位下的价格（接口已给出 base 与 d 两套） */
  function priceOf(item, field) {
    const baseField = field;                 // buy_avg / sell_avg / buy_avg_24h ...
    const dField = 'd_' + field;
    if (unit() === 'd' && item[dField] !== undefined && item[dField] !== null) return item[dField];
    return item[baseField];
  }

  function displayed(item, prefix) {
    // prefix: '' | 'latest_'  (latest_buy1 / latest_sell1)
    const buy = prefix === 'latest_' ? priceOf(item, 'latest_buy1') : item[prefix + 'buy_avg'];
    const sell = prefix === 'latest_' ? priceOf(item, 'latest_sell1') : item[prefix + 'sell_avg'];
    return { buy: buy, sell: sell };
  }

  /* ---------------------------------------------------------- 元信息卡 */
  function renderMeta() {
    const meta = state.meta;
    if (!meta) return;
    const r = meta.rate && meta.rate.d_to_e;
    els.rate.textContent = r ? '1 d = ' + P.num(r, r >= 100 ? 0 : 2) + ' e' : '—';
    els.rateSub.textContent = r
      ? (meta.rate.source || '') + ' · 1 神圣石 = ' + P.num(r, 2) + ' 崇高石'
      : '汇率未获取';

    els.updated.textContent = meta.fetched_at ? P.shortTime(meta.fetched_at) : '—';
    els.updatedSub.textContent = meta.fetched_at ? P.timeAgo(meta.fetched_at) + ' · ' + (meta.source || '') : '等待首次同步';

    const f = meta.fetch;
    if (f && f.ok) {
      els.status.textContent = f.skipped ? '已是最新' : '正常';
      els.statusSub.textContent = '最近同步 ' + P.shortTime(f.at) + ' · ' + (f.item_count || 0) + ' 条';
      els.status.style.color = 'var(--up)';
    } else if (f && !f.ok) {
      els.status.textContent = '失败';
      els.statusSub.textContent = (f.error || '未知错误').slice(0, 90);
      els.status.style.color = 'var(--down)';
    } else {
      els.status.textContent = '本地数据';
      els.statusSub.textContent = '尚未执行仓库同步（数据来源：GitHub Actions）';
      els.status.style.color = 'var(--warn)';
    }

    els.items.textContent = (meta.item_count || 0) + ' / ' + (meta.error_count || 0);
    els.itemsSub.textContent = '异常条目 ' + (meta.error_count || 0) + ' 条（橙色行）';
    els.snaps.textContent = meta.snapshot_total || 0;
  }

  /* ---------------------------------------------------------- 分类 Tab */
  function renderTabs() {
    const cats = [{ category: '全部', count: state.meta ? state.meta.item_count : 0, errors: state.meta ? state.meta.error_count : 0 }]
      .concat(state.meta ? state.meta.categories : []);
    els.tabs.innerHTML = cats.map((c) => {
      const active = state.category === c.category ? ' active' : '';
      const err = c.errors ? '<span class="n" style="color:var(--warn)">⚠' + c.errors + '</span>' : '';
      return '<span class="tab' + active + '" data-cat="' + P.escapeHtml(c.category) + '">' +
        P.escapeHtml(c.category) + '<span class="n">' + c.count + '</span>' + err + '</span>';
    }).join('');
    // 「分类」列：只在按某个分类筛选时才显示（全部时该列内容都相同，没有意义）。
    // 注意必须同时隐藏表头与单元格，否则表头列数会与内容列数错位。
    els.table.classList.toggle('hide-category', state.category === '全部');
  }

  /* ---------------------------------------------------------- 表格 */
  function ratioCell(v) {
    return '<td class="num ' + P.cls(v) + '">' + P.pct(v) + '</td>';
  }

  function renderTable() {
    const rows = state.visible;
    els.empty.classList.toggle('hidden', rows.length > 0);
    if (!rows.length) { els.body.innerHTML = ''; return; }
    const u = unit();
    els.body.innerHTML = rows.map((it, idx) => {
      const buy = priceOf(it, 'buy_avg');
      const sell = priceOf(it, 'sell_avg');
      const b24 = priceOf(it, 'buy_avg_24h');
      const s24 = priceOf(it, 'sell_avg_24h');
      const lb = priceOf(it, 'latest_buy1');
      const ls = priceOf(it, 'latest_sell1');
      const status = it.error
        ? '<span class="err-mark" title="' + P.escapeHtml(it.error_info || '数据源标记异常') + '">⚠ 异常' +
          (it.anomaly_count ? ' (' + it.anomaly_count + ')' : '') + '</span>'
        : '<span class="muted">正常</span>';
      return '<tr data-idx="' + idx + '" class="' + (it.error ? 'row-error' : '') + '">' +
        '<td><img class="icon" loading="lazy" src="' + P.escapeHtml(it.icon || '') + '" alt="" onerror="this.style.visibility=\'hidden\'"></td>' +
        '<td class="name">' + P.escapeHtml(it.item_name) + '</td>' +
        '<td class="eng">' + P.escapeHtml(it.engname) + '</td>' +
        '<td class="eng">' + P.escapeHtml(it.category) + '</td>' +
        '<td class="num">' + P.num(buy) + '</td>' +
        '<td class="num">' + P.num(sell) + '</td>' +
        ratioCell(it.buy_ratio) + ratioCell(it.sell_ratio) +
        '<td class="num muted">' + P.num(b24) + ' / ' + P.num(s24) + '</td>' +
        '<td class="num muted">' + P.num(lb) + ' / ' + P.num(ls) + '</td>' +
        '<td><span class="unit-tag">' + u + '</span></td>' +
        '<td class="eng">' + P.escapeHtml((it.latest_datetime || '').slice(5)) + '</td>' +
        '<td>' + status + '</td>' +
        '</tr>';
    }).join('');
  }

  /* ---------------------------------------------------------- 数据加载 */
  async function load() {
    try {
      const data = await P.api.prices({
        category: state.category === '全部' ? null : state.category,
        only_error: state.onlyError ? 'true' : null
      });
      state.items = data.items || [];
      ui.setRate(data.d_to_e);
      refreshView();
    } catch (err) {
      P.ui.toast('价格加载失败：' + P.escapeHtml(err.message), 'err');
      state.items = [];
      state.visible = [];
      renderTable();
    }
  }

  async function loadAll() {
    const meta = await ui.loadMeta();
    if (meta) {
      state.meta = meta;
      renderMeta();
      renderTabs();
    }
    await load();
    saveState();
  }

  function saveState() {
    ui.savePageState({
      category: state.category, search: state.search, onlyError: state.onlyError,
      sort: state.sort, order: state.order
    });
  }

  /* ---------------------------------------------------------- 抽屉详情 */
  function openDrawer(item) {
    els.dName.textContent = item.item_name;
    els.dEng.textContent = item.engname + ' · ' + item.category;
    els.dIcon.src = item.icon || '';
    els.dWarn.innerHTML = item.error
      ? '<div class="badge badge-warn" style="margin-bottom:12px">⚠ 数据源标记异常：' + P.escapeHtml(item.error_info || '无详情') + '</div>'
      : '';
    const u = unit();
    const kv = [
      ['分类', P.escapeHtml(item.category)],
      ['数据源单位', item.unit],
      ['买入均价', P.num(priceOf(item, 'buy_avg')) + ' ' + u],
      ['卖出均价', P.num(priceOf(item, 'sell_avg')) + ' ' + u],
      ['昨日买入均价', P.num(priceOf(item, 'buy_avg_yesterday')) + ' ' + u],
      ['昨日卖出均价', P.num(priceOf(item, 'sell_avg_yesterday')) + ' ' + u],
      ['买入涨跌幅', '<span class="' + P.cls(item.buy_ratio) + '">' + P.pct(item.buy_ratio) + '</span>'],
      ['卖出涨跌幅', '<span class="' + P.cls(item.sell_ratio) + '">' + P.pct(item.sell_ratio) + '</span>'],
      ['12h 买/卖', P.num(priceOf(item, 'buy_avg_12h')) + ' / ' + P.num(priceOf(item, 'sell_avg_12h'))],
      ['24h 买/卖', P.num(priceOf(item, 'buy_avg_24h')) + ' / ' + P.num(priceOf(item, 'sell_avg_24h'))],
      ['最新买1 / 卖1', P.num(priceOf(item, 'latest_buy1')) + ' / ' + P.num(priceOf(item, 'latest_sell1'))],
      ['最近价格时间', P.escapeHtml(item.latest_datetime || '—')],
      ['上一买1时间', P.escapeHtml(item.prev_buy1_datetime || '—')],
      ['异常计数', String(item.anomaly_count || 0)],
      ['以 e 折算', P.num(item.e_buy_avg) + ' / ' + P.num(item.e_sell_avg)]
    ];
    els.dKv.innerHTML = kv.map((row) => '<div class="k">' + row[0] + '</div><div class="v">' + row[1] + '</div>').join('');

    els.scrim.classList.add('open');
    els.drawer.classList.add('open');
    loadDrawerHistory(item.engname, item);
  }

  function closeDrawer() {
    els.scrim.classList.remove('open');
    els.drawer.classList.remove('open');
    if (state.drawerChart) { state.drawerChart.destroy(); state.drawerChart = null; }
  }

  async function loadDrawerHistory(engname, item) {
    els.dSpark.innerHTML = '<span class="muted">加载中…</span>';
    els.dChart.innerHTML = '';
    els.dHistory.innerHTML = '';
    try {
      const data = await P.api.history({ item: engname, hours: 168, unit: unit() });
      const series = (data.series && data.series[0]) || { points: [] };
      const sell = series.points.map((p) => p.sell_avg);
      els.dSpark.innerHTML = P.charts.sparkline(sell, { width: Math.max(240, els.dSpark.clientWidth || 300), height: 56, color: 'auto' });
      if (state.drawerChart) state.drawerChart.destroy();
      state.drawerChart = new P.charts.LineChart(els.dChart, { height: 220 });
      state.drawerChart.setHistory([series], 'price');

      const pts = series.points.slice(-40).reverse();
      els.dHistory.innerHTML = pts.length
        ? pts.map((p) => '<tr><td class="eng">' + P.shortTime(p.t) + '</td><td class="num">' + P.num(p.buy_avg) +
          '</td><td class="num">' + P.num(p.sell_avg) + '</td><td class="eng">' + (p.raw_unit || p.unit) + '</td></tr>').join('')
        : '<tr><td colspan="4" class="muted">暂无历史（快照会随时间累积）</td></tr>';
    } catch (err) {
      els.dSpark.innerHTML = '<span class="muted">历史加载失败：' + P.escapeHtml(err.message) + '</span>';
    }
  }

  /* ---------------------------------------------------------- 排序（客户端） */
  function applySort() {
    const key = state.sort, dir = state.order === 'desc' ? -1 : 1;
    const getters = {
      name: (i) => i.item_name || '',
      engname: (i) => i.engname || '',
      category: (i) => i.category || '',
      buy: (i) => priceOf(i, 'buy_avg'),
      sell: (i) => priceOf(i, 'sell_avg'),
      buy_ratio: (i) => i.buy_ratio,
      sell_ratio: (i) => i.sell_ratio,
      latest: (i) => i.latest_datetime || ''
    };
    const get = getters[key] || getters.name;
    state.items.sort((a, b) => {
      const va = get(a), vb = get(b);
      const na = va === null || va === undefined || va === '';
      const nb = vb === null || vb === undefined || vb === '';
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb), 'zh-CN') * dir;
    });
  }

  function refreshView() {
    const q = state.search.trim().toLowerCase();
    state.visible = !q ? state.items.slice() : state.items.filter((i) =>
      (i.item_name || '').toLowerCase().includes(q) ||
      (i.engname || '').toLowerCase().includes(q) ||
      (i.category || '').toLowerCase().includes(q));
    renderTable();
  }

  /* ---------------------------------------------------------- 事件绑定 */
  function bind() {
    els.tabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      state.category = tab.getAttribute('data-cat');
      renderTabs();
      load().then(saveState);
    });

    els.search.addEventListener('input', P.debounce(() => {
      state.search = els.search.value;
      refreshView(); saveState();
    }, 200));

    els.errorOnly.addEventListener('change', () => {
      state.onlyError = els.errorOnly.checked;
      load().then(saveState);
    });

    els.sort.addEventListener('change', () => {
      state.sort = els.sort.value; applySort(); refreshView(); saveState();
    });
    els.order.addEventListener('change', () => {
      state.order = els.order.value; applySort(); refreshView(); saveState();
    });

    document.querySelectorAll('#priceTable thead th').forEach((th) => {
      th.addEventListener('click', () => {
        const col = th.getAttribute('data-col');
        if (['icon', 'unit', 'status', 'buy_24h', 'latest1'].includes(col)) return;
        if (state.sort === col) {
          state.order = state.order === 'asc' ? 'desc' : 'asc';
        } else {
          state.sort = col;
          state.order = ['buy', 'sell', 'buy_ratio', 'sell_ratio', 'latest'].includes(col) ? 'desc' : 'asc';
        }
        els.sort.value = state.sort;
        els.order.value = state.order;
        applySort(); refreshView(); saveState();
      });
    });

    els.unitSwitch.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      ui.setUnit(btn.getAttribute('data-unit'));
    });

    els.body.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (!tr) return;
      const idx = Number(tr.getAttribute('data-idx'));
      const item = state.visible[idx];
      if (item) openDrawer(item);
    });

    document.getElementById('drawerClose').addEventListener('click', closeDrawer);
    els.scrim.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

    els.exportBtn.addEventListener('click', () => {
      const params = new URLSearchParams();
      if (state.category !== '全部') params.set('category', state.category);
      if (state.search) params.set('search', state.search);
      window.location.href = '/api/export.csv?' + params.toString();
    });

    els.auto.addEventListener('change', () => {
      if (els.auto.checked) startAuto(); else stopAuto();
    });

    document.addEventListener('poe:data', () => loadAll());
    ui.onUnitChange(() => { refreshView(); renderTable(); updateUnitSwitch(); });
  }

  function updateUnitSwitch() {
    els.unitSwitch.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-unit') === unit());
    });
  }

  function startAuto() {
    stopAuto();
    state.countdown = 60;
    state.autoTimer = setInterval(() => {
      state.countdown -= 1;
      if (state.countdown <= 0) {
        state.countdown = 60;
        load();
        ui.loadMeta();
      }
      if (els.autoCount) els.autoCount.textContent = '(' + state.countdown + 's)';
    }, 1000);
  }

  function stopAuto() {
    if (state.autoTimer) clearInterval(state.autoTimer);
    state.autoTimer = null;
    if (els.autoCount) els.autoCount.textContent = '';
  }

  /* ---------------------------------------------------------- 启动 */
  ui.init();
  if (store.category) state.category = store.category;
  if (store.search) { state.search = store.search; els.search.value = store.search; }
  if (store.onlyError) { state.onlyError = true; els.errorOnly.checked = true; }
  if (store.sort) { state.sort = store.sort; els.sort.value = store.sort; }
  if (store.order) { state.order = store.order; els.order.value = store.order; }
  updateUnitSwitch();
  bind();
  loadAll().then(() => { applySort(); refreshView(); if (els.auto.checked) startAuto(); });
})();
