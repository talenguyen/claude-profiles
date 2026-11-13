const test = require('node:test');
const assert = require('node:assert/strict');
const { rankProfiles, formatReset, formatIn } = require('../src/select.js');
const { clearInheritedConfigEnv } = require('./helpers.js');

clearInheritedConfigEnv();

const NOW = Date.parse('2026-11-13T10:00:00Z');
const HOUR = 3600_000;
const win = (used, resetsInHours = 2, extra = {}) => ({ used, resetsAt: NOW + resetsInHours * HOUR, locked: false, critical: false, ...extra });
const snap = (name, weight, fiveHour, weekly, extra = {}) => ({ name, weight, usage: { fiveHour, weekly }, ...extra });

test('premium with a higher percentage used beats standard with a lower one', () => {
  const result = rankProfiles([
    snap('standard', 1.25, win(5), win(5)),
    snap('premium', 6.25, win(40), win(40))
  ], NOW);
  assert.equal(result.choice.name, 'premium');
  assert.ok(Math.abs(result.choice.capacity - 3.75) < 1e-9);
});

test('the stricter of the two windows decides', () => {
  const result = rankProfiles([
    snap('big', 20, win(95), win(10)),
    snap('small', 1, win(0), win(20))
  ], NOW);
  assert.equal(result.choice.name, 'big');
  assert.ok(Math.abs(result.choice.capacity - 1) < 1e-9);
  assert.equal(result.choice.limiting, '5h');

  const weekly = rankProfiles([snap('a', 1, win(10), win(90, 48))], NOW);
  assert.equal(weekly.choice.limiting, 'week');
  assert.equal(weekly.choice.limitingResetsAt, NOW + 48 * HOUR);
});

test('a near tie goes to the earlier reset', () => {
  const result = rankProfiles([
    snap('late', 5, win(50, 4), win(0)),
    snap('soon', 5, win(52, 1), win(0))
  ], NOW);
  assert.equal(result.choice.name, 'soon');
});

test('a clear capacity gap is not treated as a tie', () => {
  const result = rankProfiles([
    snap('late', 5, win(0, 4), win(0)),
    snap('soon', 5, win(20, 1), win(0))
  ], NOW);
  assert.equal(result.choice.name, 'late');
});

test('a full tie falls back to input order', () => {
  const result = rankProfiles([snap('first', 1, win(10), win(10)), snap('second', 1, win(10), win(10))], NOW);
  assert.equal(result.choice.name, 'first');
});

test('exhausted profiles are excluded', () => {
  const result = rankProfiles([
    snap('empty', 20, win(10), win(100)),
    snap('some', 1, win(10), win(10))
  ], NOW);
  assert.equal(result.choice.name, 'some');
  assert.equal(result.ranking.find((e) => e.name === 'empty').status, 'exhausted');
});

test('a locked window or a critical limit counts as exhausted', () => {
  const locked = rankProfiles([snap('a', 1, win(10, 2, { locked: true }), win(10))], NOW);
  assert.equal(locked.choice, null);
  assert.equal(locked.allExhausted, true);
  const critical = rankProfiles([snap('a', 1, win(10), win(99, 2, { critical: true }))], NOW);
  assert.equal(critical.allExhausted, true);
});

test('all exhausted names the profile that frees up first, using the latest exhausted window', () => {
  const result = rankProfiles([
    snap('slow', 1, win(100, 1), win(100, 30)),
    snap('quick', 1, win(100, 3), win(10)),
    snap('mid', 1, win(10), win(100, 20))
  ], NOW);
  assert.equal(result.choice, null);
  assert.equal(result.allExhausted, true);
  assert.equal(result.earliest.name, 'quick');
  assert.equal(result.earliest.availableAt, NOW + 3 * HOUR);
});

test('unknown usage is excluded and reported, never picked', () => {
  const result = rankProfiles([
    { name: 'broken', weight: 20, usage: null, error: 'timed out' },
    snap('fine', 1, win(90), win(90))
  ], NOW);
  assert.equal(result.choice.name, 'fine');
  assert.deepEqual(result.unknown.map((e) => [e.name, e.error]), [['broken', 'timed out']]);
  const none = rankProfiles([{ name: 'broken', usage: null }], NOW);
  assert.equal(none.choice, null);
  assert.equal(none.allExhausted, false);
});

test('a single profile and null windows work', () => {
  assert.equal(rankProfiles([snap('only', 1, win(30), null)], NOW).choice.name, 'only');
  const open = rankProfiles([snap('only', 2, null, win(25))], NOW).choice;
  assert.ok(Math.abs(open.capacity - 1.5) < 1e-9);
  assert.equal(rankProfiles([], NOW).choice, null);
});

test('a window whose reset is long past is treated as reset', () => {
  const staleReset = { used: 100, resetsAt: NOW - 5 * 60_000, locked: false, critical: false };
  const result = rankProfiles([snap('a', 1, staleReset, win(0))], NOW);
  assert.equal(result.choice.name, 'a');
  assert.equal(result.choice.remaining, 1);
  const recent = { used: 100, resetsAt: NOW - 10_000, locked: false, critical: false };
  assert.equal(rankProfiles([snap('a', 1, recent, win(0))], NOW).allExhausted, true);
});

test('formatters give short human text', () => {
  assert.equal(formatIn(NOW + 125 * 60_000, NOW), '2h 5m');
  assert.equal(formatIn(NOW + 10 * 60_000, NOW), '10m');
  assert.equal(formatIn(NOW + 50 * HOUR, NOW), '2d 2h');
  assert.match(formatReset(NOW + HOUR, NOW), /^\d\d:\d\d$/);
  assert.match(formatReset(NOW + 72 * HOUR, NOW), /^[A-Z][a-z]{2} \d\d:\d\d$/);
  assert.equal(formatReset(null, NOW), 'unknown');
});
