const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { checkProfile, hookTarget, POLICY_RULES, MAX_PER_CATEGORY } = require('../src/doctor.js');
const { materializeProfileConfig, SHARED_ITEMS } = require('../src/config.js');
const { run } = require('../src/commands.js');
const { makeTempDir, removeTempDir, clearInheritedConfigEnv } = require('./helpers.js');

clearInheritedConfigEnv();

let root;
let home;
let binDir;
let baseConfigDir;
let profilesConfigDir;
let env;

test.beforeEach(async () => {
  root = await makeTempDir('doctor-');
  home = path.join(root, 'home');
  binDir = path.join(root, 'bin');
  baseConfigDir = path.join(home, '.claude');
  profilesConfigDir = path.join(root, 'profiles');
  env = { HOME: home, PATH: binDir };
  await fsp.mkdir(binDir, { recursive: true });
  await fsp.mkdir(baseConfigDir, { recursive: true });
  await fsp.writeFile(path.join(baseConfigDir, '.claude.json'), '{}');
});

test.afterEach(async () => {
  await removeTempDir(root);
});

const writeJson = (file, value) => fsp.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));

async function writeExecutable(file) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, '#!/bin/sh\nexit 0\n');
  await fsp.chmod(file, 0o755);
}

// A base config with every shared item, settings that enable one installed
// plugin and run one hook, and one real skill: the clean starting point.
async function fillBase({ hooks, enabledPlugins } = {}) {
  const pluginRoot = path.join(baseConfigDir, 'plugins', 'cache', 'good');
  await fsp.mkdir(pluginRoot, { recursive: true });
  const hookScript = path.join(baseConfigDir, 'hooks', 'ok.sh');
  await writeExecutable(hookScript);
  for (const item of SHARED_ITEMS) {
    const full = path.join(baseConfigDir, item);
    if (await fsp.access(full).then(() => true, () => false)) continue;
    if (item.includes('.')) await fsp.writeFile(full, '{}');
    else await fsp.mkdir(full);
  }
  await writeJson(path.join(baseConfigDir, 'settings.json'), {
    enabledPlugins: enabledPlugins || { 'good@market': true, 'off@market': false },
    hooks: hooks || { SessionStart: [{ hooks: [{ type: 'command', command: `bash '${hookScript}' session` }] }] }
  });
  await writeJson(path.join(baseConfigDir, 'plugins', 'installed_plugins.json'), {
    version: 2, plugins: { 'good@market': [{ scope: 'user', installPath: pluginRoot }] }
  });
  await writeJson(path.join(baseConfigDir, 'plugins', 'known_marketplaces.json'), { market: { source: { source: 'github', repo: 'o/r' } } });
  await fsp.mkdir(path.join(baseConfigDir, 'skills', 'real'), { recursive: true });
}

async function makeProfile(name = 'a') {
  const target = await materializeProfileConfig({
    baseConfigDir, baseStateFile: path.join(baseConfigDir, '.claude.json'), profilesConfigDir, profile: name, isAlive: () => false
  });
  return target;
}

const check = (profileDir, extra = {}) => checkProfile({ profile: 'a', profileDir, baseConfigDir, env, ...extra });

// A profile in sync with the base, ready for one fault to be added.
async function cleanProfile() {
  await fillBase();
  return makeProfile('a');
}

test('a clean profile prints nothing', async () => {
  assert.deepEqual(await check(await cleanProfile()), []);
});

test('a profile whose config does not exist yet has nothing to check', async () => {
  assert.deepEqual(await check(path.join(profilesConfigDir, 'nope')), []);
});

// ---- shared links ----

test('a missing shared link is reported with the relink fix', async () => {
  const target = await cleanProfile();
  await fsp.rm(path.join(target, 'agents'));
  assert.deepEqual(await check(target), ['warning: a: agents is missing; run: claude-profiles relink a']);
});

test('a real directory or file in place of a shared link is reported', async () => {
  const target = await cleanProfile();
  await fsp.rm(path.join(target, 'skills'));
  await fsp.mkdir(path.join(target, 'skills'));
  await fsp.rm(path.join(target, 'CLAUDE.md'));
  await fsp.writeFile(path.join(target, 'CLAUDE.md'), 'mine');
  const lines = await check(target);
  assert.ok(lines.includes('warning: a: skills is a real directory, not a link to the base config; run: claude-profiles relink a'));
  assert.ok(lines.includes('warning: a: CLAUDE.md is a real file, not a link to the base config; run: claude-profiles relink a'));
});

test('a link to somewhere other than the base item, or a broken one, is reported', async () => {
  const target = await cleanProfile();
  const elsewhere = path.join(root, 'elsewhere');
  await fsp.mkdir(elsewhere);
  await fsp.rm(path.join(target, 'hooks'));
  await fsp.symlink(elsewhere, path.join(target, 'hooks'));
  await fsp.rm(path.join(target, 'commands'));
  await fsp.symlink(path.join(root, 'gone'), path.join(target, 'commands'));
  const lines = await check(target);
  assert.ok(lines.includes('warning: a: hooks is linked somewhere other than the base config; run: claude-profiles relink a'));
  assert.ok(lines.includes('warning: a: commands is a broken link; run: claude-profiles relink a'));
});

test('a shared item the base config lacks is not reported', async () => {
  const target = await cleanProfile();
  await fsp.rm(path.join(baseConfigDir, 'output-styles'), { recursive: true });
  await fsp.rm(path.join(target, 'output-styles'));
  assert.deepEqual(await check(target), []);
});

test('items the launch repair already warned about are not repeated', async () => {
  const target = await cleanProfile();
  await fsp.rm(path.join(target, 'agents'));
  assert.deepEqual(await check(target, { skipLinkItems: new Set(['agents']) }), []);
});

// ---- plugins ----

test('a plugin enabled but not installed is reported; a disabled one is not', async () => {
  const target = await cleanProfile();
  await writeJson(path.join(baseConfigDir, 'settings.json'), { enabledPlugins: { 'good@market': true, 'missing@market': true, 'off@market': false } });
  assert.deepEqual(await check(target), [
    'warning: a: plugin missing@market is enabled but it is not installed; run /plugin install missing@market, or disable it in settings.json'
  ]);
});

test('a plugin whose install files are gone is reported', async () => {
  const target = await cleanProfile();
  await fsp.rm(path.join(baseConfigDir, 'plugins', 'cache', 'good'), { recursive: true });
  assert.deepEqual(await check(target), [
    'warning: a: plugin good@market is enabled but its install files are missing; run /plugin install good@market, or disable it in settings.json'
  ]);
});

test('a missing marketplace is reported for an installed and for an uninstalled plugin', async () => {
  const target = await cleanProfile();
  await writeJson(path.join(baseConfigDir, 'plugins', 'known_marketplaces.json'), {});
  await writeJson(path.join(baseConfigDir, 'settings.json'), { enabledPlugins: { 'good@market': true, 'new@other': true } });
  assert.deepEqual(await check(target), [
    'warning: a: plugin good@market is installed but its marketplace "market" is not in the plugins registry; run /plugin marketplace add to restore it',
    'warning: a: plugin new@other is enabled but it is not installed and its marketplace "other" is not in the plugins registry; run /plugin marketplace add, then /plugin install new@other, or disable it in settings.json'
  ]);
});

test('settings.local.json enabledPlugins are merged over settings.json', async () => {
  const target = await cleanProfile();
  await writeJson(path.join(baseConfigDir, 'settings.local.json'), { enabledPlugins: { 'good@market': false, 'local@market': true } });
  assert.deepEqual(await check(target), [
    'warning: a: plugin local@market is enabled but it is not installed; run /plugin install local@market, or disable it in settings.json'
  ]);
});

test('an unknown-shaped plugins registry gives one could-not-check line', async () => {
  const target = await cleanProfile();
  await writeJson(path.join(baseConfigDir, 'plugins', 'installed_plugins.json'), '{ not json');
  assert.deepEqual(await check(target), [
    'warning: a: could not check plugins (plugins/installed_plugins.json: it is not valid JSON); repair or delete that file'
  ]);
  await writeJson(path.join(baseConfigDir, 'plugins', 'installed_plugins.json'), { version: 2, plugins: ['x'] });
  assert.deepEqual(await check(target), [
    'warning: a: could not check plugins (plugins/installed_plugins.json has no "plugins" object); repair or delete that file'
  ]);
  await writeJson(path.join(baseConfigDir, 'settings.json'), { enabledPlugins: ['x'] });
  assert.deepEqual(await check(target), [
    'warning: a: could not check plugins (settings.json "enabledPlugins" is not an object); fix it in settings.json'
  ]);
});

// ---- hooks ----

const hookSettings = (...commands) => ({ hooks: { Stop: [{ hooks: commands.map((command) => ({ type: 'command', command })) }] } });

test('a hook whose script is missing is reported, once per script', async () => {
  const target = await cleanProfile();
  const missing = path.join(home, '.claude', 'hooks', 'gone.sh');
  await writeJson(path.join(baseConfigDir, 'settings.json'), hookSettings(`bash '${missing}'`, `sh "$HOME/.claude/hooks/gone.sh" x`));
  assert.deepEqual(await check(target), [
    `warning: a: Stop hook runs ${missing}, but that script was not found; restore it or remove the hook from settings.json`
  ]);
});

test('a hook executable is looked up directly when absolute and on PATH when bare', async () => {
  const target = await cleanProfile();
  const plain = path.join(home, 'plain.sh');
  await fsp.writeFile(plain, '#!/bin/sh\n');
  await fsp.chmod(plain, 0o644);
  await writeExecutable(path.join(binDir, 'present-tool'));
  await writeJson(path.join(baseConfigDir, 'settings.json'), hookSettings(plain, 'present-tool --flag', 'absent-tool', '~/nowhere/run.sh'));
  assert.deepEqual(await check(target), [
    `warning: a: Stop hook runs ${plain}, but that file was not found or is not executable; restore it or remove the hook from settings.json`,
    'warning: a: Stop hook runs absent-tool, but that executable was not found on PATH; restore it or remove the hook from settings.json',
    `warning: a: Stop hook runs ${path.join(home, 'nowhere', 'run.sh')}, but that file was not found or is not executable; restore it or remove the hook from settings.json`
  ]);
});

test('hook commands whose target cannot be told from the text are skipped, not guessed', async () => {
  const target = await cleanProfile();
  await writeJson(path.join(baseConfigDir, 'settings.json'), hookSettings(
    'if [ -z "$X" ]; then echo hi; fi',
    'bash -c "run something"',
    'node -e "1"',
    '${CLAUDE_PLUGIN_ROOT}/bin/run.sh',
    'missing-a | missing-b',
    'cat /nowhere/x > /dev/null',
    './relative.sh',
    'FOO=1 echo done'
  ));
  assert.deepEqual(await check(target), []);
});

test('hookTarget reads the script out of an interpreter command', () => {
  assert.deepEqual(hookTarget(`bash '/x/y.sh' session`, env), { target: '/x/y.sh', direct: false });
  assert.deepEqual(hookTarget('FOO=1 node --no-warnings $HOME/h.js', env), { target: path.join(home, 'h.js'), direct: false });
  assert.deepEqual(hookTarget('gh-axi', env), { target: 'gh-axi', direct: true });
  assert.equal(hookTarget('echo hi', env), null);
  assert.equal(hookTarget(42, env), null);
});

test('a hooks entry of the wrong shape gives one could-not-check line', async () => {
  const target = await cleanProfile();
  await writeJson(path.join(baseConfigDir, 'settings.json'), { hooks: { Stop: 'nope' } });
  assert.deepEqual(await check(target), ['warning: a: could not check hooks (hooks.Stop is not a list); fix it in settings.json']);
  await writeJson(path.join(baseConfigDir, 'settings.json'), { hooks: [] });
  assert.deepEqual(await check(target), ['warning: a: could not check hooks (settings.json "hooks" is not an object); fix it in settings.json']);
});

// ---- skills ----

test('a dangling skill link is reported by name; a good link and a plain folder are not', async () => {
  const target = await cleanProfile();
  const skills = path.join(baseConfigDir, 'skills');
  await fsp.symlink(path.join(skills, 'real'), path.join(skills, 'good-link'));
  await fsp.symlink(path.join(root, 'moved', 'skill'), path.join(skills, 'stale'));
  assert.deepEqual(await check(target), [
    `warning: a: skill "stale" is a dangling link to ${path.join(root, 'moved', 'skill')}; restore its target or delete the link`
  ]);
});

test('many dangling skills fold into one summary line', async () => {
  const target = await cleanProfile();
  for (let i = 0; i < MAX_PER_CATEGORY + 3; i += 1) {
    await fsp.symlink(path.join(root, 'moved', `s${i}`), path.join(baseConfigDir, 'skills', `stale-${String(i).padStart(2, '0')}`));
  }
  const lines = await check(target);
  assert.equal(lines.length, MAX_PER_CATEGORY + 1);
  assert.equal(lines.at(-1), 'warning: a: ... and 3 more dangling skill links; run: claude-profiles doctor');
});

// ---- connectors ----

test('claude.ai connectors in the per-profile auth cache are reported; plugin servers are not', async () => {
  const target = await cleanProfile();
  await writeJson(path.join(target, 'mcp-needs-auth-cache.json'), {
    'claude.ai Zeta': { timestamp: 1 }, 'claude.ai Alpha': { timestamp: 2, id: 'x' }, 'plugin:design:figma': { timestamp: 3 }
  });
  assert.deepEqual(await check(target), [
    'warning: a: claude.ai connector "Alpha" needs to be authenticated for this account; run: claude-profiles use a, then /mcp',
    'warning: a: claude.ai connector "Zeta" needs to be authenticated for this account; run: claude-profiles use a, then /mcp'
  ]);
});

test('an empty auth cache is clean and a malformed one gives one could-not-check line', async () => {
  const target = await cleanProfile();
  await writeJson(path.join(target, 'mcp-needs-auth-cache.json'), {});
  assert.deepEqual(await check(target), []);
  await writeJson(path.join(target, 'mcp-needs-auth-cache.json'), '[1,');
  assert.deepEqual(await check(target), [
    'warning: a: could not check connectors (mcp-needs-auth-cache.json: it is not valid JSON); delete that file to reset it'
  ]);
  await writeJson(path.join(target, 'mcp-needs-auth-cache.json'), '[]');
  assert.deepEqual(await check(target), [
    'warning: a: could not check connectors (mcp-needs-auth-cache.json: it is not a JSON object); delete that file to reset it'
  ]);
});

// ---- org policy ----

const RULE = { key: 'allow_thing', enabledIn: (settings) => (settings.thing ? 'thing' : null), fix: 'remove "thing" from settings.json' };

test('no policy mapping ships, so a restrictive policy file alone warns about nothing', async () => {
  assert.deepEqual(POLICY_RULES, []);
  const target = await cleanProfile();
  await writeJson(path.join(target, 'policy-limits.json'), { restrictions: { allow_quick_web_setup: { allowed: false } } });
  assert.deepEqual(await check(target), []);
});

test('a proven policy rule warns only when the restriction applies and the setting is enabled', async () => {
  const target = await cleanProfile();
  const base = JSON.parse(await fsp.readFile(path.join(baseConfigDir, 'settings.json'), 'utf8'));
  await writeJson(path.join(baseConfigDir, 'settings.json'), { ...base, thing: true });
  await writeJson(path.join(target, 'policy-limits.json'), { restrictions: { allow_thing: { allowed: false } } });
  assert.deepEqual(await check(target, { policyRules: [RULE] }), [
    'warning: a: org policy for this account restricts allow_thing, but the shared settings enable thing; remove "thing" from settings.json'
  ]);
  await writeJson(path.join(target, 'policy-limits.json'), { restrictions: { allow_thing: { allowed: true } } });
  assert.deepEqual(await check(target, { policyRules: [RULE] }), []);
});

test('a malformed policy file gives one could-not-check line when rules exist', async () => {
  const target = await cleanProfile();
  await writeJson(path.join(target, 'policy-limits.json'), '{oops');
  assert.deepEqual(await check(target, { policyRules: [RULE] }), [
    'warning: a: could not check org policy (policy-limits.json: it is not valid JSON); skipped'
  ]);
  await writeJson(path.join(target, 'policy-limits.json'), { defaults: {} });
  assert.deepEqual(await check(target, { policyRules: [RULE] }), [
    'warning: a: could not check org policy (policy-limits.json: it has no "restrictions" object); skipped'
  ]);
});

// ---- malformed settings ----

test('a malformed settings.json gives one could-not-check line instead of a crash', async () => {
  const target = await cleanProfile();
  await writeJson(path.join(baseConfigDir, 'settings.json'), '{ "enabledPlugins": ');
  assert.deepEqual(await check(target), [
    'warning: a: could not check plugins and hooks (settings.json: it is not valid JSON); fix or delete the file'
  ]);
});

// ---- doctor command ----

function commandDeps(extra = {}) {
  const out = [];
  const err = [];
  return {
    out,
    err,
    deps: {
      registry: { list: async () => [{ name: 'a' }, { name: 'b' }], get: async (name) => ({ name }) },
      profilesConfigDir, baseConfigDir, env, print: (text) => out.push(text), printErr: (text) => err.push(text), ...extra
    }
  };
}

test('doctor on clean profiles prints nothing and succeeds', async () => {
  await fillBase();
  await makeProfile('a');
  await makeProfile('b');
  const { deps, out, err } = commandDeps();
  await run(['doctor'], deps);
  await run(['doctor', '--all'], deps);
  await run(['doctor', 'a'], deps);
  assert.deepEqual([out, err], [[], []]);
});

test('doctor prints each warning and exits non-zero', async () => {
  await fillBase();
  const target = await makeProfile('a');
  await makeProfile('b');
  await fsp.rm(path.join(target, 'agents'));
  await writeJson(path.join(target, 'mcp-needs-auth-cache.json'), { 'claude.ai Uplive Data': { timestamp: 1 } });
  const { deps, err } = commandDeps();
  await assert.rejects(run(['doctor', '--all'], deps), /2 warning\(s\) found/);
  assert.equal(err.length, 2);
  assert.ok(err.every((line) => line.startsWith('warning: a: ')));
  const second = commandDeps();
  await assert.rejects(run(['doctor', 'a'], second.deps), /2 warning\(s\) found/);
  await run(['doctor', 'b'], second.deps);
});

test('doctor for one profile without a config errors, and with --all skips it', async () => {
  await fillBase();
  await makeProfile('a');
  const { deps, out } = commandDeps();
  await assert.rejects(run(['doctor', 'b'], deps), /no profile config yet/);
  await run(['doctor', '--all'], deps);
  assert.deepEqual(out, ['b: no profile config yet; skipped']);
});

test('doctor rejects bad arguments', async () => {
  const { deps } = commandDeps();
  await assert.rejects(run(['doctor', '--nope'], deps), /unknown option/);
  await assert.rejects(run(['doctor', 'a', 'b'], deps), /Usage: doctor/);
  await assert.rejects(run(['doctor', 'a', '--all'], deps), /Usage: doctor/);
});

// ---- launch ----

function launchDeps(extra = {}) {
  const err = [];
  const launched = [];
  const deps = {
    registry: { get: async (name) => ({ name, sessions: 'private' }), list: async () => [{ name: 'a', sessions: 'private' }] },
    profilesConfigDir,
    baseConfigDir,
    baseStateFile: path.join(baseConfigDir, '.claude.json'),
    materializeProfileConfig,
    resolveClaude: async () => '/fake/claude',
    launchClaude: (args) => launched.push(args),
    isAlive: () => false,
    env,
    printErr: (text) => err.push(text),
    ...extra
  };
  return { deps, err, launched };
}

test('a clean profile launches without printing anything', async () => {
  await fillBase();
  await makeProfile('a');
  const { deps, err, launched } = launchDeps();
  await run(['use', 'a'], deps);
  assert.deepEqual(err, []);
  assert.equal(launched.length, 1);
});

test('launch warns about every fault class and still launches', async () => {
  await fillBase();
  const target = await makeProfile('a');
  await writeJson(path.join(baseConfigDir, 'settings.json'), {
    enabledPlugins: { 'missing@market': true }, ...hookSettings(`bash '${path.join(home, 'gone.sh')}'`)
  });
  await fsp.symlink(path.join(root, 'moved'), path.join(baseConfigDir, 'skills', 'stale'));
  await writeJson(path.join(target, 'mcp-needs-auth-cache.json'), { 'claude.ai Uplive Data': { timestamp: 1 } });
  const { deps, err, launched } = launchDeps({ launchClaude: (args) => launched.push(args) });
  await run(['use', 'a', '--resume'], deps);
  assert.equal(err.length, 4);
  for (const part of ['plugin missing@market', 'Stop hook runs', 'skill "stale"', 'claude.ai connector "Uplive Data"']) {
    assert.ok(err.some((line) => line.includes(part)), part);
  }
  assert.equal(launched.length, 1);
  assert.deepEqual(launched[0].args, ['--resume']);
});

test('launch warns and proceeds when a check file is malformed', async () => {
  await fillBase();
  const target = await makeProfile('a');
  await writeJson(path.join(target, 'mcp-needs-auth-cache.json'), '{bad');
  const { deps, err, launched } = launchDeps();
  await run(['use', 'a'], deps);
  assert.equal(err.length, 1);
  assert.match(err[0], /could not check connectors/);
  assert.equal(launched.length, 1);
});

test('launch proceeds even when the check cannot run at all', async () => {
  const { deps, launched } = launchDeps({ materializeProfileConfig: async () => undefined, baseConfigDir: undefined });
  await run(['use', 'a'], deps);
  assert.equal(launched.length, 1);
});

test('a link the repair skipped for a live session is warned about once, not twice', async () => {
  await fillBase();
  const target = await makeProfile('a');
  await fsp.rm(path.join(target, 'agents'));
  await fsp.mkdir(path.join(target, 'agents'));
  await fsp.mkdir(path.join(target, 'sessions'));
  await writeJson(path.join(target, 'sessions', '4242.json'), {});
  const { deps, err, launched } = launchDeps({ isAlive: () => true });
  await run(['use', 'a'], deps);
  assert.equal(err.filter((line) => line.includes('agents')).length, 1);
  assert.match(err[0], /Claude is running for this profile/);
  assert.equal(launched.length, 1);
});

test('the check also runs on the auto launch path, including auto resume', async () => {
  await fillBase();
  const target = await makeProfile('a');
  await writeJson(path.join(target, 'mcp-needs-auth-cache.json'), { 'claude.ai Uplive Data': { timestamp: 1 } });
  const now = Date.UTC(2026, 10, 16, 12, 0, 0);
  const window = { utilization: 10, resets_at: new Date(now + 3600_000).toISOString() };
  const state = {
    oauthAccount: { accountUuid: 'u' },
    cachedUsageUtilization: { fetchedAtMs: now - 1000, accountUuid: 'u', utilization: { five_hour: window, seven_day: window } }
  };
  for (const argv of [['use', '--auto'], ['use', '--auto', '--continue']]) {
    const { deps, err, launched } = launchDeps({
      readProfileState: async () => state,
      spawnProbe: () => { throw new Error('probe must not run in this test'); },
      configHome: root,
      now: () => now,
      cwd: path.join(root, 'no-such-cwd'),
      isTTY: false,
      print: () => {}
    });
    await run(argv, deps);
    assert.equal(launched.length, 1, argv.join(' '));
    assert.equal(err.filter((line) => line.includes('claude.ai connector "Uplive Data"')).length, 1, argv.join(' '));
  }
});
