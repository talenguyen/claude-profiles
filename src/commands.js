const { launchClaude } = require('./launcher.js');
const path = require('node:path');

const COMMANDS = new Set(['add', 'list', 'status', 'use', 'refresh', 'remove', 'help', '--help', '-h']);

const HELP_TEXT = `Usage: claude-profiles <command>

Commands:
  add <profile>                    Create a profile and sign in with Claude
  list                             List profiles and auth metadata status
  status [profile]                 Show auth metadata status
  use <profile> [claude args...]   Launch Claude with a profile
  refresh <profile>                Sign in again for a profile
  remove <profile>                 Remove a profile after confirmation
  help, --help, -h                 Show this help

New profiles use Claude's native login. On first use, complete the one-time
Claude onboarding screens for that profile; subsequent launches skip login.`;

function parseArgs(argv) {
  if (!Array.isArray(argv)) throw new Error('Usage: arguments must be an array.');
  const dashIndex = argv.indexOf('--');
  if (dashIndex === -1) return { positional: argv.slice(), passthrough: [] };
  return {
    positional: argv.slice(0, dashIndex),
    passthrough: argv.slice(dashIndex + 1)
  };
}

// `use <profile> [args...]`: the first token is the profile; every later token
// is forwarded to Claude verbatim. A single leading `--` is an optional
// separator and is dropped, so `use <profile> -- <args>` keeps its meaning.
function parseUseArgs(argv) {
  if (!Array.isArray(argv)) throw new Error('Usage: arguments must be an array.');
  const [name, ...tail] = argv;
  const positional = name && !name.startsWith('-') ? [name] : [];
  const passthrough = tail[0] === '--' ? tail.slice(1) : tail;
  return { positional, passthrough };
}

function defaultPrint(text) {
  if (typeof text !== 'string') return;
  process.stdout.write(`${text}\n`);
}

async function reportPresence({ print, hasProfileAuth, profilesConfigDir, name }) {
  const present = await hasProfileAuth({ profilesConfigDir, profile: name });
  print(`${name}: ${present ? 'present' : 'missing'}`);
}

async function addCommand(positional, deps) {
  const name = positional[0];
  if (!name) throw new Error('Usage: add <profile>');

  try {
    await deps.registry.get(name);
    throw new Error('Profile already exists.');
  } catch (err) {
    if (err && err.message !== 'Profile not found.') throw err;
  }

  const claudePath = await deps.resolveClaude({ env: deps.env });
  const configDir = await deps.materializeProfileConfig({
    baseConfigDir: deps.baseConfigDir,
    baseStateFile: deps.baseStateFile,
    profilesConfigDir: deps.profilesConfigDir,
    profile: name
  });
  await deps.authenticateProfile({
    claudePath,
    spawnInteractive: deps.spawnInteractive,
    configDir,
    env: deps.env
  });
  await deps.registry.add(name);
}

async function listCommand(deps) {
  const profiles = await deps.registry.list();
  for (const { name } of profiles) {
    await reportPresence({ print: deps.print, hasProfileAuth: deps.hasProfileAuth, profilesConfigDir: deps.profilesConfigDir, name });
  }
}

async function statusCommand(positional, deps) {
  const [name] = positional;
  if (name) {
    await reportPresence({ print: deps.print, hasProfileAuth: deps.hasProfileAuth, profilesConfigDir: deps.profilesConfigDir, name });
    return;
  }
  const profiles = await deps.registry.list();
  for (const { name } of profiles) {
    await reportPresence({ print: deps.print, hasProfileAuth: deps.hasProfileAuth, profilesConfigDir: deps.profilesConfigDir, name });
  }
}

async function useCommand(positional, passthrough, deps) {
  const name = positional[0];
  if (!name) throw new Error('Usage: use <profile> [claude arguments...]');

  const profile = await deps.registry.get(name);
  const configDir = await deps.materializeProfileConfig({
    baseConfigDir: deps.baseConfigDir,
    baseStateFile: deps.baseStateFile,
    profilesConfigDir: deps.profilesConfigDir,
    profile: name
  });
  const claudePath = await deps.resolveClaude({ env: deps.env });
  const launch = deps.launchClaude || launchClaude;
  launch({
    claudePath,
    args: passthrough,
    configDir,
    env: deps.env,
    execve: deps.execve
  });
}

async function refreshCommand(positional, deps) {
  const name = positional[0];
  if (!name) throw new Error('Usage: refresh <profile>');

  await deps.registry.get(name);
  const claudePath = await deps.resolveClaude({ env: deps.env });
  const configDir = await deps.materializeProfileConfig({
    baseConfigDir: deps.baseConfigDir,
    baseStateFile: deps.baseStateFile,
    profilesConfigDir: deps.profilesConfigDir,
    profile: name
  });
  await deps.authenticateProfile({
    claudePath,
    spawnInteractive: deps.spawnInteractive,
    configDir,
    env: deps.env
  });
}

async function removeCommand(positional, deps) {
  const name = positional[0];
  if (!name) throw new Error('Usage: remove <profile>');

  const profile = await deps.registry.get(name);
  const answer = await deps.confirm('Type the profile name to remove it: ');
  if (answer !== name) return;

  const configDir = path.join(deps.profilesConfigDir, name);
  const claudePath = await deps.resolveClaude({ env: deps.env });
  await deps.logoutProfile({ claudePath, spawnInteractive: deps.spawnInteractive, configDir, env: deps.env });
  await deps.removeProfileConfig({ profilesConfigDir: deps.profilesConfigDir, profile: name });
  await deps.registry.remove(name);
}

async function run(argv, deps = {}) {
  if (!Array.isArray(argv)) throw new Error('Usage: arguments must be an array.');

  const [command, ...rest] = argv;
  if (!COMMANDS.has(command)) {
    throw new Error(`Usage: unknown command "${command}". Valid commands: ${[...COMMANDS].join(', ')}.`);
  }

  const print = deps.print || defaultPrint;

  if (command === 'use') {
    const { positional, passthrough } = parseUseArgs(rest);
    return useCommand(positional, passthrough, deps);
  }

  const { positional } = parseArgs(rest);

  switch (command) {
    case 'add': return addCommand(positional, { ...deps, print });
    case 'list': return listCommand({ ...deps, print });
    case 'status': return statusCommand(positional, { ...deps, print });
    case 'refresh': return refreshCommand(positional, deps);
    case 'remove': return removeCommand(positional, deps);
    case 'help':
    case '--help':
    case '-h':
      print(HELP_TEXT);
      return;
    default:
      throw new Error('Usage: unreachable.');
  }
}

module.exports = { run };
