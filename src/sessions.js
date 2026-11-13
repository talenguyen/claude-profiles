const fsp = require('node:fs/promises');
const path = require('node:path');

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Detect whether Claude arguments resume an earlier session.
 * @param {string[]} args
 * @returns {{ kind: 'id', id: string } | { kind: 'continue' } | { kind: 'picker' } | null}
 */
function parseResumeIntent(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--continue' || arg === '-c') return { kind: 'continue' };
    let value;
    if (arg === '--resume' || arg === '-r') {
      const next = args[i + 1];
      value = next !== undefined && !next.startsWith('-') ? next : undefined;
    } else if (arg.startsWith('--resume=')) {
      value = arg.slice('--resume='.length);
    } else {
      continue;
    }
    // A value that is not a session id is a search term for Claude's picker.
    return value !== undefined && SESSION_ID.test(value) ? { kind: 'id', id: value } : { kind: 'picker' };
  }
  return null;
}

// Claude names a project directory after the absolute cwd, with `/` and `.` as `-`.
function projectSlug(cwd) {
  return cwd.replace(/[/.]/g, '-');
}

async function readdirSafe(directory, fs) {
  try { return await fs.readdir(directory); } catch { return []; }
}

async function statMtime(file, fs) {
  try { return (await fs.stat(file)).mtimeMs; } catch { return null; }
}

async function realpathOr(directory, fs) {
  try { return await fs.realpath(directory); } catch { return null; }
}

/**
 * Group profiles by the real location of their `projects/` directory. Profiles
 * that share sessions resolve to the same directory and form one group.
 */
async function groupByProjects(profiles, fs) {
  const groups = new Map();
  for (const profile of profiles) {
    const projectsDir = path.join(profile.configDir, 'projects');
    const key = (await realpathOr(projectsDir, fs)) || projectsDir;
    if (!groups.has(key)) groups.set(key, { projectsDir: key, names: [] });
    groups.get(key).names.push(profile.name);
  }
  return [...groups.values()];
}

/**
 * Find a session's transcript and the profiles that can continue it.
 *
 * Transcripts live in a profile's `projects/` directory. Profiles whose
 * `projects/` resolve to the same directory share sessions, so every member of
 * the group that holds the transcript is an owner. For `continue` the group
 * with the newest transcript for this directory wins.
 *
 * @param {object} args
 * @param {Array<{ name: string, configDir: string }>} args.profiles
 * @param {{ kind: 'id', id: string } | { kind: 'continue' }} args.intent
 * @param {string} args.cwd
 * @param {typeof fsp} [args.fs]
 * @returns {Promise<{ owners: string[], transcript: string | null }>} Owning profile
 *   names in the order given, and the transcript path; empty and null when none own it.
 */
async function locateSession({ profiles, intent, cwd, fs = fsp }) {
  const groups = await groupByProjects(profiles, fs);

  if (intent.kind === 'id') {
    const owners = new Set();
    let transcript = null;
    let newest = -Infinity;
    for (const { projectsDir, names } of groups) {
      for (const slug of await readdirSafe(projectsDir, fs)) {
        const file = path.join(projectsDir, slug, `${intent.id}.jsonl`);
        const mtime = await statMtime(file, fs);
        if (mtime === null) continue;
        names.forEach((name) => owners.add(name));
        if (mtime > newest) { newest = mtime; transcript = file; }
      }
    }
    return { owners: profiles.map((profile) => profile.name).filter((name) => owners.has(name)), transcript };
  }

  let newest = null;
  for (const { projectsDir, names } of groups) {
    const directory = path.join(projectsDir, projectSlug(cwd));
    for (const file of await readdirSafe(directory, fs)) {
      if (!file.endsWith('.jsonl')) continue;
      const mtime = await statMtime(path.join(directory, file), fs);
      if (mtime !== null && (newest === null || mtime > newest.mtime)) newest = { names, mtime, transcript: path.join(directory, file) };
    }
  }
  if (!newest) return { owners: [], transcript: null };
  return {
    owners: profiles.map((profile) => profile.name).filter((name) => newest.names.includes(name)),
    transcript: newest.transcript
  };
}

/** Names of the profiles that can continue a session; see {@link locateSession}. */
async function findSessionOwners(args) {
  return (await locateSession(args)).owners;
}

/**
 * True when the profile's `projects/` is the shared sessions folder, so its
 * `--resume` picker lists every shared session.
 */
async function projectsAreShared({ configDir, sharedSessionsDir, fs = fsp }) {
  if (!sharedSessionsDir) return false;
  const own = await realpathOr(path.join(configDir, 'projects'), fs);
  const shared = await realpathOr(path.join(sharedSessionsDir, 'projects'), fs);
  return own !== null && own === shared;
}

const TAIL_BLOCK = 512 * 1024;
const MAX_TAIL_SCAN = 64 * 1024 * 1024;

// A transcript row that names the organization a run was billed to: the
// `session-owner` row, or a `credential_org` attachment appended on every run.
function organizationOf(row) {
  if (row === null || typeof row !== 'object') return null;
  const holder = row.attachment && typeof row.attachment === 'object' ? row.attachment : row;
  const isOrgRow = row.type === 'session-owner' || holder.type === 'credential_org';
  return isOrgRow && typeof holder.organizationUuid === 'string' && holder.organizationUuid ? holder.organizationUuid : null;
}

/**
 * Read the organization a session was last used under: the last
 * `session-owner` or `credential_org` row of its transcript. Reads from the end
 * in blocks, so a large transcript costs only its tail. The id is returned to
 * the caller for comparison only and must never be printed.
 *
 * @param {string} file
 * @param {typeof fsp} [fs]
 * @returns {Promise<string | null>} null when the transcript has no such row.
 */
async function readLastOrganization(file, fs = fsp) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    let position = size;
    let carry = Buffer.alloc(0);
    while (position > 0 && size - position < MAX_TAIL_SCAN) {
      const length = Math.min(TAIL_BLOCK, position);
      position -= length;
      const block = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(block, 0, length, position);
      const data = Buffer.concat([block.subarray(0, bytesRead), carry]);
      // The first line may be cut by the block boundary; keep its bytes for the next read.
      let complete = data;
      if (position > 0) {
        const firstNewline = data.indexOf(0x0a);
        if (firstNewline === -1) { carry = data; continue; }
        carry = data.subarray(0, firstNewline);
        complete = data.subarray(firstNewline + 1);
      } else {
        carry = Buffer.alloc(0);
      }
      let end = complete.length;
      for (;;) {
        const start = end === 0 ? 0 : complete.lastIndexOf(0x0a, end - 1) + 1;
        const line = complete.toString('utf8', start, end);
        if (line.includes('session-owner') || line.includes('credential_org')) {
          let row;
          try { row = JSON.parse(line); } catch { row = null; }
          const organization = organizationOf(row);
          if (organization) return organization;
        }
        if (start === 0) break;
        end = start - 1;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close();
  }
}

module.exports = { parseResumeIntent, findSessionOwners, locateSession, projectsAreShared, readLastOrganization, projectSlug };
