import type { Env } from '../env.js';

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  timeZone?: string;
}

export interface AddWorklogInput {
  issueKey: string;
  /** Calendar day the work belongs to, as YYYY-MM-DD. */
  date: string;
  timeSpentSeconds: number;
  comment?: string;
  /** Marker written as a worklog property for traceability. */
  marker?: Record<string, unknown>;
}

/** Minimal ADF (Atlassian Document Format) document from a plain-text string. */
function adf(text: string) {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/** Extracts plain text from an Atlassian Document Format (ADF) node. */
function adfToText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === 'text' && n.text) return n.text;
  if (n.content) return n.content.map(adfToText).join('').trim();
  return '';
}

/** Jira wants `started` as e.g. 2021-01-17T09:00:00.000+0000 (no colon in offset). */
function startedAt(date: string): string {
  return `${date}T09:00:00.000+0000`;
}

export class JiraClient {
  private readonly base: string;
  private readonly auth: string;

  constructor(env: Pick<Env, 'jiraBaseUrl' | 'jiraEmail' | 'jiraApiToken'>) {
    this.base = env.jiraBaseUrl;
    this.auth = Buffer.from(`${env.jiraEmail}:${env.jiraApiToken}`).toString('base64');
  }

  private async request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.base}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Basic ${this.auth}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let detail = body;
      try {
        const parsed = JSON.parse(body) as { errorMessages?: string[]; errors?: Record<string, string> };
        const msgs = [
          ...(parsed.errorMessages ?? []),
          ...Object.values(parsed.errors ?? {}),
        ].filter(Boolean);
        if (msgs.length) detail = msgs.join(' · ');
      } catch { /* keep raw body */ }
      throw new Error(`Jira ${init.method ?? 'GET'} ${pathname} → ${res.status}: ${detail}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Validates credentials and returns the authenticated user. */
  getMyself(): Promise<JiraUser> {
    return this.request<JiraUser>('/rest/api/3/myself');
  }

  /** Worklogs on an issue started on/after a given day (used for extra safety checks). */
  async getWorklogs(issueKey: string, startedAfter?: string): Promise<Array<{ id: string; started: string; timeSpentSeconds: number }>> {
    const qs = startedAfter ? `?startedAfter=${new Date(startedAfter).getTime()}` : '';
    const data = await this.request<{ worklogs: Array<{ id: string; started: string; timeSpentSeconds: number }> }>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog${qs}`,
    );
    return data.worklogs;
  }

  /** Searches issues that have worklogs by `accountId` within [from, to] (YYYY-MM-DD). */
  async searchWorklogIssues(
    accountId: string,
    from: string,
    to: string,
  ): Promise<Array<{ key: string; summary: string }>> {
    const jql = `worklogAuthor = "${accountId}" AND worklogDate >= "${from}" AND worklogDate <= "${to}"`;
    const data = await this.request<{ issues: Array<{ key: string; fields: { summary: string } }> }>(
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=100`,
    );
    return data.issues.map((i) => ({ key: i.key, summary: i.fields.summary }));
  }

  /** Returns worklogs for an issue filtered by author and date range. */
  async getWorklogsForAuthor(
    issueKey: string,
    authorAccountId: string,
    from: string,
    to: string,
  ): Promise<Array<{ id: string; started: string; timeSpentSeconds: number; comment: string }>> {
    const startedAfterMs = new Date(from).getTime();
    const startedBeforeMs = new Date(`${to}T23:59:59Z`).getTime();
    const data = await this.request<{
      worklogs: Array<{ id: string; started: string; timeSpentSeconds: number; author: { accountId: string }; comment?: unknown }>;
    }>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog?startedAfter=${startedAfterMs}`);
    return data.worklogs
      .filter(
        (w) => w.author.accountId === authorAccountId && new Date(w.started).getTime() <= startedBeforeMs,
      )
      .map((w) => ({ id: w.id, started: w.started, timeSpentSeconds: w.timeSpentSeconds, comment: adfToText(w.comment) }));
  }

  /** Adds a worklog. Returns the created worklog id. */
  async addWorklog(input: AddWorklogInput): Promise<string> {
    const body: Record<string, unknown> = {
      started: startedAt(input.date),
      timeSpentSeconds: input.timeSpentSeconds,
    };
    if (input.comment) body.comment = adf(input.comment);
    if (input.marker) {
      body.properties = [{ key: 'git-auto-imputer', value: input.marker }];
    }
    const created = await this.request<{ id: string }>(
      `/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/worklog?notifyUsers=false`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    return created.id;
  }

  /** Updates only the comment of an existing worklog. */
  async updateWorklogComment(issueKey: string, worklogId: string, comment: string): Promise<void> {
    const current = await this.request<{ started: string; timeSpentSeconds: number }>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog/${worklogId}`,
    );
    await this.request<unknown>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog/${worklogId}?notifyUsers=false`,
      {
        method: 'PUT',
        body: JSON.stringify({
          started: current.started,
          timeSpentSeconds: current.timeSpentSeconds,
          comment: adf(comment),
        }),
      },
    );
  }

  /** Updates time and/or comment of an existing worklog. */
  async updateWorklog(issueKey: string, worklogId: string, seconds: number, comment: string): Promise<void> {
    const current = await this.request<{ started: string }>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog/${worklogId}`,
    );
    await this.request<unknown>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog/${worklogId}?notifyUsers=false`,
      {
        method: 'PUT',
        body: JSON.stringify({
          started: current.started,
          timeSpentSeconds: seconds,
          comment: adf(comment),
        }),
      },
    );
  }

  /** Deletes a worklog entry from an issue. */
  async deleteWorklog(issueKey: string, worklogId: string): Promise<void> {
    await this.request<void>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog/${worklogId}?notifyUsers=false`,
      { method: 'DELETE' },
    );
  }
}
