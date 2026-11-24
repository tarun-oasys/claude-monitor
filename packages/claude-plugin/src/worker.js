#!/usr/bin/env node
'use strict';

// Detached background sender. Drains the spool directory in batches, retries
// transient failures with backoff, and leaves undelivered files in the spool so
// the next worker (spawned by the next hook) retries them: that is the offline
// fallback. At most one worker runs at a time, guarded by a lock directory.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { ROOT, SPOOL_DIR, loadConfig } = require('./state-manager');

const LOCK_DIR = path.join(ROOT, 'worker.lock');
const LOG_FILE = path.join(ROOT, 'worker.log');
const LOCK_STALE_MS = 60 * 1000;
const BATCH_MAX = 100;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 5000;
const BACKOFF_BASE_MS = 500;
const SPOOL_MAX_FILES = 1000;
const SPOOL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LOG_MAX_BYTES = 256 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.truncateSync(LOG_FILE, 0);
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // logging is best effort
  }
}

function acquireLock() {
  try {
    fs.mkdirSync(LOCK_DIR);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') return false;
  }
  try {
    if (Date.now() - fs.statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS) {
      fs.rmdirSync(LOCK_DIR);
      fs.mkdirSync(LOCK_DIR);
      return true;
    }
  } catch {
    // another worker won the race
  }
  return false;
}

function touchLock() {
  try {
    const now = new Date();
    fs.utimesSync(LOCK_DIR, now, now);
  } catch {
    // lock vanished; harmless
  }
}

function releaseLock() {
  try {
    fs.rmdirSync(LOCK_DIR);
  } catch {
    // already gone
  }
}

function listSpool() {
  let names;
  try {
    names = fs.readdirSync(SPOOL_DIR).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names.sort();
}

// Bounds disk use when the platform is unreachable for a long time.
function pruneSpool() {
  const names = listSpool();
  const cutoff = Date.now() - SPOOL_MAX_AGE_MS;
  const excess = Math.max(0, names.length - SPOOL_MAX_FILES);
  names.forEach((name, i) => {
    const file = path.join(SPOOL_DIR, name);
    try {
      if (i < excess || fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {
      // already gone
    }
  });
}

function post(endpoint, apiKey, body) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      resolve({ status: 0, error: `invalid endpoint ${endpoint}` });
      return;
    }
    const lib = url.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(body));
    const headers = { 'content-type': 'application/json', 'content-length': payload.length };
    if (apiKey) headers['x-api-key'] = apiKey;
    const req = lib.request(
      url,
      { method: 'POST', headers, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.end(payload);
  });
}

// 2xx delivered; 4xx (except 408/429) is permanent so retrying is pointless.
const classify = (status) =>
  status >= 200 && status < 300 ? 'ok' : status >= 400 && status < 500 && status !== 408 && status !== 429 ? 'drop' : 'retry';

async function sendWithRetry(config, spans) {
  let last = { status: 0 };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await post(config.endpoint, config.apiKey, { spans });
    const verdict = classify(last.status);
    if (verdict !== 'retry') return { verdict, last };
    if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
  }
  return { verdict: 'retry', last };
}

function readBatch(names) {
  const files = [];
  const spans = [];
  for (const name of names) {
    const file = path.join(SPOOL_DIR, name);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      try {
        fs.unlinkSync(file);
      } catch {
        // already gone
      }
      continue;
    }
    if (spans.length > 0 && spans.length + parsed.length > BATCH_MAX) break;
    files.push(file);
    spans.push(...parsed);
  }
  return { files, spans };
}

async function drain(config) {
  for (;;) {
    const names = listSpool();
    if (names.length === 0) return;
    const { files, spans } = readBatch(names);
    if (files.length === 0) continue;
    touchLock();

    const { verdict, last } = await sendWithRetry(config, spans);
    if (verdict === 'retry') {
      log(`delivery failed (status ${last.status}${last.error ? ` ${last.error}` : ''}); ${files.length} file(s) kept in spool`);
      return;
    }
    if (verdict === 'drop') log(`platform rejected batch with status ${last.status}; dropped ${spans.length} span(s)`);
    for (const f of files) {
      try {
        fs.unlinkSync(f);
      } catch {
        // already gone
      }
    }
  }
}

async function main() {
  const config = loadConfig();
  if (config.disabled) return;
  if (!acquireLock()) return;
  try {
    pruneSpool();
    await drain(config);
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  main()
    .catch((e) => log(`worker crashed: ${e && e.message}`))
    .finally(() => process.exit(0));
}

module.exports = { classify, drain, post };
