const DAY_MS = 86_400_000;

export function parseRange(query, now = Date.now()) {
  const to = Number(query.to) || now;
  const from = Number(query.from) || to - 30 * DAY_MS;
  const project = typeof query.project === 'string' && query.project ? query.project : null;
  return { from, to, project };
}

// project filter appended to any WHERE that already constrains start_ts.
const projectClause = (r) => (r.project ? 'AND project = @project' : '');
const params = (r) => ({ from: r.from, to: r.to, project: r.project });

export function overview(db, range) {
  const p = params(range);
  const pc = projectClause(range);
  const where = `start_ts BETWEEN @from AND @to ${pc}`;

  const llm = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd),0) AS cost_usd,
              COALESCE(SUM(input_tokens),0) AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens,
              COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens),0) AS cache_write_tokens,
              COUNT(*) AS llm_calls,
              COALESCE(AVG(duration_ms),0) AS avg_llm_ms
       FROM spans WHERE op='llm' AND ${where}`,
    )
    .get(p);

  const counts = db
    .prepare(
      `SELECT COUNT(DISTINCT CASE WHEN op='session' THEN session_id END) AS sessions,
              SUM(op='turn') AS turns,
              SUM(op='tool') AS tool_calls,
              SUM(op='tool' AND status='error') AS tool_errors
       FROM spans WHERE ${where}`,
    )
    .get(p);

  const daily = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', start_ts/1000, 'unixepoch') AS day,
              COALESCE(SUM(CASE WHEN op='llm' THEN cost_usd END),0) AS cost_usd,
              COALESCE(SUM(CASE WHEN op='llm' THEN input_tokens + output_tokens + cache_read_tokens + cache_write_tokens END),0) AS tokens,
              SUM(op='llm') AS llm_calls,
              SUM(op='tool') AS tool_calls,
              COUNT(DISTINCT CASE WHEN op='session' THEN session_id END) AS sessions
       FROM spans WHERE ${where} GROUP BY day ORDER BY day`,
    )
    .all(p);

  const models = db
    .prepare(
      `SELECT COALESCE(model,'unknown') AS model, COUNT(*) AS calls,
              SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
              SUM(cost_usd) AS cost_usd, MIN(priced) AS priced
       FROM spans WHERE op='llm' AND ${where} GROUP BY model ORDER BY cost_usd DESC, calls DESC`,
    )
    .all(p);

  const tools = db
    .prepare(
      `SELECT name, COUNT(*) AS calls, SUM(status='error') AS errors,
              COALESCE(AVG(duration_ms),0) AS avg_ms, COALESCE(MAX(duration_ms),0) AS max_ms
       FROM spans WHERE op='tool' AND ${where} GROUP BY name ORDER BY calls DESC LIMIT 25`,
    )
    .all(p);

  const projects = db
    .prepare(
      `SELECT COALESCE(project,'unknown') AS project, SUM(cost_usd) AS cost_usd,
              COUNT(DISTINCT session_id) AS sessions, SUM(op='llm') AS llm_calls
       FROM spans WHERE ${where} GROUP BY project ORDER BY cost_usd DESC LIMIT 25`,
    )
    .all(p);

  return {
    range: { from: range.from, to: range.to, project: range.project },
    totals: {
      ...llm,
      sessions: counts.sessions || 0,
      turns: counts.turns || 0,
      tool_calls: counts.tool_calls || 0,
      tool_errors: counts.tool_errors || 0,
    },
    daily,
    models: models.map((m) => ({ ...m, priced: Boolean(m.priced) })),
    tools,
    projects,
  };
}

export function listSessions(db, range, { limit = 50, offset = 0 } = {}) {
  const p = { ...params(range), limit: Math.min(limit, 200), offset };
  const pc = projectClause(range);

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM spans WHERE op='session' AND start_ts BETWEEN @from AND @to ${pc}`)
    .get(p).n;

  const rows = db
    .prepare(
      `SELECT s.session_id, s.project, s.user, s.environment, s.status, s.start_ts,
              COALESCE(a.last_ts, s.end_ts, s.start_ts) AS last_ts,
              COALESCE(a.turns,0) AS turns, COALESCE(a.tool_calls,0) AS tool_calls,
              COALESCE(a.tool_errors,0) AS tool_errors, COALESCE(a.llm_calls,0) AS llm_calls,
              COALESCE(a.cost_usd,0) AS cost_usd,
              COALESCE(a.tokens,0) AS tokens, COALESCE(a.unpriced,0) AS unpriced
       FROM spans s
       LEFT JOIN (
         SELECT session_id, MAX(COALESCE(end_ts,start_ts)) AS last_ts,
                SUM(op='turn') AS turns, SUM(op='tool') AS tool_calls,
                SUM(op='tool' AND status='error') AS tool_errors, SUM(op='llm') AS llm_calls,
                SUM(cost_usd) AS cost_usd,
                SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens,
                SUM(op='llm' AND priced=0) AS unpriced
         FROM spans GROUP BY session_id
       ) a ON a.session_id = s.session_id
       WHERE s.op='session' AND s.start_ts BETWEEN @from AND @to ${pc.replace('project', 's.project')}
       ORDER BY s.start_ts DESC LIMIT @limit OFFSET @offset`,
    )
    .all(p);

  return { total, sessions: rows };
}

export function sessionDetail(db, sessionId) {
  const spans = db
    .prepare('SELECT * FROM spans WHERE session_id = ? ORDER BY start_ts, span_id')
    .all(sessionId)
    .map((s) => ({ ...s, priced: Boolean(s.priced), attributes: safeParse(s.attributes) }));
  if (spans.length === 0) return null;

  const session = spans.find((s) => s.op === 'session') || null;
  const llm = spans.filter((s) => s.op === 'llm');
  const tools = spans.filter((s) => s.op === 'tool');
  return {
    session,
    totals: {
      cost_usd: llm.reduce((n, s) => n + s.cost_usd, 0),
      input_tokens: llm.reduce((n, s) => n + s.input_tokens, 0),
      output_tokens: llm.reduce((n, s) => n + s.output_tokens, 0),
      cache_read_tokens: llm.reduce((n, s) => n + s.cache_read_tokens, 0),
      cache_write_tokens: llm.reduce((n, s) => n + s.cache_write_tokens, 0),
      llm_calls: llm.length,
      tool_calls: tools.length,
      tool_errors: tools.filter((s) => s.status === 'error').length,
      turns: spans.filter((s) => s.op === 'turn').length,
    },
    spans,
  };
}

export function listProjects(db) {
  return db
    .prepare(`SELECT DISTINCT project FROM spans WHERE project IS NOT NULL ORDER BY project`)
    .all()
    .map((r) => r.project);
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
