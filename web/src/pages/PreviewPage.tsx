import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  api,
  secondsToHours,
  type CommitInfo,
  type LoggedDayEntry,
  type Plan,
  type ImputeResult,
} from '../api.js';
import { NumberInput } from '../components/NumberInput.js';

function currentMonthYm(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function eachDayInRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  let d = new Date(fy!, fm! - 1, fd!);
  const end = new Date(ty!, tm! - 1, td!);
  while (d <= end) {
    dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  }
  return dates;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function lastDayOf(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  // Date.UTC avoids all timezone issues; day 0 of next month = last day of this month
  const day = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return `${ym}-${String(day).padStart(2, '0')}`;
}

function daySeconds(day: Plan['days'][number]): number {
  return day.entries.reduce((sum, e) => sum + e.seconds, 0);
}

type DayStatus = 'holiday' | 'done' | 'partial' | 'pending' | 'empty';

/**
 * A day is judged against its workday, not against "is anything logged at all":
 * 4h logged out of an 8h day is still unfinished business.
 */
function dayStatus(day: Plan['days'][number], loggedSeconds: number): DayStatus {
  if (day.weekday === 'Holiday') return 'holiday';
  if (loggedSeconds >= day.workdaySeconds) return 'done';
  if (loggedSeconds > 0) return 'partial';
  if (daySeconds(day) > 0) return 'pending';
  return 'empty';
}

/** Seconds still needed to complete the workday, counting what is logged and what is already planned. */
function remainingSeconds(day: Plan['days'][number], loggedSeconds: number): number {
  return Math.max(0, day.workdaySeconds - loggedSeconds - daySeconds(day));
}

export function PreviewPage() {
  const config = useQuery({ queryKey: ['config'], queryFn: api.getConfig });
  const people = config.data?.people ?? [];
  const defaultPerson = people.find((p) => p.default)?.id ?? people[0]?.id ?? '';

  const [person, setPerson] = useState('');
  const [currentMonth, setCurrentMonth] = useState(currentMonthYm);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [commitsByDay, setCommitsByDay] = useState<Record<string, CommitInfo[]>>({});
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const [meta, setMeta] = useState<{ unlinkedBranches: typeof plan extends null ? never[] : any[]; stats: { reposScanned: number; branchesScanned: number; commits: number } } | null>(null);
  const [result, setResult] = useState<ImputeResult | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [loadingLogged, setLoadingLogged] = useState(false);
  const [progress, setProgress] = useState('');
  const [collectError, setCollectError] = useState<string | null>(null);
  const [dayLoading, setDayLoading] = useState<Set<string>>(new Set());
  const [dayResults, setDayResults] = useState<Record<string, ImputeResult>>({});
  const [dayErrors, setDayErrors] = useState<Record<string, string>>({});
  const [tempTickets, setTempTickets] = useState<Record<string, string>>({});
  const [loggedByDay, setLoggedByDay] = useState<Record<string, LoggedDayEntry[]>>({});
  const [editingEntry, setEditingEntry] = useState<Record<string, { seconds: number; comment: string }>>({});
  const [savingEntry, setSavingEntry] = useState<Set<string>>(new Set());
  const [deletingEntry, setDeletingEntry] = useState<Set<string>>(new Set());
  const [entryErrors, setEntryErrors] = useState<Record<string, string>>({});

  const activePerson = person || defaultPerson;

  const ymYear = Number(currentMonth.split('-')[0]);
  const ymMonth = Number(currentMonth.split('-')[1]);
  const yearOptions = useMemo(() => {
    const y = new Date().getFullYear();
    return Array.from({ length: 5 }, (_, i) => y - 3 + i);
  }, []);

  const [showOnlyPending, setShowOnlyPending] = useState(false);

  const from = `${currentMonth}-01`;
  const to = (() => {
    const lastDay = lastDayOf(currentMonth);
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return lastDay < today ? lastDay : today;
  })();

  const monthLabel = new Date(`${currentMonth}-15`).toLocaleString('default', { month: 'long', year: 'numeric' });

  const skeletonDays = useMemo((): Plan['days'] => {
    const holidaySet = new Set<string>();
    for (const h of config.data?.holidays ?? []) {
      for (const d of eachDayInRange(h.from, h.to)) holidaySet.add(d);
    }
    const seasonal = config.data?.workday.seasonal ?? [];
    const defaultSeconds = Math.round((config.data?.workday.defaultHours ?? 8) * 3600);
    const workdaySecondsFor = (dateStr: string): number => {
      const mmdd = dateStr.slice(5);
      for (const s of seasonal) {
        if (s.from <= mmdd && mmdd <= s.to) return Math.round(s.hours * 3600);
      }
      return defaultSeconds;
    };

    const result: Plan['days'] = [];
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    let d = new Date(fy!, fm! - 1, fd!);
    const end = new Date(ty!, tm! - 1, td!);
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    while (d <= end) {
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) {
        const yy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const dateStr = `${yy}-${mm}-${dd}`;
        const isHoliday = holidaySet.has(dateStr);
        result.push({
          date: dateStr,
          weekday: isHoliday ? 'Holiday' : names[dow]!,
          workdaySeconds: isHoliday ? 0 : workdaySecondsFor(dateStr),
          entries: [],
          warnings: [],
          existingSeconds: 0,
        });
      }
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    }
    return result;
  }, [from, to, config.data]);

  const displayDays = useMemo(() => {
    const base = plan?.days ?? skeletonDays;
    if (!showOnlyPending) return base;
    // "Only pending" means "the workday is not closed yet": hide holidays and days
    // whose logged time already covers the workday. A day with 4h of an 8h workday
    // stays, and so do empty days — before generating, every day is empty, and
    // filtering on generated entries alone would hide the whole month.
    return base.filter((day) => {
      const loggedSeconds = (loggedByDay[day.date] ?? []).reduce((s, e) => s + e.seconds, 0);
      const status = dayStatus(day, loggedSeconds);
      return status !== 'holiday' && status !== 'done';
    });
  }, [plan, skeletonDays, showOnlyPending, loggedByDay]);

  function prevMonth() {
    setCurrentMonth((prev) => {
      const [y, m] = prev.split('-').map(Number);
      const d = new Date(y!, m! - 1, 1);
      d.setMonth(d.getMonth() - 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    });
  }

  function nextMonth() {
    setCurrentMonth((prev) => {
      const [y, m] = prev.split('-').map(Number);
      const d = new Date(y!, m! - 1, 1);
      d.setMonth(d.getMonth() + 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    });
  }

  async function fetchLogged(fetchFrom: string, fetchTo: string) {
    setLoadingLogged(true);
    try {
      const data = await api.logged(fetchFrom, fetchTo);
      setLoggedByDay(
        Object.fromEntries(
          data.days.map((day) => [
            day.date,
            day.entries.map((e) => ({
              issueKey: e.issue,
              summary: e.summary,
              worklogId: e.worklogId,
              seconds: e.seconds,
              comment: e.comment,
            })),
          ]),
        ),
      );
    } catch (err) {
      setCollectError((err as Error).message);
    } finally {
      setLoadingLogged(false);
    }
  }

  const generationRef = useRef(0);

  // Method 1: load existing Jira logs (fast, fires on person or month change)
  useEffect(() => {
    if (!activePerson) return;
    setPlan(null);
    setLoggedByDay({});
    setMeta(null);
    setCollectError(null);
    setResult(null);
    setDayResults({});
    setDayErrors({});
    setTempTickets({});
    setExpandedDays(new Set());
    fetchLogged(from, to);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePerson, currentMonth]);

  async function generate(overrideTempLinks?: Array<{ repo: string; branch: string; ticket: string }>) {
    const gen = ++generationRef.current;
    setCollecting(true);
    setProgress('');
    setCollectError(null);
    setResult(null);
    setDayResults({});
    setDayErrors({});
    try {
      const links = overrideTempLinks ?? Object.entries(tempTickets)
        .filter(([, ticket]) => ticket.trim())
        .map(([key, ticket]) => {
          const [repo, ...branchParts] = key.split('@');
          return { repo: repo!, branch: branchParts.join('@'), ticket: ticket.trim() };
        });
      const data = await api.previewStream(activePerson, from, to, (msg) => setProgress(msg), links.length ? links : undefined);
      if (generationRef.current !== gen) return; // stale — month changed while collecting
      setPlan(structuredClone(data.plan));
      setCommitsByDay(data.commitsByDay ?? {});
      setLoggedByDay(data.loggedByDay ?? {});
      setExpandedDays(new Set());
      setMeta({ unlinkedBranches: data.unlinkedBranches, stats: data.stats });
      setTempTickets((prev) => {
        const next = { ...prev };
        for (const ub of data.unlinkedBranches) {
          const key = `${ub.repo}@${ub.branch}`;
          if (!prev[key] && ub.suggestion) next[key] = ub.suggestion;
        }
        return next;
      });
    } catch (err) {
      if (generationRef.current !== gen) return;
      setCollectError((err as Error).message);
    } finally {
      if (generationRef.current === gen) {
        setCollecting(false);
        setProgress('');
      }
    }
  }

  async function logDay(date: string) {
    const day = plan?.days.find((d) => d.date === date);
    if (!plan || !day) return;
    setDayLoading((prev) => new Set([...prev, date]));
    setDayErrors((prev) => { const n = { ...prev }; delete n[date]; return n; });
    try {
      const singlePlan: Plan = { ...plan, days: [day] };
      const res = await api.impute(activePerson, singlePlan);
      setDayResults((prev) => ({ ...prev, [date]: res }));
      // Move logged entries into loggedByDay for immediate display
      setLoggedByDay((prev) => {
        const next = { ...prev };
        for (const created of res.created) {
          const planEntry = day.entries.find((e) => e.issue === created.issue);
          (next[created.date] ??= []).push({
            issueKey: created.issue,
            summary: '',
            worklogId: created.worklogId,
            seconds: created.seconds,
            comment: planEntry?.comment ?? '',
          });
        }
        return next;
      });
      // Reflect the logged seconds in the plan so the day shows as done
      setPlan((prev) => {
        if (!prev) return prev;
        const next = structuredClone(prev);
        const d = next.days.find((x) => x.date === date);
        if (!d) return prev;
        d.existingSeconds += d.entries.reduce((s, e) => s + e.seconds, 0);
        d.entries = [];
        return next;
      });
    } catch (err) {
      setDayErrors((prev) => ({ ...prev, [date]: (err as Error).message }));
    } finally {
      setDayLoading((prev) => { const s = new Set(prev); s.delete(date); return s; });
    }
  }

  const impute = useMutation({
    mutationFn: () => api.impute(activePerson, plan!),
    onSuccess: (data) => {
      setResult(data);
      // Move all logged entries into loggedByDay
      setLoggedByDay((prev) => {
        const next = { ...prev };
        for (const created of data.created) {
          const dayPlan = plan!.days.find((d) => d.date === created.date);
          const planEntry = dayPlan?.entries.find((e) => e.issue === created.issue);
          (next[created.date] ??= []).push({
            issueKey: created.issue,
            summary: '',
            worklogId: created.worklogId,
            seconds: created.seconds,
            comment: planEntry?.comment ?? '',
          });
        }
        return next;
      });
      // Mark all days as logged
      setPlan((prev) => {
        if (!prev) return prev;
        const next = structuredClone(prev);
        for (const d of next.days) {
          d.existingSeconds += d.entries.reduce((s, e) => s + e.seconds, 0);
          d.entries = [];
        }
        return next;
      });
    },
  });

  const total = useMemo(
    () => (plan ? plan.days.reduce((s, d) => s + daySeconds(d), 0) : 0),
    [plan],
  );

  // Day-scoped edits are keyed by date, never by array index: the rendered list
  // can be filtered ("only pending"), so a positional index would hit another day.
  function updateEntry(date: string, entryIdx: number, patch: Partial<Plan['days'][number]['entries'][number]>) {
    setPlan((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      const entry = next.days.find((d) => d.date === date)?.entries[entryIdx];
      if (!entry) return prev;
      Object.assign(entry, patch);
      return next;
    });
  }

  function removeEntry(date: string, entryIdx: number) {
    setPlan((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      const day = next.days.find((d) => d.date === date);
      if (!day) return prev;
      day.entries.splice(entryIdx, 1);
      return next;
    });
  }

  function addEntry(date: string) {
    setPlan((prev) => {
      // Before generating there is no plan yet — seed one from the skeleton so a
      // day can be filled in by hand without collecting commits first.
      const next: Plan = prev
        ? structuredClone(prev)
        : { person: activePerson, from, to, days: structuredClone(skeletonDays) };
      const day = next.days.find((d) => d.date === date);
      if (!day) return prev;
      // Propose whatever is still missing to close the workday. When the day is
      // already covered there is nothing to derive, so fall back to one hour.
      const logged = (loggedByDay[date] ?? []).reduce((s, e) => s + e.seconds, 0);
      const seconds = remainingSeconds(day, logged) || 3600;
      day.entries.push({
        date: day.date,
        issue: '',
        seconds,
        source: 'fallback',
        label: 'manual',
        comment: '',
      });
      return next;
    });
  }

  async function saveEntry(issueKey: string, worklogId: string, seconds: number, comment: string, entryKey: string) {
    setSavingEntry((prev) => new Set([...prev, entryKey]));
    setEntryErrors((prev) => { const n = { ...prev }; delete n[entryKey]; return n; });
    try {
      await api.updateWorklog(issueKey, worklogId, seconds, comment);
      setLoggedByDay((prev) => {
        const next = { ...prev };
        for (const date of Object.keys(next)) {
          next[date] = next[date]!.map((e) => e.worklogId === worklogId ? { ...e, seconds, comment } : e);
        }
        return next;
      });
      setEditingEntry((prev) => { const n = { ...prev }; delete n[entryKey]; return n; });
    } catch (err) {
      setEntryErrors((prev) => ({ ...prev, [entryKey]: (err as Error).message }));
    } finally {
      setSavingEntry((prev) => { const s = new Set(prev); s.delete(entryKey); return s; });
    }
  }

  async function deleteEntry(issueKey: string, worklogId: string, date: string, entryKey: string) {
    if (!window.confirm(`Delete this worklog from Jira? This cannot be undone.`)) return;
    setDeletingEntry((prev) => new Set([...prev, entryKey]));
    setEntryErrors((prev) => { const n = { ...prev }; delete n[entryKey]; return n; });
    try {
      await api.deleteWorklog(issueKey, worklogId);
      setLoggedByDay((prev) => ({
        ...prev,
        [date]: (prev[date] ?? []).filter((e) => e.worklogId !== worklogId),
      }));
    } catch (err) {
      setEntryErrors((prev) => ({ ...prev, [entryKey]: (err as Error).message }));
    } finally {
      setDeletingEntry((prev) => { const s = new Set(prev); s.delete(entryKey); return s; });
    }
  }

  return (
    <>
      <div className="panel">
        <div className="row" style={{ alignItems: 'center' }}>
          <div>
            <label>Person</label>
            <select value={activePerson} onChange={(e) => setPerson(e.target.value)}>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 18 }}>
            <button className="ghost" style={{ padding: '6px 10px' }} onClick={prevMonth}>←</button>
            <select
              value={ymMonth}
              onChange={(e) => setCurrentMonth(`${ymYear}-${String(e.target.value).padStart(2, '0')}`)}
            >
              {MONTH_NAMES.map((name, i) => (
                <option key={i + 1} value={i + 1}>{name}</option>
              ))}
            </select>
            <select
              value={ymYear}
              onChange={(e) => setCurrentMonth(`${e.target.value}-${String(ymMonth).padStart(2, '0')}`)}
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
            <button className="ghost" style={{ padding: '6px 10px' }} onClick={nextMonth}>→</button>
          </div>
          <div style={{ flex: '0 0 auto', paddingTop: 18 }}>
            <button className="ghost" disabled={!activePerson || collecting} onClick={() => generate()}>
              {collecting ? '⟳ Collecting…' : '↻ Autogenerate'}
            </button>
          </div>
        </div>
        {collectError && <p className="error">{collectError}</p>}
        {collecting && progress && <p className="hint">⟳ {progress}</p>}
        {meta && (
          <p className="hint">
            {meta.stats.reposScanned} repos · {meta.stats.branchesScanned} branches · {meta.stats.commits} attributed commits
          </p>
        )}
      </div>

      {meta && meta.unlinkedBranches.length > 0 && (
        <div className="panel">
          <h2 className="warn">Branches without ticket ({meta.unlinkedBranches.length})</h2>
          <p className="hint">These branches have your commits but no ticket key could be extracted. Assign a ticket below and re-generate to include them, or link permanently in the "Link branches" tab.</p>
          <table>
            <thead>
              <tr>
                <th>Repo</th>
                <th>Branch</th>
                <th>Commits</th>
                <th>Assign ticket (temporary)</th>
              </tr>
            </thead>
            <tbody>
              {meta.unlinkedBranches.map((b) => {
                const key = `${b.repo}@${b.branch}`;
                return (
                  <tr key={key}>
                    <td>{b.repo}</td>
                    <td>{b.branch}</td>
                    <td>{b.commitCount}</td>
                    <td>
                      <input
                        placeholder="e.g. WEB-1234"
                        value={tempTickets[key] ?? ''}
                        onChange={(e) => setTempTickets((prev) => ({ ...prev, [key]: e.target.value.toUpperCase() }))}
                        style={{ width: 120 }}
                      />
                      {b.suggestion && !tempTickets[key] && (
                        <span className="muted" style={{ fontSize: '0.78em', marginLeft: 6 }}>suggested: {b.suggestion}</span>
                      )}
                      {b.suggestion && tempTickets[key] === b.suggestion && (
                        <span className="muted" style={{ fontSize: '0.78em', marginLeft: 6 }}>↳ same as in another repo</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {Object.values(tempTickets).some((t) => t.trim()) && (
            <button
              className="primary"
              style={{ marginTop: 8 }}
              disabled={collecting}
              onClick={() => generate()}
            >
              Re-generate with assignments
            </button>
          )}
        </div>
      )}

      {activePerson && (
        <div className="panel">
          <div className="day-head">
            <h2>{plan ? `Plan · total ${secondsToHours(total)}` : monthLabel}</h2>
            {plan && total > 0 && (
            <button
              className="primary"
              disabled={impute.isPending}
              onClick={() => {
                if (window.confirm(`Log ${secondsToHours(total)} to Jira across ${plan.days.length} day(s)?`)) {
                  impute.mutate();
                }
              }}
            >
              {impute.isPending ? 'Logging...' : 'Log to Jira'}
            </button>
            )}
          </div>
          {impute.isError && <p className="error">{(impute.error as Error).message}</p>}
          {result && (
            <p className="hint">
              Created {result.created.length} · skipped {result.skipped.length} · failed {result.failed.length}
              {result.failed.length > 0 && (
                <span className="error"> — {result.failed.map((f) => `${f.issue}: ${f.error}`).join('; ')}</span>
              )}
            </p>
          )}

          {/* Month summary — condition uses unfiltered base so the bar survives when showOnlyPending empties the list */}
          {(plan?.days ?? skeletonDays).length > 0 && (() => {
            // Use the unfiltered base for counts
            const base = plan?.days ?? skeletonDays;
            const counts = { done: 0, partial: 0, pending: 0, empty: 0, holiday: 0 };
            for (const day of base) {
              const lt = (loggedByDay[day.date] ?? []).reduce((s, e) => s + e.seconds, 0);
              counts[dayStatus(day, lt)]++;
            }
            const workingDays = base.filter((d) => d.weekday !== 'Holiday').length;
            return (
              <div style={{ display: 'flex', gap: 16, padding: '8px 0 4px', borderBottom: '1px solid var(--border)', marginBottom: 8, fontSize: '0.85em', flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ color: 'var(--status-done)' }}>✓ {counts.done} done</span>
                {counts.partial > 0 && <span style={{ color: 'var(--status-partial)' }}>◑ {counts.partial} partial</span>}
                {counts.pending > 0 && <span style={{ color: 'var(--status-pending)' }}>○ {counts.pending} pending</span>}
                {counts.empty > 0 && <span style={{ color: 'var(--muted)' }}>– {counts.empty} empty</span>}
                {counts.holiday > 0 && <span style={{ color: 'var(--muted)' }}>🏖 {counts.holiday} holiday</span>}
                <span style={{ color: 'var(--muted)', marginLeft: 'auto' }}>{workingDays} working days</span>
                <label className="toggle">
                  <input type="checkbox" checked={showOnlyPending} onChange={(e) => setShowOnlyPending(e.target.checked)} />
                  <span className="toggle-track"><span className="toggle-thumb" /></span>
                  only pending
                </label>
              </div>
            );
          })()}

          {showOnlyPending && displayDays.length === 0 && (plan?.days ?? skeletonDays).length > 0 && (
            <p className="hint">Nothing pending this month — every working day is fully logged.</p>
          )}

          {displayDays.map((day) => {
            const logged = loggedByDay[day.date] ?? [];
            const loggedTotal = logged.reduce((s, e) => s + e.seconds, 0);
            const pendingTotal = daySeconds(day);
            const isHoliday = day.weekday === 'Holiday';
            const status = dayStatus(day, loggedTotal);
            const statusIcon =
              status === 'holiday'  ? <span title="Holiday / day off" style={{ color: 'var(--muted)', fontSize: '1em' }}>🏖</span>
              : status === 'done'    ? <span title={`Workday complete (${secondsToHours(loggedTotal)} logged)`} style={{ color: 'var(--status-done)',    fontSize: '1em' }}>✓</span>
              : status === 'partial' ? <span title={`${secondsToHours(loggedTotal)} logged of ${secondsToHours(day.workdaySeconds)} — workday incomplete`} style={{ color: 'var(--status-partial)', fontSize: '1em' }}>◑</span>
              : status === 'pending' ? <span title="Nothing logged yet"   style={{ color: 'var(--status-pending)', fontSize: '1em' }}>○</span>
              : <span title="Nothing logged and nothing to log" style={{ color: 'var(--status-empty)', fontSize: '1em' }}>–</span>;
            return (
            <div key={day.date} className={`day-card status-${status}`}>
              <div className="day-head">
                <strong style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {statusIcon}
                  {day.date} <span className="muted">({isHoliday ? 'Holiday' : day.weekday})</span>
                  {commitsByDay[day.date] && commitsByDay[day.date]!.length > 0 && (
                    <button
                      className="ghost"
                      style={{ fontSize: '0.78em', padding: '1px 6px', fontWeight: 'normal' }}
                      onClick={() =>
                        setExpandedDays((prev) => {
                          const s = new Set(prev);
                          s.has(day.date) ? s.delete(day.date) : s.add(day.date);
                          return s;
                        })
                      }
                    >
                      {expandedDays.has(day.date) ? '▾' : '▸'} {commitsByDay[day.date]!.length} commits
                    </button>
                  )}
                </strong>
                {isHoliday ? (
                  <span className="muted" style={{ fontSize: '0.85em' }}>day off</span>
                ) : (
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    className="muted"
                    style={{ fontFamily: 'monospace', fontSize: '0.85em' }}
                    title={`Already logged in Jira: ${secondsToHours(loggedTotal)} · Workday target: ${secondsToHours(day.workdaySeconds)}`}
                  >
                    {secondsToHours(loggedTotal)}{' / '}{secondsToHours(day.workdaySeconds)}
                  </span>
                  {pendingTotal > 0 && (
                    <span title={`${secondsToHours(pendingTotal)} new entries will be logged when you press Log day`}>
                      {`+${secondsToHours(pendingTotal)}`}
                    </span>
                  )}
                  <button
                    className="ghost"
                    disabled={dayLoading.has(day.date) || pendingTotal === 0}
                    onClick={() => {
                      if (window.confirm(`Log ${secondsToHours(pendingTotal)} to Jira for ${day.date}?`)) {
                        logDay(day.date);
                      }
                    }}
                    style={{ padding: '2px 8px', fontSize: '0.8em' }}
                  >
                    {dayLoading.has(day.date) ? '…' : 'Log day'}
                  </button>
                </span>
                )}
              </div>
              {dayErrors[day.date] && <p className="error">{dayErrors[day.date]}</p>}
              {dayResults[day.date] && (
                <p className="hint">
                  Created {dayResults[day.date]!.created.length} · skipped {dayResults[day.date]!.skipped.length}
                  {dayResults[day.date]!.failed.length > 0 && (
                    <span className="error"> · {dayResults[day.date]!.failed.map((f) => f.error).join('; ')}</span>
                  )}
                </p>
              )}

              {/* Already-logged entries */}
              {logged.length > 0 && (
                <table style={{ opacity: 0.6, marginBottom: 2 }}>
                  <tbody>
                    {logged.map((entry) => {
                      const ek = `${day.date}#${entry.worklogId}`;
                      const editing = editingEntry[ek];
                      const isSaving = savingEntry.has(ek);
                      const isDeleting = deletingEntry.has(ek);
                      const busy = isSaving || isDeleting;
                      return (
                        <tr key={ek}>
                          <td className="width-issue">
                            <span style={{ fontFamily: 'monospace' }}>{entry.issueKey}</span>
                            {entry.summary && <span className="muted" style={{ display: 'block', fontSize: '0.75em' }}>{entry.summary}</span>}
                          </td>
                          <td><span className="tag recurring">logged</span></td>
                          {editing ? (
                            <>
                              <td>
                                <input autoFocus value={editing.comment} disabled={busy}
                                  placeholder="comment…"
                                  onChange={(e) => setEditingEntry((p) => ({ ...p, [ek]: { ...p[ek]!, comment: e.target.value } }))}
                                  style={{ width: '100%', minWidth: 120 }} />
                              </td>
                              <td className="width-time">
                                <NumberInput step={0.25} min={0.25} decimals={2} disabled={busy}
                                  value={editing.seconds / 3600}
                                  onChange={(hours) => setEditingEntry((p) => ({ ...p, [ek]: { ...p[ek]!, seconds: Math.round(hours * 3600) } }))} />
                              </td>
                              <td style={{ width: 80, whiteSpace: 'nowrap' }}>
                                <button className="primary" style={{ fontSize: '0.78em', padding: '2px 7px' }} disabled={busy}
                                  onClick={() => saveEntry(entry.issueKey, entry.worklogId, editing.seconds, editing.comment, ek)}>
                                  {isSaving ? '…' : 'Save'}
                                </button>
                                {' '}
                                <button className="ghost" style={{ fontSize: '0.78em', padding: '2px 6px' }} disabled={busy}
                                  onClick={() => setEditingEntry((p) => { const n = { ...p }; delete n[ek]; return n; })}>✕</button>
                              </td>
                            </>
                          ) : (
                            <>
                              <td>
                                {entry.comment || <span className="muted">—</span>}
                              </td>
                              <td className="width-time" style={{ textAlign: 'right' }}>{secondsToHours(entry.seconds)}</td>
                              <td style={{ width: 80, whiteSpace: 'nowrap', textAlign: 'right' }}>
                                <button className="ghost" style={{ fontSize: '0.78em', padding: '2px 6px' }} disabled={busy}
                                  title="Edit time & comment"
                                  onClick={() => setEditingEntry((p) => ({ ...p, [ek]: { seconds: entry.seconds, comment: entry.comment } }))}>✎</button>
                                {' '}
                                <button className="danger" style={{ fontSize: '0.78em', padding: '2px 6px' }} disabled={busy}
                                  title="Delete from Jira"
                                  onClick={() => deleteEntry(entry.issueKey, entry.worklogId, day.date, ek)}>
                                  {isDeleting ? '…' : '🗑'}
                                </button>
                              </td>
                            </>
                          )}
                          {entryErrors[ek] && (
                            <td colSpan={4}><span className="error" style={{ fontSize: '0.78em' }}>{entryErrors[ek]}</span></td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}

              {/* Commits expanded table */}
              {commitsByDay[day.date] && commitsByDay[day.date]!.length > 0 && expandedDays.has(day.date) && (
                <table style={{ fontSize: '0.82em', marginBottom: 6 }}>
                  <thead>
                    <tr>
                      <th>Ticket</th>
                      <th>Branch</th>
                      <th>Message</th>
                      <th style={{ textAlign: 'right' }}>Churn</th>
                    </tr>
                  </thead>
                  <tbody>
                    {commitsByDay[day.date]!.map((c, i) => (
                      <tr key={i} style={c.unlinked ? { opacity: 0.65 } : undefined}>
                        <td>
                          {c.unlinked
                            ? <span style={{ color: 'var(--warn, #b45309)', fontFamily: 'monospace', fontSize: '0.9em' }}>⚠ unlinked</span>
                            : <span style={{ fontFamily: 'monospace' }}>{c.ticket}</span>
                          }
                        </td>
                        <td className="muted">{c.branch.replace(/^.*\//, '')}</td>
                        <td className="muted" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.message}</td>
                        <td style={{ textAlign: 'right' }} className="muted">{c.churn}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {day.warnings.map((w, i) => (
                <p key={i} className="warn">{w}</p>
              ))}

              {/* Pending entries */}
              {day.entries.length > 0 && (
                <table>
                  <tbody>
                    {day.entries.map((entry, entryIdx) => (
                      <tr key={entryIdx}>
                        <td className="width-issue">
                          <input
                            value={entry.issue}
                            onChange={(e) => updateEntry(day.date, entryIdx, { issue: e.target.value.toUpperCase() })}
                          />
                        </td>
                        <td>
                          <span className={`tag ${entry.source}`}>{entry.label ?? entry.source}</span>{' '}
                          <span className="muted">{entry.detail ?? ''}</span>
                        </td>
                        <td>
                          <input
                            value={entry.comment ?? ''}
                            placeholder="worklog comment…"
                            onChange={(e) => updateEntry(day.date, entryIdx, { comment: e.target.value })}
                            style={{ width: '100%', minWidth: 160 }}
                          />
                        </td>
                        <td className="width-time">
                          <NumberInput
                            step={0.25}
                            min={0}
                            decimals={2}
                            value={entry.seconds / 3600}
                            onChange={(hours) =>
                              updateEntry(day.date, entryIdx, { seconds: Math.round(hours * 3600) })
                            }
                          />
                        </td>
                        <td style={{ width: 40 }}>
                          <button className="danger" onClick={() => removeEntry(day.date, entryIdx)}>x</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <button
                className="ghost"
                style={{ fontSize: '0.8em', padding: '2px 8px', marginTop: 4 }}
                disabled={!plan}
                onClick={() => addEntry(day.date)}
              >
                + Add entry
              </button>
            </div>
            );
          })}
        </div>
      )}
    </>
  );
}
