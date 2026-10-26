const fs = require('node:fs');
const path = require('node:path');
const { sanitizeEnvironment } = require('./environment.js');

/**
 * Replace the current process with the Claude CLI, carrying only the config
 * directory necessary for the selected profile. All other
 * authentication-provider variables are stripped before the execve call so
 * the subprocess cannot inherit credentials that would override isolation.
 *
 * @param {object} deps
 * @param {string} deps.claudePath - Absolute path to the Claude binary.
 * @param {string[]} deps.args - Arguments to forward to Claude.
 * @param {string} deps.configDir - Absolute path to the per-profile config.
 * @param {Record<string, string>} deps.env - Environment to sanitize before execve.
 * @param {typeof process.execve} [deps.execve] - Test seam for the real syscall.
 */
function launchClaude({ claudePath, args, configDir, env, execve = process.execve }) {
  const clean = sanitizeEnvironment(env);
  execve(claudePath, [claudePath, ...args], { ...clean, CLAUDE_CONFIG_DIR: configDir });
}

/**
 * Locate the Claude CLI by scanning the directories listed in `env.PATH` and
 * returning the first executable match. Splits on `:` exactly so callers can
 * supply an isolated `env` without depending on the host PATH.
 *
 * @param {object} deps
 * @param {Record<string, string>} deps.env - Environment whose PATH is scanned.
 * @param {(path: string, mode: number) => Promise<void>} deps.access - fs.access seam.
 * @returns {Promise<string>} Absolute path to the Claude binary.
 */
async function resolveClaude({ env, access = fs.promises.access }) {
  const pathValue = env && env.PATH;
  if (typeof pathValue !== 'string' || pathValue.length === 0) {
    throw new Error('Cannot locate Claude binary: PATH is not set.');
  }
  const errors = [];
  for (const dir of pathValue.split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, 'claude');
    try {
      await access(candidate, fs.constants.X_OK);
      return candidate;
    } catch (err) {
      errors.push(`${candidate}: ${err && err.code ? err.code : 'unreachable'}`);
    }
  }
  throw new Error('Cannot locate Claude binary: no executable on PATH.');
}

module.exports = { launchClaude, resolveClaude };
