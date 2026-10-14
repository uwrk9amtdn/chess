# Game Room

A small site for playing board games in the browser with other people, or against the computer. It comes with chess and its variants, Go and Gomoku. One Node.js server runs everything: it keeps the list of players, the invitations and every match, and the browsers only draw what it sends them.

## What you can do

- **Play chess:** invite another player, or play a computer opponent that runs in your own browser (Stockfish for standard chess and Chess960, a simpler engine for the other variants, at 8 levels).
- **Variants:** Standard, Chess960, King of the Hill, Three-Check, Antichess, Atomic, Horde, Racing Kings, Crazyhouse and Double 16x16 (two armies each on a 16x16 board).
- **Time controls:** from 1+0 bullet to 30+20 classical, or a custom one.
- **Play Go:** on 9x9, 13x13 or 19x19, with 2 to 9 handicap stones if you like, against a person or a computer opponent that runs in your own browser (a Monte-Carlo tree search, at 8 levels). Area scoring with komi 7.5 (0.5 with handicap) and positional superko. After both players pass they mark the dead stones together, starting from the server's guess, and accept the count or resume play.
- **Go clocks:** Fischer (minutes plus an increment) or byo-yomi (main time, then periods).
- **Play Gomoku:** five in a row on 15x15 (or 19x19 for Freestyle), by Freestyle, Standard (exactly five) or Renju rules, where Black's forbidden moves are refused and marked on the board. The Swap2 opening can decide the colours. The computer opponent is an alpha-beta search at 8 levels, run in your browser.
- **During a game:** premoves, takebacks, draw offers, a chat with quick phrases, and stepping back through the moves (Go and Gomoku have takebacks, the chat and stepping back; Go also passing).
- **Watching:** follow games in progress, or replay finished ones, from either side of the board.
- **Looks:** four site themes (Light, Dark, Sepia, Midnight); for chess six board colours and eight piece sets, for Go and Gomoku six boards, three kinds of stones and coordinates on or off, chosen from the ☰ menu.
- **Phones:** the layout works on phones, and the site can be installed as an app. See [ANDROID.md](ANDROID.md) for building an Android APK.

## Running it

You need [Node.js](https://nodejs.org/) 22 or newer.

```sh
npm install
npm start
```

Then open <http://localhost:9494>. To play against someone else, they open the same address. On another device that means your computer's address on the network instead of `localhost`.

Two environment variables change the defaults:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `9494` | The port the server listens on. |
| `DATA_DIR` | `data/` | Where finished matches are kept, one `<game>.jsonl` file per game. |

Everything else lives only in memory: players, invitations and matches in progress are lost when the server restarts. A player who drops out mid-game has 30 seconds to come back before the game counts them as gone.

## Tests

```sh
npm test
```

This runs the platform's tests in `test/` and each game's tests in `games/<id>/test/`, using Node's built-in test runner.

## How it is put together

```
server/      the Node.js server: static files, the WebSocket lobby, the archive
public/      the site around the games: page, styles, menu, connection
  js/kit/    a screen, setup dialog and stone board that games can share
             (Go and Gomoku use it)
games/       one folder per game, found by the server at start-up
  chess/
    server/  rules checks and the match itself (never sent to browsers)
    shared/  the chess engine, used by both the server and the browser
    client/  the game screen, board, bot, themes, pieces and sounds
  go/        laid out the same way: the rules, clocks and bot in shared/
  gomoku/    the same again
test/        tests of the platform
```

The browser is only a view. It opens a WebSocket to the server, sends what the player wants to do, and draws the snapshots the server sends back. The server is the only judge of what is legal.

New games plug in without changing the platform. [games/README.md](games/README.md) explains the contract a game has to meet, with chess as the worked example.

## Licence

Game Room is free software under the [GNU Affero General Public License, version 3 or later](LICENSE). You may use, change and share it. If you run a changed version as a website for others, you have to offer them its source code too.

## Credits

The piece sets, sounds and variant icons come from [Lichess](https://lichess.org/), and the computer opponent is [Stockfish](https://stockfishchess.org/). Each comes with its own licence, kept next to the files:

- [pieces](games/chess/client/pieces/LICENSE.md)
- [icon font](games/chess/client/font/LICENSE.md)
- [sounds](public/sound/LICENSE.md)
- [Stockfish](games/chess/client/stockfish/LICENSE.md)
