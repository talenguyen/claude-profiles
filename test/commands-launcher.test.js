const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { launchClaude } = require('../src/launcher.js');
const { run } = require('../src/commands.js');
const { materializeProfileConfig } = require('../src/config.js');
const { makeTempDir, removeTempDir } = require('./helpers.js');

test('help prints command usage and native onboarding guidance', async () => {
  const output = [];

  await run(['help'], { print: (text) => output.push(text) });

  assert.match(output.join('\n'), /use <profile>/);
  assert.match(output.join('\n'), /one-time\s+Claude onboarding/i);
});

test('the --help flag prints help without dependencies', async () => {
  const output = [];

  await run(['--help'], { print: (text) => output.push(text) });

  assert.match(output.join('\n'), /add <profile>/);
});

test('replaces itself with Claude using only its isolated config', () => {
  let actual;
  launchClaude({ claudePath: '/fake/claude', args: ['--resume'], configDir: '/profiles/mep', env: { PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'wrong', CLAUDE_CODE_OAUTH_TOKEN: 'legacy-token' }, execve: (...received) => { actual = received; } });
  assert.deepEqual(actual, ['/fake/claude', ['/fake/claude', '--resume'], { PATH: '/bin', CLAUDE_CONFIG_DIR: '/profiles/mep' }]);
});

test('use launches a materialized native-auth profile without custom Keychain access', async () => {
  let actual;
  await run(['use', 'mep'], {
    resolveClaude: async () => '/fake/claude',
    registry: { get: async () => ({ name: 'mep' }) },
    materializeProfileConfig: async () => '/profiles/mep',
    launchClaude: (args) => { actual = args; },
    env: { PATH: '/bin' }
  });
  assert.equal(actual.configDir, '/profiles/mep');
  assert.equal('token' in actual, false);
});

test('use forwards Claude arguments given without a literal -- separator', async () => {
  const launched = [];
  const deps = {
    resolveClaude: async () => '/fake/claude',
    registry: { get: async () => ({ name: 'uplive' }) },
    materializeProfileConfig: async () => '/profiles/uplive',
    launchClaude: (args) => launched.push(args),
    env: { PATH: '/bin' }
  };

  await run(['use', 'uplive', '--resume'], deps);
  await run(['use', 'uplive', '--resume', 'abc123', '--model', 'opus'], deps);
  await run(['use', 'uplive', '--', '--resume'], deps);

  assert.deepEqual(launched.map((call) => call.args), [
    ['--resume'],
    ['--resume', 'abc123', '--model', 'opus'],
    ['--resume']
  ]);
});

test('remove requires the exact profile confirmation before native logout', async () => {
  const removed = [];
  await run(['remove', 'mep'], { confirm: async () => 'uplive', registry: { get: async () => ({ name: 'mep' }), remove: async () => removed.push('registry') }, logoutProfile: async () => removed.push('logout'), removeProfileConfig: async () => removed.push('config') });
  assert.deepEqual(removed, []);
});

test('use reaches launchClaude when materializeProfileConfig is wired into deps (fix round 1)', async () => {
  const { buildDependencies } = require('../bin/claude-profiles.js');
  const tempDir = await makeTempDir('task-5-fix-');
  try {
    const baseConfigDir = path.join(tempDir, 'base');
    const baseStateFile = path.join(baseConfigDir, '.claude.json');
    const profilesConfigDir = path.join(tempDir, 'profiles');
    await fsp.mkdir(baseConfigDir, { recursive: true });
    await fsp.writeFile(baseStateFile, '{}');

    const deps = await buildDependencies();
    assert.equal(typeof deps.materializeProfileConfig, 'function', 'buildDependencies must expose materializeProfileConfig');
    deps.baseConfigDir = baseConfigDir;
    deps.baseStateFile = baseStateFile;
    deps.profilesConfigDir = profilesConfigDir;
    deps.resolveClaude = async () => '/fake/claude';
    deps.registry = { get: async () => ({ name: 'mep', service: 'Claude Profiles: mep' }) };
    let launchArgs;
    deps.launchClaude = (args) => { launchArgs = args; };

    await run(['use', 'mep'], deps);
    assert.ok(launchArgs, 'launchClaude should be reached when buildDependencies wires materializeProfileConfig');
    assert.equal('token' in launchArgs, false);
    assert.equal(launchArgs.claudePath, '/fake/claude');
    assert.equal(launchArgs.configDir, path.join(profilesConfigDir, 'mep'));
  } finally {
    await removeTempDir(tempDir);
  }
});

test('add reaches authenticateProfile when buildDependencies wires it (live-test regression)', async () => {
  const { buildDependencies } = require('../bin/claude-profiles.js');
  const tempDir = await makeTempDir('task-live-fix-');
  try {
    const deps = await buildDependencies();
    assert.equal(typeof deps.authenticateProfile, 'function', 'buildDependencies must expose authenticateProfile');

    deps.configHome = tempDir;
    deps.resolveClaude = async () => '/fake/claude';
    deps.registry = {
      get: async () => { throw new Error('Profile not found.'); },
      add: async () => {}
    };
    deps.materializeProfileConfig = async () => path.join(tempDir, 'profiles', 'mep');

    let authCalled = false;
    deps.authenticateProfile = async () => { authCalled = true; };

    await run(['add', 'mep'], deps);
    assert.equal(authCalled, true, 'authenticateProfile should be reached for a fresh add');
  } finally {
    await removeTempDir(tempDir);
  }
});

test('add materializes its config before native login', async () => {
  const events = [];
  await run(['add', 'mep'], {
    registry: { get: async () => { throw new Error('Profile not found.'); }, add: async () => events.push('registry') },
    resolveClaude: async () => '/fake/claude',
    materializeProfileConfig: async () => { events.push('config'); return '/profiles/mep'; },
    authenticateProfile: async (args) => events.push(args.configDir),
    env: { PATH: '/bin' }
  });
  assert.deepEqual(events, ['config', '/profiles/mep', 'registry']);
});

test('status reports native profile auth metadata', async () => {
  const output = [];
  await run(['status', 'mep'], {
    registry: { list: async () => [], get: async () => ({ name: 'mep' }) },
    hasProfileAuth: async () => true,
    print: (text) => output.push(text)
  });
  assert.deepEqual(output, ['mep: present']);
});
