/* 收益分析页共用的计算与行渲染工具（全局 PoE.dropRows）
   统一口径：期望金额 = 单价 × 数量 × 概率 ÷ 100（概率上限 100%） */
(function (global) {
  'use strict';

  const P = global.PoE;

  function clampChance(v) {
    const n = Number(v);
    if (!isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
  }

  /* ------------------------------------------------------------ 数值精度
     页面所有展示数值统一保留**最多 2 位**小数。 */
  function n2(v, digits) {
    const n = Number(v);
    if (!isFinite(n)) return '—';
    const r = Math.round(n * 100) / 100;          // 先归一到 2 位，去掉浮点尾巴
    const min = Math.max(0, Math.min(2, Number(digits) || 0));   // 最多 2 位
    return r.toLocaleString('zh-CN', {
      minimumFractionDigits: min,
      maximumFractionDigits: 2,
    });
  }

  /** 概率：最多 2 位小数 */
  function pct2(v) {
    const n = Number(v);
    if (!isFinite(n)) return '—';
    return n2(n) + '%';
  }

  /** 单价显示：价格库未就绪或查不到时返回 — ，不谎报 0.00 */
  function fmtPrice(v, unit) {
    return (v === null || v === undefined) ? '—' : n2(v) + ' ' + unit;
  }

  /** 概率单元格：手动填写的掉落概率 */
  function probCell(entry) {
    const override = (entry && entry.chance_override !== undefined && entry.chance_override !== null)
      ? clampChance(entry.chance_override) : null;
    const c = override !== null ? override : clampChance(entry.chance);
    return '<span class="prob-wrap">' +
      '<span class="prob-label" title="掉落概率，0~100%，支持小数">概率</span>' +
      '<input type="number" class="chance" min="0" max="100" step="0.01" value="' + n2(c) + '" title="掉落概率 %（0~100，最多 2 位小数）">' +
      '</span><span class="calc" title="期望金额">';
  }

  /** 掉落行 HTML
   *  opts: { up, unit, sourceSelect } */
  function dropRow(entry, i, o) {
    const opts = o || {};
    const up = opts.up;
    const unit = opts.unit || '';
    const override = (entry.chance_override !== undefined && entry.chance_override !== null)
      ? clampChance(entry.chance_override) : null;
    const chance = override !== null ? override : clampChance(entry.chance);
    const exp = entry.enabled === false ? 0 : (up || 0) * (Number(entry.qty) || 0) * chance / 100;
    const prob = probCell(entry);
    const amount = n2(exp) + '</span>';

    if (entry.custom) {
      return '<div class="entry custom drops" data-kind="drop" data-idx="' + i + '">' +
        '<input type="checkbox" class="enabled"' + (entry.enabled === false ? '' : ' checked') + ' title="启用">' +
        '<div class="nm"><input type="text" class="custom-name" value="' + P.escapeHtml(entry.custom_name) + '" placeholder="名称">' +
        '<div class="sub">自定义单价</div></div>' +
        '<span class="price-unit">' +
          '<input type="number" class="price" step="0.01" min="0" value="' + n2(entry.price) + '" title="单价（最多 2 位小数）">' +
          '<select class="unit"><option value="d"' + (entry.unit === 'd' ? ' selected' : '') + '>d</option>' +
          '<option value="e"' + (entry.unit === 'e' ? ' selected' : '') + '>e</option></select>' +
        '</span>' +
        '<span class="unit-price" title="当前单价">' + fmtPrice(up, unit) + '</span>' +
        prob + amount +
        '<button class="btn btn-sm btn-danger del" title="删除">✕</button></div>';
    }
    return '<div class="entry drops" data-kind="drop" data-idx="' + i + '">' +
      '<input type="checkbox" class="enabled"' + (entry.enabled === false ? '' : ' checked') + ' title="启用">' +
      '<div class="nm"><div>' + P.escapeHtml(entry.name || entry.engname) + '</div>' +
      '<div class="sub">' + P.escapeHtml(entry.engname) + '</div></div>' +
      opts.sourceSelect +
      '<span class="unit-price" title="所选价格来源的单价">' + fmtPrice(up, unit) + '</span>' +
      prob + amount +
      '<button class="btn btn-sm btn-danger del" title="删除">✕</button></div>';
  }

  global.PoE.dropRows = {
    clampChance, fmtPrice, dropRow,
    n2, pct2
  };
})(window);
