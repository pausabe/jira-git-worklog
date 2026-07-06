import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';

export function LinksPage() {
  const qc = useQueryClient();
  const links = useQuery({ queryKey: ['links'], queryFn: api.links });
  const [form, setForm] = useState({ repo: '', branch: '', ticket: '' });

  const add = useMutation({
    mutationFn: () => api.addLink(form.repo.trim(), form.branch.trim(), form.ticket.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['links'] });
      setForm({ repo: '', branch: '', ticket: '' });
    },
  });

  const remove = useMutation({
    mutationFn: (link: { repo: string; branch: string }) => api.deleteLink(link.repo, link.branch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['links'] }),
  });

  const valid = form.repo.trim() && form.branch.trim() && form.ticket.trim();

  return (
    <>
      <div className="panel">
        <h2>Link branch → ticket</h2>
        <p className="hint">
          For branches whose name does not include the ticket key. Applied when collecting commits from that branch.
        </p>
        <div className="row">
          <div>
            <label>Repo (org/name)</label>
            <input
              placeholder="org/repository"
              value={form.repo}
              onChange={(e) => setForm({ ...form, repo: e.target.value })}
            />
          </div>
          <div>
            <label>Branch</label>
            <input
              placeholder="feature/login"
              value={form.branch}
              onChange={(e) => setForm({ ...form, branch: e.target.value })}
            />
          </div>
          <div>
            <label>Ticket</label>
            <input
              placeholder="WEB-1234"
              value={form.ticket}
              onChange={(e) => setForm({ ...form, ticket: e.target.value.toUpperCase() })}
            />
          </div>
          <div style={{ flex: '0 0 auto' }}>
            <button className="primary" disabled={!valid || add.isPending} onClick={() => add.mutate()}>
              Link
            </button>
          </div>
        </div>
        {add.isError && <p className="error">{(add.error as Error).message}</p>}
      </div>

      <div className="panel">
        <h2>Existing links</h2>
        {links.isLoading && <p className="muted">Loading...</p>}
        {links.data && links.data.length === 0 && <p className="muted">No manual links yet.</p>}
        {links.data && links.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Repo</th>
                <th>Branch</th>
                <th>Ticket</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {links.data.map((l) => (
                <tr key={`${l.repo}@${l.branch}`}>
                  <td>{l.repo}</td>
                  <td>{l.branch}</td>
                  <td>{l.ticket}</td>
                  <td>
                    <button className="danger" onClick={() => remove.mutate(l)}>
                      x
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
