# Auto mode: `use --auto`

```sh
claude-profiles use --auto [--force] [--no-fork] [claude arguments...]
claude-profiles use --auto --model opus
```

`use --auto` checks every registered profile's usage and launches the one with
the most real capacity left. It picks once, at launch; it never switches
profile mid-session. Every token after `--auto`, `--force` and `--no-fork` is
passed to Claude verbatim. One line on stderr names the choice before Claude starts:

```text
auto: tech (team-premium, 89% left, 5h resets 14:10)
```

**How the pick works.** For each profile:

```text
capacity = tier weight x min(5-hour remaining, weekly remaining)
```

The stricter of the 5-hour and weekly windows wins. Weights are in Pro-equivalent
units, so a small percentage used on a premium plan can still leave more real
capacity than a large percentage used on a standard plan: Team premium at 40%
used scores 6.25 x 0.60 = 3.75, while Team standard at 5% used scores
1.25 x 0.95 = 1.19. Exhausted profiles are never chosen. Capacities within 5%
of the best are a tie, which goes to the profile whose limiting window resets
sooner, then to registry order.

**Tiers.** Each profile has an optional tier:

| Tier | Weight |
| --- | --- |
| `pro` | 1 |
| `team-standard` | 1.25 |
| `max5x` | 5 |
| `team-premium` | 6.25 |
| `max20x` | 20 |
| `custom:<n>` | `<n>` |

Set it with `claude-profiles add <profile> --tier <tier>` or
`claude-profiles tier <profile> <tier>`. A tier set this way is authoritative.
When it is unset, the tier is detected from the profile's account metadata:
Max plans are read directly, but a Team seat's standard or premium status is
only inferred (Anthropic does not document the mapping), so set it explicitly
for Team seats. If the tier is still unknown, the profile gets weight 1 and a
warning that names the `tier` command. The weights are the plans' documented
5-hour multipliers; weekly limits are assumed to scale the same way, and
`custom:<n>` lets you correct that.

**Where usage comes from.** A result no older than 60 seconds in the profile's
own `.claude.json` (`cachedUsageUtilization`, for the same account) is used
first. Otherwise, `claude-profiles` starts that profile's own `claude`
(`--safe-mode`, stream-json, competing auth variables stripped,
`CLAUDE_CONFIG_DIR` set, a fixed working directory) and sends the `get_usage`
control request, with a 10 second timeout. Claude reads its own credentials;
`claude-profiles` never reads, prints, or logs a token or Keychain item. Profiles
are checked in parallel. A profile whose usage cannot be read is reported on
stderr and excluded; if none can be read, `use --auto` fails and launches
nothing.

> **Experimental API.** `get_usage` is marked experimental by Claude Code and
> its response shape may change between versions. Parsing is defensive: anything
> unrecognised means "usage unknown" for that profile, never a wrong pick.

**When everything is exhausted.** `use --auto` never launches silently. It names
the profile that frees up first, then asks `Launch <profile> anyway? [y/N]` on
a terminal. Without a terminal it exits with status `3` and launches nothing.
`--force` launches that profile without asking.

**Resuming sessions.** By default each profile keeps its own session history,
so a session started on one profile is invisible to the others. With
`--resume <id>` (or `-r <id>`) or `--continue` (or `-c`), auto mode then
restricts the pick to the profile that owns the session (for `--continue`, the
profile with the newest transcript for the current directory). If that profile
is exhausted or its usage is unknown, `use --auto` refuses and names when it
frees up; `--force` launches it anyway. If no profile owns the session id, the
normal pick applies, with a warning. A bare `--resume` (the picker) prints a
warning that it lists only the chosen profile's sessions.

Profiles that share session history (see [shared-sessions.md](shared-sessions.md))
can all see the session, so none is pinned: `--resume <id>` and `--continue`
pick the profile with the most capacity among the profiles that can see it. If
every registered profile can, the normal pick and the normal "all exhausted"
handling apply; if only some can (for example, one profile still keeps private
sessions), the pick is limited to those. The bare `--resume` warning is left
out for a profile that shares, because its picker lists the shared sessions.
This is how you continue a conversation on another profile after one hits its
usage limit: run `claude-profiles use --auto --continue` in the same folder.
Detecting the limit and relaunching automatically is not part of this.

**`--fork`.** When auto mode moves a session to a profile on a different
organization than the one the session last ran on, it adds `--fork-session`
to the Claude arguments, and the one-line stderr notice says so. Claude then
writes the continuation to a new session and leaves the original transcript
untouched, so the original keeps its owner and two profiles never extend the
same session. Organizations are compared by id and never printed; if either
side is unknown, nothing is added. Pass `--no-fork` to continue the original
session in place, or give `--fork-session` yourself (it is never added twice).
