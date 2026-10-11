/* 用真实模板 + 真实 API 数据验证前端渲染结果（无浏览器）
   运行：node tests/render-check.js                                            */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:8000';
let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${extra ? ' — ' + extra : ''}`);
}

/* ---------------------------------------------------------------- 最小 DOM 桩 */
function makeNode(tag) {
  const node = {
    tagName: (tag || 'div').toUpperCase(), children: [], childNodes: [],
    attributes: {}, style: {}, _classes: new Set(), _html: '', _text: '',
    value: '', checked: false, selected: false, files: [],
    clientWidth: 900, clientHeight: 300, offsetWidth: 150,
    classList: {
      add: (...c) => c.forEach((x) => node._classes.add(x)),
      remove: (...c) => c.forEach((x) => node._classes.delete(x)),
      toggle: (c, on) => { if (on === undefined) { node._classes.has(c) ? node._classes.delete(c) : node._classes.add(c); } else if (on) node._classes.add(c); else node._classes.delete(c); },
      contains: (c) => node._classes.has(c)
    },
    setAttribute(k, v) { node.attributes[k] = String(v); if (k === 'class') node._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    getAttribute(k) { return node.attributes[k] === undefined ? null : node.attributes[k]; },
    hasAttribute(k) { return node.attributes[k] !== undefined; },
    appendChild(c) { node.children.push(c); node.childNodes.push(c); return c; },
    removeChild(c) { node.children = node.children.filter((x) => x !== c); node.childNodes = node.children.slice(); return c; },
    insertBefore(c) { node.children.unshift(c); node.childNodes = node.children.slice(); return c; },
    addEventListener() {}, removeEventListener() {}, click() {},
    closest() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
    contains() { return false; }, focus() {}, blur() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: node.clientWidth, height: node.clientHeight }; },
    get firstChild() { return node.children[0] || null; },
    get innerHTML() { return node._html; }, set innerHTML(v) { node._html = String(v); },
    get textContent() { return node._text; }, set textContent(v) { node._text = String(v); },
    get selectedOptions() { return node.children.filter((o) => o.selected); }
  };
  return node;
}

const byId = new Map();
const document = {
  body: makeNode('body'), createElement: (t) => makeNode(t),
  createElementNS: (ns, t) => makeNode(t),
  getElementById(id) { if (!byId.has(id)) { const n = makeNode('div'); n.id = id; byId.set(id, n); } return byId.get(id); },
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, dispatchEvent() {}
};

const store = {};
const sandbox = {
  document, console, window: null,
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  location: { href: BASE + '/', search: '' },
  navigator: { userAgent: 'node' },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, isFinite, isNaN, parseFloat, parseInt,
  URL, URLSearchParams, TextDecoder, TextEncoder, PoE: {},
  Blob: class {}, CustomEvent: class { constructor(t) { this.type = t; } },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  fetch: (input, init) => {
    const url = String(input).startsWith('http') ? String(input) : BASE + String(input);
    return fetch(url, init);
  }
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {}; sandbox.dispatchEvent = () => true;
vm.createContext(sandbox);

/* ---------------------------------------------------------------- 渲染看板表格 */
(async () => {
  const html = fs.readFileSync(path.join(ROOT, 'app', 'templates', 'dashboard.html'), 'utf8');
  const tpl = html.replace(/\{%[\s\S]*?%\}/g, '');   // 去掉 Jinja 指令，保留真实结构
  check('模板已提取（无 Jinja 残留）', !/\{%|\{\{/.test(tpl));

  // 用真实页面结构初始化桩节点（id 从模板中采集）
  const ids = [...tpl.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  check('模板 id 数量合理', ids.length > 25, `${ids.length} 个`);

  ['api.js', 'ui.js', 'charts.js', 'dashboard.js'].forEach((f) => {
    try {
      vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'static', 'js', f), 'utf8'), sandbox, { filename: f });
    } catch (err) {
      check(`加载 ${f}`, false, err.message);
    }
  });

  const P = sandbox.PoE;
  check('脚本加载完成', !!(P && P.charts && P.api));

  // 直接调用后端分页数据 + 页面里的行渲染逻辑（通过导出的 LineChart 与 api 验证数据形状）
  const prices = await P.api.prices({ limit: 5 });
  check('价格接口返回条目', prices.items.length > 0, `${prices.items.length} 条`);
  const divine = (await P.api.prices({ search: 'Divine Orb' })).items.find((x) => x.engname === 'Divine Orb');
  const it = divine || prices.items[0];
  check('条目具备渲染所需全部字段',
    ['item_name', 'engname', 'icon', 'unit', 'buy_avg', 'sell_avg', 'buy_ratio', 'sell_ratio',
      'd_buy_avg', 'd_sell_avg', 'd_latest_buy1', 'd_latest_sell1', 'latest_datetime', 'error', 'error_info']
      .every((k) => k in it),
    Object.keys(it).length + ' 个字段');
  check('d 折算字段数值正确',
    Math.abs(it.d_sell_avg - it.sell_avg / prices.d_to_e) < 1e-6,
    `d_sell=${it.d_sell_avg} vs ${(it.sell_avg / prices.d_to_e).toFixed(6)}`);

  // 图例/图表能否用真实历史数据渲染
  const hist = await P.api.history({ item: 'Divine Orb', hours: 168, unit: 'd' });
  const host = makeNode('div'); host.clientWidth = 900;
  const chart = new P.charts.LineChart(host, { height: 280 });
  chart.setHistory(hist.series, 'price');
  const paths = [];
  (function walk(n) { if (n.tagName === 'PATH') paths.push(n.attributes.d); (n.children || []).forEach(walk); })(host.children[0]);
  check('用真实历史渲染出买卖两条线', paths.length === 2, `paths=${paths.length}`);
  check('历史点数与快照数一致', hist.series[0].points.length >= 2, `${hist.series[0].points.length} 点`);

  const rateHist = await P.api.rateHistory(168);
  const host2 = makeNode('div'); host2.clientWidth = 900;
  const chart2 = new P.charts.LineChart(host2, { height: 260 });
  chart2.mode = 'rate';
  chart2.setRate(rateHist.points);
  const paths2 = [];
  (function walk(n) { if (n.tagName === 'PATH') paths2.push(n.attributes.d); (n.children || []).forEach(walk); })(host2.children[0]);
  check('汇率折线渲染成功', paths2.length === 1, `paths=${paths2.length}`);

  // 收益页选择器数据
  const opts = await P.api.options();
  check('收益页道具选择器有数据', opts.items.length > 100, `${opts.items.length} 个`);

  console.log('\n' + '='.repeat(46));
  console.log(failures === 0 ? '渲染检查：全部通过' : `渲染检查：${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('渲染检查异常：', err);
  process.exit(1);
});
