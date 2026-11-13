// Plan tiers and their weights, in Pro-equivalent units. Premium and Max plans
// have far higher limits than standard ones, so a small premium percentage
// used can still leave more real capacity than a large standard percentage.
const TIER_WEIGHTS = Object.freeze({
  pro: 1,
  'team-standard': 1.25,
  max5x: 5,
  'team-premium': 6.25,
  max20x: 20
});

const CUSTOM = /^custom:(\d+(?:\.\d+)?)$/;
const MAX_CUSTOM_WEIGHT = 1000;

function validTiersText() {
  return `${Object.keys(TIER_WEIGHTS).join(', ')}, custom:<n>`;
}

/**
 * Validate a tier string. Returns its canonical form and weight, or throws.
 * @param {unknown} input
 * @returns {{ tier: string, weight: number }}
 */
function parseTier(input) {
  const text = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (Object.hasOwn(TIER_WEIGHTS, text)) return { tier: text, weight: TIER_WEIGHTS[text] };
  const custom = CUSTOM.exec(text);
  if (custom) {
    const weight = Number(custom[1]);
    if (weight > 0 && weight <= MAX_CUSTOM_WEIGHT) return { tier: `custom:${custom[1]}`, weight };
  }
  throw new Error(`Invalid tier. Valid tiers: ${validTiersText()}.`);
}

function lower(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

/**
 * Best-effort tier detection from non-secret account metadata. Max plans are
 * explicit. A Team seat's premium status is inferred from its user rate-limit
 * tier, which is not a documented mapping, so a registry tier always wins.
 * @param {object | undefined} oauthAccount - `.claude.json` `oauthAccount`.
 * @param {{ subscriptionType?: string }} [hints] - `get_usage` subscription type.
 * @returns {string | undefined} A tier name, or undefined when unknown.
 */
function detectTier(oauthAccount, { subscriptionType } = {}) {
  const account = oauthAccount && typeof oauthAccount === 'object' ? oauthAccount : {};
  const orgType = lower(account.organizationType);
  const subscription = lower(subscriptionType);
  const orgRate = lower(account.organizationRateLimitTier);
  const userRate = lower(account.userRateLimitTier);

  if (orgType.includes('team') || subscription === 'team') {
    return /max_(5|20)x$/.test(userRate) ? 'team-premium' : undefined;
  }
  if (orgType.includes('max') || subscription === 'max') {
    if (/max_20x$/.test(orgRate) || /max_20x$/.test(userRate)) return 'max20x';
    if (/max_5x$/.test(orgRate) || /max_5x$/.test(userRate)) return 'max5x';
    return undefined;
  }
  if (orgType.includes('pro') || subscription === 'pro') return 'pro';
  return undefined;
}

/**
 * Effective tier for one profile: registry value, then detection, then a
 * default weight of 1 with a warning.
 * @returns {{ tier: string, weight: number, source: 'registry'|'detected'|'default', warning?: string }}
 */
function resolveTier({ name, registryTier, oauthAccount, subscriptionType }) {
  let invalid = false;
  if (registryTier !== undefined && registryTier !== null) {
    try {
      const { tier, weight } = parseTier(registryTier);
      return { tier, weight, source: 'registry' };
    } catch {
      invalid = true;
    }
  }
  const detected = detectTier(oauthAccount, { subscriptionType });
  if (detected) return { tier: detected, weight: TIER_WEIGHTS[detected], source: 'detected' };
  const reason = invalid ? 'registry tier is invalid' : 'tier unknown';
  return {
    tier: 'unknown',
    weight: 1,
    source: 'default',
    warning: `${name}: ${reason}, using weight 1 - set with: claude-profiles tier ${name} <tier>`
  };
}

module.exports = { TIER_WEIGHTS, parseTier, detectTier, resolveTier };
