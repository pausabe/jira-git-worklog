export type WeekdayShort = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

const WEEKDAYS: WeekdayShort[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Parses YYYY-MM-DD into a UTC Date at midnight. */
function parseYmd(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1));
}

/** Formats a UTC Date as YYYY-MM-DD. */
export function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Inclusive list of YYYY-MM-DD strings between `from` and `to`. */
export function eachDay(from: string, to: string): string[] {
  const start = parseYmd(from);
  const end = parseYmd(to);
  const out: string[] = [];
  for (let d = start; d.getTime() <= end.getTime(); d = new Date(d.getTime() + 86_400_000)) {
    out.push(ymd(d));
  }
  return out;
}

export function weekdayOf(date: string): WeekdayShort {
  return WEEKDAYS[parseYmd(date).getUTCDay()]!;
}

export function isWeekend(date: string): boolean {
  const wd = weekdayOf(date);
  return wd === 'sat' || wd === 'sun';
}

/** YYYY-MM-DD shifted by `days` (negative goes back). */
export function addDays(date: string, days: number): string {
  return ymd(new Date(parseYmd(date).getTime() + days * 86_400_000));
}

/**
 * Calendar day of an ISO instant in the server's time zone (the TZ env var if
 * set, else the OS zone). GitHub returns commit dates in UTC, so slicing the
 * ISO string would put a commit made at 00:30 in Spain on the previous day.
 * The zone is resolved on every call, not cached at import, so a TZ set in
 * .env (loaded after the modules) still applies. en-CA formats as YYYY-MM-DD.
 */
export function localDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** Start-of-day ISO instant (UTC) for a YYYY-MM-DD. */
export function isoStart(date: string): string {
  return `${date}T00:00:00Z`;
}

/** End-of-day ISO instant (UTC) for a YYYY-MM-DD. */
export function isoEnd(date: string): string {
  return `${date}T23:59:59Z`;
}
