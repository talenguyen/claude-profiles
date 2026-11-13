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
only profile metadata.

To replace an existing token without recreating the profile:

```sh
claude-profiles refresh <profile>
```

`refresh` repeats native Claude login for that profile while preserving its
isolated config directory.

## Commands

```sh
claude-profiles add <profile>
claude-profiles list
claude-profiles status [profile]
claude-profiles use <profile> [claude arguments...]
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
