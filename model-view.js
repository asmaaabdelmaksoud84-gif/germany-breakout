/* Turns a room's model (the inputs students manipulate) into everything the
 * charts and readouts need. Deterministic, so every client that holds the same
 * model renders exactly the same picture — that is what makes the shared view
 * genuinely shared rather than approximately shared.
 *
 * Results are cached by model identity; the expensive robustness tests
 * (placebos, leave-one-out) are computed only when their view is open. */
(function (root) {
  'use strict';

  var SCM = root.SCM;
  var CACHE = new Map(), CACHE_MAX = 48;

  var PRED_LABELS = {
    gdp_pc: 'GDP per capita',
    reg_car_pcm: 'Registered cars per capita',
    el_pc: 'Electricity consumption per capita',
    fossil_elpc: 'Electricity from fossil fuels',
    nuc_elpc: 'Electricity from nuclear',
    temp: 'Average temperature',
    industry: 'Industrial value added (% GDP)',
    populationdensity: 'Population density',
    populationshareinurbanareas: 'Urban population (%)',
    energyintensity: 'Energy intensity',
    hh_perc: 'Household share of electricity'
  };
  var SERIES_LABELS = {
    co2pc_fossil: 'All fossil fuels', coal_co2pc: 'Coal',
    oil_co2pc: 'Oil', gas_co2pc: 'Gas',
    nuc_elpc: 'Nuclear', coal_elpc: 'Coal', gas_elpc: 'Gas',
    oil_elpc: 'Oil', res_elpc: 'Renewables'
  };

  function labelOf(key) {
    if (PRED_LABELS[key]) return PRED_LABELS[key];
    var m = /^co2pc_fossil\((\d+)\)$/.exec(key);
    if (m) return 'CO₂ from fossil fuels, ' + m[1];
    return SERIES_LABELS[key] || key;
  }

  function modelKey(m) {
    return JSON.stringify([m.t0, m.donors, m.predictors, m.lagYears, m.weightMode, m.v]);
  }

  /** Build the V vector the design expects from the model's manual weights. */
  function vFor(design, model) {
    var v = new Array(design.S);
    for (var i = 0; i < design.S; i++) {
      var lab = design.labels[i];
      var x = model.v && model.v[lab] !== undefined ? Number(model.v[lab]) : 1;
      v[i] = isFinite(x) && x >= 0 ? x : 0;
    }
    var tot = 0;
    for (i = 0; i < design.S; i++) tot += v[i];
    if (!(tot > 0)) for (i = 0; i < design.S; i++) v[i] = 1 / design.S;
    else for (i = 0; i < design.S; i++) v[i] /= tot;
    return v;
  }

  /** Core computation: donor weights, fitted paths, gap, fit statistics. */
  function compute(bundle, model) {
    var key = modelKey(model);
    if (CACHE.has(key)) return CACHE.get(key);

    var design = SCM.buildDesign(bundle, {
      t0: model.t0, donors: model.donors,
      meanPredictors: model.predictors, lagYears: model.lagYears
    });

    var w, v = null, source = model.weightMode;
    if (model.weightMode === 'published' &&
        model.t0 === bundle.defaultT0 &&
        model.donors.length === bundle.donors.length) {
      // The paper's own donor weights, reproducing its published figures
      w = design.donors.map(function (d) { return bundle.publishedWeights[d] || 0; });
      var tot = w.reduce(function (a, b) { return a + b; }, 0);
      if (tot > 0) w = w.map(function (x) { return x / tot; });
    } else if (model.weightMode === 'optimised') {
      var fit = SCM.optimiseV(bundle, design);
      w = Array.from(fit.w); v = Array.from(fit.v);
      source = 'optimised';
    } else {
      v = vFor(design, model);
      w = Array.from(SCM.solveW(design, v));
      source = model.weightMode === 'published' ? 'published-unavailable' : 'manual';
    }

    var observed = Array.from(SCM.treatedPath(bundle, design));
    var synthetic = Array.from(SCM.syntheticPath(bundle, design, w));
    var years = bundle.years;
    var gap = years.map(function (y, i) {
      return (isFinite(observed[i]) && isFinite(synthetic[i])) ? observed[i] - synthetic[i] : NaN;
    });
    var stats = SCM.fitStats(bundle, design, w);

    // ±1 SD of the pre-treatment difference, as in the paper's shaded band
    var pre = [];
    for (var i = 0; i < years.length; i++) {
      if (years[i] < model.t0 && isFinite(gap[i])) pre.push(gap[i]);
    }
    var sd = 0;
    if (pre.length > 1) {
      var mean = pre.reduce(function (a, b) { return a + b; }, 0) / pre.length;
      var ss = pre.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0);
      sd = Math.sqrt(ss / (pre.length - 1));
    }
    var band = {
      lo: synthetic.map(function (x) { return isFinite(x) ? x - sd : NaN; }),
      hi: synthetic.map(function (x) { return isFinite(x) ? x + sd : NaN; })
    };

    var weights = design.donors.map(function (d, k) { return { donor: d, weight: w[k] }; })
      .sort(function (a, b) { return b.weight - a.weight; });

    // Effect summaries the groups report
    function meanGap(from, to) {
      var s = 0, n = 0;
      for (var j = 0; j < years.length; j++) {
        if (years[j] >= from && years[j] <= to && isFinite(gap[j])) { s += gap[j]; n++; }
      }
      return n ? s / n : NaN;
    }
    var peak = { year: null, value: -Infinity };
    for (i = 0; i < years.length; i++) {
      if (years[i] >= model.t0 && isFinite(gap[i]) && gap[i] > peak.value) {
        peak = { year: years[i], value: gap[i] };
      }
    }
    var lastYear = years[years.length - 1];

    var out = {
      design: design, w: w, v: v, weightSource: source,
      weights: weights, observed: observed, synthetic: synthetic, gap: gap,
      band: band, bandSd: sd, stats: stats, years: years, t0: model.t0,
      effect: {
        shortRun: meanGap(model.t0, Math.min(model.t0 + 6, lastYear)),
        fullPeriod: meanGap(model.t0, lastYear),
        peak: peak.year ? peak : null,
        latest: gap[years.length - 1]
      }
    };
    if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
    CACHE.set(key, out);
    return out;
  }

  /** Gap between Germany and synthetic Germany for an arbitrary series. */
  function gapFor(bundle, view, seriesName) {
    var obs = SCM.treatedPath(bundle, view.design, seriesName);
    var syn = SCM.syntheticPath(bundle, view.design, view.w, seriesName);
    return bundle.years.map(function (y, i) {
      return (isFinite(obs[i]) && isFinite(syn[i])) ? obs[i] - syn[i] : NaN;
    });
  }
  function pathsFor(bundle, view, seriesName) {
    return {
      observed: Array.from(SCM.treatedPath(bundle, view.design, seriesName)),
      synthetic: Array.from(SCM.syntheticPath(bundle, view.design, view.w, seriesName))
    };
  }

  /** Has this model already been solved? Lets the UI paint before blocking. */
  function isCached(model) { return CACHE.has(modelKey(model)); }

  /* ------------------------------------------- lazily computed robustness */

  var HEAVY = new Map();
  function heavyKey(kind, model) { return kind + '|' + modelKey(model); }

  /**
   * The predictor importances to carry into the robustness tests: whatever the
   * student is using. The published model fixes country weights directly and
   * has no V of its own, so one is derived once and cached.
   */
  function sharedV(bundle, model) {
    var view = compute(bundle, model);
    if (view.v && view.v.length === view.design.S) return view.v;
    var k = heavyKey('sv', model);
    if (HEAVY.has(k)) return HEAVY.get(k);
    var fit = SCM.optimiseV(bundle, view.design);
    HEAVY.set(k, fit.v);
    return fit.v;
  }

  /** Re-express a V as label -> weight, so it survives a change of design. */
  function vAsLabels(design, v) {
    var m = {};
    for (var i = 0; i < design.labels.length; i++) m[design.labels[i]] = v[i];
    return m;
  }
  function vForDesign(design, map) {
    var out = new Array(design.S), tot = 0, i;
    for (i = 0; i < design.S; i++) {
      var x = map[design.labels[i]];
      out[i] = (x === undefined || !isFinite(x)) ? 0 : x;
      tot += out[i];
    }
    if (!(tot > 0)) for (i = 0; i < design.S; i++) out[i] = 1 / design.S;
    return out;
  }

  function placeboSpace(bundle, model, done) {
    var k = heavyKey('ps', model);
    if (HEAVY.has(k)) return done(HEAVY.get(k));
    setTimeout(function () {
      var res = SCM.placeboInSpace(bundle, {
        t0: model.t0, donors: model.donors,
        meanPredictors: model.predictors, lagYears: model.lagYears
      }, sharedV(bundle, model));
      HEAVY.set(k, res); done(res);
    }, 10);
  }

  function placeboTime(bundle, model, fakeYears, done) {
    var k = heavyKey('pt' + fakeYears.join(','), model);
    if (HEAVY.has(k)) return done(HEAVY.get(k));
    setTimeout(function () {
      var base = compute(bundle, model);
      var map = vAsLabels(base.design, sharedV(bundle, model));
      var res = fakeYears.map(function (fy) {
        // Same specification, earlier date -- so the only thing that changed
        // is the intervention year, which is the point of the test.
        var m2 = Object.assign({}, model, { t0: fy, weightMode: 'manual', v: map });
        var vw = compute(bundle, m2);
        return {
          year: fy, observed: vw.observed, synthetic: vw.synthetic,
          band: vw.band, stats: vw.stats, gap: vw.gap
        };
      });
      HEAVY.set(k, res); done(res);
    }, 10);
  }

  function leaveOneOut(bundle, model, done) {
    var k = heavyKey('loo', model);
    if (HEAVY.has(k)) return done(HEAVY.get(k));
    setTimeout(function () {
      var res = SCM.leaveOneOut(bundle, {
        t0: model.t0, donors: model.donors,
        meanPredictors: model.predictors, lagYears: model.lagYears
      }, sharedV(bundle, model));
      var out = res.map(function (r) {
        var obs = Array.from(SCM.treatedPath(bundle, r.design));
        var syn = Array.from(r.path);
        return {
          dropped: r.dropped, stats: r.stats,
          gap: bundle.years.map(function (y, i) {
            return (isFinite(obs[i]) && isFinite(syn[i])) ? obs[i] - syn[i] : NaN;
          })
        };
      });
      HEAVY.set(k, out); done(out);
    }, 10);
  }

  root.ModelView = {
    compute: compute, gapFor: gapFor, pathsFor: pathsFor, labelOf: labelOf,
    vFor: vFor, modelKey: modelKey, isCached: isCached, sharedV: sharedV,
    placeboSpace: placeboSpace, placeboTime: placeboTime, leaveOneOut: leaveOneOut,
    PRED_LABELS: PRED_LABELS, SERIES_LABELS: SERIES_LABELS
  };
}(typeof self !== 'undefined' ? self : this));
