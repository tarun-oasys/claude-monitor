import React from 'react';
import { usd } from './format.js';

export function Card({ label, value, sub }) {
  return (
    <div className="card">
      <div className="card-label">{label}</div>
      <div className="card-value">{value}</div>
      {sub && <div className="card-sub">{sub}</div>}
    </div>
  );
}

export function Panel({ title, children, right }) {
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>{title}</h2>
        {right}
      </header>
      {children}
    </section>
  );
}

export function State({ loading, error, children }) {
  if (loading) return <div className="muted pad">Loading…</div>;
  if (error) return <div className="error pad">{error.message}</div>;
  return children;
}

export function Badge({ kind = 'ok', children }) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

// Daily cost bars. Labels are every Nth day so they never overlap.
export function DailyBars({ rows }) {
  if (rows.length === 0) return <div className="muted pad">No data in this range.</div>;
  const W = 720;
  const H = 180;
  const pad = { l: 8, r: 8, t: 10, b: 22 };
  const max = Math.max(...rows.map((r) => r.cost_usd), 1e-9);
  const slot = (W - pad.l - pad.r) / rows.length;
  const barW = Math.max(2, slot * 0.7);
  const every = Math.ceil(rows.length / 8);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Daily cost">
      {rows.map((r, i) => {
        const h = ((H - pad.t - pad.b) * r.cost_usd) / max;
        const x = pad.l + i * slot + (slot - barW) / 2;
        return (
          <g key={r.day}>
            <rect x={x} y={H - pad.b - h} width={barW} height={Math.max(h, r.cost_usd > 0 ? 1 : 0)} rx="2" className="bar">
              <title>{`${r.day}: ${usd(r.cost_usd)}, ${r.llm_calls} LLM calls`}</title>
            </rect>
            {i % every === 0 && (
              <text x={x + barW / 2} y={H - 6} textAnchor="middle" className="axis">
                {r.day.slice(5)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function InlineBar({ value, max }) {
  const w = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="inline-bar">
      <div style={{ width: `${w}%` }} />
    </div>
  );
}
