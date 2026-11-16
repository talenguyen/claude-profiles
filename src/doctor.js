const fsp = require('node:fs/promises');
const path = require('node:path');
const { SHARED_ITEMS, pointsAt } = require('./config.js');

/**
 * Warn-only health check of one profile's config directory. It reads local
 * files only: no network, no `claude` process. Every check returns warning
 * lines and never throws; a file it cannot read or does not recognise gives a
 * single "could not check" line instead.
 *
 * Checks, each one line per item, naming the fix:
 *  - shared links missing, broken or not pointing at the base config;
 *  - plugins enabled in settings but not installed, or missing their marketplace;
 *  - hook commands whose script or executable cannot be found;
 *  - dangling skill links;
 *  - claude.ai connectors this account still has to authenticate;
 *  - org policy restricting something the shared settings enable (see POLICY_RULES).
 */

// Past this many lines in one category the rest are folded into a single line.
const MAX_PER_CATEGORY = 10;

// Org policy (`policy-limits.json`, restriction key -> { allowed }) is read only
// for restrictions whose effect on a setting is proven. Neither Claude Code's
// documentation nor the local files say what any restriction key switches off,
// so no rule ships: guessing a mapping would warn about things that work.
// A rule is { key, enabledIn(settings) -> description | null, fix }.
const POLICY_RULES = [];

const SHELL_WORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'time', '!', '{', '}',
  'cd', 'export', 'set', 'unset', 'source', '.', 'exit', 'return', 'eval', 'exec', 'read', 'trap', 'alias', 'unalias',
  'type', 'command', 'builtin', ':', 'true', 'false', 'test', '[', '[[', 'echo', 'printf', 'umask', 'wait', 'shift'
]);
const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'node', 'python', 'python3', 'ruby', 'perl', 'deno', 'bun']);
const INLINE_FLAGS = new Set(['-c', '-lc', '-ic', '-e', '--eval', '-p', '--print', '-m']);

async function lstatOrNull(target) {
  try {
    return await fsp.lstat(target);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
}

async function pathExists(target, mode) {
  try {
    await fsp.access(target, mode);
    return true;
  } catch {
    return false;
  }
}

const reasonOf = (err) => (err && err.message ? err.message : String(err));

/** @returns {Promise<{ state: 'missing' } | { state: 'bad', reason: string } | { state: 'ok', value: object }>} */
async function readJsonObject(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return { state: 'missing' };
    return { state: 'bad', reason: `cannot read it (${err && err.code ? err.code : reasonOf(err)})` };
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { state: 'bad', reason: 'it is not valid JSON' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { state: 'bad', reason: 'it is not a JSON object' };
  return { state: 'ok', value };
}

// ---- shared links ----------------------------------------------------------

async function checkLinks({ profile, profileDir, baseConfigDir, skip }) {
  const lines = [];
  const flagged = new Set();
  if (!baseConfigDir) return { lines, flagged };
  const fix = `run: claude-profiles relink ${profile}`;
  for (const item of SHARED_ITEMS) {
    if (skip.has(item)) { flagged.add(item); continue; }
    const source = path.join(baseConfigDir, item);
    if (!(await pathExists(source))) continue;
    const link = path.join(profileDir, item);
    let problem = null;
    try {
      const info = await lstatOrNull(link);
      if (!info) problem = 'is missing';
      else if (!info.isSymbolicLink()) problem = `is ${info.isDirectory() ? 'a real directory' : 'a real file'}, not a link to the base config`;
      else if (!(await pointsAt(link, source))) {
        problem = (await pathExists(link)) ? 'is linked somewhere other than the base config' : 'is a broken link';
      }
    } catch (err) {
      lines.push(`could not check ${item} (${reasonOf(err)}); ${fix}`);
      flagged.add(item);
      continue;
    }
    if (problem) {
      lines.push(`${item} ${problem}; ${fix}`);
      flagged.add(item);
    }
  }
  return { lines, flagged };
}

// ---- hooks -----------------------------------------------------------------

// Split a hook command into words, honouring quotes. Returns null for anything
// that is not a plain command (pipes, chains, redirects, substitutions), because
// what such a command runs cannot be told from the text.
function splitCommand(command) {
  if (/[;&|<>`\n]|\$\(/.test(command)) return null;
  const words = [];
  let current = '';
  let quote = null;
  let started = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(current);
  return words;
}

function expandHome(word, env) {
  const home = env.HOME;
  let out = word;
  if (out === '~' || out.startsWith('~/')) {
    if (!home) return null;
    out = home + out.slice(1);
  }
  if (out.includes('$')) {
    if (!home) return null;
    out = out.replaceAll('${HOME}', home).replaceAll('$HOME', home);
  }
  return out.includes('$') ? null : out;
}

/**
 * The file a command hook runs, when that is certain: `{ target, direct }`
 * (`direct` = executed itself rather than read by an interpreter), else null.
 */
function hookTarget(command, env) {
  if (typeof command !== 'string') return null;
  const words = splitCommand(command.trim());
  if (!words) return null;
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  if (words.length === 0 || SHELL_WORDS.has(words[0])) return null;
  const first = expandHome(words[0], env);
  if (first === null) return null;
  if (!INTERPRETERS.has(path.basename(first))) return { target: first, direct: true };
  let script = null;
  for (const word of words.slice(1)) {
    if (INLINE_FLAGS.has(word)) return null;
    if (!word.startsWith('-')) { script = word; break; }
  }
  if (script === null) return null;
  const expanded = expandHome(script, env);
  return expanded === null ? null : { target: expanded, direct: false };
}

async function findOnPath(name, env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      const info = await fsp.stat(candidate);
      if (info.isFile() && (await pathExists(candidate, fsp.constants.X_OK))) return true;
    } catch {}
  }
  return false;
}

async function hookMissing({ target, direct }, env) {
  if (path.isAbsolute(target)) return !(await pathExists(target, direct ? fsp.constants.X_OK : fsp.constants.R_OK));
  if (target.includes('/')) return false; // relative to a directory we cannot know
  return direct ? !(await findOnPath(target, env)) : false;
}

function commandHooks(hooks) {
  const found = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new Error(`hooks.${event} is not a list`);
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) throw new Error(`hooks.${event} has an entry without a hooks list`);
      for (const hook of group.hooks) {
        if (hook && hook.type === 'command' && typeof hook.command === 'string') found.push({ event, command: hook.command });
      }
    }
  }
  return found;
}

async function checkHooks({ settings, env }) {
  if (settings.hooks === undefined) return [];
  if (settings.hooks === null || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    return ['could not check hooks (settings.json "hooks" is not an object); fix it in settings.json'];
  }
  let hooks;
  try {
    hooks = commandHooks(settings.hooks);
  } catch (err) {
    return [`could not check hooks (${reasonOf(err)}); fix it in settings.json`];
  }
  const lines = [];
  const seen = new Set();
  for (const { event, command } of hooks) {
    const found = hookTarget(command, env);
    if (!found || seen.has(found.target)) continue;
    if (await hookMissing(found, env)) {
      seen.add(found.target);
      const problem = !found.direct ? 'that script was not found'
        : path.isAbsolute(found.target) ? 'that file was not found or is not executable' : 'that executable was not found on PATH';
      lines.push(`${event} hook runs ${found.target}, but ${problem}; restore it or remove the hook from settings.json`);
    }
  }
  return lines;
}

// ---- plugins ---------------------------------------------------------------

async function checkPlugins({ profileDir, settings }) {
  const enabledMap = settings.enabledPlugins;
  if (enabledMap === undefined) return [];
  if (enabledMap === null || typeof enabledMap !== 'object' || Array.isArray(enabledMap)) {
    return ['could not check plugins (settings.json "enabledPlugins" is not an object); fix it in settings.json'];
  }
  const enabled = Object.entries(enabledMap).filter(([, on]) => on === true).map(([id]) => id);
  if (enabled.length === 0) return [];

  const installedFile = await readJsonObject(path.join(profileDir, 'plugins', 'installed_plugins.json'));
  const marketsFile = await readJsonObject(path.join(profileDir, 'plugins', 'known_marketplaces.json'));
  const bad = [['installed_plugins.json', installedFile], ['known_marketplaces.json', marketsFile]].find(([, file]) => file.state === 'bad');
  if (bad) return [`could not check plugins (plugins/${bad[0]}: ${bad[1].reason}); repair or delete that file`];
  const installedMap = installedFile.state === 'ok' ? installedFile.value.plugins : {};
  if (installedMap === null || typeof installedMap !== 'object' || Array.isArray(installedMap)) {
    return ['could not check plugins (plugins/installed_plugins.json has no "plugins" object); repair or delete that file'];
  }
  const markets = marketsFile.state === 'ok' ? marketsFile.value : {};

  const lines = [];
  for (const id of enabled) {
    const at = id.lastIndexOf('@');
    const market = at > 0 ? id.slice(at + 1) : null;
    const entries = Array.isArray(installedMap[id]) ? installedMap[id] : [];
    let installed = false;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.installPath !== 'string' || (await pathExists(entry.installPath))) { installed = true; break; }
    }
    const marketMissing = market !== null && !Object.hasOwn(markets, market);
    if (!installed) {
      const reason = entries.length > 0 ? 'its install files are missing' : 'it is not installed';
      lines.push(marketMissing
        ? `plugin ${id} is enabled but ${reason} and its marketplace "${market}" is not in the plugins registry; run /plugin marketplace add, then /plugin install ${id}, or disable it in settings.json`
        : `plugin ${id} is enabled but ${reason}; run /plugin install ${id}, or disable it in settings.json`);
    } else if (marketMissing) {
      lines.push(`plugin ${id} is installed but its marketplace "${market}" is not in the plugins registry; run /plugin marketplace add to restore it`);
    }
  }
  return lines;
}

// ---- skills ----------------------------------------------------------------

async function checkSkills({ profileDir }) {
  const dir = path.join(profileDir, 'skills');
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return [];
    return [`could not check skills (${err && err.code ? err.code : reasonOf(err)}); check the permissions of the skills folder`];
  }
  const lines = [];
  for (const name of names.sort()) {
    const full = path.join(dir, name);
    try {
      if (!(await fsp.lstat(full)).isSymbolicLink()) continue;
      if (await pathExists(full)) continue;
      lines.push(`skill "${name}" is a dangling link to ${await fsp.readlink(full)}; restore its target or delete the link`);
    } catch (err) {
      lines.push(`could not check skill "${name}" (${reasonOf(err)})`);
    }
  }
  return lines;
}

// ---- connectors ------------------------------------------------------------

// Claude records a server that answered "needs authentication" as an entry
// keyed by its name; claude.ai connectors are the keys that start with this.
const CONNECTOR_PREFIX = 'claude.ai ';

async function checkConnectors({ profile, profileDir }) {
  const file = await readJsonObject(path.join(profileDir, 'mcp-needs-auth-cache.json'));
  if (file.state === 'missing') return [];
  if (file.state === 'bad') return [`could not check connectors (mcp-needs-auth-cache.json: ${file.reason}); delete that file to reset it`];
  return Object.keys(file.value)
    .filter((name) => name.startsWith(CONNECTOR_PREFIX))
    .sort()
    .map((name) => `claude.ai connector "${name.slice(CONNECTOR_PREFIX.length)}" needs to be authenticated for this account; run: claude-profiles use ${profile}, then /mcp`);
}

// ---- org policy ------------------------------------------------------------

async function checkPolicy({ profileDir, settings, rules }) {
  if (rules.length === 0) return [];
  const file = await readJsonObject(path.join(profileDir, 'policy-limits.json'));
  if (file.state === 'missing') return [];
  const { restrictions } = file.state === 'ok' ? file.value : {};
  if (file.state === 'bad' || restrictions === null || typeof restrictions !== 'object' || Array.isArray(restrictions)) {
    return [`could not check org policy (policy-limits.json: ${file.state === 'bad' ? file.reason : 'it has no "restrictions" object'}); skipped`];
  }
  const lines = [];
  for (const rule of rules) {
    const restriction = restrictions[rule.key];
    if (!restriction || restriction.allowed !== false) continue;
    const enabled = rule.enabledIn(settings);
    if (enabled) lines.push(`org policy for this account restricts ${rule.key}, but the shared settings enable ${enabled}; ${rule.fix}`);
  }
  return lines;
}

// ---- entry point -----------------------------------------------------------

function fold(lines, category) {
  if (lines.length <= MAX_PER_CATEGORY) return lines;
  const rest = lines.length - MAX_PER_CATEGORY;
  return [...lines.slice(0, MAX_PER_CATEGORY), `... and ${rest} more ${category}; run: claude-profiles doctor`];
}

// Settings the profile will actually load: the shared `settings.json`, with
// `settings.local.json` on top. A missing file is not a problem here.
async function readSettings(profileDir) {
  const merged = {};
  const problems = [];
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = await readJsonObject(path.join(profileDir, name));
    if (file.state === 'bad') problems.push(`${name}: ${file.reason}`);
    else if (file.state === 'ok') {
      const { enabledPlugins, ...rest } = file.value;
      Object.assign(merged, rest);
      if (enabledPlugins !== undefined) {
        merged.enabledPlugins = enabledPlugins !== null && typeof enabledPlugins === 'object' && !Array.isArray(enabledPlugins) && merged.enabledPlugins && typeof merged.enabledPlugins === 'object'
          ? { ...merged.enabledPlugins, ...enabledPlugins }
          : enabledPlugins;
      }
    }
  }
  return { settings: merged, problems };
}

/**
 * @param {object} args
 * @param {string} args.profile
 * @param {string} args.profileDir - The profile's config directory.
 * @param {string} [args.baseConfigDir] - The base `~/.claude`; without it the link check is skipped.
 * @param {NodeJS.ProcessEnv} [args.env] - `HOME` and `PATH` for resolving hook commands.
 * @param {Set<string>} [args.skipLinkItems] - Shared items the launch repair already warned about.
 * @param {object[]} [args.policyRules]
 * @returns {Promise<string[]>} Warning lines, `warning: <profile>: ...`; empty when the profile is clean.
 */
async function checkProfile({
  profile, profileDir, baseConfigDir, env = process.env, skipLinkItems = new Set(), policyRules = POLICY_RULES
}) {
  const info = await lstatOrNull(profileDir).catch(() => null);
  if (!info) return [];

  const lines = [];
  const guard = async (what, fn) => {
    try {
      lines.push(...(await fn()));
    } catch (err) {
      lines.push(`could not check ${what} (${reasonOf(err)})`);
    }
  };

  const links = { lines: [], flagged: new Set() };
  await guard('shared links', async () => {
    Object.assign(links, await checkLinks({ profile, profileDir, baseConfigDir, skip: skipLinkItems }));
    return links.lines;
  });

  let settingsInfo = { settings: {}, problems: [] };
  await guard('settings', async () => {
    settingsInfo = await readSettings(profileDir);
    return [];
  });
  const { settings, problems } = settingsInfo;
  if (problems.length > 0) {
    lines.push(`could not check plugins and hooks (${problems.join('; ')}); fix or delete the file`);
  } else {
    // A missing plugins link is already reported above; its registry cannot be read through it.
    if (!links.flagged.has('plugins')) await guard('plugins', () => checkPlugins({ profileDir, settings }));
    await guard('hooks', () => checkHooks({ settings, env }));
  }
  const skills = [];
  await guard('skills', async () => { skills.push(...(await checkSkills({ profileDir }))); return []; });
  const connectors = [];
  await guard('connectors', async () => { connectors.push(...(await checkConnectors({ profile, profileDir }))); return []; });
  await guard('org policy', () => checkPolicy({ profileDir, settings, rules: policyRules }));

  return [...lines, ...fold(skills, 'dangling skill links'), ...fold(connectors, 'connectors')]
    .map((line) => `warning: ${profile}: ${line}`);
}

module.exports = { checkProfile, hookTarget, POLICY_RULES, MAX_PER_CATEGORY };
