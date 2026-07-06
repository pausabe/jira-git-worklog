import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, secondsToHours, type LoggedResponse } from '../api.js';

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthStartYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

const WEEKDAY_LABEL: Record<string, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri',
  sat: 'Sat', sun: 'Sun',
};

function weekdayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d.getUTCDay()]!;
}

function workingDaysInRange(from: string, to: string): string[] {
  const days: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

export function LoggedPage() {
  const config = useQuery({ queryKey: ['config'], queryFn: api.getConfig });
  const workdaySeconds = (config.data?.workday.defaultHours ?? 8) * 3600;
  const [from, setFrom] = useState(monthStartYmd());
  const [to, setTo] = useState(todayYmd());
  const [data, setData] = useState<LoggedResponse | null>(null);
  // editing state: key = `${date}#${worklogId}`, value = draft comment
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});

  const fetch = useMutation({
    mutationFn: () => api.logged(from, to),
    onSuccess: (res) => { setData(res); setEditing({}); setSaveErrors({}); },
  });

  async function saveComment(issueKey: string, worklogId: string, comment: string, entryKey: string) {
    setSaving((prev) => new Set([...prev, entryKey]));
    setSaveErrors((prev) => { const n = { ...prev }; delete n[entryKey]; return n; });
    try {
      await api.updateWorklogComment(issueKey, worklogId, comment);
      // Update the in-memory data so the saved comment is reflected
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          days: prev.days.map((d) => ({
            ...d,
            entries: d.entries.map((e) =>
              e.worklogId === worklogId ? { ...e, comment } : e,
            ),
          })),
        };
      });
      setEditing((prev) => { const n = { ...prev }; delete n[entryKey]; return n; });
    } catch (err) {
      setSaveErrors((prev) => ({ ...prev, [entryKey]: (err as Error).message }));
    } finally {
      setSaving((prev) => { const s = new Set(prev); s.delete(entryKey); return s; });
    }
  }

  return (
    <>
      <div className="panel">
        <div className="row">
          <div>
            <label>From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label>To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div style={{ alignSelf: 'flex-end' }}>
            <button className="primary" disabled={fetch.isPending} onClick={() => fetch.mutate()}>
              {fetch.isPending ? 'Loading…' : 'Load'}
            </button>
          </div>
        </div>
        {fetch.isError && <p className="error">{(fetch.error as Error).message}</p>}
      </div>

      {data && (
        <>
          {(() => {
            const loggedByDate = new Map(data.days.map((d) => [d.date, d]));
            const allWorkingDays = workingDaysInRange(from, to);
            const missingDays = allWorkingDays.filter((d) => !loggedByDate.has(d));
            const partialDays = allWorkingDays.filter((d) => {
              const day = loggedByDate.get(d);
              return day && day.totalSeconds > 0 && day.totalSeconds < workdaySeconds * 0.75;
            });

            return (
              <>
                <div className="panel">
                  <div className="day-head">
                    <h2>Logged worklogs</h2>
                    <span className="muted">{secondsToHours(data.totalSeconds)} total</span>
                  </div>
                  {(missingDays.length > 0 || partialDays.length > 0) && (
                    <p className={missingDays.length > 0 ? 'error' : 'warn'} style={{ marginTop: 8 }}>
                      {missingDays.length > 0 && <>{missingDays.length} day{missingDays.length > 1 ? 's' : ''} not logged</>}
                      {missingDays.length > 0 && partialDays.length > 0 && ' · '}
                      {partialDays.length > 0 && <>{partialDays.length} day{partialDays.length > 1 ? 's' : ''} under {secondsToHours(Math.round(workdaySeconds * 0.75))}</>}
                    </p>
                  )}
                </div>

                {allWorkingDays.map((date) => {
                  const day = loggedByDate.get(date);
                  const wd = WEEKDAY_LABEL[weekdayOf(date)] ?? weekdayOf(date);
                  const isPartial = day && day.totalSeconds > 0 && day.totalSeconds < workdaySeconds * 0.75;

                  if (!day) {
                    return (
                      <div key={date} className="panel" style={{ opacity: 0.7 }}>
                        <div className="day-head">
                          <h3>
                            {date} <span className="muted">({wd})</span>
                          </h3>
                          <span className="error" style={{ fontSize: '0.85em' }}>Not logged</span>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={date} className="panel">
                      <div className="day-head">
                        <h3>
                          {date}{' '}
                          <span className="muted">({wd})</span>
                        </h3>
                        <span className={isPartial ? 'warn' : 'muted'}>
                          {secondsToHours(day.totalSeconds)}
                          {isPartial && <span style={{ fontSize: '0.8em', marginLeft: 4 }}>⚠ partial</span>}
                        </span>
                      </div>
                      <table>
                        <thead>
                          <tr>
                            <th>Issue</th>
                            <th>Comment</th>
                            <th style={{ textAlign: 'right' }}>Hours</th>
                          </tr>
                        </thead>
                        <tbody>
                          {day.entries.map((entry, i) => {
                            const entryKey = `${date}#${entry.worklogId}`;
                            const isEditing = entryKey in editing;
                            const isSaving = saving.has(entryKey);
                            return (
                              <tr key={i}>
                                <td style={{ whiteSpace: 'nowrap' }}>
                                  <span style={{ fontFamily: 'monospace' }}>{entry.issue}</span>
                                  {entry.summary && (
                                    <span className="muted" style={{ display: 'block', fontSize: '0.8em' }}>{entry.summary}</span>
                                  )}
                                </td>
                                <td style={{ fontSize: '0.85em' }}>
                                  {isEditing ? (
                                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                                      <input
                                        autoFocus
                                        value={editing[entryKey]}
                                        onChange={(e) => setEditing((prev) => ({ ...prev, [entryKey]: e.target.value }))}
                                        style={{ flex: 1, minWidth: 120 }}
                                        disabled={isSaving}
                                      />
                                      <button
                                        type="button"
                                        className="primary"
                                        style={{ fontSize: '0.8em', padding: '2px 8px' }}
                                        disabled={isSaving}
                                        onClick={() => saveComment(entry.issue, entry.worklogId, editing[entryKey]!, entryKey)}
                                      >
                                        {isSaving ? '…' : 'Save'}
                                      </button>
                                      <button
                                        type="button"
                                        className="ghost"
                                        style={{ fontSize: '0.8em', padding: '2px 6px' }}
                                        disabled={isSaving}
                                        onClick={() => setEditing((prev) => { const n = { ...prev }; delete n[entryKey]; return n; })}
                                      >
                                        ✕
                                      </button>
                                    </div>
                                  ) : (
                                    <span
                                      style={{ cursor: 'pointer' }}
                                      title="Click to edit"
                                      onClick={() => setEditing((prev) => ({ ...prev, [entryKey]: entry.comment }))}
                                    >
                                      {entry.comment || <span className="muted">—</span>}
                                      {' '}<span className="muted" style={{ fontSize: '0.8em' }}>✎</span>
                                    </span>
                                  )}
                                  {saveErrors[entryKey] && (
                                    <span className="error" style={{ display: 'block', fontSize: '0.8em' }}>{saveErrors[entryKey]}</span>
                                  )}
                                </td>
                                <td style={{ textAlign: 'right' }}>{secondsToHours(entry.seconds)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              </>
            );
          })()}
        </>
      )}
    </>
  );
}
