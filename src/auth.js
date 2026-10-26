const { sanitizeEnvironment } = require('./environment.js');

const CR = 0x0D;
const LF = 0x0A;
const CTRL_C = 0x03;
const BACKSPACE = 0x08;
const DELETE = 0x7F;

async function promptHidden(prompt = 'Token: ') {
  if (!process.stdin || !process.stdin.isTTY || !process.stdout || !process.stdout.isTTY) {
    throw new Error('Hidden prompt requires an interactive terminal.');
  }

  process.stdout.write(prompt);

  let rawMode = false;
  try {
    process.stdin.setRawMode(true);
    rawMode = true;

    return await new Promise((resolve, reject) => {
      let input = '';

      const onData = (chunk) => {
        for (const byte of chunk) {
          if (byte === CR || byte === LF) {
            process.stdin.removeListener('data', onData);
            process.stdout.write('\n');
            const token = input.trim();
            if (!token) reject(new Error('Token is empty.'));
            else resolve(token);
            return;
          }
          if (byte === CTRL_C) {
            process.stdin.removeListener('data', onData);
            process.stdout.write('\n');
            reject(new Error('Cancelled.'));
            return;
          }
          if (byte === BACKSPACE || byte === DELETE) {
            if (input.length > 0) input = input.slice(0, -1);
            continue;
          }
          input += String.fromCharCode(byte);
        }
      };

      process.stdin.on('data', onData);
    });
  } finally {
    if (rawMode) {
      try { process.stdin.setRawMode(false); } catch {}
    }
  }
}

/**
 * Run Claude's native subscription login inside one isolated profile config.
 *
 * @param {object} deps
 * @param {string} deps.claudePath - Absolute path to the Claude binary.
 * @param {(file: string, args: string[], options: { env: Record<string, string> }) => Promise<void>} deps.spawnInteractive
 *   Resolves when the child exits with code 0; rejects otherwise. Awaits the
 *   subprocess so the exit code is observed before the login completes.
 * @param {string} deps.configDir - Absolute per-profile Claude config directory.
 * @param {Record<string, string>} deps.env - Environment to sanitize before
 *   spawning the subprocess.
 */
async function authenticateProfile({ claudePath, spawnInteractive, configDir, env }) {
  const cleanEnv = sanitizeEnvironment(env);
  await spawnInteractive(claudePath, ['auth', 'login', '--claudeai'], { env: { ...cleanEnv, CLAUDE_CONFIG_DIR: configDir } });
}

async function logoutProfile({ claudePath, spawnInteractive, configDir, env }) {
  const cleanEnv = sanitizeEnvironment(env);
  await spawnInteractive(claudePath, ['auth', 'logout'], { env: { ...cleanEnv, CLAUDE_CONFIG_DIR: configDir } });
}

module.exports = { authenticateProfile, logoutProfile, promptHidden };
