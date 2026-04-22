// =====================================================================
// Blitzkrieg server.
//   • Static file server for blitzkrieg.html, engine.js, knight.jpg, etc.
//   • WebSocket endpoint at /ws for online two-player Kriegspiel.
//
// Rooms are ephemeral (in-memory). Each room has an authoritative
// Referee instance, two player slots, a spectator list, and Fischer
// chess clocks. Clocks pause while a player is disconnected and
// resume when they return. Games can be resumed by URL + saved token.
// =====================================================================
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;

const Engine = require('./engine.js');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const INDEX = 'blitzkrieg.html';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------------
// Static file HTTP server (unchanged behavior from v1.0).
// ---------------------------------------------------------------------
const httpServer = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/' + INDEX;

  const requested = path.normalize(path.join(ROOT, urlPath));
  if (!requested.startsWith(ROOT)) {
    res.writeHead(400); res.end('Bad request'); return;
  }
  fs.stat(requested, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(requested).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(requested).pipe(res);
  });
});

// ---------------------------------------------------------------------
// Room model.
// ---------------------------------------------------------------------
const rooms = new Map(); // code -> Room

class Room {
  constructor(code, tc) {
    this.code = code;
    this.tc = tc; // { baseMs, incMs }
    this.referee = new Engine.Referee();
    this.players = { w: null, b: null };
    // slot = { token, ws, timeMs, connected }
    this.spectators = new Set();
    this.clockLastTick = null;
    this.clockRunning = false;
    this.capturedByWhite = []; // pieces White has taken from Black
    this.capturedByBlack = [];
    this.lastMoveByWhite = null;
    this.lastMoveByBlack = null;
    this.gameOver = false;
    this.result = null;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
  }

  touch() { this.lastActivity = Date.now(); }

  bothConnected() {
    return this.players.w && this.players.w.connected &&
           this.players.b && this.players.b.connected;
  }

  // Live clock values accounting for current-turn elapsed time.
  liveClocks() {
    const turn = this.referee.state.turn;
    let elapsed = 0;
    if (this.clockRunning && this.clockLastTick) {
      elapsed = Date.now() - this.clockLastTick;
    }
    const wBase = this.players.w ? this.players.w.timeMs : this.tc.baseMs;
    const bBase = this.players.b ? this.players.b.timeMs : this.tc.baseMs;
    const whiteMs = turn === 'w' ? wBase - elapsed : wBase;
    const blackMs = turn === 'b' ? bBase - elapsed : bBase;
    return { whiteMs: Math.max(0, whiteMs), blackMs: Math.max(0, blackMs) };
  }

  flagged() {
    const { whiteMs, blackMs } = this.liveClocks();
    if (whiteMs <= 0) return 'w';
    if (blackMs <= 0) return 'b';
    return null;
  }

  startClock() {
    if (this.gameOver) return;
    this.clockRunning = true;
    this.clockLastTick = Date.now();
  }
  pauseClock() {
    // Fold current-turn elapsed time into the running player's bank.
    if (this.clockRunning && this.clockLastTick) {
      const turn = this.referee.state.turn;
      const slot = this.players[turn];
      if (slot) {
        const elapsed = Date.now() - this.clockLastTick;
        slot.timeMs = Math.max(0, slot.timeMs - elapsed);
      }
    }
    this.clockRunning = false;
    this.clockLastTick = null;
  }
  // After a legal move: deduct elapsed from mover, add Fischer increment,
  // then (unless game ended) reset clockLastTick for opponent.
  applyMoveClocks(moverColor) {
    const slot = this.players[moverColor];
    if (!slot) return;
    const elapsed = this.clockLastTick ? Date.now() - this.clockLastTick : 0;
    slot.timeMs = Math.max(0, slot.timeMs - elapsed + this.tc.incMs);
    if (this.gameOver) {
      this.clockRunning = false;
      this.clockLastTick = null;
    } else {
      this.clockLastTick = Date.now();
      this.clockRunning = true;
    }
  }

  ownBoardFor(color) {
    const b = Engine.emptyBoard();
    const truth = this.referee.state.board;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = truth[r][c];
        if (p && Engine.colorOf(p) === color) b[r][c] = p;
      }
    }
    return b;
  }

  snapshotForPlayer(color) {
    const ownBoard = this.ownBoardFor(color);
    const myTurn = this.referee.state.turn === color && !this.gameOver;
    const { whiteMs, blackMs } = this.liveClocks();
    let checkDirections = null;
    if (Engine.inCheck(this.referee.state, color)) {
      checkDirections = Engine.checkDirections(this.referee.state.board, color);
    }
    return {
      role: 'player',
      color,
      turn: this.referee.state.turn,
      gameOver: this.gameOver,
      result: this.result,
      ownBoard,
      // What you've captured from the opponent (displayed on YOUR side).
      capturedByMe: color === 'w' ? this.capturedByWhite : this.capturedByBlack,
      // What you've LOST (displayed below your board).
      capturedByThem: color === 'w' ? this.capturedByBlack : this.capturedByWhite,
      lastOwnMove: color === 'w' ? this.lastMoveByWhite : this.lastMoveByBlack,
      whiteMs, blackMs,
      clockRunning: this.clockRunning,
      pawnTries: myTurn ? this.referee.pawnTries(color) : 0,
      // Public to both sides: the current mover's pawn-try count. Classic
      // Kriegspiel referees announce this to the room each turn.
      pawnTriesOfMover: this.gameOver
        ? 0
        : this.referee.pawnTries(this.referee.state.turn),
      pawnAttemptsThisTurn: this.referee.pawnAttemptsThisTurn,
      inCheckDirections: checkDirections,
      tc: this.tc,
      bothConnected: this.bothConnected(),
      // Full board when game is over so client can reveal true positions.
      finalBoard: this.gameOver ? this.referee.state.board : null
    };
  }

  snapshotForSpectator() {
    const { whiteMs, blackMs } = this.liveClocks();
    return {
      role: 'spectator',
      board: this.referee.state.board,
      turn: this.referee.state.turn,
      gameOver: this.gameOver,
      result: this.result,
      whiteMs, blackMs,
      clockRunning: this.clockRunning,
      lastMoveByWhite: this.lastMoveByWhite,
      lastMoveByBlack: this.lastMoveByBlack,
      capturedByWhite: this.capturedByWhite,
      capturedByBlack: this.capturedByBlack,
      pawnTriesOfMover: this.gameOver
        ? 0
        : this.referee.pawnTries(this.referee.state.turn),
      tc: this.tc,
      bothConnected: this.bothConnected()
    };
  }
}

// ---------------------------------------------------------------------
// Code + token generators.
// ---------------------------------------------------------------------
// No I/O/0/1 to avoid typing confusion.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}
function genToken() {
  return crypto.randomBytes(18).toString('hex');
}

// ---------------------------------------------------------------------
// WebSocket helpers.
// ---------------------------------------------------------------------
function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch (e) { /* swallow */ }
  }
}
function sendError(ws, message, reason) {
  send(ws, { type: 'error', message, reason });
}
function broadcastToRoom(room, msg, exclude = null) {
  for (const color of ['w', 'b']) {
    const slot = room.players[color];
    if (slot && slot.connected && slot.ws !== exclude) send(slot.ws, msg);
  }
  for (const sp of room.spectators) {
    if (sp !== exclude) send(sp, msg);
  }
}
function sendLobby(room) {
  broadcastToRoom(room, {
    type: 'lobby',
    white: !!(room.players.w && room.players.w.connected),
    black: !!(room.players.b && room.players.b.connected),
    whiteSeated: !!room.players.w,
    blackSeated: !!room.players.b,
    spectators: room.spectators.size
  });
}

// ---------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------
function handleCreate(ws, msg) {
  const min = Math.min(180, Math.max(1, Number(msg?.timeControl?.min) || 10));
  const inc = Math.min(60, Math.max(0, Number(msg?.timeControl?.inc) || 5));
  const tc = { baseMs: min * 60 * 1000, incMs: inc * 1000 };
  let code;
  for (let i = 0; i < 20; i++) {
    code = genCode();
    if (!rooms.has(code)) break;
  }
  const room = new Room(code, tc);

  let color = msg?.prefColor;
  if (color !== 'w' && color !== 'b') color = Math.random() < 0.5 ? 'w' : 'b';
  const token = genToken();
  room.players[color] = { token, ws, timeMs: tc.baseMs, connected: true };
  ws.meta = { code, role: 'player', color, token };
  rooms.set(code, room);
  room.touch();

  send(ws, { type: 'created', code, token, color, tc });
  sendLobby(room);
}

function handleJoin(ws, msg) {
  const code = (msg?.code || '').toString().toUpperCase();
  const room = rooms.get(code);
  if (!room) return sendError(ws, 'Game not found.', 'not-found');
  let color = null;
  if (!room.players.w) color = 'w';
  else if (!room.players.b) color = 'b';
  else return sendError(ws, 'Game is full. You can spectate instead.', 'full');
  const token = genToken();
  room.players[color] = { token, ws, timeMs: room.tc.baseMs, connected: true };
  ws.meta = { code: room.code, role: 'player', color, token };
  room.touch();
  send(ws, { type: 'joined', code: room.code, token, color, tc: room.tc });

  if (room.players.w && room.players.b && !room.gameOver) {
    // Game starts.
    room.startClock();
    for (const c of ['w','b']) {
      const slot = room.players[c];
      if (slot && slot.connected) {
        send(slot.ws, { type: 'started', snapshot: room.snapshotForPlayer(c) });
      }
    }
    for (const sp of room.spectators) {
      send(sp, { type: 'started', snapshot: room.snapshotForSpectator() });
    }
  }
  sendLobby(room);
}

function handleSpectate(ws, msg) {
  const code = (msg?.code || '').toString().toUpperCase();
  const room = rooms.get(code);
  if (!room) return sendError(ws, 'Game not found.', 'not-found');
  room.spectators.add(ws);
  ws.meta = { code: room.code, role: 'spectator' };
  room.touch();
  send(ws, { type: 'spectating', code: room.code, tc: room.tc, snapshot: room.snapshotForSpectator() });
  sendLobby(room);
}

function handleResume(ws, msg) {
  const code = (msg?.code || '').toString().toUpperCase();
  const room = rooms.get(code);
  if (!room) return sendError(ws, 'Game not found.', 'not-found');
  const token = msg?.token;
  let color = null;
  if (room.players.w && room.players.w.token === token) color = 'w';
  else if (room.players.b && room.players.b.token === token) color = 'b';
  else return sendError(ws, 'Invalid resume token for this game.', 'bad-token');

  const slot = room.players[color];
  // If there was an old socket still open, close it.
  if (slot.ws && slot.ws !== ws && slot.ws.readyState === WebSocket.OPEN) {
    try { slot.ws.close(4000, 'Replaced by newer connection'); } catch(e) {}
  }
  slot.ws = ws;
  slot.connected = true;
  ws.meta = { code: room.code, role: 'player', color, token: slot.token };
  room.touch();

  send(ws, { type: 'resumed', code: room.code, color, tc: room.tc, snapshot: room.snapshotForPlayer(color) });
  // Notify opponent they're back, resume clocks if both present.
  broadcastToRoom(room, { type: 'opponentReconnected', color }, ws);
  if (!room.gameOver && room.bothConnected() && !room.clockRunning) {
    room.startClock();
    broadcastToRoom(room, {
      type: 'clock',
      ...room.liveClocks(),
      turn: room.referee.state.turn,
      clockRunning: true
    });
  }
  sendLobby(room);
}

function handleMove(ws, msg) {
  const meta = ws.meta;
  if (!meta || meta.role !== 'player') return sendError(ws, 'Not a player.');
  const room = rooms.get(meta.code);
  if (!room) return sendError(ws, 'Game not found.', 'not-found');
  if (room.gameOver) return sendError(ws, 'Game is already over.');
  if (!room.bothConnected()) return sendError(ws, 'Waiting for opponent to reconnect.', 'opponent-gone');

  room.touch();

  // Check for flag before processing
  const fl = room.flagged();
  if (fl) return endByFlag(room, fl);

  const result = room.referee.attemptMove(meta.color, msg.desired);
  if (!result.ok) {
    send(ws, {
      type: 'moveRejected',
      announcements: result.announcements,
      pawnAttemptsThisTurn: room.referee.pawnAttemptsThisTurn,
      pawnTries: room.referee.pawnTries(meta.color)
    });
    return;
  }

  // Update captured log
  const capAnn = result.announcements.find(a => a.kind === 'capture');
  if (capAnn) {
    if (capAnn.captorColor === 'w') room.capturedByWhite.push(capAnn.piece);
    else room.capturedByBlack.push(capAnn.piece);
  }
  // Last-move highlight
  const moveFromTo = { from: result.move.from, to: result.move.to };
  if (meta.color === 'w') room.lastMoveByWhite = moveFromTo;
  else room.lastMoveByBlack = moveFromTo;

  const ended = !!result.result;
  if (ended) {
    room.gameOver = true;
    room.result = result.result;
  }

  // Now apply clocks (after setting gameOver so applyMoveClocks stops the tick).
  room.applyMoveClocks(meta.color);

  const { whiteMs, blackMs } = room.liveClocks();
  const clockInfo = {
    whiteMs, blackMs,
    turn: room.referee.state.turn,
    clockRunning: room.clockRunning
  };

  const oppColor = meta.color === 'w' ? 'b' : 'w';
  const oppSlot = room.players[oppColor];

  // Kriegspiel-public: the new mover's pawn-try count is announced to
  // everyone in the room (both players + spectators), matching how a live
  // referee calls it out each turn.
  const pawnTriesOfMover = ended
    ? 0
    : room.referee.pawnTries(room.referee.state.turn);

  send(ws, {
    type: 'moveAccepted',
    move: result.move,
    announcements: result.announcements,
    ...clockInfo,
    pawnAttemptsThisTurn: 0,
    pawnTriesOfMover,
    gameOver: ended,
    result: ended ? result.result : null,
    finalBoard: ended ? room.referee.state.board : null
  });

  if (oppSlot && oppSlot.connected) {
    // The opponent doesn't see the from/to, just that the opponent moved,
    // plus the Kriegspiel-public announcements (captures, checks, end).
    send(oppSlot.ws, {
      type: 'opponentMoved',
      announcements: result.announcements,
      ...clockInfo,
      pawnTries: ended ? 0 : room.referee.pawnTries(oppColor),
      pawnTriesOfMover,
      pawnAttemptsThisTurn: room.referee.pawnAttemptsThisTurn,
      gameOver: ended,
      result: ended ? result.result : null,
      finalBoard: ended ? room.referee.state.board : null
    });
  }

  for (const sp of room.spectators) {
    send(sp, {
      type: 'spectatorUpdate',
      board: room.referee.state.board,
      moverColor: meta.color,
      move: moveFromTo,
      lastMoveByWhite: room.lastMoveByWhite,
      lastMoveByBlack: room.lastMoveByBlack,
      announcements: result.announcements,
      ...clockInfo,
      capturedByWhite: room.capturedByWhite,
      capturedByBlack: room.capturedByBlack,
      pawnTriesOfMover,
      gameOver: ended,
      result: ended ? result.result : null
    });
  }
}

function endByFlag(room, flaggedColor) {
  if (room.gameOver) return;
  room.gameOver = true;
  room.result = { type: 'time', winner: flaggedColor === 'w' ? 'b' : 'w' };
  room.pauseClock();
  broadcastToRoom(room, {
    type: 'ended',
    result: room.result,
    reason: 'time',
    flaggedColor,
    finalBoard: room.referee.state.board
  });
}

function handleResign(ws) {
  const meta = ws.meta;
  if (!meta || meta.role !== 'player') return;
  const room = rooms.get(meta.code);
  if (!room || room.gameOver) return;
  room.gameOver = true;
  room.result = { type: 'resign', winner: meta.color === 'w' ? 'b' : 'w' };
  room.pauseClock();
  broadcastToRoom(room, {
    type: 'ended',
    result: room.result,
    reason: 'resign',
    resignedColor: meta.color,
    finalBoard: room.referee.state.board
  });
}

function handleDisconnect(ws) {
  const meta = ws.meta;
  if (!meta) return;
  const room = rooms.get(meta.code);
  if (!room) return;
  if (meta.role === 'spectator') {
    room.spectators.delete(ws);
    sendLobby(room);
    return;
  }
  const slot = room.players[meta.color];
  if (!slot || slot.ws !== ws) return; // already replaced
  slot.connected = false;
  // Pause clock (commit any elapsed to the current mover).
  if (!room.gameOver && room.clockRunning) {
    room.pauseClock();
  }
  broadcastToRoom(room, {
    type: 'opponentDisconnected',
    color: meta.color,
    ...room.liveClocks(),
    turn: room.referee.state.turn,
    clockRunning: false
  });
  sendLobby(room);
}

// ---------------------------------------------------------------------
// WebSocket server wired to the same HTTP server for simpler deploys.
// ---------------------------------------------------------------------
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch (e) { return sendError(ws, 'Bad JSON.'); }
    const t = msg && msg.type;
    switch (t) {
      case 'create':   return handleCreate(ws, msg);
      case 'join':     return handleJoin(ws, msg);
      case 'spectate': return handleSpectate(ws, msg);
      case 'resume':   return handleResume(ws, msg);
      case 'move':     return handleMove(ws, msg);
      case 'resign':   return handleResign(ws);
      case 'ping':     return send(ws, { type: 'pong' });
      default:         return sendError(ws, 'Unknown message type: ' + t);
    }
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => {}); // swallow errors so the server keeps running
});

// Heartbeat: drop sockets that fail to pong within 60s.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch(e) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch(e) {}
  });
}, 30 * 1000);
wss.on('close', () => clearInterval(heartbeat));

// Flag-check tick: end games when a player's clock hits zero.
setInterval(() => {
  for (const [, room] of rooms) {
    if (room.gameOver || !room.clockRunning) continue;
    const fl = room.flagged();
    if (fl) endByFlag(room, fl);
  }
}, 500);

// Garbage-collect rooms that have been idle with nobody connected for 6 hours.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyoneHere =
      (room.players.w && room.players.w.connected) ||
      (room.players.b && room.players.b.connected) ||
      room.spectators.size > 0;
    if (!anyoneHere && (now - room.lastActivity) > 6 * 60 * 60 * 1000) {
      rooms.delete(code);
    }
  }
}, 60 * 1000);

httpServer.listen(PORT, () => {
  console.log(`Blitzkrieg serving on port ${PORT}  (WebSocket: /ws)`);
});
