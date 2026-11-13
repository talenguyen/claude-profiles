# Verification

Back to the [README](../README.md).

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

- [ ] `add mep` and `add uplive` complete via browser auth without leaking
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
      and `hooks`). `history.jsonl` stays per profile. Runtime files — daemon,
      lock, socket — are not shared.
- [ ] `refresh mep` re-authenticates successfully; a follow-up `use mep`
      still opens the TUI directly without a login selector.
- [ ] `remove mep` logs out and deletes the `mep` profile config and registry entry after
      exact-name confirmation. Typing the wrong name aborts the command and
      leaves `uplive` and its native profile state untouched.

The package ships no secrets: `npm pack --dry-run` lists every source file
under `bin/` and `src/`, the test files, `package.json`, `README.md`,
`spec.md`, and the project-internal `.pi/agents/*` and `docs/superpowers/*`
docs; no Keychain token, no local runtime config, no `node_modules/`.
