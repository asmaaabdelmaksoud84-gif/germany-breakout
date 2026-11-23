/* Synthetic Control Method solver — pure JS, no dependencies.
 *
 * Mirrors the reference Python implementation (scipy) used to replicate
 * Loiacono, Rizzo & Secomandi (2025).
 *
 *   Inner problem  min_w (X1 - X0 w)' diag(V) (X1 - X0 w),  w >= 0, sum w = 1
 *   Outer problem  min_V  pre-treatment MSPE of the outcome
 *
 * The inner problem is a convex QP over the probability simplex. It is solved
 * by pairwise (SMO-style) coordinate descent, which converges to machine
 * precision for the small donor pools used here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SCM = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS = 1e-14;

  function nanMean(arr) {
    var s = 0, n = 0;
    for (var i = 0; i < arr.length; i++) {
      var x = arr[i];
      if (x !== null && x !== undefined && isFinite(x)) { s += x; n++; }
    }
    return n ? s / n : NaN;
  }

  /* Sample standard deviation (ddof = 1) across a row, ignoring non-finite. */
  function sampleSd(arr) {
    var vals = [];
    for (var i = 0; i < arr.length; i++) {
      if (isFinite(arr[i])) vals.push(arr[i]);
    }
    if (vals.length < 2) return 0;
    var m = 0, j;
    for (j = 0; j < vals.length; j++) m += vals[j];
    m /= vals.length;
    var s = 0;
    for (j = 0; j < vals.length; j++) s += (vals[j] - m) * (vals[j] - m);
    return Math.sqrt(s / (vals.length - 1));
  }

  /* ---------------------------------------------------------------- design */

  /**
   * Build the SCM design from a raw data bundle.
   * opts: { treated, donors, meanPredictors, lagYears, t0, outcome }
   * Predictor means are taken over the full pre-treatment window.
   */
  function buildDesign(bundle, opts) {
    var treated = opts.treated || bundle.treated;
    var donors = opts.donors || bundle.donors;
    var meanPredictors = opts.meanPredictors || bundle.meanPredictors;
    var lagYears = opts.lagYears || bundle.lagYears;
    var t0 = opts.t0 || bundle.defaultT0;
    var outcome = opts.outcome || bundle.outcome;
    var years = bundle.years;
    var units = [treated].concat(donors);

    var preYears = years.filter(function (y) { return y < t0; });
    var preIdx = preYears.map(function (y) { return years.indexOf(y); });

    var labels = [], rows = [];
    var i, k, u, s;

    // Block 1: pre-treatment means of each predictor
    for (i = 0; i < meanPredictors.length; i++) {
      var name = meanPredictors[i];
      var ser = bundle.series[name];
      if (!ser) continue;
      var row = [];
      for (k = 0; k < units.length; k++) {
        var full = ser[units[k]];
        var vals = [];
        for (s = 0; s < preIdx.length; s++) vals.push(full[preIdx[s]]);
        row.push(nanMean(vals));
      }
      rows.push(row); labels.push(name);
    }

    // Block 2: lagged outcome values (only those inside the pre-window)
    var oc = bundle.series[outcome];
    var usedLags = [];
    for (i = 0; i < lagYears.length; i++) {
      var y = lagYears[i];
      if (y >= t0 || years.indexOf(y) < 0) continue;
      var yi = years.indexOf(y);
      var lrow = [];
      for (k = 0; k < units.length; k++) lrow.push(oc[units[k]][yi]);
      rows.push(lrow); labels.push(outcome + '(' + y + ')');
      usedLags.push(y);
    }

    var S = rows.length, K = donors.length;
    var X1 = new Float64Array(S), X0 = [];
    var sd = new Float64Array(S);
    for (i = 0; i < S; i++) {
      X1[i] = rows[i][0];
      var dr = new Float64Array(K);
      for (k = 0; k < K; k++) dr[k] = rows[i][k + 1];
      X0.push(dr);
      sd[i] = sampleSd(rows[i]);
      if (!(sd[i] > 0)) sd[i] = 1;
    }

    // Pre-treatment outcome paths
    var Z1 = new Float64Array(preIdx.length), Z0 = [];
    for (s = 0; s < preIdx.length; s++) {
      Z1[s] = oc[treated][preIdx[s]];
      var zr = new Float64Array(K);
      for (k = 0; k < K; k++) zr[k] = oc[donors[k]][preIdx[s]];
      Z0.push(zr);
    }

    return {
      treated: treated, donors: donors, labels: labels, usedLags: usedLags,
      t0: t0, outcome: outcome, years: years, preYears: preYears,
      X1: X1, X0: X0, sd: sd, Z1: Z1, Z0: Z0, S: S, K: K
    };
  }

  /* ----------------------------------------------------------- inner solve */

  /**
   * Solve min_w (X1-X0 w)' diag(v) (X1-X0 w) over the simplex.
   * X1/X0 are expected already standardised; v need not be normalised.
   */
  function solveW(design, v, opts) {
    opts = opts || {};
    var sweeps = opts.sweeps || 400;
    var tol = opts.tol || 1e-13;
    var S = design.S, K = design.K, X0 = design.X0, X1 = design.X1,
        sd = design.sd;
    var i, j, k, p, q;

    // Standardise and fold in sqrt(v): A = diag(sqrt(v)/sd) X0, b likewise
    var sv = new Float64Array(S);
    for (i = 0; i < S; i++) {
      var vi = v[i] > 0 ? v[i] : 0;
      sv[i] = Math.sqrt(vi) / sd[i];
    }

    // Gram matrix Q = A'A and c = A'b
    var Q = [], c = new Float64Array(K);
    for (k = 0; k < K; k++) Q.push(new Float64Array(K));
    for (i = 0; i < S; i++) {
      var wi = sv[i] * sv[i];
      if (wi === 0) continue;
      var xr = X0[i], t = X1[i];
      for (k = 0; k < K; k++) {
        c[k] += wi * xr[k] * t;
        var qk = Q[k], xk = wi * xr[k];
        for (j = k; j < K; j++) qk[j] += xk * xr[j];
      }
    }
    for (k = 0; k < K; k++) for (j = 0; j < k; j++) Q[k][j] = Q[j][k];

    // Warm start: uniform
    var w = new Float64Array(K);
    for (k = 0; k < K; k++) w[k] = 1 / K;

    // g = Qw - c  (half-gradient of w'Qw - 2c'w)
    var g = new Float64Array(K);
    function recomputeG() {
      for (k = 0; k < K; k++) {
        var s = 0, qk = Q[k];
        for (j = 0; j < K; j++) s += qk[j] * w[j];
        g[k] = s - c[k];
      }
    }
    recomputeG();

    for (var sweep = 0; sweep < sweeps; sweep++) {
      var moved = 0;
      for (p = 0; p < K; p++) {
        for (q = 0; q < K; q++) {
          if (p === q) continue;
          // move d from q into p: w_p += d, w_q -= d, d in [-w_p, w_q]
          var denom = Q[p][p] - 2 * Q[p][q] + Q[q][q];
          var num = g[q] - g[p];
          var d;
          if (denom > EPS) {
            d = num / denom;
          } else {
            d = num > 0 ? w[q] : -w[p];
          }
          if (d > w[q]) d = w[q];
          if (d < -w[p]) d = -w[p];
          if (!(Math.abs(d) > tol)) continue;
          w[p] += d; w[q] -= d;
          if (w[p] < 0) w[p] = 0;
          if (w[q] < 0) w[q] = 0;
          for (k = 0; k < K; k++) g[k] += d * (Q[k][p] - Q[k][q]);
          moved++;
        }
      }
      if (!moved) break;
      if (sweep % 25 === 24) recomputeG();   // guard against drift
    }

    // Renormalise defensively
    var tot = 0;
    for (k = 0; k < K; k++) { if (w[k] < 0) w[k] = 0; tot += w[k]; }
    if (tot > 0) for (k = 0; k < K; k++) w[k] /= tot;
    else for (k = 0; k < K; k++) w[k] = 1 / K;
    return w;
  }

  /* --------------------------------------------------------- outcome paths */

  function syntheticPath(bundle, design, w, seriesName) {
    var ser = bundle.series[seriesName || design.outcome];
    var years = bundle.years, out = new Float64Array(years.length);
    for (var t = 0; t < years.length; t++) {
      var s = 0, ok = true;
      for (var k = 0; k < design.K; k++) {
        var x = ser[design.donors[k]][t];
        if (x === null || x === undefined || !isFinite(x)) {
          if (w[k] > 1e-12) { ok = false; break; }
          continue;
        }
        s += w[k] * x;
      }
      out[t] = ok ? s : NaN;
    }
    return out;
  }

  function treatedPath(bundle, design, seriesName) {
    var ser = bundle.series[seriesName || design.outcome];
    var raw = ser[design.treated];
    var out = new Float64Array(raw.length);
    for (var t = 0; t < raw.length; t++) {
      out[t] = (raw[t] === null || raw[t] === undefined) ? NaN : raw[t];
    }
    return out;
  }

  /** Pre/post RMSPE and the ratio used for placebo inference. */
  function fitStats(bundle, design, w) {
    var years = bundle.years;
    var a = treatedPath(bundle, design), b = syntheticPath(bundle, design, w);
    var pre = 0, npre = 0, post = 0, npost = 0;
    for (var t = 0; t < years.length; t++) {
      if (!isFinite(a[t]) || !isFinite(b[t])) continue;
      var d = a[t] - b[t];
      if (years[t] < design.t0) { pre += d * d; npre++; }
      else { post += d * d; npost++; }
    }
    var rpre = npre ? Math.sqrt(pre / npre) : NaN;
    var rpost = npost ? Math.sqrt(post / npost) : NaN;
    return {
      rmspePre: rpre, rmspePost: rpost,
      ratio: (rpre > 0) ? rpost / rpre : NaN,
      mspePre: npre ? pre / npre : NaN
    };
  }

  /* ----------------------------------------------------------- outer solve */

  function mspeFromV(bundle, design, v) {
    var w = solveW(design, v);
    var s = 0, n = design.Z1.length;
    for (var t = 0; t < n; t++) {
      var acc = 0, zr = design.Z0[t];
      for (var k = 0; k < design.K; k++) acc += zr[k] * w[k];
      var d = design.Z1[t] - acc;
      s += d * d;
    }
    return s / n;
  }

  function softmax(theta) {
    var m = -Infinity, i;
    for (i = 0; i < theta.length; i++) if (theta[i] > m) m = theta[i];
    var out = new Float64Array(theta.length), tot = 0;
    for (i = 0; i < theta.length; i++) { out[i] = Math.exp(theta[i] - m); tot += out[i]; }
    for (i = 0; i < theta.length; i++) out[i] /= tot;
    return out;
  }

  /* Nelder-Mead over log-weights; bounded work so it stays interactive. */
  function nelderMead(f, x0, maxIter) {
    var n = x0.length, i, j;
    var pts = [], vals = [];
    function mk(a) { return Array.prototype.slice.call(a); }
    pts.push(mk(x0)); vals.push(f(x0));
    for (i = 0; i < n; i++) {
      var p = mk(x0); p[i] += 1.0;
      pts.push(p); vals.push(f(p));
    }
    var alpha = 1, gamma = 2, rho = 0.5, sigma = 0.5;
    for (var it = 0; it < maxIter; it++) {
      var order = [];
      for (i = 0; i <= n; i++) order.push(i);
      order.sort(function (a, b) { return vals[a] - vals[b]; });
      var np = [], nv = [];
      for (i = 0; i <= n; i++) { np.push(pts[order[i]]); nv.push(vals[order[i]]); }
      pts = np; vals = nv;
      if (Math.abs(vals[n] - vals[0]) < 1e-14 * (Math.abs(vals[0]) + 1e-14)) break;

      var cen = new Array(n).fill(0);
      for (i = 0; i < n; i++) for (j = 0; j < n; j++) cen[j] += pts[i][j] / n;

      var xr = new Array(n), xe = new Array(n), xc = new Array(n);
      for (j = 0; j < n; j++) xr[j] = cen[j] + alpha * (cen[j] - pts[n][j]);
      var fr = f(xr);
      if (fr < vals[0]) {
        for (j = 0; j < n; j++) xe[j] = cen[j] + gamma * (cen[j] - pts[n][j]);
        var fe = f(xe);
        if (fe < fr) { pts[n] = xe; vals[n] = fe; } else { pts[n] = xr; vals[n] = fr; }
      } else if (fr < vals[n - 1]) {
        pts[n] = xr; vals[n] = fr;
      } else {
        for (j = 0; j < n; j++) xc[j] = cen[j] + rho * (pts[n][j] - cen[j]);
        var fc = f(xc);
        if (fc < vals[n]) { pts[n] = xc; vals[n] = fc; }
        else {
          for (i = 1; i <= n; i++) {
            for (j = 0; j < n; j++) pts[i][j] = pts[0][j] + sigma * (pts[i][j] - pts[0][j]);
            vals[i] = f(pts[i]);
          }
        }
      }
    }
    var bi = 0;
    for (i = 1; i <= n; i++) if (vals[i] < vals[bi]) bi = i;
    return { x: pts[bi], fun: vals[bi] };
  }

  /**
   * Data-driven predictor weights: choose V to minimise pre-treatment MSPE.
   *
   * The objective is flat and multi-modal, and its optima concentrate V on a
   * handful of predictors, so a global sampling phase over sparse candidates
   * comes first and Nelder-Mead only refines the best of them. Deterministic:
   * every client that runs this on the same design gets the same answer.
   */
  function optimiseV(bundle, design, opts) {
    opts = opts || {};
    var samples = opts.samples === undefined ? 600 : opts.samples;
    var refine = opts.refine === undefined ? 6 : opts.refine;
    var maxIter = opts.maxIter || 700;
    var S = design.S;
    var seed = (opts.seed || 12345) >>> 0;
    function rnd() {   // deterministic LCG, so every client agrees
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }
    function obj(theta) { return mspeFromV(bundle, design, softmax(theta)); }

    var i, k, cands = [];

    function pushV(v) {
      var tot = 0;
      for (var j = 0; j < S; j++) tot += v[j];
      if (!(tot > 0)) return;
      var th = new Array(S);
      for (var j2 = 0; j2 < S; j2++) th[j2] = Math.log(Math.max(v[j2] / tot, 1e-12));
      cands.push({ x: th, fun: obj(th) });
    }

    // Structured candidates: uniform, and all weight on each single predictor
    var uni = new Array(S).fill(1 / S);
    pushV(uni);
    for (i = 0; i < S; i++) {
      var e = new Array(S).fill(1e-10); e[i] = 1;
      pushV(e);
    }
    // Sparse random candidates: pick a random active subset, random magnitudes
    for (i = 0; i < samples; i++) {
      var size = 1 + Math.floor(rnd() * Math.min(S, 6));
      var v = new Array(S).fill(1e-10);
      for (k = 0; k < size; k++) {
        var idx = Math.floor(rnd() * S);
        var mag = rnd();
        v[idx] += mag * mag * mag + 1e-6;   // cubed -> favours concentrated V
      }
      pushV(v);
    }

    cands.sort(function (a, b) { return a.fun - b.fun; });

    var best = cands[0];
    var nref = Math.min(refine, cands.length);
    for (i = 0; i < nref; i++) {
      var res = nelderMead(obj, cands[i].x.slice(), maxIter);
      res = nelderMead(obj, res.x, Math.round(maxIter / 2));
      if (res.fun < best.fun) best = res;
    }
    var vv = softmax(best.x);
    return { v: vv, w: solveW(design, vv), mspePre: best.fun };
  }

  /* ------------------------------------------------------- robustness tools */

  /** Placebo in space: treat each donor as if it had been treated. */
  function placeboInSpace(bundle, baseOpts) {
    var pool = (baseOpts.donors || bundle.donors).slice();
    var all = [bundle.treated].concat(pool);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var unit = all[i];
      var others = all.filter(function (u) { return u !== unit; });
      var o = Object.assign({}, baseOpts, { treated: unit, donors: others });
      var d = buildDesign(bundle, o);
      var fit = optimiseV(bundle, d, { samples: 260, refine: 3, maxIter: 340 });
      var st = fitStats(bundle, d, fit.w);
      out.push({
        unit: unit, ratio: st.ratio,
        rmspePre: st.rmspePre, rmspePost: st.rmspePost
      });
    }
    out.sort(function (a, b) { return (b.ratio || 0) - (a.ratio || 0); });
    return out;
  }

  /** Leave-one-out: drop each donor in turn from the pool. */
  function leaveOneOut(bundle, baseOpts, v) {
    var pool = (baseOpts.donors || bundle.donors).slice();
    var out = [];
    for (var i = 0; i < pool.length; i++) {
      var dropped = pool[i];
      var others = pool.filter(function (u) { return u !== dropped; });
      var d = buildDesign(bundle, Object.assign({}, baseOpts, { donors: others }));
      var w;
      if (v && v.length === d.S) w = solveW(d, v);
      else w = optimiseV(bundle, d, { samples: 260, refine: 3, maxIter: 340 }).w;
      out.push({
        dropped: dropped, design: d, w: w,
        path: syntheticPath(bundle, d, w),
        stats: fitStats(bundle, d, w)
      });
    }
    return out;
  }

  return {
    buildDesign: buildDesign, solveW: solveW, optimiseV: optimiseV,
    syntheticPath: syntheticPath, treatedPath: treatedPath,
    fitStats: fitStats, mspeFromV: mspeFromV, softmax: softmax,
    placeboInSpace: placeboInSpace, leaveOneOut: leaveOneOut,
    nanMean: nanMean, sampleSd: sampleSd
  };
}));
