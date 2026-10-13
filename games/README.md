# Adding a game

Every folder in `games/` that contains `server/index.js` is a game. The server finds it at start-up and the site shows it in the grid; no platform file needs editing. `games/chess/` is the worked example, and `test/fixtures/games/pick/` is the smallest server side that works.

The platform (in `server/` and `public/`) handles user names, the player list, invitations, reconnecting, the list of matches to watch, the archive of finished matches and the page around the game. A game supplies its rules and its screen.

## Folder layout

```
games/<id>/
  meta.js            what the grid shows
  server/index.js    options check and match factory (never sent to browsers)
  client/index.js    invitation options and the game screen
  shared/            optional: code used by both server and browser
  test/*.test.js     optional: run by `npm test`
```

Browsers can fetch `meta.js`, `client/` and `shared/` under `/games/<id>/`. Anything else in the folder is private. Inside the game, import with relative paths (`../shared/rules.js`) so the same file works in Node and in the browser.

## `meta.js`

```js
export default {
  id: 'chess',          // must equal the folder name
  name: 'Chess',
  description: 'One or two sentences for the grid.',
  players: 2,
  icon: '♞',            // optional; one character shown on the card
};
```

The lobby currently seats exactly two players per match. A game for more needs the invitation flow in `server/lobby.js` extended first.

## `server/index.js`

Default-export an object with:

| Member | What it does |
| --- | --- |
| `meta` | The object from `meta.js`. |
| `validateOptions(options, limits)` | Checks what a player asked for in an invitation. Return `{ options }` with a clean copy holding only the fields you use, or `{ error: 'message for the player' }`. `options` comes straight from a browser, so trust nothing in it. `limits` is only set by tests. |
| `preview(snapshot)` | Optional. Given a spectator's snapshot, returns a small piece of JSON from which the browser can draw a thumbnail of the match (see `preview` in `client/index.js`). It is sent with every match in the lists of games in progress and past games, and again to everyone looking at the list each time it changes (unless more than 12 matches of the game are going), so keep it short. |
| `validateBot(bot, options)` | Optional; with it the game can be played against a bot. Checks what a player asked for as an opponent (`bot` comes straight from a browser; `options` are already clean). Return `{ bot, name }`, a clean copy and the name the bot plays under, or `{ error }`. See "Bots" below. |
| `createMatch({ players, options, bots, onChange })` | Starts a match and returns it. `players` is one name per seat, in a random order chosen by the lobby. `bots` has one entry per seat: what `validateBot` returned for a seat played by a bot, `null` for a person. Call `onChange(match)` whenever the players should see something new, including when the match ends. |

The match object needs:

| Member | What it does |
| --- | --- |
| `over` | Falsy while playing; anything truthy once finished. The lobby frees the players when it sees this after an `onChange`. |
| `handle(seat, action)` | A message from the player in `seat`. `action.action` names it and the rest is yours to define. Return an error string to show that player, or `null`. |
| `setConnected(seat, connected)` | The player dropped or came back. |
| `abandon(seat)` | The player stayed away past the grace period; end the match. |
| `setSpectators(count)` | Optional. Called when the number of people watching changes; put it in the snapshot and call `onChange` if the screen shows it. |
| `snapshot(seat)` | Everything that player's screen needs, as plain JSON. `seat` is `null` for a spectator, who must get nothing that is hidden from any player. When a match ends the platform saves `snapshot(null)` and later shows it to anyone who wants to look at the match again, so it has to be enough to draw the whole game, not just its last moment. Must include `id` (unique per match), `players`, `you` (the seat), `options` and `over`, and in a game that has bots also `bots` as given to `createMatch`; the platform uses these for the start sound and the rematch button. Leave out anything that seat must not see. |

Timers a match starts should be `unref()`ed so they never keep the process alive.

## `client/index.js`

Default-export an object with:

| Member | What it does |
| --- | --- |
| `inviteForm(container, submit)` | Draw the options for a new match into `container` (inside the platform's dialog) and call `submit(options)` when the player confirms. With no options, draw one button. |
| `botForm(container, submit)` | Optional, for a game with `validateBot`. Like `inviteForm`, for a match against a bot: call `submit({ options, bot, seat })`, where `seat` is the seat the player wants, or `null` for either. The platform then shows a "Play the computer" button on the game's page. |
| `describeOptions(options)` | A few words for invitation cards, e.g. `3+1`. |
| `describeResult({ players, options, over })` | Optional. A few words on how a finished match ended, for the list of past matches, e.g. `1-0 • Black resigned`. `over` is the match's `over` value. |
| `preview(container, preview)` | Optional. Draw the thumbnail that the server's `preview` describes into `container`, as seen from the first seat's side. Called again with a newer preview while a match is being played. |
| `mount(container, ctx)` | Build the game screen in `container` and return `{ update(snapshot), destroy() }`. `update` is called with every new snapshot, and again with the same one if the server refused an action, so anything shown early can be undone. `snapshot.you` is `null` when the screen is shown to a spectator: draw the match but offer no actions. `destroy` must stop timers and listeners. The returned object may also have `chat(messages)`: it is called with the whole conversation, an array of `{ from, text }`, when the screen opens and after every new message. |

`ctx` provides:

- `ctx.send({ action: 'move', ... })`: sends an action to your match's `handle`. With `bot: true` it is handled as coming from the bot's seat (see "Bots").
- `ctx.play(name, delay?)`: plays a sound from `public/js/sounds.js` (`move`, `capture`, `check`, `explosion`, `end`, `notify`, `lowTime`). The platform already plays `start` for a new match and `notify` for invitations.
- `ctx.sendChat(text)`: says something to the other players of the match (up to 140 characters). The platform keeps the conversation, also after the match is over, and gives it back through the view's `chat`. It plays no sound for a message; that is up to the game.
- `ctx.toast(text)`: shows a short notice.

Load your own stylesheet from the module, as chess does, and prefix its class names with the game's name. The colour variables defined at the top of `public/style.css` (`--surface`, `--accent`, and so on) are available. Once a match is over the platform shows Rematch and Close above your screen, so the game does not need its own.

## Bots

The server never thinks for a bot. A match against one is an ordinary match, run, watched and saved like any other, in which one seat has nobody behind it: the browser of the player facing the bot works out its moves and sends them with `bot: true`, and the match checks them as it checks anyone's. So the game's screen has to do the playing: when a snapshot has `you` set and a bot in the other seat's entry of `bots`, and it is that seat's turn, act for it. A spectator's screen (`you` is `null`) must not.

Two things follow. The bot only plays while its opponent's page is open, and that player could send any legal action for it; with nothing at stake, that is acceptable.

Chess does this in `client/bot/`: Stockfish (WebAssembly, in `client/stockfish/`) plays standard chess and Chess960, and the search in `shared/search.js` plays the other variants, each in a worker.
