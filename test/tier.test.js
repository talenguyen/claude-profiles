const test = require('node:test');
const assert = require('node:assert/strict');
const { TIER_WEIGHTS, parseTier, detectTier, resolveTier } = require('../src/tier.js');
const { clearInheritedConfigEnv } = require('./helpers.js');

clearInheritedConfigEnv();

test('weights follow the documented plan multipliers', () => {
  assert.deepEqual({ ...TIER_WEIGHTS }, { pro: 1, 'team-standard': 1.25, max5x: 5, 'team-premium': 6.25, max20x: 20 });
});

test('parseTier accepts named tiers and custom:<n>, and rejects the rest', () => {
  assert.deepEqual(parseTier('Max5x'), { tier: 'max5x', weight: 5 });
  assert.deepEqual(parseTier('custom:2.5'), { tier: 'custom:2.5', weight: 2.5 });
  for (const bad of ['', 'gold', 'custom:', 'custom:0', 'custom:-1', 'custom:abc', 'custom:5000', undefined, 7]) {
    assert.throws(() => parseTier(bad), /Invalid tier/);
  }
});

test('detectTier reads Max plans explicitly', () => {
  assert.equal(detectTier({ organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_5x' }), 'max5x');
  assert.equal(detectTier({ organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' }), 'max20x');
  assert.equal(detectTier({ organizationType: 'claude_max' }), undefined);
});

test('detectTier infers a premium Team seat from its user rate-limit tier', () => {
  const premium = { organizationType: 'claude_team', organizationRateLimitTier: 'default_raven', userRateLimitTier: 'default_claude_max_5x', seatTier: 'team_tier_1' };
  assert.equal(detectTier(premium), 'team-premium');
  assert.equal(detectTier({ organizationType: 'claude_team', organizationRateLimitTier: 'default_raven', userRateLimitTier: null }), undefined);
});

test('detectTier handles Pro, subscription hints and junk input', () => {
  assert.equal(detectTier({ organizationType: 'claude_pro' }), 'pro');
  assert.equal(detectTier(undefined, { subscriptionType: 'pro' }), 'pro');
  assert.equal(detectTier({ organizationType: 'claude_enterprise' }), undefined);
  assert.equal(detectTier(null), undefined);
  assert.equal(detectTier('nope'), undefined);
});

test('a registry tier beats detection, and custom weights apply', () => {
  const oauthAccount = { organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_5x' };
  assert.deepEqual(resolveTier({ name: 'a', registryTier: 'team-standard', oauthAccount }), { tier: 'team-standard', weight: 1.25, source: 'registry' });
  assert.deepEqual(resolveTier({ name: 'a', registryTier: 'custom:3', oauthAccount }), { tier: 'custom:3', weight: 3, source: 'registry' });
  assert.deepEqual(resolveTier({ name: 'a', oauthAccount }), { tier: 'max5x', weight: 5, source: 'detected' });
});

test('an unknown tier gets weight 1 and a warning naming the tier command', () => {
  const unknown = resolveTier({ name: 'work', oauthAccount: {} });
  assert.equal(unknown.weight, 1);
  assert.equal(unknown.source, 'default');
  assert.match(unknown.warning, /claude-profiles tier work <tier>/);
  const invalid = resolveTier({ name: 'work', registryTier: 'gold', oauthAccount: {} });
  assert.equal(invalid.weight, 1);
  assert.match(invalid.warning, /invalid/);
});
