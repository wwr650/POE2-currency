/* 收益页交互测试：添加门票/掉落、删除、自定义道具加入门票、状态持久化
   用法：node tests/profit-interaction.js                                    */
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
      toggle: (c, on) => { if (on === undefined) { node._classes.has(c) ? node._classes.delete(c) : node._classes.add(c); } else if (on) node._classes.add(c); else node._classes.delete(c); },
      contains: (c) => node._classes.has(c)
    },
    setAttribute(k, v) { node.attributes[k] = String(v); },
    getAttribute(k) { return node.attributes[k] === undefined ? null : node.attributes[k]; },
    removeAttribute(k) { delete node.attributes[k]; },
    hasAttribute(k) { return node.attributes[k] !== undefined; },
    appendChild(c) { node.children.push(c); node.childNodes.push(c); return c; },
    removeChild(c) { node.children = node.children.filter((x) => x !== c); return c; },
    remove() { if (node._parent) node._parent.removeChild(node); },
    insertBefore(c) { node.children.unshift(c); return c; },
    addEventListener(type, fn) {
      const k = key(node.id || node.tagName, type);
      if (!listeners.has(k)) listeners.set(k, []);
      listeners.get(k).push(fn);
      node._ev = node._ev || {};
      node._ev[type] = fn;
    },
    removeEventListener() {}, click() { fire(node.id, 'click', { target: node }); },
    focus() {}, blur() {}, scrollIntoView() {},
    closest(sel) {
      // 支持 .entry / .cfg-item / .del / .ci-del / .ci-add / .custom-add 等
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
    getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 300 }; },
    get firstChild() { return node.children[0] || null; },
    get innerHTML() { return node._html; },
    set innerHTML(v) { node._html = String(v); node.options = (String(v).match(/<option/g) || []).length; node.children = []; },
    get textContent() { return node._text; }, set textContent(v) { node._text = String(v); },
    get selectedOptions() { return node._selectedOptions || []; }
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

const store = {};
const sandbox = {
  document, console, window: null,
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  location: { href: BASE + '/', search: '' }, navigator: { userAgent: 'node' },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, isFinite, isNaN, parseFloat, parseInt,
  URL, URLSearchParams, TextDecoder, TextEncoder, PoE: {},
  Blob: class {}, CustomEvent: class { constructor(t) { this.type = t; } },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  confirm: () => true,          // 自动确认删除弹窗
  fetch: (input, init) => fetch(String(input).startsWith('http') ? String(input) : BASE + String(input), init)
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {}; sandbox.dispatchEvent = () => true;
vm.createContext(sandbox);

const tpl = fs.readFileSync(path.join(ROOT, 'app', 'templates', 'profit.html'), 'utf8').replace(/\{%[\s\S]*?%\}/g, '');
[...tpl.matchAll(/id="([^"]+)"/g)].map((m) => m[1]).forEach((id) => document.getElementById(id));
// 真实模板由 base.html 渲染为 <body data-page="profit">，测试需保持一致
document.body.setAttribute('data-page', 'profit');

const errors = [];
['api.js', 'ui.js', 'charts.js', 'searchselect.js', 'shared.js', 'custom.js', 'profit.js'].forEach((f) => {
  try { vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'static', 'js', f), 'utf8'), sandbox, { filename: f }); }
  catch (e) { errors.push(`加载 ${f}: ${e.stack.split('\n')[0]}`); }
});

function fire(id, type, extra) {
  const fns = listeners.get(key(id, type)) || [];
  const ev = Object.assign({ type, target: byId.get(id), preventDefault() {}, stopPropagation() {} }, extra || {});
  fns.forEach((fn) => { try { fn(ev); } catch (e) { errors.push(`${id}:${type} -> ${e.stack.split('\n')[0]}`); } });
  return fns.length;
}

/** 造一个「行内按钮/输入框」节点，并挂上正确的父链与类名 */
function makeChild(cls, kind, idx) {
  const el = makeNode('div');
  cls.split(' ').forEach((c) => el._classes.add(c));
  const row = makeNode('div');
  ['entry'].forEach((c) => row._classes.add(c));
  row.setAttribute('data-kind', kind);
  row.setAttribute('data-idx', String(idx));
  el._parent = row;
  return el;
}

(async () => {
  // 只清理**本测试自己**可能残留的条目（名字以「自测」开头），绝不触碰用户数据
  try {
    const list = (await (await fetch(BASE + '/api/custom-items')).json()).items || [];
    const mine = list.filter((it) => String(it.name || '').indexOf('自测') >= 0);
    for (const it of mine) await fetch(BASE + '/api/custom-items/' + it.id, { method: 'DELETE' });
    if (mine.length) console.log(`（已清理 ${mine.length} 个上次遗留的测试道具）`);
  } catch (e) { /* ignore */ }

  await new Promise((r) => setTimeout(r, 2500));
  console.log('运行期异常:', errors.length ? errors : '无');
  check('profit.js 加载无异常', errors.length === 0, errors.join(' | '));

  const P = sandbox.PoE;
  const els = (id) => byId.get(id);

  console.log('\n--- 初始下拉框（可搜索 + 分类分组）---');
  const pickState = sandbox.PoE.__picks;
  check('已创建可搜索选择器', !!pickState && !!pickState.ticket && !!pickState.drop);
  if (pickState) {
    check('门票选择器含全部道具 + 自定义', pickState.ticket.items.length > 500,
      `${pickState.ticket.items.length} 项`);
    const cats = Array.from(new Set(pickState.ticket.items.map((i) => i.category)));
    check('选项按分类分组（分类数 > 5）', cats.length > 5, `${cats.length} 个分类：${cats.slice(0, 6).join('/')}…`);
    check('选项带当前价格文本', pickState.ticket.items.some((i) => /\d/.test(i.meta || '')),
      (pickState.ticket.items.find((i) => i.meta) || {}).meta);
    // 搜索：中文名 / 英文名 / 分类（输入有 120ms 防抖，需等待）
    pickState.ticket.setValue('');
    pickState.ticket.open();
    const wrapEl = document.getElementById('ticketPicker');
    const inputEl = wrapEl.children[1].children[0];
    const listEl = wrapEl.children[1].children[1];

    async function search(q) {
      inputEl.value = q;
      inputEl._ev.input();
      await new Promise((r) => setTimeout(r, 260));
      return listEl.innerHTML;
    }

    let res = await search('神圣石');
    check('搜索中文名可命中（神圣石）', /Divine Orb/.test(res), res.slice(0, 80));
    res = await search('chaos');
    check('搜索英文名可命中（chaos）', /Chaos Orb/.test(res));
    res = await search('精华');
    check('搜索分类名可命中（精华）', /ss-group">精华/.test(res), (res.match(/ss-group">[^<]+/) || [''])[0]);
    res = await search('zzzz不存在');
    check('无匹配时给出提示', /没有匹配的道具/.test(res), res.slice(0, 60));
    res = await search('divine');
    const hits = (res.match(/ss-item/g) || []).length;
    check('筛选后条目数显著减少', hits > 0 && hits < 20, `${hits} 条命中`);
    pickState.ticket.close();
  }

  console.log('\n--- 添加门票 ---');
  if (pickState) pickState.ticket.setValue('Divine Orb');
  fire('ticketAdd', 'click');
  await new Promise((r) => setTimeout(r, 400));
  check('添加门票后列表出现 1 行', /data-kind="ticket"/.test(els('ticketList').innerHTML), els('ticketList').innerHTML.slice(0, 80));
  check('门票行含删除按钮', /class="btn btn-sm btn-danger del"/.test(els('ticketList').innerHTML));

  console.log('\n--- 删除门票（点击 ✕）---');
  const delBtn = makeChild('btn btn-sm btn-danger del', 'ticket', 0);
  fire('ticketList', 'click', { target: delBtn });
  await new Promise((r) => setTimeout(r, 300));
  const ticketHtml = els('ticketList').innerHTML;
  check('删除后门票列表为空', !/data-kind="ticket"/.test(ticketHtml), ticketHtml.slice(0, 60));

  console.log('\n--- 添加掉落并删除 ---');
  if (pickState) pickState.drop.setValue('Chaos Orb');
  fire('dropAdd', 'click');
  await new Promise((r) => setTimeout(r, 300));
  check('掉落添加成功', /data-kind="drop"/.test(els('dropList').innerHTML));
  check('掉落行显示所选价格来源的单价', /class="unit-price"/.test(els('dropList').innerHTML),
    (els('dropList').innerHTML.match(/unit-price[^>]*>([^<]*)</) || [])[1]);
  check('概率输入框前有「概率」提示文字', /class="prob-label"[^>]*>概率</.test(els('dropList').innerHTML));
  check('概率为手动输入框（0~100）', /class="chance"[^>]*max="100"/.test(els('dropList').innerHTML));
  check('掉落条目带启用标记', /class="enabled"/.test(els('dropList').innerHTML));

  // 概率手动填写：超范围自动收敛到 0~100
  const pp = sandbox.PoE.__profit;
  check('已暴露渲染/计算接口', !!pp);
  if (pp) {
    const chanceInput = makeChild('input chance', 'drop', 0);
    chanceInput.value = '25.5';
    fire('dropList', 'input', { target: chanceInput });
    await new Promise((r) => setTimeout(r, 200));
    check('填写 25.5 → 概率保存为 25.5', pp.state.drops[0].chance === 25.5, String(pp.state.drops[0].chance));
    const overInput = makeChild('input chance', 'drop', 0);
    overInput.value = '150';
    fire('dropList', 'input', { target: overInput });
    await new Promise((r) => setTimeout(r, 200));
    check('填写 150 → 收敛为 100', pp.state.drops[0].chance === 100, String(pp.state.drops[0].chance));
    const negInput = makeChild('input chance', 'drop', 0);
    negInput.value = '-5';
    fire('dropList', 'input', { target: negInput });
    await new Promise((r) => setTimeout(r, 200));
    check('填写 -5 → 收敛为 0', pp.state.drops[0].chance === 0, String(pp.state.drops[0].chance));
    pp.renderEntries();
    check('渲染出的概率输入框回填当前值', /class="chance"[^>]*value="0"/.test(els('dropList').innerHTML));
  }

  fire('dropList', 'click', { target: makeChild('btn btn-sm btn-danger del', 'drop', 0) });
  await new Promise((r) => setTimeout(r, 300));
  check('掉落删除成功', !/data-kind="drop"/.test(els('dropList').innerHTML));

  console.log('\n--- 自定义道具加入门票 / 掉落 ---');
  els('ciName').value = '自测宝珠';
  els('ciPrice').value = '3.5';
  els('ciUnit').value = 'd';
  fire('ciAdd', 'click');
  await new Promise((r) => setTimeout(r, 1200));
  const customList = els('customList').innerHTML;
  check('自定义道具已创建', /自测宝珠/.test(customList), customList.slice(0, 100));
  check('自定义道具行含「加入门票」按钮', /ci-ticket/.test(customList) && /加入门票/.test(customList));
  check('自定义道具行含「加入掉落」按钮', /ci-drop/.test(customList) && /加入掉落/.test(customList));

  // 定位**本测试创建的那一行**（用户自己的道具可能也在列表里，不能用第一行）
  const realId = (() => {
    const i = customList.indexOf('自测宝珠');
    if (i < 0) return null;
    const before = customList.slice(0, i);
    const ids = before.match(/data-id="([^"]+)"/g) || [];
    return (ids[ids.length - 1] || '').replace(/^data-id="|"$/g, '') || null;
  })();
  // 只取本测试那一行的自定义名称
  function customNameIn(html) {
    const i = html.indexOf('data-id="' + realId + '"');
    if (i < 0) return '(未找到本测试行)';
    return (html.slice(i).match(/custom-name"[^>]*value="([^"]*)"/) || [])[1] || '(无 value)';
  }

  function customBtn(cls, id) {
    const el = makeNode('button');
    cls.split(' ').forEach((c) => el._classes.add(c));
    const row = makeNode('div');
    row._classes.add('entry');
    row._classes.add('custom-row');
    row.setAttribute('data-id', id);
    el._parent = row;
    return el;
  }

  fire('customList', 'click', { target: customBtn('btn btn-sm ci-ticket', realId) });
  await new Promise((r) => setTimeout(r, 300));
  check('自定义道具可加入门票列表', /data-kind="ticket"/.test(els('ticketList').innerHTML),
    els('ticketList').innerHTML.slice(0, 90));
  check('加入门票后名称正确', /custom-name"[^>]*value="自测宝珠"/.test(els('ticketList').innerHTML),
    customNameIn(els('ticketList').innerHTML));

  fire('customList', 'click', { target: customBtn('btn btn-sm ci-drop', realId) });
  await new Promise((r) => setTimeout(r, 300));
  check('自定义道具可加入掉落列表', /data-kind="drop"/.test(els('dropList').innerHTML));
  check('加入掉落后名称正确', /custom-name"[^>]*value="自测宝珠"/.test(els('dropList').innerHTML),
    customNameIn(els('dropList').innerHTML));
  check('自定义掉落也带概率输入框与启用标记',
    /data-kind="drop"/.test(els('dropList').innerHTML) && /class="chance"/.test(els('dropList').innerHTML));

  console.log('\n--- 状态持久化（切换页面后保留）---');
  const savedRaw = store['poe2.state.profit'] || '(未保存)';
  check('已写入 localStorage 的收益页状态', savedRaw !== '(未保存)', String(savedRaw).slice(0, 120));
  let parsed = null;
  try { parsed = JSON.parse(savedRaw); } catch (e) { /* ignore */ }
  check('状态包含 display_unit / ticket / drops',
    !!(parsed && parsed.display_unit && parsed.ticket && parsed.drops),
    parsed ? 'keys=' + Object.keys(parsed).join(',') + ' ticket=' + parsed.ticket.length + ' drops=' + parsed.drops.length : 'n/a');
  check('状态里的门票保留了自定义条目', !!(parsed && parsed.ticket.some((t) => t.custom)),
    parsed ? JSON.stringify(parsed.ticket).slice(0, 110) : '');

  console.log('\n--- 新增条目后自动保存 ---');
  if (pickState) pickState.ticket.setValue('Chaos Orb');
  fire('ticketAdd', 'click');
  await new Promise((r) => setTimeout(r, 600));
  const after = JSON.parse(store['poe2.state.profit'] || '{}');
  check('新增门票后状态已更新', (after.ticket || []).some((t) => t.engname === 'Chaos Orb'),
    JSON.stringify(after.ticket || []).slice(0, 120));

  console.log('\n--- 模拟「切到看板再切回」：重新加载页面脚本并恢复 ---');
  const savedTicket = (after.ticket || []).length;
  const savedDrops = (after.drops || []).length;
  const savedUnit = after.display_unit;
  const savedMinutes = after.minutes_per_run;
  // 重新跑一遍 profit.js（等价于从别的页面切回来时重新执行脚本）
  errors.length = 0;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'static', 'js', 'profit.js'), 'utf8'), sandbox, { filename: 'profit.js(reload)' });
  await new Promise((r) => setTimeout(r, 2500));
  const ticketHtml2 = els('ticketList').innerHTML;
  const dropHtml2 = els('dropList').innerHTML;
  const ticketRows2 = (ticketHtml2.match(/data-kind="ticket"/g) || []).length;
  const dropRows2 = (dropHtml2.match(/data-kind="drop"/g) || []).length;
  check('切回后门票条目被恢复', ticketRows2 === savedTicket, `${ticketRows2} / 期望 ${savedTicket}`);
  check('切回后掉落条目被恢复', dropRows2 === savedDrops, `${dropRows2} / 期望 ${savedDrops}`);
  check('切回后展示单位被恢复', els('displayUnit').value === savedUnit, `${els('displayUnit').value} / ${savedUnit}`);
  check('切回后单次耗时被恢复', Number(els('minutes').value) === Number(savedMinutes),
    `${els('minutes').value} / ${savedMinutes}`);
  check('切回后自定义门票价格正确', /3\.5/.test(ticketHtml2) || /3\.5/.test(dropHtml2));
  check('重新加载无脚本异常', errors.length === 0, errors.join(' | '));

  // 删除自定义道具放在最后：状态恢复要用到它（与真实使用顺序一致）
  console.log('\n--- 删除自定义道具 ---');
  fire('customList', 'click', { target: customBtn('btn btn-sm btn-danger del ci-del', realId) });
  await new Promise((r) => setTimeout(r, 1200));
  check('自定义道具删除成功', !/自测宝珠/.test(els('customList').innerHTML), els('customList').innerHTML.slice(0, 80));

  console.log('\n' + '='.repeat(46));
  console.log(failures === 0 ? '收益页交互测试：全部通过' : `收益页交互测试：${failures} 项失败`);

  // 清理本次测试创建的自定义道具（名字含「自测」），用户自己的道具保持不动
  try {
    const list = (await (await fetch(BASE + '/api/custom-items')).json()).items || [];
    for (const it of list.filter((x) => String(x.name || '').indexOf('自测') >= 0)) {
      await fetch(BASE + '/api/custom-items/' + it.id, { method: 'DELETE' });
    }
  } catch (e) { /* ignore */ }

  process.exit(failures === 0 ? 0 : 1);
})();
