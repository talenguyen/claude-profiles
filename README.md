# claude-profiles

**Hit your Claude Code limit? Switch accounts in one command and keep your conversation.**

If you run Claude Code from the terminal with more than one subscription
(work, personal, a side project), you know the drill: the 5-hour window runs
out, you log out, log in somewhere else, and lose your place. `claude-profiles`
keeps every account logged in side by side, checks which one has the most real
capacity left, and launches Claude on it.

```text
$ claude-profiles usage
PROFILE   TIER                     5H   WEEK  RESETS  CAPACITY  STATUS
work      team-premium (registry)  92%  48%   14:10   0.50      ok
personal  pro (registry)           23%  18%   15:40   0.77      ok
side      max5x (registry)         71%  40%   13:20   1.45      best

$ claude-profiles use --auto --continue
auto: side (max5x, 29% left, 5h resets 13:20)
```

`work` is nearly out of its 5-hour window, so `--auto` picks `side`: a Max 5x
plan with 71% used still has more real capacity than a Pro plan with 23% used.
With [shared sessions](docs/shared-sessions.md) turned on, `--continue` picks up
the conversation you were in.

## Why

- **One command instead of logout and login.** Each profile keeps its own
  isolated Claude login, so accounts never overwrite each other.
- **Pick by real capacity, not by guess.** Plan tiers are weighted, so 40% used
  on a premium plan can beat 5% used on a standard one.
- **Keep your place.** Opt in to shared session history and continue a
  conversation on another account.
- **Still plain Claude Code.** Your settings, plugins, and skills are shared
  across profiles, and every argument after the profile name goes to `claude`
  untouched.
- **No dependencies.** Node built-ins only.

## Quick start

Requires Node 23.11 or newer and the `claude` CLI on your `PATH`.

1. Install:

   ```sh
   git clone https://github.com/talenguyen/claude-profiles.git
   cd claude-profiles && npm install -g .
   ```

2. Add each account. A browser opens for Claude's normal login:

   ```sh
   claude-profiles add work --tier team-premium
   claude-profiles add personal --tier pro
   ```

3. Launch on whichever account has the most room:

   ```sh
   claude-profiles use --auto
   ```

Prefer to choose yourself? `claude-profiles use work --resume` launches the
`work` account and passes `--resume` to Claude.

## Features

| Feature | What it does | Details |
| --- | --- | --- |
| Auto pick | `use --auto` launches the profile with the most capacity left: tier weight x the smaller of the 5-hour and weekly remaining share. It picks once at launch and never switches mid-session. | [auto-mode.md](docs/auto-mode.md) |
| Usage table | `usage` shows each profile's tier, 5-hour and weekly use, reset time, capacity, and status. `--json` for scripts. | [commands.md](docs/commands.md) |
| Plan tiers | `pro`, `team-standard`, `max5x`, `team-premium`, `max20x`, or `custom:<n>`. Set one explicitly; Max plans are also detected. | [auto-mode.md](docs/auto-mode.md) |
| Shared sessions | Opt in per profile so `use --auto --continue` resumes the same conversation on another account. Rollback included. | [shared-sessions.md](docs/shared-sessions.md) |
| Argument passthrough | Everything after the profile name goes to `claude` verbatim: `use work --model opus`. | [commands.md](docs/commands.md) |
| Safe by default | When every profile is exhausted it asks before launching (or exits with status `3` without a terminal). | [auto-mode.md](docs/auto-mode.md) |

## FAQ

**Is my token safe?**
`claude-profiles` never reads, prints, or logs a token or Keychain item. Claude
Code stores its own credentials inside each profile's isolated config
directory, and `usage` and `use --auto` ask each profile's own `claude` for its
numbers. The registry keeps only metadata, in a `0600` file. See
[docs/security.md](docs/security.md).

**Does anything leave my machine?**
`claude-profiles` makes no network calls of its own. It runs your `claude`
binary, which talks to Anthropic exactly as it normally does.

**What crosses accounts with shared sessions?**
Continuing a conversation on another profile re-sends the whole conversation
(prompts, replies, tool results, project memory) to Anthropic on *that
account*. Work content continued on a personal account lands there, under that
account's terms. Sharing is off by default, per profile, and you choose which
profiles opt in. Read the [data-crossing
note](docs/shared-sessions.md) before you do. Never run one session in two
terminals at once: the branches diverge and one side's turns are lost.

**Does it switch accounts when I hit the limit mid-session?**
No. It picks once, at launch. When a session ends on a limit, run
`claude-profiles use --auto --continue` in the same folder.

**What platforms work?**
macOS (tested). Linux and Windows are untested: the unit tests run on Linux in
CI, but real login and launch flows have only been checked on macOS.

**Where do the details live?**
[docs/commands.md](docs/commands.md) (every command),
[docs/auto-mode.md](docs/auto-mode.md),
[docs/shared-sessions.md](docs/shared-sessions.md),
[docs/security.md](docs/security.md), and
[docs/verification.md](docs/verification.md).

## License

[MIT](LICENSE). `claude-profiles` is an independent project, not affiliated
with, endorsed by, or sponsored by Anthropic. Claude and Claude Code are
trademarks of Anthropic.
