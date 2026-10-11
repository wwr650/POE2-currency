/* 轻量自研图表：SVG 折线图（支持多序列、多点悬停、断点、自适应）
   不依赖任何 CDN，离线可用。全局 PoE.charts */
(function (global) {
  'use strict';

  const P = global.PoE;
  //: 道具配色对：[买入色, 卖出色]，明度接近但色相差异大，暗色背景下易区分
  const PAIRS = [
    ['#4cc9f0', '#ff9f43'],   // 青 / 橙
    ['#7ddf64', '#ff6b9d'],   // 绿 / 玫红
    ['#b388ff', '#ffd93d'],   // 紫 / 黄
    ['#5aa9e6', '#f2635f'],   // 蓝 / 红
    ['#41e0c8', '#e879f9']    // 蓝绿 / 品红
  ];
  //: 单序列（如汇率）用金色
  const PALETTE = ['#d8b26a', '#4cc9f0', '#7ddf64', '#ff9f43', '#b388ff', '#ff6b9d', '#41e0c8'];
  const BUY_LEGEND = '#4cc9f0';
  const SELL_LEGEND = '#ff9f43';

  const NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs) {
    const node = document.createElementNS(NS, tag);
    if (attrs) Object.keys(attrs).forEach((k) => node.setAttribute(k, attrs[k]));
    return node;
  }

  function fmtValue(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 10000) return (v / 1000).toFixed(1) + 'k';
    if (a >= 1000) return v.toFixed(0);
    if (a >= 100) return v.toFixed(1);
    if (a >= 1) return v.toFixed(2);
    if (a >= 0.01) return v.toFixed(3);
    return v.toExponential(1);
  }

  function fmtTick(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  class LineChart {
    /** @param {HTMLElement} container @param {{unit?:string,height?:number,yLabel?:string,spanGaps?:boolean}} opts */
    constructor(container, opts) {
      this.el = container;
      this.opts = Object.assign({ height: 280, unit: '', spanGaps: false, yLabel: '' }, opts || {});
      this.series = [];
      this.rateSeries = null;
      this._hover = null;
      this._build();
      this._onResize = P.debounce(() => this.render(), 120);
      window.addEventListener('resize', this._onResize);
    }

    _build() {
      this.el.classList.add('chart-box');
      this.el.innerHTML = '';
      this.svg = el('svg', { width: '100%', height: this.opts.height, preserveAspectRatio: 'none' });
      this.svg.style.height = this.opts.height + 'px';
      this.el.appendChild(this.svg);
      this.tip = document.createElement('div');
      this.tip.className = 'chart-tooltip';
      this.el.appendChild(this.tip);
      this.legend = document.createElement('div');
      this.legend.className = 'chart-legend';
      this.legend.style.marginTop = '8px';
      this.el.appendChild(this.legend);
    }

    destroy() {
      window.removeEventListener('resize', this._onResize);
      this.el.innerHTML = '';
    }

    /** data: [{name, unit, points:[{t: isoString, buy_avg, sell_avg}]}] */
    setHistory(data, mode) {
      this.mode = mode || 'price';
      this._raw = data || [];
      this.render();
    }

    /** rate points: [{t, d_to_e}] */
    setRate(points) {
      this._rate = points || [];
      this.render();
    }

    render() {
      const width = Math.max(320, this.el.clientWidth || 640);
      const height = this.opts.height;
      const pad = { top: 14, right: 16, bottom: 30, left: 58 };
      const innerW = width - pad.left - pad.right;
      const innerH = height - pad.top - pad.bottom;

      this.svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      this.svg.setAttribute('width', width);
      while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);

      const palette = PALETTE;
      let series = [];
      if (this.mode === 'rate') {
        series = [{ name: '1 d = ', color: palette[0], points: (this._rate || []).map((r) => ({ t: r.t, v: r.d_to_e })), unit: 'e' }];
      } else {
        (this._raw || []).forEach((s, i) => {
          const pair = PAIRS[i % PAIRS.length];
          // 买入 / 卖出用不同颜色（而非同色虚线），并加粗提升对比度
          series.push({
            name: s.name + ' · 买入', color: pair[0], width: 2.6,
            points: (s.points || []).map((p) => ({ t: p.t, v: p.buy_avg })), unit: s.unit
          });
          series.push({
            name: s.name + ' · 卖出', color: pair[1], width: 2.6,
            points: (s.points || []).map((p) => ({ t: p.t, v: p.sell_avg })), unit: s.unit
          });
        });
      }
      series = series.filter((s) => s.points.length);
      this._series = series;

      if (!series.length) {
        this._empty(width, height);
        this.legend.innerHTML = '';
        return;
      }

      const allTimes = [];
      series.forEach((s) => s.points.forEach((p) => { const t = Date.parse(p.t); if (!Number.isNaN(t)) allTimes.push(t); }));
      const xMin = Math.min.apply(null, allTimes), xMax = Math.max.apply(null, allTimes);
      const xSpan = Math.max(1, xMax - xMin);

      let yMin = Infinity, yMax = -Infinity;
      series.forEach((s) => s.points.forEach((p) => {
        if (p.v === null || p.v === undefined || !isFinite(p.v)) return;
        if (p.v < yMin) yMin = p.v;
        if (p.v > yMax) yMax = p.v;
      }));
      if (!isFinite(yMin)) { yMin = 0; yMax = 1; }
      if (yMin === yMax) { const d = Math.abs(yMin) * 0.05 || 1; yMin -= d; yMax += d; }
      const yPad = (yMax - yMin) * 0.08;
      yMin = Math.max(0, yMin - yPad);
      yMax = yMax + yPad;

      const X = (ts) => pad.left + ((ts - xMin) / xSpan) * innerW;
      const Y = (v) => pad.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

      const g = el('g');
      this.svg.appendChild(g);

      // 水平网格 + y 轴刻度
      const ticks = 5;
      for (let i = 0; i <= ticks; i++) {
        const value = yMin + (yMax - yMin) * (i / ticks);
        const y = Y(value);
        g.appendChild(el('line', {
          x1: pad.left, x2: pad.left + innerW, y1: y, y2: y,
          stroke: i === 0 ? '#2b3140' : '#1f2532', 'stroke-width': 1
        }));
        const label = el('text', { x: pad.left - 8, y: y + 4, fill: '#6b7488', 'font-size': 11, 'text-anchor': 'end' });
        label.textContent = fmtValue(value);
        g.appendChild(label);
      }

      // x 轴刻度
      const xticks = width < 520 ? 3 : 6;
      for (let i = 0; i <= xticks; i++) {
        const ts = xMin + xSpan * (i / xticks);
        const x = X(ts);
        g.appendChild(el('line', { x1: x, x2: x, y1: pad.top, y2: pad.top + innerH, stroke: '#171c26', 'stroke-width': 1 }));
        const label = el('text', { x: x, y: height - 10, fill: '#6b7488', 'font-size': 10.5, 'text-anchor': i === 0 ? 'start' : (i === xticks ? 'end' : 'middle') });
        label.textContent = fmtTick(ts);
        g.appendChild(label);
      }

      // 曲线
      series.forEach((s) => {
        const segs = [];
        let current = [];
        s.points.forEach((p) => {
          const t = Date.parse(p.t);
          const ok = !Number.isNaN(t) && p.v !== null && p.v !== undefined && isFinite(p.v);
          if (ok) {
            current.push([X(t), Y(p.v)]);
          } else if (current.length) {
            segs.push(current); current = [];
          }
        });
        if (current.length) segs.push(current);

        segs.forEach((seg) => {
          if (seg.length === 1) {
            g.appendChild(el('circle', { cx: seg[0][0], cy: seg[0][1], r: 2.4, fill: s.color }));
            return;
          }
          const d = seg.map((pt, i) => (i ? 'L' : 'M') + pt[0].toFixed(1) + ' ' + pt[1].toFixed(1)).join(' ');
          g.appendChild(el('path', {
            d: d, fill: 'none', stroke: s.color, 'stroke-width': s.width || 1.9,
            'stroke-linejoin': 'round', 'stroke-linecap': 'round',
            'stroke-dasharray': s.dash || 'none', opacity: 1
          }));
          // 单点大圆点（数据稀疏时更容易看到）
          if (seg.length === 1) {
            g.appendChild(el('circle', { cx: seg[0][0], cy: seg[0][1], r: 3, fill: s.color }));
          }
        });
      });

      // 悬停层
      this._hoverLine = el('line', {
        x1: 0, x2: 0, y1: pad.top, y2: pad.top + innerH,
        stroke: '#d8b26a', 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0
      });
      g.appendChild(this._hoverLine);
      this._hoverDots = series.map((s) => {
        const c = el('circle', { r: 3.4, fill: s.color, stroke: '#0b0d12', 'stroke-width': 1.2, opacity: 0 });
        g.appendChild(c);
        return c;
      });

      const overlay = el('rect', {
        x: pad.left, y: pad.top, width: innerW, height: innerH,
        fill: 'transparent', style: 'cursor:crosshair'
      });
      g.appendChild(overlay);

      const onMove = (evt) => this._handleMove(evt, overlay, { X, Y, xMin, xMax, pad, innerW, innerH });
      overlay.addEventListener('mousemove', onMove);
      overlay.addEventListener('mouseleave', () => this._clearHover());
      overlay.addEventListener('touchmove', (evt) => {
        const t = evt.touches[0];
        if (t) this._handleMove({ clientX: t.clientX, clientY: t.clientY }, overlay, { X, Y, xMin, xMax, pad, innerW, innerH });
      }, { passive: true });

      this._geom = { X, Y, pad, innerW, innerH };
      this._renderLegend(series);
    }

    _handleMove(evt, overlay, geo) {
      const rect = this.svg.getBoundingClientRect();
      const scale = rect.width / (this.svg.viewBox.baseVal.width || rect.width);
      const xLocal = (evt.clientX - rect.left) / (scale || 1);
      const ratio = Math.max(0, Math.min(1, (xLocal - geo.pad.left) / geo.innerW));
      const targetTs = geo.xMin + (geo.xMax - geo.xMin) * ratio;

      let bestTs = null, bestDist = Infinity;
      this._series.forEach((s) => s.points.forEach((p) => {
        const t = Date.parse(p.t);
        if (Number.isNaN(t)) return;
        const d = Math.abs(t - targetTs);
        if (d < bestDist) { bestDist = d; bestTs = t; }
      }));
      if (bestTs === null) return;

      const x = geo.X(bestTs);
      this._hoverLine.setAttribute('x1', x);
      this._hoverLine.setAttribute('x2', x);
      this._hoverLine.setAttribute('opacity', 1);

      let html = '<div class="t">' + P.shortTime(new Date(bestTs).toISOString()) + '</div>';
      this._series.forEach((s, i) => {
        let value = null;
        s.points.forEach((p) => { if (Date.parse(p.t) === bestTs) value = p.v; });
        const dot = this._hoverDots[i];
        if (value === null || value === undefined || !isFinite(value)) {
          dot.setAttribute('opacity', 0);
          return;
        }
        dot.setAttribute('cx', x);
        dot.setAttribute('cy', geo.Y(value));
        dot.setAttribute('opacity', 1);
        html += '<div class="row"><span class="dot" style="background:' + s.color + '"></span>' +
          P.escapeHtml(s.name) + '<b>' + fmtValue(value) + ' ' + P.escapeHtml(s.unit || '') + '</b></div>';
      });
      this.tip.innerHTML = html;
      this.tip.style.display = 'block';
      const wrapW = this.el.clientWidth;
      const tipW = this.tip.offsetWidth || 150;
      let left = (x / (this.svg.viewBox.baseVal.width || wrapW)) * wrapW + 14;
      if (left + tipW > wrapW) left = Math.max(4, (x / (this.svg.viewBox.baseVal.width || wrapW)) * wrapW - tipW - 14);
      this.tip.style.left = left + 'px';
      this.tip.style.top = '12px';
    }

    _clearHover() {
      if (this._hoverLine) this._hoverLine.setAttribute('opacity', 0);
      (this._hoverDots || []).forEach((d) => d.setAttribute('opacity', 0));
      this.tip.style.display = 'none';
    }

    _renderLegend(series) {
      const seen = {};
      const items = series.map((s) => {
        if (seen[s.name]) return '';
        seen[s.name] = true;
        return '<span class="key"><span class="dot" style="background:' + s.color + '"></span>' +
          P.escapeHtml(s.name) + '</span>';
      }).filter(Boolean);
      this.legend.innerHTML = items.join('');
    }

    _empty(width, height) {
      const text = el('text', {
        x: width / 2, y: height / 2, fill: '#6b7488', 'font-size': 13,
        'text-anchor': 'middle'
      });
      text.textContent = '暂无历史数据（需要至少一份快照；调度器每小时会自动累积）';
      this.svg.appendChild(text);
      this._series = [];
    }
  }

  /** 迷你走势图（内联 SVG 字符串），用于抽屉与表格 */
  function sparkline(values, opts) {
    const o = Object.assign({ width: 220, height: 40, color: '#d8b26a' }, opts || {});
    const nums = (values || []).filter((v) => v !== null && v !== undefined && isFinite(v));
    if (nums.length < 2) return '<div class="muted" style="font-size:12px">数据点不足（' + nums.length + '）</div>';
    const min = Math.min.apply(null, nums), max = Math.max.apply(null, nums);
    const span = (max - min) || Math.abs(max) || 1;
    const step = o.width / (nums.length - 1);
    const pts = nums.map((v, i) => [i * step, o.height - 4 - ((v - min) / span) * (o.height - 10)]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const up = nums[nums.length - 1] >= nums[0];
    const color = o.color === 'auto' ? (up ? '#4ec97a' : '#f2635f') : o.color;
    return '<svg width="' + o.width + '" height="' + o.height + '" viewBox="0 0 ' + o.width + ' ' + o.height + '">' +
      '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.6"/>' +
      '<circle cx="' + pts[pts.length - 1][0].toFixed(1) + '" cy="' + pts[pts.length - 1][1].toFixed(1) + '" r="2.4" fill="' + color + '"/>' +
      '</svg>';
  }

  global.PoE.charts = { LineChart, sparkline, PALETTE, PAIRS, fmtValue };
})(window);
