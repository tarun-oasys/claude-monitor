import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spans (
  span_id               TEXT PRIMARY KEY,
  trace_id              TEXT NOT NULL,
  parent_span_id        TEXT,
  session_id            TEXT NOT NULL,
  op                    TEXT NOT NULL CHECK (op IN ('session','turn','llm','tool')),
  name                  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'ok',
  start_ts              INTEGER NOT NULL,
  end_ts                INTEGER,
  duration_ms           INTEGER,
  project               TEXT,
  user                  TEXT,
  environment           TEXT,
  model                 TEXT,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd              REAL NOT NULL DEFAULT 0,
  priced                INTEGER NOT NULL DEFAULT 1,
  attributes            TEXT NOT NULL DEFAULT '{}',
  received_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spans_session ON spans (session_id, start_ts);
CREATE INDEX IF NOT EXISTS idx_spans_op_start ON spans (op, start_ts);
CREATE INDEX IF NOT EXISTS idx_spans_project ON spans (project, op, start_ts);
`;

export function openDb(file = process.env.DB_PATH || './data/monitor.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

const UPSERT = `
INSERT INTO spans (
  span_id, trace_id, parent_span_id, session_id, op, name, status, start_ts, end_ts, duration_ms,
  project, user, environment, model, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, cache_write_1h_tokens, cost_usd, priced, attributes, received_at
) VALUES (
  @span_id, @trace_id, @parent_span_id, @session_id, @op, @name, @status, @start_ts, @end_ts, @duration_ms,
  @project, @user, @environment, @model, @input_tokens, @output_tokens, @cache_read_tokens,
  @cache_write_tokens, @cache_write_1h_tokens, @cost_usd, @priced, @attributes, @received_at
)
ON CONFLICT(span_id) DO UPDATE SET
  name = excluded.name,
  status = excluded.status,
  start_ts = MIN(spans.start_ts, excluded.start_ts),
  end_ts = CASE
    WHEN excluded.end_ts IS NULL THEN spans.end_ts
    WHEN spans.end_ts IS NULL THEN excluded.end_ts
    ELSE MAX(spans.end_ts, excluded.end_ts) END,
  duration_ms = CASE
    WHEN excluded.end_ts IS NULL AND spans.end_ts IS NULL THEN NULL
    ELSE MAX(COALESCE(excluded.end_ts, 0), COALESCE(spans.end_ts, 0)) - MIN(spans.start_ts, excluded.start_ts) END,
  model = COALESCE(excluded.model, spans.model),
  input_tokens = excluded.input_tokens,
  output_tokens = excluded.output_tokens,
  cache_read_tokens = excluded.cache_read_tokens,
  cache_write_tokens = excluded.cache_write_tokens,
  cache_write_1h_tokens = excluded.cache_write_1h_tokens,
  cost_usd = excluded.cost_usd,
  priced = excluded.priced,
  attributes = excluded.attributes,
  received_at = excluded.received_at
`;

export function makeUpserter(db) {
  const stmt = db.prepare(UPSERT);
  return db.transaction((rows) => {
    for (const row of rows) stmt.run(row);
  });
}

export function purgeOlderThan(db, days) {
  const cutoff = Date.now() - days * 86_400_000;
  return db.prepare('DELETE FROM spans WHERE start_ts < ?').run(cutoff).changes;
}
