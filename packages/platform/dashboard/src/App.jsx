import React, { useState } from 'react';
import { getKey, setKey, UnauthorizedError } from './api.js';
import { REFRESH_MS, RefreshProvider, useApi, useRefreshTick, useRoute } from './hooks.js';
import Overview from './pages/Overview.jsx';
import Sessions from './pages/Sessions.jsx';
import SessionDetail from './pages/SessionDetail.jsx';

const RANGES = [
  { label: '24h', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

function KeyPrompt({ onSave }) {
  const [value, setValue] = useState(getKey());
  return (
    <div className="panel key-prompt">
      <h2>Dashboard key required</h2>
      <p className="muted">This server has DASHBOARD_KEY set. Enter it to continue.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setKey(value.trim());
          onSave();
        }}
      >
        <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Dashboard key" autoFocus />
        <button type="submit">Save</button>
      </form>
    </div>
  );
}

export default function App() {
  const route = useRoute();
  const tick = useRefreshTick();
  const [days, setDays] = useState(30);
  const [project, setProject] = useState('');
  const [authTick, setAuthTick] = useState(0);
  const projects = useApi('/projects', { authTick });

  if (projects.error instanceof UnauthorizedError) return <KeyPrompt onSave={() => setAuthTick((n) => n + 1)} />;

  // Rounded to the minute so the request key is stable between renders.
  const to = Math.ceil(Date.now() / 60_000) * 60_000;
  const range = { from: to - days * 86_400_000, to, project };
  const [page, id] = route;

  return (
    <RefreshProvider value={tick}>
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">Claude Monitor</a>
        <nav>
          <a href="#/" className={!page ? 'active' : ''}>Overview</a>
          <a href="#/sessions" className={page === 'sessions' ? 'active' : ''}>Sessions</a>
        </nav>
        <div className="filters">
          <span className="muted small" title="Data reloads automatically">Auto-refresh {REFRESH_MS / 1000}s</span>
          <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
            <option value="">All projects</option>
            {(projects.data || []).map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <div className="seg" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r.days} className={days === r.days ? 'on' : ''} onClick={() => setDays(r.days)}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </header>
      <main>
        {page === 'sessions' && id ? (
          <SessionDetail id={id} />
        ) : page === 'sessions' ? (
          <Sessions range={range} />
        ) : (
          <Overview range={range} />
        )}
      </main>
    </div>
    </RefreshProvider>
  );
}
