import Fastify from 'fastify';
import cors from '@fastify/cors';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { loadEnv } from './env.js';
import { loadConfig, saveConfig, ConfigSchema } from './config.js';
import { JiraClient } from './clients/jira.js';
import { GithubClient } from './clients/github.js';
import { collectCommits } from './core/collect.js';
import { buildPlan } from './core/distribute.js';
import { applyPlan } from './core/impute.js';
import { listLinks, upsertLink, deleteLink, getLastLoggedDate, linkKey } from './store.js';
import type { Plan } from './types.js';

const env = loadEnv();
const jira = new JiraClient(env);
const github = new GithubClient(env);

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato esperado YYYY-MM-DD');

app.get('/api/health', async () => ({ ok: true }));

app.get('/api/me', async () => {
  const me = await jira.getMyself();
  return { jira: me, githubOrg: github.org };
});

app.get('/api/config', async () => loadConfig(env.configPath));

app.put('/api/config', async (req, reply) => {
  const parsed = ConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: 'Invalid config', issues: parsed.error.issues };
  }
  return saveConfig(env.configPath, parsed.data);
});

const PreviewBody = z.object({
  person: z.string().min(1),
  from: DateStr,
  to: DateStr,
  tempLinks: z.array(z.object({ repo: z.string(), branch: z.string(), ticket: z.string() })).optional(),
});

app.post('/api/preview', async (req, reply) => {
  const parsed = PreviewBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: 'Invalid parameters', issues: parsed.error.issues };
  }
  const { person: personId, from, to, tempLinks } = parsed.data;
  const config = await loadConfig(env.configPath);
  const person = config.people.find((p) => p.id === personId);
  if (!person) {
    reply.code(400);
    return { error: `Person '${personId}' not found in config.people` };
  }
  if (!person.githubLogin && person.emails.length === 0) {
    reply.code(400);
    return { error: `Person '${personId}' has no githubLogin or emails to attribute commits` };
  }

  const stream = new PassThrough();
  reply
    .header('Content-Type', 'text/event-stream')
    .header('Cache-Control', 'no-cache')
    .header('Connection', 'keep-alive')
    .send(stream);

  const send = (event: object) => stream.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    send({ type: 'progress', message: 'Checking existing Jira worklogs…' });
    const me = await jira.getMyself();
    const existingIssues = await jira.searchWorklogIssues(me.accountId, from, to);
    const existingByDay = new Map<string, number>();
    const loggedByDay: Record<string, Array<{ issueKey: string; summary: string; worklogId: string; seconds: number; comment: string }>> = {};
    await Promise.all(
      existingIssues.map(async ({ key, summary }) => {
        const worklogs = await jira.getWorklogsForAuthor(key, me.accountId, from, to);
        for (const wl of worklogs) {
          const date = wl.started.slice(0, 10);
          existingByDay.set(date, (existingByDay.get(date) ?? 0) + wl.timeSpentSeconds);
          (loggedByDay[date] ??= []).push({ issueKey: key, summary, worklogId: wl.id, seconds: wl.timeSpentSeconds, comment: wl.comment });
        }
      }),
    );

    const existingIssuesByDay = new Map<string, Set<string>>();
    for (const [date, entries] of Object.entries(loggedByDay)) {
      existingIssuesByDay.set(date, new Set(entries.map((e) => e.issueKey)));
    }

    const extraLinks = tempLinks?.length
      ? new Map(tempLinks.map(({ repo, branch, ticket }) => [linkKey(repo, branch), ticket]))
      : undefined;
    const collected = await collectCommits(github, config, person, from, to, (msg) =>
      send({ type: 'progress', message: msg }),
      extraLinks,
    );
    const plan = buildPlan(config, person.id, from, to, collected.commits, existingByDay, existingIssuesByDay);
    const commitsByDay: Record<string, Array<{ repo: string; branch: string; ticket: string; message: string; churn: number; unlinked?: boolean }>> = {};
    for (const c of collected.commits) {
      const date = c.date.slice(0, 10);
      (commitsByDay[date] ??= []).push({ repo: c.repo, branch: c.branch, ticket: c.ticket ?? '', message: c.message, churn: c.churn });
    }
    for (const c of collected.unlinkedCommits) {
      const date = c.date.slice(0, 10);
      (commitsByDay[date] ??= []).push({ repo: c.repo, branch: c.branch, ticket: '', message: c.message, churn: 0, unlinked: true });
    }
    const allLinks = await listLinks();
    const suggestTicket = (repo: string, branch: string): string | undefined =>
      allLinks.find((l) => l.branch === branch && l.repo !== repo)?.ticket;

    send({
      type: 'done',
      plan,
      unlinkedBranches: collected.unlinkedBranches.map((ub) => ({
        ...ub,
        suggestion: suggestTicket(ub.repo, ub.branch),
      })),
      commitsByDay,
      loggedByDay,
      stats: {
        reposScanned: collected.reposScanned,
        branchesScanned: collected.branchesScanned,
        commits: collected.commits.length,
      },
    });
  } catch (err) {
    send({ type: 'error', message: (err as Error).message });
  } finally {
    stream.end();
  }
});

// The plan may be edited client-side before submission, so accept it verbatim.
const ImputeBody = z.object({
  person: z.string().min(1),
  plan: z.object({
    person: z.string(),
    from: z.string(),
    to: z.string(),
    days: z.array(
      z.object({
        date: z.string(),
        weekday: z.string(),
        workdaySeconds: z.number(),
        existingSeconds: z.number().default(0),
        entries: z.array(
          z.object({
            date: z.string(),
            issue: z.string(),
            seconds: z.number().int().nonnegative(),
            source: z.enum(['commits', 'recurring', 'fallback']),
            label: z.string().optional(),
            detail: z.string().optional(),
            comment: z.string().optional(),
          }),
        ),
        warnings: z.array(z.string()),
      }),
    ),
  }),
});

app.post('/api/impute', async (req, reply) => {
  const parsed = ImputeBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: 'Invalid parameters', issues: parsed.error.issues };
  }
  return applyPlan(jira, parsed.data.person, parsed.data.plan as Plan);
});

app.get('/api/links', async () => listLinks());

app.get('/api/last-logged-date', async (req, reply) => {
  const { person = '', before } = req.query as Record<string, string>;
  if (!person) { reply.code(400); return { error: 'person required' }; }

  // Check local ledger first (fast)
  const localDate = await getLastLoggedDate(person, before || undefined);
  if (localDate) return { date: localDate };

  // Fall back to Jira: scan the last 90 days ending before `before` (or today)
  try {
    const me = await jira.getMyself();
    const to = before
      ? new Date(new Date(before).getTime() - 86_400_000).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const from = new Date(new Date(to).getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
    const issues = await jira.searchWorklogIssues(me.accountId, from, to);
    let lastDate: string | null = null;
    await Promise.all(
      issues.map(async ({ key }) => {
        const worklogs = await jira.getWorklogsForAuthor(key, me.accountId, from, to);
        for (const wl of worklogs) {
          const d = wl.started.slice(0, 10);
          if (!lastDate || d > lastDate) lastDate = d;
        }
      }),
    );
    return { date: lastDate };
  } catch {
    return { date: null };
  }
});

const LinkBody = z.object({ repo: z.string().min(1), branch: z.string().min(1), ticket: z.string().min(1) });

const WorklogCommentBody = z.object({
  issueKey: z.string().min(1),
  worklogId: z.string().min(1),
  comment: z.string(),
});

app.put('/api/worklog-comment', async (req, reply) => {
  const parsed = WorklogCommentBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: 'Invalid parameters', issues: parsed.error.issues };
  }
  const { issueKey, worklogId, comment } = parsed.data;
  await jira.updateWorklogComment(issueKey, worklogId, comment);
  return { ok: true };
});

const UpdateWorklogBody = z.object({
  issueKey: z.string().min(1),
  worklogId: z.string().min(1),
  seconds: z.number().int().positive(),
  comment: z.string(),
});

app.put('/api/worklog', async (req, reply) => {
  const parsed = UpdateWorklogBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: 'Invalid parameters', issues: parsed.error.issues };
  }
  const { issueKey, worklogId, seconds, comment } = parsed.data;
  await jira.updateWorklog(issueKey, worklogId, seconds, comment);
  return { ok: true };
});

const DeleteWorklogBody = z.object({ issueKey: z.string().min(1), worklogId: z.string().min(1) });

app.delete('/api/worklog', async (req, reply) => {
  const parsed = DeleteWorklogBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: 'Invalid parameters', issues: parsed.error.issues };
  }
  await jira.deleteWorklog(parsed.data.issueKey, parsed.data.worklogId);
  return { ok: true };
});

app.post('/api/links', async (req, reply) => {
  const parsed = LinkBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: 'Invalid parameters', issues: parsed.error.issues };
  }
  const { repo, branch, ticket } = parsed.data;
  return upsertLink(repo, branch, ticket.toUpperCase());
});

const DeleteLinkBody = z.object({ repo: z.string().min(1), branch: z.string().min(1) });

app.delete('/api/links', async (req, reply) => {
  const parsed = DeleteLinkBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: 'Invalid parameters', issues: parsed.error.issues };
  }
  await deleteLink(parsed.data.repo, parsed.data.branch);
  return { ok: true };
});

const LoggedQuery = z.object({ from: DateStr, to: DateStr });

app.get('/api/logged', async (req, reply) => {
  const parsed = LoggedQuery.safeParse(req.query);
  if (!parsed.success) {
    reply.code(400);
    return { error: 'Invalid parameters', issues: parsed.error.issues };
  }
  const { from, to } = parsed.data;
  const me = await jira.getMyself();
  const issues = await jira.searchWorklogIssues(me.accountId, from, to);

  const dayMap = new Map<string, Array<{ issue: string; summary: string; seconds: number; comment: string; worklogId: string }>>();
  await Promise.all(
    issues.map(async ({ key, summary }) => {
      const worklogs = await jira.getWorklogsForAuthor(key, me.accountId, from, to);
      for (const wl of worklogs) {
        const date = wl.started.slice(0, 10);
        if (date < from || date > to) continue;
        const entries = dayMap.get(date) ?? [];
        entries.push({ issue: key, summary, seconds: wl.timeSpentSeconds, comment: wl.comment, worklogId: wl.id });
        dayMap.set(date, entries);
      }
    }),
  );

  const days = [...dayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entries]) => ({
      date,
      entries: entries.sort((a, b) => a.issue.localeCompare(b.issue)),
      totalSeconds: entries.reduce((s, e) => s + e.seconds, 0),
    }));

  return { days, totalSeconds: days.reduce((s, d) => s + d.totalSeconds, 0) };
});

app
  .listen({ port: env.port, host: '127.0.0.1' })
  .then(() => app.log.info(`API ready at http://127.0.0.1:${env.port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
