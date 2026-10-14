# Running the server on FreeBSD

This keeps Game Room running on a FreeBSD server without root and without tmux. It starts at boot, comes back if it stops, and updates itself after a push to `master` without cutting games short. All of it runs as your own user, from your own crontab, through one script, [deploy/game-room](deploy/game-room).

## How an update goes

Every five minutes the script looks for new commits on GitHub. When there are some:

1. It tests them in a separate copy of the code, so the running server is not touched. If the tests fail, nothing happens; that commit is left alone until a newer one arrives.
2. It tells the server, which shows everyone a banner at the top of the page counting down five minutes. New games cannot start from then on, and open invitations are closed.
3. When the five minutes are up, it waits for the games still being played to end (the banner says how many). Games have clocks, so they all end.
4. Then it updates the code, installs dependencies if they changed and restarts the server. Pages reconnect by themselves, and new games can start again.

## Commands

Run them on the server, from the checkout:

| Command | What it does |
| --- | --- |
| `deploy/game-room status` | Whether the server is running, and any update waiting. |
| `deploy/game-room check` | Looks for new commits now instead of waiting for cron, and goes through the steps above. |
| `deploy/game-room update-now` | The same, but skips the five minutes: updates as soon as no game is in progress. Run while an update is already waiting or being tested, it makes that one skip the countdown. |
| `deploy/game-room update-now --force` | Tests, updates and restarts at once, ending any games in progress. |
| `deploy/game-room start`, `stop`, `restart` | Control the server directly. `stop` and `restart` end games in progress. |
| `deploy/game-room set-password` | Sets the admin panel's password (see below). |

`update-now` also applies a commit that `check` leaves alone: one whose tests failed (it tests it again) or whose update was called off.

Only one `check` or `update-now` runs at a time. While one is waiting, a second one says so and leaves it be.

The script keeps the server's pid file, logs and the admin token (below) in `~/.game-room/`.

## 1. Check the server has what it needs

```sh
node --version && npm --version && git --version
crontab -l
```

`crontab -l` saying "no crontab for ..." is fine; an error saying you are not allowed to use cron is not, and needs the administrator.

If `node` is anywhere but `/usr/local/bin/node`, tell the script where (step 2).

Cron has no SSH agent and nobody to type a passphrase, so `git fetch` must work on its own. Try it in the checkout:

```sh
cd ~/game-room && git fetch origin master
```

If it asks for a password or passphrase, either fetch over HTTPS (if the repository is public: `git remote set-url origin https://github.com/uwrk9amtdn/game-room.git`), or make an SSH key without a passphrase for this server and add its public half to the repository on GitHub as a read-only **deploy key** (Settings, then Deploy keys).

## 2. Settings, if the defaults do not suit

Create `~/.game-room/config` only if something differs from these defaults:

```sh
port=9494                 # the port to listen on
data_dir=$HOME/game-room/data   # where finished games are kept (default: the checkout's data/)
node=/usr/local/bin/node  # the node to run, e.g. one installed with nvm
branch=master             # the branch to follow
warning=300               # seconds of warning before an update
```

## 3. Move the server out of tmux

Stop the server in its tmux window (Ctrl-C), then:

```sh
cd ~/game-room
deploy/game-room start
deploy/game-room status
```

## 4. Start at boot and check every five minutes

Run `crontab -e` and add these two lines, with the path to your checkout:

```
@reboot     $HOME/game-room/deploy/game-room start
*/5 * * * * $HOME/game-room/deploy/game-room check
```

Every check also starts the server if it is not running, so it comes back within five minutes even where `@reboot` is not honoured.

## Day to day

- What the updates did: `cat ~/.game-room/update.log`
- The server's own output: `tail -f ~/.game-room/server.log`
- A commit whose tests failed is recorded in `~/.game-room/update-failed`. Pushing a newer commit is enough; deleting the file makes the next check try the same commit again.
- The script does nothing while the checkout has edits of its own to tracked files, and says so in `update.log`.

## The admin panel

`https://<your site>/admin` shows who is online and what is being played, the updates (with buttons to check now, update now or call off a waiting update), statistics per day and per game, the server's health, and the finished games, any of which can be deleted. Set its password once, on the server:

```sh
deploy/game-room set-password
```

It asks twice without showing what you type, and keeps only a scrypt hash of it, in `~/.game-room/admin-password`, readable only by your user. Run it again to change the password; everyone logged in is logged out. The server reads the file when someone logs in, so no restart is needed.

How it is kept safe:

- **HTTPS only.** Logging in works only through your HTTPS proxy, or directly on the server itself (`ssh -L 9494:localhost:9494 server`, then `http://localhost:9494/admin`). Over plain HTTP from anywhere else the panel refuses.
- **Guessing is slowed down.** Each address may get the password wrong three times; after that it must wait 1 second, then 2, 4, 8 and so on, up to an hour. More than 30 wrong passwords in ten minutes, from any number of addresses, makes everyone wait until the ten minutes are up (you can still use the commands above over SSH). Every login and wrong password is written to `~/.game-room/server.log` with the address.
- **Sessions** last 12 hours at most, or 2 hours unused, in a cookie that scripts on the page cannot read, that only travels over HTTPS and never with requests from other sites. Everything the panel shows or changes is checked against the session on the server.

The panel needs your proxy to say who the visitor is (in `X-Real-IP` or `X-Forwarded-For`) and that HTTPS was used (in `X-Forwarded-Proto`). The server believes those headers only from the addresses the proxy connects from, by default the server itself. Two settings in `~/.game-room/config` adapt it to your proxy:

```sh
proxy_addresses=127.0.0.1   # where the proxy connects from (several: separate with commas)
proxy_https=yes             # the proxy serves only HTTPS but does not send X-Forwarded-Proto
```

To find the right values, open `/admin` through your site and unfold **What the server sees of this connection** under the login form. "Connection from" is the proxy's address, for `proxy_addresses`. If X-Forwarded-Proto says "(none)" and your proxy forces HTTPS, set `proxy_https=yes`. After changing them, run `deploy/game-room restart`, and "Taken as visitor address" should then show your own public address and "Counts as HTTPS" yes.

On serv00, the proxy sends the visitor's address in `X-Real-IP`. Switch on "Force SSL" in the website's settings before using `proxy_https=yes`, so the proxy never passes on plain HTTP.

With nginx, for example:

```nginx
location / {
    proxy_pass http://127.0.0.1:9494;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;       # the games' WebSocket
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

### What is recorded

Per day, kept for good in `data/stats.jsonl` (one small line a day), and per hour for the last week:

- players: how many different names joined, the most online at once, connections, players who dropped out mid-game, chat messages (counted, never kept);
- per game: games started and finished, how many against the bot, their average length, how they ended, the options chosen, and per bot level how often the bot won;
- the server: starts, updates, errors, the most memory used and the longest the server was held up.

Players' names are only used to count today's players, and are forgotten when the day ends. No addresses are recorded, except in the login lines of the server's log.

## The interface for the script

The script talks to the server through `/admin/` on the server's own port: to announce a restart, to ask whether games are still being played, and to call a restart off. Every request needs the token in `~/.game-room/admin-token`, which the script makes the first time it starts the server and which only your user can read. Without the right token, `/admin/` answers "Not found" like any unknown address, so it is safe for the port to be public. The token reaches the server in its environment, not on its command line, so other users cannot see it with `ps`.

A server started before this interface existed cannot be told about an update, so the first update after switching to this setup restarts it at once.
