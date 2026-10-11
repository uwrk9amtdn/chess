# Adding a game

Every folder in `games/` that contains `server/index.js` is a game. The server finds it at start-up and the site shows it in the grid; no platform file needs editing. `games/chess/` is the worked example, and `test/fixtures/games/pick/` is the smallest server side that works.

The platform (in `server/` and `public/`) handles user names, the player list, invitations, reconnecting and the page around the game. A game supplies its rules and its screen.

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
| `createMatch({ players, options, onChange })` | Starts a match and returns it. `players` is one name per seat, in a random order chosen by the lobby. Call `onChange(match)` whenever the players should see something new, including when the match ends. |

The match object needs:

| Member | What it does |
| --- | --- |
| `over` | Falsy while playing; anything truthy once finished. The lobby frees the players when it sees this after an `onChange`. |
| `handle(seat, action)` | A message from the player in `seat`. `action.action` names it and the rest is yours to define. Return an error string to show that player, or `null`. |
| `setConnected(seat, connected)` | The player dropped or came back. |
| `abandon(seat)` | The player stayed away past the grace period; end the match. |
| `snapshot(seat)` | Everything that player's screen needs, as plain JSON. Must include `id` (unique per match), `players`, `you` (the seat), `options` and `over`; the platform uses these for the start sound and the rematch button. Leave out anything that seat must not see. |

Timers a match starts should be `unref()`ed so they never keep the process alive.

## `client/index.js`

Default-export an object with:

| Member | What it does |
| --- | --- |
| `inviteForm(container, submit)` | Draw the options for a new match into `container` (inside the platform's dialog) and call `submit(options)` when the player confirms. With no options, draw one button. |
| `describeOptions(options)` | A few words for invitation cards, e.g. `3+1`. |
| `mount(container, ctx)` | Build the game screen in `container` and return `{ update(snapshot), destroy() }`. `update` is called with every new snapshot, and again with the same one if the server refused an action, so anything shown early can be undone. `destroy` must stop timers and listeners. |

`ctx` provides:

- `ctx.send({ action: 'move', ... })`: sends an action to your match's `handle`.
- `ctx.play(name, delay?)`: plays a sound from `public/js/sounds.js` (`move`, `capture`, `check`, `end`, `notify`, `lowTime`). The platform already plays `start` for a new match and `notify` for invitations.
- `ctx.toast(text)`: shows a short notice.

Load your own stylesheet from the module, as chess does, and prefix its class names with the game's name. The colour variables defined at the top of `public/style.css` (`--surface`, `--accent`, and so on) are available. Once a match is over the platform shows Rematch and Close above your screen, so the game does not need its own.
