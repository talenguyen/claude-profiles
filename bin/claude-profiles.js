#!/usr/bin/env node
const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

function spawnInteractive(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${file} exited with code ${code}.`));
    });
    child.on('error', reject);
  });
}

// Probe children get piped stdin/stdout and no stderr: their output is parsed
// by src/usage.js and never forwarded to the terminal.
function spawnProbe(file, args, options) {
  return spawn(file, args, { ...options, stdio: ['pipe', 'pipe', 'ignore'] });
}

function runSecurity(args) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', args, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function promptConfirm(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin || !process.stdin.isTTY) {
      reject(new Error('Confirmation requires an interactive terminal.'));
      return;
    }
    process.stdout.write(prompt);
    let input = '';
    const onData = (chunk) => {
      for (const byte of chunk) {
        if (byte === 0x0A || byte === 0x0D) {
          process.stdin.removeListener('data', onData);
          process.stdin.pause();
          resolve(input);
          return;
        }
        input += String.fromCharCode(byte);
      }
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

async function buildDependencies({ home = os.homedir() } = {}) {
  const { createRegistry } = require('../src/registry.js');
  const { createKeychain } = require('../src/keychain.js');
  const { promptHidden, authenticateProfile, logoutProfile } = require('../src/auth.js');
  const { resolveClaude } = require('../src/launcher.js');
  const { materializeProfileConfig, removeProfileConfig, hasProfileAuth, readProfileState } = require('../src/config.js');

  const configHome = path.join(home, '.config', 'claude-profiles');
  const baseConfigDir = path.join(home, '.claude');
  const profilesConfigDir = path.join(configHome, 'configs');
  const baseStateFile = path.join(baseConfigDir, '.claude.json');
  // Shared session history lives beside the profile configs, never in a project repo.
  const sharedSessionsDir = path.join(configHome, 'shared');

  const registry = createRegistry({ configHome });
  const keychain = createKeychain({ runSecurity });

  return {
    registry,
    keychain,
    spawnInteractive,
    promptHidden,
    resolveClaude,
    materializeProfileConfig,
    authenticateProfile,
    logoutProfile,
    removeProfileConfig,
    hasProfileAuth,
    readProfileState,
    spawnProbe,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    configHome,
    baseConfigDir,
    baseStateFile,
    profilesConfigDir,
    sharedSessionsDir,
    env: process.env,
    print: (text) => process.stdout.write(`${text}\n`),
    printErr: (text) => process.stderr.write(`${text}\n`),
    confirm: promptConfirm
  };
}

if (require.main === module) {
  (async () => {
    try {
      const { run } = require('../src/commands.js');
      await run(process.argv.slice(2), await buildDependencies());
    } catch (error) {
      process.stderr.write(`${error && error.message ? error.message : error}\n`);
      process.exit(Number.isInteger(error && error.exitCode) ? error.exitCode : 1);
    }
  })();
}

module.exports = { buildDependencies };
