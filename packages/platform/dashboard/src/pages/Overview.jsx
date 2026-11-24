import React from 'react';
import { Badge, Card, DailyBars, InlineBar, Panel, State } from '../components.jsx';
import { compact, duration, num, pct, usd } from '../format.js';
import { useApi } from '../hooks.js';

export default function Overview({ range }) {
  const { data, error, loading } = useApi('/overview', range);

  return (
    <State loading={loading} error={error}>
      {data && <Body data={data} />}
    </State>
  );
}

function Body({ data }) {
  const { totals: t, daily, models, tools, projects } = data;
  const allTokens = t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens;
  const cacheShare = pct(t.cache_read_tokens, t.input_tokens + t.cache_read_tokens + t.cache_write_tokens);
  const unpriced = models.filter((m) => !m.priced);
  const maxModel = Math.max(...models.map((m) => m.cost_usd || 0), 0);
  const maxProject = Math.max(...projects.map((p) => p.cost_usd || 0), 0);

  return (
    <>
      {unpriced.length > 0 && (
        <div className="notice">
          No pricing for {unpriced.map((m) => m.model).join(', ')}: their cost is counted as $0. Add them to
          <code> server/pricing.json</code> and run <code>npm run recost</code>.
        </div>
      )}

      <div className="cards">
        <Card label="Estimated cost" value={usd(t.cost_usd)} sub={`${num(t.llm_calls)} LLM calls`} />
        <Card label="Tokens" value={compact(allTokens)} sub={`${compact(t.output_tokens)} output`} />
        <Card label="Cache hit share" value={cacheShare} sub="cache read / input side" />
        <Card label="Sessions" value={num(t.sessions)} sub={`${num(t.turns)} turns`} />
        <Card
          label="Tool calls"
          value={num(t.tool_calls)}
          sub={`${pct(t.tool_errors, t.tool_calls)} errors`}
        />
        <Card label="Avg LLM latency" value={duration(t.avg_llm_ms)} />
      </div>

      <Panel title="Daily cost (USD)">
        <DailyBars rows={daily} />
      </Panel>

      <div className="grid2">
        <Panel title="Models">
          <table>
            <thead>
              <tr><th>Model</th><th className="r">Calls</th><th className="r">Tokens</th><th className="r">Cost</th><th /></tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.model}>
                  <td>{m.model} {!m.priced && <Badge kind="warn">unpriced</Badge>}</td>
                  <td className="r">{num(m.calls)}</td>
                  <td className="r">{compact(m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_write_tokens)}</td>
                  <td className="r">{usd(m.cost_usd)}</td>
                  <td className="w"><InlineBar value={m.cost_usd} max={maxModel} /></td>
                </tr>
              ))}
              {models.length === 0 && <tr><td colSpan="5" className="muted">No LLM calls yet.</td></tr>}
            </tbody>
          </table>
        </Panel>

        <Panel title="Projects">
          <table>
            <thead>
              <tr><th>Project</th><th className="r">Sessions</th><th className="r">Cost</th><th /></tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.project}>
                  <td>{p.project}</td>
                  <td className="r">{num(p.sessions)}</td>
                  <td className="r">{usd(p.cost_usd || 0)}</td>
                  <td className="w"><InlineBar value={p.cost_usd || 0} max={maxProject} /></td>
                </tr>
              ))}
              {projects.length === 0 && <tr><td colSpan="4" className="muted">No projects yet.</td></tr>}
            </tbody>
          </table>
        </Panel>
      </div>

      <Panel title="Tools">
        <table>
          <thead>
            <tr><th>Tool</th><th className="r">Calls</th><th className="r">Errors</th><th className="r">Error rate</th><th className="r">Avg</th><th className="r">Max</th></tr>
          </thead>
          <tbody>
            {tools.map((x) => (
              <tr key={x.name}>
                <td>{x.name}</td>
                <td className="r">{num(x.calls)}</td>
                <td className="r">{num(x.errors)}</td>
                <td className="r">{pct(x.errors, x.calls)}</td>
                <td className="r">{duration(x.avg_ms)}</td>
                <td className="r">{duration(x.max_ms)}</td>
              </tr>
            ))}
            {tools.length === 0 && <tr><td colSpan="6" className="muted">No tool calls yet.</td></tr>}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
