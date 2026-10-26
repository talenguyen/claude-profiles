# claude-profiles MVP design

## Purpose

`claude-profiles` is a dependency-free Node.js CLI for running concurrent
Claude Code sessions under manually selected subscription profiles.  Each
`use` invocation must start the real Claude executable directly with an
isolated configuration directory and the selected profile token, without a
login selector or a fallback to the caller's account.

The package is installed globally through its Node `bin` entry, making
`claude-profiles` available through `npm install -g` (or `npm link` during
development).

## Command contract

```text
claude-profiles add <profile>
claude-profiles list
claude-profiles status [profile]
claude-profiles use <profile> [-- <claude arguments>]
claude-profiles refresh <profile>
claude-profiles remove <profile>
```

Profile names are validated before they can determine a filesystem path or
Keychain service. `list` returns metadata only. `status` reports whether the
profile exists and whether its Keychain item is present; neither command reads
or prints a token.

## Components

- **CLI dispatcher:** parses and validates input, dispatches commands, and
  keeps all output free of tokens.
- **Registry:** maintains profile name and Keychain service metadata in
  `~/.config/claude-profiles/profiles.json`. Its parent directory is `0700` and
  its file mode is `0600`.
- **Keychain adapter:** calls `/usr/bin/security` to manage a generic password
  whose service is exactly `Claude Profiles: <profile>`. Tokens are never put
  in the registry, logs, or normal command output.
- **Authentication flow:** runs an interactive `claude setup-token` with
  competing auth and provider environment variables removed, then accepts the
  user-pasted token through an echo-disabled terminal prompt. `refresh` does
  not replace the existing item until the new token has been obtained.
- **Config builder:** creates and refreshes
  `~/.config/claude-profiles/configs/<profile>/` at `0700`. It symlinks only
  approved non-auth source items: settings, skills, plugins, commands, hooks,
  and history. It never shares a config root or runtime files such as daemons,
  locks, and sockets. It creates a profile-local `.claude.json` copy from the
  base file, removing only the top-level `oauthAccount` property.
- **Launcher:** reads the selected token into memory, builds the isolated
  configuration, strips all competing auth/provider settings, sets
  `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CONFIG_DIR`, and replaces itself with
  the real `claude` executable using the user-provided arguments.

## Data flow and failures

`add` and `refresh` are interactive local-only operations. A profile is added
to the registry only after its Keychain entry succeeds. `remove` asks for a
profile-specific explicit confirmation, then deletes that exact Keychain
service and registry entry.

`use` is fail-closed: a missing profile or Keychain token, unsafe or failed
config materialization, or a launcher-preparation failure exits non-zero. It
never starts ordinary Claude as a fallback. Before either authentication or
launching, the shared environment sanitizer removes `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, pre-existing
`CLAUDE_CODE_OAUTH_TOKEN`, and Bedrock, Vertex, and Foundry provider flags.
Errors identify the failed operation without exposing a token or command data
that contains one.

## Testing and acceptance

Automated tests use Node's built-in test runner with temporary directories and
fake `security` and `claude` executables. They verify registry permissions,
profile/service scoping, confirmation behavior, environment sanitization,
config allowlisting and OAuth removal, launcher arguments/environment, and
all relevant fail-closed paths.

Browser authorization and the actual Claude TUI identity are manually tested:
add two profiles, launch each including concurrent sessions, verify the TUI
identity without a login selector, refresh one profile, and remove it. The
`claude auth status` command alone is not sufficient evidence.

## Scope boundaries

The MVP supports macOS Keychain and Node built-ins only. It does not implement
automatic usage-window switching, alternate secret backends, dependency-based
credential tooling, or a wrapper TUI.
