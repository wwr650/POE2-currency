/* 可搜索、按分类分组的道具选择器（替代原生 <select>）
   用法：
     const w = PoE.searchSelect(host, { placeholder: '搜索道具…', onChange: fn });
     w.setItems([{ value, label, category, meta }]);   // 按 category 分组
     w.value / w.setValue(v)                           // 当前选中值
   —— 300+ 道具时可直接输入中文/英文/分类名筛选。（全局 PoE.searchSelect） */
(function (global) {
  'use strict';

  const P = global.PoE;

  function searchSelect(host, opts) {
    const o = Object.assign({ placeholder: '搜索道具（中/英文/分类）…', maxRows: 220, onChange: null }, opts || {});
    let items = [];
    let filtered = [];
    let value = '';
    let open = false;

    host.classList.add('ss');
    // 用 createElement/appendChild 构建（便于测试与后续扩展）
    const btn = document.createElement('button');
    btn.setAttribute('type', 'button');
    btn.className = 'ss-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    const text = document.createElement('span');
    text.className = 'ss-text';
    const caret = document.createElement('span');
    caret.className = 'ss-caret';
    caret.textContent = '▾';
    btn.appendChild(text);
    btn.appendChild(caret);

    const panel = document.createElement('div');
    panel.className = 'ss-panel';
    panel.setAttribute('hidden', 'hidden');
    const input = document.createElement('input');
    input.setAttribute('type', 'text');
    input.className = 'ss-input';
    input.setAttribute('placeholder', o.placeholder);
    input.setAttribute('autocomplete', 'off');
    const list = document.createElement('div');
    list.className = 'ss-list';
    list.setAttribute('role', 'listbox');
    const hint = document.createElement('div');
    hint.className = 'ss-hint';
    panel.appendChild(input);
    panel.appendChild(list);
    panel.appendChild(hint);

    host.appendChild(btn);
    host.appendChild(panel);

    function labelOf(v) {
      const found = items.filter((i) => i.value === v)[0];
      return found ? found.label : '';
    }

    function setText() {
      const found = items.filter((i) => i.value === value)[0];
      text.textContent = found ? found.label : (value ? value : o.placeholder);
      text.className = 'ss-text' + (found ? '' : ' ss-ph');
      btn.title = found ? found.label : '';
    }

    function applyFilter() {
      const q = (input.value || '').trim().toLowerCase();
      const out = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!q) { out.push(it); continue; }
        const hay = ((it.label || '') + ' ' + (it.engname || '') + ' ' + (it.category || '') + ' ' + (it.value || '')).toLowerCase();
        if (hay.indexOf(q) >= 0) out.push(it);
      }
      filtered = out;
    }

    function renderList() {
      applyFilter();
      const rows = filtered.slice(0, o.maxRows);
      let html = '';
      let lastCat = null;
      rows.forEach((it) => {
        const cat = it.category || '其他';
        if (cat !== lastCat) {
          html += '<div class="ss-group">' + P.escapeHtml(cat) + '</div>';
          lastCat = cat;
        }
        const price = it.meta ? '<span class="ss-price">' + P.escapeHtml(it.meta) + '</span>' : '';
        html += '<div class="ss-item' + (it.value === value ? ' on' : '') + '" data-v="' + P.escapeHtml(it.value) + '">' +
          '<span class="ss-name">' + P.escapeHtml(it.label) + '</span>' + price + '</div>';
      });
      list.innerHTML = html || '<div class="ss-empty">没有匹配的道具</div>';
      hint.textContent = filtered.length
        ? '共 ' + filtered.length + ' 项' + (filtered.length > rows.length ? '（显示前 ' + rows.length + ' 项，继续输入以缩小范围）' : '')
        : '换个关键词试试（支持中文名 / 英文名 / 分类）';
    }

    function openPanel() {
      open = true;
      panel.hidden = false;
      panel.removeAttribute('hidden');
      host.classList.add('open');
      input.value = '';
      renderList();
      try { input.focus(); } catch (e) { /* ignore */ }
      // 让选中项出现在可视区域
      setTimeout(() => {
        const on = list.querySelector ? list.querySelector('.ss-item.on') : null;
        if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
      }, 0);
    }

    function closePanel() {
      open = false;
      panel.hidden = true;
      panel.setAttribute('hidden', 'hidden');
      host.classList.remove('open');
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (open) closePanel(); else openPanel();
    });
    input.addEventListener('input', P.debounce(() => renderList(), 120));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closePanel(); return; }
      if (e.key === 'Enter') {
        const first = filtered[0];
        if (first) { select(first.value); }
      }
    });
    list.addEventListener('click', (e) => {
      const row = e.target.closest ? e.target.closest('.ss-item') : null;
      if (!row) return;
      select(row.getAttribute('data-v'));
    });
    document.addEventListener('click', (e) => {
      if (!host.contains || !host.contains(e.target)) closePanel();
    });

    function select(v) {
      value = v;
      setText();
      closePanel();
      if (typeof o.onChange === 'function') o.onChange(v, items.filter((i) => i.value === v)[0] || null);
    }

    const api = {
      setItems(next) {
        items = (next || []).slice();
        // 让分类顺序稳定：先按分类名，再按名称
        items.sort((a, b) => String(a.category || '').localeCompare(String(b.category || ''), 'zh-CN') ||
          String(a.label || '').localeCompare(String(b.label || ''), 'zh-CN'));
        if (value && !items.filter((i) => i.value === value).length) value = '';
        setText();
        if (open) renderList();
      },
      setValue(v) { value = v || ''; setText(); return api; },
      get value() { return value; },
      set value(v) { value = v || ''; setText(); },
      open() { openPanel(); return api; },
      close() { closePanel(); return api; },
      get items() { return items; },
      get filtered() { return filtered; }
    };

    setText();
    return api;
  }

  global.PoE.searchSelect = searchSelect;
})(window);
