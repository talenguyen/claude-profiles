const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { launchClaude } = require('../src/launcher.js');
const { run } = require('../src/commands.js');
const { materializeProfileConfig } = require('../src/config.js');
const { makeTempDir, removeTempDir, clearInheritedConfigEnv } = require('./helpers.js');

clearInheritedConfigEnv();

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

    const deps = await buildDependencies({ home: tempDir });
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
    const deps = await buildDependencies({ home: tempDir });
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

// ---- auto mode ----

const NOW = Date.parse('2026-11-13T10:00:00Z');
const HOUR = 3600_000;
const iso = (hours) => new Date(NOW + hours * HOUR).toISOString();

const rateLimits = (five, week, fiveResetH = 2, weekResetH = 48) => ({
  five_hour: { utilization: five, resets_at: iso(fiveResetH), locked_reason: null },
  seven_day: { utilization: week, resets_at: iso(weekResetH), locked_reason: null }
});

// Fresh `.claude.json` cache for a profile, so no probe is needed.
const cachedState = (limits, extra = {}) => ({
  oauthAccount: { accountUuid: 'u', ...extra },
  cachedUsageUtilization: { fetchedAtMs: NOW - 1000, accountUuid: 'u', utilization: limits }
});

function autoDeps(states, overrides = {}) {
  const launched = [];
  const errors = [];
  const out = [];
  const names = Object.keys(states);
  const deps = {
    registry: {
      list: async () => names.map((name) => ({ name, ...(overrides.tiers && overrides.tiers[name] ? { tier: overrides.tiers[name] } : {}) })),
      get: async (name) => ({ name })
    },
    resolveClaude: async () => '/fake/claude',
    materializeProfileConfig: async ({ profile }) => `/profiles/${profile}`,
    readProfileState: async (dir) => states[dir.split('/').pop()] ?? null,
    spawnProbe: () => { throw new Error('probe must not run in this test'); },
    launchClaude: (args) => launched.push(args),
    profilesConfigDir: '/profiles',
    configHome: '/cfg',
    env: { PATH: '/bin' },
    now: () => NOW,
    cwd: '/no/such/cwd',
    isTTY: false,
    print: (text) => out.push(text),
    printErr: (text) => errors.push(text),
    ...overrides.deps
  };
  return { deps, launched, errors, out };
}

const TIERS = { standard: 'team-standard', premium: 'team-premium' };

test('use --auto launches the profile with the most real capacity and forwards args', async () => {
  const { deps, launched, errors } = autoDeps({
    standard: cachedState(rateLimits(5, 5)),
    premium: cachedState(rateLimits(40, 40))
  }, { tiers: TIERS });
  await run(['use', '--auto', '--model', 'opus', 'hello'], deps);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].configDir, '/profiles/premium');
  assert.deepEqual(launched[0].args, ['--model', 'opus', 'hello']);
  assert.equal('token' in launched[0], false);
  assert.deepEqual(Object.keys(launched[0]).sort(), ['args', 'claudePath', 'configDir', 'env', 'execve']);
  const line = errors.find((text) => text.startsWith('auto: '));
  assert.match(line, /^auto: premium \(team-premium, 60% left, 5h resets \d\d:\d\d\)$/);
  assert.equal(errors.indexOf(line), errors.length - 1);
});

test('use --auto forwards every token after --auto and --force verbatim', async () => {
  const states = { a: cachedState(rateLimits(10, 10), { organizationType: 'claude_pro' }) };
  for (const [argv, expected] of [
    [['--auto', '--resume'], ['--resume']],
    [['--auto', '--force', '--continue', '--force'], ['--continue', '--force']],
    [['--force', '--auto', '--', '--resume', 'abc'], ['--resume', 'abc']],
    [['--auto', '-p', '--auto'], ['-p', '--auto']]
  ]) {
    const { deps, launched } = autoDeps(states, { deps: { cwd: '/no/such/cwd' } });
    await run(['use', ...argv], deps);
    assert.deepEqual(launched[0].args, expected);
  }
});

test('--force without --auto is a usage error and --auto after a profile is forwarded', async () => {
  const { deps, launched } = autoDeps({ a: cachedState(rateLimits(1, 1)) });
  await assert.rejects(run(['use', '--force', 'a'], deps), /--force requires --auto/);
  await run(['use', 'a', '--auto'], deps);
  assert.deepEqual(launched[0].args, ['--auto']);
});

test('use --auto drops unknown profiles with a warning and still launches another', async () => {
  const { deps, launched, errors } = autoDeps({
    broken: { oauthAccount: { accountUuid: 'u' } },
    ok: cachedState(rateLimits(50, 50), { organizationType: 'claude_pro' })
  }, { deps: { spawnProbe: () => { throw new Error('nope'); } } });
  await run(['use', '--auto'], deps);
  assert.equal(launched[0].configDir, '/profiles/ok');
  assert.ok(errors.some((text) => /broken: usage unknown \(could not start claude\); excluded/.test(text)));
  assert.ok(errors.some((text) => /broken: tier unknown.*claude-profiles tier broken <tier>/.test(text)));
});

test('use --auto fails clearly when no profile has readable usage, even with --force', async () => {
  const { deps, launched } = autoDeps({ a: null });
  await assert.rejects(run(['use', '--auto'], deps), /Cannot read usage for any profile/);
  await assert.rejects(run(['use', '--auto', '--force'], deps), /Cannot read usage for any profile/);
  assert.equal(launched.length, 0);
});

test('use --auto with no registered profiles asks to add one', async () => {
  const { deps } = autoDeps({});
  await assert.rejects(run(['use', '--auto'], deps), /add a profile first/);
});

const exhausted = () => ({
  slow: cachedState(rateLimits(100, 10, 4)),
  quick: cachedState(rateLimits(100, 10, 1))
});

test('all exhausted in a non-TTY names the earliest-freeing profile, exits 3 and never launches', async () => {
  const { deps, launched } = autoDeps(exhausted());
  await assert.rejects(run(['use', '--auto'], deps), (err) => {
    assert.match(err.message, /all profiles exhausted; quick frees at \d\d:\d\d \(in 1h 0m\)/);
    assert.equal(err.exitCode, 3);
    return true;
  });
  assert.equal(launched.length, 0);
});

test('all exhausted on a TTY prompts, and only a yes launches', async () => {
  const prompts = [];
  const answer = async (value, calls) => {
    const { deps, launched, errors } = autoDeps(exhausted(), { deps: { isTTY: true, confirm: async (text) => { calls.push(text); return value; } } });
    await run(['use', '--auto', '--resume'], deps);
    return { launched, errors };
  };
  const no = await answer('n', prompts);
  assert.equal(no.launched.length, 0);
  const yes = await answer('y', prompts);
  assert.equal(yes.launched[0].configDir, '/profiles/quick');
  assert.deepEqual(prompts, ['Launch quick anyway? [y/N] ', 'Launch quick anyway? [y/N] ']);
  assert.ok(yes.errors.some((text) => /all profiles exhausted; quick frees at/.test(text)));
});

test('--force launches the earliest-freeing profile without prompting', async () => {
  const { deps, launched, errors } = autoDeps(exhausted(), { deps: { confirm: async () => { throw new Error('must not prompt'); } } });
  await run(['use', '--auto', '--force', '--model', 'opus'], deps);
  assert.equal(launched[0].configDir, '/profiles/quick');
  assert.deepEqual(launched[0].args, ['--model', 'opus']);
  assert.ok(errors.some((text) => /^auto: quick \(unknown, forced\)$/.test(text)));
});

async function withSessions(setup) {
  const root = await makeTempDir('auto-sessions-');
  try {
    const { projectSlug } = require('../src/sessions.js');
    const cwd = path.join(root, 'work.dir');
    for (const [profile, id] of Object.entries(setup)) {
      const dir = path.join(root, 'profiles', profile, 'projects', projectSlug(cwd));
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, `${id}.jsonl`), '{}\n');
    }
    return { root, cwd };
  } catch (err) {
    await removeTempDir(root);
    throw err;
  }
}

test('auto resume repairs a missing shared link before selecting session owners', async () => {
  const root = await makeTempDir('auto-shared-sessions-');
  try {
    const cwd = path.join(root, 'work.dir');
    const profilesConfigDir = path.join(root, 'profiles');
    const baseConfigDir = path.join(root, 'base');
    const baseStateFile = path.join(baseConfigDir, '.claude.json');
    const sharedSessionsDir = path.join(root, 'shared');
    const sharedProfileDir = path.join(profilesConfigDir, 'shared');
    const privateProfileDir = path.join(profilesConfigDir, 'private');
    const { projectSlug } = require('../src/sessions.js');
    await fsp.mkdir(sharedProfileDir, { recursive: true });
    await fsp.mkdir(privateProfileDir, { recursive: true });
    await fsp.mkdir(baseConfigDir, { recursive: true });
    await fsp.writeFile(baseStateFile, '{}');
    const transcript = path.join(sharedSessionsDir, 'projects', projectSlug(cwd), 'sess-1.jsonl');
    await fsp.mkdir(path.dirname(transcript), { recursive: true });
    await fsp.writeFile(transcript, '{}\n');

    const { deps, launched } = autoDeps({
      shared: cachedState(rateLimits(80, 80)),
      private: cachedState(rateLimits(0, 0), { organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' })
    }, {
      deps: {
        profilesConfigDir,
        baseConfigDir,
        baseStateFile,
        cwd,
        sharedSessionsDir,
        registry: {
          list: async () => [{ name: 'shared', sessions: 'shared' }, { name: 'private', sessions: 'private' }],
          get: async (name) => ({ name })
        },
        materializeProfileConfig
      }
    });

    await run(['use', '--auto', '--resume', 'sess-1'], deps);
    assert.equal(launched[0].configDir, sharedProfileDir);
    assert.deepEqual(launched[0].args, ['--resume', 'sess-1']);
    assert.equal(await fsp.realpath(path.join(sharedProfileDir, 'projects')), await fsp.realpath(path.join(sharedSessionsDir, 'projects')));
  } finally {
    await removeTempDir(root);
  }
});

test('--resume <id> restricts the pick to the owning profile even when another has more capacity', async () => {
  const { root, cwd } = await withSessions({ small: 'sess-1' });
  try {
    const { deps, launched } = autoDeps({
      small: cachedState(rateLimits(80, 80)),
      big: cachedState(rateLimits(0, 0), { organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' })
    }, { deps: { profilesConfigDir: path.join(root, 'profiles'), cwd } });
    await run(['use', '--auto', '--resume', 'sess-1'], deps);
    assert.equal(launched[0].configDir, '/profiles/small');
    assert.deepEqual(launched[0].args, ['--resume', 'sess-1']);
  } finally {
    await removeTempDir(root);
  }
});

test('--continue picks the profile with the newest transcript for this directory', async () => {
  const { root, cwd } = await withSessions({ older: 'a1', newer: 'b1' });
  try {
    const { projectSlug } = require('../src/sessions.js');
    const file = (profile, id) => path.join(root, 'profiles', profile, 'projects', projectSlug(cwd), `${id}.jsonl`);
    await fsp.utimes(file('older', 'a1'), 1000, 1000);
    await fsp.utimes(file('newer', 'b1'), 2000, 2000);
    const { deps, launched } = autoDeps({
      older: cachedState(rateLimits(0, 0), { organizationType: 'claude_pro' }),
      newer: cachedState(rateLimits(90, 90), { organizationType: 'claude_pro' })
    }, { deps: { profilesConfigDir: path.join(root, 'profiles'), cwd } });
    await run(['use', '--auto', '--continue'], deps);
    assert.equal(launched[0].configDir, '/profiles/newer');
  } finally {
    await removeTempDir(root);
  }
});

test('--resume refuses an exhausted owner unless --force, and never switches profiles', async () => {
  const { root, cwd } = await withSessions({ owner: 'sess-9' });
  try {
    const states = {
      owner: cachedState(rateLimits(100, 10, 3), { organizationType: 'claude_pro' }),
      other: cachedState(rateLimits(0, 0), { organizationType: 'claude_pro' })
    };
    const base = { deps: { profilesConfigDir: path.join(root, 'profiles'), cwd } };
    const refused = autoDeps(states, base);
    await assert.rejects(run(['use', '--auto', '--resume', 'sess-9'], refused.deps), (err) => {
      assert.match(err.message, /Session belongs to owner, which is exhausted; frees at \d\d:\d\d \(in 3h 0m\)\. Use --force/);
      assert.equal(err.exitCode, 3);
      return true;
    });
    assert.equal(refused.launched.length, 0);

    const forced = autoDeps(states, base);
    await run(['use', '--auto', '--force', '--resume', 'sess-9'], forced.deps);
    assert.equal(forced.launched[0].configDir, '/profiles/owner');
  } finally {
    await removeTempDir(root);
  }
});

test('--resume with an owner whose usage is unknown refuses unless --force', async () => {
  const { root, cwd } = await withSessions({ owner: 'sess-7' });
  try {
    const states = { owner: { oauthAccount: { accountUuid: 'u' } }, other: cachedState(rateLimits(0, 0), { organizationType: 'claude_pro' }) };
    const base = { deps: { profilesConfigDir: path.join(root, 'profiles'), cwd, spawnProbe: () => { throw new Error('x'); } } };
    await assert.rejects(run(['use', '--auto', '--resume', 'sess-7'], autoDeps(states, base).deps), /usage is unknown/);
    const forced = autoDeps(states, base);
    await run(['use', '--auto', '--force', '--resume', 'sess-7'], forced.deps);
    assert.equal(forced.launched[0].configDir, '/profiles/owner');
  } finally {
    await removeTempDir(root);
  }
});

test('--resume <id> owned by nobody falls back to the normal pick with a warning', async () => {
  const { deps, launched, errors } = autoDeps({ a: cachedState(rateLimits(10, 10), { organizationType: 'claude_pro' }) });
  await run(['use', '--auto', '--resume', 'ghost-id'], deps);
  assert.equal(launched[0].configDir, '/profiles/a');
  assert.ok(errors.some((text) => /no profile owns session ghost-id/.test(text)));
});

test('bare --resume warns that the picker only shows the chosen profile sessions', async () => {
  const { deps, launched, errors } = autoDeps({ a: cachedState(rateLimits(10, 10), { organizationType: 'claude_pro' }) });
  await run(['use', '--auto', '--resume'], deps);
  assert.deepEqual(launched[0].args, ['--resume']);
  assert.ok(errors.some((text) => /--resume picker will show only a's sessions/.test(text)));
});

test('use --auto probes with the profile config and a fixed cwd when the cache is stale', async () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const calls = [];
  const spawnProbe = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => true;
    child.stdin.on('data', (chunk) => {
      const { request_id } = JSON.parse(String(chunk));
      child.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id, response: { subscription_type: 'pro', rate_limits: rateLimits(20, 20) } } })}\n`);
    });
    return child;
  };
  const { deps, launched } = autoDeps({ a: { oauthAccount: { accountUuid: 'u', organizationType: 'claude_pro' } } }, { deps: { spawnProbe } });
  await run(['use', '--auto'], deps);
  assert.equal(launched[0].configDir, '/profiles/a');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cwd, '/cfg');
  assert.equal(calls[0].options.env.CLAUDE_CONFIG_DIR, '/profiles/a');
});

test('usage prints a table and marks the best profile without launching', async () => {
  const { deps, launched, out } = autoDeps({
    standard: cachedState(rateLimits(5, 5)),
    premium: cachedState(rateLimits(40, 40)),
    spent: cachedState(rateLimits(10, 100, 2, 30)),
    broken: null
  }, { tiers: { ...TIERS, spent: 'max5x', broken: 'pro' } });
  await run(['usage'], deps);
  assert.equal(launched.length, 0);
  assert.match(out[0], /^PROFILE\s+TIER\s+5H\s+WEEK\s+RESETS\s+CAPACITY\s+STATUS$/);
  const row = (name) => out.find((line) => line.startsWith(name));
  assert.match(row('premium'), /team-premium \(registry\)\s+40%\s+40%\s+\S+\s+3\.75\s+best$/);
  assert.match(row('standard'), /team-standard \(registry\)\s+5%\s+5%\s+\S+\s+1\.19\s+ok$/);
  assert.match(row('spent'), /max5x \(registry\)\s+10%\s+100%\s+.*0\.00\s+exhausted$/);
  assert.match(row('broken'), /unknown: not signed in/);
});

test('usage shows unknown when an exhausted window has no reset time', async () => {
  const { deps, out } = autoDeps({
    locked: cachedState({
      five_hour: { utilization: 0, locked_reason: 'overage' },
      seven_day: { utilization: 10, resets_at: iso(48), locked_reason: null }
    })
  });
  await run(['usage'], deps);
  const row = out.find((line) => line.startsWith('locked'));
  assert.deepEqual(row.trim().split(/\s{2,}/), ['locked', 'unknown (default)', '0%', '10%', 'unknown', '0.00', 'exhausted']);
});

test('usage --json is machine readable and carries no credentials', async () => {
  const { deps, out } = autoDeps({
    a: cachedState(rateLimits(25, 50), { organizationType: 'claude_pro', email: 'someone@example.test', accessToken: 'sk-ant-SECRET' })
  });
  await run(['usage', '--json'], deps);
  const parsed = JSON.parse(out.join('\n'));
  assert.equal(parsed.best, 'a');
  assert.deepEqual(parsed.profiles[0], {
    name: 'a', tier: 'pro', tierSource: 'detected', weight: 1, status: 'ok', capacity: 0.5,
    fiveHour: { used: 25, resetsAt: iso(2) }, weekly: { used: 50, resetsAt: iso(48) },
    availableAt: null, source: 'cache', error: null
  });
  assert.doesNotMatch(out.join('\n'), /SECRET|someone@example/);
  await assert.rejects(run(['usage', '--bogus'], deps), /Usage: usage \[--json\]/);
});

test('usage with no profiles asks to add one', async () => {
  await assert.rejects(run(['usage'], autoDeps({}).deps), /add a profile first/);
});

test('tier sets a validated tier on an existing profile', async () => {
  const set = [];
  const deps = { registry: { get: async (name) => ({ name }), setTier: async (...args) => set.push(args) } };
  await run(['tier', 'mep', 'Team-Premium'], deps);
  assert.deepEqual(set, [['mep', 'team-premium']]);
  await assert.rejects(run(['tier', 'mep', 'gold'], deps), /Invalid tier/);
  await assert.rejects(run(['tier', 'mep'], deps), /Usage: tier <profile> <tier>/);
  assert.equal(set.length, 1);
});

test('add --tier validates before signing in and stores the tier', async () => {
  const added = [];
  const events = [];
  const deps = {
    registry: { get: async () => { throw new Error('Profile not found.'); }, add: async (...args) => added.push(args) },
    resolveClaude: async () => '/fake/claude',
    materializeProfileConfig: async () => '/profiles/mep',
    authenticateProfile: async () => events.push('auth'),
    env: { PATH: '/bin' }
  };
  await run(['add', 'mep', '--tier', 'max20x'], deps);
  await run(['add', '--tier=pro', 'other'], deps);
  assert.deepEqual(added, [['mep', { tier: 'max20x' }], ['other', { tier: 'pro' }]]);
  await assert.rejects(run(['add', 'bad', '--tier', 'gold'], deps), /Invalid tier/);
  await assert.rejects(run(['add', 'bad', '--tier'], deps), /Usage: add/);
  await assert.rejects(run(['add', 'bad', '--wat'], deps), /unknown option/);
  assert.equal(events.length, 2);
});

test('help documents auto mode, usage, tier and the exit status', async () => {
  const output = [];
  await run(['help'], { print: (text) => output.push(text) });
  const text = output.join('\n');
  for (const needle of [/use --auto \[--force\]/, /usage \[--json\]/, /tier <profile> <tier>/, /add <profile> \[--tier <tier>\]/, /status 3/, /experimental/]) {
    assert.match(text, needle);
  }
});

// ---- shared session history ----

const { projectSlug } = require('../src/sessions.js');

// Real temp dirs: profiles in `sharedNames` link `projects` to one shared folder,
// the others keep a private one. `transcripts` maps a place (`shared` or a
// profile name) to the session files to create there, as { id: [rows] }.
async function withSharedSessions({ sharedNames, privateNames = [], transcripts }) {
  const root = await makeTempDir('auto-shared-');
  const cwd = path.join(root, 'work.dir');
  const slug = projectSlug(cwd);
  const sharedSessionsDir = path.join(root, 'shared');
  const profilesConfigDir = path.join(root, 'profiles');
  await fsp.mkdir(path.join(sharedSessionsDir, 'projects'), { recursive: true });
  for (const name of sharedNames) {
    await fsp.mkdir(path.join(profilesConfigDir, name), { recursive: true });
    await fsp.symlink(path.join(sharedSessionsDir, 'projects'), path.join(profilesConfigDir, name, 'projects'));
  }
  for (const name of privateNames) await fsp.mkdir(path.join(profilesConfigDir, name, 'projects'), { recursive: true });
  const place = (where) => (where === 'shared' ? path.join(sharedSessionsDir, 'projects') : path.join(profilesConfigDir, where, 'projects'));
  for (const [where, files] of Object.entries(transcripts || {})) {
    await fsp.mkdir(path.join(place(where), slug), { recursive: true });
    for (const [id, rows] of Object.entries(files)) {
      await fsp.writeFile(path.join(place(where), slug, `${id}.jsonl`), `${(rows || ['{}']).join('\n')}\n`);
    }
  }
  return { root, cwd, sharedSessionsDir, profilesConfigDir, base: { deps: { profilesConfigDir, sharedSessionsDir, cwd } } };
}

const ORG_WORK = '93cd1d00-0000-4000-8000-00000000aaaa';
const ORG_PERSONAL = 'a0464300-0000-4000-8000-00000000bbbb';
const orgRows = (org) => [JSON.stringify({ type: 'session-owner', accountUuid: 'u', organizationUuid: org, sessionId: 's' }), JSON.stringify({ type: 'user', message: 'hi' })];
const pro = (five, week, extra = {}) => cachedState(rateLimits(five, week), { organizationType: 'claude_pro', ...extra });

test('--continue on shared history picks the profile with the most capacity, not the first', async () => {
  const sb = await withSharedSessions({ sharedNames: ['first', 'second'], transcripts: { shared: { s1: null } } });
  try {
    const { deps, launched, errors } = autoDeps({ first: pro(80, 80), second: pro(10, 10) }, sb.base);
    await run(['use', '--auto', '--continue'], deps);
    assert.equal(launched[0].configDir, '/profiles/second');
    assert.deepEqual(launched[0].args, ['--continue']);
    assert.equal(errors.some((text) => /Session belongs/.test(text)), false);
  } finally {
    await removeTempDir(sb.root);
  }
});

test('--resume <id> on shared history is not pinned to an exhausted profile', async () => {
  const sb = await withSharedSessions({ sharedNames: ['a', 'b'], transcripts: { shared: { 'sess-1': null } } });
  try {
    const { deps, launched } = autoDeps({ a: cachedState(rateLimits(100, 10, 3), { organizationType: 'claude_pro' }), b: pro(20, 20) }, sb.base);
    await run(['use', '--auto', '--resume', 'sess-1'], deps);
    assert.equal(launched[0].configDir, '/profiles/b');
    assert.deepEqual(launched[0].args, ['--resume', 'sess-1']);
  } finally {
    await removeTempDir(sb.root);
  }
});

test('when every shared profile is exhausted the normal all-exhausted path applies', async () => {
  const sb = await withSharedSessions({ sharedNames: ['slow', 'quick'], transcripts: { shared: { 'sess-1': null } } });
  try {
    const states = { slow: cachedState(rateLimits(100, 10, 4), { organizationType: 'claude_pro' }), quick: cachedState(rateLimits(100, 10, 1), { organizationType: 'claude_pro' }) };
    await assert.rejects(run(['use', '--auto', '--resume', 'sess-1'], autoDeps(states, sb.base).deps), (err) => {
      assert.match(err.message, /^all profiles exhausted; quick frees at/);
      assert.equal(err.exitCode, 3);
      return true;
    });
  } finally {
    await removeTempDir(sb.root);
  }
});

test('a partially shared registry still restricts to the profiles that can see the session', async () => {
  const sb = await withSharedSessions({ sharedNames: ['a', 'b'], privateNames: ['c'], transcripts: { shared: { 'sess-1': null } } });
  try {
    const states = { a: pro(70, 70), b: pro(30, 30), c: pro(0, 0) };
    const { deps, launched } = autoDeps(states, sb.base);
    await run(['use', '--auto', '--resume', 'sess-1'], deps);
    assert.equal(launched[0].configDir, '/profiles/b', 'c has the most capacity but cannot see the session');

    const spent = { a: cachedState(rateLimits(100, 10, 3), { organizationType: 'claude_pro' }), b: cachedState(rateLimits(100, 10, 1), { organizationType: 'claude_pro' }), c: pro(0, 0) };
    await assert.rejects(run(['use', '--auto', '--resume', 'sess-1'], autoDeps(spent, sb.base).deps), (err) => {
      assert.match(err.message, /Session belongs to a, b, which are all exhausted; b frees at \d\d:\d\d \(in 1h 0m\)\. Use --force/);
      assert.equal(err.exitCode, 3);
      return true;
    });
    const forced = autoDeps(spent, sb.base);
    await run(['use', '--auto', '--force', '--resume', 'sess-1'], forced.deps);
    assert.equal(forced.launched[0].configDir, '/profiles/b');
  } finally {
    await removeTempDir(sb.root);
  }
});

test('a session id nobody has still falls back to the normal pick with a warning on shared history', async () => {
  const sb = await withSharedSessions({ sharedNames: ['a', 'b'], transcripts: { shared: {} } });
  try {
    const { deps, launched, errors } = autoDeps({ a: pro(50, 50), b: pro(5, 5) }, sb.base);
    await run(['use', '--auto', '--resume', 'ghost-id'], deps);
    assert.equal(launched[0].configDir, '/profiles/b');
    assert.ok(errors.some((text) => /no profile owns session ghost-id/.test(text)));
  } finally {
    await removeTempDir(sb.root);
  }
});

test('the bare --resume picker warning is suppressed for a shared profile and kept for a private one', async () => {
  const sb = await withSharedSessions({ sharedNames: ['shared'], privateNames: ['solo'] });
  try {
    const shared = autoDeps({ shared: pro(1, 1), solo: pro(90, 90) }, sb.base);
    await run(['use', '--auto', '--resume'], shared.deps);
    assert.equal(shared.launched[0].configDir, '/profiles/shared');
    assert.equal(shared.errors.some((text) => /picker/.test(text)), false);

    const solo = autoDeps({ shared: pro(90, 90), solo: pro(1, 1) }, sb.base);
    await run(['use', '--auto', '--resume'], solo.deps);
    assert.equal(solo.launched[0].configDir, '/profiles/solo');
    assert.ok(solo.errors.some((text) => /--resume picker will show only solo's sessions/.test(text)));
  } finally {
    await removeTempDir(sb.root);
  }
});

// ---- --fork ----

const forkSetup = (rows = orgRows(ORG_WORK)) => withSharedSessions({ sharedNames: ['work', 'personal'], transcripts: { shared: { 'sess-1': rows } } });
const orgStates = (work, personal) => ({
  work: cachedState(rateLimits(...work), { organizationType: 'claude_team', organizationUuid: ORG_WORK }),
  personal: cachedState(rateLimits(...personal), { organizationType: 'claude_max', organizationUuid: ORG_PERSONAL })
});

test('switching a session to a profile on another organization adds --fork-session and says so', async () => {
  const sb = await forkSetup();
  try {
    const { deps, launched, errors } = autoDeps(orgStates([100, 10, 3], [10, 10]), sb.base);
    await run(['use', '--auto', '--resume', 'sess-1', '--model', 'opus'], deps);
    assert.equal(launched[0].configDir, '/profiles/personal');
    assert.deepEqual(launched[0].args, ['--resume', 'sess-1', '--model', 'opus', '--fork-session']);
    const notice = errors.filter((text) => text.startsWith('auto: '));
    assert.equal(notice.length, 1);
    assert.match(notice[0], /^auto: personal \(.*\); adding --fork-session: this session last ran on a different organization \(--no-fork to keep it as is\)$/);
    assert.equal(errors.indexOf(notice[0]), errors.length - 1);
    // No organization id, account id or email may ever be printed.
    assert.doesNotMatch(errors.join('\n'), new RegExp(`${ORG_WORK}|${ORG_PERSONAL}|93cd1d|a04643`));
  } finally {
    await removeTempDir(sb.root);
  }
});

test('--continue also forks when the newest transcript last ran on another organization', async () => {
  const sb = await forkSetup(orgRows(ORG_WORK));
  try {
    const { deps, launched } = autoDeps(orgStates([100, 10, 3], [10, 10]), sb.base);
    await run(['use', '--auto', '--continue'], deps);
    assert.deepEqual(launched[0].args, ['--continue', '--fork-session']);
  } finally {
    await removeTempDir(sb.root);
  }
});

test('--no-fork opts out and is not forwarded to Claude', async () => {
  const sb = await forkSetup();
  try {
    for (const argv of [['--auto', '--no-fork', '--resume', 'sess-1'], ['--no-fork', '--auto', '--resume', 'sess-1']]) {
      const { deps, launched, errors } = autoDeps(orgStates([100, 10, 3], [10, 10]), sb.base);
      await run(['use', ...argv], deps);
      assert.equal(launched[0].configDir, '/profiles/personal');
      assert.deepEqual(launched[0].args, ['--resume', 'sess-1']);
      assert.equal(errors.some((text) => /fork/.test(text)), false);
    }
    const { deps } = autoDeps(orgStates([0, 0], [0, 0]), sb.base);
    await assert.rejects(run(['use', '--no-fork', 'work'], deps), /--no-fork requires --auto/);
  } finally {
    await removeTempDir(sb.root);
  }
});

test('no fork when the organization is the same, unknown, or the flag is already present', async () => {
  const same = await forkSetup(orgRows(ORG_PERSONAL));
  const noRows = await forkSetup(['{}']);
  const sb = await forkSetup();
  try {
    let ctx = autoDeps(orgStates([100, 10, 3], [10, 10]), same.base);
    await run(['use', '--auto', '--resume', 'sess-1'], ctx.deps);
    assert.deepEqual(ctx.launched[0].args, ['--resume', 'sess-1']);

    ctx = autoDeps(orgStates([100, 10, 3], [10, 10]), noRows.base);
    await run(['use', '--auto', '--resume', 'sess-1'], ctx.deps);
    assert.deepEqual(ctx.launched[0].args, ['--resume', 'sess-1'], 'unknown session organization');

    const unknownProfile = orgStates([100, 10, 3], [10, 10]);
    unknownProfile.personal = cachedState(rateLimits(10, 10), { organizationType: 'claude_max' });
    ctx = autoDeps(unknownProfile, sb.base);
    await run(['use', '--auto', '--resume', 'sess-1'], ctx.deps);
    assert.deepEqual(ctx.launched[0].args, ['--resume', 'sess-1'], 'unknown profile organization');

    ctx = autoDeps(orgStates([100, 10, 3], [10, 10]), sb.base);
    await run(['use', '--auto', '--resume', 'sess-1', '--fork-session'], ctx.deps);
    assert.deepEqual(ctx.launched[0].args, ['--resume', 'sess-1', '--fork-session']);

    ctx = autoDeps(orgStates([100, 10, 3], [10, 10]), sb.base);
    await run(['use', '--auto', '--resume'], ctx.deps);
    assert.deepEqual(ctx.launched[0].args, ['--resume'], 'the picker is never forked');
  } finally {
    await Promise.all([same, noRows, sb].map((entry) => removeTempDir(entry.root)));
  }
});

test('staying on the profile that last ran the session does not fork', async () => {
  const sb = await forkSetup();
  try {
    const { deps, launched, errors } = autoDeps(orgStates([10, 10], [100, 10, 3]), sb.base);
    await run(['use', '--auto', '--continue'], deps);
    assert.equal(launched[0].configDir, '/profiles/work');
    assert.deepEqual(launched[0].args, ['--continue']);
    assert.equal(errors.some((text) => /fork/.test(text)), false);
  } finally {
    await removeTempDir(sb.root);
  }
});

// ---- wiring ----

test('use and refresh materialise a shared profile with its shared folder; add and private profiles do not share', async () => {
  const calls = [];
  const deps = {
    registry: {
      get: async (name) => ({ name, sessions: name === 'a' ? 'shared' : 'private' }),
      add: async () => {}
    },
    resolveClaude: async () => '/fake/claude',
    materializeProfileConfig: async (args) => { calls.push(args); return `/profiles/${args.profile}`; },
    authenticateProfile: async () => {},
    launchClaude: () => {},
    sharedSessionsDir: '/shared',
    printErr: () => {},
    env: { PATH: '/bin' }
  };
  await run(['use', 'a'], deps);
  await run(['use', 'b'], deps);
  await run(['refresh', 'a'], deps);
  deps.registry.get = async () => { throw new Error('Profile not found.'); };
  await run(['add', 'c'], deps);
  assert.deepEqual(calls.map((call) => [call.profile, call.sessions, call.sharedSessionsDir]), [
    ['a', 'shared', '/shared'], ['b', 'private', '/shared'], ['a', 'shared', '/shared'], ['c', 'private', '/shared']
  ]);
  assert.equal(typeof calls[0].warn, 'function');
});

test('use --auto passes the chosen profile its sessions mode', async () => {
  const { deps, launched } = autoDeps({ a: pro(10, 10) });
  const seen = [];
  deps.registry.list = async () => [{ name: 'a', sessions: 'shared' }];
  deps.materializeProfileConfig = async (args) => { seen.push(args.sessions); return '/profiles/a'; };
  await run(['use', '--auto'], deps);
  assert.deepEqual(seen, ['shared']);
  assert.equal(launched.length, 1);
});

test('remove of one shared profile deletes its links, not the shared sessions the other profile still sees', async () => {
  const { createRegistry } = require('../src/registry.js');
  const { removeProfileConfig } = require('../src/config.js');
  const root = await makeTempDir('remove-shared-');
  try {
    const profilesConfigDir = path.join(root, 'profiles');
    const sharedSessionsDir = path.join(root, 'shared');
    const registry = createRegistry({ configHome: path.join(root, 'home') });
    for (const name of ['a', 'b']) {
      await registry.add(name);
      await fsp.mkdir(path.join(profilesConfigDir, name), { recursive: true });
    }
    const deps = { registry, profilesConfigDir, sharedSessionsDir, isAlive: () => false, print: () => {} };
    await run(['share-sessions', 'a', 'b'], deps);

    // A session written into the shared folder after sharing.
    const transcript = path.join(sharedSessionsDir, 'projects', '-work-demo', 'sess-1.jsonl');
    const history = path.join(sharedSessionsDir, 'file-history', 'sess-1', 'v1');
    await fsp.mkdir(path.dirname(transcript), { recursive: true });
    await fsp.writeFile(transcript, '{"type":"user"}\n');
    await fsp.mkdir(path.dirname(history), { recursive: true });
    await fsp.writeFile(history, 'edit');

    const loggedOut = [];
    await run(['remove', 'a'], {
      ...deps,
      confirm: async () => 'a',
      resolveClaude: async () => '/usr/bin/true',
      env: {},
      logoutProfile: async ({ configDir }) => loggedOut.push(configDir),
      removeProfileConfig
    });

    assert.deepEqual(loggedOut, [path.join(profilesConfigDir, 'a')]);
    await assert.rejects(fsp.lstat(path.join(profilesConfigDir, 'a')));
    assert.deepEqual((await registry.list()).map((profile) => profile.name), ['b']);
    assert.equal(await fsp.readFile(transcript, 'utf8'), '{"type":"user"}\n');
    assert.equal(await fsp.readFile(history, 'utf8'), 'edit');

    const bProjects = path.join(profilesConfigDir, 'b', 'projects');
    assert.equal((await fsp.lstat(bProjects)).isSymbolicLink(), true);
    assert.equal(await fsp.realpath(bProjects), await fsp.realpath(path.join(sharedSessionsDir, 'projects')));
    assert.equal(await fsp.readFile(path.join(bProjects, '-work-demo', 'sess-1.jsonl'), 'utf8'), '{"type":"user"}\n');
  } finally {
    await removeTempDir(root);
  }
});

test('help documents share-sessions and --no-fork', async () => {
  const output = [];
  await run(['help'], { print: (text) => output.push(text) });
  const text = output.join('\n');
  for (const needle of [/share-sessions \[--dry-run\] \[--rollback\] \[<profile>\.\.\.\]/, /use --auto \[--force\] \[--no-fork\]/, /--fork-session/]) {
    assert.match(text, needle);
  }
});
