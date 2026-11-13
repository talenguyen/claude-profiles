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
