/* Student client: room selection, the shared investigation, private
 * exploration, group answers, and the glossary. A student never sees another
 * room's work -- the room list shows only names and a head count. */
(function () {
  'use strict';
  var C = Charts, MV = ModelView;

  /* Each stage offers only the controls it needs. */
  var STAGE_CONTROLS = {
    s1: { views: ['levels'], show: [] },
    s2: { views: ['levels', 'gap'], show: ['weights', 'predictors'] },
    s3: { views: ['levels', 'gap', 'fuels', 'electricity'], show: [] },
    s4: { views: ['gap', 'placeboSpace', 'placeboTime', 'loo'], show: ['dropDonor', 't0'] },
    s5: { views: ['levels', 'gap'], show: [] }
  };

  var App = {
    bundle: null, net: null, st: null, panel: null,
    ack: {}, inflight: {}, dirty: {}
  };

  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  var SIGS = {};
  function ifChanged(key, sig, fn) {
    if (SIGS[key] === sig) return false;
    SIGS[key] = sig;
    fn();
    return true;
  }

  /* ------------------------------------------------------------------ boot */

  function boot() {
    try {
      if (localStorage.getItem('scm-large-text') === '1') {
        document.documentElement.classList.add('large-text');
      }
    } catch (e) { /* private browsing */ }

    fetch('data_bundle.json').then(function (r) { return r.json(); }).then(function (b) {
      App.bundle = b;
      App.net = new Net({ storeKey: 'scm-classroom-seat' });
      App.net.on('state', onState);
      App.net.on('connection', onConnection);
      App.net.on('denied', onDenied);
      App.net.on('answerAck', onAnswerAck);
      App.net.on('displaced', function () {
        App.st = null;
        toast('You opened this activity in another tab, so this one has left the room.',
              'warn', 8000);
      });
      App.net.connect();
      setInterval(function () { App.net.send({ type: 'ping' }); }, 20000);
    }).catch(function () {
      $('#app').innerHTML = '<div class="wrap-narrow"><div class="notice bad">' +
        '<span class="ic">!</span><div>Could not load the dataset. Reload the page.</div></div></div>';
    });
  }

  function onConnection(up) {
    var c = $('#conn');
    if (c) {
      c.className = 'conn' + (up ? '' : ' down');
      c.innerHTML = '<span class="dot"></span>' + (up ? '' : 'Reconnecting…');
    }
  }

  function onDenied(msg) {
    var why = {
      'frozen-all': 'Your facilitator has paused every room.',
      'frozen-room': 'Your facilitator has paused your room.',
      'presenting': 'Your facilitator is presenting to the whole class.',
      'name-required': 'Please enter a name.',
      'not-in-room': 'Join a room first.',
      'too-long': 'That answer is at its maximum length.'
    }[msg.reason] || ('That action was refused (' + msg.reason + ').');
    toast(why, 'info', 4000);
  }

  var toastTimer = null;
  function toast(text, kind, ms) {
    var host = $('#toast');
    host.innerHTML = '<div class="notice ' + (kind || 'info') + '"><span class="ic">' +
      (kind === 'warn' ? '!' : 'i') + '</span><div>' + C.esc(text) + '</div></div>';
    host.style.display = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { host.style.display = 'none'; }, ms || 4000);
  }

  function onState(s) {
    var wasIn = App.st && App.st.you.roomId;
    App.st = s;
    render();
    syncAnswersFromServer(!wasIn && !!s.you.roomId);
  }

  /* -------------------------------------------------------- mode reasoning */

  function modeOf() {
    var s = App.st;
    if (!s || !s.you.roomId) return { key: 'none' };
    var c = s.classroom;
    if (c.presenting) return { key: 'present' };
    if (c.freezeAll) return { key: 'frozen', scope: 'all' };
    if (c.frozenRooms[s.you.roomId]) return { key: 'frozen', scope: 'room' };
    if (s.myPrivate && s.myPrivate.active) return { key: 'private' };
    return { key: 'group' };
  }
  function isLocked() {
    var m = modeOf();
    return m.key === 'frozen' || m.key === 'present';
  }
  function activeModel() {
    var s = App.st, m = modeOf();
    if (m.key === 'present' && s.classroom.presentModel) return s.classroom.presentModel;
    if (m.key === 'private' && s.myPrivate) return s.myPrivate.model;
    return s.rooms[s.you.roomId].model;
  }

  /* ---------------------------------------------------------------- render */

  function render() {
    var s = App.st;
    if (!s) return;
    if (!s.you.roomId) { App.panel = null; App.shellFor = null; SIGS = {}; renderLobby(); return; }
    renderRoom();
  }

  /* ------------------------------------------------------------ room picker */

  function renderLobby() {
    var s = App.st, b = App.bundle;
    var root = $('#app');
    var intro = CONTENT.INTRO;
    root.innerHTML = '';
    var wrap = el('div', 'wrap-narrow');

    var head = el('div', 'lobby-head');
    head.appendChild(el('h1', 'serif', C.esc(intro.title)));
    head.appendChild(el('p', 'secondary', C.esc(intro.subtitle)));
    wrap.appendChild(head);

    var about = el('div', 'card pad about');
    intro.blocks.slice(0, 2).forEach(function (bk) {
      about.appendChild(el('p', null, '<strong>' + C.esc(bk.lead) + '</strong> ' + C.esc(bk.text)));
    });
    wrap.appendChild(about);

    var pick = el('div');
    pick.style.marginTop = '28px';
    pick.appendChild(el('h2', null, 'Pick your breakout room'));
    pick.appendChild(el('p', 'muted', 'Choose the room your facilitator assigned you.'));
    wrap.appendChild(pick);

    var grid = el('div', 'room-grid');
    grid.style.marginTop = '16px';
    s.config.roomIds.forEach(function (id) {
      var r = s.rooms[id];
      var card = el('button', 'room-card');
      card.type = 'button';
      card.appendChild(el('div', 'rc-name', 'Room ' + id));

      var n = r.occupancy;
      var occ = el('div', 'rc-occ' + (n === 0 ? ' empty' : ''),
                   n === 0 ? 'Empty' : n + (n === 1 ? ' person here' : ' people here'));
      card.appendChild(occ);

      var who = el('div', 'who');
      if (r.seats && r.seats.length) {
        r.seats.slice(0, 8).forEach(function (st) {
          var row = el('div', 'who-row');
          var dot = el('span', 'who-dot' + (st.online ? '' : ' off'));
          dot.style.background = st.color;
          row.appendChild(dot);
          row.appendChild(el('span', st.online ? '' : 'muted',
            C.esc(st.name) + (st.online ? '' : ' (away)')));
          who.appendChild(row);
        });
        if (r.seats.length > 8) {
          who.appendChild(el('div', 'who-row muted', '+' + (r.seats.length - 8) + ' more'));
        }
      } else {
        who.appendChild(el('div', 'who-row muted', 'No one here yet'));
      }
      card.appendChild(who);
      card.addEventListener('click', function () { askName(id); });
      grid.appendChild(card);
    });
    wrap.appendChild(grid);

    var foot = el('div', 'small muted');
    foot.style.marginTop = '26px';
    foot.innerHTML = 'Everything you change inside a room is shared with the people in ' +
      'that room, and with nobody else. You can move to a different room at any time.';
    wrap.appendChild(foot);

    var fac = el('div', 'tiny muted');
    fac.style.marginTop = '10px';
    fac.innerHTML = '<a href="facilitator" target="_blank" rel="noopener">' +
      'Facilitator? Open the dashboard</a>';
    wrap.appendChild(fac);

    root.appendChild(wrap);
  }

  function askName(roomId) {
    var seat = App.net.seat();
    var scrim = el('div', 'scrim');
    var modal = el('div', 'modal');
    modal.appendChild(el('h2', null, 'Join Room ' + roomId));
    modal.appendChild(el('p', 'secondary small',
      'Your group will see this name next to the changes you make.'));
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = 'Your name or nickname';
    inp.maxLength = 40;
    inp.value = (seat && seat.name) || '';
    modal.appendChild(inp);
    var err = el('div', 'tiny');
    err.style.cssText = 'color:var(--critical);min-height:16px;margin-top:4px';
    modal.appendChild(err);
    var row = el('div', 'row');
    row.style.cssText = 'margin-top:14px;justify-content:flex-end';
    var cancel = el('button', 'ghost', 'Cancel');
    cancel.type = 'button';
    var go = el('button', 'primary', 'Join room');
    go.type = 'button';
    row.appendChild(cancel); row.appendChild(go);
    modal.appendChild(row);
    scrim.appendChild(modal);
    document.body.appendChild(scrim);
    setTimeout(function () { inp.focus(); inp.select(); }, 30);

    function close() { scrim.remove(); }
    function submit() {
      var name = inp.value.trim();
      if (!name) { err.textContent = 'Please enter a name.'; inp.focus(); return; }
      App.net.send({ type: 'join', roomId: roomId, name: name });
      close();
    }
    cancel.addEventListener('click', close);
    go.addEventListener('click', submit);
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') close();
    });
    scrim.addEventListener('click', function (e) { if (e.target === scrim) close(); });
  }

  /* ------------------------------------------------------------- room view */

  function renderRoom() {
    var s = App.st, b = App.bundle;
    var room = s.rooms[s.you.roomId];
    var mode = modeOf();
    var locked = isLocked();
    var root = $('#app');

    if (App.shellFor !== s.you.roomId) {
      root.innerHTML = '';
      App.shellFor = s.you.roomId;
      App.panel = null;
      SIGS = {};

      App.freezeBar = el('div', 'freeze-bar');
      root.appendChild(App.freezeBar);
      App.roomBar = el('div', 'room-bar');
      root.appendChild(App.roomBar);

      var wrap = el('div', 'wrap');

      var head = el('div', 'act-head');
      var ht = el('div');
      ht.appendChild(el('h1', 'serif', C.esc(CONTENT.INTRO.title)));
      ht.appendChild(el('p', 'secondary', C.esc(CONTENT.INTRO.subtitle)));
      head.appendChild(ht);
      var tools = el('div', 'row-wrap');
      var gloss = el('button', 'always', 'What do these words mean?');
      gloss.type = 'button';
      gloss.addEventListener('click', openGlossary);
      tools.appendChild(gloss);
      var bigger = el('button', 'ghost always', 'Larger text');
      bigger.type = 'button';
      bigger.addEventListener('click', function () {
        var on = document.documentElement.classList.toggle('large-text');
        try { localStorage.setItem('scm-large-text', on ? '1' : '0'); } catch (e) {}
      });
      tools.appendChild(bigger);
      head.appendChild(tools);
      wrap.appendChild(head);

      App.introHost = el('div');
      wrap.appendChild(App.introHost);

      App.stageNav = el('div', 'stage-nav');
      wrap.appendChild(App.stageNav);

      App.noticeHost = el('div');
      App.noticeHost.style.margin = '12px 0';
      wrap.appendChild(App.noticeHost);

      var cols = el('div', 'cols');
      App.panelHost = el('div', 'readonly-veil stack');
      cols.appendChild(App.panelHost);
      App.sideHost = el('div', 'stack');
      cols.appendChild(App.sideHost);
      wrap.appendChild(cols);

      root.appendChild(wrap);
      renderIntroCard();
    }

    renderFreezeBar(mode);
    renderRoomBar(mode, room);
    renderStageNav(room, mode, locked);
    renderNotices(mode, room);

    var showStage = mode.key === 'present' ? s.classroom.presentStage : room.stage;
    var stage = s.stages[showStage];
    var controls = STAGE_CONTROLS[stage.key] || { views: ['levels'], show: [] };

    if (!App.panel) {
      App.panel = new Panel(App.panelHost, {
        bundle: b,
        onChange: function (patch, label) {
          var m = modeOf();
          if (m.key === 'private') App.net.send({ type: 'privateSetModel', model: patch });
          else App.net.send({ type: 'setModel', model: patch, label: label });
        }
      });
    }
    var model = activeModel();
    // Keep the view inside what this stage offers
    if (controls.views.indexOf(model.view) < 0) {
      model = Object.assign({}, model, { view: controls.views[0] });
    }
    App.panel.update({
      model: model, locked: locked, controls: controls, stageKey: stage.key
    });
    App.panelHost.dataset.locked = locked ? '1' : '0';

    renderSide(room, stage, showStage, locked, mode);
  }

  function renderIntroCard() {
    var intro = CONTENT.INTRO;
    var d = el('details', 'card pad about-card');
    var sm = document.createElement('summary');
    sm.innerHTML = '<strong>About this activity</strong> — what you are doing and how the room works';
    d.appendChild(sm);
    intro.blocks.forEach(function (bk) {
      d.appendChild(el('p', null, '<strong>' + C.esc(bk.lead) + '</strong> ' + C.esc(bk.text)));
    });
    try { d.open = localStorage.getItem('scm-intro-seen') !== '1'; } catch (e) { d.open = true; }
    d.addEventListener('toggle', function () {
      if (!d.open) { try { localStorage.setItem('scm-intro-seen', '1'); } catch (e) {} }
    });
    App.introHost.appendChild(d);
  }

  function renderFreezeBar(mode) {
    var txt = mode.key === 'frozen'
      ? 'Paused by your facilitator. You can look, but you cannot change anything until ' +
        'the session resumes.'
      : mode.key === 'present'
        ? 'Your facilitator is presenting. Everyone is seeing the same analysis; your ' +
          'group’s own work is saved and comes back afterwards.'
        : '';
    ifChanged('freeze', txt, function () {
      App.freezeBar.textContent = txt;
      App.freezeBar.style.display = txt ? '' : 'none';
      App.freezeBar.className = 'freeze-bar' + (mode.key === 'present' ? ' presenting' : '');
    });
  }

  function renderRoomBar(mode, room) {
    var s = App.st;
    var priv = s.myPrivate || {};
    var sig = [mode.key, s.you.roomId, room.occupancy, priv.active, priv.suspended,
               isLocked(), App.net.connected,
               room.seats.map(function (q) { return q.seatId + q.name + q.online; }).join(',')
              ].join('|');
    if (SIGS.roomBar === sig) return;
    SIGS.roomBar = sig;

    App.roomBar.innerHTML = '';
    var left = el('div', 'rb-left');
    left.appendChild(el('span', 'live-dot'));
    left.appendChild(el('strong', null, 'Room ' + s.you.roomId));
    var n = room.occupancy;
    left.appendChild(el('span', 'muted small',
      n + (n === 1 ? ' here' : ' here')));

    room.seats.forEach(function (q) {
      var chip = el('span', 'person-chip' + (q.online ? '' : ' off'));
      var dot = el('span', 'who-dot');
      dot.style.background = q.color;
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(
        q.name + (q.seatId === s.you.seatId ? ' (you)' : '')));
      if (q.seatId === s.you.seatId && mode.key === 'private') {
        chip.appendChild(el('em', 'tiny', ' (exploring on their own)'));
      }
      left.appendChild(chip);
    });
    App.roomBar.appendChild(left);

    var right = el('div', 'rb-right');
    if (mode.key === 'private') {
      right.appendChild(el('span', 'explore-note',
        'You’re exploring on your own: your group can’t see your changes, and ' +
        'they won’t be kept when you rejoin.'));
    }

    var changeRoom = el('button', 'linkish always', 'Change room');
    changeRoom.type = 'button';
    changeRoom.addEventListener('click', function () {
      if (confirm('Leave Room ' + s.you.roomId + ' and pick a different one?\n\n' +
                  'Your group keeps its work.')) {
        App.net.send({ type: 'leave' });
      }
    });
    right.appendChild(changeRoom);

    var facLink = el('a', 'linkish', 'Facilitator?');
    facLink.href = 'facilitator';
    facLink.target = '_blank';
    facLink.rel = 'noopener';
    right.appendChild(facLink);

    if (mode.key === 'private') {
      var rejoin = el('button', 'primary always', 'Rejoin the group');
      rejoin.type = 'button';
      rejoin.addEventListener('click', function () { App.net.send({ type: 'privateStop' }); });
      right.appendChild(rejoin);
      var prop = el('button', 'sm', 'Propose to my group');
      prop.type = 'button';
      prop.disabled = isLocked();
      prop.addEventListener('click', proposeToGroup);
      right.appendChild(prop);
    } else {
      var go = el('button', 'always', 'Explore on your own');
      go.type = 'button';
      go.addEventListener('click', function () { App.net.send({ type: 'privateStart' }); });
      right.appendChild(go);
    }

    var conn = el('span', 'conn');
    conn.id = 'conn';
    conn.innerHTML = '<span class="dot"></span>' + (App.net.connected ? '' : 'Reconnecting…');
    if (!App.net.connected) conn.className = 'conn down';
    right.appendChild(conn);

    App.roomBar.appendChild(right);
  }

  function renderStageNav(room, mode, locked) {
    var s = App.st;
    var showStage = mode.key === 'present' ? s.classroom.presentStage : room.stage;
    if (SIGS.stageNav === showStage + '|' + locked) return;
    SIGS.stageNav = showStage + '|' + locked;
    App.stageNav.innerHTML = '';
    s.stages.forEach(function (st, i) {
      var btn = el('button', 'stage-pill' + (i === showStage ? ' on' : ''));
      btn.type = 'button';
      btn.textContent = (i + 1) + ' ' + st.title;
      btn.disabled = locked;
      btn.addEventListener('click', function () {
        App.net.send({ type: 'setStage', stage: i });
      });
      App.stageNav.appendChild(btn);
    });
  }

  function renderNotices(mode, room) {
    var s = App.st, h = '';
    var sig = [mode.key, (s.myPrivate && s.myPrivate.suspended),
               (room.proposals || []).map(function (p) { return p.id; }).join(',')].join('|');
    if (SIGS.notices === sig) return;
    SIGS.notices = sig;

    if (s.myPrivate && s.myPrivate.active && s.myPrivate.suspended && mode.key !== 'private') {
      h += '<div class="notice warn"><span class="ic">⏸</span><div>Your private ' +
        'workspace is paused while the facilitator has the floor. It will come back as ' +
        'you left it.</div></div>';
    }
    (room.proposals || []).forEach(function (p) {
      var mine = p.from === s.you.seatId;
      h += '<div class="notice info"><span class="ic">▸</span><div><strong>' +
        C.esc(p.fromName) + '</strong> proposes a model from their own exploration. ' +
        'Applying it replaces your group’s current settings.' +
        (mine ? ' <span class="muted">(your proposal — someone else should accept it)</span>'
              : ' <button class="sm primary" data-accept="' + C.esc(p.id) + '">Apply to group</button>' +
                ' <button class="sm ghost" data-reject="' + C.esc(p.id) + '">Dismiss</button>') +
        '</div></div>';
    });
    App.noticeHost.innerHTML = h;
    App.noticeHost.querySelectorAll('[data-accept]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        App.net.send({ type: 'applyProposal', proposalId: btn.dataset.accept, accept: true });
      });
    });
    App.noticeHost.querySelectorAll('[data-reject]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        App.net.send({ type: 'applyProposal', proposalId: btn.dataset.reject, accept: false });
      });
    });
  }

  /* ------------------------------------------ right column: prose + answer */

  function renderSide(room, stage, showStage, locked, mode) {
    var content = CONTENT.STAGE_CONTENT[stage.key];
    if (SIGS.sideStage !== stage.key) {
      SIGS.sideStage = stage.key;
      App.sideHost.innerHTML = '';
      var card = el('div', 'card pad prose');
      card.appendChild(el('h2', null, C.esc(content.heading)));
      content.blocks.forEach(function (bk) {
        card.appendChild(el('p', null,
          '<strong>' + C.esc(bk.lead) + '</strong> ' + C.esc(bk.text)));
      });
      App.sideHost.appendChild(card);

      App.answerHost = el('div', 'card pad readonly-veil');
      App.sideHost.appendChild(App.answerHost);
      App.answerKey = null;
      App.activityHost = el('div', 'tiny muted');
      App.sideHost.appendChild(App.activityHost);
    }
    renderAnswer(room, stage, locked);
    renderActivity(room);
  }

  function renderAnswer(room, stage, locked) {
    var key = stage.key;
    var doc = (room.answers && room.answers[key]) || { text: '', version: 0, lastEditor: null };

    if (App.answerKey !== key) {
      App.answerKey = key;
      App.answerHost.innerHTML = '';
      App.answerHost.appendChild(el('h4', null, 'Your group’s answer'));
      App.answerHost.appendChild(el('p', 'question', C.esc(stage.ask)));
      App.ta = document.createElement('textarea');
      App.ta.placeholder = 'Everyone in your room writes here. You will see each other type.';
      App.ta.value = doc.text;
      App.ta.addEventListener('input', onAnswerInput);
      App.answerHost.appendChild(App.ta);
      App.answerMeta = el('div', 'answer-meta');
      App.answerHost.appendChild(App.answerMeta);
      App.ack[key] = { text: doc.text, version: doc.version };
      SIGS.answerMeta = null;
    }

    App.ta.disabled = locked;
    App.answerHost.dataset.locked = locked ? '1' : '0';

    var conf = (room.confidence && room.confidence[key]) || null;
    var meta = '<div class="small muted">' + (doc.lastEditor
      ? 'Last edited by ' + C.esc(doc.lastEditor) + ' · saved automatically'
      : 'Saved automatically as you type') + '</div>' +
      '<div class="row-wrap small"><span class="muted">How sure are you?</span>' +
      [[1, 'Guessing'], [3, 'Fairly sure'], [5, 'Sure']].map(function (p) {
        return '<button class="opt sm' + (conf && conf.value === p[0] ? ' on' : '') +
               '" data-conf="' + p[0] + '"' + (locked ? ' disabled' : '') + '>' + p[1] + '</button>';
      }).join('') + '</div>';
    if (SIGS.answerMeta === meta) return;
    SIGS.answerMeta = meta;
    App.answerMeta.innerHTML = meta;
    App.answerMeta.querySelectorAll('[data-conf]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        App.net.send({ type: 'confidence', stageKey: key,
                       value: parseInt(btn.dataset.conf, 10) });
      });
    });
  }

  function renderActivity(room) {
    if (!room.lastChange) { App.activityHost.innerHTML = ''; return; }
    var h = 'Last change: <strong>' + C.esc(room.lastChange.by) + '</strong> ' +
            C.esc(room.lastChange.what) + ' · ' + ago(room.lastChange.at);
    if (SIGS.activity === h) return;
    SIGS.activity = h;
    App.activityHost.innerHTML = h;
  }

  function ago(ts) {
    var d = Math.max(0, Date.now() - ts) / 1000;
    if (d < 10) return 'just now';
    if (d < 60) return Math.round(d) + 's ago';
    if (d < 3600) return Math.round(d / 60) + ' min ago';
    return Math.round(d / 3600) + ' h ago';
  }

  /* ------------------------------------------------------- group answers */

  function onAnswerInput() {
    var key = App.answerKey;
    if (!App.ack[key]) App.ack[key] = { text: '', version: 0 };
    if (App.inflight[key]) { App.dirty[key] = true; return; }
    flushAnswer(key);
  }

  function flushAnswer(key) {
    var ack = App.ack[key];
    var op = OT.diff(ack.text, App.ta.value);
    if (!op) { App.dirty[key] = false; return; }
    App.inflight[key] = true;
    App.dirty[key] = false;
    App.net.send({ type: 'answer', stageKey: key, op: op, baseVersion: ack.version });
  }

  function onAnswerAck(msg) {
    var key = msg.stageKey;
    App.ack[key] = { text: msg.text, version: msg.version };
    App.inflight[key] = false;
    if (key !== App.answerKey || !App.ta) return;
    if (App.dirty[key]) { flushAnswer(key); return; }
    if (App.ta.value !== msg.text) setTextPreservingCaret(msg.text);
  }

  function setTextPreservingCaret(next) {
    var ta = App.ta;
    var before = ta.value;
    var selS = ta.selectionStart, selE = ta.selectionEnd;
    var op = OT.diff(before, next);
    ta.value = next;
    if (op) {
      var s = OT.xformCaret(selS, op), e = OT.xformCaret(selE, op);
      try { ta.setSelectionRange(s, e); } catch (err) { /* ignore */ }
    }
  }

  function syncAnswersFromServer(force) {
    var s = App.st;
    if (!s || !s.you.roomId || !App.ta) return;
    var room = s.rooms[s.you.roomId];
    var key = App.answerKey;
    var doc = (room.answers && room.answers[key]) || { text: '', version: 0 };
    var ack = App.ack[key] || { text: '', version: -1 };
    if (App.inflight[key] || App.dirty[key]) return;
    if (!force && doc.version === ack.version) return;
    App.ack[key] = { text: doc.text, version: doc.version };
    if (App.ta.value !== doc.text) setTextPreservingCaret(doc.text);
  }

  /* --------------------------------------------------------- private mode */

  function proposeToGroup() {
    if (!confirm('Send your private settings to your group as a proposal?\n\n' +
                 'Nothing changes for them until one of them accepts it.')) return;
    App.net.send({ type: 'proposeToGroup' });
    toast('Proposal sent. One of your group-mates needs to apply it.', 'info', 5000);
  }

  /* ------------------------------------------------------------- glossary */

  function openGlossary() {
    var scrim = el('div', 'scrim');
    var modal = el('div', 'modal wide glossary');
    var head = el('div', 'spread');
    var h = el('div');
    h.appendChild(el('h2', null, 'What do these words mean?'));
    h.appendChild(el('p', 'small secondary',
      'Every term this activity uses, in plain language. Nothing here assumes you ' +
      'have met synthetic control before.'));
    head.appendChild(h);
    var x = el('button', 'ghost', 'Close');
    x.type = 'button';
    x.addEventListener('click', close);
    head.appendChild(x);
    modal.appendChild(head);

    var search = document.createElement('input');
    search.type = 'text';
    search.placeholder = 'Search for a word…';
    search.style.margin = '10px 0 4px';
    modal.appendChild(search);

    var body = el('div');
    modal.appendChild(body);

    function draw(q) {
      q = (q || '').trim().toLowerCase();
      body.innerHTML = '';
      var any = false;
      CONTENT.GLOSSARY.forEach(function (grp) {
        var hits = grp.terms.filter(function (t) {
          return !q || t.term.toLowerCase().indexOf(q) >= 0 ||
                 t.def.toLowerCase().indexOf(q) >= 0;
        });
        if (!hits.length) return;
        any = true;
        body.appendChild(el('h4', 'gloss-group', C.esc(grp.group)));
        hits.forEach(function (t) {
          var d = el('div', 'gloss-item');
          d.appendChild(el('dt', null, C.esc(t.term)));
          d.appendChild(el('dd', null, C.esc(t.def)));
          body.appendChild(d);
        });
      });
      if (!any) body.appendChild(el('p', 'muted', 'Nothing matches “' + C.esc(q) + '”.'));
    }
    draw('');
    search.addEventListener('input', function () { draw(search.value); });

    scrim.appendChild(modal);
    document.body.appendChild(scrim);
    setTimeout(function () { search.focus(); }, 40);
    scrim.addEventListener('click', function (e) { if (e.target === scrim) close(); });
    document.addEventListener('keydown', esc);
    function esc(e) { if (e.key === 'Escape') close(); }
    function close() {
      scrim.remove();
      document.removeEventListener('keydown', esc);
    }
  }

  window.addEventListener('DOMContentLoaded', boot);
}());
