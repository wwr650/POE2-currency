/* 历史趋势页逻辑 */
(function () {
  'use strict';
  const P = window.PoE;
  const ui = P.ui;

  const els = {
    windowSwitch: document.getElementById('windowSwitch'),
    unitSwitch: document.getElementById('unitSwitch'),
    category: document.getElementById('categorySelect'),
    reload: document.getElementById('reloadBtn'),
    rateChart: document.getElementById('rateChart'),
    priceChart: document.getElementById('priceChart'),
    itemSelect: document.getElementById('itemSelect'),
    itemFilter: document.getElementById('itemFilter'),
    itemHint: document.getElementById('itemHint'),
    bsLegend: document.getElementById('bsLegend'),
    clearSel: document.getElementById('clearSelBtn'),
    statTable: document.getElementById('statTableWrap'),
    snapBody: document.getElementById('snapBody'),
    snapCount: document.getElementById('snapCount'),
    rateInfo: document.getElementById('rateInfo')
  };

  const state = {
    hours: 168,
    unit: 'd',
    category: '',
    selected: [],
    items: [],
    rateChart: null,
    priceChart: null
  };

  function apiUnit() { return state.unit; }

  /* ---------------------------------------------------------- 道具列表 */
  async function loadItems() {
    // 首选：历史中出现过的道具（带点数）
    state.items = [];
    try {
      const data = await P.api.historyItems(Math.max(state.hours, 720));
      state.items = data.items || [];
    } catch (err) {
      console.warn('history/items 失败，回退到价格库', err);
    }
    // 回退：直接用最新快照的全部道具（保证选择器永不为空）
    if (!state.items.length) {
      try {
        const opts = await P.api.options();
        ui.setRate(opts.d_to_e);
        state.items = (opts.items || []).map((i) => ({
          engname: i.engname, item_name: i.item_name, category: i.category, points: 0
        }));
      } catch (err) {
        P.ui.toast('道具列表加载失败：' + P.escapeHtml(err.message), 'err');
      }
    }
    renderCategoryOptions();
    const defaults = ['Divine Orb', 'Chaos Orb', 'Exalted Orb', 'Mirror of Kalandra'];
    if (!state.selected.length) {
      state.selected = state.items.filter((i) => defaults.includes(i.engname)).map((i) => i.engname).slice(0, 2);
      if (!state.selected.length && state.items.length) state.selected = [state.items[0].engname];
    }
    renderItemSelect();
  }

  function renderCategoryOptions() {
    const cats = [];
    state.items.forEach((i) => { if (i.category && cats.indexOf(i.category) < 0) cats.push(i.category); });
    cats.sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const cur = state.category;
    els.category.innerHTML = '<option value="">全部分类（' + state.items.length + '）</option>' +
      cats.map((c) => {
        const n = state.items.filter((i) => i.category === c).length;
        return '<option value="' + P.escapeHtml(c) + '"' + (c === cur ? ' selected' : '') + '>' +
          P.escapeHtml(c) + '（' + n + '）</option>';
      }).join('');
    els.category.value = cur;
  }

  function visibleItems() {
    const q = (els.itemFilter.value || '').trim().toLowerCase();
    return state.items.filter((i) => {
      if (state.category && i.category !== state.category) return false;
      if (!q) return true;
      return (i.item_name || '').toLowerCase().includes(q) ||
        (i.engname || '').toLowerCase().includes(q) ||
        (i.category || '').toLowerCase().includes(q);   // 也可按分类名过滤
    });
  }

  function renderItemSelect() {
    const rows = visibleItems();
    els.itemSelect.innerHTML = rows.map((i) =>
      '<option value="' + P.escapeHtml(i.engname) + '"' + (state.selected.includes(i.engname) ? ' selected' : '') + '>' +
      (i.category ? i.category + ' · ' : '') +
      P.escapeHtml(i.item_name || i.engname) + ' · ' + P.escapeHtml(i.engname) +
      (i.points ? ' (' + i.points + ')' : '') + '</option>').join('') ||
      '<option value="" disabled>没有匹配的道具</option>';
    if (els.itemHint) {
      els.itemHint.textContent = '显示 ' + rows.length + ' / ' + state.items.length + ' 个道具 · 已选 ' +
        state.selected.length + ' 个' + (state.selected.length ? '：' + state.selected.join('、') : '');
    }
  }

  /* ---------------------------------------------------------- 图表 */
  async function loadCharts() {
    // 汇率
    try {
      const rate = await P.api.rateHistory(state.hours);
      if (state.rateChart) state.rateChart.destroy();
      state.rateChart = new P.charts.LineChart(els.rateChart, { height: 260 });
      state.rateChart.mode = 'rate';
      state.rateChart.setRate(rate.points || []);
      const pts = rate.points || [];
      const last = pts.length ? pts[pts.length - 1].d_to_e : null;
      els.rateInfo.textContent = pts.length
        ? '共 ' + pts.length + ' 个点 · 最新 1 d = ' + P.num(last, 2) + ' e'
        : '暂无数据（每份快照记录一个点）';
    } catch (err) {
      els.rateInfo.textContent = '加载失败：' + err.message;
    }

    // 价格
    if (!state.selected.length) {
      if (state.priceChart) { state.priceChart.destroy(); state.priceChart = null; }
      els.priceChart.innerHTML = '<div class="empty">请选择至少一个道具</div>';
      els.statTable.innerHTML = '';
      return;
    }
    try {
      const data = await P.api.history({ items: state.selected.join(','), hours: state.hours, unit: apiUnit() });
      if (state.priceChart) state.priceChart.destroy();
      state.priceChart = new P.charts.LineChart(els.priceChart, { height: 340 });
      state.priceChart.setHistory(data.series || [], 'price');
      renderStats(data.series || []);
    } catch (err) {
      els.priceChart.innerHTML = '<div class="empty">加载失败：' + P.escapeHtml(err.message) + '</div>';
    }
  }

  function renderStats(series) {
    // 买入 / 卖出配色提示（与图表一致）
    if (els.bsLegend) {
      els.bsLegend.innerHTML =
        '<span class="key" style="margin-right:14px"><span class="dot" style="background:' + P.charts.PAIRS[0][0] + '"></span>买入均价</span>' +
        '<span class="key"><span class="dot" style="background:' + P.charts.PAIRS[0][1] + '"></span>卖出均价</span>' +
        '<span style="margin-left:10px">每个道具用一对颜色（如 ' +
        '<b style="color:' + P.charts.PAIRS[0][0] + '">青</b> / <b style="color:' + P.charts.PAIRS[0][1] + '">橙</b>）区分买卖</span>';
    }
    const rows = series.map((s) => {
      const pts = (s.points || []).filter((p) => p.sell_avg !== null || p.buy_avg !== null);
      const first = pts[0], last = pts[pts.length - 1];
      const dBuy = first && last && first.buy_avg ? (last.buy_avg - first.buy_avg) / first.buy_avg * 100 : null;
      const dSell = first && last && first.sell_avg ? (last.sell_avg - first.sell_avg) / first.sell_avg * 100 : null;
      return { name: s.name, engname: s.engname, unit: s.unit, points: pts.length, last: last, dBuy: dBuy, dSell: dSell };
    });
    els.statTable.innerHTML = '<table class="grid"><thead><tr>' +
      '<th>道具</th><th>英文名</th><th class="num">数据点</th><th class="num">最新买入</th><th class="num">最新卖出</th>' +
      '<th class="num">区间买入变化</th><th class="num">区间卖出变化</th><th>单位</th></tr></thead><tbody>' +
      rows.map((r) => '<tr>' +
        '<td class="name">' + P.escapeHtml(r.name) + '</td>' +
        '<td class="eng">' + P.escapeHtml(r.engname) + '</td>' +
        '<td class="num">' + r.points + '</td>' +
        '<td class="num">' + P.num(r.last && r.last.buy_avg) + '</td>' +
        '<td class="num">' + P.num(r.last && r.last.sell_avg) + '</td>' +
        '<td class="num ' + P.cls(r.dBuy) + '">' + P.pct(r.dBuy) + '</td>' +
        '<td class="num ' + P.cls(r.dSell) + '">' + P.pct(r.dSell) + '</td>' +
        '<td class="eng">' + P.escapeHtml(r.unit || '') + '</td>' +
        '</tr>').join('') + '</tbody></table>';
  }

  async function loadSnapshots() {
    try {
      const data = await P.api.snapshots();
      const items = (data.items || []).slice(0, 200);
      els.snapCount.textContent = '共 ' + data.count + ' 份快照';
      els.snapBody.innerHTML = items.length ? items.map((s) =>
        '<tr><td class="eng">' + P.escapeHtml(P.shortTime(s.fetched_at)) + '</td>' +
        '<td class="num">' + (s.item_count || 0) + '</td>' +
        '<td class="num ' + (s.error_count ? 'down' : 'muted') + '">' + (s.error_count || 0) + '</td>' +
        '<td class="num">' + P.num(s.d_to_e, 2) + '</td>' +
        '<td class="eng">' + P.escapeHtml(s.file || '') + '</td></tr>').join('')
        : '<tr><td colspan="5" class="muted">暂无快照</td></tr>';
    } catch (err) {
      els.snapBody.innerHTML = '<tr><td colspan="5" class="muted">加载失败：' + P.escapeHtml(err.message) + '</td></tr>';
    }
  }

  /* ---------------------------------------------------------- 事件 */
  function bind() {
    els.windowSwitch.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      state.hours = Number(b.getAttribute('data-hours'));
      updateSwitches();
      loadCharts();
      loadItems().then(renderItemSelect);
      saveTrendState();
    });

    els.unitSwitch.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      state.unit = b.getAttribute('data-unit');
      updateSwitches();
      loadCharts();
      saveTrendState();
    });

    els.itemSelect.addEventListener('change', () => {
      const picked = Array.from(els.itemSelect.selectedOptions).map((o) => o.value).filter(Boolean);
      if (picked.length > 5) P.ui.toast('最多同时对比 5 个道具，已保留前 5 个', 'err');
      state.selected = picked.slice(0, 5);
      renderItemSelect();   // 保持选中态，不丢失当前选择
      loadCharts();
      saveTrendState();
    });

    els.category.addEventListener('change', () => {
      state.category = els.category.value;
      renderItemSelect();
      saveTrendState();
    });

    els.clearSel.addEventListener('click', () => {
      state.selected = [];
      renderItemSelect();
      saveTrendState();
      if (state.priceChart) { state.priceChart.destroy(); state.priceChart = null; }
      els.priceChart.innerHTML = '<div class="empty">请选择至少一个道具</div>';
      els.statTable.innerHTML = '';
    });

    els.itemFilter.addEventListener('input', P.debounce(renderItemSelect, 200));
    els.reload.addEventListener('click', () => { loadItems().then(renderItemSelect); loadCharts(); loadSnapshots(); });
  }

  function updateSwitches() {
    els.windowSwitch.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', Number(b.getAttribute('data-hours')) === state.hours);
    });
    els.unitSwitch.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-unit') === state.unit);
    });
  }

  /* ---------------------------------------------------------- 状态持久化 */
  function saveTrendState() {
    ui.savePageState({
      hours: state.hours,
      unit: state.unit,
      selected: state.selected,
      category: state.category
    });
  }

  /* ---------------------------------------------------------- 启动 */
  ui.init();
  const saved = ui.loadPageState();
  state.hours = saved.hours || 168;
  state.unit = saved.unit || 'd';
  state.selected = saved.selected || [];
  state.category = saved.category || '';
  ui.loadMeta();
  updateSwitches();
  bind();
  loadItems().then(() => { renderItemSelect(); loadCharts(); loadSnapshots(); });
})();
