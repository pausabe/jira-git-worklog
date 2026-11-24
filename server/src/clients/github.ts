import type { Env } from '../env.js';
import { mapPool } from '../core/pool.js';

/**
 * GitHub access goes through the GraphQL API only. The REST equivalent needed
 * one request per branch (compare) plus one per commit (churn, PRs), which for
 * an org with ~1000 branches burned the 5000 req/h REST quota in a handful of
 * previews. GraphQL lets us batch many branches per request and has its own,
 * separate point budget.
 */
const GRAPHQL_URL = 'https://api.github.com/graphql';

/** Branches whose history is fetched per GraphQL request (keeps queries < 10s). */
const REFS_PER_QUERY = 20;
/** Commits whose churn is fetched per GraphQL request. */
const CHURN_PER_QUERY = 50;
/** Concurrent GraphQL requests per repo (kept low to avoid secondary rate limits). */
const CONCURRENCY = 4;

export interface GithubRepo {
  name: string;
  fullName: string; // owner/name
  defaultBranch: string;
  pushedAt: string | null;
}

export interface GithubBranch {
  name: string;
  /** Committer date of the branch head. */
  headDate: string | null;
}

export interface GithubCommit {
  sha: string;
  authorLogin: string | null;
  authorEmail: string | null;
  date: string; // ISO author date
  message: string; // first line
  /** Pull requests containing this commit (only fetched for the default branch). */
  pulls?: Array<{ headRef: string; title: string }>;
}

/** GraphQL `CommitAuthor` filter: a user node id, or a list of emails. */
export type CommitAuthorFilter = { id: string } | { emails: string[] };

export class GithubRateLimitError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function resetTime(res: Response): string {
  const reset = Number(res.headers.get('x-ratelimit-reset') ?? '0');
  if (!reset) return 'within the hour';
  return `at ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC`;
}

interface RawCommit {
  oid: string;
  authoredDate: string;
  message: string;
  parents: { totalCount: number };
  author: { email: string | null; user: { login: string } | null } | null;
  associatedPullRequests?: { nodes: Array<{ headRefName: string; title: string }> };
}

interface RawCommitPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: RawCommit[];
}

const COMMIT_FIELDS = `
  oid authoredDate message
  parents { totalCount }
  author { email user { login } }`;

export class GithubClient {
  private readonly token: string;
  readonly org: string;

  constructor(env: Pick<Env, 'githubToken' | 'githubOrg'>) {
    this.token = env.githubToken;
    this.org = env.githubOrg;
  }

  /**
   * Runs a GraphQL query. Retries transient 5xx/timeouts and secondary rate
   * limits; fails fast (with the reset time) when the hourly budget is spent,
   * since waiting it out inside a request is pointless.
   */
  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let lastError = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'jira-git-worklog',
        },
        body: JSON.stringify({ query, variables }),
      });

      if (res.status === 403 || res.status === 429) {
        if (res.headers.get('x-ratelimit-remaining') === '0') {
          throw new GithubRateLimitError(`GitHub API rate limit exhausted; it resets ${resetTime(res)}.`);
        }
        const retryAfter = Number(res.headers.get('retry-after') ?? '0');
        lastError = `${res.status} ${await res.text().catch(() => '')}`;
        await sleep(Math.min((retryAfter || 5 * (attempt + 1)) * 1000, 60_000));
        continue;
      }
      if (res.status >= 500) {
        lastError = `${res.status} ${res.statusText}`;
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        throw new Error(`GitHub GraphQL -> ${res.status} ${res.statusText} ${await res.text().catch(() => '')}`);
      }

      const body = (await res.json()) as { data?: T; errors?: Array<{ type?: string; message: string }> };
      if (body.errors?.some((e) => e.type === 'RATE_LIMITED')) {
        throw new GithubRateLimitError(`GitHub API rate limit exhausted; it resets ${resetTime(res)}.`);
      }
      if (body.errors?.length || !body.data) {
        throw new Error(`GitHub GraphQL error: ${(body.errors ?? []).map((e) => e.message).join('; ') || 'empty response'}`);
      }
      return body.data;
    }
    throw new Error(`GitHub GraphQL failed after retries: ${lastError}`);
  }

  /** Builds the commit-author filter: GitHub login when known, else emails. */
  async resolveAuthor(login: string, emails: string[]): Promise<CommitAuthorFilter | null> {
    if (login) {
      const data = await this.graphql<{ user: { id: string } | null }>(
        'query($login: String!) { user(login: $login) { id } }',
        { login },
      ).catch(() => ({ user: null }));
      if (data.user) return { id: data.user.id };
    }
    return emails.length > 0 ? { emails } : null;
  }

  /** Lists non-archived repositories owned by the org (or user). */
  async listRepos(): Promise<GithubRepo[]> {
    const query = `query($owner: String!, $after: String) {
      repositoryOwner(login: $owner) {
        repositories(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { name nameWithOwner isArchived pushedAt owner { login } defaultBranchRef { name } }
        }
      }
    }`;
    type Page = {
      repositoryOwner: {
        repositories: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            name: string;
            nameWithOwner: string;
            isArchived: boolean;
            pushedAt: string | null;
            owner: { login: string };
            defaultBranchRef: { name: string } | null;
          }>;
        };
      } | null;
    };
    const out: GithubRepo[] = [];
    let after: string | null = null;
    do {
      const data: Page = await this.graphql<Page>(query, { owner: this.org, after });
      if (!data.repositoryOwner) throw new Error(`GitHub owner '${this.org}' not found`);
      const { nodes, pageInfo } = data.repositoryOwner.repositories;
      for (const r of nodes) {
        if (r.isArchived || !r.defaultBranchRef) continue; // archived or empty repo
        if (r.owner.login.toLowerCase() !== this.org.toLowerCase()) continue;
        out.push({ name: r.name, fullName: r.nameWithOwner, defaultBranch: r.defaultBranchRef.name, pushedAt: r.pushedAt });
      }
      after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  /** Lists branches with the committer date of their head commit. */
  async listBranches(fullName: string): Promise<GithubBranch[]> {
    const [owner, name] = fullName.split('/') as [string, string];
    const query = `query($owner: String!, $name: String!, $after: String) {
      repository(owner: $owner, name: $name) {
        refs(refPrefix: "refs/heads/", first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { name target { ... on Commit { committedDate } } }
        }
      }
    }`;
    type Page = {
      repository: {
        refs: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{ name: string; target: { committedDate?: string } | null }>;
        };
      };
    };
    const out: GithubBranch[] = [];
    let after: string | null = null;
    do {
      const data: Page = await this.graphql<Page>(query, { owner, name, after });
      const { nodes, pageInfo } = data.repository.refs;
      for (const r of nodes) out.push({ name: r.name, headDate: r.target?.committedDate ?? null });
      after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  /**
   * Non-merge commits on `branch` by `author`, committed within [sinceIso,
   * untilIso], each with the pull requests that contain it. Used for the
   * default branch, where merged feature work is attributed via its PR.
   * If PRs can't be read (e.g. a fine-grained token without the Pull requests
   * permission), commits are returned without them.
   */
  async branchHistory(
    fullName: string,
    branch: string,
    author: CommitAuthorFilter,
    sinceIso: string,
    untilIso: string,
  ): Promise<GithubCommit[]> {
    try {
      return await this.fetchHistory(fullName, branch, author, sinceIso, untilIso, true);
    } catch (err) {
      if (err instanceof GithubRateLimitError) throw err;
      return this.fetchHistory(fullName, branch, author, sinceIso, untilIso, false);
    }
  }

  private async fetchHistory(
    fullName: string,
    branch: string,
    author: CommitAuthorFilter,
    sinceIso: string,
    untilIso: string,
    withPulls: boolean,
  ): Promise<GithubCommit[]> {
    const pulls = withPulls ? 'associatedPullRequests(first: 5) { nodes { headRefName title } }' : '';
    const [owner, name] = fullName.split('/') as [string, string];
    const query = `query($owner: String!, $name: String!, $ref: String!, $since: GitTimestamp!,
      $until: GitTimestamp!, $author: CommitAuthor!, $after: String) {
      repository(owner: $owner, name: $name) { ref(qualifiedName: $ref) { target { ... on Commit {
        history(first: 100, after: $after, since: $since, until: $until, author: $author) {
          pageInfo { hasNextPage endCursor }
          nodes { ${COMMIT_FIELDS} ${pulls} }
        }
      } } } }
    }`;
    type Page = { repository: { ref: { target: { history?: RawCommitPage } | null } | null } };
    const out: GithubCommit[] = [];
    let after: string | null = null;
    do {
      const data: Page = await this.graphql<Page>(query, {
        owner, name, ref: `refs/heads/${branch}`, since: sinceIso, until: untilIso, author, after,
      });
      const history = data.repository.ref?.target?.history;
      if (!history) break;
      out.push(...history.nodes.filter(isNotMerge).map(toCommit));
      after = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  /**
   * For each branch, the non-merge commits it has that `baseBranch` doesn't
   * (`base...branch`), unfiltered — callers filter by author and date.
   * Branches are batched REFS_PER_QUERY per request; a branch more than 100
   * commits ahead is paginated on its own.
   */
  async branchUniqueCommits(
    fullName: string,
    baseBranch: string,
    branches: string[],
  ): Promise<Map<string, GithubCommit[]>> {
    const [owner, name] = fullName.split('/') as [string, string];
    const compareSelection = (alias: string, headVar: string, afterVar = '') =>
      `${alias}: compare(headRef: ${headVar}) { commits(first: 100${afterVar ? `, after: ${afterVar}` : ''}) {
        pageInfo { hasNextPage endCursor } nodes { ${COMMIT_FIELDS} } } }`;
    const result = new Map<string, GithubCommit[]>();
    const pending: Array<{ branch: string; cursor: string }> = [];

    await mapPool(chunk(branches, REFS_PER_QUERY), CONCURRENCY, async (group) => {
      const vars: Record<string, unknown> = { owner, name, base: `refs/heads/${baseBranch}` };
      group.forEach((branch, i) => (vars[`h${i}`] = branch));
      const decls = group.map((_, i) => `$h${i}: String!`).join(', ');
      const selections = group.map((_, i) => compareSelection(`b${i}`, `$h${i}`)).join('\n');
      const data = await this.graphql<{
        repository: { ref: Record<string, { commits: RawCommitPage } | null> | null };
      }>(
        `query($owner: String!, $name: String!, $base: String!, ${decls}) {
          repository(owner: $owner, name: $name) { ref(qualifiedName: $base) { ${selections} } }
        }`,
        vars,
      );
      group.forEach((branch, i) => {
        const page = data.repository.ref?.[`b${i}`]?.commits;
        if (!page) return; // branch deleted meanwhile, or no common history
        result.set(branch, page.nodes.filter(isNotMerge).map(toCommit));
        if (page.pageInfo.hasNextPage && page.pageInfo.endCursor) {
          pending.push({ branch, cursor: page.pageInfo.endCursor });
        }
      });
    });

    await mapPool(pending, CONCURRENCY, async ({ branch, cursor }) => {
      let after: string | null = cursor;
      while (after) {
        const data: { repository: { ref: { c: { commits: RawCommitPage } | null } | null } } = await this.graphql(
          `query($owner: String!, $name: String!, $base: String!, $head: String!, $after: String) {
            repository(owner: $owner, name: $name) { ref(qualifiedName: $base) { ${compareSelection('c', '$head', '$after')} } }
          }`,
          { owner, name, base: `refs/heads/${baseBranch}`, head: branch, after },
        );
        const page = data.repository.ref?.c?.commits;
        if (!page) break;
        result.get(branch)!.push(...page.nodes.filter(isNotMerge).map(toCommit));
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      }
    });
    return result;
  }

  /** Lines changed (additions + deletions) per commit, batched. */
  async commitChurn(fullName: string, shas: string[]): Promise<Record<string, number>> {
    const [owner, name] = fullName.split('/') as [string, string];
    const out: Record<string, number> = {};
    for (const group of chunk(shas, CHURN_PER_QUERY)) {
      const vars: Record<string, unknown> = { owner, name };
      const decls = group.map((_, i) => `$o${i}: GitObjectID!`).join(', ');
      const selections = group
        .map((sha, i) => {
          vars[`o${i}`] = sha;
          return `c${i}: object(oid: $o${i}) { ... on Commit { additions deletions } }`;
        })
        .join('\n');
      const data = await this.graphql<{
        repository: Record<string, { additions?: number; deletions?: number } | null>;
      }>(`query($owner: String!, $name: String!, ${decls}) { repository(owner: $owner, name: $name) { ${selections} } }`, vars);
      group.forEach((sha, i) => {
        const c = data.repository[`c${i}`];
        out[sha] = (c?.additions ?? 0) + (c?.deletions ?? 0);
      });
    }
    return out;
  }
}

function isNotMerge(c: RawCommit): boolean {
  return c.parents.totalCount <= 1;
}

function toCommit(c: RawCommit): GithubCommit {
  return {
    sha: c.oid,
    authorLogin: c.author?.user?.login ?? null,
    authorEmail: c.author?.email ?? null,
    // GraphQL keeps the author's UTC offset; normalise to UTC like the REST API
    // did. Callers derive the calendar day with localDay().
    date: new Date(c.authoredDate).toISOString(),
    message: c.message.split('\n')[0]!,
    pulls: c.associatedPullRequests?.nodes.map((pr) => ({ headRef: pr.headRefName, title: pr.title })),
  };
}
