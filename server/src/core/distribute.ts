import type { Config } from '../config.js';
import type { CollectedCommit, DayPlan, Plan, WorklogEntry, WorklogSource } from '../types.js';
import { eachDay, isWeekend, weekdayOf } from './dates.js';

const ROUND_SECONDS = 300; // round worklogs to 5-minute steps

interface TicketAgg {
  churn: number;
  commits: number;
}

function seasonalHours(config: Config, date: string): number {
  const mmdd = date.slice(5); // "MM-DD" from "YYYY-MM-DD"
  for (const s of config.workday.seasonal) {
    if (s.from <= mmdd && mmdd <= s.to) return s.hours;
  }
  return config.workday.defaultHours;
}

function roundTo(seconds: number, step: number): number {
  return Math.round(seconds / step) * step;
}

/**
 * Splits `total` seconds across weighted buckets, rounded to 5-minute steps,
 * adjusting the largest bucket so the parts sum back to `total`.
 */
function splitWeighted(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const positive = weights.filter((w) => w > 0).length;
  // Not enough budget to give every ticket at least one step: fall back to
  // proportional rounding without the minimum guarantee.
  const canGuaranteeMin = positive * ROUND_SECONDS <= total;

  const raw = weights.map((w) => roundTo((total * w) / sum, ROUND_SECONDS));

  // Guarantee a minimum of one step for any positive-weight bucket that rounded
  // to 0, so small tickets aren't silently dropped.
  if (canGuaranteeMin) {
    for (let i = 0; i < raw.length; i += 1) {
      if (weights[i]! > 0 && raw[i] === 0) raw[i] = ROUND_SECONDS;
    }
  }

  // Rebalance so parts sum back to `total`, taking/adding on the largest bucket.
  // Move in whole steps to keep values tidy; absorb any sub-step remainder at the end.
  let drift = total - raw.reduce((a, b) => a + b, 0);
  let guard = raw.length * 4 + 4;
  while (Math.abs(drift) >= ROUND_SECONDS && guard-- > 0) {
    let maxIdx = 0;
    for (let i = 1; i < raw.length; i += 1) if (raw[i]! > raw[maxIdx]!) maxIdx = i;
    const step = drift > 0 ? ROUND_SECONDS : -ROUND_SECONDS;
    raw[maxIdx] = Math.max(0, raw[maxIdx]! + step);
    drift = total - raw.reduce((a, b) => a + b, 0);
  }
  // Absorb any remaining sub-step drift on the largest bucket.
  if (drift !== 0) {
    let maxIdx = 0;
    for (let i = 1; i < raw.length; i += 1) if (raw[i]! > raw[maxIdx]!) maxIdx = i;
    raw[maxIdx] = Math.max(0, raw[maxIdx]! + drift);
  }
  return raw;
}

function commentFor(config: Config, source: WorklogSource, issue: string, label?: string): string {
  if (config.issueComments[issue]) return config.issueComments[issue]!;
  if (source === 'recurring') return label ?? 'Meeting';
  if (source === 'fallback') return config.defaultComments.fallback;
  return config.defaultComments.commits;
}

/** Builds a per-day imputation plan for one person from their collected commits. */
export function buildPlan(
  config: Config,
  person: string,
  from: string,
  to: string,
  commits: CollectedCommit[],
  existingByDay?: Map<string, number>,
  existingIssuesByDay?: Map<string, Set<string>>,
): Plan {
  // Aggregate commits by day -> ticket.
  const byDay = new Map<string, Map<string, TicketAgg>>();
  for (const c of commits) {
    if (!c.ticket) continue;
    const day = c.date.slice(0, 10);
    const tickets = byDay.get(day) ?? new Map<string, TicketAgg>();
    const agg = tickets.get(c.ticket) ?? { churn: 0, commits: 0 };
    agg.churn += c.churn;
    agg.commits += 1;
    tickets.set(c.ticket, agg);
    byDay.set(day, tickets);
  }

  const holidays = new Set(
    config.holidays.flatMap(({ from, to }) => eachDay(from, to)),
  );
  const days: DayPlan[] = [];

  for (const date of eachDay(from, to)) {
    if (isWeekend(date) || holidays.has(date)) continue;

    const weekday = weekdayOf(date);
    const workdaySeconds = Math.round(seasonalHours(config, date) * 3600);
    const entries: WorklogEntry[] = [];
    const warnings: string[] = [];

    // If the full day is already logged in Jira, skip everything.
    const existingSeconds = existingByDay?.get(date) ?? 0;
    if (existingSeconds >= workdaySeconds) {
      days.push({ date, weekday, workdaySeconds, entries, warnings, existingSeconds });
      continue;
    }

    // Fixed recurring blocks for this weekday.
    let fixedSeconds = 0;
    const alreadyLoggedIssues = existingIssuesByDay?.get(date) ?? new Set<string>();
    for (const block of config.recurring) {
      const applies = block.weekday === '*' || block.weekday === weekday;
      if (!applies) continue;
      if (!block.issue) {
        warnings.push(`Fixed block "${block.label}" has no issue configured; skipping.`);
        continue;
      }
      if (alreadyLoggedIssues.has(block.issue)) continue; // already logged in Jira today
      const seconds = block.minutes * 60;
      fixedSeconds += seconds;
      entries.push({ date, issue: block.issue, seconds, source: 'recurring', label: block.label, comment: commentFor(config, 'recurring', block.issue, block.label) });
    }

    let remaining = workdaySeconds - fixedSeconds;
    if (remaining < 0) {
      warnings.push('Recurring meetings exceed the workday; no time left for tickets.');
      remaining = 0;
    }

    const distributable = Math.max(0, remaining - existingSeconds);

    const tickets = byDay.get(date);
    if (tickets && tickets.size > 0 && distributable > 0) {
      const keys = [...tickets.keys()];
      const weights = keys.map((k) => weightFor(config, tickets.get(k)!));
      const parts = splitWeighted(distributable, weights);
      keys.forEach((issue, i) => {
        if (parts[i]! <= 0) return;
        const agg = tickets.get(issue)!;
        entries.push({
          date,
          issue,
          seconds: parts[i]!,
          source: 'commits',
          detail: `${agg.commits} commit(s), ${agg.churn} lineas`,
          comment: commentFor(config, 'commits', issue),
        });
      });
    } else if (distributable > 0) {
      // No commits and no automatic fallback — leave the day empty so the user
      // can fill it in manually via "Add entry".
    }

    days.push({ date, weekday, workdaySeconds, existingSeconds, entries, warnings });
  }

  return { person, from, to, days };
}

function weightFor(config: Config, agg: TicketAgg): number {
  switch (config.distribution) {
    case 'equal':
      return 1;
    case 'weighted-by-commits':
      return agg.commits;
    case 'weighted-by-churn':
    default:
      // Fall back to commit count when churn is unavailable (e.g. merge commits).
      return agg.churn > 0 ? agg.churn : agg.commits;
  }
}
