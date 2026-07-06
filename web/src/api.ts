// Shared types mirroring the server API, plus tiny fetch helpers.

export type Distribution = 'weighted-by-churn' | 'equal' | 'weighted-by-commits';
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | '*';

export interface RecurringBlock {
  label: string;
  weekday: Weekday;
  minutes: number;
  issue: string;
}

export interface Seasonal {
  from: string; // MM-DD
  to: string;   // MM-DD
  hours: number;
}

export interface HolidayRange {
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
}

export interface Person {
  id: string;
  githubLogin: string;
  emails: string[];
  default: boolean;
}

export interface Config {
  workday: { defaultHours: number; seasonal: Seasonal[] };
  recurring: RecurringBlock[];
  fallbackIssue: string;
  distribution: Distribution;
  ticketRegex: string;
  holidays: HolidayRange[];
  people: Person[];
  defaultComments: { commits: string; fallback: string };
  issueComments: Record<string, string>;
}

export type WorklogSource = 'commits' | 'recurring' | 'fallback';

export interface WorklogEntry {
  date: string;
  issue: string;
  seconds: number;
  source: WorklogSource;
  label?: string;
  detail?: string;
  comment?: string;
}

export interface DayPlan {
  date: string;
  weekday: string;
  workdaySeconds: number;
  existingSeconds: number;
  entries: WorklogEntry[];
  warnings: string[];
}

export interface Plan {
  person: string;
  from: string;
  to: string;
  days: DayPlan[];
}

export interface UnlinkedBranch {
  repo: string;
  branch: string;
  commitCount: number;
  suggestion?: string;
}

export interface LoggedDayEntry {
  issueKey: string;
  summary: string;
  worklogId: string;
  seconds: number;
  comment: string;
}

export interface CommitInfo {
  repo: string;
  branch: string;
  ticket: string;
  message: string;
  churn: number;
  unlinked?: boolean;
}

export interface PreviewResponse {
  plan: Plan;
  unlinkedBranches: UnlinkedBranch[];
  stats: { reposScanned: number; branchesScanned: number; commits: number };
  commitsByDay: Record<string, CommitInfo[]>;
  loggedByDay: Record<string, LoggedDayEntry[]>;
}

export interface ImputeResult {
  created: Array<{ date: string; issue: string; seconds: number; worklogId: string }>;
  skipped: Array<{ date: string; issue: string; reason: string }>;
  failed: Array<{ date: string; issue: string; error: string }>;
}

export interface BranchLink {
  repo: string;
  branch: string;
  ticket: string;
  createdAt: string;
}

export interface MeResponse {
  jira: { accountId: string; displayName: string; timeZone?: string };
  githubOrg: string;
}

export interface LoggedEntry {
  issue: string;
  summary: string;
  comment: string;
  worklogId: string;
  seconds: number;
}

export interface LoggedDay {
  date: string;
  entries: LoggedEntry[];
  totalSeconds: number;
}

export interface LoggedResponse {
  days: LoggedDay[];
  totalSeconds: number;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const issues = data?.issues as Array<{ path: unknown[]; message: string }> | undefined;
    const detail = issues?.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    const message = detail ? `${data?.error ?? 'Error'}: ${detail}` : (data?.error ?? `${res.status} ${res.statusText}`);
    throw new Error(message);
  }
  return data as T;
}

export const api = {
  me: () => req<MeResponse>('/api/me'),
  getConfig: () => req<Config>('/api/config'),
  saveConfig: (config: Config) => req<Config>('/api/config', { method: 'PUT', body: JSON.stringify(config) }),
  preview: (person: string, from: string, to: string) =>
    req<PreviewResponse>('/api/preview', { method: 'POST', body: JSON.stringify({ person, from, to }) }),
  impute: (person: string, plan: Plan) =>
    req<ImputeResult>('/api/impute', { method: 'POST', body: JSON.stringify({ person, plan }) }),
  links: () => req<BranchLink[]>('/api/links'),
  addLink: (repo: string, branch: string, ticket: string) =>
    req<BranchLink>('/api/links', { method: 'POST', body: JSON.stringify({ repo, branch, ticket }) }),
  deleteLink: (repo: string, branch: string) =>
    req<{ ok: true }>('/api/links', { method: 'DELETE', body: JSON.stringify({ repo, branch }) }),
  logged: (from: string, to: string) =>
    req<LoggedResponse>(`/api/logged?from=${from}&to=${to}`),
  updateWorklogComment: (issueKey: string, worklogId: string, comment: string) =>
    req<{ ok: true }>('/api/worklog-comment', { method: 'PUT', body: JSON.stringify({ issueKey, worklogId, comment }) }),
  updateWorklog: (issueKey: string, worklogId: string, seconds: number, comment: string) =>
    req<{ ok: true }>('/api/worklog', { method: 'PUT', body: JSON.stringify({ issueKey, worklogId, seconds, comment }) }),
  deleteWorklog: (issueKey: string, worklogId: string) =>
    req<{ ok: true }>('/api/worklog', { method: 'DELETE', body: JSON.stringify({ issueKey, worklogId }) }),
  lastLoggedDate: (person: string, before?: string) =>
    req<{ date: string | null }>(`/api/last-logged-date?person=${encodeURIComponent(person)}${before ? `&before=${before}` : ''}`),  
  previewStream: (
    person: string,
    from: string,
    to: string,
    onProgress: (msg: string) => void,
    tempLinks?: Array<{ repo: string; branch: string; ticket: string }>,
  ): Promise<PreviewResponse> =>
    new Promise((resolve, reject) => {
      fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ person, from, to, ...(tempLinks?.length ? { tempLinks } : {}) }),
      })
        .then(async (res) => {
          if (!res.ok || !res.body) {
            const text = await res.text().catch(() => '');
            const data = text ? JSON.parse(text) : {};
            reject(new Error(data.error ?? `${res.status} ${res.statusText}`));
            return;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const chunks = buffer.split('\n\n');
            buffer = chunks.pop()!;
            for (const chunk of chunks) {
              if (!chunk.startsWith('data: ')) continue;
              const event = JSON.parse(chunk.slice(6)) as { type: string; message?: string } & Partial<PreviewResponse>;
              if (event.type === 'progress' && event.message) onProgress(event.message);
              else if (event.type === 'done') resolve({ plan: event.plan!, unlinkedBranches: event.unlinkedBranches!, stats: event.stats!, commitsByDay: event.commitsByDay ?? {}, loggedByDay: event.loggedByDay ?? {} });
              else if (event.type === 'error') reject(new Error(event.message));
            }
          }
        })
        .catch(reject);
    }),
};

export function secondsToHours(seconds: number): string {
  return (seconds / 3600).toFixed(2).replace(/\.00$/, '') + 'h';
}
