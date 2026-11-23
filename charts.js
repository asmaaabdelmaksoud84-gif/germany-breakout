/* Chart rendering for the classroom app: SVG line charts with a crosshair
 * tooltip, horizontal bar charts, direct labels, and a table view.
 * No dependencies. */
(function (root) {
  'use strict';

  var SERIES = ['--series-1', '--series-2', '--series-3', '--series-4',
                '--series-5', '--series-6', '--series-7', '--series-8'];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function fmt(x, dp) {
    if (x === null || x === undefined || !isFinite(x)) return '—';
    return x.toFixed(dp === undefined ? 2 : dp);
  }
  function niceTicks(lo, hi, want) {
    want = want || 5;
    if (!(isFinite(lo) && isFinite(hi))) return [0, 1];
    if (hi === lo) { hi = lo + 1; }
    var span = hi - lo;
    var raw = span / want;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    var start = Math.ceil(lo / step) * step;
    var out = [];
    for (var v = start; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(10));
    return out;
  }

  /**
   * Line chart.
   * opts: {
   *   years:[], series:[{name,values,color?,width?,dash?,opacity?,noLegend?,label?}],
   *   band:{lo:[],hi:[],color?,label?}, vline:year, vlabel:'',
   *   yTitle, height, zeroLine:bool, directLabels:bool, highlightLast:bool
   * }
   */
  function lineChart(host, opts) {
    var years = opts.years, series = opts.series.filter(function (s) { return s && s.values; });
    var H = opts.height || 330;
    var padL = 52, padR = opts.directLabels === false ? 16 : 104, padT = 14, padB = 34;
    var W = Math.max(360, host.clientWidth || 720);
    var iw = W - padL - padR, ih = H - padT - padB;

    // ---- domain
    var lo = Infinity, hi = -Infinity, i, k, s;
    function note(v) { if (isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    for (k = 0; k < series.length; k++) {
      for (i = 0; i < years.length; i++) note(series[k].values[i]);
    }
    if (opts.band) for (i = 0; i < years.length; i++) { note(opts.band.lo[i]); note(opts.band.hi[i]); }
    if (opts.zeroLine) note(0);
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    var pad = (hi - lo) * 0.08 || 0.5;
    lo -= pad; hi += pad;
    var ticks = niceTicks(lo, hi, 5);
    if (ticks.length) { lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]); }

    var x0 = years[0], x1 = years[years.length - 1];
    function X(y) { return padL + (years.length < 2 ? iw / 2 : (y - x0) / (x1 - x0) * iw); }
    function Y(v) { return padT + ih - (v - lo) / (hi - lo) * ih; }

    var colors = series.map(function (sr, idx) {
      return sr.color || cssVar(SERIES[idx % SERIES.length]);
    });

    var g = [];
    g.push('<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' +
           esc(opts.yTitle || 'chart') + '" preserveAspectRatio="none">');

    // gridlines
    for (i = 0; i < ticks.length; i++) {
      var ty = Y(ticks[i]);
      g.push('<line x1="' + padL + '" y1="' + ty.toFixed(1) + '" x2="' + (padL + iw) +
             '" y2="' + ty.toFixed(1) + '" stroke="' + cssVar('--grid') + '" stroke-width="1"/>');
      g.push('<text x="' + (padL - 8) + '" y="' + (ty + 3.5).toFixed(1) +
             '" text-anchor="end" font-size="10.5" fill="' + cssVar('--ink-muted') +
             '" style="font-variant-numeric:tabular-nums">' + fmt(ticks[i], opts.yDp === undefined ? 1 : opts.yDp) + '</text>');
    }
    // x ticks every 5 years
    for (i = 0; i < years.length; i++) {
      var yr = years[i];
      if (yr % 5 !== 0 && i !== 0 && i !== years.length - 1) continue;
      var tx = X(yr);
      g.push('<text x="' + tx.toFixed(1) + '" y="' + (padT + ih + 17) +
             '" text-anchor="middle" font-size="10.5" fill="' + cssVar('--ink-muted') +
             '" style="font-variant-numeric:tabular-nums">' + yr + '</text>');
    }
    // axis + optional zero line
    g.push('<line x1="' + padL + '" y1="' + (padT + ih) + '" x2="' + (padL + iw) +
           '" y2="' + (padT + ih) + '" stroke="' + cssVar('--axis') + '" stroke-width="1"/>');
    if (opts.zeroLine && 0 > lo && 0 < hi) {
      g.push('<line x1="' + padL + '" y1="' + Y(0).toFixed(1) + '" x2="' + (padL + iw) +
             '" y2="' + Y(0).toFixed(1) + '" stroke="' + cssVar('--axis') +
             '" stroke-width="1.5" stroke-dasharray="1 0"/>');
    }

    // confidence band
    if (opts.band) {
      var up = [], dn = [];
      for (i = 0; i < years.length; i++) {
        if (!isFinite(opts.band.lo[i]) || !isFinite(opts.band.hi[i])) continue;
        up.push(X(years[i]).toFixed(1) + ',' + Y(opts.band.hi[i]).toFixed(1));
        dn.push(X(years[i]).toFixed(1) + ',' + Y(opts.band.lo[i]).toFixed(1));
      }
      if (up.length > 1) {
        g.push('<polygon points="' + up.join(' ') + ' ' + dn.reverse().join(' ') +
               '" fill="' + (opts.band.color || cssVar('--series-2')) +
               '" opacity="0.13" stroke="none"/>');
      }
    }

    // intervention line
    if (opts.vline && opts.vline >= x0 && opts.vline <= x1) {
      var vx = X(opts.vline);
      g.push('<line x1="' + vx.toFixed(1) + '" y1="' + padT + '" x2="' + vx.toFixed(1) +
             '" y2="' + (padT + ih) + '" stroke="' + cssVar('--ink-2') +
             '" stroke-width="1.25" stroke-dasharray="4 3"/>');
      g.push('<text x="' + (vx + 5).toFixed(1) + '" y="' + (padT + 11) +
             '" font-size="10.5" font-weight="600" fill="' + cssVar('--ink-2') + '">' +
             esc(opts.vlabel || String(opts.vline)) + '</text>');
    }

    // series paths — 2px lines per the mark spec
    for (k = 0; k < series.length; k++) {
      s = series[k];
      var d = '', open = false;
      for (i = 0; i < years.length; i++) {
        var v = s.values[i];
        if (!isFinite(v)) { open = false; continue; }
        d += (open ? 'L' : 'M') + X(years[i]).toFixed(1) + ' ' + Y(v).toFixed(1) + ' ';
        open = true;
      }
      if (!d) continue;
      g.push('<path d="' + d + '" fill="none" stroke="' + colors[k] +
             '" stroke-width="' + (s.width || 2) + '" stroke-linejoin="round" ' +
             'stroke-linecap="round" opacity="' + (s.opacity === undefined ? 1 : s.opacity) + '"' +
             (s.dash ? ' stroke-dasharray="' + s.dash + '"' : '') + '/>');
    }

    // direct labels at the right end (identity never carried by colour alone)
    if (opts.directLabels !== false) {
      var placed = [];
      var labelled = series.filter(function (sr) { return !sr.noLegend && sr.name; });
      for (k = labelled.length - 1; k >= 0; k--) {
        s = labelled[k];
        var ci = series.indexOf(s);
        var li = -1;
        for (i = years.length - 1; i >= 0; i--) { if (isFinite(s.values[i])) { li = i; break; } }
        if (li < 0) continue;
        var ly = Y(s.values[li]);
        for (var p = 0; p < placed.length; p++) {
          if (Math.abs(placed[p] - ly) < 12) ly = placed[p] + (ly >= placed[p] ? 12 : -12);
        }
        ly = Math.max(padT + 8, Math.min(padT + ih, ly));
        placed.push(ly);
        g.push('<text x="' + (padL + iw + 8) + '" y="' + (ly + 3.5).toFixed(1) +
               '" font-size="11" font-weight="600" fill="' + colors[ci] + '">' +
               esc(s.label || s.name) + '</text>');
      }
    }

    // hover layer
    g.push('<g class="xh" style="display:none">' +
           '<line y1="' + padT + '" y2="' + (padT + ih) + '" stroke="' + cssVar('--ink-2') +
           '" stroke-width="1" opacity=".55"/></g>');
    g.push('<rect class="hit" x="' + padL + '" y="' + padT + '" width="' + iw +
           '" height="' + ih + '" fill="transparent" style="cursor:crosshair"/>');
    g.push('</svg>');

    host.innerHTML = g.join('');
    var tip = document.createElement('div');
    tip.className = 'tip';
    host.appendChild(tip);

    var svg = host.querySelector('svg');
    var xh = svg.querySelector('.xh');
    var hit = svg.querySelector('.hit');
    var line = xh.querySelector('line');

    function onMove(ev) {
      var r = svg.getBoundingClientRect();
      var px = (ev.clientX - r.left) / r.width * W;
      var frac = (px - padL) / iw;
      var idx = Math.round(frac * (years.length - 1));
      idx = Math.max(0, Math.min(years.length - 1, idx));
      var yr = years[idx], vx = X(yr);
      line.setAttribute('x1', vx); line.setAttribute('x2', vx);
      xh.style.display = '';
      var html = '<div class="tip-h">' + yr + '</div>';
      for (var j = 0; j < series.length; j++) {
        if (series[j].noLegend) continue;
        var val = series[j].values[idx];
        html += '<div class="tip-r"><span class="sw" style="background:' + colors[j] +
                '"></span><span class="lbl">' + esc(series[j].name) +
                '</span><span class="val">' + fmt(val, opts.tipDp === undefined ? 2 : opts.tipDp) +
                '</span></div>';
      }
      tip.innerHTML = html;
      tip.classList.add('on');
      var hostR = host.getBoundingClientRect();
      var left = (vx / W) * hostR.width + 14;
      if (left + tip.offsetWidth > hostR.width - 4) left = (vx / W) * hostR.width - tip.offsetWidth - 14;
      tip.style.left = Math.max(2, left) + 'px';
      tip.style.top = Math.max(2, (ev.clientY - hostR.top) - tip.offsetHeight - 12) + 'px';
    }
    function onLeave() { xh.style.display = 'none'; tip.classList.remove('on'); }
    hit.addEventListener('mousemove', onMove);
    hit.addEventListener('mouseleave', onLeave);
    hit.addEventListener('touchmove', function (e) {
      if (e.touches[0]) { onMove(e.touches[0]); e.preventDefault(); }
    }, { passive: false });
    hit.addEventListener('touchend', onLeave);

    return { colors: colors };
  }

  /** Horizontal bars: rows of {label, value, color?, note?, highlight?}. */
  function barChart(host, opts) {
    var rows = opts.rows || [];
    var W = Math.max(300, host.clientWidth || 600);
    var rowH = opts.rowH || 22, gap = 5;
    var labelW = opts.labelW || 128, valW = 54;
    var H = rows.length * (rowH + gap) + 6;
    var iw = Math.max(40, W - labelW - valW - 10);
    var max = 0, min = 0, i;
    for (i = 0; i < rows.length; i++) {
      if (isFinite(rows[i].value)) {
        max = Math.max(max, rows[i].value);
        min = Math.min(min, rows[i].value);
      }
    }
    if (max === min) max = min + 1;
    var zero = min < 0 ? labelW + (-min / (max - min)) * iw : labelW;
    function wOf(v) { return Math.abs(v) / (max - min) * iw; }

    var g = ['<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' +
             esc(opts.title || 'bars') + '" preserveAspectRatio="none">'];
    if (opts.ref !== undefined && isFinite(opts.ref)) {
      var rx = labelW + ((opts.ref - min) / (max - min)) * iw;
      g.push('<line x1="' + rx.toFixed(1) + '" y1="0" x2="' + rx.toFixed(1) + '" y2="' + H +
             '" stroke="' + cssVar('--critical') + '" stroke-width="1.25" stroke-dasharray="3 3"/>');
    }
    for (i = 0; i < rows.length; i++) {
      var r = rows[i], y = i * (rowH + gap) + 2;
      var col = r.color || cssVar(r.highlight ? '--series-1' : '--grid');
      var bw = isFinite(r.value) ? wOf(r.value) : 0;
      var bx = r.value < 0 ? zero - bw : zero;
      g.push('<text x="' + (labelW - 8) + '" y="' + (y + rowH * 0.72).toFixed(1) +
             '" text-anchor="end" font-size="11.5" fill="' +
             cssVar(r.highlight ? '--ink-1' : '--ink-2') + '"' +
             (r.highlight ? ' font-weight="650"' : '') + '>' + esc(r.label) + '</text>');
      // 4px rounded data-end anchored to the baseline
      g.push('<rect x="' + bx.toFixed(1) + '" y="' + (y + 3) + '" width="' +
             Math.max(1.5, bw).toFixed(1) + '" height="' + (rowH - 6) +
             '" rx="3.5" fill="' + col + '"/>');
      g.push('<text x="' + (labelW + iw + 8) + '" y="' + (y + rowH * 0.72).toFixed(1) +
             '" font-size="11.5" fill="' + cssVar('--ink-1') +
             '" style="font-variant-numeric:tabular-nums"' +
             (r.highlight ? ' font-weight="650"' : '') + '>' +
             (r.note !== undefined ? esc(r.note) : fmt(r.value, opts.dp === undefined ? 2 : opts.dp)) +
             '</text>');
    }
    g.push('</svg>');
    host.innerHTML = g.join('');
  }

  /** Legend markup: items of {name, color, square?}. */
  function legend(items) {
    return '<div class="legend">' + items.map(function (it) {
      return '<span class="legend-item"><span class="sw' + (it.square ? ' sq' : '') +
             '" style="background:' + it.color + '"></span>' + esc(it.name) + '</span>';
    }).join('') + '</div>';
  }

  /** Table view — the relief for light-mode contrast and a screen-reader path. */
  function dataTable(years, series, dp) {
    var h = '<div class="table-scroll"><table class="data"><thead><tr><th>Year</th>';
    series.forEach(function (s) { h += '<th>' + esc(s.name) + '</th>'; });
    h += '</tr></thead><tbody>';
    for (var i = 0; i < years.length; i++) {
      h += '<tr><td>' + years[i] + '</td>';
      series.forEach(function (s) { h += '<td>' + fmt(s.values[i], dp === undefined ? 2 : dp) + '</td>'; });
      h += '</tr>';
    }
    return h + '</tbody></table></div>';
  }

  root.Charts = {
    lineChart: lineChart, barChart: barChart, legend: legend,
    dataTable: dataTable, cssVar: cssVar, fmt: fmt, esc: esc, SERIES: SERIES
  };
}(typeof self !== 'undefined' ? self : this));
