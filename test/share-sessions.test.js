const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { plan, apply, rollback, BACKUP_SUFFIX } = require('../src/share-sessions.js');
const { run } = require('../src/commands.js');
const { createRegistry } = require('../src/registry.js');
const { makeTempDir, removeTempDir, clearInheritedConfigEnv } = require('./helpers.js');

clearInheritedConfigEnv();

// A sandbox with profiles `a` and `b` and a shared folder, all in a temp dir.
async function sandbox(names = ['a', 'b']) {
  const root = await makeTempDir('share-sessions-');
  const profiles = names.map((name) => ({ name, dir: path.join(root, 'configs', name) }));
  for (const { dir } of profiles) await fsp.mkdir(dir, { recursive: true });
  return { root, profiles, sharedDir: path.join(root, 'shared') };
}

async function put(dir, relative, content, mtimeSec) {
  const file = path.join(dir, relative);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content);
  if (mtimeSec !== undefined) await fsp.utimes(file, mtimeSec, mtimeSec);
  return file;
}

// Every path under a directory with file content, for exact before/after comparison.
async function snapshot(directory) {
  const out = {};
  async function walk(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(directory, full);
      if (entry.isSymbolicLink()) out[rel] = `-> ${await fsp.readlink(full)}`;
      else if (entry.isDirectory()) { out[rel] = 'dir'; await walk(full); } else out[rel] = (await fsp.readFile(full)).toString();
    }
  }
  await walk(directory);
  return out;
}

const read = (file) => fsp.readFile(file, 'utf8');
const isLink = async (file) => (await fsp.lstat(file)).isSymbolicLink();
const none = () => false;

test('union merge: disjoint and shared project folders, sidecars, memory and file-history', async () => {
  const { root, profiles, sharedDir } = await sandbox();
  try {
    const [a, b] = profiles;
    await put(a.dir, 'projects/-p-one/s1.jsonl', 'one\n');
    await put(a.dir, 'projects/-p-one/s1/tool-results/r.txt', 'result');
    await put(a.dir, 'projects/-p-one/memory/MEMORY.md', 'memory a');
    await put(b.dir, 'projects/-p-one/s2.jsonl', 'two\n');
    await put(b.dir, 'projects/-p-two/s3.jsonl', 'three\n');
    await put(b.dir, 'projects/-p-one/memory/other.md', 'memory b');
    await put(a.dir, 'file-history/s1/v1', 'edit');
    await fsp.mkdir(path.join(b.dir, 'projects/-p-empty/s9'), { recursive: true });

    const result = await apply({ profiles, sharedDir, isAlive: none });
    assert.deepEqual(result.completed, ['a', 'b']);

    for (const [rel, text] of [
      ['projects/-p-one/s1.jsonl', 'one\n'], ['projects/-p-one/s2.jsonl', 'two\n'], ['projects/-p-two/s3.jsonl', 'three\n'],
      ['projects/-p-one/s1/tool-results/r.txt', 'result'], ['projects/-p-one/memory/MEMORY.md', 'memory a'],
      ['projects/-p-one/memory/other.md', 'memory b'], ['file-history/s1/v1', 'edit']
    ]) assert.equal(await read(path.join(sharedDir, rel)), text, rel);
    assert.equal((await fsp.stat(path.join(sharedDir, 'projects/-p-empty/s9'))).isDirectory(), true);

    for (const { dir } of profiles) {
      for (const item of ['projects', 'file-history']) {
        assert.equal(await isLink(path.join(dir, item)), true);
        assert.equal(await fsp.realpath(path.join(dir, item)), await fsp.realpath(path.join(sharedDir, item)));
      }
      assert.equal((await fsp.stat(path.join(dir, 'projects/-p-two/s3.jsonl'))).isFile(), true);
    }
    assert.equal((await fsp.stat(sharedDir)).mode & 0o777, 0o700);
    assert.equal((await fsp.stat(path.join(sharedDir, 'projects'))).mode & 0o777, 0o700);
    // The old trees stay as backups.
    assert.equal(await read(path.join(a.dir, `projects${BACKUP_SUFFIX}`, '-p-one/s1.jsonl')), 'one\n');
  } finally {
    await removeTempDir(root);
  }
});

test('copies keep modification times so --continue still finds the newest transcript', async () => {
  const { root, profiles, sharedDir } = await sandbox();
  try {
    await put(profiles[0].dir, 'projects/-p/s1.jsonl', 'x\n', 1234);
    await apply({ profiles, sharedDir, isAlive: none });
    assert.equal(Math.round((await fsp.stat(path.join(sharedDir, 'projects/-p/s1.jsonl'))).mtimeMs / 1000), 1234);
  } finally {
    await removeTempDir(root);
  }
});

test('identical files are dropped and a resumed copy that extends the original wins', async () => {
  const { root, profiles, sharedDir } = await sandbox();
  try {
    const [a, b] = profiles;
    await put(a.dir, 'projects/-p/same.jsonl', 'same\n');
    await put(b.dir, 'projects/-p/same.jsonl', 'same\n');
    await put(a.dir, 'projects/-p/ext.jsonl', 'short\n');
    await put(b.dir, 'projects/-p/ext.jsonl', 'short\nlonger\n');
    await put(a.dir, 'projects/-p/old.jsonl', 'long\nlonger\n');
    await put(b.dir, 'projects/-p/old.jsonl', 'long\n');

    const planned = await plan({ profiles, sharedDir });
    assert.equal(planned.conflicts.length, 0);
    assert.deepEqual(planned.dropped.map((entry) => entry.kind).sort(), ['identical', 'incoming-is-older-prefix']);

    await apply({ profiles, sharedDir, isAlive: none });
    assert.equal(await read(path.join(sharedDir, 'projects/-p/same.jsonl')), 'same\n');
    assert.equal(await read(path.join(sharedDir, 'projects/-p/ext.jsonl')), 'short\nlonger\n');
    assert.equal(await read(path.join(sharedDir, 'projects/-p/old.jsonl')), 'long\nlonger\n');
  } finally {
    await removeTempDir(root);
  }
});

test('a same-named file with different content aborts and changes nothing', async () => {
  const { root, profiles, sharedDir } = await sandbox();
  try {
    const [a, b] = profiles;
    await put(a.dir, 'projects/-p/dv.jsonl', 'common\nfrom a\n');
    await put(b.dir, 'projects/-p/dv.jsonl', 'common\nfrom b\n');
    await put(a.dir, 'projects/-p/fine.jsonl', 'fine\n');
    const before = [await snapshot(a.dir), await snapshot(b.dir)];

    await assert.rejects(apply({ profiles, sharedDir, isAlive: none }), (error) => {
      assert.match(error.message, /1 file\(s\).*different content.*nothing was changed/);
      assert.deepEqual(error.conflicts, [{ profile: 'b', path: path.join('projects', '-p', 'dv.jsonl') }]);
      return true;
    });
    assert.deepEqual([await snapshot(a.dir), await snapshot(b.dir)], before);
    await assert.rejects(fsp.stat(sharedDir));
  } finally {
    await removeTempDir(root);
  }
});

test('a conflict with a file already in the shared folder aborts too', async () => {
  const { root, profiles, sharedDir } = await sandbox(['a']);
  try {
    await put(sharedDir, 'projects/-p/x.jsonl', 'shared version\n');
    await put(profiles[0].dir, 'projects/-p/x.jsonl', 'private version\n');
    await assert.rejects(apply({ profiles, sharedDir, isAlive: none }), /different content/);
    assert.equal(await read(path.join(sharedDir, 'projects/-p/x.jsonl')), 'shared version\n');
    assert.equal((await fsp.lstat(path.join(profiles[0].dir, 'projects'))).isDirectory(), true);
  } finally {
    await removeTempDir(root);
  }
});

test('a live Claude process blocks the whole operation, dead pids do not', async () => {
  const { root, profiles, sharedDir } = await sandbox();
  try {
    await put(profiles[0].dir, 'projects/-p/s1.jsonl', 'x\n');
    await put(profiles[1].dir, 'sessions/4242.json', '{}');
    await put(profiles[1].dir, 'sessions/notes.txt', 'ignored');
    const before = [await snapshot(profiles[0].dir), await snapshot(profiles[1].dir)];

    await assert.rejects(apply({ profiles, sharedDir, isAlive: (pid) => pid === 4242 }), /Claude is still running for: b/);
    assert.deepEqual([await snapshot(profiles[0].dir), await snapshot(profiles[1].dir)], before);
    await assert.rejects(fsp.stat(sharedDir));
    await assert.rejects(rollback({ profiles, sharedDir, isAlive: (pid) => pid === 4242 }), /still running/);

    await apply({ profiles, sharedDir, isAlive: (pid) => pid !== 4242 });
    assert.equal(await read(path.join(sharedDir, 'projects/-p/s1.jsonl')), 'x\n');
  } finally {
    await removeTempDir(root);
  }
});

test('a process that starts during the copy still blocks the swap', async () => {
  const { root, profiles, sharedDir } = await sandbox(['a']);
  try {
    await put(profiles[0].dir, 'projects/-p/s1.jsonl', 'x\n');
    await put(profiles[0].dir, 'sessions/77.json', '{}');
    let calls = 0;
    await assert.rejects(apply({ profiles, sharedDir, isAlive: () => (calls += 1) > 1 }), /still running/);
    assert.equal((await fsp.lstat(path.join(profiles[0].dir, 'projects'))).isDirectory(), true);
  } finally {
    await removeTempDir(root);
  }
});

test('re-running is a no-op and a profile with no sessions simply gets links', async () => {
  const { root, profiles, sharedDir } = await sandbox(['a', 'empty']);
  try {
    await put(profiles[0].dir, 'projects/-p/s1.jsonl', 'x\n');
    await apply({ profiles, sharedDir, isAlive: none });
    for (const { dir } of profiles) assert.equal(await isLink(path.join(dir, 'projects')), true);
    const before = [await snapshot(profiles[0].dir), await snapshot(profiles[1].dir), await snapshot(sharedDir)];

    const planned = await plan({ profiles, sharedDir });
    assert.deepEqual([planned.copies, planned.swaps, planned.links, planned.conflicts], [[], [], [], []]);
    assert.equal(planned.already.length, 4);
    const again = await apply({ profiles, sharedDir, isAlive: none });
    assert.deepEqual([again.copied, again.backups, again.linked], [0, [], []]);
    assert.deepEqual([await snapshot(profiles[0].dir), await snapshot(profiles[1].dir), await snapshot(sharedDir)], before);
  } finally {
    await removeTempDir(root);
  }
});

test('a symlink pointing elsewhere is refused and left alone', async () => {
  const { root, profiles, sharedDir } = await sandbox();
  try {
    const elsewhere = path.join(root, 'elsewhere');
    await fsp.mkdir(elsewhere);
    await fsp.symlink(elsewhere, path.join(profiles[0].dir, 'projects'));
    await put(profiles[1].dir, 'projects/-p/s1.jsonl', 'x\n');
    await assert.rejects(apply({ profiles, sharedDir, isAlive: none }), /1 item\(s\) cannot be shared; nothing was changed/);
    assert.equal(await fsp.readlink(path.join(profiles[0].dir, 'projects')), elsewhere);
    assert.equal((await fsp.lstat(path.join(profiles[1].dir, 'projects'))).isDirectory(), true);
  } finally {
    await removeTempDir(root);
  }
});

test('an existing backup folder blocks the run instead of being overwritten', async () => {
  const { root, profiles, sharedDir } = await sandbox(['a']);
  try {
    await put(profiles[0].dir, 'projects/-p/s1.jsonl', 'x\n');
    await put(profiles[0].dir, `projects${BACKUP_SUFFIX}/-p/old.jsonl`, 'old\n');
    await assert.rejects(apply({ profiles, sharedDir, isAlive: none }), /cannot be shared/);
    assert.equal(await read(path.join(profiles[0].dir, `projects${BACKUP_SUFFIX}/-p/old.jsonl`)), 'old\n');
  } finally {
    await removeTempDir(root);
  }
});

test('symlinks inside a tree are carried as links, never followed', async () => {
  const { root, profiles, sharedDir } = await sandbox(['a']);
  try {
    const outside = path.join(root, 'outside');
    await put(outside, 'precious.txt', 'keep');
    await fsp.mkdir(path.join(profiles[0].dir, 'projects'), { recursive: true });
    await fsp.symlink(outside, path.join(profiles[0].dir, 'projects', '-linked-slug'));
    await apply({ profiles, sharedDir, isAlive: none });
    assert.equal(await fsp.readlink(path.join(sharedDir, 'projects/-linked-slug')), outside);
    assert.equal(await read(path.join(outside, 'precious.txt')), 'keep');
  } finally {
    await removeTempDir(root);
  }
});

test('rollback restores the exact pre-migration tree and reports newer sessions', async () => {
  const { root, profiles, sharedDir } = await sandbox();
  try {
    const [a, b] = profiles;
    await put(a.dir, 'projects/-p/s1.jsonl', 'one\n', 1000);
    await put(a.dir, 'projects/-p/s1/tool-results/r.txt', 'result');
    await put(b.dir, 'projects/-p/s2.jsonl', 'two\n', 1000);
    await put(b.dir, 'file-history/s2/v1', 'edit');
    await put(b.dir, 'projects/-p/recent.jsonl', 'made just before the migration\n');
    const before = [await snapshot(a.dir), await snapshot(b.dir)];

    await apply({ profiles, sharedDir, isAlive: none });
    // A session created after the migration lands in the shared folder.
    await put(path.join(a.dir), 'projects/-p/new.jsonl', 'new\n', Date.now() / 1000 + 10);

    const preview = await rollback({ profiles, sharedDir, isAlive: none, dryRun: true });
    assert.equal(preview.restored.length, 3);
    assert.equal(await isLink(path.join(a.dir, 'projects')), true);

    const result = await rollback({ profiles, sharedDir, isAlive: none });
    assert.equal(result.newerSessions, 1);
    assert.deepEqual([await snapshot(a.dir), await snapshot(b.dir)].map((tree) => Object.keys(tree).sort()),
      before.map((tree) => Object.keys(tree).sort()));
    assert.deepEqual([await snapshot(a.dir), await snapshot(b.dir)], before);
    // The shared folder keeps its copies, so a second run sees them as identical.
    const again = await plan({ profiles, sharedDir });
    assert.equal(again.conflicts.length, 0);
    assert.equal(again.dropped.length, 5);
    // A second rollback has nothing to do.
    assert.deepEqual((await rollback({ profiles, sharedDir, isAlive: none })).restored, []);
  } finally {
    await removeTempDir(root);
  }
});

test('rollback of a profile that had no sessions just removes the links', async () => {
  const { root, profiles, sharedDir } = await sandbox(['fresh']);
  try {
    await apply({ profiles, sharedDir, isAlive: none });
    const result = await rollback({ profiles, sharedDir, isAlive: none });
    assert.deepEqual(result.unlinked, ['fresh/projects', 'fresh/file-history']);
    assert.deepEqual(await fsp.readdir(profiles[0].dir), []);
  } finally {
    await removeTempDir(root);
  }
});

// ---- the command ----

async function commandSandbox(names = ['a', 'b']) {
  const base = await sandbox(names);
  const configHome = path.join(base.root, 'home');
  await fsp.mkdir(configHome, { recursive: true });
  const registry = createRegistry({ configHome });
  for (const name of names) await registry.add(name);
  const out = [];
  const deps = {
    registry, profilesConfigDir: path.join(base.root, 'configs'), sharedSessionsDir: base.sharedDir,
    isAlive: none, print: (text) => out.push(text)
  };
  return { ...base, registry, deps, out };
}

test('share-sessions opts the named profiles in, says what crosses, and keeps backups', async () => {
  const sb = await commandSandbox(['a', 'b', 'c']);
  try {
    await put(sb.profiles[0].dir, 'projects/-p/s1.jsonl', 'x\n');
    await run(['share-sessions', 'a', 'b'], sb.deps);
    assert.deepEqual((await sb.registry.list()).map((p) => p.sessions), ['shared', 'shared', 'private']);
    await assert.rejects(fsp.lstat(path.join(sb.profiles[2].dir, 'projects')), 'c did not opt in');
    const text = sb.out.join('\n');
    assert.match(text, /sent to that account/);
    assert.match(text, /projects\.pre-share/);
    assert.match(text, /--rollback/);

    await run(['share-sessions', '--rollback', 'a'], sb.deps);
    assert.deepEqual((await sb.registry.list()).map((p) => p.sessions), ['private', 'shared', 'private']);
    assert.equal((await fsp.lstat(path.join(sb.profiles[0].dir, 'projects'))).isDirectory(), true);
  } finally {
    await removeTempDir(sb.root);
  }
});

test('share-sessions without names needs an opt-in first, then acts on the shared profiles', async () => {
  const sb = await commandSandbox(['a', 'b']);
  try {
    await assert.rejects(run(['share-sessions'], sb.deps), /Name the profiles that should share sessions/);
    await run(['share-sessions', '--rollback'], sb.deps);
    assert.match(sb.out.join('\n'), /nothing to roll back/);
    await run(['share-sessions', 'b'], sb.deps);
    sb.out.length = 0;
    await run(['share-sessions'], sb.deps);
    assert.match(sb.out.join('\n'), /shared: b/);
    await assert.rejects(run(['share-sessions', 'ghost'], sb.deps), /Profile not found/);
    await assert.rejects(run(['share-sessions', '--wat'], sb.deps), /unknown option "--wat"/);
  } finally {
    await removeTempDir(sb.root);
  }
});

test('share-sessions --dry-run changes nothing, lists conflicts, and fails when not ready', async () => {
  const sb = await commandSandbox(['a', 'b']);
  try {
    await put(sb.profiles[0].dir, 'projects/-p/s1.jsonl', 'x\n');
    await put(sb.profiles[0].dir, 'projects/-p/dv.jsonl', 'a\n');
    await put(sb.profiles[1].dir, 'projects/-p/dv.jsonl', 'b\n');
    const before = [await snapshot(sb.profiles[0].dir), await snapshot(sb.profiles[1].dir)];
    await assert.rejects(run(['share-sessions', '--dry-run', 'a', 'b'], sb.deps), /Not ready to share/);
    assert.match(sb.out.join('\n'), /conflicting files[\s\S]*dv\.jsonl/);
    assert.deepEqual([await snapshot(sb.profiles[0].dir), await snapshot(sb.profiles[1].dir)], before);
    await assert.rejects(fsp.stat(sb.sharedDir));
    assert.deepEqual((await sb.registry.list()).map((p) => p.sessions), ['private', 'private']);

    await fsp.rm(path.join(sb.profiles[1].dir, 'projects'), { recursive: true });
    sb.out.length = 0;
    await run(['share-sessions', '--dry-run', 'a', 'b'], sb.deps);
    assert.match(sb.out.join('\n'), /would copy \d+ file/);
    await assert.rejects(fsp.stat(sb.sharedDir));
  } finally {
    await removeTempDir(sb.root);
  }
});

test('share-sessions refuses while Claude runs and leaves the registry alone', async () => {
  const sb = await commandSandbox(['a']);
  try {
    await put(sb.profiles[0].dir, 'sessions/9.json', '{}');
    await put(sb.profiles[0].dir, 'projects/-p/s1.jsonl', 'x\n');
    await assert.rejects(run(['share-sessions', 'a'], { ...sb.deps, isAlive: () => true }), /Exit every Claude session/);
    assert.equal((await sb.registry.get('a')).sessions, 'private');
  } finally {
    await removeTempDir(sb.root);
  }
});

test('a path that is a file in one profile and a folder in another is a conflict', async () => {
  const { root, profiles, sharedDir } = await sandbox();
  try {
    await put(profiles[0].dir, 'projects/-p/thing', 'file\n');
    await put(profiles[1].dir, 'projects/-p/thing/inner.jsonl', 'folder\n');
    await assert.rejects(apply({ profiles, sharedDir, isAlive: none }), /different content/);
    await assert.rejects(fsp.stat(sharedDir));
    // Same collision the other way round, and against what is already shared.
    await fsp.rm(path.join(profiles[0].dir, 'projects/-p/thing'));
    await put(sharedDir, 'projects/-p/thing', 'shared file\n');
    await assert.rejects(apply({ profiles: [profiles[1]], sharedDir, isAlive: none }), /different content/);
    assert.equal(await read(path.join(sharedDir, 'projects/-p/thing')), 'shared file\n');
  } finally {
    await removeTempDir(root);
  }
});
