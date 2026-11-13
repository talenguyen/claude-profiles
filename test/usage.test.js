const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { normalizeUsage, readCachedUsage, probeUsage, collectUsage, PROBE_ARGS } = require('../src/usage.js');
const { clearInheritedConfigEnv } = require('./helpers.js');

clearInheritedConfigEnv();

const NOW = Date.parse('2026-11-13T10:00:00Z');
const RESET5 = '2026-11-13T12:00:00+00:00';
const RESET7 = '2026-11-19T05:00:00+00:00';

// Shape observed from Claude Code 2.1.323 `get_usage` (values are fixtures).
const payload = (overrides = {}) => ({
  session: { total_cost_usd: 0 },
  subscription_type: 'team',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 11, resets_at: RESET5, locked_reason: null },
    seven_day: { utilization: 7, resets_at: RESET7, locked_reason: null },
    limits: [
      { kind: 'session', percent: 11, severity: 'normal', is_active: true },
      { kind: 'weekly_all', percent: 7 },
      { kind: 'weekly_scoped', percent: 2, scope: { model: { display_name: 'Fable' } } }
    ]
  },
  ...overrides
});

// A fake claude child: parses the request from stdin and replies on stdout.
function fakeSpawn({ lines = (id) => [], exitCode, hang = false } = {}) {
  const calls = [];
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.killed = [];
    child.kill = (signal) => { child.killed.push(signal); return true; };
    calls.push({ file, args, options, child });
    let input = '';
    child.stdin.on('data', (chunk) => {
      input += chunk;
      if (!input.includes('\n') || hang) return;
      const request = JSON.parse(input);
      for (const line of lines(request.request_id)) child.stdout.write(`${line}\n`);
      if (exitCode !== undefined) setImmediate(() => child.emit('exit', exitCode));
    });
    return child;
  };
  return { spawn, calls };
}

const success = (response) => (id) => [
  '{"type":"system","subtype":"hook_started","hook":"SessionStart"}',
  'plain non-json noise from a hook',
  JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'someone-else', response: {} } }),
  JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
];

const probeDeps = (spawn, extra = {}) => ({
  claudePath: '/fake/claude', configDir: '/profiles/tech', cwd: '/cfg', spawn, timeoutMs: 1000,
  env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-secret', ANTHROPIC_AUTH_TOKEN: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'secret', ANTHROPIC_BASE_URL: 'http://x', CLAUDE_CONFIG_DIR: '/inherited' },
  ...extra
});

test('normalizeUsage reads the primary windows, resets and subscription type', () => {
  const usage = normalizeUsage(payload());
  assert.deepEqual(usage, {
    fiveHour: { used: 11, resetsAt: Date.parse(RESET5), locked: false, critical: false },
    weekly: { used: 7, resetsAt: Date.parse(RESET7), locked: false, critical: false },
    subscriptionType: 'team'
  });
});

test('normalizeUsage falls back to limits[] and flags locked or critical windows', () => {
  const fallback = normalizeUsage({ rate_limits: { limits: [
    { kind: 'session', percent: 40, resets_at: RESET5 },
    { kind: 'weekly_all', percent: 100, severity: 'critical', resets_at: RESET7 }
  ] } });
  assert.equal(fallback.fiveHour.used, 40);
  assert.equal(fallback.weekly.critical, true);
  const locked = normalizeUsage(payload({ rate_limits: { five_hour: { utilization: 5, locked_reason: 'overage' } } }));
  assert.equal(locked.fiveHour.locked, true);
  assert.equal(locked.weekly, null);
});

test('normalizeUsage accepts the cached shape without a rate_limits wrapper', () => {
  const usage = normalizeUsage({ five_hour: { utilization: 3, resets_at: RESET5 }, seven_day: { utilization: 150 } });
  assert.equal(usage.weekly.used, 100);
});

test('normalizeUsage returns null for anything it cannot use', () => {
  for (const bad of [null, undefined, 'x', [], {}, { rate_limits: {} }, payload({ rate_limits_available: false }),
    { rate_limits: { five_hour: { utilization: 'high' }, seven_day: { utilization: null } } },
    { rate_limits: { five_hour: 'oops', limits: 'nope' } }]) {
    assert.equal(normalizeUsage(bad), null);
  }
});

test('the cache is used only when fresh and for the same account', () => {
  const state = (overrides = {}) => ({
    oauthAccount: { accountUuid: 'acct-1' },
    cachedUsageUtilization: { fetchedAtMs: NOW - 30_000, accountUuid: 'acct-1', utilization: payload().rate_limits },
    ...overrides
  });
  assert.equal(readCachedUsage(state(), { now: NOW }).fiveHour.used, 11);
  assert.equal(readCachedUsage(state({ oauthAccount: { accountUuid: 'acct-2' } }), { now: NOW }), null);
  assert.equal(readCachedUsage(state({ oauthAccount: {} }), { now: NOW }), null);
  const old = state(); old.cachedUsageUtilization.fetchedAtMs = NOW - 61_000;
  assert.equal(readCachedUsage(old, { now: NOW }), null);
  const future = state(); future.cachedUsageUtilization.fetchedAtMs = NOW + 5_000;
  assert.equal(readCachedUsage(future, { now: NOW }), null);
  assert.equal(readCachedUsage(null, { now: NOW }), null);
  assert.equal(readCachedUsage({ oauthAccount: { accountUuid: 'a' } }, { now: NOW }), null);
});

test('probeUsage sends get_usage, skips hook noise and returns normalized usage', async () => {
  const { spawn, calls } = fakeSpawn({ lines: success(payload()) });
  const usage = await probeUsage(probeDeps(spawn));
  assert.equal(usage.fiveHour.used, 11);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/fake/claude');
  assert.deepEqual(calls[0].args, PROBE_ARGS);
  assert.ok(calls[0].args.includes('--safe-mode'));
  assert.ok(!calls[0].args.includes('--bare'));
  assert.equal(calls[0].options.cwd, '/cfg');
  assert.deepEqual(calls[0].child.killed, ['SIGTERM']);
});

test('probeUsage env has competing auth stripped and only CLAUDE_CONFIG_DIR set', async () => {
  const { spawn, calls } = fakeSpawn({ lines: success(payload()) });
  await probeUsage(probeDeps(spawn));
  assert.deepEqual(calls[0].options.env, { PATH: '/bin', CLAUDE_CONFIG_DIR: '/profiles/tech' });
  assert.equal('token' in calls[0].options, false);
});

test('probeUsage rejects on an error response without echoing child output', async () => {
  const lines = (id) => [JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'sk-ant-SECRET-LEAK' } })];
  const { spawn } = fakeSpawn({ lines });
  await assert.rejects(probeUsage(probeDeps(spawn)), (err) => {
    assert.match(err.message, /error response/);
    assert.doesNotMatch(err.message, /SECRET/);
    return true;
  });
});

test('probeUsage rejects when usage is missing or in an unknown format', async () => {
  const { spawn } = fakeSpawn({ lines: success({ rate_limits_available: false }) });
  await assert.rejects(probeUsage(probeDeps(spawn)), /unavailable or in an unknown format/);
});

test('probeUsage times out, kills the child and rejects', async () => {
  const { spawn, calls } = fakeSpawn({ hang: true });
  await assert.rejects(probeUsage(probeDeps(spawn, { timeoutMs: 20 })), /timed out/);
  assert.deepEqual(calls[0].child.killed, ['SIGTERM']);
});

test('probeUsage rejects when the child exits early or cannot start', async () => {
  const early = fakeSpawn({ exitCode: 2 });
  await assert.rejects(probeUsage(probeDeps(early.spawn)), /exited early \(code 2\)/);
  await assert.rejects(probeUsage(probeDeps(() => { throw new Error('ENOENT /secret/path'); })), (err) => {
    assert.equal(err.message, 'could not start claude');
    return true;
  });
  const errored = (file, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => true;
    setImmediate(() => child.emit('error', new Error('boom')));
    return child;
  };
  await assert.rejects(probeUsage(probeDeps(errored)), /could not run claude/);
});

test('probeUsage never writes child output to the terminal', async () => {
  const written = [];
  const out = process.stdout.write; const err = process.stderr.write;
  process.stdout.write = (chunk, ...rest) => { written.push(String(chunk)); return true; };
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return true; };
  try {
    const { spawn } = fakeSpawn({ lines: (id) => ['LEAKY-LINE-sk-ant-123', ...success(payload())(id)] });
    await probeUsage(probeDeps(spawn));
  } finally {
    process.stdout.write = out; process.stderr.write = err;
  }
  assert.equal(written.join('').includes('LEAKY-LINE'), false);
});

test('collectUsage prefers the fresh cache, probes otherwise, and isolates failures', async () => {
  const states = {
    cached: { oauthAccount: { accountUuid: 'u', organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_5x' }, cachedUsageUtilization: { fetchedAtMs: NOW - 1000, accountUuid: 'u', utilization: payload().rate_limits } },
    stale: { oauthAccount: { accountUuid: 'u' } },
    failing: { oauthAccount: { accountUuid: 'u' } },
    signedout: { oauthAccount: undefined }
  };
  const probed = [];
  const spawnProbe = (file, args, options) => {
    probed.push(options.env.CLAUDE_CONFIG_DIR);
    return fakeSpawn({ lines: options.env.CLAUDE_CONFIG_DIR.endsWith('failing') ? () => [] : success(payload()), exitCode: options.env.CLAUDE_CONFIG_DIR.endsWith('failing') ? 1 : undefined }).spawn(file, args, options);
  };
  const result = await collectUsage({
    profiles: [{ name: 'cached' }, { name: 'stale', tier: 'team-standard' }, { name: 'failing' }, { name: 'signedout' }, { name: 'missing' }],
    claudePath: '/fake/claude', env: { PATH: '/bin' }, cwd: '/cfg', profilesConfigDir: '/profiles',
    readProfileState: async (dir) => states[dir.split('/').pop()] ?? null,
    spawnProbe, now: NOW, timeoutMs: 500
  });
  const by = Object.fromEntries(result.map((r) => [r.name, r]));
  assert.equal(by.cached.source, 'cache');
  assert.equal(by.cached.tier, 'max5x');
  assert.equal(by.stale.source, 'probe');
  assert.deepEqual([by.stale.tier, by.stale.tierSource, by.stale.weight], ['team-standard', 'registry', 1.25]);
  assert.equal(by.failing.usage, null);
  assert.match(by.failing.error, /exited early/);
  assert.match(by.signedout.error, /refresh signedout/);
  assert.match(by.missing.error, /not signed in/);
  assert.deepEqual(probed.sort(), ['/profiles/failing', '/profiles/stale']);
  assert.match(by.failing.tierWarning, /tier failing <tier>/);
});
