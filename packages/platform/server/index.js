import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadPricing } from './cost.js';
import { openDb, purgeOlderThan } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 4318;
const host = process.env.HOST || '0.0.0.0';
const ingestKey = process.env.API_KEY || '';
const dashboardKey = process.env.DASHBOARD_KEY || '';
const retentionDays = Number(process.env.RETENTION_DAYS) || 0;

if (!ingestKey) console.warn('[warn] API_KEY is not set: /api/ingest accepts unauthenticated writes. Set it outside local development.');
if (!dashboardKey) console.warn('[warn] DASHBOARD_KEY is not set: the dashboard API is readable without authentication.');

const db = openDb();
const app = createApp({
  db,
  pricing: loadPricing(),
  ingestKey,
  dashboardKey,
  staticDir: process.env.STATIC_DIR || path.resolve(here, '../dashboard/dist'),
});

let purgeTimer;
if (retentionDays > 0) {
  const purge = () => {
    const n = purgeOlderThan(db, retentionDays);
    if (n > 0) console.log(`[retention] deleted ${n} spans older than ${retentionDays}d`);
  };
  purge();
  purgeTimer = setInterval(purge, 6 * 3600_000);
  purgeTimer.unref();
}

const server = app.listen(port, host, () => console.log(`claude-monitor listening on http://${host}:${port}`));

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
