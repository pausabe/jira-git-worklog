import type { Config, Person } from '../config.js';
import type { CollectedCommit } from '../types.js';
import { GithubClient } from '../clients/github.js';
import { extractTicketKey } from './ticket.js';
import { isoStart, isoEnd } from './dates.js';
import { getCachedChurn, cacheChurn, getLinkMap, linkKey } from '../store.js';

export interface CollectResult {
  commits: CollectedCommit[];
  unlinkedBranches: Array<{ repo: string; branch: string; commitCount: number }>;
  unlinkedCommits: CollectedCommit[];
  reposScanned: number;
  branchesScanned: number;
}

/** Runs an async mapper over items with a bounded concurrency. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function authorIdentifier(person: Person): string {
  return person.githubLogin || person.emails[0] || '';
}

/**
 * Collects the person's commits across all org branches within [from, to],
 * attributing each commit to a Jira ticket (from the branch name or a manual
 * link) and enriching it with churn. Branches with commits but no resolvable
 * ticket are returned separately so the UI can prompt for manual linking.
 */
export async function collectCommits(
  github: GithubClient,
  config: Config,
  person: Person,
  from: string,
  to: string,
  onProgress?: (msg: string) => void,
  extraLinks?: Map<string, string>,
): Promise<CollectResult> {
  const author = authorIdentifier(person);
  const since = isoStart(from);
  const until = isoEnd(to);
  const storeLinkMap = await getLinkMap();
  const linkMap = extraLinks?.size ? new Map([...storeLinkMap, ...extraLinks]) : storeLinkMap;

  // Cross-repo fallback: if the same branch name is linked in ANY repo, reuse that
  // ticket for repos where the branch has no explicit link. This handles the common
  // case of working the same feature across multiple repos.
  const branchNameFallback = new Map<string, string>();
  for (const [key, ticket] of linkMap) {
    const sep = key.indexOf('@@');
    if (sep !== -1) {
      const bn = key.slice(sep + 2);
      if (!branchNameFallback.has(bn)) branchNameFallback.set(bn, ticket);
    }
  }

  const repos = await github.listRepos();
  onProgress?.(`Found ${repos.length} repos, listing branches…`);

  // Discover every branch and resolve its ticket up front.
  const branchLists = await mapPool(repos, 6, (repo) => github.listBranches(repo.fullName));
  interface BranchRef {
    repo: string;
    defaultBranch: string;
    branch: string;
    ticket: string | null;
  }
  const branches: BranchRef[] = [];
  repos.forEach((repo, i) => {
    for (const b of branchLists[i]!) {
      const fromName = extractTicketKey(b.name, config.ticketRegex);
      const fromLink = linkMap.get(linkKey(repo.fullName, b.name)) ?? branchNameFallback.get(b.name) ?? null;
      branches.push({ repo: repo.fullName, defaultBranch: repo.defaultBranch, branch: b.name, ticket: fromName ?? fromLink });
    }
  });

  // Sort so that:
  // 1. Default branch is processed LAST (won't steal commits from feature branches)
  // 2. Ticketed feature branches are sorted by ticket number ASC (older branches first,
  //    so they claim their commits before newer branches that inherited them via merge)
  // 3. Unlinked branches are between ticketed and default
  function ticketNum(ticket: string | null): number {
    if (!ticket) return Infinity;
    const m = ticket.match(/(\d+)$/);
    return m ? parseInt(m[1]!, 10) : Infinity;
  }
  branches.sort((a, b) => {
    const aIsDefault = a.branch === a.defaultBranch;
    const bIsDefault = b.branch === b.defaultBranch;
    if (aIsDefault !== bIsDefault) return aIsDefault ? 1 : -1;
    const aHasTicket = a.ticket !== null;
    const bHasTicket = b.ticket !== null;
    if (aHasTicket !== bHasTicket) return aHasTicket ? -1 : 1;
    return ticketNum(a.ticket) - ticketNum(b.ticket);
  });

  onProgress?.(`Found ${branches.length} branches, fetching commits…`);

  // Fetch commits for all branches in parallel, then deduplicate sequentially.
  let completed = 0;
  const commitLists = await mapPool(branches, 6, async (ref) => {
    const list = await github.listBranchUniqueCommits(ref.repo, ref.defaultBranch, ref.branch, author, since, until);
    completed += 1;
    onProgress?.(`Fetching commits… ${completed}/${branches.length} branches`);
    return { ref, list };
  });

  const claimed = new Set<string>();
  const commits: CollectedCommit[] = [];
  const unlinked = new Map<string, { repo: string; branch: string; commitCount: number }>();
  const unlinkedCommits: CollectedCommit[] = [];
  // Commits from the default branch that couldn't be attributed via branch name/link
  const defaultBranchUnclaimed: Array<{ repo: string; c: typeof commitLists[0]['list'][0] }> = [];

  for (const { ref, list } of commitLists) {
    for (const c of list) {
      if (claimed.has(c.sha)) continue;
      if (ref.ticket) {
        claimed.add(c.sha);
        commits.push({
          repo: ref.repo,
          branch: ref.branch,
          sha: c.sha,
          ticket: ref.ticket,
          authorLogin: c.authorLogin,
          authorEmail: c.authorEmail,
          date: c.date,
          message: c.message.split('\n')[0]!,
          churn: 0,
        });
      } else if (ref.branch === ref.defaultBranch) {
        // Default branch commit — defer resolution via PR API (handles deleted feature branches)
        defaultBranchUnclaimed.push({ repo: ref.repo, c });
      } else {
        const key = linkKey(ref.repo, ref.branch);
        const entry = unlinked.get(key) ?? { repo: ref.repo, branch: ref.branch, commitCount: 0 };
        entry.commitCount += 1;
        unlinked.set(key, entry);
        unlinkedCommits.push({
          repo: ref.repo, branch: ref.branch, sha: c.sha, ticket: null,
          authorLogin: c.authorLogin, authorEmail: c.authorEmail,
          date: c.date, message: c.message.split('\n')[0]!, churn: 0,
        });
      }
    }
  }

  // Resolve default-branch commits via their associated PRs (catches deleted feature branches)
  if (defaultBranchUnclaimed.length > 0) {
    onProgress?.(`Resolving ${defaultBranchUnclaimed.length} commits via PR history…`);
    const resolved = await mapPool(defaultBranchUnclaimed, 6, async ({ repo, c }) => {
      if (claimed.has(c.sha)) return null;
      const pulls = await github.getCommitPullRequests(repo, c.sha);
      // Prefer a PR whose head branch resolves to a ticket.
      for (const pr of pulls) {
        const ticket =
          extractTicketKey(pr.headRef, config.ticketRegex) ??
          extractTicketKey(pr.title, config.ticketRegex) ??
          linkMap.get(linkKey(repo, pr.headRef)) ??
          branchNameFallback.get(pr.headRef) ??
          null;
        if (ticket) return { repo, c, ticket, branch: pr.headRef };
      }
      // No ticket found — remember the originating branch (if any) so the commit
      // surfaces as an unlinked branch the user can map manually.
      const originBranch = pulls[0]?.headRef ?? branches.find((b) => b.repo === repo)?.defaultBranch ?? 'main';
      return { repo, c, ticket: null as string | null, branch: originBranch };
    });
    for (const hit of resolved) {
      if (!hit || claimed.has(hit.c.sha)) continue;
      claimed.add(hit.c.sha);
      if (hit.ticket) {
        commits.push({
          repo: hit.repo,
          branch: hit.branch,
          sha: hit.c.sha,
          ticket: hit.ticket,
          authorLogin: hit.c.authorLogin,
          authorEmail: hit.c.authorEmail,
          date: hit.c.date,
          message: hit.c.message.split('\n')[0]!,
          churn: 0,
        });
      } else {
        // Unlinked: track under the originating branch so the user can map it.
        const key = linkKey(hit.repo, hit.branch);
        const entry = unlinked.get(key) ?? { repo: hit.repo, branch: hit.branch, commitCount: 0 };
        entry.commitCount += 1;
        unlinked.set(key, entry);
        unlinkedCommits.push({
          repo: hit.repo, branch: hit.branch, sha: hit.c.sha, ticket: null,
          authorLogin: hit.c.authorLogin, authorEmail: hit.c.authorEmail,
          date: hit.c.date, message: hit.c.message.split('\n')[0]!, churn: 0,
        });
      }
    }
  }

  onProgress?.(`Resolving churn for ${commits.length} commits…`);
  await resolveChurn(github, commits);

  return {
    commits,
    unlinkedBranches: [...unlinked.values()].sort((a, b) => b.commitCount - a.commitCount),
    unlinkedCommits,
    reposScanned: repos.length,
    branchesScanned: branches.length,
  };
}

/** Fills in `churn` for each commit, using the cache and fetching the rest. */
async function resolveChurn(github: GithubClient, commits: CollectedCommit[]): Promise<void> {
  const byRepoSha = new Map<string, CollectedCommit[]>();
  for (const c of commits) {
    const key = `${c.repo}#${c.sha}`;
    const list = byRepoSha.get(key) ?? [];
    list.push(c);
    byRepoSha.set(key, list);
  }

  const uniqueShas = [...new Set(commits.map((c) => c.sha))];
  const cached = await getCachedChurn(uniqueShas);

  const toFetch = [...byRepoSha.keys()].filter((k) => !(k.split('#')[1]! in cached));
  const fetched: Record<string, number> = {};
  await mapPool(toFetch, 5, async (key) => {
    const [repo, sha] = key.split('#') as [string, string];
    const churn = await github.getCommitChurn(repo, sha);
    fetched[sha] = churn;
  });
  await cacheChurn(fetched);

  const all = { ...cached, ...fetched };
  for (const c of commits) c.churn = all[c.sha] ?? 0;
}
