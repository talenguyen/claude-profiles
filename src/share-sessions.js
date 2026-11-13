const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { SHARED_SESSION_ITEMS, sessionItemState } = require('./config.js');

// A migrated profile keeps its old tree next to the link under this suffix.
const BACKUP_SUFFIX = '.pre-share';
const CHUNK = 1024 * 1024;

/** True when a process with this pid exists (EPERM still means it exists). */
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

async function lstatOrNull(target) {
  try {
    return await fsp.lstat(target);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function readdirSafe(directory) {
  try { return await fsp.readdir(directory); } catch { return []; }
}

/**
 * Claude records each running process as `<config>/sessions/<pid>.json`.
 * Moving a transcript while a writer has it open would split the session, so
 * every operation that touches session trees refuses while one is alive.
 */
async function findLiveProcesses(profiles, isAlive) {
  const live = [];
  for (const { name, dir } of profiles) {
    for (const file of await readdirSafe(path.join(dir, 'sessions'))) {
      const match = /^(\d+)\.json$/.exec(file);
      if (match && isAlive(Number(match[1]))) live.push({ profile: name, pid: Number(match[1]) });
    }
  }
  return live;
}

function liveError(live) {
  const names = [...new Set(live.map((entry) => entry.profile))].join(', ');
  const error = new Error(`Claude is still running for: ${names}. Exit every Claude session for these profiles first.`);
  error.live = live;
  return error;
}

/**
 * Compare two regular files in chunks. A resumed copy of a transcript is a
 * byte extension of the original, which is what makes a merge safe.
 *
 * @returns {Promise<'identical' | 'a-is-prefix' | 'b-is-prefix' | 'diverged'>}
 */
async function compareFiles(a, b) {
  const [handleA, handleB] = [await fsp.open(a, 'r'), await fsp.open(b, 'r')];
  try {
    const [sizeA, sizeB] = [(await handleA.stat()).size, (await handleB.stat()).size];
    const common = Math.min(sizeA, sizeB);
    const bufferA = Buffer.allocUnsafe(CHUNK);
    const bufferB = Buffer.allocUnsafe(CHUNK);
    for (let offset = 0; offset < common; offset += CHUNK) {
      const length = Math.min(CHUNK, common - offset);
      const [readA, readB] = [await handleA.read(bufferA, 0, length, offset), await handleB.read(bufferB, 0, length, offset)];
      if (readA.bytesRead !== length || readB.bytesRead !== length) return 'diverged';
      if (!bufferA.subarray(0, length).equals(bufferB.subarray(0, length))) return 'diverged';
    }
    if (sizeA === sizeB) return 'identical';
    return sizeA < sizeB ? 'a-is-prefix' : 'b-is-prefix';
  } finally {
    await handleA.close();
    await handleB.close();
  }
}

// Leaves are files, symlinks and empty directories; anything else is refused.
function leafKind(info) {
  if (info.isSymbolicLink()) return 'symlink';
  if (info.isFile()) return 'file';
  if (info.isDirectory()) return 'dir';
  return null;
}

/**
 * Decide what to do when `incoming` wants a path that `existing` already holds.
 * @returns {Promise<'identical' | 'incoming-is-older-prefix' | 'incoming-extends-existing' | 'conflict'>}
 */
async function classify(incoming, existing) {
  const [infoIn, infoEx] = [await fsp.lstat(incoming), await fsp.lstat(existing)];
  const [kindIn, kindEx] = [leafKind(infoIn), leafKind(infoEx)];
  if (kindIn !== kindEx) return 'conflict';
  if (kindIn === 'dir') return 'identical';
  if (kindIn === 'symlink') {
    return (await fsp.readlink(incoming)) === (await fsp.readlink(existing)) ? 'identical' : 'conflict';
  }
  const result = await compareFiles(incoming, existing);
  if (result === 'identical') return 'identical';
  if (result === 'a-is-prefix') return 'incoming-is-older-prefix';
  if (result === 'b-is-prefix') return 'incoming-extends-existing';
  return 'conflict';
}

function isDirectTranscript(relativePath) {
  const parts = relativePath.split(path.sep);
  return parts.length === 3 && parts[0] === 'projects' && parts[2].endsWith('.jsonl');
}

async function planItemTree({ profile, source, destination, winners, conflicts, dropped, refusals, relativeTo }) {
  const info = await fsp.lstat(source);
  const kind = leafKind(info);
  if (kind === null) {
    refusals.push({ profile, path: path.relative(relativeTo, destination), reason: 'unsupported file type' });
    return;
  }
  if (kind === 'dir') {
    const entries = await fsp.readdir(source);
    if (entries.length > 0) {
      const taken = winners.get(destination) || (await lstatOrNull(destination));
      const takenIsDir = taken && (taken.type ? taken.type === 'dir' : taken.isDirectory());
      if (taken && !takenIsDir) {
        conflicts.push({ profile, path: path.relative(relativeTo, destination) });
        return;
      }
      for (const entry of entries) {
        await planItemTree({
          profile, source: path.join(source, entry), destination: path.join(destination, entry),
          winners, conflicts, dropped, refusals, relativeTo
        });
      }
      return;
    }
  }
  const rel = path.relative(relativeTo, destination);
  const current = winners.get(destination);
  let other = current ? current.from : null;
  if (!other && (await lstatOrNull(destination))) other = destination;
  if (!other) {
    winners.set(destination, { profile, from: source, to: destination, kind: 'new', type: kind });
    return;
  }
  const outcome = await classify(source, other);
  if ((outcome === 'incoming-is-older-prefix' || outcome === 'incoming-extends-existing') && !isDirectTranscript(rel)) {
    conflicts.push({ profile, path: rel });
    return;
  }
  if (outcome === 'conflict') conflicts.push({ profile, path: rel });
  else if (outcome === 'incoming-extends-existing') winners.set(destination, { profile, from: source, to: destination, kind: outcome, type: kind });
  else dropped.push({ profile, path: rel, kind: outcome });
}

/**
 * Read-only plan: what sharing these profiles would copy, link and swap, and
 * everything that blocks it.
 *
 * @param {object} args
 * @param {Array<{ name: string, dir: string }>} args.profiles
 * @param {string} args.sharedDir
 * @param {string[]} [args.items]
 */
async function plan({ profiles, sharedDir, items = SHARED_SESSION_ITEMS }) {
  const winners = new Map();
  const conflicts = [];
  const dropped = [];
  const refusals = [];
  const swaps = [];
  const links = [];
  const already = [];

  for (const item of items) {
    const sharedItem = path.join(sharedDir, item);
    for (const { name, dir } of profiles) {
      const state = await sessionItemState(dir, sharedDir, item);
      if (state === 'linked') {
        already.push({ profile: name, item });
      } else if (state === 'missing') {
        links.push({ profile: name, item });
      } else if (state === 'foreign') {
        refusals.push({ profile: name, path: item, reason: 'is a link to somewhere other than the shared sessions folder (or not a directory); not touching it' });
      } else if (await lstatOrNull(path.join(dir, `${item}${BACKUP_SUFFIX}`))) {
        refusals.push({ profile: name, path: `${item}${BACKUP_SUFFIX}`, reason: 'already exists; run share-sessions --rollback first, or move it away' });
      } else {
        swaps.push({ profile: name, item });
        await planItemTree({
          profile: name, source: path.join(dir, item), destination: sharedItem,
          winners, conflicts, dropped, refusals, relativeTo: sharedDir
        });
      }
    }
  }
  // A path cannot be a file in one profile and a folder in another.
  for (const winner of winners.values()) {
    for (let parent = path.dirname(winner.to); parent.length > sharedDir.length; parent = path.dirname(parent)) {
      if (winners.has(parent) && winners.get(parent).type !== 'dir') conflicts.push({ profile: winner.profile, path: path.relative(sharedDir, parent) });
    }
  }
  return { copies: [...winners.values()], swaps, links, already, conflicts, dropped, refusals };
}

function blockedError(result) {
  const parts = [];
  if (result.conflicts.length > 0) {
    parts.push(`${result.conflicts.length} file(s) exist in more than one profile with different content`);
  }
  if (result.refusals.length > 0) parts.push(`${result.refusals.length} item(s) cannot be shared`);
  const error = new Error(`${parts.join('; ')}; nothing was changed.`);
  error.conflicts = result.conflicts;
  error.refusals = result.refusals;
  return error;
}

async function ensurePrivateDir(directory) {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.chmod(directory, 0o700);
}

async function copyLeaf(operation) {
  await fsp.mkdir(path.dirname(operation.to), { recursive: true, mode: 0o700 });
  if (operation.type === 'dir') {
    await fsp.mkdir(operation.to, { recursive: true, mode: 0o700 });
    return;
  }
  // COPYFILE_FICLONE makes an APFS clone (instant, no extra space) and falls
  // back to a normal copy elsewhere.
  await fsp.cp(operation.from, operation.to, {
    force: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    mode: fs.constants.COPYFILE_FICLONE
  });
}

/**
 * Share the given profiles' session trees. Existing sessions are copied into
 * the shared folder (a union, with prefix merging limited to direct
 * transcript files), then each profile's tree is renamed to
 * `<item>.pre-share` and replaced by a link to the shared folder. A refusal,
 * a conflict or a live Claude process aborts before anything changes.
 *
 * @returns {Promise<{ completed: string[], copied: number, dropped: number, backups: string[], linked: string[] }>}
 */
async function apply({ profiles, sharedDir, isAlive = defaultIsAlive, items = SHARED_SESSION_ITEMS }) {
  const live = await findLiveProcesses(profiles, isAlive);
  if (live.length > 0) throw liveError(live);

  const result = await plan({ profiles, sharedDir, items });
  if (result.conflicts.length > 0 || result.refusals.length > 0) throw blockedError(result);

  await ensurePrivateDir(sharedDir);
  for (const item of items) await ensurePrivateDir(path.join(sharedDir, item));
  for (const operation of result.copies) await copyLeaf(operation);

  // Re-check right before swapping: nothing may have started in the meantime.
  const stillLive = await findLiveProcesses(profiles, isAlive);
  if (stillLive.length > 0) throw liveError(stillLive);

  const backups = [];
  const linked = [];
  const completed = [];
  for (const { name, dir } of profiles) {
    const undo = [];
    try {
      for (const item of items) {
        const itemPath = path.join(dir, item);
        const backup = `${itemPath}${BACKUP_SUFFIX}`;
        if (result.swaps.some((entry) => entry.profile === name && entry.item === item)) {
          await fsp.rename(itemPath, backup);
          undo.push(() => fsp.rename(backup, itemPath));
          await fsp.symlink(path.join(sharedDir, item), itemPath);
          undo.unshift(() => fsp.unlink(itemPath));
          backups.push(backup);
        } else if (result.links.some((entry) => entry.profile === name && entry.item === item)) {
          await fsp.symlink(path.join(sharedDir, item), itemPath);
          undo.unshift(() => fsp.unlink(itemPath));
          linked.push(`${name}/${item}`);
        }
      }
    } catch (err) {
      // Put this profile back exactly as it was; earlier profiles stay shared.
      for (const step of undo) {
        try { await step(); } catch {}
      }
      err.completed = completed;
      throw err;
    }
    completed.push(name);
  }
  return { completed, copied: result.copies.length, dropped: result.dropped.length, backups, linked };
}

async function countTranscriptsNewerThan(directory, sinceMs) {
  let count = 0;
  for (const slug of await readdirSafe(directory)) {
    for (const file of await readdirSafe(path.join(directory, slug))) {
      if (!file.endsWith('.jsonl')) continue;
      const info = await lstatOrNull(path.join(directory, slug, file));
      if (info && info.isFile() && info.mtimeMs > sinceMs) count += 1;
    }
  }
  return count;
}

/**
 * Undo sharing: remove each profile's link and rename its `.pre-share` backup
 * back (an item that had no sessions before is just unlinked). Sessions created after the migration stay in the shared folder (they
 * cannot be attributed to one profile); their number is reported.
 *
 * @returns {Promise<{ restored: string[], unlinked: string[], newerSessions: number }>}
 */
async function rollback({ profiles, sharedDir, isAlive = defaultIsAlive, items = SHARED_SESSION_ITEMS, dryRun = false }) {
  const live = await findLiveProcesses(profiles, isAlive);
  if (live.length > 0) throw liveError(live);

  const restored = [];
  const unlinked = [];
  let since = null;
  const jobs = [];
  for (const { name, dir } of profiles) {
    for (const item of items) {
      const state = await sessionItemState(dir, sharedDir, item);
      const backup = `${path.join(dir, item)}${BACKUP_SUFFIX}`;
      const hasBackup = Boolean(await lstatOrNull(backup));
      if (state === 'foreign' || (state === 'local' && hasBackup)) {
        const error = new Error(`${name}: ${item} is in an unexpected state; nothing was changed. Fix it by hand or restore ${item}${BACKUP_SUFFIX}.`);
        throw error;
      }
      jobs.push({ name, item, state, backup, hasBackup, link: path.join(dir, item) });
    }
  }
  for (const job of jobs) {
    if (job.state !== 'linked') continue;
    if (job.item === 'projects' && job.hasBackup) {
      // The link was created at migration time; copies kept their old mtimes.
      const info = await fsp.lstat(job.link);
      const created = info.birthtimeMs || info.ctimeMs;
      since = since === null ? created : Math.min(since, created);
    }
    if (dryRun) {
      (job.hasBackup ? restored : unlinked).push(`${job.name}/${job.item}`);
      continue;
    }
    await fsp.unlink(job.link);
    if (job.hasBackup) {
      await fsp.rename(job.backup, job.link);
      restored.push(`${job.name}/${job.item}`);
    } else {
      unlinked.push(`${job.name}/${job.item}`);
    }
  }
  const newerSessions = since === null ? 0 : await countTranscriptsNewerThan(path.join(sharedDir, 'projects'), since);
  return { restored, unlinked, newerSessions };
}

module.exports = { plan, apply, rollback, findLiveProcesses, defaultIsAlive, compareFiles, BACKUP_SUFFIX };
