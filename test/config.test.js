const test = require('node:test');
const assert = require('node:assert/strict');
const { writeFile, mkdir, readFile, stat, lstat, realpath, symlink, readlink } = require('node:fs/promises');
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

// ---- shared session history ----

async function sharedSetup() {
  await writeFile(baseStateFile, '{}');
  return join(tempDir, 'shared');
}

const resolves = async (link, target) => (await realpath(link)) === (await realpath(target));

test('history files stay private to each profile', async () => {
  await writeFile(baseStateFile, '{}');
  await writeFile(join(baseConfigDir, 'history.jsonl'), 'prompt\n');
  await mkdir(join(baseConfigDir, 'history'));
  const target = await materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'mep' });
  await assert.rejects(lstat(join(target, 'history')));
  await assert.rejects(lstat(join(target, 'history.jsonl')));
});

test('an opted-in new profile links projects and file-history into a 0700 shared folder', async () => {
  const sharedSessionsDir = await sharedSetup();
  const target = await materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'a', sessions: 'shared', sharedSessionsDir });
  for (const item of ['projects', 'file-history']) {
    assert.equal((await lstat(join(target, item))).isSymbolicLink(), true);
    assert.equal(await resolves(join(target, item), join(sharedSessionsDir, item)), true);
    assert.equal((await stat(join(sharedSessionsDir, item))).mode & 0o777, 0o700);
  }
  assert.equal((await stat(sharedSessionsDir)).mode & 0o777, 0o700);
  // Two profiles share one folder.
  const other = await materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'b', sessions: 'shared', sharedSessionsDir });
  assert.equal(await resolves(join(other, 'projects'), join(target, 'projects')), true);
});

test('a private profile (the default) gets no session links and no shared folder', async () => {
  const sharedSessionsDir = await sharedSetup();
  const target = await materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'a', sharedSessionsDir });
  await assert.rejects(lstat(join(target, 'projects')));
  await assert.rejects(lstat(sharedSessionsDir));
  await materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'a', sessions: 'private', sharedSessionsDir });
  await assert.rejects(lstat(join(target, 'projects')));
});

test('sharing without a shared folder configured is an error, not a silent private profile', async () => {
  await writeFile(baseStateFile, '{}');
  await assert.rejects(materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'a', sessions: 'shared' }), /no shared sessions folder/);
});

test('an existing opted-in profile with missing session items is linked on the next launch', async () => {
  const sharedSessionsDir = await sharedSetup();
  const target = await materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'a' });
  await materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'a', sessions: 'shared', sharedSessionsDir });
  for (const item of ['projects', 'file-history']) assert.equal(await resolves(join(target, item), join(sharedSessionsDir, item)), true);
  // And again: already linked, nothing to do.
  const warnings = [];
  await materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'a', sessions: 'shared', sharedSessionsDir, warn: (t) => warnings.push(t) });
  assert.deepEqual(warnings, []);
  // The existing profile's other state is untouched.
  assert.deepEqual(JSON.parse(await readFile(join(target, '.claude.json'))), {});
});

test('a real projects directory is never migrated silently; the user is pointed at share-sessions', async () => {
  const sharedSessionsDir = await sharedSetup();
  const target = await materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'a' });
  await mkdir(join(target, 'projects', '-p'), { recursive: true });
  await writeFile(join(target, 'projects', '-p', 's.jsonl'), 'keep');
  const warnings = [];
  await materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'a', sessions: 'shared', sharedSessionsDir, warn: (t) => warnings.push(t) });
  assert.equal((await lstat(join(target, 'projects'))).isDirectory(), true);
  assert.equal(await readFile(join(target, 'projects', '-p', 's.jsonl'), 'utf8'), 'keep');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /projects still hold private sessions; run: claude-profiles share-sessions a$/);
  // file-history was missing, so it did get linked.
  assert.equal(await resolves(join(target, 'file-history'), join(sharedSessionsDir, 'file-history')), true);
});

test('a symlink pointing elsewhere is refused and left in place', async () => {
  const sharedSessionsDir = await sharedSetup();
  const target = await materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'a' });
  const elsewhere = join(tempDir, 'elsewhere');
  await mkdir(elsewhere);
  await symlink(elsewhere, join(target, 'projects'));
  await assert.rejects(
    materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'a', sessions: 'shared', sharedSessionsDir }),
    /projects in the profile config is not a link to the shared sessions folder/
  );
  assert.equal(await readlink(join(target, 'projects')), elsewhere);
});

test('removing a profile deletes its links, not the shared sessions', async () => {
  const sharedSessionsDir = await sharedSetup();
  const target = await materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'a', sessions: 'shared', sharedSessionsDir });
  await writeFile(join(sharedSessionsDir, 'projects', 'keep.jsonl'), 'keep');
  await removeProfileConfig({ profilesConfigDir, profile: 'a' });
  await assert.rejects(stat(target));
  assert.equal(await readFile(join(sharedSessionsDir, 'projects', 'keep.jsonl'), 'utf8'), 'keep');
});

test('a link to a deleted shared folder still counts as linked and the folder is recreated', async () => {
  const sharedSessionsDir = await sharedSetup();
  const target = await materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'a', sessions: 'shared', sharedSessionsDir });
  await removeTempDir(sharedSessionsDir);
  await materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile: 'a', sessions: 'shared', sharedSessionsDir });
  assert.equal(await resolves(join(target, 'projects'), join(sharedSessionsDir, 'projects')), true);
});
