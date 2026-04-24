// =====================================================================
// Blitzkrieg / Kriegspiel chess engine.
//
// Shared between the browser (vs-Computer mode) and the Node server
// (the authoritative referee for online play). Uses a UMD-ish wrapper
// so the same file works in both environments without a build step.
// =====================================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BlitzkriegEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FILES = 'abcdefgh';
  const GLYPHS = {
    K: '\u2654', Q: '\u2655', R: '\u2656', B: '\u2657', N: '\u2658', P: '\u2659',
    k: '\u265A', q: '\u265B', r: '\u265C', b: '\u265D', n: '\u265E', p: '\u265F'
  };

  // ------------------------------------------------------------------
  // Board primitives.
  // Position = 8x8 array of single-char pieces (or null).
  // Uppercase = White, lowercase = Black.
  // Row 0 = rank 8 (Black back rank); row 7 = rank 1 (White back rank).
  // Col 0 = file a; col 7 = file h.
  // ------------------------------------------------------------------
  function emptyBoard() {
    const b = [];
    for (let r = 0; r < 8; r++) b.push(new Array(8).fill(null));
    return b;
  }
  function initialPosition() {
    const b = emptyBoard();
    const back = ['r','n','b','q','k','b','n','r'];
    for (let c = 0; c < 8; c++) {
      b[0][c] = back[c];
      b[1][c] = 'p';
      b[6][c] = 'P';
      b[7][c] = back[c].toUpperCase();
    }
    return b;
  }
  function cloneBoard(b) { return b.map(row => row.slice()); }
  function colorOf(p) { return !p ? null : (p === p.toUpperCase() ? 'w' : 'b'); }
  function isSameColor(p, color) { return p && colorOf(p) === color; }
  function kindOf(p) { return p ? p.toUpperCase() : null; }
  function onBoard(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
  function sqName(r, c) { return FILES[c] + (8 - r); }
  function sqParse(s) {
    if (!s || s.length < 2) return null;
    const c = FILES.indexOf(s[0].toLowerCase());
    const r = 8 - parseInt(s[1], 10);
    if (!onBoard(r, c)) return null;
    return { r, c };
  }

  function initialState() {
    return {
      board: initialPosition(),
      turn: 'w',
      castling: { K: true, Q: true, k: true, q: true },
      ep: null,
      halfmove: 0,
      fullmove: 1
    };
  }
  function cloneState(s) {
    return {
      board: cloneBoard(s.board),
      turn: s.turn,
      castling: { ...s.castling },
      ep: s.ep ? { ...s.ep } : null,
      halfmove: s.halfmove,
      fullmove: s.fullmove
    };
  }

  // ------------------------------------------------------------------
  // Move generation (pseudo-legal, then filtered for self-check).
  // ------------------------------------------------------------------
  function pseudoLegalMoves(state, color) {
    const moves = [];
    const b = state.board;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = b[r][c];
        if (!p || colorOf(p) !== color) continue;
        const k = kindOf(p);
        if (k === 'P') genPawn(state, r, c, color, moves);
        else if (k === 'N') genLeaper(state, r, c, color, [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]], moves);
        else if (k === 'B') genSlider(state, r, c, color, [[-1,-1],[-1,1],[1,-1],[1,1]], moves);
        else if (k === 'R') genSlider(state, r, c, color, [[-1,0],[1,0],[0,-1],[0,1]], moves);
        else if (k === 'Q') genSlider(state, r, c, color, [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]], moves);
        else if (k === 'K') {
          genLeaper(state, r, c, color, [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]], moves);
          genCastling(state, r, c, color, moves);
        }
      }
    }
    return moves;
  }
  function genPawn(state, r, c, color, moves) {
    const b = state.board;
    const dir = color === 'w' ? -1 : 1;
    const startRow = color === 'w' ? 6 : 1;
    const promoRow = color === 'w' ? 0 : 7;
    if (onBoard(r + dir, c) && !b[r + dir][c]) {
      if (r + dir === promoRow) {
        for (const pr of ['Q','R','B','N']) {
          moves.push({from:{r,c}, to:{r:r+dir, c}, piece:'P', promo: color==='w'?pr:pr.toLowerCase()});
        }
      } else {
        moves.push({from:{r,c}, to:{r:r+dir, c}, piece:'P'});
        if (r === startRow && !b[r + 2*dir][c]) {
          moves.push({from:{r,c}, to:{r:r+2*dir, c}, piece:'P', double:true});
        }
      }
    }
    for (const dc of [-1, 1]) {
      const nr = r + dir, nc = c + dc;
      if (!onBoard(nr, nc)) continue;
      const target = b[nr][nc];
      if (target && colorOf(target) !== color) {
        if (nr === promoRow) {
          for (const pr of ['Q','R','B','N']) {
            moves.push({from:{r,c}, to:{r:nr, c:nc}, piece:'P', capture:true, promo: color==='w'?pr:pr.toLowerCase()});
          }
        } else {
          moves.push({from:{r,c}, to:{r:nr, c:nc}, piece:'P', capture:true});
        }
      }
      if (state.ep && state.ep.r === nr && state.ep.c === nc) {
        moves.push({from:{r,c}, to:{r:nr, c:nc}, piece:'P', capture:true, enPassant:true});
      }
    }
  }
  function genLeaper(state, r, c, color, deltas, moves) {
    const b = state.board;
    const piece = b[r][c];
    for (const [dr, dc] of deltas) {
      const nr = r + dr, nc = c + dc;
      if (!onBoard(nr, nc)) continue;
      const t = b[nr][nc];
      if (!t) moves.push({from:{r,c}, to:{r:nr,c:nc}, piece: kindOf(piece)});
      else if (colorOf(t) !== color) moves.push({from:{r,c}, to:{r:nr,c:nc}, piece: kindOf(piece), capture:true});
    }
  }
  function genSlider(state, r, c, color, dirs, moves) {
    const b = state.board;
    const piece = b[r][c];
    for (const [dr, dc] of dirs) {
      let nr = r + dr, nc = c + dc;
      while (onBoard(nr, nc)) {
        const t = b[nr][nc];
        if (!t) { moves.push({from:{r,c}, to:{r:nr,c:nc}, piece: kindOf(piece)}); }
        else {
          if (colorOf(t) !== color) moves.push({from:{r,c}, to:{r:nr,c:nc}, piece: kindOf(piece), capture:true});
          break;
        }
        nr += dr; nc += dc;
      }
    }
  }
  function genCastling(state, r, c, color, moves) {
    const b = state.board;
    const back = color === 'w' ? 7 : 0;
    if (r !== back || c !== 4) return;
    if (isSquareAttacked(b, r, c, color === 'w' ? 'b' : 'w')) return;
    const kKey = color === 'w' ? 'K' : 'k';
    const qKey = color === 'w' ? 'Q' : 'q';
    if (state.castling[kKey]) {
      if (!b[back][5] && !b[back][6] &&
          !isSquareAttacked(b, back, 5, color === 'w' ? 'b' : 'w') &&
          !isSquareAttacked(b, back, 6, color === 'w' ? 'b' : 'w')) {
        const rookChar = color === 'w' ? 'R' : 'r';
        if (b[back][7] === rookChar) {
          moves.push({from:{r,c}, to:{r:back, c:6}, piece:'K', castle:'K'});
        }
      }
    }
    if (state.castling[qKey]) {
      if (!b[back][1] && !b[back][2] && !b[back][3] &&
          !isSquareAttacked(b, back, 3, color === 'w' ? 'b' : 'w') &&
          !isSquareAttacked(b, back, 2, color === 'w' ? 'b' : 'w')) {
        const rookChar = color === 'w' ? 'R' : 'r';
        if (b[back][0] === rookChar) {
          moves.push({from:{r,c}, to:{r:back, c:2}, piece:'K', castle:'Q'});
        }
      }
    }
  }
  function isSquareAttacked(board, r, c, byColor) {
    const pDir = byColor === 'w' ? -1 : 1;
    const pawnChar = byColor === 'w' ? 'P' : 'p';
    for (const dc of [-1, 1]) {
      const ar = r - pDir, ac = c - dc;
      if (onBoard(ar, ac) && board[ar][ac] === pawnChar) return true;
    }
    const knightChar = byColor === 'w' ? 'N' : 'n';
    for (const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
      const nr = r+dr, nc = c+dc;
      if (onBoard(nr,nc) && board[nr][nc] === knightChar) return true;
    }
    const kingChar = byColor === 'w' ? 'K' : 'k';
    for (const [dr,dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
      const nr = r+dr, nc = c+dc;
      if (onBoard(nr,nc) && board[nr][nc] === kingChar) return true;
    }
    const rookQ = byColor === 'w' ? ['R','Q'] : ['r','q'];
    for (const [dr,dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      let nr = r+dr, nc = c+dc;
      while (onBoard(nr, nc)) {
        const p = board[nr][nc];
        if (p) { if (rookQ.includes(p)) return true; break; }
        nr += dr; nc += dc;
      }
    }
    const bishQ = byColor === 'w' ? ['B','Q'] : ['b','q'];
    for (const [dr,dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
      let nr = r+dr, nc = c+dc;
      while (onBoard(nr, nc)) {
        const p = board[nr][nc];
        if (p) { if (bishQ.includes(p)) return true; break; }
        nr += dr; nc += dc;
      }
    }
    return false;
  }

  function findKing(board, color) {
    const target = color === 'w' ? 'K' : 'k';
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (board[r][c] === target) return {r,c};
    return null;
  }
  function inCheck(state, color) {
    const k = findKing(state.board, color);
    if (!k) return false;
    return isSquareAttacked(state.board, k.r, k.c, color === 'w' ? 'b' : 'w');
  }

  function applyMove(state, move) {
    const ns = cloneState(state);
    const b = ns.board;
    const piece = b[move.from.r][move.from.c];
    let captured = null;

    if (move.enPassant) {
      const capRow = move.from.r;
      captured = { piece: b[capRow][move.to.c], r: capRow, c: move.to.c };
      b[capRow][move.to.c] = null;
    } else if (b[move.to.r][move.to.c]) {
      captured = { piece: b[move.to.r][move.to.c], r: move.to.r, c: move.to.c };
    }

    b[move.to.r][move.to.c] = move.promo ? move.promo : piece;
    b[move.from.r][move.from.c] = null;

    if (move.castle === 'K') {
      const back = move.from.r;
      b[back][5] = b[back][7]; b[back][7] = null;
    } else if (move.castle === 'Q') {
      const back = move.from.r;
      b[back][3] = b[back][0]; b[back][0] = null;
    }

    if (piece === 'K') { ns.castling.K = false; ns.castling.Q = false; }
    if (piece === 'k') { ns.castling.k = false; ns.castling.q = false; }
    if (piece === 'R' && move.from.r === 7 && move.from.c === 0) ns.castling.Q = false;
    if (piece === 'R' && move.from.r === 7 && move.from.c === 7) ns.castling.K = false;
    if (piece === 'r' && move.from.r === 0 && move.from.c === 0) ns.castling.q = false;
    if (piece === 'r' && move.from.r === 0 && move.from.c === 7) ns.castling.k = false;
    if (captured) {
      if (move.to.r === 7 && move.to.c === 0) ns.castling.Q = false;
      if (move.to.r === 7 && move.to.c === 7) ns.castling.K = false;
      if (move.to.r === 0 && move.to.c === 0) ns.castling.q = false;
      if (move.to.r === 0 && move.to.c === 7) ns.castling.k = false;
    }

    if (move.double) {
      ns.ep = { r: (move.from.r + move.to.r) / 2, c: move.from.c };
    } else {
      ns.ep = null;
    }

    if (kindOf(piece) === 'P' || captured) ns.halfmove = 0;
    else ns.halfmove++;

    if (ns.turn === 'b') ns.fullmove++;
    ns.turn = ns.turn === 'w' ? 'b' : 'w';

    return { state: ns, captured };
  }

  function legalMoves(state, color) {
    return pseudoLegalMoves(state, color).filter(m => {
      const { state: ns } = applyMove(state, m);
      return !inCheck(ns, color);
    });
  }
  function isCheckmate(state) {
    return inCheck(state, state.turn) && legalMoves(state, state.turn).length === 0;
  }
  function isStalemate(state) {
    return !inCheck(state, state.turn) && legalMoves(state, state.turn).length === 0;
  }

  function movesEqual(a, b) {
    if (!a || !b) return false;
    if (a.from.r !== b.from.r || a.from.c !== b.from.c) return false;
    if (a.to.r !== b.to.r || a.to.c !== b.to.c) return false;
    if (a.promo && b.promo && a.promo.toUpperCase() !== b.promo.toUpperCase()) return false;
    if (a.promo && !b.promo) {
      return a.promo.toUpperCase() === 'Q';
    }
    return true;
  }

  // Given the board and the color currently in check, return list of directions.
  function checkDirections(board, checkedColor) {
    const k = findKing(board, checkedColor);
    if (!k) return [];
    const attackerColor = checkedColor === 'w' ? 'b' : 'w';
    const dirs = [];
    const knightChar = attackerColor === 'w' ? 'N' : 'n';
    for (const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
      const nr = k.r+dr, nc = k.c+dc;
      if (onBoard(nr,nc) && board[nr][nc] === knightChar) { dirs.push('knight'); break; }
    }
    const rookQ = attackerColor === 'w' ? ['R','Q'] : ['r','q'];
    for (const [dr,dc] of [[0,-1],[0,1]]) {
      let nr = k.r+dr, nc = k.c+dc;
      while (onBoard(nr,nc)) {
        const p = board[nr][nc];
        if (p) { if (rookQ.includes(p)) dirs.push('horizontal'); break; }
        nr+=dr; nc+=dc;
      }
      if (dirs.includes('horizontal')) break;
    }
    for (const [dr,dc] of [[-1,0],[1,0]]) {
      let nr = k.r+dr, nc = k.c+dc;
      while (onBoard(nr,nc)) {
        const p = board[nr][nc];
        if (p) { if (rookQ.includes(p)) dirs.push('vertical'); break; }
        nr+=dr; nc+=dc;
      }
      if (dirs.includes('vertical')) break;
    }
    const bishQ = attackerColor === 'w' ? ['B','Q'] : ['b','q'];
    let diag = false;
    for (const [dr,dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
      let nr = k.r+dr, nc = k.c+dc;
      let steps = 0;
      while (onBoard(nr,nc)) {
        const p = board[nr][nc];
        steps++;
        if (p) {
          if (bishQ.includes(p)) diag = true;
          if (steps === 1) {
            const pawnChar = attackerColor === 'w' ? 'P' : 'p';
            if (p === pawnChar) {
              const pawnForward = attackerColor === 'w' ? -1 : 1;
              if (dr === -pawnForward) diag = true;
            }
          }
          break;
        }
        nr+=dr; nc+=dc;
      }
      if (diag) break;
    }
    if (diag) dirs.push('diagonal');
    return dirs;
  }

  // ------------------------------------------------------------------
  // Referee — authoritative state + Kriegspiel announcements.
  // Used by both the in-browser local mode and the online server.
  // ------------------------------------------------------------------
  const MAX_PAWN_ATTEMPTS = 3;

  function onlyKingsLeft(board) {
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++)
        if (board[r][c] && kindOf(board[r][c]) !== 'K') return false;
    return true;
  }

  class Referee {
    constructor() {
      this.state = initialState();
      this.gameOver = false;
      this.result = null;
      this.pawnAttemptsThisTurn = 0;
    }

    pawnTries(color) {
      return legalMoves(this.state, color).filter(m => m.piece === 'P' && m.capture).length;
    }

    canAttemptPawnCapture(color) {
      if (this.state.turn !== color) return false;
      return this.pawnAttemptsThisTurn < MAX_PAWN_ATTEMPTS;
    }

    attemptMove(color, desired) {
      if (this.gameOver) {
        return { ok: false, announcements: [{ kind: 'illegal', text: 'Game is already over.' }] };
      }
      if (this.state.turn !== color) {
        return { ok: false, announcements: [{ kind: 'illegal', text: "Not your turn." }] };
      }

      const fromPiece = this.state.board[desired.from.r][desired.from.c];
      const isPawnCaptureAttempt =
        fromPiece && kindOf(fromPiece) === 'P' &&
        desired.from.c !== desired.to.c;
      if (isPawnCaptureAttempt && this.pawnAttemptsThisTurn >= MAX_PAWN_ATTEMPTS) {
        return {
          ok: false,
          announcements: [{
            kind: 'pawn-attempts-exhausted',
            text: `No more pawn-capture attempts this turn (max ${MAX_PAWN_ATTEMPTS}).`
          }]
        };
      }

      const legals = legalMoves(this.state, color);
      const matched = legals.find(m => movesEqual(m, desired));
      if (!matched) {
        if (isPawnCaptureAttempt && this.pawnAttemptsThisTurn < MAX_PAWN_ATTEMPTS) {
          this.pawnAttemptsThisTurn++;
        }
        return { ok: false, announcements: [{ kind: 'illegal', text: 'No.' }] };
      }

      const { state: ns, captured } = applyMove(this.state, matched);
      this.state = ns;
      this.pawnAttemptsThisTurn = 0;

      const announcements = [];
      if (captured) {
        announcements.push({
          kind: 'capture',
          square: sqName(captured.r, captured.c),
          piece: captured.piece,
          capturedColor: colorOf(captured.piece),
          captorColor: color
        });
      }
      // Promotion: tell both sides a pawn just turned into something bigger.
      // In Kriegspiel the opponent needs to know the new piece exists, because
      // their strategic model of the board has to account for it.
      if (matched.promo) {
        announcements.push({
          kind: 'promotion',
          square: sqName(matched.to.r, matched.to.c),
          piece: matched.promo,          // 'Q','R','B','N' or lowercase
          promoteColor: color
        });
      }
      const otherColor = color === 'w' ? 'b' : 'w';
      if (inCheck(this.state, otherColor)) {
        const dirs = checkDirections(this.state.board, otherColor);
        announcements.push({
          kind: 'check',
          checkedColor: otherColor,
          directions: dirs
        });
      }

      const otherLegal = legalMoves(this.state, otherColor);
      if (otherLegal.length === 0) {
        this.gameOver = true;
        if (inCheck(this.state, otherColor)) {
          this.result = { type: 'checkmate', winner: color };
          announcements.push({ kind: 'end', text: `Checkmate. ${color === 'w' ? 'White' : 'Black'} wins.` });
        } else {
          this.result = { type: 'stalemate' };
          announcements.push({ kind: 'end', text: 'Stalemate. Draw.' });
        }
      }

      // Kings-only draw: if both sides have only a king left the position is
      // dead — neither can checkmate the other by any legal sequence.
      if (!this.gameOver && onlyKingsLeft(this.state.board)) {
        this.gameOver = true;
        this.result = { type: 'draw', reason: 'only-kings' };
        announcements.push({ kind: 'end', text: 'Draw — only kings remain.' });
      }

      return { ok: true, announcements, move: matched, captured, result: this.result };
    }
  }

  // ------------------------------------------------------------------
  // Player view — what one side perceives (their own pieces only).
  // ------------------------------------------------------------------
  class PlayerView {
    constructor(color) {
      this.color = color;
      this.ownBoard = emptyBoard();
      const init = initialPosition();
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const p = init[r][c];
          if (p && colorOf(p) === color) this.ownBoard[r][c] = p;
        }
      }
      this.enemyHints = {};
      this.capturedByMe = [];
      this.capturedByThem = [];
      this.lastOwnMove = null;
      this.lastEnemyCaptureSquare = null;
    }
    applyOwnMove(move) {
      const piece = this.ownBoard[move.from.r][move.from.c];
      this.ownBoard[move.to.r][move.to.c] = move.promo ? move.promo : piece;
      this.ownBoard[move.from.r][move.from.c] = null;
      if (move.castle === 'K') {
        const back = move.from.r;
        this.ownBoard[back][5] = this.ownBoard[back][7];
        this.ownBoard[back][7] = null;
      } else if (move.castle === 'Q') {
        const back = move.from.r;
        this.ownBoard[back][3] = this.ownBoard[back][0];
        this.ownBoard[back][0] = null;
      }
      this.lastOwnMove = { from: {...move.from}, to: {...move.to} };
      this.lastEnemyCaptureSquare = null;
      delete this.enemyHints[sqName(move.to.r, move.to.c)];
    }
    opponentCapturedAt(r, c) {
      const piece = this.ownBoard[r][c];
      if (piece) {
        this.capturedByThem.push(piece);
        this.ownBoard[r][c] = null;
      }
      this.enemyHints[sqName(r,c)] = true;
      this.lastEnemyCaptureSquare = { r, c };
    }
    capturedOpponentAt(piece, r, c) {
      this.capturedByMe.push(piece);
      delete this.enemyHints[sqName(r,c)];
    }
    opponentSilentMove() {
      this.enemyHints = {};
      this.lastEnemyCaptureSquare = null;
    }
  }

  // ------------------------------------------------------------------
  // AI opponent — used only in vs-Computer mode (browser).
  // Negamax + alpha-beta + piece-square tables, on its blind guess.
  // ------------------------------------------------------------------
  const PIECE_VALUES = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 20000 };
  const PST = {
    P: [
      [ 0,  0,  0,  0,  0,  0,  0,  0],
      [50, 50, 50, 50, 50, 50, 50, 50],
      [10, 10, 20, 30, 30, 20, 10, 10],
      [ 5,  5, 10, 25, 25, 10,  5,  5],
      [ 0,  0,  0, 20, 20,  0,  0,  0],
      [ 5, -5,-10,  0,  0,-10, -5,  5],
      [ 5, 10, 10,-20,-20, 10, 10,  5],
      [ 0,  0,  0,  0,  0,  0,  0,  0]
    ],
    N: [
      [-50,-40,-30,-30,-30,-30,-40,-50],
      [-40,-20,  0,  0,  0,  0,-20,-40],
      [-30,  0, 10, 15, 15, 10,  0,-30],
      [-30,  5, 15, 20, 20, 15,  5,-30],
      [-30,  0, 15, 20, 20, 15,  0,-30],
      [-30,  5, 10, 15, 15, 10,  5,-30],
      [-40,-20,  0,  5,  5,  0,-20,-40],
      [-50,-40,-30,-30,-30,-30,-40,-50]
    ],
    B: [
      [-20,-10,-10,-10,-10,-10,-10,-20],
      [-10,  0,  0,  0,  0,  0,  0,-10],
      [-10,  0,  5, 10, 10,  5,  0,-10],
      [-10,  5,  5, 10, 10,  5,  5,-10],
      [-10,  0, 10, 10, 10, 10,  0,-10],
      [-10, 10, 10, 10, 10, 10, 10,-10],
      [-10,  5,  0,  0,  0,  0,  5,-10],
      [-20,-10,-10,-10,-10,-10,-10,-20]
    ],
    R: [
      [ 0,  0,  0,  0,  0,  0,  0,  0],
      [ 5, 10, 10, 10, 10, 10, 10,  5],
      [-5,  0,  0,  0,  0,  0,  0, -5],
      [-5,  0,  0,  0,  0,  0,  0, -5],
      [-5,  0,  0,  0,  0,  0,  0, -5],
      [-5,  0,  0,  0,  0,  0,  0, -5],
      [-5,  0,  0,  0,  0,  0,  0, -5],
      [ 0,  0,  0,  5,  5,  0,  0,  0]
    ],
    Q: [
      [-20,-10,-10, -5, -5,-10,-10,-20],
      [-10,  0,  0,  0,  0,  0,  0,-10],
      [-10,  0,  5,  5,  5,  5,  0,-10],
      [ -5,  0,  5,  5,  5,  5,  0, -5],
      [  0,  0,  5,  5,  5,  5,  0, -5],
      [-10,  5,  5,  5,  5,  5,  0,-10],
      [-10,  0,  5,  0,  0,  0,  0,-10],
      [-20,-10,-10, -5, -5,-10,-10,-20]
    ],
    K: [
      [-30,-40,-40,-50,-50,-40,-40,-30],
      [-30,-40,-40,-50,-50,-40,-40,-30],
      [-30,-40,-40,-50,-50,-40,-40,-30],
      [-30,-40,-40,-50,-50,-40,-40,-30],
      [-20,-30,-30,-40,-40,-30,-30,-20],
      [-10,-20,-20,-20,-20,-20,-20,-10],
      [ 20, 20,  0,  0,  0,  0, 20, 20],
      [ 20, 30, 10,  0,  0, 10, 30, 20]
    ]
  };

  function evaluate(state) {
    let score = 0;
    const b = state.board;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = b[r][c];
        if (!p) continue;
        const k = kindOf(p);
        const val = PIECE_VALUES[k];
        const isW = colorOf(p) === 'w';
        const pstRow = isW ? r : 7 - r;
        const pstVal = PST[k][pstRow][c];
        if (isW) score += val + pstVal;
        else score -= val + pstVal;
      }
    }
    return score;
  }
  function orderMoves(state, moves) {
    const b = state.board;
    const scored = moves.map(m => {
      let s = 0;
      if (m.capture) {
        const victim = b[m.to.r][m.to.c];
        const victimVal = victim ? PIECE_VALUES[kindOf(victim)] : 100;
        const attackerVal = PIECE_VALUES[m.piece] || 100;
        s += 10000 + victimVal - attackerVal;
      }
      if (m.promo) s += 800;
      if (m.castle) s += 50;
      return { m, s };
    });
    scored.sort((a, b) => b.s - a.s);
    return scored.map(x => x.m);
  }
  function quiesce(state, alpha, beta) {
    const side = state.turn === 'w' ? 1 : -1;
    const standPat = side * evaluate(state);
    if (standPat >= beta) return beta;
    if (standPat > alpha) alpha = standPat;
    const caps = legalMoves(state, state.turn).filter(m => m.capture || m.promo);
    const ordered = orderMoves(state, caps);
    for (const m of ordered) {
      const { state: ns } = applyMove(state, m);
      const score = -quiesce(ns, -beta, -alpha);
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }
  function negamax(state, depth, alpha, beta, useQuiesce) {
    const moves = legalMoves(state, state.turn);
    if (moves.length === 0) {
      if (inCheck(state, state.turn)) return -100000 - depth;
      return 0;
    }
    if (depth === 0) {
      return useQuiesce ? quiesce(state, alpha, beta) : (state.turn === 'w' ? 1 : -1) * evaluate(state);
    }
    const ordered = orderMoves(state, moves);
    let best = -Infinity;
    for (const m of ordered) {
      const { state: ns } = applyMove(state, m);
      const score = -negamax(ns, depth - 1, -beta, -alpha, useQuiesce);
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return best;
  }
  function searchAndRank(state, depth, useQuiesce, jitter) {
    const moves = legalMoves(state, state.turn);
    if (moves.length === 0) return [];
    const ordered = orderMoves(state, moves);
    const scored = [];
    for (const m of ordered) {
      const { state: ns } = applyMove(state, m);
      let score = -negamax(ns, depth - 1, -Infinity, Infinity, useQuiesce);
      if (jitter) score += (Math.random() - 0.5) * jitter;
      scored.push({ m, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map(x => x.m);
  }

  class AIPlayer {
    constructor(color, strength) {
      this.color = color;
      this.strength = strength || 'normal';
      this.view = new PlayerView(color);
      this.guess = cloneBoard(initialPosition());
      this.guessCastling = { K: true, Q: true, k: true, q: true };
      this.guessEp = null;
      this.rejected = [];
    }
    buildGuessState() {
      const board = emptyBoard();
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const ownP = this.view.ownBoard[r][c];
          const guessP = this.guess[r][c];
          if (ownP) board[r][c] = ownP;
          else if (guessP && colorOf(guessP) !== this.color) board[r][c] = guessP;
          else board[r][c] = null;
        }
      }
      return {
        board,
        turn: this.color,
        castling: { ...this.guessCastling },
        ep: this.guessEp ? { ...this.guessEp } : null,
        halfmove: 0, fullmove: 1
      };
    }
    pickMove() {
      if (!this.rankedMoves) {
        const searchState = this.buildGuessState();
        let depth, useQ, jitter;
        if (this.strength === 'easy')       { depth = 1; useQ = false; jitter = 150; }
        else if (this.strength === 'normal'){ depth = 2; useQ = false; jitter = 20;  }
        else                                 { depth = 3; useQ = true;  jitter = 4;   }
        this.rankedMoves = searchAndRank(searchState, depth, useQ, jitter);
      }
      for (const m of this.rankedMoves) {
        if (!this.rejected.some(rm =>
          rm.from.r===m.from.r && rm.from.c===m.from.c && rm.to.r===m.to.r && rm.to.c===m.to.c
        )) return m;
      }
      return null;
    }
    newTurn() {
      this.rejected = [];
      this.rankedMoves = null;
      this.guessEp = null;
    }
    registerReject(move) {
      this.rejected.push({ from: {...move.from}, to: {...move.to} });
      const enemyChar = this.color === 'w' ? 'p' : 'P';
      if (move.piece === 'P' && !move.capture) {
        this.guess[move.to.r][move.to.c] = enemyChar;
      } else if (move.piece === 'P' && move.capture) {
        const cur = this.guess[move.to.r][move.to.c];
        if (cur && colorOf(cur) !== this.color) this.guess[move.to.r][move.to.c] = null;
      } else if (['R','B','Q'].includes(move.piece) && !move.capture) {
        const dr = Math.sign(move.to.r - move.from.r);
        const dc = Math.sign(move.to.c - move.from.c);
        if (dr !== 0 || dc !== 0) {
          let r = move.from.r + dr, c = move.from.c + dc;
          while (r !== move.to.r || c !== move.to.c) {
            if (!this.view.ownBoard[r][c]) {
              this.guess[r][c] = enemyChar;
              break;
            }
            r += dr; c += dc;
          }
        }
      }
      this.rankedMoves = null;
    }
    processCaptureAnnouncement(a) {
      const {r, c} = sqParse(a.square);
      if (a.captorColor === this.color) {
        this.guess[r][c] = null;
      } else {
        this.view.opponentCapturedAt(r, c);
        const enemyPlaceholder = this.color === 'w' ? 'p' : 'P';
        this.guess[r][c] = enemyPlaceholder;
      }
    }
    processOpponentMove() {
      this.view.opponentSilentMove();
    }
  }

  return {
    // constants
    FILES, GLYPHS, MAX_PAWN_ATTEMPTS,
    // board primitives
    emptyBoard, initialPosition, cloneBoard, colorOf, isSameColor, kindOf,
    onBoard, sqName, sqParse,
    // state
    initialState, cloneState,
    // moves
    pseudoLegalMoves, legalMoves, applyMove, movesEqual,
    isSquareAttacked, findKing, inCheck, isCheckmate, isStalemate,
    checkDirections,
    // referee + view + AI
    Referee, PlayerView, AIPlayer
  };
}));
