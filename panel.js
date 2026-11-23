/* The investigation panel: controls on the left, chart and readout on the right.
 *
 * The control DOM is built once and then only synced, so a student dragging a
 * slider is never interrupted by an incoming state update from a room-mate.
 * `locked` makes every input read-only — the visual half of the freeze; the
 * server enforces the real thing. */
(function (root) {
  'use strict';

  var C = root.Charts, MV = root.ModelView;

  var VIEWS = [
    { key: 'levels', label: 'Levels' },
    { key: 'gap', label: 'Gap' },
    { key: 'fuels', label: 'By fuel' },
    { key: 'electricity', label: 'Electricity mix' },
    { key: 'placeboSpace', label: 'Placebo: countries' },
    { key: 'placeboTime', label: 'Placebo: dates' },
    { key: 'loo', label: 'Leave one out' }
  ];
  var FAKE_YEARS = [2000, 2007, 2008, 2009];

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function Panel(host, opts) {
    this.host = host;
    this.bundle = opts.bundle;
    this.onChange = opts.onChange || function () {};
    this.showTable = false;
    this.built = false;
    this.model = null;
    this.locked = false;
    this.dragging = false;
    this.pending = null;
  }

  Panel.prototype.update = function (o) {
    this.model = o.model;
    this.locked = !!o.locked;
    this.lockReason = o.lockReason || '';
    if (!this.built) this.build();
    this.sync();
  };

  /* ------------------------------------------------------------- building */

  Panel.prototype.build = function () {
    var self = this, b = this.bundle;
    this.host.innerHTML = '';
    var cols = el('div', 'cols');

    /* ---- left: controls ---- */
    var left = el('div', 'stack');

    // View selector
    var viewCard = el('div', 'card pad');
    viewCard.appendChild(el('h4', null, 'What to show'));
    var vseg = el('div', 'seg wrapset');
    this.viewBtns = {};
    VIEWS.forEach(function (v) {
      var btn = el('button', null, v.label);
      btn.type = 'button';
      btn.addEventListener('click', function () { self.change({ view: v.key }, 'switched to the ' + v.label.toLowerCase() + ' view'); });
      self.viewBtns[v.key] = btn;
      vseg.appendChild(btn);
    });
    viewCard.appendChild(vseg);
    left.appendChild(viewCard);

    // Intervention year
    var yrCard = el('div', 'card pad');
    yrCard.appendChild(el('h4', null, 'Intervention year'));
    this.yrOut = el('div', 'num', '2011');
    this.yrOut.style.cssText = 'font-size:1.25rem;font-weight:650;margin-bottom:4px';
    yrCard.appendChild(this.yrOut);
    this.yrInput = document.createElement('input');
    this.yrInput.type = 'range';
    this.yrInput.min = '1992'; this.yrInput.max = '2021'; this.yrInput.step = '1';
    this.yrInput.addEventListener('input', function () {
      self.yrOut.textContent = self.yrInput.value;
      self.dragging = true;
      self.localPatch({ t0: parseInt(self.yrInput.value, 10) });
    });
    this.yrInput.addEventListener('change', function () {
      self.dragging = false;
      self.change({ t0: parseInt(self.yrInput.value, 10) },
                  'set the intervention year to ' + self.yrInput.value);
    });
    yrCard.appendChild(this.yrInput);
    yrCard.appendChild(el('div', 'tiny muted', 'The real phase-out began in 2011. Moving it earlier is a placebo test.'));
    left.appendChild(yrCard);

    // Donor countries
    var dCard = el('div', 'card pad');
    dCard.appendChild(el('h4', null, 'Donor countries'));
    dCard.appendChild(el('div', 'tiny muted', 'Who stands in for "Germany without the phase-out".'));
    var dChips = el('div', 'chips');
    dChips.style.marginTop = '8px';
    this.donorChips = {};
    b.donors.forEach(function (d) {
      var lab = el('label', 'chip');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(d));
      cb.addEventListener('change', function () {
        var cur = self.model.donors.slice();
        if (cb.checked) { if (cur.indexOf(d) < 0) cur.push(d); }
        else cur = cur.filter(function (x) { return x !== d; });
        if (!cur.length) { cb.checked = true; return; }
        self.change({ donors: cur },
                    (cb.checked ? 'added ' : 'removed ') + d + (cb.checked ? ' to' : ' from') + ' the donor pool');
      });
      self.donorChips[d] = { label: lab, cb: cb };
      dChips.appendChild(lab);
    });
    dCard.appendChild(dChips);
    var dRow = el('div', 'row-wrap');
    dRow.style.marginTop = '10px';
    var allBtn = el('button', 'sm ghost', 'All 11');
    allBtn.type = 'button';
    allBtn.addEventListener('click', function () {
      self.change({ donors: b.donors.slice() }, 'restored the full donor pool');
    });
    var paperBtn = el('button', 'sm ghost', 'Only the 5 with weight');
    paperBtn.type = 'button';
    paperBtn.addEventListener('click', function () {
      self.change({ donors: Object.keys(b.publishedWeights) },
                  'kept only the five donors with non-zero weight');
    });
    dRow.appendChild(allBtn); dRow.appendChild(paperBtn);
    dCard.appendChild(dRow);
    left.appendChild(dCard);

    // Predictor weights
    var pCard = el('div', 'card pad');
    pCard.appendChild(el('h4', null, 'Predictor weights'));
    var modeSeg = el('div', 'seg wrapset');
    this.modeBtns = {};
    [['published', 'Paper'], ['manual', 'Set by hand'], ['optimised', 'Let the data choose']]
      .forEach(function (m) {
        var btn = el('button', null, m[1]);
        btn.type = 'button';
        btn.addEventListener('click', function () {
          if (m[0] === 'optimised') self.setBusy(true);
          self.change({ weightMode: m[0] }, 'switched predictor weights to "' + m[1] + '"');
        });
        self.modeBtns[m[0]] = btn;
        modeSeg.appendChild(btn);
      });
    pCard.appendChild(modeSeg);
    this.modeNote = el('div', 'tiny muted');
    this.modeNote.style.marginTop = '6px';
    pCard.appendChild(this.modeNote);

    this.sliderWrap = el('div');
    this.sliderWrap.style.marginTop = '10px';
    this.sliders = {};
    pCard.appendChild(this.sliderWrap);
    left.appendChild(pCard);

    // Which characteristics to match
    var mCard = el('div', 'card pad');
    mCard.appendChild(el('h4', null, 'Characteristics to match'));
    var mChips = el('div', 'chips');
    this.predChips = {};
    b.meanPredictors.forEach(function (p) {
      var lab = el('label', 'chip');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(MV.labelOf(p)));
      cb.addEventListener('change', function () {
        var cur = self.model.predictors.slice();
        if (cb.checked) { if (cur.indexOf(p) < 0) cur.push(p); }
        else cur = cur.filter(function (x) { return x !== p; });
        if (!cur.length && !self.model.lagYears.length) { cb.checked = true; return; }
        self.change({ predictors: cur },
                    (cb.checked ? 'matched on ' : 'stopped matching on ') + MV.labelOf(p));
      });
      self.predChips[p] = { label: lab, cb: cb };
      mChips.appendChild(lab);
    });
    mCard.appendChild(mChips);
    mCard.appendChild(el('div', 'tiny muted', 'Past emissions, included as separate predictors:'));
    var lChips = el('div', 'chips');
    this.lagChips = {};
    b.lagYears.forEach(function (y) {
      var lab = el('label', 'chip');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(String(y)));
      cb.addEventListener('change', function () {
        var cur = self.model.lagYears.slice();
        if (cb.checked) { if (cur.indexOf(y) < 0) cur.push(y); }
        else cur = cur.filter(function (x) { return x !== y; });
        if (!cur.length && !self.model.predictors.length) { cb.checked = true; return; }
        self.change({ lagYears: cur.sort(function (a, c) { return a - c; }) },
                    (cb.checked ? 'added ' : 'removed ') + 'emissions in ' + y);
      });
      self.lagChips[y] = { label: lab, cb: cb };
      lChips.appendChild(lab);
    });
    mCard.appendChild(lChips);
    left.appendChild(mCard);

    /* ---- right: chart and readout ---- */
    var right = el('div', 'stack');

    var chartCard = el('div', 'card pad');
    var ch = el('div', 'spread');
    this.chartTitle = el('h3', null, '');
    ch.appendChild(this.chartTitle);
    var tblBtn = el('button', 'sm ghost always', 'Show data');
    tblBtn.type = 'button';
    tblBtn.addEventListener('click', function () {
      self.showTable = !self.showTable;
      tblBtn.textContent = self.showTable ? 'Hide data' : 'Show data';
      self.renderChart();
    });
    ch.appendChild(tblBtn);
    chartCard.appendChild(ch);
    this.chartSub = el('div', 'small secondary');
    this.chartSub.style.margin = '2px 0 10px';
    chartCard.appendChild(this.chartSub);
    this.chartArea = el('div');
    chartCard.appendChild(this.chartArea);
    this.legendArea = el('div');
    chartCard.appendChild(this.legendArea);
    this.tableArea = el('div');
    this.tableArea.style.marginTop = '12px';
    chartCard.appendChild(this.tableArea);
    right.appendChild(chartCard);

    var statCard = el('div', 'card pad');
    this.statArea = el('div', 'stat-row');
    statCard.appendChild(this.statArea);
    right.appendChild(statCard);

    var wCard = el('div', 'card pad');
    wCard.appendChild(el('h4', null, 'Synthetic Germany is made of'));
    this.weightArea = el('div');
    wCard.appendChild(this.weightArea);
    right.appendChild(wCard);

    cols.appendChild(left);
    cols.appendChild(right);
    this.host.appendChild(cols);
    this.leftCol = left;
    this.built = true;

    var redraw = function () { if (self.model) self.renderChart(); };
    if (!Panel._resizeBound) {
      Panel._resizeBound = [];
      window.addEventListener('resize', function () {
        Panel._resizeBound.forEach(function (f) { f(); });
      });
    }
    Panel._resizeBound.push(redraw);
  };

  /* ------------------------------------------------------------- plumbing */

  Panel.prototype.setBusy = function (on) {
    this.busy = on;
    if (this.chartSub) {
      this.chartSub.textContent = on ? 'Recalculating…' : this.chartSub.textContent;
    }
  };

  /** A control moved: update locally for responsiveness, then tell the server. */
  Panel.prototype.change = function (patch, label) {
    if (this.locked) return;
    this.localPatch(patch);
    this.onChange(patch, label);
  };
  Panel.prototype.localPatch = function (patch) {
    this.model = Object.assign({}, this.model, patch);
    this.sync();
  };

  /* ------------------------------------------------------------- syncing */

  Panel.prototype.sync = function () {
    var self = this, m = this.model, b = this.bundle;
    if (!m) return;

    Object.keys(this.viewBtns).forEach(function (k) {
      self.viewBtns[k].classList.toggle('on', m.view === k);
    });
    Object.keys(this.modeBtns).forEach(function (k) {
      self.modeBtns[k].classList.toggle('on', m.weightMode === k);
    });
    if (!this.dragging) {
      this.yrInput.value = String(m.t0);
      this.yrOut.textContent = String(m.t0);
    }
    b.donors.forEach(function (d) {
      var c = self.donorChips[d];
      c.cb.checked = m.donors.indexOf(d) >= 0;
      c.label.classList.toggle('sel', c.cb.checked);
      c.cb.disabled = self.locked;
      c.label.classList.toggle('locked', self.locked);
    });
    b.meanPredictors.forEach(function (p) {
      var c = self.predChips[p];
      c.cb.checked = m.predictors.indexOf(p) >= 0;
      c.label.classList.toggle('sel', c.cb.checked);
      c.cb.disabled = self.locked;
      c.label.classList.toggle('locked', self.locked);
    });
    b.lagYears.forEach(function (y) {
      var c = self.lagChips[y];
      c.cb.checked = m.lagYears.indexOf(y) >= 0;
      c.label.classList.toggle('sel', c.cb.checked);
      c.cb.disabled = self.locked;
      c.label.classList.toggle('locked', self.locked);
    });
    this.yrInput.disabled = this.locked;
    Object.keys(this.viewBtns).forEach(function (k) { self.viewBtns[k].disabled = false; });
    Object.keys(this.modeBtns).forEach(function (k) { self.modeBtns[k].disabled = self.locked; });

    var full = m.donors.length === b.donors.length && m.t0 === b.defaultT0;
    this.modeNote.textContent =
      m.weightMode === 'published'
        ? (full ? 'The donor weights published in the paper (Czechia 51.7%, Netherlands 31.2%, France 10.9%, Sweden 4.8%, Spain 1.4%).'
                : 'The published weights only apply to the full pool in 2011 — showing hand-set weights instead.')
        : m.weightMode === 'manual'
          ? 'You decide how much each characteristic counts. The country weights follow.'
          : 'The method picks the importances that fit Germany best before the intervention.';

    this.syncSliders();
    this.renderChart();
  };

  Panel.prototype.syncSliders = function () {
    var self = this, m = this.model;
    var show = m.weightMode === 'manual';
    this.sliderWrap.style.display = show ? '' : 'none';
    if (!show) return;

    var view = MV.compute(this.bundle, m);
    var labels = view.design.labels;
    var sig = labels.join('|');
    if (this.sliderSig !== sig) {
      this.sliderSig = sig;
      this.sliderWrap.innerHTML = '';
      this.sliders = {};
      labels.forEach(function (lab) {
        var wrap = el('div');
        wrap.style.marginBottom = '7px';
        var head = el('div', 'tiny');
        head.style.cssText = 'display:flex;justify-content:space-between;gap:8px';
        var name = el('span', null, C.esc(MV.labelOf(lab)));
        var val = el('span', 'num muted', '');
        head.appendChild(name); head.appendChild(val);
        var inp = document.createElement('input');
        inp.type = 'range'; inp.min = '0'; inp.max = '100'; inp.step = '1';
        inp.addEventListener('input', function () {
          self.dragging = true;
          val.textContent = inp.value;
          var v = Object.assign({}, self.model.v);
          v[lab] = parseInt(inp.value, 10) / 100;
          self.localPatch({ v: v });
          clearTimeout(self.sendTimer);
          self.sendTimer = setTimeout(function () {
            self.onChange({ v: v }, 'changed the weight on ' + MV.labelOf(lab));
          }, 180);
        });
        inp.addEventListener('change', function () { self.dragging = false; });
        wrap.appendChild(head); wrap.appendChild(inp);
        self.sliderWrap.appendChild(wrap);
        self.sliders[lab] = { input: inp, val: val };
      });
      var reset = el('button', 'sm ghost', 'Reset to equal');
      reset.type = 'button';
      reset.addEventListener('click', function () {
        var v = {};
        labels.forEach(function (l) { v[l] = 0.5; });
        self.change({ v: v }, 'reset the predictor weights to equal');
      });
      this.sliderWrap.appendChild(reset);
    }
    labels.forEach(function (lab) {
      var s = self.sliders[lab];
      if (!s) return;
      var x = m.v && m.v[lab] !== undefined ? Number(m.v[lab]) : 1;
      if (!self.dragging) s.input.value = String(Math.round(Math.max(0, Math.min(1, x)) * 100));
      s.val.textContent = s.input.value;
      s.input.disabled = self.locked;
    });
  };

  /* --------------------------------------------------------------- charts */

  Panel.prototype.renderChart = function () {
    var self = this, m = this.model, b = this.bundle;
    if (!m) return;
    var view;
    try { view = MV.compute(b, m); }
    catch (e) {
      this.chartArea.innerHTML = '<div class="notice bad"><span class="ic">!</span>' +
        '<div>That combination could not be solved. Put a predictor or a donor back.</div></div>';
      return;
    }
    this.busy = false;
    this.view = view;
    var years = b.years;
    var host = el('div', 'chart-host');
    this.chartArea.innerHTML = '';
    this.chartArea.appendChild(host);
    this.tableArea.innerHTML = '';
    this.legendArea.innerHTML = '';

    var c1 = C.cssVar('--series-1'), c2 = C.cssVar('--series-2');
    var muted = C.cssVar('--ink-muted');

    if (m.view === 'levels' || m.view === 'gap') {
      var isGap = m.view === 'gap';
      var series = isGap
        ? [{ name: 'Germany − synthetic Germany', values: view.gap, color: c1, label: 'Gap' }]
        : [{ name: 'Germany', values: view.observed, color: c1 },
           { name: 'Synthetic Germany', values: view.synthetic, color: c2 }];
      this.chartTitle.textContent = isGap
        ? 'Gap in CO₂ from fossil fuels, tonnes per person'
        : 'CO₂ from fossil fuels, tonnes per person';
      this.chartSub.textContent = isGap
        ? 'Above zero means Germany emitted more than its synthetic counterpart.'
        : 'The shaded band is ±1 standard deviation of the pre-intervention difference.';
      var band = isGap
        ? { lo: years.map(function () { return -view.bandSd; }),
            hi: years.map(function () { return view.bandSd; }), color: c2 }
        : { lo: view.band.lo, hi: view.band.hi, color: c2 };
      C.lineChart(host, {
        years: years, series: series, band: band, vline: m.t0,
        vlabel: String(m.t0), zeroLine: isGap, height: 350, yDp: isGap ? 1 : 0
      });
      this.legendArea.innerHTML = C.legend(
        series.map(function (s) { return { name: s.name, color: s.color }; })
          .concat([{ name: '±1 SD of pre-' + m.t0 + ' difference', color: c2, square: true }]));
      if (this.showTable) this.tableArea.innerHTML = C.dataTable(years, series, 2);

    } else if (m.view === 'fuels') {
      var fuels = [
        { key: 'co2pc_fossil', name: 'All fossil fuels', color: c1 },
        { key: 'coal_co2pc', name: 'Coal', color: c2 },
        { key: 'gas_co2pc', name: 'Gas', color: C.cssVar('--series-3') },
        { key: 'oil_co2pc', name: 'Oil', color: C.cssVar('--series-4') }
      ].map(function (f) {
        return { name: f.name, color: f.color, values: MV.gapFor(b, view, f.key) };
      });
      this.chartTitle.textContent = 'Gap by fuel, tonnes of CO₂ per person';
      this.chartSub.textContent = 'Germany minus synthetic Germany, split by fuel. ' +
        'This is the paper\'s Figure 2.';
      C.lineChart(host, {
        years: years, series: fuels, vline: m.t0, vlabel: String(m.t0),
        zeroLine: true, height: 350, yDp: 1
      });
      this.legendArea.innerHTML = C.legend(fuels.map(function (s) {
        return { name: s.name, color: s.color };
      }));
      if (this.showTable) this.tableArea.innerHTML = C.dataTable(years, fuels, 2);

    } else if (m.view === 'electricity') {
      var elec = [
        { key: 'nuc_elpc', name: 'Nuclear', color: c1 },
        { key: 'coal_elpc', name: 'Coal', color: c2 },
        { key: 'gas_elpc', name: 'Gas', color: C.cssVar('--series-3') },
        { key: 'oil_elpc', name: 'Oil', color: C.cssVar('--series-4') },
        { key: 'res_elpc', name: 'Renewables', color: C.cssVar('--series-5') }
      ].map(function (f) {
        return { name: f.name, color: f.color, values: MV.gapFor(b, view, f.key) };
      });
      this.chartTitle.textContent = 'Gap in electricity generated, kWh per person';
      this.chartSub.textContent = 'Germany minus synthetic Germany, by source. ' +
        'This is the paper\'s Figure 3 — watch renewables against nuclear.';
      C.lineChart(host, {
        years: years, series: elec, vline: m.t0, vlabel: String(m.t0),
        zeroLine: true, height: 350, yDp: 0, tipDp: 0
      });
      this.legendArea.innerHTML = C.legend(elec.map(function (s) {
        return { name: s.name, color: s.color };
      }));
      if (this.showTable) this.tableArea.innerHTML = C.dataTable(years, elec, 0);

    } else if (m.view === 'placeboSpace') {
      this.chartTitle.textContent = 'Placebo test: pretend each country was treated';
      this.chartSub.textContent = 'Computing…';
      host.innerHTML = '<div class="muted small" style="padding:40px 0;text-align:center">' +
                       'Running the model once for every country…</div>';
      MV.placeboSpace(b, m, function (res) {
        if (MV.modelKey(self.model) !== MV.modelKey(m) || self.model.view !== 'placeboSpace') return;
        self.chartSub.textContent = 'A high ratio of post- to pre-intervention error means the ' +
          'country diverged from its own synthetic version. Germany should stand out.';
        host.innerHTML = '';
        var rows = res.map(function (r) {
          return {
            label: r.unit, value: isFinite(r.ratio) ? r.ratio : 0,
            note: isFinite(r.ratio) ? r.ratio.toFixed(2) : '—',
            highlight: r.unit === b.treated
          };
        });
        C.barChart(host, { rows: rows, title: 'RMSPE ratio', dp: 2, labelW: 130 });
        self.legendArea.innerHTML = '<div class="legend"><span class="legend-item">' +
          '<span class="sw sq" style="background:' + c1 + '"></span>Germany</span>' +
          '<span class="legend-item"><span class="sw sq" style="background:' +
          C.cssVar('--grid') + '"></span>Donor countries treated as placebos</span></div>';
        var rank = res.findIndex(function (r) { return r.unit === b.treated; }) + 1;
        self.tableArea.innerHTML =
          '<div class="notice ' + (rank === 1 ? 'info' : 'warn') + '"><span class="ic">' +
          (rank === 1 ? '✓' : '!') + '</span><div>Germany ranks <strong>' + rank +
          ' of ' + res.length + '</strong>. ' +
          (rank === 1
            ? 'No donor country shows a bigger post-intervention divergence, so the result is unlikely to be chance.'
            : 'At least one donor country diverges more than Germany, which weakens the inference.') +
          '</div></div>';
      });

    } else if (m.view === 'placeboTime') {
      this.chartTitle.textContent = 'Placebo test: pretend the policy came earlier';
      this.chartSub.textContent = 'Computing…';
      host.innerHTML = '<div class="muted small" style="padding:40px 0;text-align:center">' +
                       'Refitting for four earlier dates…</div>';
      MV.placeboTime(b, m, FAKE_YEARS, function (res) {
        if (MV.modelKey(self.model) !== MV.modelKey(m) || self.model.view !== 'placeboTime') return;
        self.chartSub.textContent = 'If the 2011 result were really there all along, these ' +
          'earlier dates would show the same jump. They should not.';
        host.remove();
        var grid = el('div');
        grid.style.cssText = 'display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))';
        res.forEach(function (r) {
          var cell = el('div');
          cell.appendChild(el('div', 'small', '<strong>Fake intervention in ' + r.year +
            '</strong> <span class="muted num">pre-RMSPE ' + r.stats.rmspePre.toFixed(3) + '</span>'));
          var h2 = el('div', 'chart-host');
          cell.appendChild(h2);
          grid.appendChild(cell);
          var sub = b.years.filter(function (y) { return y <= 2011; });
          var n = sub.length;
          C.lineChart(h2, {
            years: sub,
            series: [{ name: 'Germany', values: r.observed.slice(0, n), color: c1 },
                     { name: 'Synthetic', values: r.synthetic.slice(0, n), color: c2 }],
            band: { lo: r.band.lo.slice(0, n), hi: r.band.hi.slice(0, n), color: c2 },
            vline: r.year, vlabel: String(r.year), height: 190, yDp: 0,
            directLabels: false
          });
        });
        self.chartArea.appendChild(grid);
        self.legendArea.innerHTML = C.legend([
          { name: 'Germany', color: c1 }, { name: 'Synthetic Germany', color: c2 }]);
      });

    } else if (m.view === 'loo') {
      this.chartTitle.textContent = 'Leave one out: drop each donor in turn';
      this.chartSub.textContent = 'Computing…';
      host.innerHTML = '<div class="muted small" style="padding:40px 0;text-align:center">' +
                       'Refitting without each donor…</div>';
      MV.leaveOneOut(b, m, function (res) {
        if (MV.modelKey(self.model) !== MV.modelKey(m) || self.model.view !== 'loo') return;
        self.chartSub.textContent = 'Each grey line is the gap with one donor country removed. ' +
          'If they stay close to the blue line, no single country is driving the result.';
        host.innerHTML = '';
        var series = res.map(function (r) {
          return {
            name: 'without ' + r.dropped, values: r.gap, color: muted,
            width: 1.25, opacity: 0.6, noLegend: true
          };
        });
        series.push({ name: 'All donors', values: view.gap, color: c1, width: 2.5 });
        C.lineChart(host, {
          years: years, series: series, vline: m.t0, vlabel: String(m.t0),
          zeroLine: true, height: 350, yDp: 1, directLabels: false
        });
        self.legendArea.innerHTML = C.legend([
          { name: 'All donors included', color: c1 },
          { name: 'One donor dropped (each line)', color: muted }]);
        var worst = res.slice().sort(function (a, c2x) {
          return c2x.stats.rmspePre - a.stats.rmspePre;
        })[0];
        self.tableArea.innerHTML =
          '<div class="notice ' + (worst.stats.rmspePre > view.stats.rmspePre * 1.75 ? 'warn' : 'info') +
          '"><span class="ic">' + (worst.stats.rmspePre > view.stats.rmspePre * 1.75 ? '!' : '✓') +
          '</span><div>Dropping <strong>' + C.esc(worst.dropped) +
          '</strong> hurts the pre-intervention fit most: RMSPE ' +
          view.stats.rmspePre.toFixed(3) + ' → <strong>' + worst.stats.rmspePre.toFixed(3) +
          '</strong>, and the placebo ratio moves to ' + worst.stats.ratio.toFixed(2) + '.</div></div>' +
          '<div class="table-scroll" style="margin-top:10px"><table class="data"><thead><tr>' +
          '<th>Donor dropped</th><th>pre-RMSPE</th><th>post-RMSPE</th><th>ratio</th></tr></thead><tbody>' +
          res.map(function (r) {
            return '<tr><td>' + C.esc(r.dropped) + '</td><td>' + r.stats.rmspePre.toFixed(3) +
                   '</td><td>' + r.stats.rmspePost.toFixed(3) + '</td><td>' +
                   r.stats.ratio.toFixed(2) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      });
    }

    this.renderStats(view);
    this.renderWeights(view);
  };

  Panel.prototype.renderStats = function (view) {
    var e = view.effect, s = view.stats;
    function stat(k, v, cls) {
      return '<div class="stat"><div class="k">' + k + '</div><div class="v ' +
             (cls || '') + '">' + v + '</div></div>';
    }
    var fitQuality = s.rmspePre < 0.25 ? 'close' : s.rmspePre < 0.5 ? 'fair' : 'poor';
    this.statArea.innerHTML =
      stat('Pre-' + view.t0 + ' fit (RMSPE)', s.rmspePre.toFixed(3) +
           ' <span class="small muted">' + fitQuality + '</span>') +
      stat('Mean gap, first 7 yrs', (e.shortRun >= 0 ? '+' : '') + e.shortRun.toFixed(2)) +
      stat('Mean gap, whole period', (e.fullPeriod >= 0 ? '+' : '') + e.fullPeriod.toFixed(2)) +
      stat('Largest gap', e.peak ? ((e.peak.value >= 0 ? '+' : '') + e.peak.value.toFixed(2) +
           ' <span class="small muted">in ' + e.peak.year + '</span>') : '—') +
      stat('Gap in 2023', (e.latest >= 0 ? '+' : '') + e.latest.toFixed(2)) +
      stat('Placebo ratio', s.ratio.toFixed(2), 'sm');
  };

  Panel.prototype.renderWeights = function (view) {
    var rows = view.weights.filter(function (w) { return w.weight > 0.0005; });
    var zero = view.weights.length - rows.length;
    var max = rows.length ? rows[0].weight : 1;
    this.weightArea.innerHTML =
      rows.map(function (w) {
        return '<div style="margin-bottom:7px"><div class="spread small" style="margin-bottom:3px">' +
               '<span>' + Charts.esc(w.donor) + '</span><span class="num">' +
               (w.weight * 100).toFixed(1) + '%</span></div>' +
               '<div class="wbar"><span style="width:' + (w.weight / max * 100).toFixed(1) +
               '%"></span></div></div>';
      }).join('') +
      (zero ? '<div class="tiny muted" style="margin-top:6px">' + zero +
              ' other donor' + (zero === 1 ? '' : 's') + ' received zero weight.</div>' : '');
  };

  root.Panel = Panel;
  root.PANEL_VIEWS = VIEWS;
}(typeof self !== 'undefined' ? self : this));
