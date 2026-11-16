const fsp = require('node:fs/promises');
const path = require('node:path');

/** True when a process with this pid exists (EPERM still means it exists). */
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

async function readdirSafe(directory) {
  try { return await fsp.readdir(directory); } catch { return []; }
}

/**
 * Claude records each running process as `<config>/sessions/<pid>.json`.
 * Anything that rewrites a profile's config tree (session folders, shared
 * config links) refuses while one of those processes is alive.
 *
 * @param {{ name: string, dir: string }[]} profiles
 * @param {(pid: number) => boolean} isAlive
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

module.exports = { defaultIsAlive, findLiveProcesses, readdirSafe };
