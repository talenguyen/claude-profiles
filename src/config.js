const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateProfile } = require('./profile.js');

// Linked into every profile from the base Claude config. `history.jsonl` is
// deliberately absent: it stays per profile (prompt recall only).
const SHARED_ITEMS = ['settings.json', 'settings.local.json', 'skills', 'plugins', 'commands', 'hooks'];

// Session history. These link to a folder shared between opted-in profiles
// (never to the base config), so a conversation can continue on another profile.
const SHARED_SESSION_ITEMS = ['projects', 'file-history'];

async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function lstatOrNull(filePath) {
  try {
    return await fsp.lstat(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function realpathOrResolve(filePath) {
  try {
    return await fsp.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

async function ensureSharedItemDir(sharedSessionsDir, item) {
  const root = path.resolve(sharedSessionsDir);
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  await fsp.chmod(root, 0o700);
  const itemDir = path.join(root, item);
  await fsp.mkdir(itemDir, { recursive: true, mode: 0o700 });
  await fsp.chmod(itemDir, 0o700);
  return itemDir;
}

/**
 * Classify how one session item (`projects`, `file-history`) of a profile
 * relates to the shared folder, without changing anything.
 *
 * @returns {Promise<'missing' | 'linked' | 'local' | 'foreign'>}
 *   `linked`: already a symlink to the shared folder. `local`: a real
 *   directory of private sessions. `foreign`: a symlink elsewhere, or not a
 *   directory at all.
 */
async function sessionItemState(target, sharedSessionsDir, item) {
  const link = path.join(target, item);
  const info = await lstatOrNull(link);
  if (!info) return 'missing';
  if (info.isSymbolicLink()) {
    const wanted = await realpathOrResolve(path.join(sharedSessionsDir, item));
    // A link whose target is gone still counts when it points at the shared folder.
    let actual;
    try {
      actual = await fsp.realpath(link);
    } catch {
      actual = path.resolve(path.dirname(link), await fsp.readlink(link));
    }
    return actual === wanted ? 'linked' : 'foreign';
  }
  return info.isDirectory() ? 'local' : 'foreign';
}

/**
 * Link an existing profile's session items to the shared folder.
 *
 *  - missing: create the symlink;
 *  - already linked: nothing;
 *  - a real directory: never migrated here (that is `share-sessions`), reported;
 *  - a symlink elsewhere: refused.
 *
 * @returns {Promise<{ needsMigration: string[] }>} Items that still hold private sessions.
 */
async function linkSharedSessions(target, sharedSessionsDir, items = SHARED_SESSION_ITEMS) {
  const states = [];
  for (const item of items) states.push([item, await sessionItemState(target, sharedSessionsDir, item)]);
  const foreign = states.filter(([, state]) => state === 'foreign').map(([item]) => item);
  if (foreign.length > 0) {
    throw new Error(`Cannot share sessions: ${foreign.join(', ')} in the profile config is not a link to the shared sessions folder.`);
  }
  const needsMigration = [];
  for (const [item, state] of states) {
    if (state === 'local') {
      needsMigration.push(item);
    } else {
      // Also for an existing link: the shared folder may have been deleted since.
      const itemDir = await ensureSharedItemDir(sharedSessionsDir, item);
      if (state === 'missing') await fsp.symlink(itemDir, path.join(target, item));
    }
  }
  return { needsMigration };
}

async function existingOAuthAccount(target) {
  try {
    const raw = await fsp.readFile(path.join(target, '.claude.json'), 'utf8');
    const state = JSON.parse(raw);
    if (state === null || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('Cannot establish account isolation: existing profile state is malformed.');
    }
    return state.oauthAccount;
  } catch (err) {
    if (err && err.code === 'ENOENT') return undefined;
    if (err instanceof SyntaxError) throw new Error('Cannot establish account isolation: existing profile state is malformed.');
    throw err;
  }
}

/**
 * @param {object} args
 * @param {'shared' | 'private'} [args.sessions] - `shared` links `projects` and
 *   `file-history` into `sharedSessionsDir`; anything else keeps them private.
 * @param {string} [args.sharedSessionsDir]
 * @param {(text: string) => void} [args.warn] - Receives non-fatal notices.
 */
async function materializeProfileConfig({
  baseConfigDir, baseStateFile, profilesConfigDir, profile, sessions = 'private', sharedSessionsDir, warn = () => {}
}) {
  validateProfile(profile);
  const shareSessions = sessions === 'shared';
  if (shareSessions && !sharedSessionsDir) throw new Error('Cannot share sessions: no shared sessions folder is configured.');

  const target = path.resolve(profilesConfigDir, profile);
  let existing = false;
  try {
    const targetStat = await fsp.stat(target);
    if (!targetStat.isDirectory()) {
      throw new Error('Cannot establish account isolation: existing profile config is not a directory.');
    }
    await fsp.chmod(target, 0o700);
    existing = true;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  if (existing) {
    if (shareSessions) {
      const { needsMigration } = await linkSharedSessions(target, sharedSessionsDir);
      if (needsMigration.length > 0) {
        warn(`warning: ${profile} is set to share sessions but ${needsMigration.join(', ')} still hold private sessions; run: claude-profiles share-sessions ${profile}`);
      }
    }
    return target;
  }

  const targetParent = path.dirname(target);
  const stagingName = `.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const staging = path.join(targetParent, stagingName);
  const backup = `${target}.backup`;

  let backupMoved = false;

  try {
    await fsp.mkdir(staging, { recursive: true, mode: 0o700 });
    await fsp.chmod(staging, 0o700);

    for (const item of SHARED_ITEMS) {
      const source = path.join(baseConfigDir, item);
      if (await exists(source)) await fsp.symlink(source, path.join(staging, item));
    }
    if (shareSessions) {
      for (const item of SHARED_SESSION_ITEMS) {
        await fsp.symlink(await ensureSharedItemDir(sharedSessionsDir, item), path.join(staging, item));
      }
    }

    let stateRaw;
    try {
      stateRaw = await fsp.readFile(baseStateFile, 'utf8');
    } catch {
      throw new Error('Cannot establish account isolation: base state file is missing.');
    }

    let state;
    try {
      state = JSON.parse(stateRaw);
    } catch {
      throw new Error('Cannot establish account isolation: base state file is malformed.');
    }

    if (state === null || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('Cannot establish account isolation: base state file is malformed.');
    }

    delete state.oauthAccount;
    // The usage cache belongs to the base account; never inherit it.
    delete state.cachedUsageUtilization;
    const statePath = path.join(staging, '.claude.json');
    await fsp.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fsp.chmod(statePath, 0o600);

    try {
      await fsp.rename(target, backup);
      backupMoved = true;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }

    try {
      await fsp.rename(staging, target);
    } catch (renameErr) {
      let restored = false;
      if (backupMoved) {
        try {
          await fsp.rename(backup, target);
          restored = true;
        } catch {}
      }
      if (!restored && backupMoved) {
        throw new Error('Cannot establish account isolation: failed to restore previous profile config.');
      }
      throw new Error('Cannot establish account isolation: failed to materialize profile config.');
    }

    if (backupMoved) {
      await fsp.rm(backup, { recursive: true, force: true });
    }

    await fsp.chmod(target, 0o700);
    return target;
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

/**
 * Read only the account metadata and usage cache that auto mode needs from a
 * profile's `.claude.json`. Returns null when the file is missing or unusable.
 */
async function readProfileState(configDir) {
  try {
    const state = JSON.parse(await fsp.readFile(path.join(configDir, '.claude.json'), 'utf8'));
    if (state === null || typeof state !== 'object' || Array.isArray(state)) return null;
    return { oauthAccount: state.oauthAccount, cachedUsageUtilization: state.cachedUsageUtilization };
  } catch {
    return null;
  }
}

async function removeProfileConfig({ profilesConfigDir, profile }) {
  validateProfile(profile);
  const target = path.resolve(profilesConfigDir, profile);
  await fsp.rm(target, { recursive: true, force: true });
}

async function hasProfileAuth({ profilesConfigDir, profile }) {
  validateProfile(profile);
  const target = path.resolve(profilesConfigDir, profile);
  return (await existingOAuthAccount(target)) !== undefined;
}

module.exports = {
  materializeProfileConfig, removeProfileConfig, hasProfileAuth, readProfileState,
  linkSharedSessions, sessionItemState, SHARED_ITEMS, SHARED_SESSION_ITEMS
};
