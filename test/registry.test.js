const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile, stat } = require('node:fs/promises');
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
