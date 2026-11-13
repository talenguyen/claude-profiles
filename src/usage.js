const crypto = require('node:crypto');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { sanitizeEnvironment } = require('./environment.js');
const { resolveTier } = require('./tier.js');

const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;

const PROBE_ARGS = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--no-session-persistence',
  '--safe-mode'
];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function toPercent(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
}

function toMs(value) {
  if (value == null) return null;
  const ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function buildWindow(win, limit) {
  const used = toPercent(win && win.utilization) ?? toPercent(limit && limit.percent);
  if (used === null) return null;
  return {
    used,
    resetsAt: toMs((win && win.resets_at) ?? (limit && limit.resets_at)),
    locked: Boolean(win && win.locked_reason),
    critical: Boolean(limit && limit.severity === 'critical' && limit.percent >= 100)
  };
}

/**
 * Normalize a `get_usage` payload (or the CLI's cached copy of it). The API is
 * experimental, so this parses defensively and returns null, meaning "usage
 * unknown", whenever it cannot find a usable window. Only whitelisted numeric
 * and date fields are read.
 *
 * @param {unknown} raw
 * @returns {{ fiveHour: object | null, weekly: object | null, subscriptionType?: string } | null}
 */
function normalizeUsage(raw) {
  if (!isObject(raw) || raw.rate_limits_available === false) return null;
  const root = isObject(raw.rate_limits) ? raw.rate_limits : raw;
  const limits = Array.isArray(root.limits) ? root.limits.filter(isObject) : [];
  const byKind = (kind) => limits.find((limit) => limit.kind === kind);
  const fiveHour = buildWindow(isObject(root.five_hour) ? root.five_hour : null, byKind('session'));
  const weekly = buildWindow(isObject(root.seven_day) ? root.seven_day : null, byKind('weekly_all'));
  if (!fiveHour && !weekly) return null;
  const usage = { fiveHour, weekly };
  if (typeof raw.subscription_type === 'string') usage.subscriptionType = raw.subscription_type;
  return usage;
}

/**
 * Read the profile's `cachedUsageUtilization` when it is fresh and belongs to
 * the profile's own account.
 *
 * @param {{ oauthAccount?: object, cachedUsageUtilization?: object } | null} state
 * @returns {object | null} Normalized usage, or null when absent, stale or mismatched.
 */
function readCachedUsage(state, { now = Date.now(), ttlMs = CACHE_TTL_MS } = {}) {
  const cache = state && state.cachedUsageUtilization;
  const accountUuid = state && state.oauthAccount && state.oauthAccount.accountUuid;
  if (!isObject(cache) || typeof accountUuid !== 'string' || cache.accountUuid !== accountUuid) return null;
  const age = now - cache.fetchedAtMs;
  if (typeof cache.fetchedAtMs !== 'number' || !(age >= 0 && age < ttlMs)) return null;
  return normalizeUsage(cache.utilization);
}

/**
 * Ask a profile's own Claude CLI for its usage (`get_usage` control request)
 * and resolve with the normalized result. The CLI reads its own credentials;
 * this code never sees a token. Child output is parsed, never echoed, and
 * every failure rejects with a short generic reason.
 *
 * @param {object} deps
 * @param {string} deps.claudePath
 * @param {string} deps.configDir
 * @param {Record<string, string>} deps.env
 * @param {string} deps.cwd - Fixed directory, so only one project slug is created.
 * @param {typeof import('node:child_process').spawn} deps.spawn
 * @param {number} [deps.timeoutMs]
 */
function probeUsage({ claudePath, configDir, env, cwd, spawn, timeoutMs = PROBE_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const requestId = `usage-${crypto.randomUUID()}`;
    let child;
    try {
      child = spawn(claudePath, PROBE_ARGS, {
        env: { ...sanitizeEnvironment(env), CLAUDE_CONFIG_DIR: configDir },
        cwd,
        stdio: ['pipe', 'pipe', 'ignore']
      });
    } catch {
      reject(new Error('could not start claude'));
      return;
    }

    let settled = false;
    let buffer = '';
    const decoder = new StringDecoder('utf8');

    const finish = (error, usage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      try { child.kill('SIGTERM'); } catch {}
      if (error) reject(error);
      else resolve(usage);
    };

    const timer = setTimeout(() => finish(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);

    const handleLine = (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (!isObject(message) || message.type !== 'control_response') return;
      const response = message.response;
      if (!isObject(response) || response.request_id !== requestId) return;
      if (response.subtype !== 'success') {
        finish(new Error('claude returned an error response'));
        return;
      }
      const usage = normalizeUsage(response.response);
      if (usage) finish(null, usage);
      else finish(new Error('usage data unavailable or in an unknown format'));
    };

    child.stdout.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      let index;
      while (!settled && (index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(line);
      }
      if (!settled && buffer.length > MAX_LINE_BYTES) finish(new Error('claude output too large'));
    });
    child.on('error', () => finish(new Error('could not run claude')));
    child.on('exit', (code) => finish(new Error(`claude exited early (code ${code})`)));
    if (child.stdin && typeof child.stdin.on === 'function') child.stdin.on('error', () => {});

    try {
      child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'get_usage', skip_behaviors: true } })}\n`);
    } catch {
      finish(new Error('could not write to claude'));
    }
  });
}

/**
 * Gather a usage snapshot for every profile in parallel. A profile whose usage
 * cannot be read gets `usage: null` and a reason; it never fails the others.
 *
 * @returns {Promise<Array<{ name, configDir, usage, error?, source?, tier, tierSource, weight, tierWarning? }>>}
 */
async function collectUsage({
  profiles, claudePath, env, cwd, profilesConfigDir, readProfileState, spawnProbe,
  now = Date.now(), ttlMs = CACHE_TTL_MS, timeoutMs = PROBE_TIMEOUT_MS
}) {
  return Promise.all(profiles.map(async (profile) => {
    const { name } = profile;
    const configDir = path.join(profilesConfigDir, name);
    let state = null;
    try { state = await readProfileState(configDir); } catch {}

    let usage = null;
    let source;
    let error;
    if (!state || !state.oauthAccount) {
      error = `not signed in (run: claude-profiles refresh ${name})`;
    } else {
      usage = readCachedUsage(state, { now, ttlMs });
      if (usage) {
        source = 'cache';
      } else {
        try {
          usage = await probeUsage({ claudePath, configDir, env, cwd, spawn: spawnProbe, timeoutMs });
          source = 'probe';
        } catch (err) {
          error = err && err.message ? err.message : 'usage unavailable';
        }
      }
    }

    const tier = resolveTier({
      name,
      registryTier: profile.tier,
      oauthAccount: state && state.oauthAccount,
      subscriptionType: usage && usage.subscriptionType
    });
    return {
      name, configDir, usage, error, source,
      tier: tier.tier, tierSource: tier.source, weight: tier.weight, tierWarning: tier.warning
    };
  }));
}

module.exports = { normalizeUsage, readCachedUsage, probeUsage, collectUsage, CACHE_TTL_MS, PROBE_TIMEOUT_MS, PROBE_ARGS };
