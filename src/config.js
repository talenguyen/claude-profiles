const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateProfile } = require('./profile.js');

const SHARED_ITEMS = ['settings.json', 'settings.local.json', 'skills', 'plugins', 'commands', 'hooks', 'history'];

async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
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

async function materializeProfileConfig({ baseConfigDir, baseStateFile, profilesConfigDir, profile }) {
  validateProfile(profile);

  const target = path.resolve(profilesConfigDir, profile);
  try {
    const targetStat = await fsp.stat(target);
    if (!targetStat.isDirectory()) {
      throw new Error('Cannot establish account isolation: existing profile config is not a directory.');
    }
    await fsp.chmod(target, 0o700);
    return target;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
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

module.exports = { materializeProfileConfig, removeProfileConfig, hasProfileAuth };
