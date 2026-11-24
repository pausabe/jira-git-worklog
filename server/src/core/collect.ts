import type { Config, Person } from '../config.js';
import type { CollectedCommit } from '../types.js';
import type { GithubClient, GithubCommit } from '../clients/github.js';
import { extractTicketKey } from './ticket.js';
import { addDays, isoStart, isoEnd, localDay } from './dates.js';
import { getCachedChurn, cacheChurn, getLinkMap, linkKey } from '../store.js';
import { mapPool } from './pool.js';

export interface CollectResult {
  commits: CollectedCommit[];
  unlinkedBranches: Array<{ repo: string; branch: string; commitCount: number }>;
  unlinkedCommits: CollectedCommit[];
  reposScanned: number;
  branchesScanned: number;
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
  const author = await github.resolveAuthor(person.githubLogin, person.emails);
  if (!author) throw new Error(`Person '${person.id}' has no resolvable GitHub login or emails`);
  // GitHub filters by UTC instants but days are local: query from one day
  // before `from` and keep the commits whose local day is inside [from, to].
  const since = isoStart(addDays(from, -1));
  const sinceMs = new Date(since).getTime();
  // Default-branch history is filtered by committer date, which is never earlier
  // than the author date, so `since` is safe as-is; commits authored in range
  // but rebased/committed later need some slack on `until` (this also covers
  // the local-day margin). Feature branches are fetched unfiltered (compare).
  const queryUntil = isoEnd(addDays(to, 7));
  const inRange = (c: GithubCommit): boolean => {
    const day = localDay(c.date);
    return day >= from && day <= to;
  };
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

  const allRepos = await github.listRepos();
  // A repo with no push since `from` cannot hold commits from the range.
  const repos = allRepos.filter((r) => !r.pushedAt || new Date(r.pushedAt).getTime() >= sinceMs);
  onProgress?.(`Found ${allRepos.length} repos (${repos.length} active since ${from}), listing branches…`);

  // Discover every branch and resolve its ticket up front. Branches whose head
  // was committed before `from` cannot contain commits from the range (a commit
  // is committed after its ancestors, barring clock skew), so they are skipped.
  const branchLists = await mapPool(repos, 4, (repo) => github.listBranches(repo.fullName));
  interface BranchRef {
    repo: string;
    defaultBranch: string;
    branch: string;
    ticket: string | null;
  }
  const branches: BranchRef[] = [];
  repos.forEach((repo, i) => {
    for (const b of branchLists[i]!) {
      const isDefault = b.name === repo.defaultBranch;
      if (!isDefault && b.headDate && new Date(b.headDate).getTime() < sinceMs) continue;
      const fromName = extractTicketKey(b.name, config.ticketRegex);
      const fromLink = linkMap.get(linkKey(repo.fullName, b.name)) ?? branchNameFallback.get(b.name) ?? null;
      branches.push({ repo: repo.fullName, defaultBranch: repo.defaultBranch, branch: b.name, ticket: fromName ?? fromLink });
    }
  });
  const totalBranches = branchLists.reduce((n, list) => n + list.length, 0);

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

  onProgress?.(`Fetching commits from ${branches.length} of ${totalBranches} branches (others inactive since ${from})…`);

  // Per repo: the default branch history (with PRs, to attribute merged work),
  // then each feature branch's own commits (`default...branch`).
  const branchesByRepo = new Map<string, string[]>();
  for (const b of branches) {
    if (b.branch === b.defaultBranch) continue;
    const list = branchesByRepo.get(b.repo) ?? [];
    list.push(b.branch);
    branchesByRepo.set(b.repo, list);
  }
  const login = person.githubLogin.toLowerCase();
  const emails = new Set(person.emails.map((e) => e.toLowerCase()));
  const byPerson = (c: GithubCommit): boolean =>
    (!!login && c.authorLogin?.toLowerCase() === login) || (!!c.authorEmail && emails.has(c.authorEmail.toLowerCase()));
  const listsByRef = new Map<string, GithubCommit[]>();
  let completed = 0;
  await mapPool(repos, 4, async (repo) => {
    const [defaultHistory, featureCommits] = await Promise.all([
      github.branchHistory(repo.fullName, repo.defaultBranch, author, since, queryUntil),
      github.branchUniqueCommits(repo.fullName, repo.defaultBranch, branchesByRepo.get(repo.fullName) ?? []),
    ]);
    listsByRef.set(linkKey(repo.fullName, repo.defaultBranch), defaultHistory.filter(inRange));
    for (const [branch, list] of featureCommits) {
      listsByRef.set(linkKey(repo.fullName, branch), list.filter((c) => byPerson(c) && inRange(c)));
    }
    completed += 1;
    onProgress?.(`Fetching commits… ${completed}/${repos.length} repos`);
  });
  const commitLists = branches.map((ref) => ({ ref, list: listsByRef.get(linkKey(ref.repo, ref.branch)) ?? [] }));

  const claimed = new Set<string>();
  const commits: CollectedCommit[] = [];
  const unlinked = new Map<string, { repo: string; branch: string; commitCount: number }>();
  const unlinkedCommits: CollectedCommit[] = [];
  // Commits from the default branch that couldn't be attributed via branch name/link
  const defaultBranchUnclaimed: Array<{ repo: string; defaultBranch: string; c: GithubCommit }> = [];

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
          message: c.message,
          churn: 0,
        });
      } else if (ref.branch === ref.defaultBranch) {
        // Default branch commit — defer resolution via PR API (handles deleted feature branches)
        defaultBranchUnclaimed.push({ repo: ref.repo, defaultBranch: ref.defaultBranch, c });
      } else {
        const key = linkKey(ref.repo, ref.branch);
        const entry = unlinked.get(key) ?? { repo: ref.repo, branch: ref.branch, commitCount: 0 };
        entry.commitCount += 1;
        unlinked.set(key, entry);
        unlinkedCommits.push({
          repo: ref.repo, branch: ref.branch, sha: c.sha, ticket: null,
          authorLogin: c.authorLogin, authorEmail: c.authorEmail,
          date: c.date, message: c.message, churn: 0,
        });
      }
    }
  }

  // Resolve default-branch commits via their associated PRs (catches deleted feature branches).
  // The PRs come inline with the default-branch history, so no extra requests.
  if (defaultBranchUnclaimed.length > 0) {
    onProgress?.(`Resolving ${defaultBranchUnclaimed.length} commits via PR history…`);
    const resolved = defaultBranchUnclaimed.map(({ repo, defaultBranch, c }) => {
      const pulls = c.pulls ?? [];
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
      return { repo, c, ticket: null as string | null, branch: pulls[0]?.headRef ?? defaultBranch };
    });
    for (const hit of resolved) {
      if (claimed.has(hit.c.sha)) continue;
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
          message: hit.c.message,
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
          date: hit.c.date, message: hit.c.message, churn: 0,
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

/** Fills in `churn` for each commit, using the cache and fetching the rest in batches. */
async function resolveChurn(github: GithubClient, commits: CollectedCommit[]): Promise<void> {
  const cached = await getCachedChurn([...new Set(commits.map((c) => c.sha))]);

  const missingByRepo = new Map<string, Set<string>>();
  for (const c of commits) {
    if (c.sha in cached) continue;
    const set = missingByRepo.get(c.repo) ?? new Set<string>();
    set.add(c.sha);
    missingByRepo.set(c.repo, set);
  }
  const fetched: Record<string, number> = {};
  await mapPool([...missingByRepo], 4, async ([repo, shas]) => {
    Object.assign(fetched, await github.commitChurn(repo, [...shas]));
  });
  await cacheChurn(fetched);

  const all = { ...cached, ...fetched };
  for (const c of commits) c.churn = all[c.sha] ?? 0;
}
