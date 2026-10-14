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

## The admin interface

The script talks to the server through `/admin/` on the server's own port: to announce a restart, to ask whether games are still being played, and to call a restart off. Every request needs the token in `~/.game-room/admin-token`, which the script makes the first time it starts the server and which only your user can read. Without the right token, `/admin/` answers "Not found" like any unknown address, so it is safe for the port to be public. The token reaches the server in its environment, not on its command line, so other users cannot see it with `ps`.

A server started before this interface existed cannot be told about an update, so the first update after switching to this setup restarts it at once.
