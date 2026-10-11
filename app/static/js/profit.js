/* 收益分析页逻辑：门票 + 掉落 + 概率 → 期望收益 / ROI */
(function () {
  'use strict';
  const P = window.PoE;
  const ui = P.ui;

  const els = {
    cfgList: document.getElementById('cfgList'),
    customList: document.getElementById('customList'),
    cfgName: document.getElementById('cfgName'),
    save: document.getElementById('saveBtn'),
    newBtn: document.getElementById('newBtn'),
    exportBtn: document.getElementById('exportBtn'),
    importFile: document.getElementById('importFile'),
    displayUnit: document.getElementById('displayUnit'),
    minutes: document.getElementById('minutes'),
    rateText: document.getElementById('rateText'),
    calcState: document.getElementById('calcState'),
    ticketPicker: document.getElementById('ticketPicker'),
    ticketAdd: document.getElementById('ticketAdd'),
    ticketList: document.getElementById('ticketList'),
    dropPicker: document.getElementById('dropPicker'),
    dropAdd: document.getElementById('dropAdd'),
    dropList: document.getElementById('dropList'),
    ciName: document.getElementById('ciName'),
    ciEng: document.getElementById('ciEng'),
    ciPrice: document.getElementById('ciPrice'),
    ciUnit: document.getElementById('ciUnit'),
    ciAdd: document.getElementById('ciAdd'),
    netBig: document.getElementById('netBig'),
    sumCost: document.getElementById('sumCost'),
    sumRevenue: document.getElementById('sumRevenue'),
    sumMax: document.getElementById('sumMax'),
    sumNet: document.getElementById('sumNet'),
    sumRoi: document.getElementById('sumRoi'),
    sumPerMin: document.getElementById('sumPerMin'),
    sumPerHour: document.getElementById('sumPerHour'),
    warnList: document.getElementById('warnList'),
    detailTable: document.getElementById('detailTable')
  };

  const D = P.dropRows;   // 共用工具：数值最多 2 位小数等
  const SOURCES = [
    ['', '默认（卖出均价）'],
    ['sell_avg', '卖出均价'],
    ['buy_avg', '买入均价'],
    ['sell_avg_24h', '卖出 24h 均价'],
    ['buy_avg_24h', '买入 24h 均价'],
    ['latest_sell1', '最新卖 1'],
    ['latest_buy1', '最新买 1']
  ];

  const state = {
    id: null,
    name: '',
    display_unit: 'd',
    minutes_per_run: 5,
    ticket: [],
    drops: [],
    options: [],
    custom: [],
    result: null,
    timer: null,
    restoring: true
  };

  // 可搜索选择器实例（在 bind/renderPickers 之前创建）
  const pick = { ticket: null, drop: null };
  if (P.searchSelect) {
    pick.ticket = P.searchSelect(els.ticketPicker, { placeholder: '搜索道具加入门票（中/英文/分类）…' });
    pick.drop = P.searchSelect(els.dropPicker, { placeholder: '搜索道具加入掉落（中/英文/分类）…' });
  }
  P.__picks = pick;   // 供自动化测试检查选项与搜索行为
  // 供自动化测试直接调用渲染与计算（与界面同一份逻辑）
  P.__profit = {
    renderEntries,
    calculate,
    state
  };

  const unitLabel = (u) => (u === 'd' ? 'd' : 'e');

  /* ---------------------------------------------------------- 初始化选项 */
  async function loadOptions() {
    state.options = [];
    state.custom = [];
    try {
      const [opts, custom] = await Promise.all([
        P.api.options(),
        P.api.customItems().catch(() => ({ items: [] }))
      ]);
      state.options = opts.items || [];
      state.custom = custom.items || [];
      ui.setRate(opts.d_to_e);
      els.rateText.textContent = opts.d_to_e ? '1 d = ' + D.n2(opts.d_to_e, 2) + ' e' : '—';
    } catch (err) {
      P.ui.toast('价格库加载失败：' + P.escapeHtml(err.message) + '<br><span class="muted">请确认服务仍在运行，然后刷新页面。</span>', 'err', 9000);
      console.error('options 加载失败', err);
    }
    // 兜底：/api/options 失败时改用 /api/prices，保证下拉框不会为空
    if (!state.options.length) {
      try {
        const prices = await P.api.prices({});
        state.options = (prices.items || []).filter((i) => i.engname);
        console.warn('已回退到 /api/prices，共', state.options.length, '项');
      } catch (e2) {
        console.error('回退加载也失败', e2);
      }
    }
    renderPickers();
    // 自定义道具：列表与选择器都按统一逻辑同步（custom.js）
    if (customCtl) { customCtl.render(); customCtl.syncPickers(); }
    if (!state.options.length && !state.custom.length) {
      if (pick.ticket) pick.ticket.setItems([{ value: '', label: '（暂无价格数据）', category: '提示', meta: '' }]);
      if (pick.drop) pick.drop.setItems([{ value: '', label: '（暂无价格数据）', category: '提示', meta: '' }]);
    }
  }

  function renderPickers() {
    const rate = ui.state.rate || 1;
    const priceText = (i) => {
      const base = i.unit || 'e';
      const price = i.sell_avg || i.buy_avg;
      if (price === null || price === undefined) return '无报价';
      return state.display_unit === base
        ? D.n2(price) + ' ' + base
        : D.n2(base === 'e' ? price / rate : price * rate) + ' ' + state.display_unit;
    };

    // 价格库道具：按分类分组 + 可直接搜索（中文名 / 英文名 / 分类）
    const marketItems = state.options.map((i) => ({
      value: i.engname,
      label: (i.item_name || i.engname) + ' · ' + i.engname,
      engname: i.engname,
      category: i.category || '未分类',
      meta: priceText(i)
    }));
    // 自定义道具置顶，单独一组
    const customItems = state.custom.map((i) => ({
      value: 'custom:' + i.id,
      label: '[自定义] ' + i.name,
      engname: i.engname || '',
      category: '自定义道具',
      meta: D.n2(i.price) + ' ' + i.unit
    }));

    const all = customItems.concat(marketItems);
    if (pick.ticket) pick.ticket.setItems(all);
    if (pick.drop) pick.drop.setItems(all);

    if (!all.length) {
      if (pick.ticket) pick.ticket.setItems([{ value: '', label: '（暂无价格数据）', category: '提示', meta: '' }]);
      if (pick.drop) pick.drop.setItems([{ value: '', label: '（暂无价格数据）', category: '提示', meta: '' }]);
    }
  }

  function optionByKey(key) {
    if (key && key.startsWith('custom:')) {
      const id = key.slice(7);
      const item = state.custom.find((c) => c.id === id);
      if (!item) return null;
      return { custom: true, custom_name: item.name, engname: '', unit: item.unit, price: item.price, name: item.name };
    }
    const item = state.options.find((o) => o.engname === key);
    if (!item) return null;
    return { custom: false, engname: item.engname, name: item.item_name, unit: item.unit,
             buy_avg: item.buy_avg, sell_avg: item.sell_avg, buy_avg_24h: item.buy_avg_24h,
             sell_avg_24h: item.sell_avg_24h, latest_buy1: item.latest_buy1, latest_sell1: item.latest_sell1,
             e_buy_avg: item.e_buy_avg, e_sell_avg: item.e_sell_avg, category: item.category };
  }

  /* ---------------------------------------------------------- 入口操作 */
  function pickerValue(which) {
    if (pick[which]) return pick[which].value;
    // 兜底：没有可搜索组件时退回原生 select
    const sel = which === 'ticket' ? els.ticketPicker : els.dropPicker;
    return sel ? sel.value : '';
  }

  function addTicket(key) {
    const base = optionByKey(key || pickerValue('ticket'));
    if (!base) { P.ui.toast('请先在上方搜索并选择一个道具', 'err'); return; }
    state.ticket.push(base.custom
      ? { custom: true, custom_name: base.custom_name, unit: base.unit, price: base.price, qty: 1, price_source: '' }
      : { engname: base.engname, name: base.name, qty: 1, price_source: 'sell_avg' });
    renderEntries(); scheduleCalc(); saveNow();
  }

  function addDrop(key) {
    const base = optionByKey(key || pickerValue('drop'));
    if (!base) { P.ui.toast('请先在上方搜索并选择一个道具', 'err'); return; }
    state.drops.push(base.custom
      ? { custom: true, custom_name: base.custom_name, unit: base.unit, price: base.price,
          qty: 1, chance: 100, enabled: true, price_source: '' }
      : { engname: base.engname, name: base.name, qty: 1, chance: 100, enabled: true, price_source: 'sell_avg' });
    renderEntries(); scheduleCalc(); saveNow();
  }

  /* ---------------------------------------------------------- 行渲染 */
  function unitPriceOf(entry) {
    const rate = ui.state.rate || 1;
    const source = entry.price_source || 'sell_avg';
    if (entry.custom) {
      const base = entry.unit || 'd';
      const price = Number(entry.price) || 0;
      return toDisplay(price, base, rate);
    }
    const item = state.options.find((o) => o.engname === entry.engname);
    if (!item) return null;   // 价格库尚未加载或查不到该道具（不要当成 0）
    const base = item.unit || 'e';
    const dField = 'd_' + source;
    // 展示为 d 时优先使用后端折算字段，缺失再回退换算
    if (state.display_unit === 'd' && item[dField] !== undefined && item[dField] !== null) {
      return Number(item[dField]) || 0;
    }
    const raw = item[source] !== undefined && item[source] !== null
      ? item[source] : (item.sell_avg || item.buy_avg || 0);
    return toDisplay(Number(raw) || 0, base, rate);
  }

  /** 行内展示用：价格库未就绪时显示占位符而不是 0.00 */
  function fmtUnitPrice(entry) {
    const v = unitPriceOf(entry);
    return (v === null || v === undefined) ? '—' : D.n2(v) + ' ' + state.display_unit;
  }

  function toDisplay(price, baseUnit, rate) {
    if (state.display_unit === baseUnit) return price;
    if (baseUnit === 'e' && state.display_unit === 'd') return rate ? price / rate : price;
    if (baseUnit === 'd' && state.display_unit === 'e') return price * rate;
    return price;
  }

  function sourceSelect(entry) {
    const opts = SOURCES.map(([v, label]) =>
      '<option value="' + v + '"' + ((entry.price_source || '') === v ? ' selected' : '') + '>' + label + '</option>').join('');
    return '<select class="src">' + opts + '</select>';
  }

  function renderEntries() {
    // 门票（数量固定为 1，界面上不输入数量）
    els.ticketList.innerHTML = state.ticket.map((entry, i) => {
      const up = unitPriceOf(entry);
      const sub = (up || 0) * 1;
      if (entry.custom) {
        return '<div class="entry custom" data-kind="ticket" data-idx="' + i + '">' +
          '<span class="muted" title="自定义道具">✎</span>' +
          '<div class="nm"><input type="text" class="custom-name" value="' + P.escapeHtml(entry.custom_name) + '" placeholder="名称">' +
          '<div class="sub">自定义道具</div></div>' +
          '<input type="number" class="price" step="0.01" min="0" value="' + (entry.price || 0) + '" title="自定义单价">' +
          '<select class="unit"><option value="d"' + (entry.unit === 'd' ? ' selected' : '') + '>d</option>' +
          '<option value="e"' + (entry.unit === 'e' ? ' selected' : '') + '>e</option></select>' +
          '<span class="unit-price" title="当前单价">' + fmtUnitPrice(entry) + '</span>' +
          '<span class="calc" title="小计">' + D.n2(sub) + '</span>' +
          '<button class="btn btn-sm btn-danger del" title="删除">✕</button></div>';
      }
      return '<div class="entry" data-kind="ticket" data-idx="' + i + '">' +
        '<span class="muted" title="价格库道具">◈</span>' +
        '<div class="nm"><div>' + P.escapeHtml(entry.name || entry.engname) + '</div>' +
        '<div class="sub">' + P.escapeHtml(entry.engname) + '</div></div>' +
        sourceSelect(entry) +
        '<span class="unit-price" title="所选价格来源的单价">' + fmtUnitPrice(entry) + '</span>' +
        '<span class="calc" title="小计">' + D.n2(sub) + '</span>' +
        '<button class="btn btn-sm btn-danger del" title="删除">✕</button></div>';
    }).join('') || '<div class="muted" style="font-size:12.5px">尚未添加门票（无成本可留空）</div>';

    // 掉落（行渲染由 shared.js 提供）
    els.dropList.innerHTML = state.drops.map((entry, i) => D.dropRow(entry, i, {
      up: unitPriceOf(entry),
      unit: state.display_unit,
      mode: 'manual',               // 收益分析：概率由用户手填
      sourceSelect: sourceSelect(entry)
    })).join('') || '<div class="muted" style="font-size:12.5px">尚未添加掉落条目</div>';
  }

  /* ---------------------------------------------------------- 计算 */
  function scheduleCalc() {
    clearTimeout(state.timer);
    state.timer = setTimeout(calculate, 260);
  }

  function buildPayload() {
    return {
      display_unit: state.display_unit,
      minutes_per_run: Number(els.minutes && els.minutes.value) || 0,
      // 数量固定为 1：界面上不输入数量，期望收益由「概率 × 单价」决定
      ticket: state.ticket.map((e) => Object.assign({}, e, { qty: 1 })),
      drops: state.drops.map((e) => Object.assign({}, e, {
        qty: 1,
        chance: Math.max(0, Math.min(100, Number(e.chance) || 0)),
        enabled: e.enabled !== false
      }))
    };
  }

  async function calculate() {
    els.calcState.textContent = '计算中…';
    try {
      const res = await P.api.profitCalculate(buildPayload());
      state.result = res;
      renderResult(res);
      els.calcState.textContent = '已更新 ' + new Date().toLocaleTimeString('zh-CN');
      state.restoring = false;
      saveNow();          // 每次计算后保存视图状态（含数量、概率等编辑）
    } catch (err) {
      els.calcState.textContent = '计算失败：' + err.message;
    }
  }

  function renderResult(res) {
    const u = res.display_unit;
    const s = res.summary;
    els.sumCost.textContent = D.n2(s.total_cost) + ' ' + u;
    els.sumRevenue.textContent = D.n2(s.expected_revenue) + ' ' + u;
    els.sumMax.textContent = D.n2(s.max_revenue) + ' ' + u;
    els.sumNet.textContent = D.n2(s.net) + ' ' + u;
    els.sumNet.className = 'v ' + P.cls(s.net);
    els.sumRoi.textContent = s.roi === null ? '—' : P.pct(s.roi);
    els.sumRoi.className = 'v ' + P.cls(s.roi);
    els.sumPerMin.textContent = s.per_minute === null ? '—' : D.n2(s.per_minute) + ' ' + u;
    els.sumPerHour.textContent = s.per_hour === null ? '—' : D.n2(s.per_hour, 2) + ' ' + u;
    els.netBig.className = 'big-net ' + P.cls(s.net);
    els.netBig.innerHTML = '<span class="lbl">净收益（期望收益 − 门票成本）</span>' +
      (s.net >= 0 ? '+' : '') + D.n2(s.net) + ' ' + u;

    els.warnList.innerHTML = (res.warnings || []).map((w) => '<li>' + P.escapeHtml(w) + '</li>').join('');

    const rows = []
      .concat((res.ticket || []).map((t) => ({ kind: '门票', ...t, amount: -t.subtotal })))
      .concat((res.drops || []).map((t) => ({ kind: t.enabled ? '掉落' : '掉落(停用)', ...t, amount: t.expected })));
    els.detailTable.innerHTML = rows.length
      ? '<div class="detail-wrap"><table class="detail-table"><thead><tr><th>类型</th><th>道具</th><th class="num">数量</th>' +
        '<th class="num">概率</th>' +
        '<th class="num">单价</th><th class="num">金额</th></tr></thead><tbody>' +
        rows.map((r) => '<tr>' +
          '<td class="eng">' + r.kind + '</td>' +
          '<td class="name">' + P.escapeHtml(r.name) + '</td>' +
          '<td class="num">' + D.n2(r.qty, 2) + '</td>' +
          '<td class="num">' + (r.chance === undefined ? '—' : D.n2(r.chance) + '%') + '</td>' +
          '<td class="num">' + D.n2(r.unit_price) + '</td>' +
          '<td class="num ' + P.cls(r.amount) + '">' + D.n2(r.amount) + '</td>' +
          '</tr>').join('') + '</tbody></table></div>'
      : '<span class="muted">暂无条目</span>';
  }

  /* ---------------------------------------------------------- 配置保存/加载 */
  async function loadConfigs() {
    try {
      const data = await P.api.profitConfigs();
      const items = data.items || [];
      els.cfgList.innerHTML = items.length ? items.map((c) =>
        '<div class="cfg-item" data-id="' + P.escapeHtml(c.id) + '">' +
        '<span class="del" data-del="' + P.escapeHtml(c.id) + '" title="删除">✕</span>' +
        '<div class="n">' + P.escapeHtml(c.name || '未命名') + '</div>' +
        '<div class="d">' + P.escapeHtml(P.shortTime(c.updated_at || c.created_at)) + ' · ' +
        (c.ticket || []).length + ' 门票 / ' + (c.drops || []).length + ' 掉落</div></div>').join('')
        : '<div class="muted">暂无保存的配置</div>';
    } catch (err) {
      els.cfgList.innerHTML = '<div class="muted">加载失败：' + P.escapeHtml(err.message) + '</div>';
    }
  }

  function applyConfig(cfg) {
    state.id = cfg.id || null;
    state.name = cfg.name || '';
    state.display_unit = cfg.display_unit === 'e' ? 'e' : 'd';
    els.displayUnit.value = state.display_unit;
    els.cfgName.value = state.name;
    els.minutes.value = cfg.minutes_per_run || 0;
    state.ticket = (cfg.ticket || []).map((t) => Object.assign({}, t));
    state.drops = (cfg.drops || []).map((d) => Object.assign({ enabled: true, chance: 100 }, d));
    renderEntries();
    calculate();
    P.ui.toast('已加载配置：' + P.escapeHtml(state.name || state.id), 'ok');
  }

  async function saveConfig() {
    const payload = Object.assign(buildPayload(), {
      id: state.id,
      name: els.cfgName.value.trim() || ('配置 ' + new Date().toLocaleString('zh-CN'))
    });
    try {
      const res = await P.api.profitSave(payload);
      state.id = res.id;
      state.name = res.config.name;
      P.ui.toast('已保存：' + P.escapeHtml(res.config.name) + (res.replaced ? '（覆盖）' : ''), 'ok');
      loadConfigs();
    } catch (err) {
      P.ui.toast('保存失败：' + P.escapeHtml(err.message), 'err');
    }
  }

  /* ---------------------------------------------------------- 自定义道具
     与 shared.js 共同提供自定义道具面板逻辑 */
  let customCtl = null;

  function initCustomPanel() {
    if (!P.customItems) return;
    customCtl = P.customItems.controller({
      listEl: els.customList,
      nameEl: els.ciName, engEl: els.ciEng, priceEl: els.ciPrice, unitEl: els.ciUnit,
      addBtn: els.ciAdd,
      exportBtn: document.getElementById('backupExport'),
      importBtn: document.getElementById('backupImport'),
      importFile: document.getElementById('backupFile'),
      base: () => ({ customList: state.custom, display_unit: state.display_unit }),
      pickTicket: pick.ticket,
      pickDrop: pick.drop,
      list: {
        ticket: { list: () => state.ticket, render: renderEntries },
        drop: { list: () => state.drops, render: renderEntries }
      },
      onRefresh: async () => {                      // 重新拉取自定义道具数据
        try {
          const custom = await P.api.customItems();
          state.custom = custom.items || [];
        } catch (err) { /* 忽略：保留原数据 */ }
      },
      onChange: () => { renderEntries(); calculate(); saveNow(); }
    });
    customCtl.render();
  }

  /* ---------------------------------------------------------- 事件 */
  function bind() {
    els.ticketAdd.addEventListener('click', () => addTicket());
    els.dropAdd.addEventListener('click', () => addDrop());
    els.save.addEventListener('click', saveConfig);
    els.exportBtn.addEventListener('click', () => {
      P.download('poe2_profit_' + (state.name || 'config') + '.json',
        JSON.stringify(Object.assign(buildPayload(), { name: els.cfgName.value, id: state.id }), null, 2));
    });
    // 自定义条目：直接在行内新增一条
    document.querySelectorAll('.custom-add').forEach((btn) => {
      btn.addEventListener('click', () => {
        const list = btn.getAttribute('data-list') === 'ticket' ? state.ticket : state.drops;
        const entry = { custom: true, custom_name: '自定义道具', unit: state.display_unit, price: 0,
                        qty: 1, price_source: '' };
        if (list === state.drops) { entry.chance = 100; entry.enabled = true; }
        list.push(entry);
        renderEntries(); scheduleCalc(); saveNow();
      });
    });
    document.getElementById('clearEntriesBtn').addEventListener('click', () => {
      if (!confirm('清空当前所有门票与掉落条目？')) return;
      state.ticket = []; state.drops = [];
      renderEntries(); calculate(); saveNow();
      P.ui.toast('已清空门票与掉落', 'ok');
    });
    document.getElementById('importLabel').addEventListener('click', () => els.importFile.click());
    els.importFile.addEventListener('change', async () => {
      const file = els.importFile.files[0];
      if (!file) return;
      try {
        const cfg = JSON.parse(await file.text());
        applyConfig(cfg);
      } catch (err) {
        P.ui.toast('导入失败：' + P.escapeHtml(err.message), 'err');
      }
      els.importFile.value = '';
    });

    els.newBtn.addEventListener('click', () => {
      state.id = null; state.name = ''; els.cfgName.value = '';
      state.ticket = []; state.drops = [];
      renderEntries(); calculate();
      P.ui.toast('已新建空白配置', 'ok');
    });

    els.displayUnit.addEventListener('change', () => {
      state.display_unit = els.displayUnit.value;
      renderEntries(); calculate();
    });
    els.minutes.addEventListener('input', P.debounce(calculate, 300));

    // 条目列表：输入与删除（事件委托）
    function onListChange(e) {
      const row = e.target.closest('.entry');
      if (!row || !row.hasAttribute('data-kind')) return;
      const kind = row.getAttribute('data-kind');
      const idx = Number(row.getAttribute('data-idx'));
      const list = kind === 'ticket' ? state.ticket : state.drops;
      const entry = list[idx];
      if (!entry) return;

      if (e.target.classList.contains('del')) {
        list.splice(idx, 1);
        renderEntries(); scheduleCalc();
        return;
      }
      if (e.target.classList.contains('chance')) {
        // 概率：0~100，支持小数，超范围自动收敛
        entry.chance = Math.max(0, Math.min(100, Number(e.target.value) || 0));
      }
      else if (e.target.classList.contains('price')) entry.price = Number(e.target.value) || 0;
      else if (e.target.classList.contains('unit')) entry.unit = e.target.value;
      else if (e.target.classList.contains('src')) entry.price_source = e.target.value;
      else if (e.target.classList.contains('enabled')) entry.enabled = e.target.checked;
      else if (e.target.classList.contains('custom-name')) entry.custom_name = e.target.value;
      else return;

      // 实时更新行内单价 / 金额（数量固定为 1，避免整表重绘导致失焦）
      const up = unitPriceOf(entry);
      const chance = Math.max(0, Math.min(100, Number(entry.chance) || 0));
      const priceSpan = row.querySelector('.unit-price');
      if (priceSpan) priceSpan.textContent = fmtUnitPrice(entry);
      const calc = row.querySelector('.calc');
      if (calc) {
        const amount = kind === 'drop'
          ? (entry.enabled === false ? 0 : (up || 0) * chance / 100)
          : (up || 0);
        calc.textContent = D.n2(amount);
      }
      const sub = row.querySelector('.nm .sub');
      if (sub && !entry.custom) sub.textContent = entry.engname;
      scheduleCalc();
    }

    els.ticketList.addEventListener('input', onListChange);
    els.ticketList.addEventListener('change', onListChange);
    els.dropList.addEventListener('input', onListChange);
    els.dropList.addEventListener('change', onListChange);
    // 删除按钮是 click 事件（input/change 不会因点击按钮触发），必须单独监听
    els.ticketList.addEventListener('click', onListClick);
    els.dropList.addEventListener('click', onListClick);

    function onListClick(e) {
      const row = e.target.closest('.entry');
      if (!row || !row.hasAttribute('data-kind')) return;
      const kind = row.getAttribute('data-kind');
      const idx = Number(row.getAttribute('data-idx'));
      const list = kind === 'ticket' ? state.ticket : state.drops;
      if (idx < 0 || idx >= list.length) return;
      if (e.target.classList.contains('del')) {
        e.preventDefault();
        list.splice(idx, 1);
        renderEntries();
        calculate();
        saveNow();
      }
    }

    els.cfgList.addEventListener('click', async (e) => {
      const del = e.target.closest('.del');
      if (del) {
        e.stopPropagation();
        const id = del.getAttribute('data-del');
        if (!confirm('确定删除该配置？')) return;
        try {
          await P.api.profitDelete(id);
          P.ui.toast('已删除配置', 'ok');
          if (state.id === id) { state.id = null; }
          loadConfigs();
        } catch (err) { P.ui.toast('删除失败：' + err.message, 'err'); }
        return;
      }
      const item = e.target.closest('.cfg-item');
      if (!item) return;
      try {
        const res = await P.api.profitLoad(item.getAttribute('data-id'));
        applyConfig(res.config);
      } catch (err) { P.ui.toast('加载失败：' + err.message, 'err'); }
    });

    document.addEventListener('poe:data', () => {
      loadOptions().then(() => { renderEntries(); calculate(); });
    });
  }

  /** 自定义道具列表：加入门票 / 加入掉落 / 删除
   *  （实际实现已抽到 app/static/js/custom.js） */

  /* ---------------------------------------------------------- 视图状态持久化

  /* ---------------------------------------------------------- 视图状态持久化
     切换页面（切到看板再切回）后仍保留上一节配置的门票/掉落。 */
  function saveNow() {
    if (state.restoring) return;
    ui.savePageState({
      display_unit: state.display_unit,
      minutes_per_run: Number(els.minutes && els.minutes.value) || 0,
      ticket: state.ticket,
      drops: state.drops,
      cfgName: els.cfgName ? els.cfgName.value : ''
    });
  }

  function restoreView() {
    const saved = ui.loadPageState();
    if (!saved || (!saved.ticket && !saved.drops)) return false;
    if (saved.display_unit === 'd' || saved.display_unit === 'e') state.display_unit = saved.display_unit;
    if (saved.cfgName) els.cfgName.value = saved.cfgName;
    if (saved.minutes_per_run !== undefined) els.minutes.value = saved.minutes_per_run;
    state.ticket = (saved.ticket || []).map((t) => Object.assign({}, t));
    state.drops = (saved.drops || []).map((d) => Object.assign({ enabled: true, chance: 100 }, d));
    els.displayUnit.value = state.display_unit;
    return true;
  }

  /** 支持 /profit?load=<配置id>：直接载入指定的收益配置 */
  async function loadFromQuery() {
    const m = (window.location.search || '').match(/[?&]load=([^&]+)/);
    if (!m) return false;
    const id = decodeURIComponent(m[1]);
    try {
      const res = await P.api.profitLoad(id);
      applyConfig(res.config);
      P.ui.toast('已载入导入的配置：' + P.escapeHtml(res.config.name || id), 'ok', 6000);
      return true;
    } catch (err) {
      P.ui.toast('载入配置失败：' + P.escapeHtml(err.message), 'err', 8000);
      return false;
    }
  }

  /* ---------------------------------------------------------- 启动 */
  ui.init();
  initCustomPanel();      // 自定义道具面板
  ui.loadMeta();          // 顶栏徽章（汇率 / 更新时间 / 抓取状态）
  restoreView();          // 先恢复上一节配置，再渲染与计算
  bind();
  renderEntries();        // 首屏渲染：此时价格库未就绪，单价显示占位符 —
  loadOptions().then(() => {
    // 价格库就绪后必须重绘：否则恢复的历史条目单价会一直是 0.00
    renderEntries();
    loadConfigs();
    calculate();          // 计算完成后 restoring=false，随后的改动会自动保存
    return loadFromQuery();
  });
  ui.onUnitChange(() => { els.rateText.textContent = ui.state.rate ? '1 d = ' + D.n2(ui.state.rate, 2) + ' e' : '—'; });
})();
