'use strict';

// Local state for the hook handler. Hooks are separate short-lived processes, so
// everything that must survive between events lives on disk under os.tmpdir().
// One directory per session; tool spans get one file each so parallel tool
// hooks never read-modify-write the same file.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.env.CLAUDE_TELEMETRY_DIR || path.join(os.tmpdir(), 'claude-telemetry');
const STATE_DIR = path.join(ROOT, 'state');
const SPOOL_DIR = path.join(ROOT, 'spool');
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CONFIG_PATH =
  process.env.CLAUDE_TELEMETRY_CONFIG || path.join(os.homedir(), '.claude-telemetry', 'config.json');

function ensureDirs() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SPOOL_DIR, { recursive: true, mode: 0o700 });
}

function newId(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function hashId(...parts) {
  return crypto.createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 16);
}

function safeName(s) {
  return String(s).replace(/[^\w.-]/g, '_').slice(0, 128);
}

function parseBool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
}

// Precedence: environment > config file > defaults.
function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    // missing or invalid config file: fall through to env/defaults
  }
  const env = process.env;
  return {
    disabled: parseBool(env.CLAUDE_TELEMETRY_DISABLED, parseBool(file.disabled, false)),
    endpoint: env.CLAUDE_TELEMETRY_ENDPOINT || file.endpoint || 'http://localhost:4318/api/ingest',
    apiKey: env.CLAUDE_TELEMETRY_API_KEY || file.apiKey || '',
    captureContent: parseBool(env.CLAUDE_TELEMETRY_CAPTURE_CONTENT, parseBool(file.captureContent, false)),
    user: env.CLAUDE_TELEMETRY_USER || file.user || safeUser(),
    environment: env.CLAUDE_TELEMETRY_ENV || file.environment || 'default',
    debug: parseBool(env.CLAUDE_TELEMETRY_DEBUG, parseBool(file.debug, false)),
  };
}

function safeUser() {
  try {
    return os.userInfo().username;
  } catch {
    return 'unknown';
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function sessionDir(sessionId) {
  return path.join(STATE_DIR, safeName(sessionId));
}

function loadSession(sessionId) {
  return readJson(path.join(sessionDir(sessionId), 'session.json'));
}

function saveSession(sessionId, data) {
  const dir = sessionDir(sessionId);
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true, mode: 0o700 });
  writeJsonAtomic(path.join(dir, 'session.json'), data);
}

function loadTurn(sessionId) {
  return readJson(path.join(sessionDir(sessionId), 'turn.json'));
}

function saveTurn(sessionId, data) {
  writeJsonAtomic(path.join(sessionDir(sessionId), 'turn.json'), data);
}

function clearTurn(sessionId) {
  try {
    fs.unlinkSync(path.join(sessionDir(sessionId), 'turn.json'));
  } catch {
    // already gone
  }
}

function toolFile(sessionId, key) {
  return path.join(sessionDir(sessionId), 'tools', `${safeName(key)}.json`);
}

function saveTool(sessionId, key, data) {
  fs.mkdirSync(path.join(sessionDir(sessionId), 'tools'), { recursive: true, mode: 0o700 });
  writeJsonAtomic(toolFile(sessionId, key), data);
}

// Reads and removes the tool entry in one step.
function takeTool(sessionId, key) {
  const file = toolFile(sessionId, key);
  const data = readJson(file);
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone
  }
  return data;
}

function removeSession(sessionId) {
  fs.rmSync(sessionDir(sessionId), { recursive: true, force: true });
}

function pruneStaleState() {
  let entries;
  try {
    entries = fs.readdirSync(STATE_DIR);
  } catch {
    return;
  }
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const name of entries) {
    const dir = path.join(STATE_DIR, name);
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // raced with another cleanup
    }
  }
}

// Spans are written to the spool as one JSON file per hook event. The worker
// only picks up *.json, so the tmp+rename keeps it from reading partial files.
function enqueue(spans) {
  const name = `${Date.now()}-${newId(4)}`;
  const tmp = path.join(SPOOL_DIR, `${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(spans), { mode: 0o600 });
  fs.renameSync(tmp, path.join(SPOOL_DIR, `${name}.json`));
}

function debugLog(config, msg) {
  if (!config.debug) return;
  try {
    const dir = path.dirname(CONFIG_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'debug.log'), `${new Date().toISOString()} pid=${process.pid} ${msg}\n`);
  } catch {
    // debug logging is best effort
  }
}

module.exports = {
  debugLog,
  ROOT,
  STATE_DIR,
  SPOOL_DIR,
  CONFIG_PATH,
  ensureDirs,
  newId,
  hashId,
  loadConfig,
  loadSession,
  saveSession,
  loadTurn,
  saveTurn,
  clearTurn,
  saveTool,
  takeTool,
  removeSession,
  pruneStaleState,
  enqueue,
};
