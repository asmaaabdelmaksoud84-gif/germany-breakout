#!/usr/bin/env node
/* Synthetic-control classroom server.
 *
 *   node server.js                       (then open the printed URLs)
 *   PORT=8080 FACILITATOR_KEY=mykey node server.js
 *
 * The server is authoritative. Every message that would change shared state is
 * checked against the classroom's freeze/presentation status and the sender's
 * role BEFORE anything is written, so a student cannot edit a frozen room by
 * talking to the socket directly -- the UI being disabled is only a courtesy.
 *
 * Zero dependencies: Node's own http/crypto/fs plus the local ws.js and ot.js.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const ws = require('./ws.js');
const OT = require('./ot.js');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ROOM_COUNT = parseInt(process.env.ROOM_COUNT || '10', 10);
const ROOM_IDS = Array.from({ length: ROOM_COUNT }, (_, i) => i + 1);
// 0 means no limit: a room just reports how many people are in it, so the
// whole class can pile into one room for a demonstration.
const ROOM_CAPACITY = parseInt(process.env.ROOM_CAPACITY || '0', 10);
const SEAT_TIMEOUT_MS = parseInt(process.env.SEAT_TIMEOUT_MS || '120000', 10);
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'classroom-state.json');
const FACILITATOR_KEY = process.env.FACILITATOR_KEY ||
  crypto.randomBytes(5).toString('hex');
const ANSWER_MAX = 8000;
const HISTORY_MAX = 400;

/* ------------------------------------------------------------- activity */

const STAGES = [
  {
    key: 's1',
    title: 'The claim',
    prompt: 'The published model is already loaded. Check its donor weights against ' +
            'the ones the paper printed.',
    ask: 'Do the donor weights on your screen match the five the paper printed? ' +
         'And what does it mean that over half of "synthetic Germany" is one country?'
  },
  {
    key: 's2',
    title: 'Build it yourself',
    prompt: 'You choose how much each characteristic counts; the method works out ' +
            'which countries go into the blend. Watch the pre-2011 fit as you change it.',
    ask: 'What pre-2011 fit did you get with the published weights, and what did you ' +
         'get when the data chose? Does either match the 0.218 the paper reports?'
  },
  {
    key: 's3',
    title: 'Read off the effect',
    prompt: 'The distance between the two lines after 2011 is the estimated effect. ' +
            'Split it by fuel, and look at what replaced the nuclear power.',
    ask: 'What is your group\u2019s estimate of the effect, and how does it change ' +
         'from 2011 to 2023? Which fuel drives it, and does the gap close?'
  },
  {
    key: 's4',
    title: 'Try to break it',
    prompt: 'Run the placebo tests across countries and across dates, and drop donor ' +
            'countries one at a time.',
    ask: 'Which test put the most pressure on the result? Name the number that moved ' +
         'and say whether the finding survived.'
  },
  {
    key: 's5',
    title: 'Did it replicate?',
    prompt: 'Go through the published numbers one at a time and mark each as matched, ' +
            'close, or did not reproduce.',
    ask: 'Did the study replicate? Go through the checklist, say which numbers matched ' +
         'and which did not, and state the conclusion you are willing to defend.'
  }
];

const ALL_DONORS = ['Bulgaria', 'Czechia', 'Finland', 'France', 'Hungary', 'Netherlands',
                    'Slovak Republic', 'Slovenia', 'Spain', 'Sweden', 'Romania'];
const ALL_PREDICTORS = ['gdp_pc', 'reg_car_pcm', 'el_pc', 'fossil_elpc', 'nuc_elpc', 'temp',
                        'industry', 'populationdensity', 'populationshareinurbanareas',
                        'energyintensity', 'hh_perc'];
const ALL_LAGS = [1990, 1994, 1998, 2002, 2006, 2010];
const VIEWS = ['levels', 'gap', 'fuels', 'electricity', 'placeboSpace', 'placeboTime', 'loo'];
const WEIGHT_MODES = ['published', 'manual', 'optimised'];

function defaultModel() {
  return {
    t0: 2011,
    donors: ALL_DONORS.slice(),
    predictors: ALL_PREDICTORS.slice(),
    lagYears: ALL_LAGS.slice(),
    weightMode: 'published',
    v: {},                       // manual predictor importances, by label
    view: 'levels'
  };
}

/* --------------------------------------------------------------- state */

function freshRoom(id) {
  return {
    id: id,
    seats: {},                   // seatId -> seat
    stage: 0,
    model: defaultModel(),
    answers: {},                 // stageKey -> {text, version, history, lastEditor, updatedAt}
    confidence: {},              // stageKey -> {value, by, at}
    lastChange: null,
    proposals: {}
  };
}

function freshState() {
  const rooms = {};
  for (const id of ROOM_IDS) rooms[id] = freshRoom(id);
  return {
    rooms: rooms,
    classroom: {
      freezeAll: false,
      frozenRooms: {},
      presenting: false,
      presentModel: defaultModel(),
      presentStage: 0,
      revealCrossRoom: false,
      resumeEpoch: 0,
      updatedAt: Date.now()
    },
    privates: {},                // seatToken -> {active, suspended, model}
    createdAt: Date.now()
  };
}

let state = freshState();

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!raw || !raw.rooms) return;
    // Merge defensively so an older/partial file cannot crash the server
    const s = freshState();
    for (const id of ROOM_IDS) {
      const r = raw.rooms[id];
      if (!r) continue;
      const room = s.rooms[id];
      room.stage = clampStage(r.stage);
      room.model = sanitiseModel(r.model);
      room.answers = {};
      for (const st of STAGES) {
        const a = r.answers && r.answers[st.key];
        if (a && typeof a.text === 'string') {
          room.answers[st.key] = {
            text: a.text.slice(0, ANSWER_MAX),
            version: a.version | 0, history: [],
            lastEditor: a.lastEditor || null, updatedAt: a.updatedAt || Date.now()
          };
        }
      }
      room.confidence = (r.confidence && typeof r.confidence === 'object') ? r.confidence : {};
      room.lastChange = r.lastChange || null;
      // Seats come back offline; students reclaim them with their token
      if (r.seats && typeof r.seats === 'object') {
        for (const sid of Object.keys(r.seats)) {
          const seat = r.seats[sid];
          if (!seat || typeof seat.name !== 'string' || !seat.token) continue;
          room.seats[sid] = {
            seatId: sid, name: seat.name.slice(0, 40), token: seat.token,
            online: false, connId: null, lastSeen: seat.lastSeen || 0,
            color: seat.color || pickColor(sid)
          };
        }
      }
    }
    if (raw.classroom) {
      const c = raw.classroom;
      s.classroom.freezeAll = !!c.freezeAll;
      s.classroom.frozenRooms = (c.frozenRooms && typeof c.frozenRooms === 'object') ? c.frozenRooms : {};
      s.classroom.presenting = !!c.presenting;
      s.classroom.presentModel = sanitiseModel(c.presentModel);
      s.classroom.presentStage = clampStage(c.presentStage);
      s.classroom.revealCrossRoom = !!c.revealCrossRoom;
      s.classroom.resumeEpoch = c.resumeEpoch | 0;
    }
    if (raw.privates && typeof raw.privates === 'object') {
      for (const tok of Object.keys(raw.privates)) {
        const p = raw.privates[tok];
        if (!p) continue;
        s.privates[tok] = {
          active: !!p.active, suspended: !!p.suspended, model: sanitiseModel(p.model)
        };
      }
    }
    state = s;
    console.log('[state] restored from ' + STATE_FILE);
  } catch (e) {
    console.error('[state] could not restore (' + e.message + '); starting fresh');
  }
}

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = STATE_FILE + '.tmp';
      // Strip OT history; it is only needed while clients are live
      const out = JSON.stringify(state, (k, v) => (k === 'history' ? [] : v));
      fs.writeFileSync(tmp, out);
      fs.renameSync(tmp, STATE_FILE);          // atomic replace
    } catch (e) { console.error('[state] save failed', e.message); }
  }, 1200);
  if (saveTimer.unref) saveTimer.unref();
}

/* ---------------------------------------------------------- validation */

const COLORS = ['#3b7dd8', '#c2582b', '#2f8f6b', '#8a5bb8', '#b8873a', '#4a6fa5'];
function pickColor(key) {
  let h = 0;
  for (let i = 0; i < String(key).length; i++) h = (h * 31 + String(key).charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}
function clampStage(n) {
  n = n | 0;
  return n < 0 ? 0 : (n >= STAGES.length ? STAGES.length - 1 : n);
}
function uniqStrings(arr, allowed, min) {
  if (!Array.isArray(arr)) return allowed.slice();
  const seen = new Set(), out = [];
  for (const x of arr) {
    if (typeof x !== 'string' || !allowed.includes(x) || seen.has(x)) continue;
    seen.add(x); out.push(x);
  }
  return out.length >= (min || 0) ? out : allowed.slice();
}
/** Never trust a model body off the wire. */
function sanitiseModel(m) {
  const d = defaultModel();
  if (!m || typeof m !== 'object') return d;
  const t0 = parseInt(m.t0, 10);
  d.t0 = (isFinite(t0) && t0 >= 1992 && t0 <= 2021) ? t0 : 2011;
  d.donors = uniqStrings(m.donors, ALL_DONORS, 1);
  d.predictors = uniqStrings(m.predictors, ALL_PREDICTORS, 0);
  const lags = Array.isArray(m.lagYears)
    ? m.lagYears.map(x => parseInt(x, 10)).filter(x => ALL_LAGS.includes(x))
    : ALL_LAGS.slice();
  d.lagYears = Array.from(new Set(lags));
  if (!d.predictors.length && !d.lagYears.length) d.lagYears = ALL_LAGS.slice();
  d.weightMode = WEIGHT_MODES.includes(m.weightMode) ? m.weightMode : 'published';
  d.view = VIEWS.includes(m.view) ? m.view : 'levels';
  d.v = {};
  if (m.v && typeof m.v === 'object') {
    for (const k of Object.keys(m.v)) {
      if (k.length > 40) continue;
      const x = Number(m.v[k]);
      if (isFinite(x) && x >= 0 && x <= 1000) d.v[k] = x;
    }
  }
  return d;
}

/* ------------------------------------------------------------- clients */

const clients = new Map();        // connId -> client

function roomOccupancy(room) {
  const now = Date.now();
  let n = 0;
  for (const sid of Object.keys(room.seats)) {
    const s = room.seats[sid];
    if (s.online || (now - s.lastSeen) < SEAT_TIMEOUT_MS) n++;
  }
  return n;
}

function seatByToken(token) {
  for (const id of ROOM_IDS) {
    const room = state.rooms[id];
    for (const sid of Object.keys(room.seats)) {
      if (room.seats[sid].token === token) return { room: room, seat: room.seats[sid] };
    }
  }
  return null;
}

function isFrozenFor(roomId) {
  const c = state.classroom;
  return !!(c.freezeAll || c.frozenRooms[roomId] || c.presenting);
}

/** The single gate every student-initiated mutation passes through. */
function guardStudent(client, roomId) {
  if (client.role === 'facilitator') return { ok: true };
  if (!client.roomId) return { ok: false, reason: 'not-in-room' };
  if (roomId !== undefined && roomId !== client.roomId) {
    return { ok: false, reason: 'wrong-room' };
  }
  const c = state.classroom;
  if (c.presenting) return { ok: false, reason: 'presenting' };
  if (c.freezeAll) return { ok: false, reason: 'frozen-all' };
  if (c.frozenRooms[client.roomId]) return { ok: false, reason: 'frozen-room' };
  return { ok: true };
}

function noteChange(room, client, what) {
  room.lastChange = {
    by: client.role === 'facilitator' ? 'Facilitator' : (client.name || 'Someone'),
    what: what, at: Date.now()
  };
}

/* ----------------------------------------------------------- snapshots */

function publicRoom(room, forClient) {
  const seats = Object.keys(room.seats).map(sid => {
    const s = room.seats[sid];
    return { seatId: sid, name: s.name, online: s.online, color: s.color };
  });
  const isMine = forClient.roomId === room.id;
  const isFac = forClient.role === 'facilitator';
  const canSeeAnswers = isFac || isMine || state.classroom.revealCrossRoom;

  // A student sees only their own room's work. Other rooms are a name and a
  // head count on the picker -- nothing about what those groups are doing.
  if (!isFac && !isMine) {
    return {
      id: room.id,
      seats: seats.map(q => ({ name: q.name, online: q.online, color: q.color })),
      occupancy: roomOccupancy(room),
      capacity: ROOM_CAPACITY,
      frozen: !!state.classroom.frozenRooms[room.id],
      answersVisible: false,
      restricted: true
    };
  }

  const out = {
    id: room.id,
    stage: room.stage,
    model: room.model,
    seats: seats,
    occupancy: roomOccupancy(room),
    capacity: ROOM_CAPACITY,
    frozen: !!state.classroom.frozenRooms[room.id],
    lastChange: room.lastChange,
    answersVisible: canSeeAnswers
  };
  if (canSeeAnswers) {
    out.answers = {};
    for (const k of Object.keys(room.answers)) {
      out.answers[k] = {
        text: room.answers[k].text,
        version: room.answers[k].version,
        lastEditor: room.answers[k].lastEditor,
        updatedAt: room.answers[k].updatedAt
      };
    }
    out.confidence = room.confidence;
  }
  if (isMine) {
    out.proposals = Object.keys(room.proposals).map(pid => {
      const p = room.proposals[pid];
      return { id: pid, from: p.from, fromName: p.fromName, at: p.at, model: p.model };
    });
  }
  return out;
}

function snapshotFor(client) {
  const rooms = {};
  for (const id of ROOM_IDS) rooms[id] = publicRoom(state.rooms[id], client);
  const priv = client.token ? state.privates[client.token] : null;
  const c = state.classroom;
  return {
    type: 'state',
    now: Date.now(),
    you: {
      role: client.role, roomId: client.roomId, seatId: client.seatId,
      name: client.name, connId: client.connId
    },
    classroom: {
      freezeAll: c.freezeAll,
      frozenRooms: c.frozenRooms,
      presenting: c.presenting,
      presentModel: c.presenting || client.role === 'facilitator' ? c.presentModel : null,
      presentStage: c.presentStage,
      revealCrossRoom: c.revealCrossRoom,
      resumeEpoch: c.resumeEpoch
    },
    rooms: rooms,
    myPrivate: priv ? { active: priv.active, suspended: priv.suspended, model: priv.model } : null,
    frozenForMe: client.role === 'student' && client.roomId ? isFrozenFor(client.roomId) : false,
    stages: STAGES,
    config: {
      capacity: ROOM_CAPACITY, roomIds: ROOM_IDS, seatTimeoutMs: SEAT_TIMEOUT_MS,
      allDonors: ALL_DONORS, allPredictors: ALL_PREDICTORS, allLags: ALL_LAGS
    }
  };
}

let bcastTimer = null;
function broadcast() {
  state.classroom.updatedAt = Date.now();
  saveSoon();
  if (bcastTimer) return;
  bcastTimer = setTimeout(() => {
    bcastTimer = null;
    for (const client of clients.values()) {
      if (!client.conn.open) continue;
      try { client.conn.sendJSON(snapshotFor(client)); } catch (e) { /* ignore */ }
    }
  }, 30);
}

function sendTo(client, obj) {
  if (client.conn.open) { try { client.conn.sendJSON(obj); } catch (e) { /* ignore */ } }
}
function deny(client, action, reason) {
  sendTo(client, { type: 'denied', action: action, reason: reason });
}

/* ------------------------------------------------------- freeze helpers */

function suspendPrivates(on) {
  for (const tok of Object.keys(state.privates)) {
    state.privates[tok].suspended = !!on;
  }
}

/* ------------------------------------------------------ message handling */

function handleJoin(client, msg) {
  const roomId = parseInt(msg.roomId, 10);
  if (!ROOM_IDS.includes(roomId)) return deny(client, 'join', 'bad-room');
  const room = state.rooms[roomId];
  let name = String(msg.name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  if (!name) return deny(client, 'join', 'name-required');

  // Reclaim a seat with a matching token before considering capacity
  if (msg.seatToken) {
    const found = seatByToken(String(msg.seatToken));
    if (found && found.room.id === roomId) {
      attachSeat(client, found.room, found.seat, name);
      return;
    }
  }
  // Free seats that have been abandoned past the timeout
  sweepSeats();
  if (ROOM_CAPACITY > 0 && roomOccupancy(room) >= ROOM_CAPACITY) {
    return deny(client, 'join', 'room-full');
  }

  const seatId = 'seat' + crypto.randomBytes(4).toString('hex');
  const seat = {
    seatId: seatId, name: name, token: crypto.randomBytes(16).toString('hex'),
    online: false, connId: null, lastSeen: Date.now(), color: pickColor(seatId)
  };
  room.seats[seatId] = seat;
  attachSeat(client, room, seat, name);
}

function attachSeat(client, room, seat, name) {
  // If another live connection holds this seat, drop it (same student, new tab)
  for (const other of clients.values()) {
    if (other !== client && other.seatId === seat.seatId) {
      other.roomId = null; other.seatId = null; other.token = null;
      sendTo(other, { type: 'displaced' });
    }
  }
  if (name) seat.name = name;
  seat.online = true;
  seat.connId = client.connId;
  seat.lastSeen = Date.now();
  client.role = 'student';
  client.roomId = room.id;
  client.seatId = seat.seatId;
  client.token = seat.token;
  client.name = seat.name;
  if (!state.privates[seat.token]) {
    state.privates[seat.token] = { active: false, suspended: false, model: defaultModel() };
  }
  sendTo(client, {
    type: 'joined', roomId: room.id, seatId: seat.seatId,
    seatToken: seat.token, name: seat.name
  });
  noteChange(room, client, 'joined the room');
  broadcast();
}

function handleLeave(client) {
  if (!client.roomId) return;
  const room = state.rooms[client.roomId];
  const seat = room && room.seats[client.seatId];
  if (seat) {
    delete room.seats[client.seatId];
    noteChange(room, client, 'left the room');
  }
  if (client.token) delete state.privates[client.token];
  client.roomId = null; client.seatId = null; client.token = null;
  sendTo(client, { type: 'left' });
  broadcast();
}

function handleSetModel(client, msg) {
  const g = guardStudent(client, client.roomId);
  if (!g.ok) return deny(client, 'setModel', g.reason);
  const room = state.rooms[client.roomId];
  room.model = sanitiseModel(Object.assign({}, room.model, msg.model || {}));
  noteChange(room, client, msg.label ? String(msg.label).slice(0, 80) : 'changed the model');
  broadcast();
}

function handleSetStage(client, msg) {
  const g = guardStudent(client, client.roomId);
  if (!g.ok) return deny(client, 'setStage', g.reason);
  const room = state.rooms[client.roomId];
  room.stage = clampStage(msg.stage);
  noteChange(room, client, 'moved to stage ' + (room.stage + 1));
  broadcast();
}

function handleAnswer(client, msg) {
  const g = guardStudent(client, client.roomId);
  if (!g.ok) return deny(client, 'answer', g.reason);
  const room = state.rooms[client.roomId];
  const key = String(msg.stageKey || '');
  if (!STAGES.some(s => s.key === key)) return deny(client, 'answer', 'bad-stage');
  if (!room.answers[key]) {
    room.answers[key] = {
      text: '', version: 0, history: [], lastEditor: null, updatedAt: Date.now()
    };
  }
  const doc = room.answers[key];
  const base = Math.max(0, Math.min(doc.version, parseInt(msg.baseVersion, 10) || 0));
  let op = OT.clampOp({
    p: parseInt(msg.op && msg.op.p, 10) || 0,
    d: parseInt(msg.op && msg.op.d, 10) || 0,
    i: (msg.op && typeof msg.op.i === 'string') ? msg.op.i : ''
  }, Infinity);
  if (op.i.length > ANSWER_MAX) return deny(client, 'answer', 'too-long');

  // Rebase the edit over everything committed since the client's base version
  const since = doc.history.filter(h => h.version > base).map(h => h.op);
  if (since.length) op = OT.transformOver(op, since);
  op = OT.clampOp(op, doc.text.length);

  const next = OT.apply(doc.text, op);
  if (next.length > ANSWER_MAX) return deny(client, 'answer', 'too-long');
  doc.text = next;
  doc.version++;
  doc.history.push({ version: doc.version, op: op, by: client.seatId });
  if (doc.history.length > HISTORY_MAX) doc.history.splice(0, doc.history.length - HISTORY_MAX);
  doc.lastEditor = client.name;
  doc.updatedAt = Date.now();
  noteChange(room, client, 'edited the group answer');
  // Tell the sender which version absorbed its edit, so its caret can follow
  sendTo(client, {
    type: 'answerAck', stageKey: key, version: doc.version, op: op, text: doc.text
  });
  broadcast();
}

function handleConfidence(client, msg) {
  const g = guardStudent(client, client.roomId);
  if (!g.ok) return deny(client, 'confidence', g.reason);
  const room = state.rooms[client.roomId];
  const key = String(msg.stageKey || '');
  if (!STAGES.some(s => s.key === key)) return deny(client, 'confidence', 'bad-stage');
  const val = parseInt(msg.value, 10);
  if (!(val >= 1 && val <= 5)) return deny(client, 'confidence', 'bad-value');
  room.confidence[key] = { value: val, by: client.name, at: Date.now() };
  noteChange(room, client, 'set the confidence rating to ' + val + '/5');
  broadcast();
}

function handlePrivate(client, msg) {
  if (client.role !== 'student' || !client.token) return deny(client, 'private', 'not-student');
  const priv = state.privates[client.token];
  if (!priv) return deny(client, 'private', 'no-workspace');
  const room = state.rooms[client.roomId];

  if (msg.type === 'privateStart') {
    // Entering/leaving private mode is a view change, so it is allowed while
    // frozen -- but the workspace stays suspended until the session resumes.
    priv.active = true;
    priv.suspended = isFrozenFor(client.roomId);
    priv.model = sanitiseModel(room ? room.model : null);   // start from group state
    broadcast();
    return;
  }
  if (msg.type === 'privateStop') {
    priv.active = false;
    broadcast();
    return;
  }
  if (msg.type === 'privateSetModel') {
    const g = guardStudent(client, client.roomId);
    if (!g.ok) return deny(client, 'privateSetModel', g.reason);
    if (!priv.active) return deny(client, 'privateSetModel', 'not-private');
    priv.model = sanitiseModel(Object.assign({}, priv.model, msg.model || {}));
    broadcast();
    return;
  }
  if (msg.type === 'proposeToGroup') {
    const g = guardStudent(client, client.roomId);
    if (!g.ok) return deny(client, 'proposeToGroup', g.reason);
    if (!priv.active) return deny(client, 'proposeToGroup', 'not-private');
    const pid = 'p' + crypto.randomBytes(4).toString('hex');
    room.proposals[pid] = {
      from: client.seatId, fromName: client.name,
      model: sanitiseModel(priv.model), at: Date.now()
    };
    noteChange(room, client, 'proposed a model to the group');
    broadcast();
    return;
  }
  deny(client, 'private', 'unknown');
}

function handleProposalDecision(client, msg) {
  const g = guardStudent(client, client.roomId);
  if (!g.ok) return deny(client, 'applyProposal', g.reason);
  const room = state.rooms[client.roomId];
  const pid = String(msg.proposalId || '');
  const p = room.proposals[pid];
  if (!p) return deny(client, 'applyProposal', 'no-proposal');
  delete room.proposals[pid];
  if (msg.accept) {
    room.model = sanitiseModel(p.model);
    noteChange(room, client, 'applied ' + p.fromName + "'s proposed model");
  } else {
    noteChange(room, client, 'declined ' + p.fromName + "'s proposal");
  }
  broadcast();
}

/* ------------------------------------------------------ facilitator ops */

function handleFacilitator(client, msg) {
  if (client.role !== 'facilitator') return deny(client, msg.type, 'not-facilitator');
  const c = state.classroom;
  switch (msg.type) {
    case 'fac:freezeAll':
      c.freezeAll = true;
      suspendPrivates(true);
      break;
    case 'fac:unfreezeAll': {
      c.freezeAll = false;
      c.frozenRooms = {};
      c.resumeEpoch++;
      suspendPrivates(false);
      break;
    }
    case 'fac:freezeRoom': {
      const id = parseInt(msg.roomId, 10);
      if (!ROOM_IDS.includes(id)) return deny(client, msg.type, 'bad-room');
      if (msg.frozen) c.frozenRooms[id] = true;
      else delete c.frozenRooms[id];
      // Suspend only the private workspaces of students in that room
      for (const other of clients.values()) {
        if (other.role === 'student' && other.roomId === id && other.token &&
            state.privates[other.token]) {
          state.privates[other.token].suspended = isFrozenFor(id);
        }
      }
      break;
    }
    case 'fac:present': {
      c.presenting = !!msg.on;
      if (c.presenting) {
        // Seed the demo from a chosen room so the class sees real work
        const src = ROOM_IDS.includes(parseInt(msg.fromRoom, 10))
          ? state.rooms[parseInt(msg.fromRoom, 10)] : null;
        c.presentModel = sanitiseModel(src ? src.model : c.presentModel);
        if (src) c.presentStage = src.stage;
        suspendPrivates(true);
      } else {
        c.resumeEpoch++;
        suspendPrivates(!!c.freezeAll);
      }
      break;
    }
    case 'fac:presentModel':
      c.presentModel = sanitiseModel(Object.assign({}, c.presentModel, msg.model || {}));
      break;
    case 'fac:presentStage':
      c.presentStage = clampStage(msg.stage);
      break;
    case 'fac:advanceAll': {
      const dir = msg.back ? -1 : 1;
      for (const id of ROOM_IDS) {
        const room = state.rooms[id];
        room.stage = clampStage(room.stage + dir);
        room.lastChange = {
          by: 'Facilitator', what: 'moved the room to stage ' + (room.stage + 1),
          at: Date.now()
        };
      }
      break;
    }
    case 'fac:reveal':
      c.revealCrossRoom = !!msg.on;
      break;
    case 'fac:resetRoom': {
      const id = parseInt(msg.roomId, 10);
      if (!ROOM_IDS.includes(id)) return deny(client, msg.type, 'bad-room');
      const old = state.rooms[id];
      const keep = old.seats;                 // students stay connected
      state.rooms[id] = freshRoom(id);
      state.rooms[id].seats = keep;
      state.rooms[id].lastChange = {
        by: 'Facilitator', what: 'reset the room', at: Date.now()
      };
      break;
    }
    case 'fac:applyToAll': {
      if (!msg.confirm) return deny(client, msg.type, 'needs-confirmation');
      const model = sanitiseModel(msg.model || c.presentModel);
      for (const id of ROOM_IDS) {
        state.rooms[id].model = sanitiseModel(model);
        state.rooms[id].lastChange = {
          by: 'Facilitator', what: 'applied the demonstrated model', at: Date.now()
        };
      }
      break;
    }
    case 'fac:setRoomModel': {
      // The facilitator driving one room's shared model directly
      const id = parseInt(msg.roomId, 10);
      if (!ROOM_IDS.includes(id)) return deny(client, msg.type, 'bad-room');
      const room = state.rooms[id];
      room.model = sanitiseModel(Object.assign({}, room.model, msg.model || {}));
      room.lastChange = { by: 'Facilitator', what: 'changed the model', at: Date.now() };
      break;
    }
    case 'fac:kickSeat': {
      const id = parseInt(msg.roomId, 10);
      if (!ROOM_IDS.includes(id)) return deny(client, msg.type, 'bad-room');
      const room = state.rooms[id];
      const seat = room.seats[String(msg.seatId)];
      if (seat) {
        for (const other of clients.values()) {
          if (other.seatId === seat.seatId) {
            other.roomId = null; other.seatId = null; other.token = null;
            sendTo(other, { type: 'displaced' });
          }
        }
        if (state.privates[seat.token]) delete state.privates[seat.token];
        delete room.seats[String(msg.seatId)];
      }
      break;
    }
    case 'fac:export':
      sendTo(client, { type: 'export', payload: buildExport() });
      return;
    default:
      return deny(client, msg.type, 'unknown');
  }
  broadcast();
}

function buildExport() {
  const rooms = ROOM_IDS.map(id => {
    const room = state.rooms[id];
    return {
      room: id,
      stage: room.stage,
      stageTitle: STAGES[room.stage].title,
      students: Object.keys(room.seats).map(sid => ({
        name: room.seats[sid].name, online: room.seats[sid].online
      })),
      model: room.model,
      answers: STAGES.map(s => ({
        stage: s.key, title: s.title, question: s.ask,
        answer: (room.answers[s.key] && room.answers[s.key].text) || '',
        lastEditor: (room.answers[s.key] && room.answers[s.key].lastEditor) || null,
        updatedAt: (room.answers[s.key] && room.answers[s.key].updatedAt) || null,
        confidence: (room.confidence[s.key] && room.confidence[s.key].value) || null
      })),
      lastChange: room.lastChange
    };
  });
  return {
    exportedAt: new Date().toISOString(),
    activity: 'Did Germany\'s Nuclear Phase-Out Increase CO2 Emissions?',
    classroom: {
      freezeAll: state.classroom.freezeAll,
      frozenRooms: state.classroom.frozenRooms,
      presenting: state.classroom.presenting,
      revealCrossRoom: state.classroom.revealCrossRoom
    },
    stages: STAGES,
    rooms: rooms
  };
}

/* --------------------------------------------------------------- sweeper */

function sweepSeats() {
  const now = Date.now();
  let changed = false;
  for (const id of ROOM_IDS) {
    const room = state.rooms[id];
    for (const sid of Object.keys(room.seats)) {
      const s = room.seats[sid];
      if (s.online) continue;
      if (now - s.lastSeen > SEAT_TIMEOUT_MS) {
        console.log('[seat] releasing abandoned seat ' + s.name + ' in room ' + id);
        if (state.privates[s.token]) delete state.privates[s.token];
        delete room.seats[sid];
        changed = true;
      }
    }
  }
  return changed;
}
const sweepIv = setInterval(() => { if (sweepSeats()) broadcast(); }, 10000);
if (sweepIv.unref) sweepIv.unref();

/* ------------------------------------------------------------ transport */

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function onMessage(client, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (!msg || typeof msg.type !== 'string') return;
  client.lastSeen = Date.now();
  if (client.seatId) {
    const room = state.rooms[client.roomId];
    const seat = room && room.seats[client.seatId];
    if (seat) seat.lastSeen = Date.now();
  }

  switch (msg.type) {
    case 'hello': {
      if (msg.facilitatorKey !== undefined && msg.facilitatorKey !== null) {
        if (timingSafeEqual(msg.facilitatorKey, FACILITATOR_KEY)) {
          client.role = 'facilitator';
          sendTo(client, { type: 'facilitatorOk' });
        } else {
          client.role = 'observer';
          sendTo(client, { type: 'facilitatorDenied' });
          broadcast();
          return;
        }
      }
      if (msg.seatToken) {
        const found = seatByToken(String(msg.seatToken));
        if (found) attachSeat(client, found.room, found.seat, msg.name);
      }
      sendTo(client, snapshotFor(client));
      return;
    }
    case 'join': return handleJoin(client, msg);
    case 'leave': return handleLeave(client);
    case 'setModel': return handleSetModel(client, msg);
    case 'setStage': return handleSetStage(client, msg);
    case 'answer': return handleAnswer(client, msg);
    case 'confidence': return handleConfidence(client, msg);
    case 'privateStart': case 'privateStop':
    case 'privateSetModel': case 'proposeToGroup':
      return handlePrivate(client, msg);
    case 'applyProposal': return handleProposalDecision(client, msg);
    case 'ping': return sendTo(client, { type: 'pong', now: Date.now() });
    default:
      if (msg.type.indexOf('fac:') === 0) return handleFacilitator(client, msg);
      return deny(client, msg.type, 'unknown');
  }
}

/* ----------------------------------------------------------- http server */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.csv': 'text/csv; charset=utf-8'
};

/* Compressed and cached in memory. The page is ~190 KB of text, which matters
   a great deal when the server is on another continent from the classroom. */
const fileCache = new Map();

function serveFile(res, file, status, req) {
  const hit = fileCache.get(file);
  if (hit) return sendFile(res, file, hit, status, req);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    const entry = { raw: buf, gz: null, type: MIME[ext] || 'application/octet-stream' };
    if (/\.(html|js|css|json|csv|svg)$/.test(ext) && buf.length > 1024) {
      try { entry.gz = zlib.gzipSync(buf, { level: 8 }); } catch (e) { /* serve raw */ }
    }
    fileCache.set(file, entry);
    sendFile(res, file, entry, status, req);
  });
}

function sendFile(res, file, entry, status, req) {
  const accepts = String((req && req.headers['accept-encoding']) || '');
  const useGz = entry.gz && /\bgzip\b/.test(accepts);
  const head = {
    'Content-Type': entry.type,
    'Cache-Control': 'no-cache',
    'Vary': 'Accept-Encoding'
  };
  if (useGz) head['Content-Encoding'] = 'gzip';
  res.writeHead(status || 200, head);
  res.end(useGz ? entry.gz : entry.raw);
}

/* ------------------------------------------------- HTTP polling fallback
 *
 * Some hosts' free tiers and some school networks will not carry a WebSocket.
 * Rather than fail in front of a class, the page falls back to ordinary HTTP
 * requests. A polling client gets the same client record and goes through the
 * same permission checks as a socket client, so freeze enforcement and every
 * other rule behave identically -- only the delivery changes.
 */
const httpClients = new Map();          // pollId -> client
const HTTP_IDLE_MS = 45000;

function makeHttpClient() {
  const pollId = crypto.randomBytes(12).toString('hex');
  const queue = [];
  const conn = {
    id: 'http_' + pollId,
    open: true,
    sendJSON(o) { queue.push(o); if (queue.length > 60) queue.shift(); return true; },
    send(s) { try { queue.push(JSON.parse(s)); } catch (e) {} return true; },
    ping() {},
    close() { this.open = false; },
    destroy() { this.open = false; },
    on() { return this; }
  };
  const client = {
    conn, connId: conn.id, role: 'student', roomId: null, seatId: null,
    token: null, name: null, lastSeen: Date.now(),
    transport: 'http', queue, pollId
  };
  clients.set(conn.id, client);
  httpClients.set(pollId, client);
  return client;
}

function dropHttpClient(client) {
  client.conn.open = false;
  clients.delete(client.connId);
  httpClients.delete(client.pollId);
  if (client.roomId && client.seatId) {
    const room = state.rooms[client.roomId];
    const seat = room && room.seats[client.seatId];
    if (seat && seat.connId === client.connId) {
      seat.online = false; seat.connId = null; seat.lastSeen = Date.now();
    }
    broadcast();
  }
}

const httpSweep = setInterval(() => {
  const now = Date.now();
  for (const client of Array.from(httpClients.values())) {
    if (now - client.lastSeen > HTTP_IDLE_MS) dropHttpClient(client);
  }
}, 10000);
if (httpSweep.unref) httpSweep.unref();

function readBody(req, cb) {
  let body = '';
  let tooBig = false;
  req.on('data', d => {
    body += d;
    if (body.length > 300000) { tooBig = true; req.destroy(); }
  });
  req.on('end', () => {
    if (tooBig) return cb(null);
    try { cb(JSON.parse(body || '{}')); } catch (e) { cb(null); }
  });
  req.on('error', () => cb(null));
}

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  let p = decodeURIComponent(u.pathname);

  // ---- polling transport ----
  if (p === '/api/connect' && req.method === 'POST') {
    const client = makeHttpClient();
    client.conn.sendJSON({ type: 'hello', stages: STAGES });
    return json(res, 200, { pollId: client.pollId });
  }
  if (p === '/api/send' && req.method === 'POST') {
    return readBody(req, (body) => {
      if (!body || !body.pollId) return json(res, 400, { error: 'bad-request' });
      const client = httpClients.get(String(body.pollId));
      if (!client) return json(res, 410, { error: 'gone' });
      client.lastSeen = Date.now();
      const msgs = Array.isArray(body.msgs) ? body.msgs : (body.msg ? [body.msg] : []);
      for (const m of msgs.slice(0, 20)) {
        try { onMessage(client, JSON.stringify(m)); }
        catch (e) { console.error('[http msg]', e); }
      }
      const out = client.queue.splice(0, client.queue.length);
      return json(res, 200, { messages: out });
    });
  }
  if (p === '/api/poll' && req.method === 'GET') {
    const client = httpClients.get(String(u.searchParams.get('pollId') || ''));
    if (!client) return json(res, 410, { error: 'gone' });
    client.lastSeen = Date.now();
    if (client.seatId) {
      const room = state.rooms[client.roomId];
      const seat = room && room.seats[client.seatId];
      if (seat) { seat.lastSeen = Date.now(); if (!seat.online) { seat.online = true; seat.connId = client.connId; } }
    }
    // Always include a current snapshot so a dropped message cannot desync a page
    const out = client.queue.splice(0, client.queue.length);
    out.push(snapshotFor(client));
    return json(res, 200, { messages: out });
  }

  if (p === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const occ = {};
    for (const id of ROOM_IDS) occ[id] = roomOccupancy(state.rooms[id]);
    return res.end(JSON.stringify({
      ok: true, clients: clients.size, occupancy: occ,
      freezeAll: state.classroom.freezeAll, presenting: state.classroom.presenting
    }));
  }
  if (p === '/export') {
    if (!timingSafeEqual(u.searchParams.get('key') || '', FACILITATOR_KEY)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Forbidden: add ?key=YOUR_FACILITATOR_KEY');
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="classroom-responses.json"'
    });
    return res.end(JSON.stringify(buildExport(), null, 2));
  }
  if (p === '/' || p === '/index.html') return serveFile(res, path.join(__dirname, 'index.html'), 200, req);
  if (p === '/facilitator' || p === '/facilitator.html') {
    return serveFile(res, path.join(__dirname, 'facilitator.html'), 200, req);
  }

  // Static assets, constrained to this directory
  const safe = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(__dirname, safe);
  if (!file.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }
  serveFile(res, file, 200, req);
});

ws.attach(server, (conn) => {
  const client = {
    conn: conn, connId: conn.id, role: 'student', roomId: null,
    seatId: null, token: null, name: null, lastSeen: Date.now()
  };
  clients.set(conn.id, client);
  conn.on('message', (raw) => {
    if (typeof raw !== 'string') return;
    try { onMessage(client, raw); }
    catch (e) { console.error('[msg]', e); sendTo(client, { type: 'error', message: 'server error' }); }
  });
  conn.on('close', () => {
    clients.delete(conn.id);
    if (client.roomId && client.seatId) {
      const room = state.rooms[client.roomId];
      const seat = room && room.seats[client.seatId];
      if (seat && seat.connId === conn.id) {
        seat.online = false;
        seat.connId = null;
        seat.lastSeen = Date.now();     // starts the reconnect grace period
      }
      broadcast();
    }
  });
  sendTo(client, { type: 'hello', stages: STAGES });
}, { path: '/ws' });

loadState();
server.listen(PORT, HOST, () => {
  const shown = (HOST === '0.0.0.0' || HOST === '::') ? 'localhost' : HOST;
  console.log('');
  console.log('  Synthetic-control classroom is running.');
  console.log('');
  console.log('  Students      http://' + shown + ':' + PORT + '/');
  console.log('  Facilitator   http://' + shown + ':' + PORT + '/facilitator?key=' + FACILITATOR_KEY);
  console.log('');
  console.log('  Facilitator key: ' + FACILITATOR_KEY);
  console.log('  (set FACILITATOR_KEY in the environment to choose your own)');
  console.log('');
});

function shutdown() {
  try {
    const out = JSON.stringify(state, (k, v) => (k === 'history' ? [] : v));
    fs.writeFileSync(STATE_FILE, out);
    console.log('\n[state] saved to ' + STATE_FILE);
  } catch (e) { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { server, state, buildExport, FACILITATOR_KEY };
