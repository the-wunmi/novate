/** The calendar day `at` falls on in `timeZone`, and the instant that day began. */
export function businessDay(at: Date, timeZone: string): { date: string; start: Date } {
  const parts = (d: Date) => {
    const p: Record<string, string> = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .formatToParts(d)
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
  };
  // How far the zone's wall clock is ahead of UTC at a given instant.
  const offset = (d: Date) => {
    const p = parts(d);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(d.getTime() / 1000) * 1000;
  };
  const local = parts(at);
  const midnight = Date.UTC(local.y, local.m - 1, local.d);
  const guess = midnight - offset(at);
  const start = new Date(midnight - offset(new Date(guess)));
  const date = `${local.y}-${String(local.m).padStart(2, '0')}-${String(local.d).padStart(2, '0')}`;
  return { date, start };
}

/** The instant the calendar month `at` falls in began, in `timeZone`. */
export function monthStart(at: Date, timeZone: string): Date {
  const { date, start } = businessDay(at, timeZone);
  const daysIn = Number(date.slice(8)) - 1;
  // Noon on the first, so a daylight saving change in between cannot move it to another day.
  return businessDay(new Date(start.getTime() - daysIn * 86_400_000 + 43_200_000), timeZone).start;
}
