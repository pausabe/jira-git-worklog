import type { CompanyHoliday, Leave } from '../clients/factorial.js';
import { eachDay, isWeekend } from './dates.js';

/** Half a day off is a fixed 4 hours, also in the 7-hour summer workday. */
const HALF_DAY_SECONDS = 4 * 3600;

/** What Factorial says about one calendar day. */
export interface DayOff {
  /** Seconds of the workday that are not worked (capped at the workday). */
  secondsOff: number;
  /** Why, in Factorial's own words: holiday name or leave type. */
  reasons: string[];
  /** Leave types requested for this day that are still waiting for approval. */
  pending: string[];
}

/**
 * How many seconds of one workday an approved leave takes away.
 *
 * `leave.hours` is set for leaves requested by hours (e.g. 2 for a two-hour
 * absence) and null for leaves in whole days; `leave.halfDay` is non-null when
 * Factorial marks the leave as half a day. `workdaySeconds` is the length of
 * that particular day (7h in summer, 8h otherwise).
 */
export function secondsOffForLeave(leave: Leave, workdaySeconds: number): number {
  // By hours: take exactly what was requested, whatever the leave type. A request
  // longer than the workday (8h on a 7h summer day) is a data-entry slip in
  // Factorial; the caller caps it at the workday, so it reads as a whole day off.
  if (leave.hours !== null) return leave.hours * 3600;
  if (leave.halfDay) return HALF_DAY_SECONDS;
  return workdaySeconds;
}

/**
 * Decides whether hours may be logged on a day, given what Factorial says.
 * Returns the reason to refuse, or null when logging is allowed.
 *
 * `plannedSeconds` is what is about to be sent to Jira for that day, `off` is
 * Factorial's record of the day (undefined = nothing recorded), and
 * `fullWorkdaySeconds` is the day's length before any time off.
 */
export function timeOffViolation(
  plannedSeconds: number,
  off: DayOff | undefined,
  fullWorkdaySeconds: number,
): string | null {
  if (!off || plannedSeconds <= 0) return null;
  const windowSeconds = Math.max(0, fullWorkdaySeconds - off.secondsOff);
  if (windowSeconds === 0) {
    return `day off in Factorial (${off.reasons.join(', ')})`;
  }
  // TODO(human): decide what happens on a partly-off day when plannedSeconds
  // is larger than windowSeconds. For now such days are allowed through.
  return null;
}

/**
 * Merges company holidays and one person's leaves into a per-day map for
 * [from, to]. Weekends are left out: they are never working days anyway.
 */
export function resolveDaysOff(
  leaves: Leave[],
  holidays: CompanyHoliday[],
  from: string,
  to: string,
  workdaySecondsFor: (date: string) => number,
): Map<string, DayOff> {
  const days = new Map<string, DayOff>();
  const dayOf = (date: string): DayOff => {
    let day = days.get(date);
    if (!day) {
      day = { secondsOff: 0, reasons: [], pending: [] };
      days.set(date, day);
    }
    return day;
  };
  const addOff = (date: string, seconds: number, reason: string) => {
    const day = dayOf(date);
    day.secondsOff = Math.min(workdaySecondsFor(date), day.secondsOff + Math.max(0, seconds));
    if (!day.reasons.includes(reason)) day.reasons.push(reason);
  };

  for (const h of holidays) {
    if (h.date < from || h.date > to || isWeekend(h.date)) continue;
    addOff(h.date, h.halfDay ? HALF_DAY_SECONDS : workdaySecondsFor(h.date), h.name);
  }

  for (const leave of leaves) {
    if (leave.approved === false) continue; // rejected: the day is worked
    const start = leave.from > from ? leave.from : from;
    const end = leave.to < to ? leave.to : to;
    if (start > end) continue;
    for (const date of eachDay(start, end)) {
      if (isWeekend(date)) continue;
      if (leave.approved !== true) {
        const day = dayOf(date);
        if (!day.pending.includes(leave.type)) day.pending.push(leave.type);
        continue;
      }
      addOff(date, secondsOffForLeave(leave, workdaySecondsFor(date)), leave.type);
    }
  }

  return days;
}
