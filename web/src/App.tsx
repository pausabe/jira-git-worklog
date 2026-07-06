import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';
import { PreviewPage } from './pages/PreviewPage.js';
import { ConfigPage } from './pages/ConfigPage.js';
import { LinksPage } from './pages/LinksPage.js';

type Tab = 'preview' | 'config' | 'links';

export function App() {
  const [tab, setTab] = useState<Tab>('preview');
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });

  return (
    <>
      <header>
        <h1>Jira Git Worklog</h1>
        <span className="muted">
          {me.isLoading && 'connecting...'}
          {me.isError && <span className="error">could not connect to Jira / GitHub</span>}
          {me.data && `${me.data.jira.displayName} · org ${me.data.githubOrg}`}
        </span>
        <nav>
          <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>
            Worklog
          </button>
          <button className={tab === 'links' ? 'active' : ''} onClick={() => setTab('links')}>
            Link branches
          </button>
          <button className={tab === 'config' ? 'active' : ''} onClick={() => setTab('config')}>
            Config
          </button>
        </nav>
      </header>
      <main>
        <div style={{ display: tab === 'preview' ? undefined : 'none' }}><PreviewPage /></div>
        <div style={{ display: tab === 'links' ? undefined : 'none' }}><LinksPage /></div>
        <div style={{ display: tab === 'config' ? undefined : 'none' }}><ConfigPage /></div>
      </main>
    </>
  );
}
