import type { Config, Schedule } from '../config.js';
import type { Shift } from '../clients/factorial.js';
import { eachDay, isWeekend, weekdayOf } from './dates.js';
import type { DayOff } from './timeoff.js';

export interface PlannedShift {
  clockIn: string; // HH:MM
  clockOut: string; // HH:MM
}

/**
 * What happens to one working day:
 * - `create`: no shift in Factorial yet; the template's shifts will be created.
 * - `clocked`: the day already has shifts. Never touched, even if they look short.
 * - `off`: whole day off (config holiday, company holiday or approved leave).
 * - `partly-off`: some hours off. Skipped: the app cannot know which hours.
 * - `pending-leave`: a leave waits for approval. Skipped until it is decided.
 * - `no-schedule`: the template has nothing for this weekday.
 */
export type AttendanceStatus = 'create' | 'clocked' | 'off' | 'partly-off' | 'pending-leave' | 'no-schedule';

export interface AttendanceDay {
  date: string;
  weekday: string;
  status: AttendanceStatus;
  /** Shifts to create (status `create`) or already in Factorial (status `clocked`). */
  shifts: PlannedShift[];
  minutes: number;
  reason?: string;
}

function templateFor(schedule: Schedule, date: string): PlannedShift[] {
  const weekday = weekdayOf(date) as keyof Schedule;
  return (schedule[weekday] ?? []).map((range) => ({ clockIn: range.slice(0, 5), clockOut: range.slice(6) }));
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Decides, for each working day in [from, to], whether its attendance shifts
 * can be filled in from the config template. `shifts` are the employee's
 * existing shifts and `daysOff` comes from Factorial (see resolveDaysOff).
 * `workdaySeconds` is the Jira workday of a date: resolveDaysOff caps time off
 * at it, so a day is wholly off when its time off reaches it.
 */
export function planAttendance(
  config: Config,
  from: string,
  to: string,
  shifts: Shift[],
  daysOff: Map<string, DayOff>,
  workdaySeconds: (date: string) => number,
): AttendanceDay[] {
  const holidays = new Set(config.holidays.flatMap(({ from: f, to: t }) => eachDay(f, t)));
  const shiftsByDay = new Map<string, Shift[]>();
  for (const s of shifts) shiftsByDay.set(s.date, [...(shiftsByDay.get(s.date) ?? []), s]);

  const days: AttendanceDay[] = [];
  for (const date of eachDay(from, to)) {
    if (isWeekend(date)) continue;
    const weekday = weekdayOf(date);
    const existing = shiftsByDay.get(date) ?? [];
    const off = daysOff.get(date);
    const template = templateFor(config.factorial.schedule, date);
    const day = (status: AttendanceStatus, planned: PlannedShift[], reason?: string): AttendanceDay => ({
      date,
      weekday,
      status,
      shifts: planned,
      minutes: planned.reduce((sum, s) => sum + minutesOf(s.clockOut) - minutesOf(s.clockIn), 0),
      reason,
    });

    if (existing.length > 0) {
      const clocked = existing
        .filter((s) => s.clockIn && s.clockOut)
        .map((s) => ({ clockIn: s.clockIn!.slice(0, 5), clockOut: s.clockOut!.slice(0, 5) }));
      days.push({ ...day('clocked', clocked), minutes: existing.reduce((sum, s) => sum + s.minutes, 0) });
    } else if (holidays.has(date)) {
      days.push(day('off', [], 'holiday in config.yaml'));
    } else if (off && off.secondsOff > 0 && off.secondsOff >= workdaySeconds(date)) {
      days.push(day('off', [], off.reasons.join(', ')));
    } else if (off && off.secondsOff > 0) {
      days.push(day('partly-off', [], `${off.reasons.join(', ')}: ${off.secondsOff / 3600} h off; clock in by hand`));
    } else if (off && off.pending.length > 0) {
      days.push(day('pending-leave', [], `pending approval: ${off.pending.join(', ')}`));
    } else if (template.length === 0) {
      days.push(day('no-schedule', [], `no template for ${weekday} in factorial.schedule`));
    } else {
      days.push(day('create', template));
    }
  }
  return days;
}

/**
 * ISO 8601 instant with the local offset for a date and HH:MM, in the server's
 * time zone (the TZ env var if set, else the OS zone), e.g.
 * "2026-11-10T08:00:00+01:00". Factorial wants clock-in times in this form.
 */
export function localInstant(date: string, hhmm: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const local = new Date(y!, m! - 1, d!, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)));
  const offset = -local.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date}T${hhmm}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
