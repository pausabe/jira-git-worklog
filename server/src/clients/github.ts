import type { Env } from '../env.js';

const API = 'https://api.github.com';

export interface GithubRepo {
  name: string;
  fullName: string; // owner/name
  defaultBranch: string;
  archived: boolean;
}

export interface GithubBranch {
  name: string;
  commitSha: string;
}

export interface GithubCommit {
  sha: string;
  authorLogin: string | null;
  authorEmail: string | null;
  date: string; // ISO author date
  message: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GithubClient {
  private readonly token: string;
  readonly org: string;

  constructor(env: Pick<Env, 'githubToken' | 'githubOrg'>) {
    this.token = env.githubToken;
    this.org = env.githubOrg;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jira-git-worklog',
    };
  }

  /** Fetch with basic secondary-rate-limit handling (honours Retry-After). */
  private async fetchRaw(url: string): Promise<Response> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await fetch(url, { headers: this.headers() });
      if (res.status === 403 || res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '0');
        const remaining = res.headers.get('x-ratelimit-remaining');
        if (retryAfter > 0 || remaining === '0') {
          const waitMs = retryAfter > 0 ? retryAfter * 1000 : 2000 * (attempt + 1);
          await sleep(Math.min(waitMs, 10_000));
          continue;
        }
      }
      return res;
    }
    // Final attempt without catching, so the caller sees a real error.
    return fetch(url, { headers: this.headers() });
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await this.fetchRaw(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub GET ${url} -> ${res.status} ${res.statusText} ${body}`);
    }
    return (await res.json()) as T;
  }

  /** Paginates a list endpoint by following the RFC 5988 Link header. */
  private async paginate<T>(firstUrl: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = firstUrl;
    while (url) {
      const res = await this.fetchRaw(url);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`GitHub GET ${url} -> ${res.status} ${res.statusText} ${body}`);
      }
      const page = (await res.json()) as T[];
      out.push(...page);
      url = parseNextLink(res.headers.get('link'));
    }
    return out;
  }

  /** Lists non-archived repositories owned by the org (or user as a fallback). */
  async listRepos(): Promise<GithubRepo[]> {
    let raw: Array<{ name: string; full_name: string; default_branch: string; archived: boolean }>;
    try {
      raw = await this.paginate(`${API}/orgs/${this.org}/repos?per_page=100&type=all`);
    } catch {
      raw = await this.paginate(`${API}/users/${this.org}/repos?per_page=100&type=owner`);
    }
    return raw
      .filter((r) => !r.archived)
      .map((r) => ({
        name: r.name,
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        archived: r.archived,
      }));
  }

  async listBranches(fullName: string): Promise<GithubBranch[]> {
    const raw = await this.paginate<{ name: string; commit: { sha: string } }>(
      `${API}/repos/${fullName}/branches?per_page=100`,
    );
    return raw.map((b) => ({ name: b.name, commitSha: b.commit.sha }));
  }

  /**
   * Lists commits on a branch by a given author within a date range.
   * `author` may be a GitHub login or an email address.
   */
  async listCommits(
    fullName: string,
    branch: string,
    author: string,
    sinceIso: string,
    untilIso: string,
  ): Promise<GithubCommit[]> {
    const params = new URLSearchParams({
      sha: branch,
      since: sinceIso,
      until: untilIso,
      per_page: '100',
    });
    if (author) params.set('author', author);
    const raw = await this.paginate<{
      sha: string;
      commit: { author: { email?: string; date: string }; message: string };
      author: { login: string } | null;
      parents: { sha: string }[];
    }>(`${API}/repos/${fullName}/commits?${params.toString()}`);
    return raw
      .filter((c) => c.parents.length <= 1) // exclude merge commits (2+ parents)
      .map((c) => ({
        sha: c.sha,
        authorLogin: c.author?.login ?? null,
        authorEmail: c.commit.author?.email ?? null,
        date: c.commit.author.date,
        message: c.commit.message,
      }));
  }

  /**
   * For feature branches: returns only commits unique to `branch` vs `baseBranch`
   * (compare API). Falls back to listCommits only on API error, NOT on 0 results
   * (0 results means the branch is merged — those commits are handled via the
   * default-branch + PR-resolution path in collect.ts).
   */
  async listBranchUniqueCommits(
    fullName: string,
    baseBranch: string,
    branch: string,
    author: string,
    sinceIso: string,
    untilIso: string,
  ): Promise<GithubCommit[]> {
    if (branch === baseBranch) {
      return this.listCommits(fullName, branch, author, sinceIso, untilIso);
    }
    let raw: Array<{
      sha: string;
      commit: { author: { email?: string; date: string }; message: string };
      author: { login: string } | null;
      parents: { sha: string }[];
    }>;
    try {
      const data = await this.getJson<{ commits: typeof raw }>(
        `${API}/repos/${fullName}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(branch)}`,
      );
      raw = data.commits;
    } catch {
      // API error (e.g. no common ancestor) — fall back to regular listing.
      return this.listCommits(fullName, branch, author, sinceIso, untilIso);
    }
    // 0 results = branch already merged into base. Do NOT fall back — those
    // commits will be found via the default-branch + PR-resolution path.
    const sinceMs = new Date(sinceIso).getTime();
    const untilMs = new Date(untilIso).getTime();
    const a = author.toLowerCase();
    return raw
      .filter((c) => c.parents.length <= 1)
      .filter((c) => {
        const ms = new Date(c.commit.author.date).getTime();
        return ms >= sinceMs && ms <= untilMs;
      })
      .filter((c) => {
        if (!author) return true;
        return (
          c.author?.login?.toLowerCase() === a ||
          c.commit.author?.email?.toLowerCase() === a
        );
      })
      .map((c) => ({
        sha: c.sha,
        authorLogin: c.author?.login ?? null,
        authorEmail: c.commit.author?.email ?? null,
        date: c.commit.author.date,
        message: c.commit.message,
      }));
  }
  async getCommitChurn(fullName: string, sha: string): Promise<number> {
    const data = await this.getJson<{ stats?: { total?: number } }>(
      `${API}/repos/${fullName}/commits/${sha}`,
    );
    return data.stats?.total ?? 0;
  }

  /**
   * Returns pull requests associated with a commit (useful for finding
   * the originating branch of a commit that landed on the default branch).
   * Also checks the PR title for a ticket key.
   */
  async getCommitPullRequests(
    fullName: string,
    sha: string,
  ): Promise<Array<{ headRef: string; title: string }>> {
    try {
      const data = await this.getJson<Array<{ head: { ref: string }; title: string }>>(
        `${API}/repos/${fullName}/commits/${sha}/pulls`,
      );
      return data.map((pr) => ({ headRef: pr.head.ref, title: pr.title }));
    } catch {
      return [];
    }
  }
}

function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1]!;
  }
  return null;
}
