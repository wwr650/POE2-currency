/* 前端无浏览器冒烟测试：用最小 DOM 桩加载页面脚本，验证渲染逻辑不报错。
   运行：node tests/frontend-smoke.js                                            */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const JS = path.join(ROOT, 'app', 'static', 'js');

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${extra ? ' — ' + extra : ''}`);
}

/* ---------------------------------------------------------------- DOM 桩 */
function makeNode(tag) {
  const node = {
    tagName: (tag || 'div').toUpperCase(),
    children: [], childNodes: [], attributes: {}, style: {}, dataset: {},
    _classes: new Set(), _html: '', _text: '', value: '', checked: false, selected: false,
    files: [], clientWidth: 900, clientHeight: 300, offsetWidth: 150,
    classList: {
      add: (...c) => c.forEach((x) => node._classes.add(x)),
      remove: (...c) => c.forEach((x) => node._classes.delete(x)),
      toggle: (c, on) => { if (on === undefined) { node._classes.has(c) ? node._classes.delete(c) : node._classes.add(c); } else if (on) node._classes.add(c); else node._classes.delete(c); },
      contains: (c) => node._classes.has(c)
    },
    setAttribute(k, v) { node.attributes[k] = String(v); if (k === 'class') node._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    getAttribute(k) { return node.attributes[k] === undefined ? null : node.attributes[k]; },
    hasAttribute(k) { return node.attributes[k] !== undefined; },
    removeAttribute(k) { delete node.attributes[k]; },
    appendChild(c) { node.children.push(c); node.childNodes.push(c); return c; },
    removeChild(c) { node.children = node.children.filter((x) => x !== c); node.childNodes = node.children.slice(); return c; },
    insertBefore(c) { node.children.unshift(c); node.childNodes = node.children.slice(); return c; },
    addEventListener() {}, removeEventListener() {},
    click() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    focus() {}, blur() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: node.clientWidth, height: node.clientHeight, right: node.clientWidth, bottom: node.clientHeight }; },
    get firstChild() { return node.children[0] || null; },
    get innerHTML() { return node._html; },
    set innerHTML(v) { node._html = String(v); },
    get textContent() { return node._text; },
    set textContent(v) { node._text = String(v); },
    get selectedOptions() { return node.children.filter((o) => o.selected); }
  };
  return node;
}

const NS = 'http://www.w3.org/2000/svg';
const elements = new Map();
const document = {
  body: makeNode('body'),
  documentElement: makeNode('html'),
  createElement: (t) => makeNode(t),
  createElementNS: (ns, t) => makeNode(t),
  createTextNode: (t) => { const n = makeNode('#text'); n.textContent = t; return n; },
  getElementById: (id) => {
    if (!elements.has(id)) { const n = makeNode('div'); n.id = id; elements.set(id, n); }
    return elements.get(id);
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  dispatchEvent() {}
};
document.body.setAttribute('data-page', 'dashboard');

const svgProto = { baseVal: { width: 900, height: 300 } };

const localStore = {};
const sandbox = {
  document,
  console,
  window: null,
  localStorage: {
    getItem: (k) => (k in localStore ? localStore[k] : null),
    setItem: (k, v) => { localStore[k] = String(v); },
    removeItem: (k) => { delete localStore[k]; }
  },
  location: { href: 'http://127.0.0.1:8000/' },
  navigator: { userAgent: 'node' },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, isFinite, isNaN, parseFloat, parseInt,
  URL: URL, URLSearchParams: URLSearchParams, TextDecoder, TextEncoder,
  Blob: class { constructor() {} },
  URL_createObjectURL: () => 'blob:x',
  CustomEvent: class { constructor(t) { this.type = t; } },
  fetch: async () => { throw new Error('fetch 未在冒烟测试中启用'); },
  requestAnimationFrame: (fn) => setTimeout(fn, 0)
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.dispatchEvent = () => true;
sandbox.URL.createObjectURL = () => 'blob:x';
sandbox.URL.revokeObjectURL = () => {};

vm.createContext(sandbox);

/* ---------------------------------------------------------------- 加载脚本 */
function load(file) {
  const code = fs.readFileSync(path.join(JS, file), 'utf8');
  try {
    vm.runInContext(code, sandbox, { filename: file });
    return true;
  } catch (err) {
    console.log(`[FAIL] 加载 ${file} 抛出异常：${err.message}`);
    failures++;
    return false;
  }
}

console.log('== 脚本加载 ==');
['api.js', 'ui.js', 'charts.js'].forEach((f) => check(`加载 ${f}`, load(f)));

const P = sandbox.PoE;
check('PoE 命名空间导出 api/ui/charts', !!(P && P.api && P.ui && P.charts));

/* ---------------------------------------------------------------- 格式化 */
console.log('\n== 数值格式化 ==');
check('num(787.5) 带千分位规则', P.num(787.5) === '787.50' || P.num(787.5) === '787.5', P.num(787.5));
check('num(null) → —', P.num(null) === '—');
check('num(0.000123) 保留精度', /0\.00012/.test(P.num(0.000123)), P.num(0.000123));
check('pct 正数带 +', P.pct(12.345) === '+12.35%', P.pct(12.345));
check('pct null → —', P.pct(null) === '—');
check('cls 正=up 负=down 空=null', P.cls(1) === 'up' && P.cls(-1) === 'down' && P.cls(null) === 'null');
check('escapeHtml 转义', P.escapeHtml('<b>"x"</b>') === '&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
check('shortTime 可解析 ISO', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(P.shortTime('2026-10-03T10:00:00+08:00')), P.shortTime('2026-10-03T10:00:00+08:00'));
check('timeAgo 输出中文', /分钟前|小时前|天前|刚刚/.test(P.timeAgo(new Date(Date.now() - 3600e3).toISOString())), P.timeAgo(new Date(Date.now() - 3600e3).toISOString()));

/* ---------------------------------------------------------------- URL 拼装 */
console.log('\n== 查询参数 ==');
check('qs 过滤空值', P.qs({ a: 1, b: null, c: '', d: 'x y' }) === 'a=1&d=x+y', P.qs({ a: 1, b: null, c: '', d: 'x y' }));

/* ---------------------------------------------------------------- 单位换算 */
console.log('\n== 单位换算（ui.toUnit）==');
P.ui.setRate(787.5);
// 展示单位 = e 时：以 e 计价保持原值，以 d 计价乘汇率
P.ui.setUnit('e');
check('展示 e / 源 e → 原值', P.ui.toUnit(787, 'e') === 787, String(P.ui.toUnit(787, 'e')));
check('展示 e / 源 d → 乘汇率', Math.abs(P.ui.toUnit(1, 'd') - 787.5) < 1e-9, String(P.ui.toUnit(1, 'd')));
// 展示单位 = d 时：以 e 计价除以汇率，以 d 计价保持原值
P.ui.setUnit('d');
check('展示 d / 源 e → 除以汇率 (787/787.5≈0.9994)', Math.abs(P.ui.toUnit(787, 'e') - 787 / 787.5) < 1e-9, String(P.ui.toUnit(787, 'e')));
check('展示 d / 源 d → 原值', P.ui.toUnit(1, 'd') === 1, String(P.ui.toUnit(1, 'd')));
check('pick 在 d 单位下取 d 字段', P.ui.pick({ buy_avg: 787, d_buy_avg: 0.9994 }, 'buy_avg', 'd_buy_avg') === 0.9994);
P.ui.setUnit('e');
check('pick 在 e 单位下取原始字段', P.ui.pick({ buy_avg: 787, d_buy_avg: 0.9994 }, 'buy_avg', 'd_buy_avg') === 787);
P.ui.setUnit('d');
P.ui.savePageState({ category: '精华', sort: 'sell' });
check('页面状态持久化可读回', P.ui.loadPageState().category === '精华' && P.ui.loadPageState().sort === 'sell');
P.ui.setUnit('e');

/* ---------------------------------------------------------------- 图表渲染 */
console.log('\n== 图表渲染 ==');
const chartHost = makeNode('div');
chartHost.clientWidth = 860;
let chart = null;
try {
  chart = new P.charts.LineChart(chartHost, { height: 260 });
  check('LineChart 构造', !!chart.svg);
} catch (err) {
  check('LineChart 构造', false, err.message);
}

const now = Date.now();
const mkPoints = (n, base, step) => Array.from({ length: n }, (_, i) => ({
  t: new Date(now - (n - i) * 3600e3).toISOString(),
  buy_avg: base + Math.sin(i / 3) * step,
  sell_avg: base - 0.4 + Math.sin(i / 5) * step,
  unit: 'e', raw_unit: 'e'
}));

if (chart) {
  try {
    chart.setHistory([
      { name: '神圣石', engname: 'Divine Orb', unit: 'e', points: mkPoints(30, 787, 12) },
      { name: '混沌石', engname: 'Chaos Orb', unit: 'e', points: mkPoints(30, 107, 5) }
    ], 'price');
    const svgHtml = chartHost.children[0];
    const paths = [];
    const strokes = [];
    (function walk(n) {
      if (n.tagName === 'PATH') { paths.push(n.attributes.d); strokes.push(n.attributes.stroke); }
      (n.children || []).forEach(walk);
    })(svgHtml);
    check('价格图生成 path 数量 = 4（2 道具 × 买卖）', paths.length === 4, `paths=${paths.length}`);
    check('path d 属性为合法 M/L 指令', paths.every((d) => /^M[\d.\s]+L/.test(d)), paths[0] ? paths[0].slice(0, 40) : '');
    check('买入与卖出使用不同颜色', strokes[0] !== strokes[1], `${strokes[0]} vs ${strokes[1]}`);
    check('同一道具买卖颜色成对且与其它道具不同',
      strokes[0] === P.charts.PAIRS[0][0] && strokes[1] === P.charts.PAIRS[0][1] &&
      strokes[2] === P.charts.PAIRS[1][0] && strokes[3] === P.charts.PAIRS[1][1],
      strokes.join(' '));
    check('四条线颜色互不相同', new Set(strokes).size === 4, `${new Set(strokes).size} 种颜色`);
    check('折线加粗（stroke-width ≥ 2）',
      (function () { const w = []; (function walk(n) { if (n.tagName === 'PATH') w.push(Number(n.attributes['stroke-width'])); (n.children || []).forEach(walk); })(svgHtml); return w.every((x) => x >= 2); })());
    check('图例包含道具名与买/卖', /神圣石 · 买入/.test(chart.legend.innerHTML) && /神圣石 · 卖出/.test(chart.legend.innerHTML));
    check('图例不再使用“虚线”标注', !/虚线/.test(chart.legend.innerHTML));

    chart.mode = 'rate';
    chart.setRate(Array.from({ length: 12 }, (_, i) => ({ t: new Date(now - (12 - i) * 3600e3).toISOString(), d_to_e: 780 + i })));
    const ratePaths = [];
    (function walk(n) { if (n.tagName === 'PATH') ratePaths.push(n.attributes.d); (n.children || []).forEach(walk); })(chartHost.children[0]);
    check('汇率图渲染 1 条线', ratePaths.length === 1, `paths=${ratePaths.length}`);
    check('汇率图例不含占位符 ?e', !/\?\s*e/.test(chart.legend.innerHTML) && /1 d =/.test(chart.legend.innerHTML));

    chart.setHistory([], 'price');
    check('空数据不抛异常', true);
    chart.setRate([]);
    check('空汇率不抛异常', true);
  } catch (err) {
    check('图表渲染无异常', false, err.stack.split('\n')[0]);
  }
}

/* ---------------------------------------------------------------- 迷你走势图 */
console.log('\n== 迷你走势图 ==');
const spark = P.charts.sparkline([1, 5, 3, 8, 2], { width: 200, height: 40, color: 'auto' });
check('sparkline 返回 svg', /^<svg/.test(spark) && /<path/.test(spark), spark.slice(0, 60));
check('sparkline 数据不足有提示', /数据点不足/.test(P.charts.sparkline([1], {})));
check('sparkline 上涨用绿色', /#4ec97a/.test(P.charts.sparkline([1, 2, 3], { color: 'auto' })));
check('sparkline 下跌用红色', /#f2635f/.test(P.charts.sparkline([3, 2, 1], { color: 'auto' })));

/* ---------------------------------------------------------------- 页面脚本（DOM 桩） */
console.log('\n== 页面脚本加载 ==');
['dashboard.js', 'trends.js', 'profit.js'].forEach((f) => check(`加载并初始化 ${f}`, load(f)));

console.log('\n' + '='.repeat(46));
console.log(failures === 0 ? '前端冒烟测试：全部通过' : `前端冒烟测试：${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
