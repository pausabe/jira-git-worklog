import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Config, type HolidayRange, type RecurringBlock, type Weekday, type Distribution } from '../api.js';

const WEEKDAYS: Weekday[] = ['*', 'mon', 'tue', 'wed', 'thu', 'fri'];
const DISTRIBUTIONS: Distribution[] = ['weighted-by-churn', 'equal', 'weighted-by-commits'];

export function ConfigPage() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['config'], queryFn: api.getConfig });
  const [draft, setDraft] = useState<Config | null>(null);

  useEffect(() => {
    if (query.data) setDraft(structuredClone(query.data));
  }, [query.data]);

  const save = useMutation({
    mutationFn: (config: Config) => api.saveConfig(config),
    onSuccess: (saved) => {
      qc.setQueryData(['config'], saved);
      setDraft(structuredClone(saved));
    },
  });

  const [newHolidayFrom, setNewHolidayFrom] = useState('');
  const [newHolidayTo, setNewHolidayTo] = useState('');
  const [newIssueKey, setNewIssueKey] = useState('');
  const [newIssueComment, setNewIssueComment] = useState('');

  if (!draft) return <div className="panel">Loading configuration...</div>;

  function patch(p: Partial<Config>) {
    setDraft((prev) => (prev ? { ...prev, ...p } : prev));
  }

  function updateRecurring(idx: number, p: Partial<RecurringBlock>) {
    setDraft((prev) => {
      if (!prev) return prev;
      const recurring = prev.recurring.map((b, i) => (i === idx ? { ...b, ...p } : b));
      return { ...prev, recurring };
    });
  }

  return (
    <>
      <div className="panel">
        <h2>Workday &amp; distribution</h2>
        <div className="row">
          <div>
            <label>Default hours</label>
            <input
              type="number"
              step={0.5}
              value={draft.workday.defaultHours}
              onChange={(e) => patch({ workday: { ...draft.workday, defaultHours: Number(e.target.value) } })}
            />
          </div>
          <div>
            <label>Distribution</label>
            <select value={draft.distribution} onChange={(e) => patch({ distribution: e.target.value as Distribution })}>
              {DISTRIBUTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Fallback issue (days without commits)</label>
            <input value={draft.fallbackIssue} onChange={(e) => patch({ fallbackIssue: e.target.value.toUpperCase() })} />
          </div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <div>
            <label>Ticket regex in branch name</label>
            <input value={draft.ticketRegex} onChange={(e) => patch({ ticketRegex: e.target.value })} />
          </div>
          <div>
            <label>Seasonal period → hours</label>
            {(() => {
              const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
              const s = draft.workday.seasonal[0];
              const fMM = s?.from?.slice(0, 2) ?? '06';
              const fDD = s?.from?.slice(3) ?? '15';
              const tMM = s?.to?.slice(0, 2) ?? '09';
              const tDD = s?.to?.slice(3) ?? '15';
              const hrs = s?.hours ?? 7;
              const set = (from: string, to: string, h: number) =>
                patch({ workday: { ...draft.workday, seasonal: [{ from, to, hours: h }] } });
              return (
                <div className="inline">
                  <select value={fMM} onChange={(e) => set(`${e.target.value}-${fDD}`, `${tMM}-${tDD}`, hrs)}>
                    {MONTHS.map((m, i) => <option key={i} value={String(i + 1).padStart(2, '0')}>{m}</option>)}
                  </select>
                  <input type="number" min={1} max={31} className="width-time" value={Number(fDD)}
                    onChange={(e) => set(`${fMM}-${String(e.target.value).padStart(2, '0')}`, `${tMM}-${tDD}`, hrs)} />
                  <span className="muted">→</span>
                  <select value={tMM} onChange={(e) => set(`${fMM}-${fDD}`, `${e.target.value}-${tDD}`, hrs)}>
                    {MONTHS.map((m, i) => <option key={i} value={String(i + 1).padStart(2, '0')}>{m}</option>)}
                  </select>
                  <input type="number" min={1} max={31} className="width-time" value={Number(tDD)}
                    onChange={(e) => set(`${fMM}-${fDD}`, `${tMM}-${String(e.target.value).padStart(2, '0')}`, hrs)} />
                  <input type="number" step={0.5} className="width-time" value={hrs}
                    onChange={(e) => set(`${fMM}-${fDD}`, `${tMM}-${tDD}`, Number(e.target.value))} />
                  <span className="muted">h</span>
                </div>
              );
            })()}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="day-head">
          <h2>Recurring meetings</h2>
          <button
            className="ghost"
            onClick={() =>
              patch({ recurring: [...draft.recurring, { label: 'New', weekday: '*', minutes: 15, issue: '' }] })
            }
          >
            + Add
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Day</th>
              <th>Minutes</th>
              <th>Issue</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {draft.recurring.map((block, idx) => (
              <tr key={idx}>
                <td>
                  <input value={block.label} onChange={(e) => updateRecurring(idx, { label: e.target.value })} />
                </td>
                <td>
                  <select value={block.weekday} onChange={(e) => updateRecurring(idx, { weekday: e.target.value as Weekday })}>
                    {WEEKDAYS.map((w) => (
                      <option key={w} value={w}>
                        {w}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="number"
                    className="width-time"
                    value={block.minutes}
                    onChange={(e) => updateRecurring(idx, { minutes: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    className="width-issue"
                    placeholder="WEB-1234"
                    value={block.issue}
                    onChange={(e) => updateRecurring(idx, { issue: e.target.value.toUpperCase() })}
                  />
                </td>
                <td>
                  <button
                    className="danger"
                    onClick={() => patch({ recurring: draft.recurring.filter((_, i) => i !== idx) })}
                  >
                    x
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2>Holidays</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {draft.holidays.map((range: HolidayRange, idx: number) => (
            <div key={idx} className="inline">
              <span>{range.from}</span>
              <span className="muted">→</span>
              <span>{range.to}</span>
              <button className="danger" onClick={() => patch({ holidays: draft.holidays.filter((_: HolidayRange, i: number) => i !== idx) })}>x</button>
            </div>
          ))}
          <div className="inline" style={{ marginTop: 4 }}>
            <input type="date" value={newHolidayFrom} onChange={(e) => setNewHolidayFrom(e.target.value)} />
            <span className="muted">→</span>
            <input type="date" value={newHolidayTo} onChange={(e) => setNewHolidayTo(e.target.value)} />
            <button
              className="ghost"
              disabled={!newHolidayFrom || !newHolidayTo || newHolidayFrom > newHolidayTo}
              onClick={() => {
                patch({ holidays: [...draft.holidays, { from: newHolidayFrom, to: newHolidayTo }].sort((a: HolidayRange, b: HolidayRange) => a.from.localeCompare(b.from)) });
                setNewHolidayFrom('');
                setNewHolidayTo('');
              }}
            >
              + Add
            </button>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="day-head">
          <h2>People</h2>
          <button
            className="ghost"
            onClick={() => patch({ people: [...draft.people, { id: '', githubLogin: '', emails: [], default: false }] })}
          >
            + Add
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Id</th>
              <th>GitHub login</th>
              <th>Emails (comma)</th>
              <th>Default</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {draft.people.map((p, idx) => (
              <tr key={idx}>
                <td>
                  <input
                    value={p.id}
                    onChange={(e) =>
                      patch({ people: draft.people.map((x, i) => (i === idx ? { ...x, id: e.target.value } : x)) })
                    }
                  />
                </td>
                <td>
                  <input
                    value={p.githubLogin}
                    onChange={(e) =>
                      patch({ people: draft.people.map((x, i) => (i === idx ? { ...x, githubLogin: e.target.value } : x)) })
                    }
                  />
                </td>
                <td>
                  <input
                    value={p.emails.join(',')}
                    onChange={(e) =>
                      patch({
                        people: draft.people.map((x, i) =>
                          i === idx ? { ...x, emails: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } : x,
                        ),
                      })
                    }
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={p.default}
                    onChange={(e) =>
                      patch({
                        people: draft.people.map((x, i) => ({ ...x, default: i === idx ? e.target.checked : false })),
                      })
                    }
                  />
                </td>
                <td>
                  <button className="danger" onClick={() => patch({ people: draft.people.filter((_, i) => i !== idx) })}>
                    x
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2>Default comments</h2>
        <div className="row">
          <div>
            <label>Development days (commits)</label>
            <input
              value={draft.defaultComments.commits}
              onChange={(e) => patch({ defaultComments: { ...draft.defaultComments, commits: e.target.value } })}
            />
          </div>
          <div>
            <label>Fallback (no commits)</label>
            <input
              value={draft.defaultComments.fallback}
              onChange={(e) => patch({ defaultComments: { ...draft.defaultComments, fallback: e.target.value } })}
            />
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Issue comments</h2>
        <p className="muted" style={{ marginTop: 0, marginBottom: 8, fontSize: '0.85em' }}>
          Override the default comment for a specific issue key.
        </p>
        <table>
          <thead>
            <tr>
              <th>Issue</th>
              <th>Comment</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {Object.entries(draft.issueComments).map(([issue, comment]) => (
              <tr key={issue}>
                <td><span style={{ fontFamily: 'monospace' }}>{issue}</span></td>
                <td>
                  <input
                    value={comment}
                    onChange={(e) => patch({ issueComments: { ...draft.issueComments, [issue]: e.target.value } })}
                  />
                </td>
                <td>
                  <button
                    className="danger"
                    onClick={() => {
                      const { [issue]: _, ...rest } = draft.issueComments;
                      patch({ issueComments: rest });
                    }}
                  >
                    x
                  </button>
                </td>
              </tr>
            ))}
            <tr>
              <td>
                <input
                  className="width-issue"
                  placeholder="MAP-1234"
                  value={newIssueKey}
                  onChange={(e) => setNewIssueKey(e.target.value.toUpperCase())}
                />
              </td>
              <td>
                <input
                  placeholder="comment for this issue…"
                  value={newIssueComment}
                  onChange={(e) => setNewIssueComment(e.target.value)}
                />
              </td>
              <td>
                <button
                  className="ghost"
                  disabled={!newIssueKey || !newIssueComment}
                  onClick={() => {
                    patch({ issueComments: { ...draft.issueComments, [newIssueKey]: newIssueComment } });
                    setNewIssueKey('');
                    setNewIssueComment('');
                  }}
                >
                  + Add
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="panel">
        <div className="inline">
          <button className="primary" disabled={save.isPending} onClick={() => save.mutate(draft)}>
            {save.isPending ? 'Saving...' : 'Save configuration'}
          </button>
          {save.isSuccess && <span className="muted">Saved.</span>}
          {save.isError && <span className="error">{(save.error as Error).message}</span>}
        </div>
      </div>
    </>
  );
}
