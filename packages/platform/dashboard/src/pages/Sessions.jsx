import React, { useEffect, useState } from 'react';
import { Badge, Panel, State } from '../components.jsx';
import { compact, dateTime, duration, num, usd } from '../format.js';
import { useApi } from '../hooks.js';

const PAGE = 25;

export default function Sessions({ range }) {
  const [offset, setOffset] = useState(0);
  const rangeKey = JSON.stringify(range);
  useEffect(() => setOffset(0), [rangeKey]);
  const { data, error, loading } = useApi('/sessions', { ...range, limit: PAGE, offset });

  return (
    <Panel title="Sessions">
      <State loading={loading} error={error}>
        {data && (
          <>
            <table>
              <thead>
                <tr>
                  <th>Started</th><th>Project</th><th>User</th><th>Status</th>
                  <th className="r">Duration</th><th className="r">Turns</th><th className="r">Tools</th>
                  <th className="r">Tokens</th><th className="r">Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.sessions.map((s) => (
                  <tr key={s.session_id} className="click" onClick={() => (window.location.hash = `#/sessions/${encodeURIComponent(s.session_id)}`)}>
                    <td><a href={`#/sessions/${encodeURIComponent(s.session_id)}`}>{dateTime(s.start_ts)}</a></td>
                    <td>{s.project}</td>
                    <td>{s.user}</td>
                    <td><Badge kind={s.status === 'ok' ? 'ok' : 'run'}>{s.status === 'ok' ? 'ended' : 'active'}</Badge></td>
                    <td className="r">{duration(s.last_ts - s.start_ts)}</td>
                    <td className="r">{num(s.turns)}</td>
                    <td className="r">{num(s.tool_calls)}{s.tool_errors > 0 && <span className="error"> ({s.tool_errors} err)</span>}</td>
                    <td className="r">{compact(s.tokens)}</td>
                    <td className="r">{usd(s.cost_usd)}{s.unpriced > 0 && ' *'}</td>
                  </tr>
                ))}
                {data.sessions.length === 0 && <tr><td colSpan="9" className="muted">No sessions in this range.</td></tr>}
              </tbody>
            </table>
            <div className="pager">
              <span className="muted">{data.total} sessions</span>
              <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Prev</button>
              <button disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Next</button>
            </div>
            {data.sessions.some((s) => s.unpriced > 0) && <p className="muted small">* includes calls to models with no pricing (counted as $0).</p>}
          </>
        )}
      </State>
    </Panel>
  );
}
