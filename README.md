# claude-profiles

Run multiple Claude Code subscriptions on a single machine and pick one before
you hit a usage window. Each profile launches the real Claude TUI into the
chosen account while your settings, plugins, and skills stay shared across
profiles.

## Install

From this directory:

```sh
npm install -g .
```

Then `claude-profiles` is on your PATH. The package targets Node `>=23.11.0`
and uses only Node built-ins.

## Authenticate a profile

```sh
claude-profiles add <profile>
claude-profiles add mep
```

The command materialises an isolated Claude config, then runs
`claude auth login --claudeai` inside it with competing auth variables
stripped. Complete the browser flow with the account for that profile.
Claude Code stores its native credential and OAuth metadata inside that
profile's isolated auth scope; neither credential data nor tokens are printed
or stored in the registry.

The registry at `~/.config/claude-profiles/profiles.json` (mode `0600`) holds
only profile metadata: the name, its service label, and an optional plan tier.
`add --tier <tier>` sets the tier when you create the profile.

To replace an existing token without recreating the profile:

```sh
claude-profiles refresh <profile>
```

`refresh` repeats native Claude login for that profile while preserving its
isolated config directory.

## Commands

```sh
claude-profiles add <profile> [--tier <tier>]
claude-profiles list
claude-profiles status [profile]
claude-profiles use <profile> [claude arguments...]
claude-profiles use --auto [--force] [claude arguments...]
claude-profiles usage [--json]
claude-profiles tier <profile> <tier>
claude-profiles refresh <profile>
claude-profiles remove <profile>
claude-profiles help
```

### `list`

```sh
claude-profiles list
```

Print every registered profile and whether its native OAuth metadata is
`present` or `missing`. Credentials are never printed.

### `status`

```sh
claude-profiles status [profile]
claude-profiles status mep
```

argument, report every profile.
With a profile name, report native auth metadata presence for that profile.
With no argument, report every profile.

### `use`

```sh
claude-profiles use <profile> [claude arguments...]
claude-profiles use mep
claude-profiles use uplive --resume
claude-profiles use uplive -- --resume
```

`use` materialises a per-profile config directory under
`~/.config/claude-profiles/configs/<profile>/`, preserves that profile's
native OAuth metadata, sanitises the environment, and `execve`s the real
Claude binary directly with `CLAUDE_CONFIG_DIR` set. For a newly authenticated
profile, complete Claude's one-time onboarding screens on its first `use`;
later launches skip the login selector.

Every argument after the profile name is passed to Claude verbatim; for example,
`claude-profiles use uplive --resume` resumes the previous session on the
`uplive` account. A literal `--` directly after the profile name is optional
and is dropped, so `claude-profiles use uplive -- --resume` behaves the same.

If per-profile config materialisation fails, `use` aborts before launching
Claude. There is no fallback to a non-isolated run.

### Auto mode: `use --auto`

```sh
claude-profiles use --auto [--force] [claude arguments...]
claude-profiles use --auto --model opus
```

`use --auto` checks every registered profile's usage and launches the one with
the most real capacity left. It picks once, at launch; it never switches
profile mid-session. Every token after `--auto` and `--force` is passed to
Claude verbatim. One line on stderr names the choice before Claude starts:

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

**Resuming sessions.** Session transcripts live in each profile's own
`projects/` directory, so a session started on one profile is invisible to the
others. With `--resume <id>` (or `-r <id>`) or `--continue` (or `-c`), auto mode
restricts the pick to the profile that owns the session (for `--continue`, the
profile with the newest transcript for the current directory). If that profile
is exhausted or its usage is unknown, `use --auto` refuses and names when it
frees up; `--force` launches it anyway. If no profile owns the session id, the
normal pick applies, with a warning. A bare `--resume` (the picker) prints a
warning that it lists only the chosen profile's sessions.

### `usage`

```sh
claude-profiles usage [--json]
```

Read-only table of each profile's tier (and where it came from: `registry`,
`detected`, or `default`), 5-hour and weekly percent used, reset time,
capacity, and status (`best`, `ok`, `exhausted`, or `unknown: <reason>`).
`--json` prints the same data for scripts. Asking Claude for usage refreshes
that profile's `cachedUsageUtilization`; nothing else is written.

### `tier`

```sh
claude-profiles tier <profile> <tier>
claude-profiles tier uplive team-premium
```

Set a registered profile's tier (see the table under auto mode).

### `refresh`

```sh
claude-profiles refresh <profile>
claude-profiles refresh mep
```

Re-run native Claude login for an existing profile. The profile stays
registered and retains its isolated profile config.

### `help`

```sh
claude-profiles help
claude-profiles --help
```

Print command usage and the one-time native onboarding note.

### `remove`

```sh
claude-profiles remove <profile>
```

Delete one profile. The CLI prompts for exact-name confirmation and only
proceeds on a byte-for-byte match:

```text
Type the profile name to remove it:
```

Anything other than the exact profile name — including the wrong profile, an
empty line, or a typo — aborts the command without logging out, deleting the
profile config, or changing the registry.

## Security

- Claude Code's native credentials and OAuth metadata are created under each
  profile's isolated `CLAUDE_CONFIG_DIR`. The registry stores only metadata.
- The registry file is mode `0600`. Per-profile config directories are mode
  `0700`. The hidden `.claude.json` inside each profile directory is mode
  `0600`.
- `add` and `refresh` run `claude auth login --claudeai` with
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
  `CLAUDE_CODE_OAUTH_TOKEN`, and Bedrock / Vertex / Foundry flags stripped.
- `use` performs an `execve` into the real Claude binary with only
  `CLAUDE_CONFIG_DIR` injected. If config materialisation fails, `use` aborts
  before launching Claude — no fallback to a non-isolated run.
- `remove` requires the exact profile name as confirmation. The wrong name
  aborts without deleting anything.
- `use --auto` and `usage` run each profile's own `claude` to read usage and
  never read, print, or log a token or Keychain item. A new profile does not
  inherit the base account's usage cache.
- No token ever appears in stdout, stderr, log output, or shell history.

### What does and does not prove isolation

Running `claude auth status` on the host — outside the TUI — does **not**
prove that a profile is wired correctly. The standalone command reads the
base `~/.claude/.claude.json` and bypasses the per-profile config directory,
so it can report an account that is not the one `use` would launch. A
green `claude auth status` therefore cannot tell you isolation is working.

The only valid evidence is the real Claude TUI itself: opening directly —
without a login selector — for the chosen profile, and then running the
in-TUI `/auth status` slash command. If the TUI skips the login screen and
`/auth status` reports the identity you expect, the profile is wired. Anything
less — including `claude auth status`, scripted probes, or checking the
Keychain in isolation — can pass while profile isolation is broken.

## Verify manually

```sh
claude-profiles use mep
# In the real Claude TUI, run: /auth status
```

The TUI must open without a login selector, and `/auth status` must report the
`mep` identity. Repeat with `uplive` (or any second profile) to confirm a
distinct identity and the same shared settings, plugins, and skills.

## Acceptance checklist

Run this end-to-end on a real macOS machine with two Claude accounts after
linking the package from this directory:

```sh
npm link
claude-profiles add mep
claude-profiles add uplive
claude-profiles status mep
claude-profiles use mep
claude-profiles use uplive -- --resume
claude-profiles refresh mep
claude-profiles remove mep
```

Each item maps to the acceptance checklist in `spec.md`:

- [ ] `add mep` and `add uplive` complete via browser auth without leaking a
  credentials into shell history, log output, or the registry.
- [ ] `status mep` and `status uplive` report `present` without printing
      credentials.
- [ ] `use mep` opens the real Claude TUI directly; no login selector appears.
- [ ] Inside the TUI for `mep`, `/auth status` confirms the `mep` identity.
- [ ] Exit that TUI; `use uplive` confirms a different identity and also opens
      without a login selector.
- [ ] Two terminals running `use mep` and `use uplive` simultaneously keep
      distinct identities — no cross-account leakage between sessions.
- [ ] Settings, plugins, and skills remain shared across profiles (each
      profile reads from the same base config via symlinks for
      `settings.json`, `settings.local.json`, `skills`, `plugins`, `commands`,
      `hooks`, and `history`). Runtime files — daemon, lock, socket — are not
      shared.
- [ ] `refresh mep` re-authenticates successfully; a follow-up `use mep`
      still opens the TUI directly without a login selector.
- [ ] `remove mep` logs out and deletes the `mep` profile config and registry entry after
      exact-name confirmation. Typing the wrong name aborts the command and
      leaves `uplive` and its native profile state untouched.

The package ships no secrets: `npm pack --dry-run` lists every source file
under `bin/` and `src/`, the test files, `package.json`, `README.md`,
`spec.md`, and the project-internal `.pi/agents/*` and `docs/superpowers/*`
docs; no Keychain token, no local runtime config, no `node_modules/`.
