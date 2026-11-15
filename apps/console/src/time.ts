// One clock: every time on screen, and every period asked for, is in the tenant's zone, the one its
// business days and sign-offs are cut in, whatever zone the browser is in.

let zone = 'UTC';

/** Set once the signed-in person's tenant is known, before anything is drawn. */
export function setTimeZone(timeZone: string) {
  zone = timeZone;
}

export const timeZone = () => zone;

function wallClock(at: Date) {
  const p: Record<string, string> = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const n = (k: string) => Number(p[k]);
  return {
    y: n('year'),
    m: n('month'),
    d: n('day'),
    h: n('hour'),
    min: n('minute'),
    s: n('second'),
  };
}

/** How far the zone's wall clock is ahead of UTC at `at`, in milliseconds. */
function offset(at: Date) {
  const w = wallClock(at);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant a calendar day began in the zone. `month` counts from 1 and may overflow. */
export function dayStart(year: number, month: number, day: number) {
  const midnight = Date.UTC(year, month - 1, day);
  const guess = midnight - offset(new Date(midnight));
  return new Date(midnight - offset(new Date(guess)));
}

/** The instant a month began in the zone: 0 for this month, -1 for last month. */
export function monthStart(monthsAgo = 0, now = new Date()) {
  const w = wallClock(now);
  return dayStart(w.y, w.m + monthsAgo, 1);
}

/** The calendar day an instant falls on in the zone, as `YYYY-MM-DD`. */
export function dayKey(when: string | Date) {
  const w = wallClock(new Date(when));
  return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}

/** "Europe/London (UTC+1)", or "UTC". */
export function zoneLabel(at = new Date()) {
  if (zone === 'UTC' || zone === 'Etc/UTC') return 'UTC';
  const minutes = Math.round(offset(at) / 60_000);
  const sign = minutes < 0 ? '-' : '+';
  const h = Math.floor(Math.abs(minutes) / 60);
  const m = Math.abs(minutes) % 60;
  return `${zone.replaceAll('_', ' ')} (UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''})`;
}

/** The zone in a few letters, for labels: "UTC", "London". */
export const zoneName = () =>
  zone === 'UTC' || zone === 'Etc/UTC'
    ? 'UTC'
    : (zone.split('/').pop() ?? zone).replaceAll('_', ' ');
