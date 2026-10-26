# Native Profile Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each profile use Claude Code's native authentication state under its own `CLAUDE_CONFIG_DIR`, so interactive sessions open without a login selector on Claude Code 2.1.276.

**Architecture:** Profiles retain isolated config directories. `add` and `refresh` materialize the directory then invoke `claude auth login --claudeai` in that directory; Claude Code owns its Keychain credential and the profile's `oauthAccount` metadata. `use` only supplies the isolated config directory. Config refresh preserves an existing profile's OAuth metadata while stripping the base profile's metadata.

**Tech Stack:** Node.js >=23.11.0, CommonJS, Node built-ins, macOS Claude Code CLI.

**Spec:** `docs/superpowers/specs/2026-09-18-claude-profiles-mvp-design.md`

## Global Constraints

- macOS and Node built-ins only; no dependency additions.
- Never print credentials or inject `CLAUDE_CODE_OAUTH_TOKEN`.
- Profile config directories remain `0700`; `.claude.json` remains `0600`.
- Real interactive login and logout are invoked only after their commands' normal profile confirmation flow.

---

### Task 1: Native auth adapter and isolated launch

**Files:**
- Modify: `src/auth.js`
- Modify: `src/launcher.js`
- Modify: `test/keychain-auth.test.js`
- Modify: `test/commands-launcher.test.js`

**Interfaces:**
- Produces `authenticateProfile({ claudePath, spawnInteractive, configDir, env })` which launches `auth login --claudeai` with sanitized environment and `CLAUDE_CONFIG_DIR`.
- Produces `launchClaude({ claudePath, args, configDir, env, execve })` which launches with sanitized environment and `CLAUDE_CONFIG_DIR` only.

- [x] Write tests that require `auth login --claudeai`, reject injected OAuth tokens, and require launch environment to contain no OAuth token.
- [x] Run focused tests; failures showed setup-token/prompt behavior and OAuth injection remained.
- [x] Replace setup-token/prompt/legacy token behavior with native login and remove token injection from launcher.
- [x] Run focused tests and `npm test`; all pass.

### Task 2: Preserve profile-native OAuth metadata

**Files:**
- Modify: `src/config.js`
- Modify: `test/config.test.js`

**Interfaces:**
- `materializeProfileConfig(...)` copies permitted base state but retains an existing target config's top-level `oauthAccount` only.
- Produces `removeProfileConfig({ profilesConfigDir, profile })` that removes one validated profile directory.

- [x] Write a test where base OAuth metadata is stripped while target OAuth metadata remains after re-materialization; write a removal test.
- [x] Run `node --test test/config.test.js`; failures showed target OAuth metadata was discarded and no removal function existed.
- [x] Implement minimal state preservation and validated profile deletion.
- [x] Run focused config tests; all pass.

### Task 3: Commands and native-profile status

**Files:**
- Modify: `src/commands.js`
- Modify: `bin/claude-profiles.js`
- Modify: `test/commands-launcher.test.js`

**Interfaces:**
- `add`/`refresh`: materialize then native-login.
- `use`: materialize then direct launch without a profile-token lookup.
- `status`/`list`: report `present` when a profile config contains native `oauthAccount` metadata.
- `remove`: after exact confirmation, invoke `claude auth logout`, delete that profile config, then delete registry entry.

- [x] Write failing command tests for these lifecycle contracts.
- [x] Run focused command tests; failures showed commands used the legacy app Keychain flow.
- [x] Wire commands to the native auth/config interfaces, preserving fail-closed ordering.
- [x] Run focused command tests and full suite; all pass.

### Task 4: Operator documentation and package acceptance

**Files:**
- Modify: `README.md`
- Modify: `test/readme.test.js` only if public command coverage changes

- [x] Replace setup-token/legacy-Keychain instructions with native login, native config state, native logout, and existing-profile re-login instructions.
- [x] Run `npm test`, `npm pack --dry-run --json`, and `node --check` on changed source files.
- [ ] Perform manual acceptance: native-login two profiles, launch each concurrently, verify each in-TUI `/auth status`, refresh one, and remove one.
