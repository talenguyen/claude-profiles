const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { validateProfile, serviceForProfile } = require('./profile.js');

async function writeRegistry(registryPath, value) {
  const temporary = `${registryPath}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.chmod(temporary, 0o600);
  await fsp.rename(temporary, registryPath);
  await fsp.chmod(registryPath, 0o600);
}

async function readRegistry(registryPath) {
  let raw;
  try {
    raw = await fsp.readFile(registryPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { profiles: [] };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Registry file is malformed.');
  }
  if (!parsed || !Array.isArray(parsed.profiles)) {
    throw new Error('Registry file is malformed.');
  }
  return parsed;
}

function createRegistry({ configHome }) {
  fs.mkdirSync(configHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(configHome, 0o700);
  const registryPath = path.join(configHome, 'profiles.json');

  async function list() {
    const { profiles } = await readRegistry(registryPath);
    return profiles.map(({ name }) => ({ name, service: serviceForProfile(name) }));
  }

  async function get(name) {
    validateProfile(name);
    const { profiles } = await readRegistry(registryPath);
    const match = profiles.find((entry) => entry && entry.name === name);
    if (!match) throw new Error('Profile not found.');
    return { name, service: serviceForProfile(name) };
  }

  async function add(name) {
    validateProfile(name);
    const current = await readRegistry(registryPath);
    if (current.profiles.some((entry) => entry && entry.name === name)) {
      throw new Error('Profile already exists.');
    }
    const entry = { name, service: serviceForProfile(name) };
    await writeRegistry(registryPath, { profiles: [...current.profiles, entry] });
  }

  async function remove(name) {
    validateProfile(name);
    const current = await readRegistry(registryPath);
    const filtered = current.profiles.filter((entry) => entry && entry.name !== name);
    if (filtered.length === current.profiles.length) {
      throw new Error('Profile not found.');
    }
    await writeRegistry(registryPath, { profiles: filtered });
  }

  return { list, get, add, remove };
}

module.exports = { createRegistry };
