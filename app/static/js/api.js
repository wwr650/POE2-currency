/* API 客户端与通用格式化工具（全局命名空间 PoE）*/
(function (global) {
  'use strict';

  /* 允许通过 window.__POE_API__ 覆盖（默认 /api）；若站点挂在子路径下，
     模板会注入带前缀的相对地址。 */
  const RAW_BASE = (global.__POE_API__ || '/api').replace(/\/+$/, '');
  const API = RAW_BASE;

  async function request(path, options) {
    const opts = Object.assign({ headers: {} }, options || {});
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(API + path, opts);
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
    }
    if (!res.ok) {
      const detail = (data && (data.detail || data.message)) || res.statusText;
      const err = new Error(detail);
      err.status = res.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  const api = {
    request,
    meta: () => request('/meta'),
    prices: (params) => request('/prices?' + qs(params)),
    options: () => request('/options'),
    history: (params) => request('/history?' + qs(params)),
    rateHistory: (hours) => request('/history/rate?hours=' + hours),
    historyItems: (hours) => request('/history/items?hours=' + hours),
    snapshots: () => request('/snapshots'),
    syncRepo: () => request('/sync-repo', { method: 'POST' }),
    health: () => request('/health'),

    profitCalculate: (payload) => request('/profit/calculate', { method: 'POST', body: payload }),
    profitConfigs: () => request('/profit/configs'),
    profitSave: (payload) => request('/profit/save', { method: 'POST', body: payload }),
    profitLoad: (id) => request('/profit/load/' + encodeURIComponent(id)),
    profitDelete: (id) => request('/profit/configs/' + encodeURIComponent(id), { method: 'DELETE' }),

    customItems: () => request('/custom-items'),
    customCreate: (item) => request('/custom-items', { method: 'POST', body: item }),
    customUpdate: (id, item) => request('/custom-items/' + encodeURIComponent(id), { method: 'PUT', body: item }),
    customDelete: (id) => request('/custom-items/' + encodeURIComponent(id), { method: 'DELETE' }),

    backupExport: () => request('/backup/export'),
    backupImport: (body) => request('/backup/import', { method: 'POST', body: body }),
    backupCounts: () => request('/backup/counts')
  };

  function qs(params) {
    const p = new URLSearchParams();
    Object.keys(params || {}).forEach((k) => {
      const v = params[k];
      if (v === undefined || v === null || v === '') return;
      p.set(k, v);
    });
    return p.toString();
  }

  /* ------------------------------------------------------------ 格式化 */
  function num(value, digits) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    const d = digits === undefined ? autoDigits(value) : digits;
    const f = Number(value);
    if (!isFinite(f)) return '—';
    return f.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function autoDigits(v) {
    const a = Math.abs(Number(v));
    if (a === 0) return 2;
    if (a >= 1000) return 0;
    if (a >= 100) return 1;
    if (a >= 1) return 2;
    if (a >= 0.01) return 3;
    return 5;
  }

  function pct(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    const v = Number(value);
    const sign = v > 0 ? '+' : '';
    return sign + v.toFixed(2) + '%';
  }

  function cls(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return 'null';
    const v = Number(value);
    if (v > 0) return 'up';
    if (v < 0) return 'down';
    return 'muted';
  }

  function money(value, unit, digits) {
    return num(value, digits) + ' ' + (unit || '');
  }

  function timeAgo(iso) {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return iso;
    const diff = Date.now() - t;
    const abs = Math.abs(diff);
    const mins = Math.round(abs / 60000);
    if (mins < 1) return diff >= 0 ? '刚刚' : '即将';
    if (mins < 60) return (diff >= 0 ? '' : '') + mins + ' 分钟前';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + ' 小时前';
    return Math.floor(hours / 24) + ' 天前';
  }

  function shortTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function escapeHtml(str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      const args = arguments, self = this;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(self, args), wait || 250);
    };
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  global.PoE = { api, qs, num, pct, cls, money, timeAgo, shortTime, escapeHtml, debounce, download, autoDigits };
})(window);
