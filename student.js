/* Student client: room selection, the shared investigation, private
 * exploration, group answers, and the classroom overview. */
(function () {
  'use strict';
  var C = Charts, MV = ModelView;

  var App = {
    bundle: null, net: null, st: null, panel: null,
    ack: {}, inflight: {}, dirty: {}, overviewOpen: false, lastDenied: null
  };

  function $(sel) { return document.querySelector(sel); }

  /* Re-render a region only when its contents would actually differ. State
     broadcasts arrive whenever anyone in any room changes anything, and
     rebuilding a region replaces its buttons -- a click landing in that gap
     would hit a detached node. Guarding on a signature keeps controls stable. */
  var SIGS = {};
  function ifChanged(key, sig, fn) {
    if (SIGS[key] === sig) return false;
    SIGS[key] = sig;
    fn();
    return true;
  }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  /* ------------------------------------------------------------------ boot */

  function boot() {
    fetch('data_bundle.json').then(function (r) { return r.json(); }).then(function (b) {
      App.bundle = b;
      App.net = new Net({ storeKey: 'scm-classroom-seat' });
      App.net.on('state', onState);
      App.net.on('connection', onConnection);
      App.net.on('denied', onDenied);
      App.net.on('answerAck', onAnswerAck);
      App.net.on('displaced', function () {
        App.st = null;
        toast('You opened this activity in another tab, so this one has left the room.', 'warn', 8000);
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
      c.innerHTML = '<span class="dot"></span>' + (up ? 'Live' : 'Reconnecting…');
    }
  }

  function onDenied(msg) {
    var why = {
      'frozen-all': 'The facilitator has paused every room.',
      'frozen-room': 'The facilitator has paused your room.',
      'presenting': 'The facilitator is presenting to the whole class.',
      'room-full': 'That room already has four students.',
      'name-required': 'Please enter a name.',
      'not-in-room': 'Join a room first.',
      'too-long': 'That answer is at its maximum length.'
    }[msg.reason] || ('That action was refused (' + msg.reason + ').');
    toast(why, msg.reason === 'room-full' ? 'warn' : 'info', 4500);
    if (msg.reason === 'room-full') render();
  }

  var toastTimer = null;
  function toast(text, kind, ms) {
    var host = $('#toast');
    host.innerHTML = '<div class="notice ' + (kind || 'info') + '"><span class="ic">' +
      (kind === 'warn' ? '!' : kind === 'bad' ? '!' : 'i') + '</span><div>' +
      C.esc(text) + '</div></div>';
    host.style.display = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { host.style.display = 'none'; }, ms || 4000);
  }

  function onState(s) {
    var wasIn = App.st && App.st.you.roomId;
    App.st = s;
    render();
    if (!wasIn && s.you.roomId) syncAnswersFromServer(true);
    else syncAnswersFromServer(false);
    if (App.overviewOpen) renderOverview();
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
  /** Which model this student is looking at right now. */
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
    root.innerHTML = '';
    var wrap = el('div', 'wrap-narrow');

    wrap.appendChild(el('h1', null,
      "Did Germany's Nuclear Phase-Out Increase CO₂ Emissions?"));
    wrap.appendChild(el('p', 'secondary',
      'A synthetic-control investigation using the published panel of twelve European ' +
      'countries, 1990–2023.'));

    var head = el('div');
    head.style.margin = '30px 0 4px';
    head.appendChild(el('h2', null, 'Pick your breakout room'));
    wrap.appendChild(head);
    wrap.appendChild(el('p', 'muted', 'Choose the room your facilitator assigned you.'));

    var grid = el('div', 'room-grid');
    grid.style.marginTop = '18px';
    s.config.roomIds.forEach(function (id) {
      var r = s.rooms[id];
      var full = r.occupancy >= r.capacity;
      var card = el('button', 'room-card');
      card.type = 'button';
      card.disabled = full;

      var occText = r.occupancy === 0 ? 'Empty'
        : full ? 'Full — ' + r.occupancy + '/' + r.capacity + ' students'
        : r.occupancy + '/' + r.capacity + ' students';
      var occCls = r.occupancy === 0 ? 'empty' : full ? 'full' : '';

      card.appendChild(el('div', 'rc-name', 'Room ' + id));
      card.appendChild(el('div', 'rc-occ ' + occCls, occText));

      var pips = el('div', 'seat-pips');
      for (var i = 0; i < r.capacity; i++) {
        pips.appendChild(el('span', 'seat-pip' + (i < r.occupancy ? ' on' : '')));
      }
      card.appendChild(pips);

      var who = el('div', 'who');
      if (r.seats.length) {
        r.seats.forEach(function (st) {
          var row = el('div', 'who-row');
          row.appendChild(el('span', 'who-dot' + (st.online ? '' : ' off'))).style.background = st.color;
          row.appendChild(el('span', st.online ? '' : 'muted', C.esc(st.name) +
            (st.online ? '' : ' (away)')));
          who.appendChild(row);
        });
      } else {
        who.appendChild(el('div', 'who-row muted', 'No one here yet'));
      }
      card.appendChild(who);

      if (!full) card.addEventListener('click', function () { askName(id); });
      grid.appendChild(card);
    });
    wrap.appendChild(grid);

    var foot = el('div', 'small muted');
    foot.style.marginTop = '26px';
    foot.innerHTML = 'Each room holds four students and has its own shared workspace. ' +
      'Everything you change inside a room is visible to your group straight away.';
    wrap.appendChild(foot);
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

    // Build the shell once, then update in place
    if (!App.shellFor || App.shellFor !== s.you.roomId) {
      root.innerHTML = '';
      App.shellFor = s.you.roomId;
      App.panel = null;
      SIGS = {};

      App.modeBar = el('div', 'mode-bar');
      root.appendChild(App.modeBar);

      var wrap = el('div', 'wrap');
      App.noticeHost = el('div');
      App.noticeHost.style.marginBottom = '14px';
      wrap.appendChild(App.noticeHost);

      App.stageHost = el('div', 'card pad');
      App.stageHost.style.marginBottom = '16px';
      wrap.appendChild(App.stageHost);

      App.panelHost = el('div', 'readonly-veil');
      wrap.appendChild(App.panelHost);

      App.answerHost = el('div', 'card pad readonly-veil');
      App.answerHost.style.marginTop = '16px';
      wrap.appendChild(App.answerHost);

      App.activityHost = el('div', 'small muted');
      App.activityHost.style.marginTop = '14px';
      wrap.appendChild(App.activityHost);

      root.appendChild(wrap);
    }

    renderModeBar(mode, room);
    renderNotices(mode, room);
    renderStageHeader(room, mode, locked);

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
    App.panel.update({ model: activeModel(), locked: locked });
    App.panelHost.dataset.locked = locked ? '1' : '0';

    renderAnswer(room, locked, mode);
    renderActivity(room);
  }

  function renderModeBar(mode, room) {
    var s = App.st;
    var priv0 = s.myPrivate || {};
    var sig = [mode.key, mode.scope || '', s.you.roomId, App.net.connected,
               priv0.active, priv0.suspended, isLocked(),
               room.seats.map(function (q) {
                 return q.seatId + ':' + q.name + ':' + q.online;
               }).join(',')].join('|');
    if (SIGS.modeBar === sig) return;
    SIGS.modeBar = sig;
    var cls = { group: 'mode-group', private: 'mode-private', frozen: 'mode-frozen',
                present: 'mode-present' }[mode.key] || 'mode-group';
    App.modeBar.className = 'mode-bar ' + cls;
    var title = {
      group: 'Group Mode — Room ' + s.you.roomId,
      private: 'Exploring on your own',
      frozen: 'Paused by your facilitator',
      present: 'Facilitator is presenting'
    }[mode.key];
    var sub = {
      group: 'Changes you make are shared with your group',
      private: 'Your changes are private and will not affect your group',
      frozen: 'You can look, but you cannot change anything until the session resumes',
      present: 'You are watching the facilitator\'s screen'
    }[mode.key];

    App.modeBar.innerHTML = '';
    var what = el('div', 'what');
    what.appendChild(el('span', 'mode-dot'));
    var txt = el('div');
    txt.appendChild(el('div', null, C.esc(title)));
    txt.appendChild(el('div', 'tiny', C.esc(sub)));
    txt.children[0].style.lineHeight = '1.2';
    what.appendChild(txt);
    App.modeBar.appendChild(what);

    var right = el('div', 'row-wrap');

    // Who is here
    var people = el('div', 'row-wrap');
    people.style.gap = '8px';
    room.seats.forEach(function (st) {
      var tag = el('span', 'legend-item');
      var dot = el('span', 'who-dot' + (st.online ? '' : ' off'));
      dot.style.background = st.color;
      tag.appendChild(dot);
      tag.appendChild(document.createTextNode(st.name +
        (st.seatId === App.st.you.seatId ? ' (you)' : '')));
      people.appendChild(tag);
    });
    right.appendChild(people);
    right.appendChild(el('div', null, '<span class="sep" style="display:inline-block;width:1px;height:20px;background:var(--border-strong)"></span>'));

    // Private mode toggle
    var priv = App.st.myPrivate;
    if (mode.key === 'private') {
      var rejoin = el('button', 'primary always', 'Rejoin the group');
      rejoin.type = 'button';
      rejoin.addEventListener('click', function () {
        App.net.send({ type: 'privateStop' });
      });
      right.appendChild(rejoin);
      var prop = el('button', 'sm', 'Propose this to my group');
      prop.type = 'button';
      prop.disabled = isLocked();
      prop.addEventListener('click', proposeToGroup);
      right.appendChild(prop);
    } else {
      var go = el('button', 'always', 'Explore on your own');
      go.type = 'button';
      go.addEventListener('click', function () {
        App.net.send({ type: 'privateStart' });
      });
      right.appendChild(go);
    }

    var ov = el('button', 'ghost always', 'Classroom Overview');
    ov.type = 'button';
    ov.addEventListener('click', openOverview);
    right.appendChild(ov);

    var conn = el('span', 'conn');
    conn.id = 'conn';
    conn.innerHTML = '<span class="dot"></span>' + (App.net.connected ? 'Live' : 'Reconnecting…');
    if (!App.net.connected) conn.className = 'conn down';
    right.appendChild(conn);

    var leave = el('button', 'ghost sm always', 'Leave');
    leave.type = 'button';
    leave.addEventListener('click', function () {
      if (confirm('Leave the room? Your group keeps its work, and your seat is freed.')) {
        App.net.send({ type: 'leave' });
      }
    });
    right.appendChild(leave);

    App.modeBar.appendChild(right);
  }

  function renderNotices(mode, room) {
    var s = App.st, h = '';
    var sigN = [mode.key, mode.scope || '',
                (s.myPrivate && s.myPrivate.active) + ':' + (s.myPrivate && s.myPrivate.suspended),
                (room.proposals || []).map(function (p) { return p.id; }).join(',')].join('|');
    if (SIGS.notices === sigN) return;
    SIGS.notices = sigN;
    if (mode.key === 'frozen') {
      h += '<div class="notice warn"><span class="ic">⏸</span><div><strong>Paused by your ' +
        'facilitator.</strong> You can look, but you cannot change anything until the ' +
        'session resumes.' +
        (mode.scope === 'room' ? ' Only your room is paused.' : '') + '</div></div>';
    }
    if (mode.key === 'present') {
      h += '<div class="notice info"><span class="ic">▶</span><div><strong>The facilitator ' +
        'is presenting.</strong> Everyone is seeing the same analysis. Your group\'s own ' +
        'work is saved and comes back when the presentation ends.</div></div>';
    }
    if (mode.key === 'private') {
      h += '<div class="notice info"><span class="ic">🔒</span><div><strong>You\'re exploring ' +
        'on your own.</strong> Your changes are private and won\'t affect your group\'s ' +
        'results. Use <em>Rejoin the group</em> to go back.</div></div>';
    }
    if (s.myPrivate && s.myPrivate.active && s.myPrivate.suspended && mode.key !== 'private') {
      h += '<div class="notice warn"><span class="ic">⏸</span><div>Your private workspace is ' +
        'paused while the facilitator has the floor. It will come back as you left it.</div></div>';
    }
    // Proposals waiting for the group
    (room.proposals || []).forEach(function (p) {
      var mine = p.from === s.you.seatId;
      h += '<div class="notice info" data-prop="' + C.esc(p.id) + '"><span class="ic">💡</span>' +
        '<div><strong>' + C.esc(p.fromName) + '</strong> proposes a model from their own ' +
        'exploration. Applying it replaces the group\'s current settings.' +
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

  function renderStageHeader(room, mode, locked) {
    var s = App.st;
    var showStage = mode.key === 'present' ? s.classroom.presentStage : room.stage;
    if (SIGS.stageHead === showStage + '|' + locked) return;
    SIGS.stageHead = showStage + '|' + locked;
    var stage = s.stages[showStage];
    App.stageHost.innerHTML = '';
    var nav = el('div', 'stage-nav');
    s.stages.forEach(function (st, i) {
      var btn = el('button', 'stage-btn' + (i === showStage ? ' on' : '') +
                   (i < showStage ? ' done' : ''));
      btn.type = 'button';
      btn.innerHTML = '<span class="n">' + (i + 1) + '</span>' + C.esc(st.title);
      btn.disabled = locked;
      btn.addEventListener('click', function () {
        App.net.send({ type: 'setStage', stage: i });
      });
      nav.appendChild(btn);
    });
    App.stageHost.appendChild(nav);
    var body = el('div');
    body.style.marginTop = '12px';
    body.appendChild(el('h2', null, 'Stage ' + (showStage + 1) + ' · ' + C.esc(stage.title)));
    body.appendChild(el('p', 'secondary', C.esc(stage.prompt)));
    body.style.maxWidth = '76ch';
    App.stageHost.appendChild(body);
  }

  /* ------------------------------------------------------- group answers */

  function renderAnswer(room, locked, mode) {
    var s = App.st;
    var showStage = mode.key === 'present' ? s.classroom.presentStage : room.stage;
    var stage = s.stages[showStage];
    var key = stage.key;
    var doc = (room.answers && room.answers[key]) || { text: '', version: 0, lastEditor: null };

    if (App.answerKey !== key || !App.ta) {
      App.answerKey = key;
      App.answerHost.innerHTML = '';
      App.answerHost.appendChild(el('h4', null, 'Your group\'s answer'));
      App.answerHost.appendChild(el('p', null, '<strong>' + C.esc(stage.ask) + '</strong>'));
      App.ta = document.createElement('textarea');
      App.ta.placeholder = 'Everyone in your room writes here. You will see each other type.';
      App.ta.value = doc.text;
      App.ta.addEventListener('input', onAnswerInput);
      App.answerHost.appendChild(App.ta);
      App.answerMeta = el('div', 'spread small muted');
      App.answerMeta.style.marginTop = '8px';
      App.answerHost.appendChild(App.answerMeta);
      App.ack[key] = { text: doc.text, version: doc.version };
    }

    App.ta.disabled = locked;
    App.answerHost.dataset.locked = locked ? '1' : '0';

    var conf = (room.confidence && room.confidence[key]) || null;
    var meta = '<div>' + (doc.lastEditor
      ? 'Last edited by ' + C.esc(doc.lastEditor) +
        ' · saved automatically · version ' + doc.version
      : 'Saved automatically as you type') + '</div>';
    meta += '<div class="row-wrap">How confident is your group?' +
      [1, 2, 3, 4, 5].map(function (n) {
        return '<button class="sm' + (conf && conf.value === n ? ' on' : '') +
               '" data-conf="' + n + '"' + (locked ? ' disabled' : '') + '>' + n + '</button>';
      }).join('') +
      '<span class="tiny muted">1 = not at all, 5 = very</span></div>';
    if (SIGS.answerMeta === meta) return;
    SIGS.answerMeta = meta;
    App.answerMeta.innerHTML = meta;
    App.answerMeta.querySelectorAll('[data-conf]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        App.net.send({
          type: 'confidence', stageKey: key,
          value: parseInt(btn.dataset.conf, 10)
        });
      });
    });
  }

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
    // The server may have folded in a room-mate's edit; adopt the canonical text
    if (App.ta.value !== msg.text) setTextPreservingCaret(msg.text);
  }

  /** Adopt remote text without throwing the caret to the end. */
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
    if (App.inflight[key] || App.dirty[key]) return;    // our own edit is in flight
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

  /* ---------------------------------------------------- classroom overview */

  function openOverview() {
    App.overviewOpen = true;
    var scrim = el('div', 'scrim');
    scrim.id = 'ov-scrim';
    var modal = el('div', 'modal wide');
    modal.id = 'ov-modal';
    scrim.appendChild(modal);
    document.body.appendChild(scrim);
    scrim.addEventListener('click', function (e) { if (e.target === scrim) closeOverview(); });
    document.addEventListener('keydown', ovEsc);
    renderOverview();
  }
  function ovEsc(e) { if (e.key === 'Escape') closeOverview(); }
  function closeOverview() {
    App.overviewOpen = false;
    var s = document.getElementById('ov-scrim');
    if (s) s.remove();
    document.removeEventListener('keydown', ovEsc);
  }

  function renderOverview() {
    var modal = document.getElementById('ov-modal');
    if (!modal) return;
    var s = App.st, b = App.bundle;
    modal.innerHTML = '';
    var head = el('div', 'spread');
    var h = el('div');
    h.appendChild(el('h2', null, 'Classroom Overview'));
    h.appendChild(el('p', 'small secondary',
      'A read-only live view of what every room is doing. Nothing you do here can change ' +
      'another room, and nothing they do changes yours.'));
    head.appendChild(h);
    var x = el('button', 'ghost', 'Close');
    x.type = 'button';
    x.addEventListener('click', closeOverview);
    head.appendChild(x);
    modal.appendChild(head);

    if (!s.classroom.revealCrossRoom) {
      modal.appendChild(el('div', 'notice info',
        '<span class="ic">i</span><div>Your facilitator has <strong>hidden other rooms\' ' +
        'written answers</strong> until the discussion. You can still see what each room is ' +
        'working on and watch their graphs.</div>'));
    }

    var grid = el('div', 'fac-grid');
    grid.style.marginTop = '14px';
    s.config.roomIds.forEach(function (id) {
      var r = s.rooms[id];
      var mine = id === s.you.roomId;
      var card = el('div', 'card pad fac-room');
      if (mine) card.style.borderColor = 'var(--series-1)';

      var hd = el('div', 'fr-head');
      hd.innerHTML = '<h3>Room ' + id + (mine ? ' <span class="pill live">yours</span>' : '') +
        '</h3><span class="pill ' + (r.frozen ? 'frozen' : r.occupancy ? 'live' : 'empty') +
        '">' + (r.frozen ? 'paused' : r.occupancy + '/' + r.capacity) + '</span>';
      card.appendChild(hd);

      card.appendChild(el('div', 'small secondary',
        'Stage ' + (r.stage + 1) + ' · ' + C.esc(s.stages[r.stage].title)));

      if (r.seats.length) {
        card.appendChild(el('div', 'tiny muted', r.seats.map(function (q) {
          return C.esc(q.name);
        }).join(', ')));
      }

      // Live read-only preview of this room's gap
      var ph = el('div', 'chart-host');
      card.appendChild(ph);
      try {
        var v = MV.compute(b, r.model);
        C.lineChart(ph, {
          years: b.years,
          series: [{ name: 'Gap', values: v.gap, color: C.cssVar(mine ? '--series-1' : '--series-2') }],
          vline: r.model.t0, vlabel: String(r.model.t0), zeroLine: true,
          height: 150, yDp: 1, directLabels: false
        });
        var dl = el('dl', 'kv');
        dl.innerHTML =
          '<dt>Donors</dt><dd>' + r.model.donors.length + ' of ' + b.donors.length + '</dd>' +
          '<dt>Weights</dt><dd>' + C.esc(r.model.weightMode) + '</dd>' +
          '<dt>Year</dt><dd>' + r.model.t0 + '</dd>' +
          '<dt>Pre-fit</dt><dd>' + v.stats.rmspePre.toFixed(3) + '</dd>' +
          '<dt>Mean gap</dt><dd>' + (v.effect.fullPeriod >= 0 ? '+' : '') +
          v.effect.fullPeriod.toFixed(2) + '</dd>';
        card.appendChild(dl);
      } catch (e) {
        ph.innerHTML = '<div class="tiny muted">Could not draw this room\'s model.</div>';
      }

      // Findings
      if (r.answersVisible) {
        var latest = null;
        for (var i = s.stages.length - 1; i >= 0; i--) {
          var a = r.answers && r.answers[s.stages[i].key];
          if (a && a.text.trim()) { latest = { stage: s.stages[i], a: a }; break; }
        }
        if (latest) {
          var fb = el('div');
          fb.style.cssText = 'border-top:1px solid var(--grid);padding-top:8px';
          fb.innerHTML = '<div class="tiny muted">' + C.esc(latest.stage.title) + '</div>' +
            '<div class="small">' + C.esc(latest.a.text.slice(0, 320)) +
            (latest.a.text.length > 320 ? '…' : '') + '</div>';
          card.appendChild(fb);
        } else {
          card.appendChild(el('div', 'tiny muted', 'No written answer yet.'));
        }
      } else {
        card.appendChild(el('div', 'tiny muted', 'Written answers hidden until the discussion.'));
      }

      if (r.lastChange) {
        card.appendChild(el('div', 'tiny muted',
          C.esc(r.lastChange.by) + ' ' + C.esc(r.lastChange.what) + ' · ' + ago(r.lastChange.at)));
      }
      grid.appendChild(card);
    });
    modal.appendChild(grid);
  }

  function ago(ts) {
    var d = Math.max(0, Date.now() - ts) / 1000;
    if (d < 10) return 'just now';
    if (d < 60) return Math.round(d) + 's ago';
    if (d < 3600) return Math.round(d / 60) + ' min ago';
    return Math.round(d / 3600) + ' h ago';
  }

  function renderActivity(room) {
    if (!room.lastChange) { App.activityHost.innerHTML = ''; return; }
    App.activityHost.innerHTML = 'Last change in this room: <strong>' +
      C.esc(room.lastChange.by) + '</strong> ' + C.esc(room.lastChange.what) +
      ' · ' + ago(room.lastChange.at);
  }

  window.addEventListener('DOMContentLoaded', boot);
}());
