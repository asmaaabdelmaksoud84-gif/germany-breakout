/* Minimal RFC 6455 WebSocket server on Node's built-in http module.
 * Zero dependencies, so the app deploys anywhere Node runs with no install step.
 *
 * Supports: the upgrade handshake, text and binary frames, fragmentation,
 * client masking, ping/pong keepalive, and close handshakes. Server-to-client
 * frames are unmasked, per spec.
 */
'use strict';
const crypto = require('crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1 << 20;            // 1 MiB per message

function accept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

class Conn {
  constructor(socket, req, server) {
    this.socket = socket;
    this.req = req;
    this.server = server;
    this.id = crypto.randomBytes(9).toString('hex');
    this.open = true;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.fragOp = 0;
    this.alive = true;
    this.data = {};                      // application-level attachment
    this._handlers = { message: [], close: [] };

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this._fireClose());
    socket.on('end', () => this.destroy());
  }

  on(ev, fn) { (this._handlers[ev] || (this._handlers[ev] = [])).push(fn); return this; }
  _fire(ev, arg) {
    const hs = this._handlers[ev] || [];
    for (const h of hs) { try { h(arg); } catch (e) { console.error('[ws handler]', e); } }
  }
  _fireClose() {
    if (this._closed) return;
    this._closed = true;
    this.open = false;
    this._fire('close');
  }

  _onData(chunk) {
    if (!this.open) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    // Guard against a client that never completes a frame
    if (this.buf.length > MAX_MESSAGE * 2) return this.close(1009, 'too large');
    for (;;) {
      const frame = this._readFrame();
      if (!frame) break;
      this._handleFrame(frame);
      if (!this.open) break;
    }
  }

  _readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const hi = b.readUInt32BE(off), lo = b.readUInt32BE(off + 4);
      if (hi !== 0) { this.close(1009, 'too large'); return null; }
      len = lo; off += 8;
    }
    if (len > MAX_MESSAGE) { this.close(1009, 'too large'); return null; }
    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4); off += 4;
    }
    if (b.length < off + len) return null;
    let payload = Buffer.from(b.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  _handleFrame(f) {
    switch (f.opcode) {
      case 0x0:                                  // continuation
        this.frags.push(f.payload);
        if (f.fin) this._deliver();
        break;
      case 0x1: case 0x2:                        // text / binary
        this.fragOp = f.opcode;
        this.frags = [f.payload];
        if (f.fin) this._deliver();
        break;
      case 0x8:                                  // close
        this.close(1000, '');
        break;
      case 0x9:                                  // ping
        this._send(0xA, f.payload);
        break;
      case 0xA:                                  // pong
        this.alive = true;
        break;
      default:
        this.close(1002, 'bad opcode');
    }
  }

  _deliver() {
    const total = this.frags.reduce((n, p) => n + p.length, 0);
    if (total > MAX_MESSAGE) { this.frags = []; return this.close(1009, 'too large'); }
    const payload = Buffer.concat(this.frags, total);
    this.frags = [];
    this.alive = true;
    if (this.fragOp === 0x1) this._fire('message', payload.toString('utf8'));
    else this._fire('message', payload);
  }

  _send(opcode, payload) {
    if (!this.open || this.socket.destroyed) return false;
    const len = payload.length;
    let head;
    if (len < 126) {
      head = Buffer.allocUnsafe(2);
      head[1] = len;
    } else if (len < 65536) {
      head = Buffer.allocUnsafe(4);
      head[1] = 126; head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.allocUnsafe(10);
      head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6);
    }
    head[0] = 0x80 | opcode;
    try {
      this.socket.write(head);
      if (len) this.socket.write(payload);
      return true;
    } catch (e) { this.destroy(); return false; }
  }

  send(str) {
    return this._send(0x1, Buffer.from(String(str), 'utf8'));
  }
  sendJSON(obj) { return this.send(JSON.stringify(obj)); }
  ping() { this._send(0x9, Buffer.alloc(0)); }

  close(code, reason) {
    if (!this.open) return;
    this.open = false;
    const r = Buffer.from(String(reason || ''), 'utf8');
    const p = Buffer.allocUnsafe(2 + r.length);
    p.writeUInt16BE(code || 1000, 0);
    r.copy(p, 2);
    this._send(0x8, p);
    try { this.socket.end(); } catch (e) { /* ignore */ }
    setTimeout(() => this.destroy(), 200);
  }

  destroy() {
    this.open = false;
    try { this.socket.destroy(); } catch (e) { /* ignore */ }
    this._fireClose();
  }
}

/** Attach a WebSocket endpoint to an http.Server. */
function attach(httpServer, onConnection, opts) {
  opts = opts || {};
  const path = opts.path || null;
  const conns = new Set();

  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const ver = req.headers['sec-websocket-version'];
    const upg = String(req.headers.upgrade || '').toLowerCase();
    if (upg !== 'websocket' || !key || (ver !== '13' && ver !== 13)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    if (path) {
      const u = (req.url || '/').split('?')[0];
      if (u !== path) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return socket.destroy();
      }
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept(key) + '\r\n\r\n'
    );
    const conn = new Conn(socket, req, httpServer);
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    onConnection(conn);
  });

  // Keepalive: drop connections that stop answering pings
  const iv = setInterval(() => {
    for (const c of conns) {
      if (!c.open) { conns.delete(c); continue; }
      if (!c.alive) { c.destroy(); continue; }
      c.alive = false;
      c.ping();
    }
  }, 25000);
  if (iv.unref) iv.unref();

  return { conns, close: () => { clearInterval(iv); for (const c of conns) c.destroy(); } };
}

module.exports = { attach, accept, Conn };
