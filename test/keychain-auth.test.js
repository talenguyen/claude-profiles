const test = require('node:test');
const assert = require('node:assert/strict');
const { createKeychain } = require('../src/keychain.js');
const { authenticateProfile } = require('../src/auth.js');

test('scopes every profile Keychain query to the claude-profiles account', async () => {
  const calls = [];
  const keychain = createKeychain({ runSecurity: async (args) => { calls.push(args); return { stdout: 'token-value\n' }; } });
  await keychain.has('Claude Profiles: mep');
  await keychain.read('Claude Profiles: mep');
  await keychain.remove('Claude Profiles: mep');
  assert.deepEqual(calls, [
    ['find-generic-password', '-s', 'Claude Profiles: mep', '-a', 'claude-profiles'],
    ['find-generic-password', '-s', 'Claude Profiles: mep', '-a', 'claude-profiles', '-w'],
    ['delete-generic-password', '-s', 'Claude Profiles: mep', '-a', 'claude-profiles']
  ]);
});

test('runs native Claude login in the isolated profile config', async () => {
  const events = [];
  await authenticateProfile({ claudePath: '/fake/claude', env: { ANTHROPIC_API_KEY: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'legacy-token', PATH: '/bin' }, configDir: '/profiles/mep', spawnInteractive: async (_file, args, options) => events.push({ args, env: options.env }) });
  assert.deepEqual(events, [{ args: ['auth', 'login', '--claudeai'], env: { PATH: '/bin', CLAUDE_CONFIG_DIR: '/profiles/mep' } }]);
});
