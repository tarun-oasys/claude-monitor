'use strict';

// Reads Claude Code's session transcript (JSONL) and extracts exact per-API-call
// token usage and model. The transcript is the only place the real usage numbers
// live; hook payloads do not carry them.

const fs = require('fs');

const USAGE_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'cache_write_1h_tokens',
];

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// Reads bytes [offset, EOF) and cuts at the last newline so a line that is
// still being written is left for the next read.
function readComplete(file, offset) {
  const size = fileSize(file);
  const start = offset > size ? 0 : offset;
  const len = size - start;
  if (len <= 0) return { text: '', endOffset: start };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === -1) return { text: '', endOffset: start };
    return { text: buf.subarray(0, lastNl + 1).toString('utf8'), endOffset: start + lastNl + 1 };
  } finally {
    fs.closeSync(fd);
  }
}

function normalizeUsage(u) {
  const usage = u || {};
  const cc = usage.cache_creation || {};
  const w1h = cc.ephemeral_1h_input_tokens || 0;
  const total = usage.cache_creation_input_tokens || (cc.ephemeral_5m_input_tokens || 0) + w1h;
  return {
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cache_read_tokens: usage.cache_read_input_tokens || 0,
    cache_write_tokens: total,
    cache_write_1h_tokens: Math.min(w1h, total),
  };
}

// A streamed response is written as several lines sharing one message id, with
// usage growing as it streams. Field-wise max yields the final numbers.
function mergeUsage(a, b) {
  const out = {};
  for (const f of USAGE_FIELDS) out[f] = Math.max(a[f] || 0, b[f] || 0);
  return out;
}

function toMs(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Parses transcript lines from `offset` and returns one entry per distinct
 * assistant API response.
 *
 * @param {string} file       transcript path
 * @param {number} offset     byte offset to start from
 * @param {number} [fallbackStartMs] start time for the first response when no earlier entry is in range
 * @returns {{ messages: Array, endOffset: number }}
 */
function parseTranscript(file, offset = 0, fallbackStartMs = null) {
  if (!file) return { messages: [], endOffset: offset };
  let read;
  try {
    read = readComplete(file, offset);
  } catch {
    return { messages: [], endOffset: offset };
  }

  const groups = new Map();
  let prevTs = fallbackStartMs;

  for (const line of read.text.split('\n')) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = toMs(entry.timestamp);
    const msg = entry.message;

    if (entry.type !== 'assistant' || !msg || !msg.usage) {
      if (ts !== null) prevTs = ts;
      continue;
    }
    if (entry.isApiErrorMessage || msg.model === '<synthetic>') continue;

    const id = msg.id || entry.uuid;
    if (!id) continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    const toolUses = content.filter((c) => c && c.type === 'tool_use').length;
    const usage = normalizeUsage(msg.usage);

    const existing = groups.get(id);
    if (existing) {
      existing.usage = mergeUsage(existing.usage, usage);
      if (ts !== null) existing.end_ts = Math.max(existing.end_ts, ts);
      existing.tool_calls += toolUses;
      if (msg.stop_reason) existing.stop_reason = msg.stop_reason;
    } else {
      const end = ts !== null ? ts : prevTs !== null ? prevTs : Date.now();
      groups.set(id, {
        message_id: id,
        model: msg.model || 'unknown',
        start_ts: prevTs !== null && prevTs <= end ? prevTs : end,
        end_ts: end,
        usage,
        tool_calls: toolUses,
        stop_reason: msg.stop_reason || null,
        sidechain: Boolean(entry.isSidechain),
      });
    }
  }

  return { messages: [...groups.values()], endOffset: read.endOffset };
}

module.exports = { parseTranscript, fileSize, normalizeUsage };
