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
