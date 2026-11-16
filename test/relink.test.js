const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { materializeProfileConfig, reconcileSharedItems, SHARED_ITEMS } = require('../src/config.js');
const { run } = require('../src/commands.js');
const { createRegistry } = require('../src/registry.js');
const { makeTempDir, removeTempDir, clearInheritedConfigEnv } = require('./helpers.js');

clearInheritedConfigEnv();

const NOW = Date.UTC(2026, 10, 16, 5, 6, 7);
const STAMP = '20261116T050607Z';

let root;
let baseConfigDir;
let baseStateFile;
let profilesConfigDir;

test.beforeEach(async () => {
  root = await makeTempDir('relink-');
  baseConfigDir = path.join(root, 'base');
  baseStateFile = path.join(baseConfigDir, '.claude.json');
  profilesConfigDir = path.join(root, 'profiles');
  await fsp.mkdir(baseConfigDir, { recursive: true });
  await fsp.writeFile(baseStateFile, '{}');
});

test.afterEach(async () => {
  await removeTempDir(root);
});

// Base config with every shared item present.
async function fillBase() {
  for (const item of SHARED_ITEMS) {
    const full = path.join(baseConfigDir, item);
    if (item.includes('.')) await fsp.writeFile(full, `base ${item}`);
    else await fsp.mkdir(full);
  }
}

const launch = (profile, extra = {}) => {
  const warnings = [];
  const promise = materializeProfileConfig({
    baseConfigDir, baseStateFile, profilesConfigDir, profile, warn: (text) => warnings.push(text), now: () => NOW, isAlive: () => false, ...extra
  });
  return promise.then((target) => ({ target, warnings }));
};

const isLinkToBase = async (target, item) => {
  const link = path.join(target, item);
  return (await fsp.lstat(link)).isSymbolicLink() && (await fsp.realpath(link)) === (await fsp.realpath(path.join(baseConfigDir, item)));
};

const recordLiveSession = async (target, pid = 4242) => {
  await fsp.mkdir(path.join(target, 'sessions'), { recursive: true });
  await fsp.writeFile(path.join(target, 'sessions', `${pid}.json`), '{}');
};

test('shared items now include CLAUDE.md, agents, keybindings.json and output-styles; per-profile items stay out', () => {
  for (const item of ['CLAUDE.md', 'agents', 'keybindings.json', 'output-styles']) assert.ok(SHARED_ITEMS.includes(item), item);
  for (const item of ['.claude.json', '.credentials.json', 'history.jsonl', 'projects', 'file-history']) {
    assert.ok(!SHARED_ITEMS.includes(item), item);
  }
});

test('a new profile links every shared item that exists in the base config, including the new ones', async () => {
  await fillBase();
  const { target } = await launch('a');
  for (const item of SHARED_ITEMS) assert.equal(await isLinkToBase(target, item), true, item);
});

test('a profile missing a shared link gets it on the next launch, quietly', async () => {
  const { target } = await launch('a');
  await fillBase();
  const { warnings } = await launch('a');
  for (const item of SHARED_ITEMS) assert.equal(await isLinkToBase(target, item), true, item);
  assert.deepEqual(warnings, []);
});

test('base items that do not exist are never linked, not even dangling', async () => {
  await fsp.writeFile(path.join(baseConfigDir, 'CLAUDE.md'), 'rules');
  const { target } = await launch('a');
  const second = await launch('a');
  assert.equal(await isLinkToBase(target, 'CLAUDE.md'), true);
  for (const item of SHARED_ITEMS.filter((name) => name !== 'CLAUDE.md')) await assert.rejects(fsp.lstat(path.join(target, item)), item);
  assert.deepEqual(second.warnings, []);
});

test('already-correct links are left untouched', async () => {
  await fillBase();
  const { target } = await launch('a');
  const before = await Promise.all(SHARED_ITEMS.map((item) => fsp.readlink(path.join(target, item))));
  const { warnings } = await launch('a');
  assert.deepEqual(await Promise.all(SHARED_ITEMS.map((item) => fsp.readlink(path.join(target, item)))), before);
  assert.deepEqual(warnings, []);
  assert.deepEqual((await fsp.readdir(target)).filter((name) => name.includes('.pre-share-')), []);
});

test('a real file where a link belongs is backed up and relinked; nothing is lost', async () => {
  await fillBase();
  const { target } = await launch('a');
  await fsp.rm(path.join(target, 'settings.json'));
  await fsp.writeFile(path.join(target, 'settings.json'), '{"drifted":true}');
  await fsp.rm(path.join(target, 'skills'));
  await fsp.mkdir(path.join(target, 'skills'));
  await fsp.writeFile(path.join(target, 'skills', 'mine.md'), 'my skill');

  const { warnings } = await launch('a');

  assert.equal(await isLinkToBase(target, 'settings.json'), true);
  assert.equal(await isLinkToBase(target, 'skills'), true);
  assert.equal(await fsp.readFile(path.join(target, `settings.json.pre-share-${STAMP}`), 'utf8'), '{"drifted":true}');
  assert.equal(await fsp.readFile(path.join(target, `skills.pre-share-${STAMP}`, 'mine.md'), 'utf8'), 'my skill');
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], new RegExp(`settings\\.json was a real file; moved to settings\\.json\\.pre-share-${STAMP} and linked`));
});

test('a link pointing elsewhere is replaced; the old link is kept as the backup', async () => {
  await fillBase();
  const { target } = await launch('a');
  const elsewhere = path.join(root, 'elsewhere');
  await fsp.mkdir(elsewhere);
  await fsp.rm(path.join(target, 'hooks'));
  await fsp.symlink(elsewhere, path.join(target, 'hooks'));

  const { warnings } = await launch('a');

  assert.equal(await isLinkToBase(target, 'hooks'), true);
  assert.equal(await fsp.readlink(path.join(target, `hooks.pre-share-${STAMP}`)), elsewhere);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /hooks was a link elsewhere/);
});

test('two repairs in the same second never overwrite an earlier backup', async () => {
  await fillBase();
  const { target } = await launch('a');
  for (const content of ['first', 'second']) {
    await fsp.rm(path.join(target, 'settings.json'));
    await fsp.writeFile(path.join(target, 'settings.json'), content);
    await launch('a');
  }
  assert.equal(await fsp.readFile(path.join(target, `settings.json.pre-share-${STAMP}`), 'utf8'), 'first');
  assert.equal(await fsp.readFile(path.join(target, `settings.json.pre-share-${STAMP}-2`), 'utf8'), 'second');
});

test('with Claude running for the profile nothing changes and one warning per item names the fix', async () => {
  await fillBase();
  const { target } = await launch('a');
  await fsp.rm(path.join(target, 'settings.json'));
  await fsp.writeFile(path.join(target, 'settings.json'), 'drifted');
  await recordLiveSession(target);

  const { warnings } = await launch('a', { isAlive: (pid) => pid === 4242 });

  assert.equal((await fsp.lstat(path.join(target, 'settings.json'))).isFile(), true);
  assert.equal(await fsp.readFile(path.join(target, 'settings.json'), 'utf8'), 'drifted');
  assert.deepEqual((await fsp.readdir(target)).filter((name) => name.includes('.pre-share-')), []);
  assert.deepEqual(warnings, ['warning: a: settings.json is not linked to the base config but Claude is running for this profile; exit it, then run: claude-profiles relink a']);
});

test('a stale session record of a dead process does not block the repair', async () => {
  await fillBase();
  const { target } = await launch('a');
  await fsp.rm(path.join(target, 'settings.json'));
  await fsp.writeFile(path.join(target, 'settings.json'), 'drifted');
  await recordLiveSession(target);
  await launch('a', { isAlive: () => false });
  assert.equal(await isLinkToBase(target, 'settings.json'), true);
});

test('a missing link is still created while Claude runs: nothing is replaced, so nothing can be disturbed', async () => {
  await fillBase();
  const { target } = await launch('a');
  await fsp.rm(path.join(target, 'agents'));
  await recordLiveSession(target);
  const { warnings } = await launch('a', { isAlive: () => true });
  assert.equal(await isLinkToBase(target, 'agents'), true);
  assert.deepEqual(warnings, []);
});

test('per-profile files are never touched by the repair', async () => {
  await fillBase();
  await fsp.writeFile(path.join(baseConfigDir, 'history.jsonl'), 'base history');
  await fsp.writeFile(path.join(baseConfigDir, '.credentials.json'), 'base creds');
  const { target } = await launch('a');
  await fsp.writeFile(path.join(target, 'history.jsonl'), 'mine');
  await fsp.writeFile(path.join(target, '.credentials.json'), 'my creds');
  await fsp.writeFile(path.join(target, '.claude.json'), '{"oauthAccount":{"email":"me"}}');
  await launch('a');
  assert.equal(await fsp.readFile(path.join(target, 'history.jsonl'), 'utf8'), 'mine');
  assert.equal(await fsp.readFile(path.join(target, '.credentials.json'), 'utf8'), 'my creds');
  assert.equal(await fsp.readFile(path.join(target, '.claude.json'), 'utf8'), '{"oauthAccount":{"email":"me"}}');
});

test('a link to the base item through another path counts as correct', async () => {
  await fillBase();
  const alias = path.join(root, 'alias');
  await fsp.symlink(baseConfigDir, alias);
  const { target } = await launch('a');
  await fsp.rm(path.join(target, 'skills'));
  await fsp.symlink(path.join(alias, 'skills'), path.join(target, 'skills'));
  const { warnings } = await launch('a');
  assert.deepEqual(warnings, []);
  assert.equal(await fsp.readlink(path.join(target, 'skills')), path.join(alias, 'skills'));
});

test('reconcileSharedItems with dryRun reports the plan and changes nothing', async () => {
  await fillBase();
  const { target } = await launch('a');
  await fsp.rm(path.join(target, 'settings.json'));
  await fsp.writeFile(path.join(target, 'settings.json'), 'drifted');
  await fsp.rm(path.join(target, 'agents'));
  const results = await reconcileSharedItems({ baseConfigDir, target, profile: 'a', isAlive: () => false, dryRun: true, now: () => NOW });
  assert.deepEqual(results, [
    { item: 'settings.json', action: 'replace', was: 'file', backup: `settings.json.pre-share-${STAMP}` },
    { item: 'agents', action: 'link' }
  ].sort((x, y) => SHARED_ITEMS.indexOf(x.item) - SHARED_ITEMS.indexOf(y.item)));
  assert.equal(await fsp.readFile(path.join(target, 'settings.json'), 'utf8'), 'drifted');
  await assert.rejects(fsp.lstat(path.join(target, 'agents')));
});

// ---- the relink command ----

async function commandSandbox(names) {
  const registry = createRegistry({ configHome: path.join(root, 'home') });
  for (const name of names) await registry.add(name);
  const out = [];
  const err = [];
  const deps = {
    registry, profilesConfigDir, baseConfigDir, isAlive: () => false, now: () => NOW,
    print: (text) => out.push(text), printErr: (text) => err.push(text)
  };
  return { deps, out, err };
}

test('relink <profile> repairs one profile and leaves the others', async () => {
  await fillBase();
  const { deps, out } = await commandSandbox(['a', 'b']);
  const { target: a } = await launch('a');
  const { target: b } = await launch('b');
  for (const target of [a, b]) {
    await fsp.rm(path.join(target, 'settings.json'));
    await fsp.writeFile(path.join(target, 'settings.json'), 'drifted');
  }
  await run(['relink', 'a'], deps);
  assert.equal(await isLinkToBase(a, 'settings.json'), true);
  assert.equal((await fsp.lstat(path.join(b, 'settings.json'))).isFile(), true);
  assert.deepEqual(out, [`a: settings.json was a real file; moved to settings.json.pre-share-${STAMP} and linked to the base config`]);
  await run(['relink', 'a'], { ...deps, print: (text) => out.push(text) });
  assert.equal(out.at(-1), 'a: up to date');
});

test('relink --all repairs every profile and skips one without a config dir', async () => {
  await fillBase();
  const { deps, out } = await commandSandbox(['a', 'b', 'new']);
  const { target: a } = await launch('a');
  const { target: b } = await launch('b');
  await fsp.rm(path.join(a, 'agents'));
  await fsp.rm(path.join(b, 'CLAUDE.md'));
  await run(['relink', '--all'], deps);
  assert.equal(await isLinkToBase(a, 'agents'), true);
  assert.equal(await isLinkToBase(b, 'CLAUDE.md'), true);
  assert.deepEqual(out, ['a: linked agents', 'b: linked CLAUDE.md', 'new: no profile config yet; skipped']);
  await assert.rejects(fsp.lstat(path.join(profilesConfigDir, 'new')));
});

test('relink --dry-run prints what would change and changes nothing', async () => {
  await fillBase();
  const { deps, out } = await commandSandbox(['a']);
  const { target } = await launch('a');
  await fsp.rm(path.join(target, 'settings.json'));
  await fsp.writeFile(path.join(target, 'settings.json'), 'drifted');
  await fsp.rm(path.join(target, 'agents'));
  await run(['relink', '--dry-run', '--all'], deps);
  assert.deepEqual(out.sort(), [
    `a: settings.json is a real file; would move to settings.json.pre-share-${STAMP} and link to the base config`,
    'a: would link agents'
  ].sort());
  assert.equal(await fsp.readFile(path.join(target, 'settings.json'), 'utf8'), 'drifted');
  await assert.rejects(fsp.lstat(path.join(target, 'agents')));
});

test('relink leaves a profile with a running session alone, still repairs the others, and exits non-zero', async () => {
  await fillBase();
  const { deps, out, err } = await commandSandbox(['a', 'b']);
  const { target: a } = await launch('a');
  const { target: b } = await launch('b');
  for (const target of [a, b]) {
    await fsp.rm(path.join(target, 'settings.json'));
    await fsp.writeFile(path.join(target, 'settings.json'), 'drifted');
  }
  await recordLiveSession(a);
  await assert.rejects(run(['relink', '--all'], { ...deps, isAlive: () => true }), /1 shared item\(s\) were not relinked/);
  assert.equal((await fsp.lstat(path.join(a, 'settings.json'))).isFile(), true);
  assert.equal(await isLinkToBase(b, 'settings.json'), true);
  assert.equal(err.length, 1);
  assert.match(err[0], /^warning: a: settings\.json is not linked .* claude-profiles relink a$/);
  assert.equal(out.length, 1);
  assert.match(out[0], /^b: settings\.json was a real file/);
});

test('relink argument errors: needs exactly a profile or --all', async () => {
  const { deps } = await commandSandbox(['a']);
  await assert.rejects(run(['relink'], deps), /Usage: relink/);
  await assert.rejects(run(['relink', 'a', '--all'], deps), /Usage: relink/);
  await assert.rejects(run(['relink', 'a', 'b'], deps), /Usage: relink/);
  await assert.rejects(run(['relink', '--bogus', 'a'], deps), /unknown option "--bogus"/);
  await assert.rejects(run(['relink', 'ghost'], deps), /Profile not found/);
  await assert.rejects(run(['relink', 'a'], deps), /no profile config yet; run: claude-profiles use a/);
});

test('help documents relink', async () => {
  const output = [];
  await run(['help'], { print: (text) => output.push(text) });
  assert.match(output.join('\n'), /relink \[--dry-run\] <profile>\|--all/);
});
