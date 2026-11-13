const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile, stat, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { createRegistry } = require('../src/registry.js');
const { makeTempDir, removeTempDir } = require('./helpers.js');

let tempDir;

test.beforeEach(async () => {
  tempDir = await makeTempDir();
});

test.afterEach(async () => {
  await removeTempDir(tempDir);
});

test('creates a 0700 home and 0600 registry without token data', async () => {
  const registry = createRegistry({ configHome: tempDir });
  await registry.add('mep');
  const text = await readFile(join(tempDir, 'profiles.json'), 'utf8');
  assert.deepEqual(JSON.parse(text), { profiles: [{ name: 'mep', service: 'Claude Profiles: mep' }] });
  assert.equal((await stat(tempDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(tempDir, 'profiles.json'))).mode & 0o777, 0o600);
});

test('rejects duplicate profiles and removes only the requested entry', async () => {
  const registry = createRegistry({ configHome: tempDir });
  await registry.add('mep'); await registry.add('uplive');
  await assert.rejects(registry.add('mep'));
  await registry.remove('mep');
  assert.deepEqual(await registry.list(), [{ name: 'uplive', service: 'Claude Profiles: uplive' }]);
});

test('tier round-trips through add, list, get and setTier', async () => {
  const registry = createRegistry({ configHome: tempDir });
  await registry.add('plain');
  await registry.add('premium', { tier: 'Team-Premium' });
  assert.deepEqual(await registry.get('premium'), { name: 'premium', service: 'Claude Profiles: premium', tier: 'team-premium' });
  assert.equal('tier' in (await registry.get('plain')), false);
  await registry.setTier('plain', 'custom:2.5');
  assert.deepEqual((await registry.list()).map((p) => p.tier), ['custom:2.5', 'team-premium']);
  await assert.rejects(registry.setTier('plain', 'gold'), /Invalid tier/);
  await assert.rejects(registry.setTier('ghost', 'pro'), /Profile not found/);
  await assert.rejects(registry.add('bad', { tier: 'gold' }), /Invalid tier/);
  assert.equal((await registry.list()).length, 2);
});

test('a legacy registry without tier fields still loads', async () => {
  await writeFile(join(tempDir, 'profiles.json'), JSON.stringify({ profiles: [{ name: 'old', service: 'Claude Profiles: old' }] }));
  const registry = createRegistry({ configHome: tempDir });
  assert.deepEqual(await registry.list(), [{ name: 'old', service: 'Claude Profiles: old' }]);
  await registry.setTier('old', 'max20x');
  assert.equal((await registry.get('old')).tier, 'max20x');
});
