/** A commit collected from a GitHub branch, enriched with its Jira ticket + churn. */
export interface CollectedCommit {
  repo: string; // owner/name
  branch: string;
  sha: string;
  ticket: string | null;
  authorLogin: string | null;
  authorEmail: string | null;
  /** ISO timestamp of the author date. */
  date: string;
  message: string;
  /** Lines changed (additions + deletions). 0 until resolved. */
  churn: number;
}

/** A branch discovered in GitHub, with the ticket resolved from name or manual link. */
export interface DiscoveredBranch {
  repo: string;
  branch: string;
  ticket: string | null;
  ticketSource: 'name' | 'link' | null;
}

export type WorklogSource = 'commits' | 'recurring' | 'fallback';

/** A single planned worklog line for one issue on one day. */
export interface WorklogEntry {
  date: string; // YYYY-MM-DD
  issue: string;
  seconds: number;
  source: WorklogSource;
  label?: string; // e.g. "Daily", "UI/UX"
  detail?: string; // human hint, e.g. "3 commits, 240 lines"
  comment?: string; // editable worklog message
}

/** The plan for one calendar day. */
export interface DayPlan {
  date: string; // YYYY-MM-DD
  weekday: string; // mon..sun
  workdaySeconds: number;
  /** Seconds already logged in Jira for this day (from previous/manual logs). */
  existingSeconds: number;
  entries: WorklogEntry[];
  warnings: string[];
}

/** The full imputation plan for a person over a date range. */
export interface Plan {
  person: string;
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  days: DayPlan[];
}

/** Result of applying a plan to Jira. */
export interface ImputeResult {
  created: Array<{ date: string; issue: string; seconds: number; worklogId: string }>;
  skipped: Array<{ date: string; issue: string; reason: string }>;
  failed: Array<{ date: string; issue: string; error: string }>;
}
