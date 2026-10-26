const EXACT = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN']);
function sanitizeEnvironment(source) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !EXACT.has(key) && !/(BEDROCK|VERTEX|FOUNDRY)/.test(key.toUpperCase())));
}
module.exports = { sanitizeEnvironment };
