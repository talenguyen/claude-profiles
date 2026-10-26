const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function makeTempDir(prefix = 'claude-profiles-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
async function removeTempDir(directory) {
  await fs.rm(directory, { recursive: true, force: true });
}
module.exports = { makeTempDir, removeTempDir };
