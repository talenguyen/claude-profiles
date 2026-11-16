# Command reference

Every `claude-profiles` command in detail. For the short version, see the [README](../README.md).

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
only profile metadata: the name, its service label, an optional plan tier, and
whether the profile shares session history (`sessions`: `shared` or `private`,
default `private`). `add --tier <tier>` sets the tier when you create the
profile.

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
claude-profiles use --auto [--force] [--no-fork] [claude arguments...]
claude-profiles usage [--json]
claude-profiles tier <profile> <tier>
claude-profiles share-sessions [--dry-run] [--rollback] [<profile>...]
claude-profiles relink [--dry-run] <profile>|--all
claude-profiles doctor [<profile>|--all]
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

### `use --auto`

```sh
claude-profiles use --auto [--force] [--no-fork] [claude arguments...]
```

Launch the profile with the most real capacity left. Covered in full in
[auto-mode.md](auto-mode.md).

### `share-sessions`

```sh
claude-profiles share-sessions [--dry-run] [--rollback] [<profile>...]
```

Let opted-in profiles share session history, so a conversation can continue on
another profile. Covered in full, including the data-crossing note, in
[shared-sessions.md](shared-sessions.md).

### Shared config and `relink`

```sh
claude-profiles relink [--dry-run] <profile>|--all
```

Every profile links these items from your base `~/.claude`, so all profiles
use the same configuration: `settings.json`, `settings.local.json`,
`CLAUDE.md`, `skills`, `plugins`, `commands`, `hooks`, `agents`,
`keybindings.json`, `output-styles`. Items missing from the base config are
skipped. Account and recall state stays per profile: `.claude.json`,
`.credentials.json`, `history.jsonl`. Session folders follow
[shared-sessions.md](shared-sessions.md).

A new profile gets the links when it is created, and every launch (`use`,
`use --auto`, `refresh`) re-checks an existing profile:

- missing link: created;
- already a link to the base item: left alone;
- a real file or directory, or a link somewhere else: moved to
  `<item>.pre-share-<timestamp>` next to it and replaced by the link. Nothing is
  deleted. If Claude is running for that profile, the item is left as it is and
  one warning names it and the command to run once Claude has exited.

`relink` runs the same repair on demand for one profile or `--all`, and
`--dry-run` prints what would change without touching anything. It exits
non-zero when an item was skipped (Claude running) or could not be replaced.

### Profile checks and `doctor`

```sh
claude-profiles doctor [<profile>|--all]
```

Some things still go wrong per profile after the links are in place: a plugin
that was never installed, a hook script that moved, a skill link that points
nowhere, a claude.ai connector this account has not authenticated. Claude Code's
own documentation does not say it reports the first three at startup (plugin
errors are listed in `/plugin`, a bad hook only fails when it runs), so
`claude-profiles` checks for them itself.

The checks run before Claude starts on every `use` launch (including `use --auto`
and its `--resume`/`--continue` path), and on demand with `doctor` for one
profile or all of them (the default). Each problem is one `warning: <profile>: ...`
line on stderr that names the item and the fix. A clean profile prints nothing.
They only read local files: no network, and `claude` is never started.

| Check | Warns when |
| --- | --- |
| Shared links | An item that exists in the base config is missing, a real file or directory, linked somewhere else, or broken. This includes an item the launch repair skipped because Claude was running (that case is reported once). Fix: `relink`. |
| Plugins | A plugin enabled in `settings.json` / `settings.local.json` is not in `plugins/installed_plugins.json`, its install folder is gone, or its marketplace is not in `plugins/known_marketplaces.json`. |
| Hooks | A command hook runs a script or executable that cannot be found (or is not executable). Commands that are not a plain command (pipes, `;`, `&&`, `$(...)`, `bash -c`, `${CLAUDE_PLUGIN_ROOT}`, relative paths, shell keywords) are skipped, because their target cannot be told from the text. |
| Skills | A link inside `skills` points at something that no longer exists. More than 10 are folded into one summary line. |
| Connectors | The profile's own `mcp-needs-auth-cache.json` lists a `claude.ai ...` connector. Each account authenticates its own connectors; plugin MCP servers in that file are not reported. |
| Org policy | A restriction in the profile's `policy-limits.json` blocks something the shared settings enable. No mapping from a restriction to a setting is documented or visible in the local files, so none is built in yet and this check never warns today. |

A file the checks cannot read or do not recognise (invalid JSON, an unexpected
shape) gives a single `could not check ...` line for that item instead of an
error. Launching never changes: warnings do not block it and do not change its
exit status. `doctor` exits `1` when it printed any warning, `0` otherwise. With
one named profile that has no config yet it is an error; with `--all` that
profile is skipped.

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

Set a registered profile's tier (see the tier table in [auto-mode.md](auto-mode.md)).

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
