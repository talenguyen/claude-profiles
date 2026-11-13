const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function makeTempDir(prefix = 'claude-profiles-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
async function removeTempDir(directory) {
  await fs.rm(directory, { recursive: true, force: true });
}
// Tests must never read or write the developer's real profiles or credentials.
function clearInheritedConfigEnv() {
  for (const key of Object.keys(process.env)) {
    if (key === 'CLAUDE_CONFIG_DIR' || key === 'CODEX_HOME' || key.startsWith('XDG_')) delete process.env[key];
  }
}
module.exports = { makeTempDir, removeTempDir, clearInheritedConfigEnv };
