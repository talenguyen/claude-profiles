const SECURITY_NOT_FOUND = 44;

function createKeychain({ runSecurity }) {
  async function safeRun(args, message) {
    try {
      return await runSecurity(args);
    } catch {
      throw new Error(message);
    }
  }

  return {
    async has(service) {
      try {
        await runSecurity(['find-generic-password', '-s', service, '-a', 'claude-profiles']);
        return true;
      } catch (err) {
        if (err && err.code === SECURITY_NOT_FOUND) return false;
        throw err;
      }
    },
    async read(service) {
      const { stdout } = await safeRun(
        ['find-generic-password', '-s', service, '-a', 'claude-profiles', '-w'],
        'Failed to read Keychain entry.'
      );
      return stdout.trim();
    },
    async replace(service, token) {
      await safeRun(
        ['add-generic-password', '-s', service, '-a', 'claude-profiles', '-w', token, '-U'],
        'Failed to replace Keychain entry.'
      );
    },
    async remove(service) {
      await safeRun(
        ['delete-generic-password', '-s', service, '-a', 'claude-profiles'],
        'Failed to remove Keychain entry.'
      );
    }
  };
}

module.exports = { createKeychain };
