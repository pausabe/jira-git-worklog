import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

/** Manual branch -> ticket mapping for branches without a key in their name. */
export interface BranchLink {
  repo: string; // owner/name
  branch: string;
  ticket: string;
  createdAt: string;
}

/** One imputed worklog, recorded locally to guarantee idempotency. */
export interface LedgerEntry {
  person: string;
  date: string; // YYYY-MM-DD
  issue: string;
  seconds: number;
  worklogId: string;
  createdAt: string;
}

interface DbShape {
  links: BranchLink[];
  ledger: LedgerEntry[];
  churn: Record<string, number>; // sha -> added + deleted (immutable per sha)
}

const DB_FILE = path.join(DATA_DIR, 'store.json');
const EMPTY: DbShape = { links: [], ledger: [], churn: {} };

async function readDb(): Promise<DbShape> {
  try {
    const raw = await fs.readFile(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DbShape>;
    return {
      links: parsed.links ?? [],
      ledger: parsed.ledger ?? [],
      churn: parsed.churn ?? {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
    throw err;
  }
}

async function writeDb(db: DbShape): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
  await fs.rename(tmp, DB_FILE);
}

function linkKey(repo: string, branch: string): string {
  return `${repo}@@${branch}`;
}

// ---- Branch links ----

export async function listLinks(): Promise<BranchLink[]> {
  return (await readDb()).links;
}

export async function upsertLink(repo: string, branch: string, ticket: string): Promise<BranchLink> {
  const db = await readDb();
  const key = linkKey(repo, branch);
  const link: BranchLink = { repo, branch, ticket, createdAt: new Date().toISOString() };
  const idx = db.links.findIndex((l) => linkKey(l.repo, l.branch) === key);
  if (idx >= 0) db.links[idx] = link;
  else db.links.push(link);
  await writeDb(db);
  return link;
}

export async function deleteLink(repo: string, branch: string): Promise<void> {
  const db = await readDb();
  const key = linkKey(repo, branch);
  db.links = db.links.filter((l) => linkKey(l.repo, l.branch) !== key);
  await writeDb(db);
}

export async function getLinkMap(): Promise<Map<string, string>> {
  const db = await readDb();
  return new Map(db.links.map((l) => [linkKey(l.repo, l.branch), l.ticket]));
}

export { linkKey };

// ---- Ledger (idempotency) ----

export async function listLedger(person?: string): Promise<LedgerEntry[]> {
  const db = await readDb();
  return person ? db.ledger.filter((e) => e.person === person) : db.ledger;
}

export async function hasImputed(person: string, date: string, issue: string): Promise<boolean> {
  const db = await readDb();
  return db.ledger.some((e) => e.person === person && e.date === date && e.issue === issue);
}

export async function recordImputation(entry: LedgerEntry): Promise<void> {
  const db = await readDb();
  db.ledger.push(entry);
  await writeDb(db);
}

export async function getLastLoggedDate(person: string, before?: string): Promise<string | null> {
  const db = await readDb();
  const dates = db.ledger
    .filter((e) => e.person === person && (!before || e.date < before))
    .map((e) => e.date);
  return dates.length > 0 ? [...dates].sort().at(-1)! : null;
}

// ---- Churn cache (sha -> lines changed) ----

export async function getCachedChurn(shas: string[]): Promise<Record<string, number>> {
  const db = await readDb();
  const out: Record<string, number> = {};
  for (const sha of shas) {
    if (sha in db.churn) out[sha] = db.churn[sha]!;
  }
  return out;
}

export async function cacheChurn(entries: Record<string, number>): Promise<void> {
  if (Object.keys(entries).length === 0) return;
  const db = await readDb();
  Object.assign(db.churn, entries);
  await writeDb(db);
}
