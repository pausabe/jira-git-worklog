import type { JiraClient } from '../clients/jira.js';
import type { ImputeResult, Plan, WorklogEntry } from '../types.js';
import { hasImputed, recordImputation } from '../store.js';

interface MergedEntry {
  date: string;
  issue: string;
  seconds: number;
  comment: string;
}

/** Merges plan entries that target the same issue on the same day. */
function mergeEntries(plan: Plan): MergedEntry[] {
  const map = new Map<string, MergedEntry>();
  for (const day of plan.days) {
    for (const e of day.entries) {
      if (!e.issue || e.seconds <= 0) continue;
      const key = `${e.date}#${e.issue}`;
      const existing = map.get(key);
      if (existing) {
        existing.seconds += e.seconds;
      } else {
        map.set(key, { date: e.date, issue: e.issue, seconds: e.seconds, comment: describe(e) });
      }
    }
  }
  return [...map.values()].sort((a, b) => (a.date === b.date ? a.issue.localeCompare(b.issue) : a.date.localeCompare(b.date)));
}

function describe(e: WorklogEntry): string {
  if (e.comment) return e.comment;
  if (e.source === 'recurring') return e.label ?? 'Meeting';
  if (e.source === 'fallback') return 'Administrative work';
  return 'Development work';
}

/**
 * Applies a (possibly user-edited) plan to Jira. Idempotent: any (person, date,
 * issue) already present in the local ledger is skipped rather than duplicated.
 */
export async function applyPlan(jira: JiraClient, person: string, plan: Plan): Promise<ImputeResult> {
  const result: ImputeResult = { created: [], skipped: [], failed: [] };

  for (const entry of mergeEntries(plan)) {
    if (await hasImputed(person, entry.date, entry.issue)) {
      result.skipped.push({ date: entry.date, issue: entry.issue, reason: 'already logged' });
      continue;
    }
    try {
      const worklogId = await jira.addWorklog({
        issueKey: entry.issue,
        date: entry.date,
        timeSpentSeconds: entry.seconds,
        comment: entry.comment,
        marker: { source: 'git-auto-imputer', person, date: entry.date },
      });
      await recordImputation({
        person,
        date: entry.date,
        issue: entry.issue,
        seconds: entry.seconds,
        worklogId,
        createdAt: new Date().toISOString(),
      });
      result.created.push({ date: entry.date, issue: entry.issue, seconds: entry.seconds, worklogId });
    } catch (err) {
      result.failed.push({ date: entry.date, issue: entry.issue, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}
