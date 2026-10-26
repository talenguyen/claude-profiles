# claude-profiles MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a globally installable macOS Node.js CLI that launches the real Claude Code process with a manually selected, Keychain-backed subscription profile.

**Architecture:** A small CommonJS package separates profile validation and environment sanitation, registry and Keychain persistence, isolated Claude-config construction, and the command dispatcher. `use` resolves the actual Claude executable and calls Node's `process.execve`, replacing the CLI process instead of running a substitute TUI or falling back to the shell account.

**Tech Stack:** Node.js >= 23.11.0, CommonJS, Node built-ins (`node:fs`, `node:path`, `node:child_process`, `node:readline`, `node:test`, `node:assert/strict`), macOS `/usr/bin/security`.

**Spec:** `docs/superpowers/specs/2026-09-18-claude-profiles-mvp-design.md`

## Global Constraints

- Source lives in `.orchestrator/projects/claude-profiles`; use no dependency outside Node built-ins.
- The global package command is `claude-profiles`, supplied by `package.json`'s `bin` field.
- Store only profile name and Keychain service in a `0600` registry; store each token only as a generic password in macOS Keychain service `Claude Profiles: <profile>`.
- Create profile configuration directories with mode `0700`; never write a token to a file, log, error, or normal command output.
- Before `claude setup-token` and before `use`, remove `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, existing `CLAUDE_CODE_OAUTH_TOKEN`, and environment variables whose uppercase names contain `BEDROCK`, `VERTEX`, or `FOUNDRY`.
- `use` must fail closed if profile lookup, Keychain retrieval, config isolation, executable lookup, or replacement fails; it must not launch unisolated Claude.
- Share only `settings.json`, `settings.local.json`, `skills`, `plugins`, `commands`, `hooks`, and `history` from the base Claude config; do not share daemon, lock, socket, or other runtime paths.

---

## File structure

```text
package.json                         Package metadata, Node engine floor, global bin mapping, test script
bin/claude-profiles.js               Executable entry point; maps domain errors to secret-safe stderr
src/profile.js                       Profile-name validation and Keychain-service derivation
src/environment.js                   Auth/provider environment removal
src/registry.js                      Secure JSON metadata registry
src/keychain.js                      Narrow /usr/bin/security generic-password adapter
src/auth.js                          Interactive setup-token and hidden token capture workflow
src/config.js                        Profile config materialization and non-auth symlinks
src/launcher.js                      Claude executable resolution and process.execve replacement
src/commands.js                      Command parsing and add/list/status/use/refresh/remove orchestration
test/helpers.js                      Temporary filesystem, fake adapter, and environment fixtures
test/profile-environment.test.js     Validation and environment-unit tests
test/registry.test.js                Secure registry tests
test/keychain-auth.test.js           Keychain scoping and auth workflow tests
test/config.test.js                  Isolated config tests
test/commands-launcher.test.js       CLI orchestration and direct-exec contract tests
README.md                            Installation, commands, safety model, and manual TUI acceptance steps
```

### Task 1: Package foundation, validation, and environment sanitation

**Files:**
- Create: `package.json`
- Create: `bin/claude-profiles.js`
- Create: `src/profile.js`
- Create: `src/environment.js`
- Create: `test/helpers.js`
- Test: `test/profile-environment.test.js`

**Interfaces:**
- Produces: `validateProfile(name): string`, `serviceForProfile(name): string`, and `sanitizeEnvironment(source): Record<string, string>`.
- Produces: executable `bin/claude-profiles.js`, which will later call `run(argv, dependencies)` from `src/commands.js`.

- [ ] **Step 1: Write failing profile and environment tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { serviceForProfile, validateProfile } = require('../src/profile.js');
const { sanitizeEnvironment } = require('../src/environment.js');

test('accepts a safe profile and derives its unique service', () => {
  assert.equal(validateProfile('mep-2'), 'mep-2');
  assert.equal(serviceForProfile('mep-2'), 'Claude Profiles: mep-2');
});

test('rejects empty, traversal, and whitespace profile names', () => {
  for (const name of ['', '../mep', 'two profiles']) {
    assert.throws(() => validateProfile(name));
  }
});

test('strips every competing provider credential without mutating input', () => {
  const source = { PATH: '/bin', ANTHROPIC_API_KEY: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'secret', AWS_BEDROCK: '1', VERTEX_AI: '1', FOUNDRY_HOST: '1' };
  assert.deepEqual(sanitizeEnvironment(source), { PATH: '/bin' });
  assert.equal(source.ANTHROPIC_API_KEY, 'secret');
});
```

- [ ] **Step 2: Run the focused test and verify it fails because the modules do not exist**

Run: `node --test test/profile-environment.test.js`

Expected: FAIL with module-not-found errors for `src/profile.js` and `src/environment.js`.

- [ ] **Step 3: Add package metadata and the minimal implementations**

```json
{
  "name": "claude-profiles",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "engines": { "node": ">=23.11.0" },
  "bin": { "claude-profiles": "bin/claude-profiles.js" },
  "scripts": { "test": "node --test" }
}
```

```js
// src/profile.js
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function validateProfile(name) {
  if (typeof name !== 'string' || !PROFILE.test(name)) throw new Error('Invalid profile name.');
  return name;
}
function serviceForProfile(name) { return `Claude Profiles: ${validateProfile(name)}`; }
module.exports = { validateProfile, serviceForProfile };
```

```js
// src/environment.js
const EXACT = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN']);
function sanitizeEnvironment(source) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !EXACT.has(key) && !/(BEDROCK|VERTEX|FOUNDRY)/.test(key)));
}
module.exports = { sanitizeEnvironment };
```

```js
// test/helpers.js
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function makeTempDir(prefix = 'claude-profiles-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
async function removeTempDir(directory) {
  await fs.rm(directory, { recursive: true, force: true });
}
module.exports = { makeTempDir, removeTempDir };
```

Make `bin/claude-profiles.js` executable with `#!/usr/bin/env node`; it must import `run` only after Task 5 supplies it, print `error.message` to stderr, and set a non-zero exit code for rejected promises.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node --test test/profile-environment.test.js`

Expected: PASS with three tests.

- [ ] **Step 5: Commit the foundation**

```bash
git -C /path/to/claude-orchestrator add -f .orchestrator/projects/claude-profiles/package.json .orchestrator/projects/claude-profiles/bin .orchestrator/projects/claude-profiles/src/profile.js .orchestrator/projects/claude-profiles/src/environment.js .orchestrator/projects/claude-profiles/test
git -C /path/to/claude-orchestrator commit -m "feat: add claude profiles foundation"
```

### Task 2: Secure profile registry

**Files:**
- Create: `src/registry.js`
- Test: `test/registry.test.js`

**Interfaces:**
- Consumes: `validateProfile(name): string` and `serviceForProfile(name): string`.
- Produces: `createRegistry({ configHome }): { list(), get(name), add(name), remove(name) }`; entries have shape `{ name: string, service: string }`.

- [ ] **Step 1: Write failing registry tests**

```js
test('creates a 0700 home and 0600 registry without token data', async () => {
  const registry = createRegistry({ configHome: tempDir });
  await registry.add('mep');
  const text = await readFile(join(tempDir, 'profiles.json'), 'utf8');
  assert.deepEqual(JSON.parse(text), { profiles: [{ name: 'mep', service: 'Claude Profiles: mep' }] });
  assert.equal((await stat(tempDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(tempDir, 'profiles.json'))).mode & 0o777, 0o600);
});

test('rejects duplicate profiles and removes only the requested entry', async () => {
  const registry = createRegistry({ configHome: tempDir });
  await registry.add('mep'); await registry.add('uplive');
  await assert.rejects(registry.add('mep'));
  await registry.remove('mep');
  assert.deepEqual(await registry.list(), [{ name: 'uplive', service: 'Claude Profiles: uplive' }]);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test test/registry.test.js`

Expected: FAIL with module-not-found for `src/registry.js`.

- [ ] **Step 3: Implement atomic metadata writes**

```js
async function writeRegistry(registryPath, value) {
  const temporary = `${registryPath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, registryPath);
  await fs.chmod(registryPath, 0o600);
}
```

Implement `createRegistry` with `fs.promises.mkdir(configHome, { recursive: true, mode: 0o700 })` followed by `chmod(configHome, 0o700)`. Treat a missing registry as `{ profiles: [] }`; reject malformed JSON, duplicate names, and missing entries with secret-free errors. Always construct services with `serviceForProfile`, never trust a stored service string as an input target.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/registry.test.js && npm test`

Expected: PASS; modes and metadata shape match the tests.

- [ ] **Step 5: Commit the registry**

```bash
git -C /path/to/claude-orchestrator add -f .orchestrator/projects/claude-profiles/src/registry.js .orchestrator/projects/claude-profiles/test/registry.test.js
git -C /path/to/claude-orchestrator commit -m "feat: add secure profile registry"
```

### Task 3: Keychain adapter and interactive authentication

**Files:**
- Create: `src/keychain.js`
- Create: `src/auth.js`
- Test: `test/keychain-auth.test.js`

**Interfaces:**
- Consumes: registry entry `{ name, service }`, `sanitizeEnvironment(source): Record<string, string>`.
- Produces: `createKeychain({ runSecurity }): { has(service), read(service), replace(service, token), remove(service) }` and `authenticateProfile({ claudePath, spawnInteractive, promptHidden, keychain, service, env }): Promise<void>`.

- [ ] **Step 1: Write failing Keychain and auth tests**

```js
test('uses only generic-password commands for the exact profile service', async () => {
  const calls = [];
  const keychain = createKeychain({ runSecurity: async (args) => { calls.push(args); return { stdout: 'token-value\n' }; } });
  await keychain.read('Claude Profiles: mep');
  await keychain.remove('Claude Profiles: mep');
  assert.deepEqual(calls[0], ['find-generic-password', '-s', 'Claude Profiles: mep', '-w']);
  assert.deepEqual(calls[1], ['delete-generic-password', '-s', 'Claude Profiles: mep']);
});

test('runs setup-token with sanitized environment then replaces the token', async () => {
  const events = [];
  await authenticateProfile({ claudePath: '/fake/claude', env: { ANTHROPIC_API_KEY: 'secret', PATH: '/bin' }, service: 'Claude Profiles: mep', spawnInteractive: async (_file, args, options) => events.push({ args, env: options.env }), promptHidden: async () => 'new-token', keychain: { replace: async (service, token) => events.push({ service, token }) } });
  assert.deepEqual(events[0], { args: ['setup-token'], env: { PATH: '/bin' } });
  assert.deepEqual(events[1], { service: 'Claude Profiles: mep', token: 'new-token' });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test test/keychain-auth.test.js`

Expected: FAIL with module-not-found errors for `src/keychain.js` and `src/auth.js`.

- [ ] **Step 3: Implement secret-safe process boundaries**

```js
function createKeychain({ runSecurity }) {
  return {
    async has(service) { await runSecurity(['find-generic-password', '-s', service]); return true; },
    async read(service) { return (await runSecurity(['find-generic-password', '-s', service, '-w'])).stdout.trim(); },
    async replace(service, token) { await runSecurity(['add-generic-password', '-s', service, '-a', 'claude-profiles', '-w', token, '-U']); },
    async remove(service) { await runSecurity(['delete-generic-password', '-s', service]); }
  };
}
```

Use `spawn`/`execFile` wrappers that do not include subprocess stderr in thrown error messages. `promptHidden` must require `process.stdin.isTTY` and `process.stdout.isTTY`, set raw mode while collecting bytes until Enter, write only the prompt and trailing newline, restore raw mode in `finally`, and reject an empty token. `authenticateProfile` invokes the actual Claude path as `setup-token` with inherited stdio, calls `promptHidden` only after exit code zero, and calls `keychain.replace` only after a nonempty token is obtained.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/keychain-auth.test.js && npm test`

Expected: PASS; tests prove the Keychain service scope and replacement ordering.

- [ ] **Step 5: Commit authentication support**

```bash
git -C /path/to/claude-orchestrator add -f .orchestrator/projects/claude-profiles/src/keychain.js .orchestrator/projects/claude-profiles/src/auth.js .orchestrator/projects/claude-profiles/test/keychain-auth.test.js
git -C /path/to/claude-orchestrator commit -m "feat: add keychain profile authentication"
```

### Task 4: Isolated Claude configuration builder

**Files:**
- Create: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile }): Promise<string>` returning the absolute profile config directory.
- Consumes: `validateProfile(profile): string`; base state file is the caller's `~/.claude.json`.

- [ ] **Step 1: Write failing isolation tests**

```js
test('symlinks only approved non-auth items and strips oauthAccount', async () => {
  await writeFile(join(baseConfigDir, 'settings.json'), '{"theme":"dark"}');
  await mkdir(join(baseConfigDir, 'skills')); await mkdir(join(baseConfigDir, 'daemon'));
  await writeFile(baseStateFile, '{"oauthAccount":{"email":"a@example.test"},"other":true}');
  const target = await materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'mep' });
  assert.equal((await lstat(join(target, 'settings.json')).isSymbolicLink()), true);
  assert.equal((await lstat(join(target, 'skills')).isSymbolicLink()), true);
  await assert.rejects(lstat(join(target, 'daemon')));
  assert.deepEqual(JSON.parse(await readFile(join(target, '.claude.json'))), { other: true });
  assert.equal((await stat(target)).mode & 0o777, 0o700);
});

test('fails when the base state file is malformed instead of launching with shared auth', async () => {
  await writeFile(baseStateFile, '{not json');
  await assert.rejects(materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'mep' }));
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test test/config.test.js`

Expected: FAIL with module-not-found for `src/config.js`.

- [ ] **Step 3: Implement allowlisted materialization**

```js
const SHARED_ITEMS = ['settings.json', 'settings.local.json', 'skills', 'plugins', 'commands', 'hooks', 'history'];
for (const item of SHARED_ITEMS) {
  const source = path.join(baseConfigDir, item);
  if (await exists(source)) await fs.symlink(source, path.join(profileDir, item));
}
const state = JSON.parse(await fs.readFile(baseStateFile, 'utf8'));
delete state.oauthAccount;
await fs.writeFile(path.join(profileDir, '.claude.json'), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
```

Build into a same-parent temporary directory, chmod it `0700`, then replace an existing profile directory by renaming the existing directory to a same-parent backup, renaming the complete temporary directory to the target, and removing the backup. If the target rename fails, rename the backup back to the target before throwing; if restoration fails, throw a secret-free isolation error. Do not create a state file from scratch: missing or malformed base state is an error because account isolation cannot be established.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/config.test.js && npm test`

Expected: PASS; no runtime item is present in materialized config.

- [ ] **Step 5: Commit config isolation**

```bash
git -C /path/to/claude-orchestrator add -f .orchestrator/projects/claude-profiles/src/config.js .orchestrator/projects/claude-profiles/test/config.test.js
git -C /path/to/claude-orchestrator commit -m "feat: isolate claude profile configs"
```

### Task 5: Direct launcher and command dispatcher

**Files:**
- Create: `src/launcher.js`
- Create: `src/commands.js`
- Test: `test/commands-launcher.test.js`
- Modify: `bin/claude-profiles.js`

**Interfaces:**
- Consumes: all preceding interfaces.
- Produces: `launchClaude({ claudePath, args, token, configDir, env, execve }): never` and `run(argv, dependencies): Promise<void>`.

- [ ] **Step 1: Write failing launcher and command tests**

```js
test('replaces itself with Claude using only isolated authentication', () => {
  let actual;
  launchClaude({ claudePath: '/fake/claude', args: ['--resume'], token: 'token-value', configDir: '/profiles/mep', env: { PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'wrong' }, execve: (...received) => { actual = received; } });
  assert.deepEqual(actual, ['/fake/claude', ['/fake/claude', '--resume'], { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'token-value', CLAUDE_CONFIG_DIR: '/profiles/mep' }]);
});

test('use fails before execve when its Keychain lookup fails', async () => {
  let executed = false;
  await assert.rejects(run(['use', 'mep'], { registry: { get: async () => ({ name: 'mep', service: 'Claude Profiles: mep' }) }, keychain: { read: async () => { throw new Error('keychain unavailable'); } }, execve: () => { executed = true; } }));
  assert.equal(executed, false);
});

test('remove requires the exact profile confirmation', async () => {
  const removed = [];
  await run(['remove', 'mep'], { confirm: async () => 'uplive', registry: { get: async () => ({ service: 'Claude Profiles: mep' }), remove: async () => removed.push('registry') }, keychain: { remove: async () => removed.push('keychain') } });
  assert.deepEqual(removed, []);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test test/commands-launcher.test.js`

Expected: FAIL with module-not-found errors for `src/launcher.js` and `src/commands.js`.

- [ ] **Step 3: Implement direct replacement and each command**

```js
function launchClaude({ claudePath, args, token, configDir, env, execve = process.execve }) {
  const clean = sanitizeEnvironment(env);
  execve(claudePath, [claudePath, ...args], { ...clean, CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CONFIG_DIR: configDir });
  throw new Error('Unable to replace process with Claude.');
}
```

Resolve `claude` to an executable absolute pathname by scanning `PATH` entries with `fs.access(path, fs.constants.X_OK)`; reject no-match. `run` accepts only the six documented commands. `add` refuses an existing profile, authenticates, then adds registry metadata. `refresh` requires an existing profile and authenticates without changing registry metadata. `list` formats profile names and service presence only. `status` reports `present` or `missing` Keychain state only. `use` retrieves the token, materializes the config, then calls `launchClaude`; no catch may launch another process. `remove` prompts `Type the profile name to remove it:`, performs no deletion unless input exactly equals the selected profile, then removes Keychain before registry; if Keychain deletion fails, preserve registry metadata.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/commands-launcher.test.js && npm test`

Expected: PASS; direct-exec arguments, fail-closed `use`, and removal confirmation are verified.

- [ ] **Step 5: Commit CLI behavior**

```bash
git -C /path/to/claude-orchestrator add -f .orchestrator/projects/claude-profiles/bin/claude-profiles.js .orchestrator/projects/claude-profiles/src/launcher.js .orchestrator/projects/claude-profiles/src/commands.js .orchestrator/projects/claude-profiles/test/commands-launcher.test.js
git -C /path/to/claude-orchestrator commit -m "feat: add claude profile commands"
```

### Task 6: Installation documentation and end-to-end local verification

**Files:**
- Create: `README.md`
- Create: `test/readme.test.js`

**Interfaces:**
- Consumes: installed `claude-profiles` bin and all command contracts.
- Produces: reproducible installation and manual acceptance instructions.

- [ ] **Step 1: Write a failing operator-documentation test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

test('README documents installation and every public command', async () => {
  const readme = await readFile(path.join(__dirname, '..', 'README.md'), 'utf8');
  for (const command of ['npm install -g .', 'claude-profiles add <profile>', 'claude-profiles list', 'claude-profiles status [profile]', 'claude-profiles use <profile>', 'claude-profiles refresh <profile>', 'claude-profiles remove <profile>']) {
    assert.match(readme, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
```

- [ ] **Step 2: Run the focused test and verify it fails because README is absent**

Run: `node --test test/readme.test.js`

Expected: FAIL with an `ENOENT` error for `README.md`.

- [ ] **Step 3: Write concise operator documentation**

```markdown
## Install

npm install -g .

## Authenticate a profile

claude-profiles add mep

The browser flow is interactive. Paste the resulting setup token only into the
echo-disabled terminal prompt; never paste it into a shell command or chat.

## Verify manually

claude-profiles use mep
# In the real Claude TUI, run: auth status
```

Document `list`, `status`, `use <profile> -- --resume`, `refresh`, and the exact-name confirmation for `remove`. State that a successful `claude auth status` outside the TUI does not prove the requirement; list the two-profile sequential and concurrent TUI identity checks from `spec.md`.

- [ ] **Step 4: Run all automated checks and inspect the package contents**

Run: `npm test && npm pack --dry-run`

Expected: all Node tests PASS; dry-run lists `bin/claude-profiles.js` and source files without any Keychain token or local runtime config.

- [ ] **Step 5: Perform the manual acceptance pass on a macOS machine with two accounts**

Run:

```bash
npm link
claude-profiles add mep
claude-profiles add uplive
claude-profiles status mep
claude-profiles use mep
claude-profiles use uplive -- --resume
claude-profiles refresh mep
claude-profiles remove mep
```

Expected: each `use` opens the real Claude TUI directly without a login selector; in-TUI `auth status` identifies the chosen account; simultaneous profile sessions remain distinct; shared settings/plugins/skills work; remove deletes only `mep` after exact confirmation.

- [ ] **Step 6: Commit documentation and final test**

```bash
git -C /path/to/claude-orchestrator add -f .orchestrator/projects/claude-profiles/README.md .orchestrator/projects/claude-profiles/test/readme.test.js
git -C /path/to/claude-orchestrator commit -m "docs: add claude profiles usage guide"
```

## Plan self-review

**Spec coverage:** Tasks 1–3 cover global installation, profile metadata, browser-token flow, Keychain isolation, sanitization, and secret-safe output. Task 4 covers profile config mode, symlink allowlisting, runtime exclusion, and `oauthAccount` removal. Task 5 covers all CLI commands, direct replacement, confirmation, and fail-closed behavior. Task 6 covers automated evidence and the required real-TUI identity acceptance checks.

**Placeholder scan:** The plan contains no deferred implementation markers or generic test directives; each task names concrete paths, interfaces, commands, and expected results.

**Type consistency:** `validateProfile`, `serviceForProfile`, `sanitizeEnvironment`, registry entries, `createKeychain`, `materializeProfileConfig`, `launchClaude`, and `run` use the same names and parameter shapes wherever they appear.
