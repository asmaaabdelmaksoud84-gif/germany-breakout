/* The left-hand column of a stage: the controls that stage needs, the chart,
 * the headline numbers, and what synthetic Germany is made of.
 *
 * Each stage asks for a different, small set of controls, so a student is never
 * shown eleven things to fiddle with when the stage is about one of them. The
 * control DOM is built once and then only synced, so a student dragging a
 * slider is never interrupted by an incoming update from a room-mate.
 * `locked` makes every input read-only -- the visual half of the freeze; the
 * server enforces the real thing. */
(function (root) {
  'use strict';

  var C = root.Charts, MV = root.ModelView;

  var VIEW_LABELS = {
    levels: 'Levels', gap: 'Gap', fuels: 'By fuel', electricity: 'Electricity mix',
    placeboSpace: 'Placebo: countries', placeboTime: 'Placebo: dates',
    loo: 'Leave one out'
  };
  var FAKE_YEARS = [2000, 2007, 2008, 2009];
  var ALL_VIEWS = ['levels', 'gap', 'fuels', 'electricity',
                   'placeboSpace', 'placeboTime', 'loo'];

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
    this.controls = { views: ALL_VIEWS, show: [] };
  }

  Panel.prototype.update = function (o) {
    this.model = o.model;
    this.locked = !!o.locked;
    if (o.controls) this.controls = o.controls;
    this.stageKey = o.stageKey;
    if (!this.built) this.build();
    this.sync();
  };

  Panel.prototype.can = function (name) {
    return (this.controls.show || []).indexOf(name) >= 0;
  };

  /* ------------------------------------------------------------- building */

  Panel.prototype.build = function () {
    var self = this, b = this.bundle;
    this.host.innerHTML = '';

    // ---- control strip (stage-specific) ----
    this.controlCard = el('div', 'card pad control-strip');
    this.host.appendChild(this.controlCard);

    // drop-a-donor row
    this.dropRow = el('div', 'ctl-row');
    this.dropRow.appendChild(el('span', 'ctl-label', 'Drop'));
    this.dropBtns = {};
    var noneBtn = el('button', 'opt', 'None (published)');
    noneBtn.type = 'button';
    noneBtn.addEventListener('click', function () {
      self.change({ donors: b.donors.slice() }, 'restored the full donor pool');
    });
    this.dropBtns['__none__'] = noneBtn;
    this.dropRow.appendChild(noneBtn);
    b.donors.forEach(function (d) {
      var btn = el('button', 'opt', d);
      btn.type = 'button';
      btn.addEventListener('click', function () {
        var dropped = self.model.donors.indexOf(d) < 0;
        if (dropped) self.change({ donors: b.donors.slice() }, 'put ' + d + ' back');
        else self.change({ donors: b.donors.filter(function (x) { return x !== d; }) },
                         'dropped ' + d + ' from the donor pool');
      });
      self.dropBtns[d] = btn;
      self.dropRow.appendChild(btn);
    });
    this.controlCard.appendChild(this.dropRow);

    // intervention year row
    this.yearRow = el('div', 'ctl-row');
    this.yearRow.appendChild(el('span', 'ctl-label', 'Intervention year'));
    this.yearBtns = {};
    [2011, 2009, 2008, 2007, 2000].forEach(function (y) {
      var btn = el('button', 'opt', y === 2011 ? '2011 (actual)' : String(y));
      btn.type = 'button';
      btn.addEventListener('click', function () {
        self.change({ t0: y }, 'set the intervention year to ' + y);
      });
      self.yearBtns[y] = btn;
      self.yearRow.appendChild(btn);
    });
    this.controlCard.appendChild(this.yearRow);

    // predictor weights
    this.weightRow = el('div');
    var wHead = el('div', 'ctl-row');
    wHead.appendChild(el('span', 'ctl-label', 'Predictor weights (V)'));
    this.modeBtns = {};
    [['published', 'As published'], ['manual', 'Set by hand'],
     ['optimised', 'Let the data choose']].forEach(function (m) {
      var btn = el('button', 'opt', m[1]);
      btn.type = 'button';
      btn.addEventListener('click', function () {
        self.change({ weightMode: m[0] }, 'switched predictor weights to "' + m[1] + '"');
      });
      self.modeBtns[m[0]] = btn;
      wHead.appendChild(btn);
    });
    this.weightRow.appendChild(wHead);
    this.modeNote = el('div', 'tiny muted');
    this.weightRow.appendChild(this.modeNote);
    this.sliderWrap = el('div', 'slider-grid');
    this.sliders = {};
    this.weightRow.appendChild(this.sliderWrap);
    this.controlCard.appendChild(this.weightRow);

    // characteristics to match on
    this.predRow = el('details', 'adv');
    var sum = document.createElement('summary');
    sum.textContent = 'Which characteristics to match on';
    this.predRow.appendChild(sum);
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
    this.predRow.appendChild(mChips);
    this.predRow.appendChild(el('div', 'tiny muted',
      'Past emissions, used as extra predictors:'));
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
    this.predRow.appendChild(lChips);
    this.controlCard.appendChild(this.predRow);

    // ---- chart ----
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

    this.viewRow = el('div', 'ctl-row');
    this.viewBtns = {};
    ALL_VIEWS.forEach(function (v) {
      var btn = el('button', 'opt', VIEW_LABELS[v]);
      btn.type = 'button';
      btn.addEventListener('click', function () {
        self.change({ view: v }, 'switched to the ' + VIEW_LABELS[v].toLowerCase() + ' view');
      });
      self.viewBtns[v] = btn;
      self.viewRow.appendChild(btn);
    });
    chartCard.appendChild(this.viewRow);

    this.chartSub = el('div', 'small secondary');
    this.chartSub.style.margin = '6px 0 10px';
    chartCard.appendChild(this.chartSub);
    this.chartArea = el('div');
    chartCard.appendChild(this.chartArea);
    this.legendArea = el('div');
    chartCard.appendChild(this.legendArea);
    this.tableArea = el('div');
    this.tableArea.style.marginTop = '12px';
    chartCard.appendChild(this.tableArea);
    this.host.appendChild(chartCard);

    // ---- headline numbers ----
    this.statWrap = el('div', 'stat-cards');
    this.host.appendChild(this.statWrap);

    // ---- what synthetic Germany is made of ----
    var wCard = el('div', 'card pad');
    wCard.appendChild(el('h4', null, 'What synthetic Germany is made of'));
    this.weightArea = el('div');
    wCard.appendChild(this.weightArea);
    this.weightNote = el('div', 'tiny muted');
    wCard.appendChild(this.weightNote);
    this.host.appendChild(wCard);

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
    var views = this.controls.views || ALL_VIEWS;

    // Only the views this stage offers
    ALL_VIEWS.forEach(function (v) {
      var on = views.indexOf(v) >= 0;
      self.viewBtns[v].style.display = on ? '' : 'none';
      self.viewBtns[v].classList.toggle('on', m.view === v);
    });
    this.viewRow.style.display = views.length > 1 ? '' : 'none';

    this.dropRow.style.display = this.can('dropDonor') ? '' : 'none';
    this.yearRow.style.display = this.can('t0') ? '' : 'none';
    this.weightRow.style.display = this.can('weights') ? '' : 'none';
    this.predRow.style.display = this.can('predictors') ? '' : 'none';
    this.controlCard.style.display =
      (this.can('dropDonor') || this.can('t0') || this.can('weights') ||
       this.can('predictors')) ? '' : 'none';

    // drop buttons: which donor is currently out
    var missing = b.donors.filter(function (d) { return m.donors.indexOf(d) < 0; });
    this.dropBtns['__none__'].classList.toggle('on', missing.length === 0);
    this.dropBtns['__none__'].disabled = this.locked;
    b.donors.forEach(function (d) {
      var out = m.donors.indexOf(d) < 0;
      self.dropBtns[d].classList.toggle('on', out);
      self.dropBtns[d].disabled = self.locked;
    });

    Object.keys(this.yearBtns).forEach(function (y) {
      self.yearBtns[y].classList.toggle('on', String(m.t0) === y);
      self.yearBtns[y].disabled = self.locked;
    });
    Object.keys(this.modeBtns).forEach(function (k) {
      self.modeBtns[k].classList.toggle('on', m.weightMode === k);
      self.modeBtns[k].disabled = self.locked;
    });
    Object.keys(this.viewBtns).forEach(function (k) {
      self.viewBtns[k].disabled = false;
    });

    b.meanPredictors.forEach(function (p) {
      var c = self.predChips[p];
      c.cb.checked = m.predictors.indexOf(p) >= 0;
      c.label.classList.toggle('sel', c.cb.checked);
      c.cb.disabled = self.locked;
    });
    b.lagYears.forEach(function (y) {
      var c = self.lagChips[y];
      c.cb.checked = m.lagYears.indexOf(y) >= 0;
      c.label.classList.toggle('sel', c.cb.checked);
      c.cb.disabled = self.locked;
    });

    var full = m.donors.length === b.donors.length && m.t0 === b.defaultT0;
    this.modeNote.textContent =
      m.weightMode === 'published'
        ? (full ? 'The donor weights the paper printed.'
                : 'The published weights only apply to the full pool in 2011, so these ' +
                  'are hand-set weights instead.')
        : m.weightMode === 'manual'
          ? 'You decide how much each characteristic counts. The country weights follow.'
          : 'The method searches for the weights that fit Germany best before the ' +
            'intervention.';

    this.syncSliders();
    this.renderChart();
  };

  Panel.prototype.syncSliders = function () {
    var self = this, m = this.model;
    var show = this.can('weights') && m.weightMode === 'manual';
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
        var wrap = el('div', 'slider-row');
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

    /* A first solve of a model blocks the thread for a second or two. Paint a
       message and hand the browser a frame before starting, so the page never
       looks dead. Once solved the result is cached and this is skipped. */
    var heavy = !MV.isCached(m) && (m.weightMode === 'optimised' ||
      m.view === 'placeboSpace' || m.view === 'placeboTime' || m.view === 'loo');
    if (this._pendingHeavy) {
      this._pendingHeavy = false;
    } else if (heavy) {
      this._pendingHeavy = true;
      this.chartSub.textContent = 'Recalculating…';
      this.chartArea.innerHTML = '<div class="muted small" style="padding:46px 0;' +
        'text-align:center">Working out the best fit… this takes a moment.</div>';
      this.legendArea.innerHTML = '';
      this.tableArea.innerHTML = '';
      setTimeout(function () { self.renderChart(); }, 30);
      return;
    }

    var view;
    try { view = MV.compute(b, m); }
    catch (e) {
      this.chartArea.innerHTML = '<div class="notice bad"><span class="ic">!</span>' +
        '<div>That combination could not be solved. Put a predictor or a donor back.</div></div>';
      return;
    }
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
           { name: 'Synthetic Germany', values: view.synthetic, color: c2, dash: '5 4' }];
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
        vlabel: 'Phase-out begins', zeroLine: isGap, height: 330, yDp: isGap ? 1 : 0
      });
      this.legendArea.innerHTML = C.legend(
        series.map(function (s) { return { name: s.name, color: s.color }; })
          .concat([{ name: '±1 SD of the pre-' + m.t0 + ' difference', color: c2, square: true }]));
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
        'The paper says coal drives it and peaks around 2013–2014.';
      C.lineChart(host, {
        years: years, series: fuels, vline: m.t0, vlabel: 'Phase-out begins',
        zeroLine: true, height: 330, yDp: 1
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
        'Watch nuclear fall, and see what rises to meet it.';
      C.lineChart(host, {
        years: years, series: elec, vline: m.t0, vlabel: 'Phase-out begins',
        zeroLine: true, height: 330, yDp: 0, tipDp: 0
      });
      this.legendArea.innerHTML = C.legend(elec.map(function (s) {
        return { name: s.name, color: s.color };
      }));
      if (this.showTable) this.tableArea.innerHTML = C.dataTable(years, elec, 0);

    } else if (m.view === 'placeboSpace') {
      this.chartTitle.textContent = 'Placebo across countries';
      this.chartSub.textContent = 'Computing…';
      host.innerHTML = '<div class="muted small" style="padding:40px 0;text-align:center">' +
                       'Running the model once for every country…</div>';
      MV.placeboSpace(b, m, function (res) {
        if (MV.modelKey(self.model) !== MV.modelKey(m) || self.model.view !== 'placeboSpace') return;
        self.chartSub.textContent = 'Each country, treated as if it had the phase-out. ' +
          'A high ratio means it diverged from its own synthetic version after 2011.';
        host.innerHTML = '';
        var rows = res.map(function (r) {
          return {
            label: r.unit, value: isFinite(r.ratio) ? r.ratio : 0,
            note: isFinite(r.ratio) ? r.ratio.toFixed(2) : '—',
            highlight: r.unit === b.treated,
            color: r.unit === b.treated ? C.cssVar('--series-2') : undefined
          };
        });
        C.barChart(host, { rows: rows, title: 'RMSPE ratio', dp: 2, labelW: 130 });
        self.legendArea.innerHTML = '';
        var rank = res.findIndex(function (r) { return r.unit === b.treated; }) + 1;
        var pub = root.CONTENT.PUBLISHED;
        var germany = res.find(function (r) { return r.unit === b.treated; });
        self.tableArea.innerHTML =
          '<div class="notice ' + (rank === 1 ? 'info' : 'warn') + '"><span class="ic">' +
          (rank === 1 ? '✓' : '!') + '</span><div>Germany ranks <strong>' + rank +
          ' of ' + res.length + '</strong>, ratio <strong>' +
          (germany ? germany.ratio.toFixed(2) : '—') + '</strong>. ' +
          'The paper reports Germany first with a ratio of ' + pub.ratio +
          ', and ' + pub.runnerUp.unit + ' second at ' + pub.runnerUp.ratio + '.</div></div>';
      });

    } else if (m.view === 'placeboTime') {
      this.chartTitle.textContent = 'Placebo across dates';
      this.chartSub.textContent = 'Computing…';
      host.innerHTML = '<div class="muted small" style="padding:40px 0;text-align:center">' +
                       'Refitting for four earlier dates…</div>';
      MV.placeboTime(b, m, FAKE_YEARS, function (res) {
        if (MV.modelKey(self.model) !== MV.modelKey(m) || self.model.view !== 'placeboTime') return;
        self.chartSub.textContent = 'Pretending the phase-out happened earlier. Nothing ' +
          'changed in these years, so a trustworthy model should show no jump.';
        host.remove();
        var grid = el('div', 'mini-grid');
        res.forEach(function (r) {
          var cell = el('div');
          cell.appendChild(el('div', 'small', '<strong>Pretend start: ' + r.year +
            '</strong> <span class="muted num">pre-fit ' + r.stats.rmspePre.toFixed(3) + '</span>'));
          var h2 = el('div', 'chart-host');
          cell.appendChild(h2);
          grid.appendChild(cell);
          var sub = b.years.filter(function (y) { return y <= 2011; });
          var n = sub.length;
          C.lineChart(h2, {
            years: sub,
            series: [{ name: 'Germany', values: r.observed.slice(0, n), color: c1 },
                     { name: 'Synthetic', values: r.synthetic.slice(0, n), color: c2, dash: '5 4' }],
            band: { lo: r.band.lo.slice(0, n), hi: r.band.hi.slice(0, n), color: c2 },
            vline: r.year, vlabel: String(r.year), height: 180, yDp: 0,
            directLabels: false
          });
        });
        self.chartArea.appendChild(grid);
        self.legendArea.innerHTML = C.legend([
          { name: 'Germany', color: c1 }, { name: 'Synthetic Germany', color: c2 }]);
      });

    } else if (m.view === 'loo') {
      this.chartTitle.textContent = 'Leave one out';
      this.chartSub.textContent = 'Computing…';
      host.innerHTML = '<div class="muted small" style="padding:40px 0;text-align:center">' +
                       'Refitting without each donor…</div>';
      MV.leaveOneOut(b, m, function (res) {
        if (MV.modelKey(self.model) !== MV.modelKey(m) || self.model.view !== 'loo') return;
        self.chartSub.textContent = 'Each grey line is the gap with one donor country ' +
          'removed. If they stay near the dark line, no single country is driving it.';
        host.innerHTML = '';
        var series = res.map(function (r) {
          return {
            name: 'without ' + r.dropped, values: r.gap, color: muted,
            width: 1.25, opacity: 0.55, noLegend: true
          };
        });
        series.push({ name: 'All donors', values: view.gap, color: c1, width: 2.5 });
        C.lineChart(host, {
          years: years, series: series, vline: m.t0, vlabel: 'Phase-out begins',
          zeroLine: true, height: 330, yDp: 1, directLabels: false
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
          '</strong> hurts the pre-intervention fit most: ' +
          view.stats.rmspePre.toFixed(3) + ' → <strong>' + worst.stats.rmspePre.toFixed(3) +
          '</strong>, and the placebo ratio moves to ' + worst.stats.ratio.toFixed(2) + '.</div></div>' +
          '<div class="table-scroll" style="margin-top:10px"><table class="data"><thead><tr>' +
          '<th>Donor dropped</th><th>pre-fit</th><th>post-fit</th><th>ratio</th></tr></thead><tbody>' +
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
    var pub = root.CONTENT.PUBLISHED;
    function card(k, v, sub) {
      return '<div class="stat-card"><div class="k">' + k + '</div><div class="v">' + v +
             '</div>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
    }
    var fitWord = s.rmspePre < 0.3 ? 'close' : s.rmspePre < 0.6 ? 'fair' : 'poor';
    this.statWrap.innerHTML =
      card('Average gap, ' + view.t0 + '–2023',
           (e.fullPeriod >= 0 ? '+' : '') + e.fullPeriod.toFixed(2),
           'tonnes of CO₂ per person') +
      card('Pre-' + view.t0 + ' fit (RMSPE)', s.rmspePre.toFixed(3),
           fitWord + ' · paper reports ' + pub.rmspePre) +
      card('Largest gap',
           e.peak ? ((e.peak.value >= 0 ? '+' : '') + e.peak.value.toFixed(2)) : '—',
           e.peak ? 'in ' + e.peak.year : '') +
      card('Gap in 2023', (e.latest >= 0 ? '+' : '') + e.latest.toFixed(2),
           Math.abs(e.latest) < 0.3 ? 'close to zero' : '');
  };

  Panel.prototype.renderWeights = function (view) {
    var pub = root.CONTENT.PUBLISHED.weights;
    var rows = view.weights.filter(function (w) { return w.weight > 0.0005; });
    var zero = view.weights.length - rows.length;
    var max = rows.length ? rows[0].weight : 1;
    var accent = C.cssVar('--series-2');
    this.weightArea.innerHTML =
      rows.map(function (w, i) {
        var p = pub[w.donor];
        var match = p !== undefined && Math.abs(p - w.weight) < 0.005;
        return '<div class="wrow"><div class="spread small" style="margin-bottom:3px">' +
               '<span>' + C.esc(w.donor) + '</span><span class="num">' +
               (w.weight * 100).toFixed(1) + '%' +
               (p !== undefined
                 ? ' <span class="tiny ' + (match ? 'ok' : 'muted') + '">' +
                   (match ? '✓ matches paper' : 'paper: ' + (p * 100).toFixed(1) + '%') +
                   '</span>'
                 : '') +
               '</span></div>' +
               '<div class="wbar"><span style="width:' + (w.weight / max * 100).toFixed(1) +
               '%' + (i === 0 ? ';background:' + accent : '') + '"></span></div></div>';
      }).join('');
    this.weightNote.textContent = zero
      ? zero + ' other donor' + (zero === 1 ? '' : 's') + ' received zero weight.'
      : '';
  };

  root.Panel = Panel;
  root.PANEL_VIEWS = ALL_VIEWS;
}(typeof self !== 'undefined' ? self : this));
