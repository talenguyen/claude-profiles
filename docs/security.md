# Security

Back to the [README](../README.md).

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
- Session history is shared only between profiles you opt in with
  `share-sessions`, in a `0700` folder outside any project. It never contains
  credentials, and `--fork` compares organization ids without printing them.
  Read the data-crossing note in [shared-sessions.md](shared-sessions.md) before opting in.
- No token ever appears in stdout, stderr, log output, or shell history.

## What does and does not prove isolation

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
