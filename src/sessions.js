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

/**
 * Find the profiles that own a session. Transcripts live in each profile's own
 * `projects/` directory, so a session is invisible to every other profile.
 *
 * @param {object} args
 * @param {Array<{ name: string, configDir: string }>} args.profiles
 * @param {{ kind: 'id', id: string } | { kind: 'continue' }} args.intent
 * @param {string} args.cwd
 * @param {typeof fsp} [args.fs]
 * @returns {Promise<string[]>} Owning profile names; empty when none own it.
 */
async function findSessionOwners({ profiles, intent, cwd, fs = fsp }) {
  if (intent.kind === 'id') {
    const owners = [];
    for (const { name, configDir } of profiles) {
      const projectsDir = path.join(configDir, 'projects');
      for (const slug of await readdirSafe(projectsDir, fs)) {
        if ((await statMtime(path.join(projectsDir, slug, `${intent.id}.jsonl`), fs)) !== null) {
          owners.push(name);
          break;
        }
      }
    }
    return owners;
  }

  let newest = null;
  for (const { name, configDir } of profiles) {
    const directory = path.join(configDir, 'projects', projectSlug(cwd));
    for (const file of await readdirSafe(directory, fs)) {
      if (!file.endsWith('.jsonl')) continue;
      const mtime = await statMtime(path.join(directory, file), fs);
      if (mtime !== null && (newest === null || mtime > newest.mtime)) newest = { name, mtime };
    }
  }
  return newest ? [newest.name] : [];
}

module.exports = { parseResumeIntent, findSessionOwners, projectSlug };
