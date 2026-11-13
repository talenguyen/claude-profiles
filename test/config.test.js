const test = require('node:test');
const assert = require('node:assert/strict');
const { writeFile, mkdir, readFile, stat, lstat } = require('node:fs/promises');
const { join } = require('node:path');
const { materializeProfileConfig, removeProfileConfig, readProfileState } = require('../src/config.js');
const { makeTempDir, removeTempDir, clearInheritedConfigEnv } = require('./helpers.js');

clearInheritedConfigEnv();

let tempDir;
let baseConfigDir;
let baseStateFile;
let profilesConfigDir;

test.beforeEach(async () => {
  tempDir = await makeTempDir();
  baseConfigDir = join(tempDir, 'base-config');
  baseStateFile = join(baseConfigDir, '.claude.json');
  profilesConfigDir = join(tempDir, 'profiles');
  await mkdir(baseConfigDir, { recursive: true });
});

test.afterEach(async () => {
  await removeTempDir(tempDir);
});

test('symlinks only approved non-auth items and strips oauthAccount', async () => {
  await writeFile(join(baseConfigDir, 'settings.json'), '{"theme":"dark"}');
  await mkdir(join(baseConfigDir, 'skills')); await mkdir(join(baseConfigDir, 'daemon'));
  await writeFile(baseStateFile, '{"oauthAccount":{"email":"a@example.test"},"other":true}');
  const target = await materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'mep' });
  assert.equal((await lstat(join(target, 'settings.json'))).isSymbolicLink(), true);
  assert.equal((await lstat(join(target, 'skills'))).isSymbolicLink(), true);
  await assert.rejects(lstat(join(target, 'daemon')));
  assert.deepEqual(JSON.parse(await readFile(join(target, '.claude.json'))), { other: true });
  assert.equal((await stat(target)).mode & 0o777, 0o700);
});

test('fails when the base state file is malformed instead of launching with shared auth', async () => {
  await writeFile(baseStateFile, '{not json');
  await assert.rejects(materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'mep' }));
});

test('preserves all existing native profile state during config refresh', async () => {
  await writeFile(baseStateFile, '{"oauthAccount":{"email":"base@example.test"},"other":true}');
  const target = await materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'mep' });
  await writeFile(join(target, '.claude.json'), '{"oauthAccount":{"email":"profile@example.test"},"runtimeCache":true}');

  await writeFile(baseStateFile, '{"oauthAccount":{"email":"new-base@example.test"},"other":false}');
  await materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'mep' });

  assert.deepEqual(JSON.parse(await readFile(join(target, '.claude.json'))), {
    oauthAccount: { email: 'profile@example.test' },
    runtimeCache: true
  });
});

test('removes only the validated profile config directory', async () => {
  await writeFile(baseStateFile, '{}');
  const target = await materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'mep' });
  await removeProfileConfig({ profilesConfigDir, profile: 'mep' });
  await assert.rejects(stat(target));
});

test('a new profile never inherits the base account usage cache', async () => {
  await writeFile(baseStateFile, JSON.stringify({
    oauthAccount: { accountUuid: 'base' },
    cachedUsageUtilization: { fetchedAtMs: 1, accountUuid: 'base', utilization: {} },
    other: true
  }));
  const target = await materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'mep' });
  assert.deepEqual(JSON.parse(await readFile(join(target, '.claude.json'))), { other: true });
});

test('readProfileState returns only account metadata and the usage cache', async () => {
  const dir = join(tempDir, 'state');
  await mkdir(dir);
  await writeFile(join(dir, '.claude.json'), JSON.stringify({
    oauthAccount: { accountUuid: 'u' }, cachedUsageUtilization: { fetchedAtMs: 5 }, mcpServers: { secret: 'x' }
  }));
  assert.deepEqual(await readProfileState(dir), { oauthAccount: { accountUuid: 'u' }, cachedUsageUtilization: { fetchedAtMs: 5 } });
  assert.equal(await readProfileState(join(tempDir, 'missing')), null);
  await writeFile(join(dir, '.claude.json'), '{not json');
  assert.equal(await readProfileState(dir), null);
  await writeFile(join(dir, '.claude.json'), '[]');
  assert.equal(await readProfileState(dir), null);
});
