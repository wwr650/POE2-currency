/* 首屏单价 BUG 回归测试：
   进入页面时本地已保存门票/掉落，价格库是异步加载的 —— 早期版本里
   行内单价会一直停留在 0.00，因为它是在价格库就绪前渲染的。
   用法：node tests/unit-price-regression.js                                    */
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

/* ---------------------------------------------------------------- DOM 桩 */
const listeners = new Map();
const key = (id, type) => id + ':' + type;

function makeNode(tag, id) {
  const node = {
    tagName: (tag || 'div').toUpperCase(), id: id || '', children: [], childNodes: [],
    attributes: {}, style: {}, _classes: new Set(), _html: '', _text: '',
    value: '', checked: false, selected: false, files: [], options: [],
    clientWidth: 900, clientHeight: 300, offsetWidth: 150,
    classList: {
      add: (...c) => c.forEach((x) => node._classes.add(x)),
      remove: (...c) => c.forEach((x) => node._classes.delete(x)),
      toggle: () => {}, contains: (c) => node._classes.has(c)
    },
    setAttribute(k, v) { node.attributes[k] = String(v); },
    getAttribute(k) { return node.attributes[k] === undefined ? null : node.attributes[k]; },
    removeAttribute(k) { delete node.attributes[k]; },
    hasAttribute(k) { return node.attributes[k] !== undefined; },
    appendChild(c) { node.children.push(c); node.childNodes.push(c); return c; },
    removeChild(c) { node.children = node.children.filter((x) => x !== c); return c; },
    remove() {},
    addEventListener(type, fn) {
      const k = key(node.id || node.tagName, type);
      if (!listeners.has(k)) listeners.set(k, []);
      listeners.get(k).push(fn);
      node._ev = node._ev || {};
      node._ev[type] = fn;
    },
    removeEventListener() {}, click() {},
    closest(sel) {
      const names = sel.split(',').map((s) => s.trim().replace(/^\./, ''));
      let cur = node;
      while (cur) {
        for (const n of names) if ((cur._classes || new Set()).has(n)) return cur;
        cur = cur._parent || null;
      }
      return null;
    },
    querySelector(sel) {
      const cls = sel.replace(/^\./, '');
      const found = [];
      (function walk(n) { (n.children || []).forEach((c) => { if ((c._classes || new Set()).has(cls)) found.push(c); walk(c); }); })(node);
      return found[0] || null;
    },
    querySelectorAll() { return []; },
    focus() {}, blur() {}, scrollIntoView() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 300 }; },
    get firstChild() { return node.children[0] || null; },
    get innerHTML() { return node._html; },
    set innerHTML(v) { node._html = String(v); node.options = (String(v).match(/<option/g) || []).length; node.children = []; },
    get textContent() { return node._text; }, set textContent(v) { node._text = String(v); },
    get selectedOptions() { return []; }
  };
  return node;
}

const byId = new Map();
const document = {
  body: makeNode('body'), createElement: (t) => makeNode(t), createElementNS: (ns, t) => makeNode(t),
  getElementById(id) { if (!byId.has(id)) byId.set(id, makeNode('div', id)); return byId.get(id); },
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, dispatchEvent() {}
};

/* 模拟「上次已经配好门票/掉落」的本地状态 */
const store = {
  'poe2.state.profit': JSON.stringify({
    display_unit: 'd',
    minutes_per_run: 5,
    cfgName: '回归测试',
    ticket: [{ engname: 'Divine Orb', name: '神圣石', qty: 1, price_source: 'sell_avg' }],
    drops: [
      { engname: 'Chaos Orb', name: '混沌石', qty: 1, chance: 25, price_source: 'sell_avg', enabled: true },
      { custom: true, custom_name: '自有宝珠', unit: 'd', price: 3.5, qty: 2, chance: 100, price_source: '', enabled: true }
    ]
  })
};

const sandbox = {
  document, console, window: null,
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  location: { href: BASE + '/', search: '' }, navigator: { userAgent: 'node' },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, isFinite, isNaN, parseFloat, parseInt,
  URL, URLSearchParams, TextDecoder, TextEncoder, PoE: {},
  Blob: class {}, CustomEvent: class { constructor(t) { this.type = t; } },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  confirm: () => true,
  fetch: (input, init) => fetch(String(input).startsWith('http') ? String(input) : BASE + String(input), init)
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {}; sandbox.dispatchEvent = () => true;
vm.createContext(sandbox);

const tpl = fs.readFileSync(path.join(ROOT, 'app', 'templates', 'profit.html'), 'utf8').replace(/\{%[\s\S]*?%\}/g, '');
[...tpl.matchAll(/id="([^"]+)"/g)].map((m) => m[1]).forEach((id) => document.getElementById(id));
document.body.setAttribute('data-page', 'profit');

const errors = [];
['api.js', 'ui.js', 'charts.js', 'searchselect.js', 'shared.js', 'custom.js', 'profit.js'].forEach((f) => {
  try { vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'static', 'js', f), 'utf8'), sandbox, { filename: f }); }
  catch (e) { errors.push(`加载 ${f}: ${e.stack.split('\n')[0]}`); }
});

const els = (id) => byId.get(id);
function unitPrices() {
  return (els('ticketList').innerHTML.match(/unit-price[^>]*>([^<]*)</g) || [])
    .concat(els('dropList').innerHTML.match(/unit-price[^>]*>([^<]*)</g) || [])
    .map((s) => s.replace(/^unit-price[^>]*>/, '').replace(/<$/, ''));
}

(async () => {
  await new Promise((r) => setTimeout(r, 3000));

  console.log('运行期异常:', errors.length ? errors : '无');
  check('profit.js 加载无异常', errors.length === 0, errors.join(' | '));

  console.log('\n--- 恢复的条目 ---');
  check('门票已被恢复', /data-kind="ticket"/.test(els('ticketList').innerHTML));
  check('掉落已被恢复（2 条）', (els('dropList').innerHTML.match(/data-kind="drop"/g) || []).length === 2);

  console.log('\n--- 行内单价（BUG 关键点）---');
  const prices = unitPrices();
  console.log('   捕获到的单价文本:', JSON.stringify(prices));
  check('门票单价不为 0', Number(String(prices[0]).replace(/[^\d.]/g, '')) > 0, prices[0]);
  check('掉落单价不为 0', Number(String(prices[1]).replace(/[^\d.]/g, '')) > 0, prices[1]);
  check('自定义条目显示用户填写的单价 3.5 d', /^3\.5\d? d$/.test(prices[2]), prices[2]);
  check('所有单价都非 0（价格库已加载）', prices.every((p) => Number(String(p).replace(/[^\d.]/g, '')) > 0), JSON.stringify(prices));
  check('门票单价与接口报价一致', /^0\.\d+ d$/.test(prices[0]) || /^\d+\.\d+ d$/.test(prices[0]), prices[0]);

  console.log('\n--- 单价与后端报价交叉核对 ---');
  const opts = await (await fetch(BASE + '/api/options')).json();
  const divine = opts.items.find((i) => i.engname === 'Divine Orb');
  const expected = (divine.d_sell_avg !== null && divine.d_sell_avg !== undefined)
    ? Number(divine.d_sell_avg) : Number(divine.sell_avg) / opts.d_to_e;
  const shown = Number(String(prices[0]).replace(/[^\d.]/g, ''));
  check('门票单价 ≈ 接口 d_sell_avg', Math.abs(shown - expected) < 0.01,
    `页面=${shown} 接口=${expected.toFixed(4)}`);

  console.log('\n' + '='.repeat(46));
  console.log(failures === 0 ? '首屏单价回归测试：全部通过' : `首屏单价回归测试：${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})();
