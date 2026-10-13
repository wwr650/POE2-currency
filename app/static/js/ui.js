/* 通用 UI：顶栏状态、单位偏好、提示条（全局 PoE.ui）*/
(function (global) {
  'use strict';

  const P = global.PoE;
  const UNIT_KEY = 'poe2.unit';

  const state = {
    unit: localStorage.getItem(UNIT_KEY) || 'e',   // 展示单位：d / e
    maxUnit: localStorage.getItem('poe2.maxUnit') || null,
    rate: null,                                    // 1 d = rate e
    meta: null,
    listeners: []
  };

  const dom = {
    rate: document.getElementById('rateBadge'),
    updated: document.getElementById('updatedBadge'),
    status: document.getElementById('statusBadge'),
    refresh: document.getElementById('refreshBtn'),
    footNote: document.getElementById('footNote'),
    toastWrap: document.getElementById('toastWrap')
  };

  /* ------------------------------------------------------------ 单位 */
  function setUnit(unit) {
    state.unit = unit === 'd' ? 'd' : 'e';
    localStorage.setItem(UNIT_KEY, state.unit);
    emit();
  }

  function onUnitChange(fn) { state.listeners.push(fn); }
  function emit() { state.listeners.forEach((fn) => { try { fn(state); } catch (e) { console.error(e); } }); }

  /** 把“基准单位”价格换算成当前展示单位 */
  function toUnit(value, baseUnit, rate) {
    const r = rate || state.rate;
    if (value === null || value === undefined) return null;
    if (!r) return value;
    if (baseUnit === 'e' && state.unit === 'd') return value / r;
    if (baseUnit === 'd' && state.unit === 'e') return value * r;
    return value;
  }

  /** 当前展示单位下、按基准单位取值的便捷函数 */
  function pick(item, baseField, dField) {
    if (state.unit === 'd' && dField && item[dField] !== undefined) return item[dField];
    return item[baseField];
  }

  /* ------------------------------------------------------------ 提示 */
  function toast(message, kind, ms) {
    if (!dom.toastWrap) return;
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.innerHTML = message;
    dom.toastWrap.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 320);
    }, ms || (kind === 'err' ? 6000 : 3200));
  }

  /* ------------------------------------------------------------ 顶栏 */
  function renderTop() {
    const meta = state.meta;
    if (dom.rate) {
      dom.rate.textContent = state.rate
        ? '1 d = ' + P.num(state.rate, state.rate >= 100 ? 0 : 2) + ' e'
        : '1 d = — e';
      dom.rate.title = state.rate
        ? '当前汇率 1 神圣石 = ' + P.num(state.rate, 2) + ' 崇高石' + (meta && meta.rate && meta.rate.source ? '（来源：' + meta.rate.source + '）' : '')
        : '汇率尚未获取';
    }
    if (dom.updated) {
      dom.updated.textContent = meta && meta.fetched_at ? '更新 ' + P.shortTime(meta.fetched_at) : '暂无数据';
      dom.updated.title = meta && meta.fetched_at ? P.timeAgo(meta.fetched_at) + '（' + meta.fetched_at + '）' : '';
    }
    if (dom.status) {
      const f = meta && meta.fetch;
      let text = '未同步', klass = 'badge';
      if (f) {
        if (f.ok) { text = f.skipped ? '已是最新' : '同步正常'; klass = 'badge badge-ok'; }
        else { text = '同步失败'; klass = 'badge badge-err'; }
      } else if (meta && meta.ok) { text = '本地数据'; klass = 'badge badge-warn'; }
      dom.status.className = klass;
      dom.status.textContent = text;
      dom.status.title = f && !f.ok ? (f.error || '未知错误') + '\n时间：' + (f.at || '')
        : (f ? (f.skipped ? '最近同步：' + (f.at || '') + '（仓库数据不比本地新）' : '最近成功：' + (f.at || '') + '，共 ' + (f.item_count || 0) + ' 条') : '尚未执行仓库同步（数据来源：GitHub Actions）');
    }
    if (dom.footNote) {
      dom.footNote.textContent = meta
        ? '历史快照 ' + (meta.snapshot_total || 0) + ' 份 · 条目 ' + (meta.item_count || 0) + ' · 异常 ' + (meta.error_count || 0)
        : '';
    }
  }

  function setRate(rate) {
    if (rate !== undefined && rate !== null) state.rate = Number(rate);
    renderTop();
  }

  function setMeta(meta) {
    state.meta = meta;
    if (meta && meta.rate && meta.rate.d_to_e) state.rate = Number(meta.rate.d_to_e);
    renderTop();
  }

  /* ------------------------------------------------------------ 同步按钮
     本地不再直接抓取 API：点击后从 GitHub 仓库拉取 Actions 定时抓取的数据。 */
  async function refresh(force) {
    if (!dom.refresh) return null;
    const btn = dom.refresh;
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin">◌</span> 同步中';
    try {
      const res = await P.api.syncRepo();
      let msg;
      if (res.skipped) {
        msg = '数据已是最新：' + (res.reason || '仓库数据不比本地更新');
      } else {
        msg = '同步成功：' + (res.item_count || 0) + ' 条条目，汇率 ' + P.num(res.d_to_e, 2);
      }
      toast(msg, 'ok', 3200);
      await loadMeta();
      document.dispatchEvent(new CustomEvent('poe:data'));
      return res;
    } catch (err) {
      toast('同步失败：' + P.escapeHtml(err.message) +
        '<br><span class="muted">无法访问 GitHub 仓库？本地已有快照仍可正常查看。</span>', 'err', 8000);
      await loadMeta();
      return null;
    } finally {
      btn.disabled = false;
      btn.innerHTML = old;
    }
  }

  async function loadMeta() {
    try {
      const meta = await P.api.meta();
      setMeta(meta);
      return meta;
    } catch (err) {
      console.warn('meta 加载失败', err);
      return null;
    }
  }

  /* ------------------------------------------------------------ 页面状态持久化
     每个页面使用独立的 localStorage 键，避免互相覆盖
     （看板/趋势/收益各自的筛选与配置互不影响）。 */
  function pageKey() {
    const page = (document.body && document.body.getAttribute('data-page')) || 'app';
    return 'poe2.state.' + page;
  }

  function savePageState(obj, merge) {
    try {
      const next = merge ? Object.assign({}, loadPageState(), obj) : obj;
      localStorage.setItem(pageKey(), JSON.stringify(next));
    } catch (e) { /* 忽略隐私模式下的写入失败 */ }
  }

  function loadPageState() {
    try { return JSON.parse(localStorage.getItem(pageKey()) || '{}'); } catch (e) { return {}; }
  }

  /* ------------------------------------------------------------ 初始化 */
  function init() {
    const page = document.body.getAttribute('data-page');
    document.querySelectorAll('.nav a').forEach((a) => {
      if (a.getAttribute('data-nav') === page) a.classList.add('active');
    });
    if (dom.refresh) dom.refresh.addEventListener('click', () => refresh(true));
    setInterval(() => { if (state.meta) renderTop(); }, 30000);
  }

  global.PoE.ui = {
    state, init, toast, setUnit, onUnitChange, toUnit, pick, setRate, setMeta,
    loadMeta, refresh, renderTop, savePageState, loadPageState
  };
})(window);
