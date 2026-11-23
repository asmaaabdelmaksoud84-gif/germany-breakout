/* Facilitator dashboard: live room cards, whole-class controls, the presentation
 * workspace, the side-by-side comparison view, and export. */
(function () {
  'use strict';
  var C = Charts, MV = ModelView;

  var App = { bundle: null, net: null, st: null, panel: null, tab: 'rooms', key: null };

  function $(s) { return document.querySelector(s); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function ago(ts) {
    var d = Math.max(0, Date.now() - ts) / 1000;
    if (d < 10) return 'just now';
    if (d < 60) return Math.round(d) + 's ago';
    if (d < 3600) return Math.round(d / 60) + ' min ago';
    return Math.round(d / 3600) + ' h ago';
  }

  /* ------------------------------------------------------------------ boot */

  function boot() {
    var url = new URL(location.href);
    var key = url.searchParams.get('key') || sessionStorage.getItem('scm-fac-key') || '';
    if (!key) return askKey('');
    start(key);
  }

  function askKey(err) {
    var root = $('#app');
    root.innerHTML = '';
    var wrap = el('div', 'wrap-narrow');
    var card = el('div', 'card pad');
    card.appendChild(el('h1', null, 'Facilitator sign-in'));
    card.appendChild(el('p', 'secondary',
      'Enter the facilitator key printed in the server\'s terminal when it started.'));
    var inp = document.createElement('input');
    inp.type = 'password';
    inp.placeholder = 'Facilitator key';
    card.appendChild(inp);
    if (err) {
      var e = el('div', 'notice bad', '<span class="ic">!</span><div>' + C.esc(err) + '</div>');
      e.style.marginTop = '10px';
      card.appendChild(e);
    }
    var btn = el('button', 'primary', 'Open dashboard');
    btn.type = 'button';
    btn.style.marginTop = '12px';
    card.appendChild(btn);
    function go() {
      var v = inp.value.trim();
      if (v) { sessionStorage.setItem('scm-fac-key', v); start(v); }
    }
    btn.addEventListener('click', go);
    inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') go(); });
    wrap.appendChild(card);
    root.appendChild(wrap);
    setTimeout(function () { inp.focus(); }, 40);
  }

  function start(key) {
    App.key = key;
    $('#app').innerHTML = '<div class="wrap-narrow"><p class="secondary">Connecting…</p></div>';
    fetch('data_bundle.json').then(function (r) { return r.json(); }).then(function (b) {
      App.bundle = b;
      App.net = new Net({ facilitatorKey: key, storeKey: 'scm-facilitator-noseat' });
      App.net.on('state', function (s) { App.st = s; render(); });
      App.net.on('connection', function (up) {
        var c = $('#conn');
        if (c) {
          c.className = 'conn' + (up ? '' : ' down');
          c.innerHTML = '<span class="dot"></span>' + (up ? 'Live' : 'Reconnecting…');
        }
      });
      App.net.on('facilitatorDenied', function () {
        sessionStorage.removeItem('scm-fac-key');
        askKey('That key was not accepted. Check the server terminal and try again.');
      });
      App.net.on('denied', function (m) {
        toast('Refused: ' + m.action + ' (' + m.reason + ')', 'warn');
      });
      App.net.on('export', function (m) { downloadExport(m.payload); });
      App.net.connect();
      setInterval(function () { App.net.send({ type: 'ping' }); }, 20000);
    });
  }

  var toastTimer;
  function toast(text, kind, ms) {
    var host = $('#toast');
    host.innerHTML = '<div class="notice ' + (kind || 'info') + '"><span class="ic">' +
      (kind === 'warn' ? '!' : 'i') + '</span><div>' + C.esc(text) + '</div></div>';
    host.style.display = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { host.style.display = 'none'; }, ms || 3500);
  }

  function send(type, extra) { App.net.send(Object.assign({ type: type }, extra || {})); }

  /* Same reasoning as the student client: don't replace live buttons on every
     incoming state broadcast. */
  var SIGS = {};

  /* ---------------------------------------------------------------- render */

  function render() {
    var s = App.st;
    if (!s) return;
    if (s.you.role !== 'facilitator') return;    // waiting on facilitatorOk

    if (!App.shell) {
      $('#app').innerHTML = '';
      App.shell = true;
      SIGS = {};
      App.bar = el('div', 'mode-bar');
      $('#app').appendChild(App.bar);
      var wrap = el('div', 'wrap');
      App.toolHost = el('div');
      App.toolHost.style.marginBottom = '16px';
      wrap.appendChild(App.toolHost);
      App.tabHost = el('div', 'row-wrap');
      App.tabHost.style.marginBottom = '14px';
      wrap.appendChild(App.tabHost);
      App.body = el('div');
      wrap.appendChild(App.body);
      $('#app').appendChild(wrap);
    }
    renderBar();
    renderToolbar();
    renderTabs();
    if (App.tab === 'rooms') renderRooms();
    else if (App.tab === 'present') renderPresent();
    else if (App.tab === 'compare') renderCompare();
    syncDrive();
  }

  function renderBar() {
    var s = App.st, c = s.classroom;
    var mode = c.presenting ? 'present' : c.freezeAll ? 'frozen' : 'group';
    App.bar.className = 'mode-bar mode-' + mode;
    var label = c.presenting ? 'Presenting to all rooms'
      : c.freezeAll ? 'All rooms paused'
      : Object.keys(c.frozenRooms).length ? 'Some rooms paused'
      : 'Rooms are working';
    App.bar.innerHTML = '';
    var what = el('div', 'what');
    what.appendChild(el('span', 'mode-dot'));
    var t = el('div');
    t.appendChild(el('div', null, 'Facilitator · ' + C.esc(label)));
    t.appendChild(el('div', 'tiny', C.esc(
      c.revealCrossRoom ? 'Cross-room answers are visible to students'
                        : 'Cross-room answers are hidden from students')));
    what.appendChild(t);
    App.bar.appendChild(what);
    var right = el('div', 'row-wrap');
    var total = 0;
    s.config.roomIds.forEach(function (id) { total += s.rooms[id].occupancy; });
    right.appendChild(el('span', 'small secondary', total + ' student' +
      (total === 1 ? '' : 's') + ' connected'));
    var conn = el('span', 'conn');
    conn.id = 'conn';
    conn.innerHTML = '<span class="dot"></span>' + (App.net.connected ? 'Live' : 'Reconnecting…');
    right.appendChild(conn);
    App.bar.appendChild(right);
  }

  function renderToolbar() {
    var s = App.st, c = s.classroom;
    var sig = [c.freezeAll, c.presenting, c.revealCrossRoom,
               Object.keys(c.frozenRooms).sort().join(',')].join('|');
    if (SIGS.toolbar === sig) return;
    SIGS.toolbar = sig;
    App.toolHost.innerHTML = '';
    var tb = el('div', 'toolbar');

    function add(label, cls, fn, opts) {
      opts = opts || {};
      var b = el('button', cls, label);
      b.type = 'button';
      if (opts.disabled) b.disabled = true;
      if (opts.title) b.title = opts.title;
      b.addEventListener('click', fn);
      tb.appendChild(b);
      return b;
    }

    add('Freeze all rooms', c.freezeAll ? 'on' : 'primary', function () {
      send('fac:freezeAll');
      toast('All rooms are now read-only for students.');
    }, { disabled: c.freezeAll });

    add('Unfreeze all rooms', '', function () {
      send('fac:unfreezeAll');
      toast('Rooms can edit again. Each group resumed its own saved work.');
    }, { disabled: !c.freezeAll && !Object.keys(c.frozenRooms).length });

    tb.appendChild(el('span', 'sep'));

    if (!c.presenting) {
      add('Present to all rooms', '', function () { startPresenting(); });
    } else {
      add('End presentation', 'primary', function () {
        send('fac:present', { on: false });
        toast('Presentation ended. Every group is back on its own saved workspace.');
      });
    }

    tb.appendChild(el('span', 'sep'));

    add('Advance all rooms', '', function () {
      send('fac:advanceAll');
      toast('Every room moved on one stage.');
    });
    add('← Back all rooms', 'ghost', function () { send('fac:advanceAll', { back: true }); });

    tb.appendChild(el('span', 'sep'));

    add(c.revealCrossRoom ? 'Hide results' : 'Reveal results',
        c.revealCrossRoom ? 'on' : '', function () {
      send('fac:reveal', { on: !c.revealCrossRoom });
      toast(c.revealCrossRoom
        ? 'Other rooms\' written answers are hidden again.'
        : 'Every room can now read the other rooms\' answers.');
    });

    tb.appendChild(el('span', 'sep'));

    add('Export responses', '', function () { send('fac:export'); });

    App.toolHost.appendChild(tb);

    if (c.presenting) {
      var n = el('div', 'notice info');
      n.style.marginTop = '10px';
      n.innerHTML = '<span class="ic">▶</span><div><strong>You are presenting.</strong> ' +
        'Every student sees your analysis and cannot change anything. Their own group work ' +
        'is preserved. Open the <em>Presentation</em> tab to drive the graphs.</div>';
      App.toolHost.appendChild(n);
    } else if (c.freezeAll) {
      var f = el('div', 'notice warn');
      f.style.marginTop = '10px';
      f.innerHTML = '<span class="ic">⏸</span><div><strong>All rooms are frozen.</strong> ' +
        'Students see a banner and cannot edit. You can still drive any room from its card ' +
        'below, or use <em>Present to all rooms</em> to put one analysis on every screen.</div>';
      App.toolHost.appendChild(f);
    }
  }

  function renderTabs() {
    if (SIGS.tabs === App.tab) return;
    SIGS.tabs = App.tab;
    App.tabHost.innerHTML = '';
    var seg = el('div', 'seg');
    [['rooms', 'Rooms'], ['present', 'Presentation'], ['compare', 'Compare all four']]
      .forEach(function (t) {
        var b = el('button', App.tab === t[0] ? 'on' : '', t[1]);
        b.type = 'button';
        b.addEventListener('click', function () {
          App.tab = t[0]; SIGS.rooms = null; render();
        });
        seg.appendChild(b);
      });
    App.tabHost.appendChild(seg);
  }

  /* ----------------------------------------------------------- rooms tab */

  function renderRooms() {
    var s = App.st, b = App.bundle, c = s.classroom;
    App.body.innerHTML = '';
    var grid = el('div', 'fac-grid');

    s.config.roomIds.forEach(function (id) {
      var r = s.rooms[id];
      var frozen = r.frozen || c.freezeAll;
      var card = el('div', 'card pad fac-room' + (frozen ? ' frozen' : ''));

      var hd = el('div', 'fr-head');
      hd.innerHTML = '<h3>Room ' + id + ' — ' + r.occupancy + '/' + r.capacity +
        ' connected</h3><span class="pill ' +
        (frozen ? 'frozen' : r.occupancy ? 'live' : 'empty') + '">' +
        (frozen ? 'paused' : r.occupancy ? 'live' : 'empty') + '</span>';
      card.appendChild(hd);

      card.appendChild(el('div', 'small secondary',
        'Stage ' + (r.stage + 1) + ' of ' + s.stages.length + ' · ' +
        C.esc(s.stages[r.stage].title)));

      // Students
      var who = el('div', 'who');
      if (r.seats.length) {
        r.seats.forEach(function (q) {
          var row = el('div', 'who-row');
          var dot = el('span', 'who-dot' + (q.online ? '' : ' off'));
          dot.style.background = q.color;
          row.appendChild(dot);
          row.appendChild(el('span', q.online ? '' : 'muted',
            C.esc(q.name) + (q.online ? '' : ' (away)')));
          var k = el('button', 'ghost sm', '×');
          k.type = 'button';
          k.title = 'Remove ' + q.name + ' and free the seat';
          k.style.marginLeft = 'auto';
          k.addEventListener('click', function () {
            if (confirm('Remove ' + q.name + ' from Room ' + id + '?')) {
              send('fac:kickSeat', { roomId: id, seatId: q.seatId });
            }
          });
          row.appendChild(k);
          who.appendChild(row);
        });
      } else {
        who.appendChild(el('div', 'who-row muted', 'No students yet'));
      }
      card.appendChild(who);

      // Live model + estimate
      var ph = el('div', 'chart-host');
      card.appendChild(ph);
      var v = null;
      try {
        v = MV.compute(b, r.model);
        C.lineChart(ph, {
          years: b.years,
          series: [{ name: 'Gap', values: v.gap, color: C.cssVar('--series-1') }],
          vline: r.model.t0, vlabel: String(r.model.t0),
          zeroLine: true, height: 140, yDp: 1, directLabels: false
        });
      } catch (e) { ph.innerHTML = '<div class="tiny muted">Model could not be solved.</div>'; }

      var dl = el('dl', 'kv');
      dl.innerHTML =
        '<dt>Donors</dt><dd>' + r.model.donors.length + '/' + b.donors.length +
        (r.model.donors.length < b.donors.length
          ? ' <span class="muted">(dropped ' + C.esc(b.donors.filter(function (d) {
              return r.model.donors.indexOf(d) < 0; }).join(', ')) + ')</span>' : '') + '</dd>' +
        '<dt>Predictors</dt><dd>' + r.model.predictors.length + '/' +
        b.meanPredictors.length + ' + ' + r.model.lagYears.length + ' lags</dd>' +
        '<dt>Weights</dt><dd>' + C.esc(r.model.weightMode) + '</dd>' +
        '<dt>Year</dt><dd>' + r.model.t0 + '</dd>' +
        '<dt>View</dt><dd>' + C.esc(r.model.view) + '</dd>' +
        (v ? '<dt>Pre-fit</dt><dd>' + v.stats.rmspePre.toFixed(3) + '</dd>' +
             '<dt>Mean gap</dt><dd>' + (v.effect.fullPeriod >= 0 ? '+' : '') +
             v.effect.fullPeriod.toFixed(2) + '</dd>' +
             '<dt>Ratio</dt><dd>' + v.stats.ratio.toFixed(2) + '</dd>' : '');
      card.appendChild(dl);

      // Latest answer
      var latest = null;
      for (var i = s.stages.length - 1; i >= 0; i--) {
        var a = r.answers && r.answers[s.stages[i].key];
        if (a && a.text.trim()) { latest = { st: s.stages[i], a: a }; break; }
      }
      var ab = el('div');
      ab.style.cssText = 'border-top:1px solid var(--grid);padding-top:8px';
      if (latest) {
        ab.innerHTML = '<div class="tiny muted">Latest answer · ' + C.esc(latest.st.title) +
          (r.confidence && r.confidence[latest.st.key]
            ? ' · confidence ' + r.confidence[latest.st.key].value + '/5' : '') + '</div>' +
          '<div class="small">' + C.esc(latest.a.text.slice(0, 400)) +
          (latest.a.text.length > 400 ? '…' : '') + '</div>';
      } else {
        ab.innerHTML = '<div class="tiny muted">No written answer yet.</div>';
      }
      card.appendChild(ab);

      if (r.lastChange) {
        card.appendChild(el('div', 'tiny muted',
          C.esc(r.lastChange.by) + ' ' + C.esc(r.lastChange.what) + ' · ' + ago(r.lastChange.at)));
      }

      var btns = el('div', 'row-wrap');
      btns.style.marginTop = 'auto';
      var viewB = el('button', 'sm', 'View this room');
      viewB.type = 'button';
      viewB.addEventListener('click', function () { openRoomDrive(id); });
      btns.appendChild(viewB);

      var fz = el('button', 'sm' + (r.frozen ? ' on' : ''),
                  r.frozen ? 'Unfreeze room' : 'Freeze room');
      fz.type = 'button';
      fz.disabled = c.freezeAll;
      fz.title = c.freezeAll ? 'All rooms are already frozen' : '';
      fz.addEventListener('click', function () {
        send('fac:freezeRoom', { roomId: id, frozen: !r.frozen });
      });
      btns.appendChild(fz);

      var pres = el('button', 'sm', 'Present from here');
      pres.type = 'button';
      pres.addEventListener('click', function () { startPresenting(id); });
      btns.appendChild(pres);

      var rst = el('button', 'sm danger', 'Reset');
      rst.type = 'button';
      rst.addEventListener('click', function () {
        if (confirm('Reset Room ' + id + '?\n\nIts model, stage and all written answers are ' +
                    'cleared. Students stay connected. This cannot be undone.')) {
          send('fac:resetRoom', { roomId: id });
          toast('Room ' + id + ' reset.');
        }
      });
      btns.appendChild(rst);
      card.appendChild(btns);

      grid.appendChild(card);
    });
    App.body.appendChild(grid);
  }

  /** Drive one room's shared model directly (useful while that room is frozen). */
  function openRoomDrive(id) {
    var s = App.st, b = App.bundle;
    var scrim = el('div', 'scrim');
    var modal = el('div', 'modal wide');
    var head = el('div', 'spread');
    head.innerHTML = '<div><h2>Room ' + id + '</h2><p class="small secondary">' +
      'Changes you make here are written straight to Room ' + id +
      '\'s shared workspace and appear on its students\' screens.</p></div>';
    var x = el('button', 'ghost', 'Close');
    x.type = 'button';
    x.addEventListener('click', function () { scrim.remove(); App.driveId = null; });
    head.appendChild(x);
    modal.appendChild(head);
    var host = el('div');
    modal.appendChild(host);
    scrim.appendChild(modal);
    document.body.appendChild(scrim);
    scrim.addEventListener('click', function (e) {
      if (e.target === scrim) { scrim.remove(); App.driveId = null; }
    });

    var panel = new Panel(host, {
      bundle: b,
      onChange: function (patch) { send('fac:setRoomModel', { roomId: id, model: patch }); }
    });
    App.driveId = id;
    App.drivePanel = panel;
    App.driveScrim = scrim;
    panel.update({ model: s.rooms[id].model, locked: false });
  }

  /** Keep an open room-drive modal in step with incoming state. */
  function syncDrive() {
    if (!App.driveId || !App.drivePanel) return;
    if (!App.driveScrim || !document.body.contains(App.driveScrim)) {
      App.driveId = null; App.drivePanel = null; App.driveScrim = null;
      return;
    }
    App.drivePanel.update({ model: App.st.rooms[App.driveId].model, locked: false });
  }

  /* ------------------------------------------------------ presentation tab */

  function startPresenting(fromRoom) {
    if (!App.st.classroom.freezeAll) {
      send('fac:freezeAll');
    }
    send('fac:present', { on: true, fromRoom: fromRoom });
    App.tab = 'present';
    toast(fromRoom
      ? 'Presenting Room ' + fromRoom + '\'s model to the whole class.'
      : 'Presenting to the whole class.');
  }

  function renderPresent() {
    var s = App.st, b = App.bundle, c = s.classroom;
    App.body.innerHTML = '';

    if (!c.presenting) {
      var card = el('div', 'card pad');
      card.appendChild(el('h2', null, 'Presentation workspace'));
      card.appendChild(el('p', 'secondary',
        'Start presenting to put one analysis on every student\'s screen. Students watch and ' +
        'cannot change anything; each group\'s own work is kept and comes back when you stop.'));
      var row = el('div', 'row-wrap');
      var all = el('button', 'primary', 'Present to all rooms');
      all.type = 'button';
      all.addEventListener('click', function () { startPresenting(); });
      row.appendChild(all);
      s.config.roomIds.forEach(function (id) {
        var b2 = el('button', '', 'Start from Room ' + id);
        b2.type = 'button';
        b2.addEventListener('click', function () { startPresenting(id); });
        row.appendChild(b2);
      });
      card.appendChild(row);
      App.body.appendChild(card);
      App.panel = null;
      return;
    }

    var head = el('div', 'card pad');
    head.style.marginBottom = '14px';
    var hr = el('div', 'spread');
    var hl = el('div');
    hl.appendChild(el('h2', null, 'Presenting to all four rooms'));
    hl.appendChild(el('p', 'small secondary',
      'Everything you change below appears on every student screen immediately.'));
    hr.appendChild(hl);
    var apply = el('button', '', 'Apply this model to all rooms…');
    apply.type = 'button';
    apply.addEventListener('click', function () {
      if (confirm('Overwrite all four rooms\' shared models with the model you are ' +
                  'presenting?\n\nThis replaces the settings each group was working on. ' +
                  'Their written answers are not affected.')) {
        send('fac:applyToAll', { confirm: true, model: c.presentModel });
        toast('Applied the demonstrated model to all four rooms.');
      }
    });
    hr.appendChild(apply);
    head.appendChild(hr);

    var nav = el('div', 'stage-nav');
    nav.style.marginTop = '10px';
    s.stages.forEach(function (st, i) {
      var btn = el('button', 'stage-btn' + (i === c.presentStage ? ' on' : ''));
      btn.type = 'button';
      btn.innerHTML = '<span class="n">' + (i + 1) + '</span>' + C.esc(st.title);
      btn.addEventListener('click', function () { send('fac:presentStage', { stage: i }); });
      nav.appendChild(btn);
    });
    head.appendChild(nav);
    App.body.appendChild(head);

    // The panel's DOM is created once and re-parented, so its control state and
    // any in-progress slider drag survive a dashboard re-render.
    if (!App.presentHost) {
      App.presentHost = el('div');
      App.presentPanel = new Panel(App.presentHost, {
        bundle: b,
        onChange: function (patch) { send('fac:presentModel', { model: patch }); }
      });
    }
    App.body.appendChild(App.presentHost);
    App.presentPanel.update({ model: c.presentModel, locked: false });
  }

  /* ---------------------------------------------------------- compare tab */

  function renderCompare() {
    var s = App.st, b = App.bundle;
    App.body.innerHTML = '';
    var card = el('div', 'card pad');
    card.appendChild(el('h2', null, 'All four rooms, side by side'));
    card.appendChild(el('p', 'secondary',
      'Each room\'s own model, drawn on the same axes. Use this to open the discussion: ' +
      'the rooms made different choices, so they have different estimates.'));

    var views = [];
    s.config.roomIds.forEach(function (id) {
      try { views.push({ id: id, room: s.rooms[id], v: MV.compute(b, s.rooms[id].model) }); }
      catch (e) { views.push({ id: id, room: s.rooms[id], v: null }); }
    });

    // One chart, four gap lines
    var host = el('div', 'chart-host');
    host.style.marginTop = '12px';
    card.appendChild(host);
    var series = views.filter(function (x) { return x.v; }).map(function (x, i) {
      return {
        name: 'Room ' + x.id, values: x.v.gap,
        color: C.cssVar(Charts.SERIES[i % 8]), label: 'Room ' + x.id
      };
    });
    if (series.length) {
      C.lineChart(host, {
        years: b.years, series: series, vline: 2011, vlabel: '2011',
        zeroLine: true, height: 340, yDp: 1
      });
      card.appendChild(el('div', null, C.legend(series.map(function (x) {
        return { name: x.name, color: x.color };
      }))));
    }

    // Comparison table
    var t = '<div class="table-scroll" style="margin-top:16px"><table class="data"><thead><tr>' +
      '<th>Room</th><th>Stage</th><th>Donors</th><th>Weights</th><th>Year</th>' +
      '<th>Pre-fit</th><th>Mean gap</th><th>Peak gap</th><th>2023 gap</th><th>Ratio</th>' +
      '<th>Confidence</th></tr></thead><tbody>';
    views.forEach(function (x) {
      var r = x.room, v = x.v;
      var lastConf = null;
      s.stages.forEach(function (st) {
        if (r.confidence && r.confidence[st.key]) lastConf = r.confidence[st.key].value;
      });
      t += '<tr><td><strong>Room ' + x.id + '</strong></td><td>' + (r.stage + 1) + '</td>' +
        '<td>' + r.model.donors.length + '</td><td>' + C.esc(r.model.weightMode) + '</td>' +
        '<td>' + r.model.t0 + '</td>' +
        (v ? '<td>' + v.stats.rmspePre.toFixed(3) + '</td>' +
             '<td>' + (v.effect.fullPeriod >= 0 ? '+' : '') + v.effect.fullPeriod.toFixed(2) + '</td>' +
             '<td>' + (v.effect.peak ? (v.effect.peak.value >= 0 ? '+' : '') +
                       v.effect.peak.value.toFixed(2) + ' (' + v.effect.peak.year + ')' : '—') + '</td>' +
             '<td>' + (v.effect.latest >= 0 ? '+' : '') + v.effect.latest.toFixed(2) + '</td>' +
             '<td>' + v.stats.ratio.toFixed(2) + '</td>'
           : '<td colspan="5" class="muted">not solvable</td>') +
        '<td>' + (lastConf ? lastConf + '/5' : '—') + '</td></tr>';
    });
    t += '</tbody></table></div>';
    card.appendChild(el('div', null, t));

    // Full answers
    var ans = el('div');
    ans.style.marginTop = '18px';
    ans.appendChild(el('h4', null, 'Written answers'));
    s.stages.forEach(function (st) {
      var any = s.config.roomIds.some(function (id) {
        var a = s.rooms[id].answers && s.rooms[id].answers[st.key];
        return a && a.text.trim();
      });
      if (!any) return;
      var blk = el('div');
      blk.style.margin = '12px 0';
      blk.appendChild(el('div', 'small', '<strong>' + C.esc(st.title) + '</strong> — ' +
        C.esc(st.ask)));
      var g = el('div', 'fac-grid');
      g.style.marginTop = '8px';
      s.config.roomIds.forEach(function (id) {
        var a = s.rooms[id].answers && s.rooms[id].answers[st.key];
        if (!a || !a.text.trim()) return;
        var cc = el('div', 'card pad');
        var cf = s.rooms[id].confidence && s.rooms[id].confidence[st.key];
        cc.innerHTML = '<div class="tiny muted">Room ' + id +
          (cf ? ' · confidence ' + cf.value + '/5' : '') + '</div><div class="small">' +
          C.esc(a.text) + '</div>';
        g.appendChild(cc);
      });
      blk.appendChild(g);
      ans.appendChild(blk);
    });
    card.appendChild(ans);
    App.body.appendChild(card);
  }

  /* ---------------------------------------------------------------- export */

  function downloadExport(payload) {
    // JSON
    var json = JSON.stringify(payload, null, 2);
    dl('classroom-responses.json', 'application/json', json);
    // CSV of the answers, which is what most people actually want
    var rows = [['room', 'stage', 'stage_title', 'question', 'answer',
                 'confidence', 'last_editor', 'updated_at']];
    payload.rooms.forEach(function (r) {
      r.answers.forEach(function (a) {
        rows.push([r.room, a.stage, a.title, a.question, a.answer,
                   a.confidence === null ? '' : a.confidence,
                   a.lastEditor || '', a.updatedAt ? new Date(a.updatedAt).toISOString() : '']);
      });
    });
    var csv = rows.map(function (r) {
      return r.map(function (c) {
        var v = String(c === null || c === undefined ? '' : c);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',');
    }).join('\n');
    dl('classroom-responses.csv', 'text/csv', csv);
    toast('Exported JSON and CSV to your downloads.', 'info', 5000);
  }

  function dl(name, mime, text) {
    var blob = new Blob([text], { type: mime + ';charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 800);
  }

  window.addEventListener('DOMContentLoaded', boot);
}());
