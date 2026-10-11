/* 自定义道具管理（收益分析页使用）
   —— 一个数据源（data/custom_items.json）、一套界面、一套行为。
   全局 PoE.customItems */
(function (global) {
  'use strict';

  const P = global.PoE;

  /** 解析一个自定义条目：从 id 出发取回**最新**的名称/单价/单位
   *  （选择器里的 label 是加列表时的快照，可能已过期） */
  function entryById(id, base, opts) {
    const list = (base && base.customList) || [];
    const item = list.find((c) => c.id === id);
    if (!item) return null;
    const entry = {
      custom: true,
      custom_name: item.name,
      name: item.name,
      engname: '',
      unit: item.unit || 'd',
      price: Number(item.price) || 0,
      qty: 1,
    };
    if (opts && opts.chance !== undefined) entry.chance = opts.chance;
    if (opts && opts.enabled !== undefined) entry.enabled = opts.enabled;
    return entry;
  }

  /** 从选择器的 value（"custom:<id>"）解析条目 */
  function entryByKey(key, base, opts) {
    if (!key || String(key).indexOf('custom:') !== 0) return null;
    return entryById(String(key).slice(7), base, opts);
  }

  /**
   * 创建自定义道具管理面板控制器。
   * opts: {
   *   listEl, nameEl, engEl, priceEl, unitEl, addBtn,   // 侧栏元素
   *   base() -> { customList, display_unit },          // 取当前数据
   *   list: { ticket?: {list, render}, drop?: {list, render} },  // 「加入门票/掉落」目标
   *   onChange(entry, kind)                            // 条目变化后由页面重绘/计算/保存
   * }
   */
  function controller(opts) {
    const o = opts || {};
    const els = {
      list: o.listEl,
      name: o.nameEl,
      eng: o.engEl,
      price: o.priceEl,
      unit: o.unitEl,
      add: o.addBtn,
      exportBtn: o.exportBtn,
      importBtn: o.importBtn,
      importFile: o.importFile,
    };
    const base = () => (typeof o.base === 'function' ? o.base() : (o.base || {}));

    /* -------------------------------------------------- 渲染列表 */
    function render() {
      if (!els.list) return;
      const items = base().customList || [];
      els.list.innerHTML = items.length ? items.map((c) =>
        '<div class="entry custom-row" data-id="' + P.escapeHtml(c.id) + '">' +
        '<div class="r1">' +
          '<span class="nm" title="' + P.escapeHtml(c.name) + '">' + P.escapeHtml(c.name) + '</span>' +
          '<span class="calc">' + P.num(c.price) + ' ' + P.escapeHtml(c.unit) + '</span>' +
        '</div>' +
        '<div class="r2" title="' + P.escapeHtml(c.engname || '') + '">' +
          P.escapeHtml(c.engname || '—') + ' · 更新 ' + P.escapeHtml(P.shortTime(c.updated_at)) +
        '</div>' +
        '<div class="r3">' +
          '<button class="btn btn-sm ci-ticket" title="加入门票（成本）">加入门票</button>' +
          '<button class="btn btn-sm ci-drop" title="加入掉落（收益）">加入掉落</button>' +
          '<button class="btn btn-sm btn-danger del ci-del" title="删除该自定义道具">✕</button>' +
        '</div>' +
        '</div>').join('')
        : '<div class="muted">暂无自定义道具</div>';
    }

    /* -------------------------------------------------- 选择器同步 */
    /** 把自定义道具合并进选择器（保留价格库选项，避免整表重载） */
    function syncPickers() {
      const items = base().customList || [];
      const custom = items.map((i) => ({
        value: 'custom:' + i.id,
        label: '[自定义] ' + i.name,
        engname: i.engname || '',
        category: '自定义道具',
        meta: P.num(i.price) + ' ' + i.unit,
      }));
      [o.pickTicket, o.pickDrop].forEach((pick) => {
        if (!pick) return;
        const rest = (pick.items || []).filter((it) => String(it.value).indexOf('custom:') !== 0);
        pick.setItems(custom.concat(rest));
      });
    }

    /* -------------------------------------------------- 新增 */
    async function add() {
      const name = els.name ? els.name.value.trim() : '';
      if (!name) { P.ui.toast('请填写名称', 'err'); return null; }
      const price = Number(els.price && els.price.value) || 0;
      try {
        const res = await P.api.customCreate({
          name: name,
          engname: els.eng ? els.eng.value.trim() : '',
          unit: els.unit ? els.unit.value : 'd',
          price: price,
        });
        if (els.name) els.name.value = '';
        if (els.eng) els.eng.value = '';
        if (els.price) els.price.value = '';
        P.ui.toast('已添加自定义道具：' + P.escapeHtml(name), 'ok');
        if (typeof o.onRefresh === 'function') await o.onRefresh();
        render();
        syncPickers();
        return res && res.item;
      } catch (err) {
        P.ui.toast('添加失败：' + P.escapeHtml(err.message), 'err');
        return null;
      }
    }

    /* -------------------------------------------------- 删除 / 加入条目 */
    async function remove(id, name) {
      if (!confirm('删除自定义道具「' + name + '」？')) return false;
      try {
        await P.api.customDelete(id);
        if (typeof o.onRefresh === 'function') await o.onRefresh();
        render();
        syncPickers();
        P.ui.toast('已删除自定义道具：' + P.escapeHtml(name), 'ok');
        return true;
      } catch (err) {
        P.ui.toast('删除失败：' + P.escapeHtml(err.message), 'err');
        return false;
      }
    }

    function addToList(item, kind) {
      const target = (o.list || {})[kind];
      if (!target) return false;
      // 每次都重新取数组：页面在载入记录/清空时会整体替换 state.ticket / state.drops
      const arr = (typeof target.list === 'function') ? target.list() : target.list;
      if (!Array.isArray(arr)) return false;
      const entry = entryById(item.id, base(), kind === 'drop'
        ? { chance: 100, enabled: true } : {});
      if (!entry) return false;
      arr.push(entry);
      if (typeof target.render === 'function') target.render();
      if (typeof o.onChange === 'function') o.onChange(entry, kind);
      P.ui.toast((kind === 'drop' ? '已加入掉落：' : '已加入门票：') + P.escapeHtml(item.name), 'ok');
      return true;
    }

    /* -------------------------------------------------- 事件 */
    if (els.add) els.add.addEventListener('click', () => { add(); });
    if (els.list) {
      els.list.addEventListener('click', async (e) => {
        const row = e.target.closest('.entry');
        if (!row) return;
        const id = row.getAttribute('data-id');
        const item = (base().customList || []).find((c) => c.id === id);
        if (!item) return;
        if (e.target.classList.contains('ci-del')) { await remove(id, item.name); return; }
        if (e.target.classList.contains('ci-ticket')) { addToList(item, 'ticket'); return; }
        if (e.target.classList.contains('ci-drop')) { addToList(item, 'drop'); }
      });
    }
    if (els.exportBtn) els.exportBtn.addEventListener('click', exportData);
    if (els.importBtn) els.importBtn.addEventListener('click', importData);

    /* -------------------------------------------------- 导出 / 导入（长效保存） */
    async function exportData() {
      try {
        const data = await P.api.backupExport();
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        P.download('poe2-backup-' + stamp + '.json', JSON.stringify(data, null, 2));
        const c = data.counts || {};
        P.ui.toast('已导出备份：自定义道具 ' + (c['自定义道具'] || 0) + ' 个 · 收益配置 ' +
          (c['收益配置'] || 0) + ' 个', 'ok', 6000);
      } catch (err) {
        P.ui.toast('导出失败：' + P.escapeHtml(err.message), 'err');
      }
    }

    async function importData() {
      const file = els.importFile && els.importFile.files && els.importFile.files[0];
      if (!file) return;
      try {
        const payload = JSON.parse(await file.text());
        const res = await P.api.backupImport(payload);
        const parts = Object.keys(res.imported || {}).map((k) => {
          const it = res.imported[k];
          return k + ' 新增 ' + it.added + (it.updated ? ' / 更新 ' + it.updated : '');
        });
        P.ui.toast('导入完成（' + (res.mode === 'replace' ? '覆盖' : '合并') + '）：' +
          P.escapeHtml(parts.join('，')), 'ok', 8000);
        if (typeof o.onRefresh === 'function') await o.onRefresh();
        render();
        syncPickers();
        if (typeof o.onChange === 'function') o.onChange(null, 'import');
      } catch (err) {
        P.ui.toast('导入失败：' + P.escapeHtml(err.message), 'err', 8000);
      } finally {
        if (els.importFile) els.importFile.value = '';
      }
    }

    return {
      render, syncPickers, add, remove, addToList, exportData, importData,
      _els: els,
    };
  }

  global.PoE.customItems = { controller, entryById, entryByKey };
})(window);
