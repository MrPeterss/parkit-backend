/** Returns true if `tz` is a valid IANA time zone name for `Intl` (e.g. `America/New_York`). */
export function isValidIanaTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const WEEKDAY_SHORT_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Local hour 0–23 in `timeZone` (h23). */
export function getHourInTimeZone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const h = parts.find((p) => p.type === 'hour');
  return h ? Number.parseInt(h.value, 10) : 0;
}

/** 0 = Sunday … 6 = Saturday in `timeZone`. */
export function getWeekdayIndexInTimeZone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).formatToParts(date);
  const w = parts.find((p) => p.type === 'weekday')?.value;
  return w !== undefined && WEEKDAY_SHORT_TO_INDEX[w] !== undefined
    ? WEEKDAY_SHORT_TO_INDEX[w]!
    : 0;
}
