const { launchClaude } = require('./launcher.js');
const { parseTier } = require('./tier.js');
const { collectUsage } = require('./usage.js');
const { rankProfiles, formatReset, formatIn } = require('./select.js');
const { parseResumeIntent, findSessionOwners } = require('./sessions.js');
const path = require('node:path');

const COMMANDS = new Set(['add', 'list', 'status', 'use', 'usage', 'tier', 'refresh', 'remove', 'help', '--help', '-h']);

// Exit status when auto mode refuses to launch because nothing has capacity.
const EXIT_EXHAUSTED = 3;

const HELP_TEXT = `Usage: claude-profiles <command>

Commands:
  add <profile> [--tier <tier>]    Create a profile and sign in with Claude
  list                             List profiles and auth metadata status
  status [profile]                 Show auth metadata status
  use <profile> [claude args...]   Launch Claude with a profile
  use --auto [--force] [claude args...]
                                   Launch the profile with the most capacity left
  usage [--json]                   Show each profile's usage and capacity
  tier <profile> <tier>            Set a profile's plan tier
  refresh <profile>                Sign in again for a profile
  remove <profile>                 Remove a profile after confirmation
  help, --help, -h                 Show this help

New profiles use Claude's native login. On first use, complete the one-time
Claude onboarding screens for that profile; subsequent launches skip login.

Auto mode picks once at launch: capacity = tier weight x the smaller of the
5-hour and weekly remaining share. Tiers: pro, team-standard, team-premium,
max5x, max20x, custom:<n>. Usage comes from Claude's experimental get_usage
API. With --resume/--continue, auto mode picks the profile that owns the
session. If every profile is exhausted it asks first (non-interactive: exits
with status 3); --force launches anyway.`;

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
//
// `use --auto [--force] [args...]` takes the profile slot: leading `--auto` and
// `--force` flags (either order) are consumed and everything after them is
// forwarded. A profile name cannot start with `-`, so `--auto` never collides.
function parseUseArgs(argv) {
  if (!Array.isArray(argv)) throw new Error('Usage: arguments must be an array.');
  let index = 0;
  let auto = false;
  let force = false;
  while (index < argv.length && (argv[index] === '--auto' || argv[index] === '--force')) {
    if (argv[index] === '--auto') auto = true;
    else force = true;
    index += 1;
  }
  if (force && !auto) throw new Error('Usage: --force requires --auto.');
  if (auto) {
    const tail = argv.slice(index);
    return { positional: [], passthrough: tail[0] === '--' ? tail.slice(1) : tail, auto, force };
  }
  const [name, ...tail] = argv;
  const positional = name && !name.startsWith('-') ? [name] : [];
  const passthrough = tail[0] === '--' ? tail.slice(1) : tail;
  return { positional, passthrough, auto: false, force: false };
}

// `add <profile> [--tier <tier>]`
function parseAddArgs(positional) {
  const names = [];
  let tier;
  for (let i = 0; i < positional.length; i += 1) {
    const arg = positional[i];
    if (arg === '--tier') {
      tier = positional[i + 1];
      if (tier === undefined) throw new Error('Usage: add <profile> [--tier <tier>]');
      i += 1;
    } else if (arg.startsWith('--tier=')) {
      tier = arg.slice('--tier='.length);
    } else if (arg.startsWith('-')) {
      throw new Error(`Usage: unknown option "${arg}". Usage: add <profile> [--tier <tier>]`);
    } else {
      names.push(arg);
    }
  }
  if (tier !== undefined) tier = parseTier(tier).tier;
  return { name: names[0], tier };
}

function defaultPrint(text) {
  if (typeof text !== 'string') return;
  process.stdout.write(`${text}\n`);
}

function defaultPrintErr(text) {
  if (typeof text !== 'string') return;
  process.stderr.write(`${text}\n`);
}

async function reportPresence({ print, hasProfileAuth, profilesConfigDir, name }) {
  const present = await hasProfileAuth({ profilesConfigDir, profile: name });
  print(`${name}: ${present ? 'present' : 'missing'}`);
}

async function addCommand(positional, deps) {
  const { name, tier } = parseAddArgs(positional);
  if (!name) throw new Error('Usage: add <profile> [--tier <tier>]');

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
  await deps.registry.add(name, tier === undefined ? undefined : { tier });
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

async function launchProfile(name, passthrough, deps) {
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

async function useCommand(positional, passthrough, deps) {
  const name = positional[0];
  if (!name) throw new Error('Usage: use <profile> [claude arguments...] | use --auto [--force] [claude arguments...]');

  await deps.registry.get(name);
  await launchProfile(name, passthrough, deps);
}

function exhaustedError(message) {
  const error = new Error(message);
  error.exitCode = EXIT_EXHAUSTED;
  return error;
}

function freesAt(entry, now) {
  return entry.availableAt == null
    ? 'reset time unknown'
    : `frees at ${formatReset(entry.availableAt, now)} (in ${formatIn(entry.availableAt, now)})`;
}

async function gatherSnapshots(deps) {
  const profiles = await deps.registry.list();
  if (profiles.length === 0) throw new Error('Usage: add a profile first');
  const claudePath = await deps.resolveClaude({ env: deps.env });
  const now = (deps.now || Date.now)();
  const snapshots = await collectUsage({
    profiles,
    claudePath,
    env: deps.env,
    cwd: deps.configHome,
    profilesConfigDir: deps.profilesConfigDir,
    readProfileState: deps.readProfileState,
    spawnProbe: deps.spawnProbe,
    now
  });
  return { snapshots, now };
}

function reportProblems(snapshots, printErr) {
  for (const snapshot of snapshots) {
    if (snapshot.tierWarning) printErr(`warning: ${snapshot.tierWarning}`);
    if (!snapshot.usage) printErr(`warning: ${snapshot.name}: usage unknown (${snapshot.error}); excluded`);
  }
}

async function autoUseCommand(passthrough, force, deps) {
  const printErr = deps.printErr || defaultPrintErr;
  const { snapshots, now } = await gatherSnapshots(deps);
  reportProblems(snapshots, printErr);

  // Resume and continue only work on the profile that owns the session.
  let candidates = snapshots;
  let restrictedTo = null;
  const intent = parseResumeIntent(passthrough);
  if (intent && intent.kind !== 'picker') {
    const owners = await findSessionOwners({
      profiles: snapshots,
      intent,
      cwd: deps.cwd || process.cwd(),
      fs: deps.fs
    });
    if (owners.length > 0) {
      candidates = snapshots.filter((snapshot) => owners.includes(snapshot.name));
      restrictedTo = candidates.map((snapshot) => snapshot.name).join(', ');
    } else if (intent.kind === 'id') {
      printErr(`warning: no profile owns session ${intent.id}; picking by capacity`);
    }
  }

  const ranked = rankProfiles(candidates, now);
  let chosen = ranked.choice;

  if (!chosen && restrictedTo) {
    const entry = ranked.ranking[0];
    if (!force) {
      if (entry.status === 'unknown') {
        throw new Error(`Session belongs to ${entry.name}, whose usage is unknown (${entry.error}). Use --force to launch it anyway.`);
      }
      throw exhaustedError(`Session belongs to ${entry.name}, which is exhausted; ${freesAt(entry, now)}. Use --force to launch it anyway.`);
    }
    chosen = entry;
  } else if (!chosen && ranked.allExhausted) {
    const earliest = ranked.earliest;
    const message = `all profiles exhausted; ${earliest.name} ${freesAt(earliest, now)}`;
    if (!force) {
      if (!deps.isTTY) throw exhaustedError(message);
      printErr(message);
      const answer = await deps.confirm(`Launch ${earliest.name} anyway? [y/N] `);
      if (!/^y(es)?$/i.test(String(answer).trim())) return;
    }
    chosen = earliest;
  } else if (!chosen) {
    throw new Error('Cannot read usage for any profile.');
  }

  const snapshot = snapshots.find((item) => item.name === chosen.name);
  printErr(describeChoice(chosen, snapshot, now));
  if (intent && intent.kind === 'picker') {
    printErr(`warning: the --resume picker will show only ${chosen.name}'s sessions`);
  }
  await launchProfile(chosen.name, passthrough, deps);
}

function describeChoice(entry, snapshot, now) {
  if (entry.status !== 'ok') return `auto: ${entry.name} (${snapshot.tier}, forced)`;
  const left = Math.round(entry.remaining * 100);
  return `auto: ${entry.name} (${snapshot.tier}, ${left}% left, ${entry.limiting} resets ${formatReset(entry.limitingResetsAt, now)})`;
}

const percentText = (win) => (win ? `${Math.round(win.used)}%` : '-');

function usageRow(entry, snapshot, best, now) {
  const resets = entry.status === 'unknown' ? '-' : formatReset(entry.status === 'exhausted' ? entry.availableAt : entry.limitingResetsAt, now);
  let status = entry.status === 'ok' && entry === best ? 'best' : entry.status;
  if (entry.status === 'unknown') status = `unknown: ${snapshot.error}`;
  return [
    snapshot.name,
    `${snapshot.tier} (${snapshot.tierSource})`,
    percentText(snapshot.usage && snapshot.usage.fiveHour),
    percentText(snapshot.usage && snapshot.usage.weekly),
    resets,
    entry.capacity == null ? '-' : entry.capacity.toFixed(2),
    status
  ];
}

async function usageCommand(args, deps) {
  const unknownOption = args.find((arg) => arg !== '--json');
  if (unknownOption) throw new Error('Usage: usage [--json]');
  const json = args.includes('--json');
  const { snapshots, now } = await gatherSnapshots(deps);
  const ranked = rankProfiles(snapshots, now);
  const entries = new Map(ranked.ranking.map((entry) => [entry.name, entry]));
  const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
  const windowJson = (win) => (win ? { used: win.used, resetsAt: iso(win.resetsAt) } : null);

  if (json) {
    deps.print(JSON.stringify({
      best: ranked.choice ? ranked.choice.name : null,
      profiles: snapshots.map((snapshot) => {
        const entry = entries.get(snapshot.name);
        return {
          name: snapshot.name,
          tier: snapshot.tier,
          tierSource: snapshot.tierSource,
          weight: snapshot.weight,
          status: entry.status,
          capacity: entry.capacity,
          fiveHour: windowJson(snapshot.usage && snapshot.usage.fiveHour),
          weekly: windowJson(snapshot.usage && snapshot.usage.weekly),
          availableAt: iso(entry.availableAt),
          source: snapshot.source || null,
          error: snapshot.error || null
        };
      })
    }, null, 2));
    return;
  }

  const rows = [['PROFILE', 'TIER', '5H', 'WEEK', 'RESETS', 'CAPACITY', 'STATUS']];
  for (const snapshot of snapshots) rows.push(usageRow(entries.get(snapshot.name), snapshot, ranked.choice, now));
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  for (const row of rows) {
    deps.print(row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd());
  }
  const printErr = deps.printErr || defaultPrintErr;
  for (const snapshot of snapshots) {
    if (snapshot.tierWarning) printErr(`warning: ${snapshot.tierWarning}`);
  }
}

async function tierCommand(positional, deps) {
  const [name, tier] = positional;
  if (!name || !tier || positional.length > 2) throw new Error('Usage: tier <profile> <tier>');
  await deps.registry.get(name);
  await deps.registry.setTier(name, parseTier(tier).tier);
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
    const { positional, passthrough, auto, force } = parseUseArgs(rest);
    if (auto) return autoUseCommand(passthrough, force, { ...deps, print });
    return useCommand(positional, passthrough, deps);
  }
  if (command === 'usage') return usageCommand(rest, { ...deps, print });

  const { positional } = parseArgs(rest);

  switch (command) {
    case 'add': return addCommand(positional, { ...deps, print });
    case 'list': return listCommand({ ...deps, print });
    case 'status': return statusCommand(positional, { ...deps, print });
    case 'tier': return tierCommand(positional, deps);
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
