const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { parseResumeIntent, findSessionOwners, projectSlug } = require('../src/sessions.js');
const { makeTempDir, removeTempDir, clearInheritedConfigEnv } = require('./helpers.js');

clearInheritedConfigEnv();

test('parseResumeIntent recognises ids, continue and the bare picker', () => {
  assert.deepEqual(parseResumeIntent(['--resume', 'abc-123', '--model', 'opus']), { kind: 'id', id: 'abc-123' });
  assert.deepEqual(parseResumeIntent(['-r', 'abc123']), { kind: 'id', id: 'abc123' });
  assert.deepEqual(parseResumeIntent(['--resume=abc123']), { kind: 'id', id: 'abc123' });
  assert.deepEqual(parseResumeIntent(['--continue']), { kind: 'continue' });
  assert.deepEqual(parseResumeIntent(['-c', '--model', 'opus']), { kind: 'continue' });
  assert.deepEqual(parseResumeIntent(['--resume']), { kind: 'picker' });
  assert.deepEqual(parseResumeIntent(['--resume', '--model', 'opus']), { kind: 'picker' });
  assert.deepEqual(parseResumeIntent(['--resume', 'two words']), { kind: 'picker' });
  assert.deepEqual(parseResumeIntent(['--resume', '../escape']), { kind: 'picker' });
  assert.equal(parseResumeIntent(['--model', 'opus']), null);
  assert.equal(parseResumeIntent([]), null);
});

test('projectSlug replaces slashes and dots with dashes', () => {
  assert.equal(projectSlug('/Users/x/.treehouse/a.b'), '-Users-x--treehouse-a-b');
});

test('findSessionOwners locates the owning profile by id and by newest transcript', async () => {
  const root = await makeTempDir('sessions-');
  try {
    const cwd = '/work/project.one';
    const slug = projectSlug(cwd);
    const profiles = ['a', 'b'].map((name) => ({ name, configDir: path.join(root, name) }));
    for (const { configDir } of profiles) await fsp.mkdir(path.join(configDir, 'projects', slug), { recursive: true });
    const write = async (profile, id, mtimeSec) => {
      const file = path.join(root, profile, 'projects', slug, `${id}.jsonl`);
      await fsp.writeFile(file, '{}\n');
      await fsp.utimes(file, mtimeSec, mtimeSec);
    };
    await write('a', 'sess-a', 1000);
    await write('b', 'sess-b', 2000);

    assert.deepEqual(await findSessionOwners({ profiles, intent: { kind: 'id', id: 'sess-a' }, cwd }), ['a']);
    assert.deepEqual(await findSessionOwners({ profiles, intent: { kind: 'id', id: 'sess-b' }, cwd: '/elsewhere' }), ['b']);
    assert.deepEqual(await findSessionOwners({ profiles, intent: { kind: 'id', id: 'nobody' }, cwd }), []);
    assert.deepEqual(await findSessionOwners({ profiles, intent: { kind: 'continue' }, cwd }), ['b']);
    assert.deepEqual(await findSessionOwners({ profiles, intent: { kind: 'continue' }, cwd: '/no/transcripts' }), []);
  } finally {
    await removeTempDir(root);
  }
});

// ---- shared session history ----

const { locateSession, projectsAreShared, readLastOrganization } = require('../src/sessions.js');

// Profiles `names`; those in `shared` link `projects` to one folder, the rest keep a private one.
async function sharedLayout(names, shared) {
  const root = await makeTempDir('sessions-shared-');
  const cwd = '/work/project.one';
  const slug = projectSlug(cwd);
  const sharedProjects = path.join(root, 'shared', 'projects');
  await fsp.mkdir(path.join(sharedProjects, slug), { recursive: true });
  const profiles = [];
  for (const name of names) {
    const configDir = path.join(root, name);
    await fsp.mkdir(configDir, { recursive: true });
    if (shared.includes(name)) await fsp.symlink(sharedProjects, path.join(configDir, 'projects'));
    else await fsp.mkdir(path.join(configDir, 'projects', slug), { recursive: true });
    profiles.push({ name, configDir });
  }
  const write = async (directory, id, mtimeSec) => {
    const file = path.join(directory, slug, `${id}.jsonl`);
    await fsp.writeFile(file, '{}\n');
    await fsp.utimes(file, mtimeSec, mtimeSec);
    return file;
  };
  return { root, cwd, profiles, sharedProjects, write, privateDir: (name) => path.join(root, name, 'projects') };
}

test('every profile whose projects resolve to the same folder owns a shared session', async () => {
  const { root, cwd, profiles, sharedProjects, write } = await sharedLayout(['a', 'b', 'c'], ['a', 'b', 'c']);
  try {
    const file = await write(sharedProjects, 'sess-1', 1000);
    assert.deepEqual(await findSessionOwners({ profiles, intent: { kind: 'id', id: 'sess-1' }, cwd: '/elsewhere' }), ['a', 'b', 'c']);
    assert.deepEqual(await locateSession({ profiles, intent: { kind: 'id', id: 'sess-1' }, cwd }), { owners: ['a', 'b', 'c'], transcript: await fsp.realpath(file) });
    assert.deepEqual(await findSessionOwners({ profiles, intent: { kind: 'id', id: 'nobody' }, cwd }), []);
  } finally {
    await removeTempDir(root);
  }
});

test('--continue with a shared folder returns every profile, not the first one', async () => {
  const { root, cwd, profiles, sharedProjects, write } = await sharedLayout(['a', 'b', 'c'], ['a', 'b', 'c']);
  try {
    await write(sharedProjects, 'sess-1', 1000);
    await write(sharedProjects, 'sess-2', 2000);
    assert.deepEqual(await findSessionOwners({ profiles, intent: { kind: 'continue' }, cwd }), ['a', 'b', 'c']);
    assert.deepEqual(await findSessionOwners({ profiles, intent: { kind: 'continue' }, cwd: '/no/transcripts' }), []);
  } finally {
    await removeTempDir(root);
  }
});

test('mixed shared and private groups: the group with the newest transcript owns --continue', async () => {
  const { root, cwd, profiles, sharedProjects, write, privateDir } = await sharedLayout(['a', 'b', 'c'], ['a', 'b']);
  try {
    await write(sharedProjects, 'shared-1', 1000);
    await write(privateDir('c'), 'private-1', 500);
    assert.deepEqual(await findSessionOwners({ profiles, intent: { kind: 'continue' }, cwd }), ['a', 'b']);
    await write(privateDir('c'), 'private-2', 3000);
    assert.deepEqual(await findSessionOwners({ profiles, intent: { kind: 'continue' }, cwd }), ['c']);
    assert.deepEqual(await findSessionOwners({ profiles, intent: { kind: 'id', id: 'shared-1' }, cwd }), ['a', 'b']);
    assert.deepEqual(await findSessionOwners({ profiles, intent: { kind: 'id', id: 'private-1' }, cwd }), ['c']);
  } finally {
    await removeTempDir(root);
  }
});

test('profiles without a projects directory do not break grouping', async () => {
  const { root, cwd, profiles } = await sharedLayout(['a'], []);
  try {
    await fsp.rm(path.join(root, 'a', 'projects'), { recursive: true });
    profiles.push({ name: 'ghost', configDir: path.join(root, 'ghost') });
    assert.deepEqual(await findSessionOwners({ profiles, intent: { kind: 'continue' }, cwd }), []);
  } finally {
    await removeTempDir(root);
  }
});

test('projectsAreShared is true only when projects resolves to the shared folder', async () => {
  const { root, profiles, privateDir } = await sharedLayout(['a', 'b'], ['a']);
  try {
    const sharedSessionsDir = path.join(root, 'shared');
    assert.equal(await projectsAreShared({ configDir: profiles[0].configDir, sharedSessionsDir }), true);
    assert.equal(await projectsAreShared({ configDir: profiles[1].configDir, sharedSessionsDir }), false);
    assert.equal(await projectsAreShared({ configDir: profiles[0].configDir }), false);
    assert.equal(await projectsAreShared({ configDir: path.join(root, 'nope'), sharedSessionsDir }), false);
    assert.ok(privateDir('b'));
  } finally {
    await removeTempDir(root);
  }
});

const ORG_A = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ownerRow = (organizationUuid) => JSON.stringify({ type: 'session-owner', accountUuid: 'acct', organizationUuid, sessionId: 's' });
const credentialRow = (organizationUuid) => JSON.stringify({ type: 'attachment', attachment: { type: 'credential_org', organizationUuid } });
const chat = (text) => JSON.stringify({ type: 'user', message: { content: text } });

async function transcript(lines) {
  const root = await makeTempDir('transcript-');
  const file = path.join(root, 's.jsonl');
  await fsp.writeFile(file, `${lines.join('\n')}\n`);
  return { root, file };
}

test('readLastOrganization returns the organization of the last owner or credential row', async () => {
  const one = await transcript([ownerRow(ORG_A), chat('hi'), credentialRow(ORG_A), chat('more'), credentialRow(ORG_B), chat('tail')]);
  const two = await transcript([credentialRow(ORG_A), ownerRow(ORG_B), chat('tail')]);
  const none = await transcript([chat('no org rows here')]);
  try {
    assert.equal(await readLastOrganization(one.file), ORG_B);
    assert.equal(await readLastOrganization(two.file), ORG_B);
    assert.equal(await readLastOrganization(none.file), null);
    assert.equal(await readLastOrganization(path.join(none.root, 'missing.jsonl')), null);
  } finally {
    await Promise.all([one, two, none].map((entry) => removeTempDir(entry.root)));
  }
});

test('readLastOrganization skips malformed and unrelated rows and handles a row with no trailing newline', async () => {
  const root = await makeTempDir('transcript-');
  try {
    const file = path.join(root, 's.jsonl');
    await fsp.writeFile(file, [credentialRow(ORG_A), '{"type":"session-owner", broken', chat('mentions session-owner and credential_org in text'), JSON.stringify({ type: 'session-owner', accountUuid: 'x' })].join('\n'));
    assert.equal(await readLastOrganization(file), ORG_A);
    await fsp.appendFile(file, `\n${ownerRow(ORG_B)}`);
    assert.equal(await readLastOrganization(file), ORG_B);
  } finally {
    await removeTempDir(root);
  }
});

test('readLastOrganization reads backwards across blocks and multibyte text on a large transcript', async () => {
  const big = 'é'.repeat(40_000);
  const lines = [credentialRow(ORG_A)];
  for (let i = 0; i < 40; i += 1) lines.push(chat(`${big}${i}`));
  const { root, file } = await transcript(lines);
  try {
    assert.ok((await fsp.stat(file)).size > 2 * 1024 * 1024);
    assert.equal(await readLastOrganization(file), ORG_A);
    await fsp.appendFile(file, `${ownerRow(ORG_B)}\n${chat(big)}\n`);
    assert.equal(await readLastOrganization(file), ORG_B);
  } finally {
    await removeTempDir(root);
  }
});
