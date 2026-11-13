// Pure profile ranking. No I/O: everything it needs comes in as arguments.
const NEAR_TIE = 0.05;
const STALE_RESET_MS = 60_000;

function windowState(win, now) {
  if (!win) return { present: false, remaining: 1, resetsAt: null, exhausted: false };
  // A reset time well in the past means the window already rolled over.
  if (win.resetsAt != null && win.resetsAt < now - STALE_RESET_MS) {
    return { present: true, remaining: 1, resetsAt: win.resetsAt, exhausted: false };
  }
  const remaining = Math.max(0, 1 - win.used / 100);
  const exhausted = remaining <= 0 || win.locked === true || win.critical === true;
  return { present: true, remaining, resetsAt: win.resetsAt ?? null, exhausted };
}

function evaluate(snapshot, index, now) {
  const base = { name: snapshot.name, index, weight: snapshot.weight ?? 1 };
  if (!snapshot.usage) {
    return { ...base, status: 'unknown', error: snapshot.error, capacity: null };
  }
  const five = windowState(snapshot.usage.fiveHour, now);
  const week = windowState(snapshot.usage.weekly, now);
  const fiveLimits = five.remaining <= week.remaining;
  const limiting = fiveLimits ? five : week;
  const remaining = Math.min(five.remaining, week.remaining);
  const exhausted = remaining <= 0 || five.exhausted || week.exhausted;
  const exhaustedTimes = [five, week].filter((w) => w.exhausted || w.remaining <= 0).map((w) => w.resetsAt);
  const availableAt = exhausted && exhaustedTimes.length > 0 && exhaustedTimes.every((t) => t != null)
    ? Math.max(...exhaustedTimes)
    : null;
  return {
    ...base,
    status: exhausted ? 'exhausted' : 'ok',
    remaining,
    limiting: fiveLimits ? '5h' : 'week',
    limitingResetsAt: limiting.resetsAt,
    fiveHourLeft: five.remaining,
    weeklyLeft: week.remaining,
    capacity: exhausted ? 0 : base.weight * remaining,
    availableAt
  };
}

const sooner = (value) => (value == null ? Infinity : value);

/**
 * Rank profiles by remaining real capacity.
 *
 * capacity = weight * min(5h remaining, weekly remaining); exhausted profiles
 * and profiles with unknown usage are never chosen. Capacities within 5% of
 * the best are a near-tie, resolved by the earlier reset of the limiting
 * window, then by input order.
 *
 * @param {Array<{ name: string, weight?: number, usage: object | null, error?: string }>} snapshots
 * @param {number} [now]
 * @returns {{ choice: object | null, ranking: object[], unknown: object[], allExhausted: boolean, earliest: object | null }}
 */
function rankProfiles(snapshots, now = Date.now()) {
  const entries = snapshots.map((snapshot, index) => evaluate(snapshot, index, now));
  const ok = entries.filter((e) => e.status === 'ok').sort((a, b) => b.capacity - a.capacity || a.index - b.index);
  const exhausted = entries
    .filter((e) => e.status === 'exhausted')
    .sort((a, b) => sooner(a.availableAt) - sooner(b.availableAt) || a.index - b.index);
  const unknown = entries.filter((e) => e.status === 'unknown');

  let choice = null;
  if (ok.length > 0) {
    const best = ok[0].capacity;
    const tied = ok.filter((e) => best - e.capacity <= best * NEAR_TIE);
    choice = tied.reduce((a, b) => (sooner(b.limitingResetsAt) < sooner(a.limitingResetsAt) ? b : a));
  }
  return {
    choice,
    ranking: [...ok, ...exhausted, ...unknown],
    unknown,
    allExhausted: ok.length === 0 && exhausted.length > 0,
    earliest: ok.length === 0 && exhausted.length > 0 ? exhausted[0] : null
  };
}

const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Local reset time: `HH:MM` within a day, `Www HH:MM` further out. */
function formatReset(ms, now = Date.now()) {
  if (ms == null) return 'unknown';
  const date = new Date(ms);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return Math.abs(ms - now) < 24 * 3600_000 ? clock : `${DAYS[date.getDay()]} ${clock}`;
}

/** Duration until a time, like `2h 5m`. */
function formatIn(ms, now = Date.now()) {
  if (ms == null) return 'unknown';
  const minutes = Math.max(0, Math.round((ms - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

module.exports = { rankProfiles, formatReset, formatIn, NEAR_TIE };
