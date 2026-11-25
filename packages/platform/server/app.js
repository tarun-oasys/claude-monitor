import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { makeUpserter } from './db.js';
import { ingestSpans, MAX_BATCH } from './ingest.js';
import { syncTranscripts } from './transcripts.js';
import { decodeLogsProtobuf, logsToSpans } from './otlp.js';
import { listProjects, listSessions, overview, parseRange, sessionDetail } from './queries.js';

function keyMatches(expected, provided) {
  if (!provided) return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(provided).digest();
  return crypto.timingSafeEqual(a, b);
}

function extractKey(req) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  return req.get('x-api-key') || (bearer && bearer[1]) || '';
}

function requireKey(expected) {
  return (req, res, next) => {
    if (!expected || keyMatches(expected, extractKey(req))) return next();
    res.status(401).json({ error: 'invalid or missing API key' });
  };
}

/**
 * @param {{ db: import('better-sqlite3').Database, pricing: object[], ingestKey?: string, dashboardKey?: string, staticDir?: string }} deps
 */
export function createApp({ db, pricing, ingestKey = '', dashboardKey = '', staticDir, transcriptDir = '', transcriptDays = 30 }) {
  const app = express();
  const upsert = makeUpserter(db);

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
    });
    next();
  });

  app.get('/api/health', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok' });
  });

  const ingestAuth = requireKey(ingestKey);
  app.get('/api/ingest/check', ingestAuth, (req, res) => res.json({ status: 'ok' }));
  app.post('/api/ingest', ingestAuth, express.json({ limit: '5mb' }), (req, res) => {
    const spans = req.body && req.body.spans;
    if (!Array.isArray(spans)) return res.status(400).json({ error: '`spans` must be an array' });
    if (spans.length > MAX_BATCH) return res.status(413).json({ error: `max ${MAX_BATCH} spans per request` });
    const result = ingestSpans(upsert, pricing, spans);
    // A fully-invalid batch is a client error so the plugin drops it instead of retrying forever.
    res.status(result.accepted === 0 && result.rejected.length > 0 ? 400 : 200).json(result);
  });

  // OTLP/HTTP receiver. Point Claude Code's native OpenTelemetry export at this server:
  //   OTEL_EXPORTER_OTLP_ENDPOINT=http://host:4318  OTEL_EXPORTER_OTLP_HEADERS="x-api-key=<API_KEY>"
  // Express inflates gzip bodies for us. Metrics are acknowledged but not stored: the
  // per-request events in /v1/logs carry the same tokens and cost with more detail.
  const otlpBody = [
    express.raw({ type: ['application/x-protobuf', 'application/octet-stream'], limit: '10mb' }),
    express.json({ limit: '10mb' }),
  ];
  const otlpAck = (req, res) => {
    if ((req.get('content-type') || '').includes('json')) return res.json({});
    res.status(200).type('application/x-protobuf').end();
  };
  app.post('/v1/logs', ingestAuth, ...otlpBody, (req, res) => {
    let payload;
    try {
      payload = Buffer.isBuffer(req.body) ? decodeLogsProtobuf(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: 'invalid OTLP protobuf' });
    }
    const spans = logsToSpans(payload || {});
    for (let i = 0; i < spans.length; i += MAX_BATCH) ingestSpans(upsert, pricing, spans.slice(i, i + MAX_BATCH));
    otlpAck(req, res);
  });
  app.post('/v1/metrics', ingestAuth, ...otlpBody, otlpAck);
  app.post('/v1/traces', ingestAuth, ...otlpBody, otlpAck);

  // Optional: import local Claude Code transcripts whenever the dashboard asks for data, so a
  // page refresh shows new sessions. Concurrent requests share one pass; passes are at most
  // ~1.5s apart and only re-read files that changed.
  const transcriptState = { seen: new Map() };
  let syncing = null;
  let lastSync = 0;
  const refreshTranscripts = () => {
    if (!transcriptDir) return null;
    if (syncing) return syncing;
    if (Date.now() - lastSync < 1500) return null;
    syncing = syncTranscripts(transcriptState, {
      dir: transcriptDir,
      days: transcriptDays,
      emit: async (spans) => ingestSpans(upsert, pricing, spans),
    })
      .catch((e) => console.error('[transcripts]', e.message))
      .finally(() => {
        lastSync = Date.now();
        syncing = null;
      });
    return syncing;
  };

  const api = express.Router();
  api.use(requireKey(dashboardKey));
  api.use(async (req, res, next) => {
    await refreshTranscripts();
    next();
  });
  api.get('/overview', (req, res) => res.json(overview(db, parseRange(req.query))));
  api.get('/projects', (req, res) => res.json(listProjects(db)));
  api.get('/sessions', (req, res) => {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.json(listSessions(db, parseRange(req.query), { limit, offset }));
  });
  api.get('/sessions/:id', (req, res) => {
    const detail = sessionDetail(db, req.params.id);
    if (!detail) return res.status(404).json({ error: 'session not found' });
    res.json(detail);
  });
  app.use('/api', api);

  if (staticDir && fs.existsSync(path.join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir, { index: 'index.html', maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.resolve(staticDir, 'index.html')));
  }

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
