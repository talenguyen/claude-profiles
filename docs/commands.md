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
