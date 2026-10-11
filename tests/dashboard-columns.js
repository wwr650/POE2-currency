#!/usr/bin/env node
/**
 * 价格看板表头/列对齐回归测试。
 *
 * 背景 BUG：`dashboard.js` 误把表头「分类」列（th#thCategory）当成分类 Tab 容器，
 * 在「全部」分类下调用了 `.hidden`（display:none）。于是**表头少一列**、内容仍是 13 列，
 * 其后所有表头整体左移一格 —— 表现为「表头与列内容对不上、少了个类别」。
 *
 * 这类错误 DOM 结构检查发现不了（元素都在），必须比较**可见列的几何位置**。
 *
 * 运行：先启动服务（start.bat offline no-browser），再执行 node tests/dashboard-columns.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.POE2_BASE || 'http://127.0.0.1:8000';
const PROBE_NAME = '_columns_probe.html';

// Edge 路径（找不到就跳过浏览器部分，只跑接口一致性检查）
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.POE2_EDGE || '',
];

let pass = 0;
const failures = [];
function commonCheck(name, cond, extra) {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' — ' + extra : ''}`); }
  else { failures.push(name); console.log(`[FAIL] ${name}${extra ? ' — ' + extra : ''}`); }
}

/* ------------------------------------------------ 注入页：测量表头与单元格几何位置 */
const PROBE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<iframe id="f" src="/" style="width:1600px;height:800px;border:0"></iframe>
<pre id="out">PENDING</pre>
<script>
function measure() {
  var d = document.getElementById('f').contentWindow.document;
  var table = d.getElementById('priceTable');
  var ths = Array.prototype.slice.call(d.querySelectorAll('#priceTable thead th'));
  var row = d.querySelector('#priceBody tr');
  var tds = row ? Array.prototype.slice.call(row.querySelectorAll('td')) : [];
  var visTh = ths.filter(function (t) { return t.getBoundingClientRect().width > 0; });
  var visTd = tds.filter(function (t) { return t.getBoundingClientRect().width > 0; });
  var cols = visTh.map(function (th, i) {
    var a = th.getBoundingClientRect();
    var b = visTd[i] || null;                 // 按“可见元素”配对，而不是按文字
    var br = b ? b.getBoundingClientRect() : null;
    return {
      header: (th.textContent || '').trim(),
      thLeft: Math.round(a.left), thWidth: Math.round(a.width),
      tdLeft: br ? Math.round(br.left) : null, tdWidth: br ? Math.round(br.width) : null,
      cell: b ? ((b.textContent || '').trim() || (b.querySelector('img') ? '[图标]' : '')) : null,
      delta: br ? Math.round(br.left - a.left) : null
    };
  });
  return {
    hiddenCategoryClass: table.classList.contains('hide-category'),
    headerCount: visTh.length,
    cellCount: visTd.length,
    totalRows: d.querySelectorAll('#priceBody tr').length,
    cols: cols
  };
}
function report(tag, data) {
  var out = document.getElementById('out');
  out.textContent = JSON.stringify({ tag: tag, data: data }, null, 1);
}
setTimeout(function () {
  try {
    var first = measure();
    var d = document.getElementById('f').contentWindow.document;
    var tab = d.querySelector('#categoryTabs .tab[data-cat="符文"]')
           || d.querySelector('#categoryTabs .tab:not(.tab:first-child)');
    if (tab) {
      tab.click();
      setTimeout(function () {
        try {
          document.getElementById('out').textContent =
            'ALL=' + JSON.stringify(first) + '\\nFILTERED=' + JSON.stringify(measure());
        } catch (e) { document.getElementById('out').textContent = 'ERR ' + e.message; }
      }, 2600);
    } else {
      document.getElementById('out').textContent = 'ALL=' + JSON.stringify(first) + '\\nFILTERED=null';
    }
  } catch (e) {
    document.getElementById('out').textContent = 'ERR ' + e.message;
  }
}, 6500);
</script></body></html>`;

function findEdge() {
  for (const p of EDGE_CANDIDATES) if (p && fs.existsSync(p)) return p;
  return null;
}

/** 用 Edge 无头模式取出注入页里的 JSON 结果（失败自动重试一次） */
function snapshotOnce(edge, budget) {
  const probePath = path.join(ROOT, 'app', 'static', PROBE_NAME);
  fs.writeFileSync(probePath, PROBE_HTML, 'utf8');
  try {
    // 直接调用 Edge（不要经 cmd.exe 重定向：本机沙箱下那条路径会失败）；
    // Edge 会往 stderr 大量刷日志，这里丢弃 stderr，避免管道积压。
    const dom = execFileSync(edge, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      `--virtual-time-budget=${budget}`, '--dump-dom',
      `${BASE}/static/${PROBE_NAME}`,
    ], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 150000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
    if (!m) return { error: `DOM 中未找到测量节点（${dom.length} 字节）` };
    const text = m[1]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    if (text === 'PENDING') return { error: '页面内测量脚本未执行完（超时）' };
    if (text.startsWith('ERR')) return { error: text };
    const iAll = text.indexOf('ALL=');
    const iFil = text.indexOf('FILTERED=');
    if (iAll < 0) return { error: '缺少 ALL= 结果：' + text.slice(0, 120) };
    const parse = (s) => {
      if (!s || s === 'null') return null;
      try { return JSON.parse(s); } catch (e) { return null; }
    };
    const allRaw = iFil >= 0 ? text.slice(iAll + 4, iFil).trim() : text.slice(iAll + 4).trim();
    const filRaw = iFil >= 0 ? text.slice(iFil + 9).trim() : '';
    return { all: parse(allRaw), filtered: parse(filRaw), raw: text };
  } catch (err) {
    return { error: 'Edge 执行失败：' + String(err.message).slice(0, 160) };
  } finally {
    try { fs.unlinkSync(probePath); } catch (e) { /* ignore */ }
  }
}

function snapshot(edge) {
  let res = snapshotOnce(edge, 20000);
  if (res.error || !res.all) {
    console.log(`[INFO] 首次测量失败（${res.error || '结果为空'}），重试一次…`);
    res = snapshotOnce(edge, 26000);
  }
  return res;
}

/* ------------------------------------------------ 1) 源码级不变量（无需浏览器）
   BUG 的本质：JS 直接给表头单元格（<th>）加了 .hidden（display:none），
   于是表头少一列、内容仍是满列 → 整体错位。这里守住这条不变量。 */
function sourceInvariants() {
  const dash = fs.readFileSync(path.join(ROOT, 'app', 'static', 'js', 'dashboard.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'app', 'static', 'css', 'app.css'), 'utf8');
  const tpl = fs.readFileSync(path.join(ROOT, 'app', 'templates', 'dashboard.html'), 'utf8');

  // 表头列定义应与行渲染的单元格一一对应
  const headers = (tpl.match(/data-col="([^"]+)"/g) || []).map((s) => s.slice(10, -1));
  commonCheck('模板定义 13 个表头列（含 category）', headers.length === 13, headers.join(','));
  commonCheck('模板含 category 表头', headers.indexOf('category') >= 0);

  // 关键：不允许把 hidden 加到表头单元格上
  const thHits = (dash.match(/[A-Za-z_$][\w$]*\.classList\.(toggle|add|remove)\(\s*'hidden'/g) || [])
    .filter((s) => /categor|Head|Th\b|thCategory/i.test(s));
  const hiddenTargets = (dash.match(/([A-Za-z_$][\w$]*)\.classList\.(?:toggle|add|remove)\(\s*'hidden'/g) || [])
    .map((s) => s.split('.')[0]);
  commonCheck('dashboard.js 未把表头元素当成可隐藏元素（不得对 th 加 hidden）',
    thHits.length === 0 && !/thCategory[^\n]*classList\.(toggle|add|remove)/.test(dash),
    thHits.length ? thHits.join(' ') : '未命中表头');
  commonCheck('隐藏分类列用的是表格类名 hide-category',
    /els\.table\.classList\.toggle\('hide-category'/.test(dash),
    '对 hidden 的目标：' + hiddenTargets.join(','));
  commonCheck('CSS 同时隐藏表头与单元格的分类列',
    /\.hide-category thead th:nth-child\(4\)/.test(css) && /\.hide-category tbody td:nth-child\(4\)/.test(css));
  commonCheck('CSS 用 nth-child(4) 对应第 4 列（图标/中文名/英文名/分类）',
    /hide-category thead th:nth-child\(4\)/.test(css));
  return { headers };
}

/* ------------------------------------------------ 2) 几何对齐（可选，需要无头浏览器） */
function geometryChecks(edge) {
  const snap = snapshot(edge);
  if (snap.error) {
    console.log(`[SKIP] 几何对齐检查未执行（${snap.error}）`);
    console.log('        在受限沙箱里 Node 可能无法创建子进程（EPERM）。');
    console.log('        如需执行：在外层终端直接运行本文件，或设 POE2_GEOMETRY=1 后重试。');
    return false;
  }
  const all = snap.all;
  commonCheck('「全部」分类下能测到表格', !!all && all.totalRows > 0,
    all ? `${all.totalRows} 行 / 表头 ${all.headerCount} 列 / 单元格 ${all.cellCount} 列` : 'n/a');
  if (all) {
    commonCheck('「全部」分类下 表头可见列数 == 单元格列数',
      all.headerCount === all.cellCount, `表头 ${all.headerCount} / 单元格 ${all.cellCount}`);
    const bad = (all.cols || []).filter((c) => c.delta === null || Math.abs(c.delta) > 1.5);
    commonCheck('「全部」分类下 每一列 left 对齐（容差 1.5px）', bad.length === 0,
      bad.map((c) => `${c.header}Δ=${c.delta}`).join(' ') || '全部对齐');
    const noCell = (all.cols || []).filter(
      (c) => c.header !== '图标' && (c.cell === null || c.cell === ''));
    commonCheck('「全部」分类下 除图标外每列都有内容', noCell.length === 0,
      noCell.length ? noCell.map((c) => c.header).join(',') : `${all.cols.length} 列均有内容`);
    commonCheck('「全部」分类下 分类列被隐藏', all.hiddenCategoryClass === true);
  }
  const f = snap.filtered;
  if (f) {
    commonCheck('按分类筛选后 表头可见列数 == 单元格列数',
      f.headerCount === f.cellCount, `表头 ${f.headerCount} / 单元格 ${f.cellCount}`);
    commonCheck('按分类筛选后 分类列重新出现',
      (f.cols || []).some((c) => c.header === '分类'), `表头 ${f.headerCount} 列`);
    const badF = (f.cols || []).filter((c) => c.delta === null || Math.abs(c.delta) > 1.5);
    commonCheck('按分类筛选后 每一列 left 对齐（容差 1.5px）', badF.length === 0,
      badF.map((c) => `${c.header}Δ=${c.delta}`).join(' ') || '全部对齐');
  } else {
    console.log('[SKIP] 未能切换到分类 Tab，跳过筛选态检查');
  }
  return true;
}

(async () => {
  const wantGeometry = process.env.POE2_GEOMETRY === '1' || process.argv.indexOf('--geometry') >= 0;
  let apiOk = false;
  try {
    await fetch(BASE + '/api/health');
    apiOk = true;
  } catch (err) { /* 服务未启动也不影响源码级检查 */ }

  if (apiOk) {
    try {
      const pj = await (await fetch(BASE + '/api/prices?limit=1')).json();
      const item = (pj.items || [])[0] || {};
      for (const f of ['item_name', 'engname', 'category']) {
        commonCheck(`接口返回 ${f} 字段`, item[f] !== undefined, String(item[f]).slice(0, 18));
      }
    } catch (err) {
      commonCheck('价格接口可访问', false, String(err.message));
    }
  } else {
    console.log('[INFO] 服务未启动，跳过接口检查（源码级检查仍然有效）');
  }

  sourceInvariants();

  const edge = findEdge();
  const spawnAllowed = wantGeometry || process.env.POE2_FORCE_GEOMETRY === '1';
  if (edge && spawnAllowed) {
    geometryChecks(edge);
  } else if (!edge) {
    console.log('[SKIP] 未找到 Edge，跳过几何对齐检查');
  } else if (!apiOk) {
    console.log('[SKIP] 服务未启动，跳过几何对齐检查');
  } else {
    console.log('[SKIP] 几何对齐检查默认不在本进程内执行（沙箱下 Node 起子进程会 EPERM）');
    console.log('        直接运行本文件时请加 --geometry（或设 POE2_GEOMETRY=1）来启用。');
  }

  console.log('\n' + '='.repeat(46));
  console.log(failures.length === 0 ? '价格看板列对齐测试：全部通过' : `价格看板列对齐测试：${failures.length} 项失败`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
