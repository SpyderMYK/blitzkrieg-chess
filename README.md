# Blitzkrieg Chess

**Chess in the fog** — you see only your own pieces. A referee adjudicates every move.

Live at: [https://blitz-chess.up.railway.app](https://blitz-chess.up.railway.app)

---

## What Is It?

Blitzkrieg Chess is an implementation of [Kriegspiel](https://en.wikipedia.org/wiki/Kriegspiel_(chess)), a chess variant where each player sees only their own pieces. You have no direct knowledge of where your opponent's pieces are. A referee (the computer) validates every move attempt and announces limited information about what is happening on the board.

---

## How to Play

### Starting a Game

- **Play vs Computer** — instant game against the AI (Easy / Normal / Hard)
- **Create Online Game** — generates a 5-letter code to share with a friend; supports Fischer time controls
- **Join by Code** — enter a code your opponent shared to join their game
- **Spectate** — watch a live online game with both sides of the board fully visible

### The Fog of War

You can only see your own pieces. Your opponent's pieces are invisible to you. The board begins showing only your side, and you must reason about where enemy pieces might be based on referee announcements.

### Making a Move

Click a piece to select it (valid target squares are highlighted based on your visible board), then click the destination. You can also type moves in algebraic notation (e.g. `e2-e4`, `Nf3`, `O-O`) and press Submit.

If a move is **illegal** (blocked by an unseen piece, or simply an invalid move), the referee says **"No."** and your turn continues — try a different move.

### Referee Announcements

After each move attempt the referee announces one or more of the following:

| Announcement | Meaning |
|---|---|
| **No** | Your move was illegal. Try again. |
| **White / Black has X pawn tries** | At the start of each turn, the referee tells you how many legal pawn captures exist (without revealing which ones). |
| **Piece captured at [square]** | An opponent's piece was captured. The square is revealed briefly. |
| **Check by knight / horizontal / vertical / diagonal** | Your king is in check, and the direction of the attack is announced. |
| **Checkmate** | Game over — one side has been mated. |
| **Stalemate / Draw** | The game ends in a draw. |

### Pawn Capture Attempts

Each turn you may attempt up to **3 pawn captures**. If a pawn capture is illegal (no enemy piece is there), the referee says "No" but your turn continues and your attempt count goes up. After 3 failed pawn-capture attempts in a row, you must make a different kind of move.

### Castling

Castling is legal under standard chess rules. Type `O-O` (kingside) or `O-O-O` (queenside), or click the king and target the castling destination square.

---

## Display Toggles

All toggles are in the control bar at the top of the game screen.

### Ghost Pieces

Toggles the **ghost piece tracker** on and off.

When enabled, a set of semi-transparent blue pieces representing your opponent's starting position appear on the board. You can drag these around freely to track your mental model of where you think enemy pieces are. The **Track Pieces** button activates edit mode so you can move them; right-clicking a ghost piece sends it to an off-board tray.

Turning this toggle off hides the ghost pieces without erasing your notes — turn it back on to see them again.

### Markers

Toggles the **marker system** on and off.

When enabled, a tray of 9 colored dots (3 red, 3 blue, 3 yellow) appears below the board. Click a dot in the tray to select it, then click any square on the board to place it there. Markers float on top of pieces and can be placed anywhere. Click a placed marker to return it to the tray.

Use markers to annotate the board however you like — mark squares you suspect contain enemy pieces, track pawn chains, flag danger zones, etc.

### Sound

Toggles move, capture, check, and game-end sound effects on and off.

### Voice

Toggles spoken referee announcements on and off. The slider controls the announcement volume independently of system volume.

---

## Post-Game Replay

After a game vs the Computer ends, two **Review** buttons appear in the game-over popup:

- **← Review from Start** — enters replay at the opening position and steps forward
- **Review from End →** — enters replay at the final position (default) and steps backward

In replay mode the full board is revealed (both sides visible). Use **← Prev** and **Next →** to step through every move. The from/to squares of the current move are highlighted in yellow, and the counter shows which move you're viewing out of the total. Click **✕ Exit Review** to return to the post-game board.

---

## Technical Notes

- Built with vanilla HTML/JS — no frontend framework
- `engine.js` is a shared UMD module used by both the browser and the Node.js server
- Online play uses WebSockets via a Node server deployed on [Railway](https://railway.app)
- No database — game state lives in memory on the server; games are not persisted across server restarts
- The current version is displayed in the bottom-right corner of the page (e.g. **v2.17**)
