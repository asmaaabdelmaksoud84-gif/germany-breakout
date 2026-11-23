/* Connection, reconnection and the client-side state store.
 *
 * Prefers a WebSocket. If one cannot be established — some hosts' free tiers
 * and some school networks will not carry one — the page falls back to ordinary
 * HTTP requests and keeps working, a little less instantly. The rest of the app
 * cannot tell the difference. */
(function (root) {
  'use strict';

  var POLL_MS = 900;            // how often the fallback asks for news
  var WS_GIVE_UP_MS = 7000;     // no usable socket by then -> fall back

  function Net(opts) {
    this.wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') +
                 location.host + '/ws';
    this.state = null;
    this.connected = false;
    this.backoff = 500;
    this.handlers = {};
    this.queue = [];
    this.opts = opts || {};
    this.storeKey = this.opts.storeKey || 'scm-classroom-seat';
    this.transport = null;       // 'ws' | 'http'
    this.wsFailures = 0;
    this.pollId = null;
  }

  Net.prototype.on = function (ev, fn) {
    (this.handlers[ev] || (this.handlers[ev] = [])).push(fn);
    return this;
  };
  Net.prototype.emit = function (ev, arg) {
    (this.handlers[ev] || []).forEach(function (f) {
      try { f(arg); } catch (e) { console.error(e); }
    });
  };

  Net.prototype.seat = function () {
    try { return JSON.parse(localStorage.getItem(this.storeKey) || 'null'); }
    catch (e) { return null; }
  };
  Net.prototype.saveSeat = function (s) {
    try {
      if (s) localStorage.setItem(this.storeKey, JSON.stringify(s));
      else localStorage.removeItem(this.storeKey);
    } catch (e) { /* private browsing */ }
  };

  /** The opening message, identical on both transports. */
  Net.prototype.helloMsg = function () {
    var hello = { type: 'hello' };
    var seat = this.seat();
    if (seat && seat.seatToken) { hello.seatToken = seat.seatToken; hello.name = seat.name; }
    if (this.opts.facilitatorKey) hello.facilitatorKey = this.opts.facilitatorKey;
    return hello;
  };

  Net.prototype.handle = function (msg) {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'state') { this.state = msg; this.emit('state', msg); return; }
    if (msg.type === 'joined') {
      this.saveSeat({ seatToken: msg.seatToken, roomId: msg.roomId, name: msg.name });
    }
    if (msg.type === 'left' || msg.type === 'displaced') this.saveSeat(null);
    this.emit(msg.type, msg);
    this.emit('message', msg);
  };

  Net.prototype.setConnected = function (up) {
    if (this.connected === up) return;
    this.connected = up;
    this.emit('connection', up);
  };

  /* ------------------------------------------------------------ websocket */

  Net.prototype.connect = function () {
    if (this.transport === 'http') return this.pollLoop();
    var self = this;
    if (this.ws) { try { this.ws.close(); } catch (e) {} }
    var ws;
    try { ws = new WebSocket(this.wsUrl); } catch (e) { return this.wsFailed(); }
    this.ws = ws;
    var settled = false;

    // If the socket never becomes usable, stop waiting and fall back
    var giveUp = setTimeout(function () {
      if (self.transport === 'ws' && self.state) return;    // it is working
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (e) {}
      self.wsFailed();
    }, WS_GIVE_UP_MS);

    ws.onopen = function () {
      self.transport = 'ws';
      self.setConnected(true);
      self.backoff = 500;
      try { ws.send(JSON.stringify(self.helloMsg())); } catch (e) {}
      var q = self.queue; self.queue = [];
      q.forEach(function (m) { self.send(m); });
    };

    ws.onmessage = function (ev) {
      settled = true;
      clearTimeout(giveUp);
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      self.handle(msg);
    };

    ws.onclose = function () {
      clearTimeout(giveUp);
      if (self.transport === 'http') return;
      self.setConnected(false);
      if (!self.state) { self.wsFailed(); return; }   // never worked at all
      self.retry();
    };
    ws.onerror = function () { /* onclose follows */ };
  };

  Net.prototype.wsFailed = function () {
    this.wsFailures++;
    if (this.wsFailures >= 2 || this.transport === 'http') {
      if (this.transport !== 'http') {
        this.transport = 'http';
        this.emit('transport', 'http');
        this.startPolling();
      }
      return;
    }
    this.retry();
  };

  Net.prototype.retry = function () {
    var self = this;
    if (this.timer || this.transport === 'http') return;
    var wait = this.backoff;
    this.backoff = Math.min(8000, Math.round(this.backoff * 1.7));
    this.timer = setTimeout(function () {
      self.timer = null;
      self.connect();
    }, wait);
  };

  /* -------------------------------------------------------- http fallback */

  Net.prototype.startPolling = function () {
    var self = this;
    fetch('api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.pollId) throw new Error('no pollId');
        self.pollId = d.pollId;
        self.setConnected(true);
        self.sendHttp([self.helloMsg()].concat(self.queue.splice(0, self.queue.length)));
        self.pollLoop();
      })
      .catch(function () {
        self.setConnected(false);
        setTimeout(function () { self.startPolling(); }, 2000);
      });
  };

  Net.prototype.pollLoop = function () {
    var self = this;
    if (this.pollTimer) return;
    function tick() {
      self.pollTimer = null;
      if (!self.pollId) { self.pollTimer = setTimeout(tick, POLL_MS); return; }
      fetch('api/poll?pollId=' + encodeURIComponent(self.pollId), { cache: 'no-store' })
        .then(function (r) {
          if (r.status === 410) { self.pollId = null; self.startPolling(); return null; }
          return r.json();
        })
        .then(function (d) {
          if (d && d.messages) {
            self.setConnected(true);
            d.messages.forEach(function (m) { self.handle(m); });
          }
          if (!self.pollTimer) self.pollTimer = setTimeout(tick, POLL_MS);
        })
        .catch(function () {
          self.setConnected(false);
          if (!self.pollTimer) self.pollTimer = setTimeout(tick, 2000);
        });
    }
    this.pollTimer = setTimeout(tick, 50);
  };

  Net.prototype.sendHttp = function (msgs) {
    var self = this;
    if (!this.pollId || !msgs.length) return;
    fetch('api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollId: this.pollId, msgs: msgs })
    })
      .then(function (r) {
        if (r.status === 410) { self.pollId = null; self.startPolling(); return null; }
        return r.json();
      })
      .then(function (d) {
        if (d && d.messages) {
          self.setConnected(true);
          d.messages.forEach(function (m) { self.handle(m); });
        }
      })
      .catch(function () { self.setConnected(false); });
  };

  /* ------------------------------------------------------------- sending */

  Net.prototype.send = function (msg) {
    if (this.transport === 'http') {
      if (!this.pollId) {
        if (msg.type !== 'ping') this.queue.push(msg);
        return false;
      }
      this.sendHttp([msg]);
      return true;
    }
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(msg)); return true; } catch (e) { /* fall through */ }
    }
    if (msg.type !== 'ping') {
      this.queue.push(msg);
      if (this.queue.length > 60) this.queue.shift();
    }
    return false;
  };

  root.Net = Net;
}(typeof self !== 'undefined' ? self : this));
