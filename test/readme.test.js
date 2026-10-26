const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

test('README documents installation and every public command', async () => {
  const readme = await readFile(path.join(__dirname, '..', 'README.md'), 'utf8');
  for (const command of ['npm install -g .', 'claude-profiles add <profile>', 'claude-profiles list', 'claude-profiles status [profile]', 'claude-profiles use <profile>', 'claude-profiles refresh <profile>', 'claude-profiles remove <profile>']) {
    assert.match(readme, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});