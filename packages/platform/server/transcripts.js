// Reads the transcripts Claude Code writes locally (~/.claude/projects/**/*.jsonl) and turns
// them into spans: session > turn > llm | tool. Cost is Claude Code's own per-model session
// total (the `cost-state` entry), split across that model's calls.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hash = (len, ...p) => crypto.createHash('sha256').update(p.join('|')).digest('hex').slice(0, len);
const ts = (e) => {
  const t = Date.parse(e.timestamp);
  return Number.isNaN(t) ? null : t;
};
// Relative cost weight of one call, used only to split Claude Code's reported per-model
// session cost across that model's calls (the per-session total stays exact).
const weight = (u) => u.input_tokens + 5 * u.output_tokens + 0.1 * u.cache_read_tokens + 1.25 * u.cache_write_tokens + 1;

function usageOf(u) {
  const cc = u.cache_creation || {};
  const w1h = cc.ephemeral_1h_input_tokens || 0;
  const w = u.cache_creation_input_tokens || (cc.ephemeral_5m_input_tokens || 0) + w1h;
  return {
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_read_tokens: u.cache_read_input_tokens || 0,
    cache_write_tokens: w,
    cache_write_1h_tokens: Math.min(w1h, w),
  };
}
const maxUsage = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, Math.max(a[k], b[k])]));

function isPrompt(e) {
  if (e.type !== 'user' || e.isSidechain || e.isMeta || !e.message) return false;
  const c = e.message.content;
  if (typeof c === 'string') return c.length > 0;
  return Array.isArray(c) && c.some((b) => b.type === 'text') && !c.some((b) => b.type === 'tool_result');
}

export function parseTranscriptFile(file, { cutoff, user }) {
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // partial last line of a live session
    }
  }
  const first = entries.find((e) => e.sessionId && e.cwd);
  if (!first) return [];
  const sid = first.sessionId;
  const project = path.basename(first.cwd) || 'unknown';
  const traceId = hash(32, sid);
  const sessionSpanId = hash(16, sid, 'session');
  const common = { trace_id: traceId, session_id: sid, project, user, environment: 'transcripts' };

  let turn = null;
  const turns = [];
  const llm = new Map();
  const toolUses = new Map();
  const tools = [];
  let prevTs = null;
  let costState = null;
  let min = Infinity;
  let max = 0;

  for (const e of entries) {
    if (e.type === 'cost-state' && e.modelUsage) costState = e.modelUsage;
    const t = ts(e);
    if (t === null) continue;
    min = Math.min(min, t);
    max = Math.max(max, t);

    if (isPrompt(e)) {
      turn = { id: hash(16, sid, 'turn', e.promptId || e.uuid), index: turns.length + 1, start: t, end: t };
      turns.push(turn);
    } else if (turn) {
      turn.end = Math.max(turn.end, t);
    }
    const parent = turn ? turn.id : sessionSpanId;

    const msg = e.message;
    if (e.type === 'assistant' && msg && msg.usage && msg.model !== '<synthetic>' && !e.isApiErrorMessage) {
      const id = msg.id || e.requestId || e.uuid;
      const usage = usageOf(msg.usage);
      const g = llm.get(id);
      if (g) {
        g.usage = maxUsage(g.usage, usage);
        g.end = Math.max(g.end, t);
      } else {
        llm.set(id, { id, model: msg.model, start: prevTs !== null && prevTs <= t ? prevTs : t, end: t, usage, parent, sidechain: Boolean(e.isSidechain) });
      }
    }
    if (e.type === 'assistant' && msg && Array.isArray(msg.content)) {
      for (const b of msg.content) if (b.type === 'tool_use') toolUses.set(b.id, { name: b.name, start: t, parent });
    }
    if (e.type === 'user' && msg && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        const u = b.type === 'tool_result' && toolUses.get(b.tool_use_id);
        if (u) tools.push({ id: b.tool_use_id, ...u, end: t, error: b.is_error === true });
      }
    }
    prevTs = t;
  }
  if (!Number.isFinite(min) || max < cutoff) return [];

  // Split Claude Code's reported per-model cost across that model's calls.
  const sums = {};
  for (const g of llm.values()) sums[g.model] = (sums[g.model] || 0) + weight(g.usage);
  const spans = [
    { ...common, span_id: sessionSpanId, parent_span_id: null, op: 'session', name: `session ${project}`, status: 'ok', start_ts: min, end_ts: max, attributes: { source: 'transcript' } },
  ];
  for (const t of turns) {
    spans.push({ ...common, span_id: t.id, parent_span_id: sessionSpanId, op: 'turn', name: `turn ${t.index}`, status: 'ok', start_ts: t.start, end_ts: t.end, attributes: { source: 'transcript' } });
  }
  for (const g of llm.values()) {
    const reported = costState && costState[g.model] && costState[g.model].costUSD;
    spans.push({
      ...common, span_id: hash(16, sid, 'llm', g.id), parent_span_id: g.parent, op: 'llm', name: g.model, status: 'ok', model: g.model,
      start_ts: g.start, end_ts: g.end, ...g.usage,
      ...(reported !== undefined ? { cost_usd: (reported * weight(g.usage)) / sums[g.model] } : {}),
      attributes: { source: 'transcript', cost_source: reported !== undefined ? 'reported' : 'computed', ...(g.sidechain ? { sidechain: true } : {}) },
    });
  }
  for (const t of tools) {
    spans.push({ ...common, span_id: hash(16, sid, 'tool', t.id), parent_span_id: t.parent, op: 'tool', name: t.name, status: t.error ? 'error' : 'ok', start_ts: t.start, end_ts: t.end, attributes: { tool_name: t.name, source: 'transcript' } });
  }
  return spans;
}

function* jsonlFiles(root, cutoff) {
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, d.name);
    if (d.isDirectory()) yield* jsonlFiles(p, cutoff);
    else if (d.name.endsWith('.jsonl') && fs.statSync(p).mtimeMs >= cutoff) yield p;
  }
}


/**
 * Parses every transcript that changed since the last call (tracked in `state.seen`) and hands
 * the spans to `emit` in batches. Span ids are deterministic, so re-parsing a growing file
 * just upserts.
 */
export async function syncTranscripts(state, { dir, days = 30, emit, batchSize = 500 }) {
  const cutoff = Date.now() - days * 86_400_000;
  const user = os.userInfo().username;
  const stats = { files: 0, sessions: 0, spans: 0 };
  let batch = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await emit(batch);
    batch = [];
  };
  if (!fs.existsSync(dir)) return stats;
  for (const file of jsonlFiles(dir, cutoff)) {
    let version;
    try {
      const st = fs.statSync(file);
      version = `${st.mtimeMs}:${st.size}`;
    } catch {
      continue;
    }
    if (state.seen.get(file) === version) continue;
    let spans;
    try {
      spans = parseTranscriptFile(file, { cutoff, user });
    } catch {
      continue;
    }
    stats.files += 1;
    if (spans.length) stats.sessions += 1;
    for (const s of spans) {
      batch.push(s);
      stats.spans += 1;
      if (batch.length >= batchSize) await flush();
    }
    await flush();
    state.seen.set(file, version);
  }
  return stats;
}
