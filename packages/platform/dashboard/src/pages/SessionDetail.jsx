import React from 'react';
import { Badge, Card, Panel, State } from '../components.jsx';
import { compact, dateTime, duration, num, usd } from '../format.js';
import { useApi } from '../hooks.js';

export default function SessionDetail({ id }) {
  const { data, error, loading } = useApi(`/sessions/${encodeURIComponent(id)}`);
  return (
    <State loading={loading} error={error}>
      {data && <Body data={data} />}
    </State>
  );
}

function Body({ data }) {
  const { session, totals: t, spans } = data;
  const turns = spans.filter((s) => s.op === 'turn');
  const children = (turnId) => spans.filter((s) => s.parent_span_id === turnId && (s.op === 'llm' || s.op === 'tool'));
  const orphans = spans.filter(
    (s) => (s.op === 'llm' || s.op === 'tool') && !turns.some((x) => x.span_id === s.parent_span_id),
  );

  return (
    <>
      <p><a href="#/sessions">← Sessions</a></p>
      <h1 className="title">
        {session ? session.project : 'Session'} <span className="muted small">{session && dateTime(session.start_ts)}</span>
      </h1>
      <div className="cards">
        <Card label="Cost" value={usd(t.cost_usd)} sub={`${num(t.llm_calls)} LLM calls`} />
        <Card label="Tokens in / out" value={`${compact(t.input_tokens + t.cache_read_tokens + t.cache_write_tokens)} / ${compact(t.output_tokens)}`} sub={`${compact(t.cache_read_tokens)} cache read`} />
        <Card label="Turns" value={num(t.turns)} />
        <Card label="Tool calls" value={num(t.tool_calls)} sub={`${t.tool_errors} errors`} />
      </div>
      {turns.map((turn) => (
        <Waterfall key={turn.span_id} title={`Turn ${turn.name.replace('turn ', '')}`} turn={turn} rows={children(turn.span_id)} />
      ))}
      {orphans.length > 0 && <Waterfall title="Outside a turn" rows={orphans} />}
    </>
  );
}

// Bars are positioned relative to the turn (or the rows' own extent when there is no turn span).
function Waterfall({ title, turn, rows }) {
  const end = (s) => s.end_ts ?? s.start_ts;
  const t0 = turn ? turn.start_ts : Math.min(...rows.map((r) => r.start_ts));
  const t1 = Math.max(turn ? end(turn) : 0, ...rows.map(end), t0 + 1);
  const span = t1 - t0;
  const cost = rows.reduce((n, r) => n + r.cost_usd, 0);
  const prompt = turn && turn.attributes.prompt;

  return (
    <Panel
      title={title}
      right={
        <span className="muted small">
          {duration(span)} · {usd(cost)} {turn && turn.status !== 'ok' && <Badge kind="run">{turn.status}</Badge>}
        </span>
      }
    >
      {prompt && <p className="prompt">“{prompt}”</p>}
      <div className="wf">
        {rows.map((r) => {
          const left = ((r.start_ts - t0) / span) * 100;
          const width = Math.max(0.6, ((end(r) - r.start_ts) / span) * 100);
          const detail =
            r.op === 'llm'
              ? `${compact(r.input_tokens + r.cache_read_tokens + r.cache_write_tokens)} in / ${compact(r.output_tokens)} out · ${usd(r.cost_usd)}`
              : r.status === 'error'
                ? r.attributes.error || 'error'
                : r.attributes.input || '';
          return (
            <div className="wf-row" key={r.span_id}>
              <div className="wf-name" title={r.name}>
                <span className={`op op-${r.op}`}>{r.op}</span> {r.name}
              </div>
              <div className="wf-track">
                <div
                  className={`wf-bar wf-${r.op} ${r.status === 'error' ? 'wf-err' : ''}`}
                  style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                  title={`${r.name}: ${duration(r.duration_ms)}`}
                />
              </div>
              <div className="wf-meta" title={detail}>{duration(r.duration_ms)} {detail && <span className="muted">· {detail}</span>}</div>
            </div>
          );
        })}
        {rows.length === 0 && <div className="muted">No LLM or tool spans recorded for this turn.</div>}
      </div>
    </Panel>
  );
}
