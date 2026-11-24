#!/usr/bin/env node
'use strict';

// Hook entrypoint. Claude Code blocks on hooks, so this does only local file
// work, queues spans to the spool and spawns a detached worker to do the HTTP.
// It always exits 0 and never writes to stdout (SessionStart stdout would be
// injected into the model's context).

const path = require('path');
const { spawn } = require('child_process');
const state = require('./state-manager');
const { parseTranscript, fileSize } = require('./transcript-parser');

const MAX_FIELD = 500;
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/g,
  /sk-[A-Za-z0-9_-]{10,}/g,
  /(api[_-]?key|token|secret|password|passwd|authorization)(["'\s]*[=:]["'\s]*)[^\s"']+/gi,
];

function readStdin(timeoutMs = 2000) {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function redact(text) {
  let out = String(text);
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m, k, sep) => (typeof k === 'string' ? `${k}${sep}[REDACTED]` : '[REDACTED]'));
  return out.length > MAX_FIELD ? `${out.slice(0, MAX_FIELD)}…` : out;
}

function byteLength(v) {
  if (v === undefined || v === null) return 0;
  try {
    return Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v));
  } catch {
    return 0;
  }
}

function toolKey(input) {
  if (input.tool_use_id) return input.tool_use_id;
  return state.hashId(input.tool_name || '', JSON.stringify(input.tool_input || {}));
}

function isToolError(response) {
  if (!response || typeof response !== 'object') return false;
  return response.is_error === true || response.success === false || response.interrupted === true;
}

function mcpAttrs(toolName) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(toolName || '');
  return m ? { mcp_server: m[1], mcp_tool: m[2] } : {};
}

function createSession(input, config) {
  const sess = {
    sessionId: input.session_id,
    traceId: state.newId(16),
    spanId: state.newId(8),
    startedAt: Date.now(),
    project: path.basename(input.cwd || '') || 'unknown',
    user: config.user,
    environment: config.environment,
    turnCount: 0,
  };
  state.saveSession(input.session_id, sess);
  return sess;
}

function sessionSpan(sess, extra) {
  return {
    trace_id: sess.traceId,
    span_id: sess.spanId,
    parent_span_id: null,
    session_id: sess.sessionId,
    op: 'session',
    name: `session ${sess.project}`,
    project: sess.project,
    user: sess.user,
    environment: sess.environment,
    start_ts: sess.startedAt,
    ...extra,
  };
}

function turnSpan(sess, turn, extra) {
  return {
    trace_id: sess.traceId,
    span_id: turn.spanId,
    parent_span_id: sess.spanId,
    session_id: sess.sessionId,
    op: 'turn',
    name: `turn ${turn.index}`,
    project: sess.project,
    user: sess.user,
    environment: sess.environment,
    start_ts: turn.startedAt,
    ...extra,
  };
}

function llmSpans(sess, turn, messages, extraAttrs) {
  return messages.map((m) => ({
    trace_id: sess.traceId,
    span_id: state.hashId(sess.sessionId, m.message_id),
    parent_span_id: turn ? turn.spanId : sess.spanId,
    session_id: sess.sessionId,
    op: 'llm',
    name: m.model,
    status: 'ok',
    project: sess.project,
    user: sess.user,
    environment: sess.environment,
    model: m.model,
    start_ts: m.start_ts,
    end_ts: m.end_ts,
    ...m.usage,
    attributes: {
      stop_reason: m.stop_reason,
      tool_calls: m.tool_calls,
      ...(m.sidechain ? { sidechain: true } : {}),
      ...extraAttrs,
    },
  }));
}

function ensureSession(input, config, spans) {
  let sess = state.loadSession(input.session_id);
  if (!sess) {
    // Plugin enabled mid-session, or SessionStart was missed.
    sess = createSession(input, config);
    spans.push(sessionSpan(sess, { status: 'running', attributes: { late_attach: true } }));
  }
  return sess;
}

function closeTurn(sess, turn, spans, status, now) {
  spans.push(turnSpan(sess, turn, { status, end_ts: now, attributes: turn.attributes || {} }));
  state.clearTurn(sess.sessionId);
}

const handlers = {
  SessionStart(input, config, spans) {
    state.pruneStaleState();
    const sess = createSession(input, config);
    spans.push(
      sessionSpan(sess, {
        status: 'running',
        attributes: { source: input.source || 'startup', model: input.model || null },
      }),
    );
  },

  UserPromptSubmit(input, config, spans) {
    const now = Date.now();
    const sess = ensureSession(input, config, spans);
    const previous = state.loadTurn(sess.sessionId);
    if (previous) closeTurn(sess, previous, spans, 'cancelled', now);

    sess.turnCount += 1;
    state.saveSession(sess.sessionId, sess);

    const prompt = input.prompt || '';
    const attributes = { prompt_chars: prompt.length };
    if (config.captureContent) attributes.prompt = redact(prompt);
    const turn = {
      spanId: state.newId(8),
      index: sess.turnCount,
      startedAt: now,
      transcriptOffset: fileSize(input.transcript_path),
      attributes,
    };
    state.saveTurn(sess.sessionId, turn);
    spans.push(turnSpan(sess, turn, { status: 'running', attributes }));
  },

  PreToolUse(input, config, spans) {
    ensureSession(input, config, spans);
    state.saveTool(input.session_id, toolKey(input), {
      startedAt: Date.now(),
      name: input.tool_name,
    });
  },

  PostToolUse(input, config, spans) {
    emitTool(input, config, spans, isToolError(input.tool_response) ? 'error' : 'ok');
  },

  PostToolUseFailure(input, config, spans) {
    emitTool(input, config, spans, 'error');
  },

  SubagentStop(input, config, spans) {
    const sess = ensureSession(input, config, spans);
    const turn = state.loadTurn(sess.sessionId);
    const { messages } = parseTranscript(input.agent_transcript_path, 0, turn ? turn.startedAt : null);
    spans.push(...llmSpans(sess, turn, messages, { subagent: true, agent_type: input.agent_type || null }));
  },

  Stop(input, config, spans) {
    const now = Date.now();
    const sess = ensureSession(input, config, spans);
    const turn = state.loadTurn(sess.sessionId);
    if (!turn) return;

    const { messages } = parseTranscript(input.transcript_path, turn.transcriptOffset, turn.startedAt);
    spans.push(...llmSpans(sess, turn, messages, {}));
    turn.attributes = { ...turn.attributes, llm_calls: messages.length };
    closeTurn(sess, turn, spans, 'ok', now);
    spans.push(sessionSpan(sess, { status: 'running', end_ts: now, attributes: { turns: sess.turnCount } }));
  },

  SessionEnd(input, config, spans) {
    const now = Date.now();
    const sess = state.loadSession(input.session_id);
    if (!sess) return;
    const turn = state.loadTurn(sess.sessionId);
    if (turn) closeTurn(sess, turn, spans, 'cancelled', now);
    spans.push(
      sessionSpan(sess, {
        status: 'ok',
        end_ts: now,
        attributes: { turns: sess.turnCount, end_reason: input.reason || null },
      }),
    );
    state.removeSession(sess.sessionId);
  },
};

function emitTool(input, config, spans, status) {
  const now = Date.now();
  const sess = ensureSession(input, config, spans);
  const turn = state.loadTurn(sess.sessionId);
  const started = state.takeTool(sess.sessionId, toolKey(input));
  const attributes = {
    tool_name: input.tool_name,
    input_bytes: byteLength(input.tool_input),
    output_bytes: byteLength(input.tool_response),
    ...mcpAttrs(input.tool_name),
  };
  if (config.captureContent) {
    attributes.input = redact(JSON.stringify(input.tool_input || {}));
    if (status === 'error') attributes.error = redact(input.error || JSON.stringify(input.tool_response || ''));
  }
  spans.push({
    trace_id: sess.traceId,
    span_id: state.hashId(sess.sessionId, toolKey(input)),
    parent_span_id: turn ? turn.spanId : sess.spanId,
    session_id: sess.sessionId,
    op: 'tool',
    name: input.tool_name || 'unknown',
    status,
    project: sess.project,
    user: sess.user,
    environment: sess.environment,
    start_ts: started ? started.startedAt : now,
    end_ts: now,
    attributes,
  });
}

function launchWorker() {
  const child = spawn(process.execPath, [path.join(__dirname, 'worker.js')], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.on('error', () => {});
  child.unref();
}

async function main() {
  const config = state.loadConfig();
  if (config.disabled) return;

  state.debugLog(config, `invoked argv=${process.argv.slice(2).join(' ')} tmp=${state.ROOT}`);
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  const event = input.hook_event_name || process.argv[2];
  state.debugLog(config, `event=${event} session=${input.session_id}`);
  const handler = handlers[event];
  if (!handler || !input.session_id) return;

  state.ensureDirs();
  const spans = [];
  handler(input, config, spans);
  if (spans.length === 0) return;
  state.enqueue(spans);
  launchWorker();
}

if (require.main === module) {
  main()
    .catch((e) => state.debugLog(state.loadConfig(), `error ${e && e.stack}`))
    .finally(() => process.exit(0));
}

module.exports = { handlers, redact };
