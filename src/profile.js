const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function validateProfile(name) {
  if (typeof name !== 'string' || !PROFILE.test(name)) throw new Error('Invalid profile name.');
  return name;
}
function serviceForProfile(name) { return `Claude Profiles: ${validateProfile(name)}`; }
module.exports = { validateProfile, serviceForProfile };
