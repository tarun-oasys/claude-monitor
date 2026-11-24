import crypto from 'node:crypto';
import protobuf from 'protobufjs';

// Minimal OTLP/HTTP logs schema (field numbers from opentelemetry-proto). Unknown
// fields are skipped by the decoder, so only what we read is declared.
const PROTO = `
syntax = "proto3";
message KeyValue { string key = 1; AnyValue value = 2; }
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
  }
}
message Resource { repeated KeyValue attributes = 1; }
message LogRecord {
  fixed64 time_unix_nano = 1;
  AnyValue body = 5;
  repeated KeyValue attributes = 6;
  fixed64 observed_time_unix_nano = 11;
}
message ScopeLogs { repeated LogRecord log_records = 2; }
message ResourceLogs { Resource resource = 1; repeated ScopeLogs scope_logs = 2; }
message ExportLogsServiceRequest { repeated ResourceLogs resource_logs = 1; }
message ExportLogsServiceResponse {}
`;

const root = protobuf.parse(PROTO).root;
export const LogsRequest = root.lookupType('ExportLogsServiceRequest');

export function decodeLogsProtobuf(buffer) {
  const msg = LogsRequest.decode(buffer);
  return LogsRequest.toObject(msg, { longs: String, oneofs: true });
}

function anyValue(v) {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.arrayValue) return (v.arrayValue.values || []).map(anyValue);
  if (v.kvlistValue) return attrMap(v.kvlistValue.values);
  return undefined;
}

function attrMap(list) {
  const out = {};
  for (const kv of list || []) out[kv.key] = anyValue(kv.value);
  return out;
}

const hash = (len, ...parts) => crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, len);
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const int = (v) => Math.round(num(v));

function eventTimeMs(record, attrs) {
  const iso = Date.parse(attrs['event.timestamp']);
  if (!Number.isNaN(iso)) return iso;
  const nanos = record.timeUnixNano || record.observedTimeUnixNano;
  const ms = nanos ? Number(BigInt(nanos) / 1_000_000n) : 0;
  return ms > 0 ? ms : Date.now();
}

const eventName = (record, attrs) =>
  String(attrs['event.name'] || (record.body && record.body.stringValue) || '').replace(/^claude_code\./, '');

/**
 * Converts an OTLP logs export (the JSON shape; decoded protobuf is normalised to it)
 * into plugin-style spans: api_request -> llm, tool_result -> tool, and session/turn
 * spans derived from the events' session.id / prompt.id. Span ids are deterministic,
 * so a re-delivered export upserts instead of duplicating.
 */
export function logsToSpans(payload) {
  const sessions = new Map();
  const turns = new Map();
  const leaves = [];

  for (const rl of payload.resourceLogs || []) {
    const resource = attrMap(rl.resource && rl.resource.attributes);
    for (const sl of rl.scopeLogs || []) {
      for (const record of sl.logRecords || []) {
        const attrs = attrMap(record.attributes);
        const name = eventName(record, attrs);
        const sid = attrs['session.id'];
        if (!name || !sid) continue;

        const ts = eventTimeMs(record, attrs);
        const project = attrs.project || resource.project || 'unknown';
        const user = attrs['user.email'] || attrs['user.id'] || resource['user.id'] || null;
        const environment = resource['deployment.environment'] || 'otlp';
        const promptId = attrs['prompt.id'] || null;

        const known = ['api_request', 'tool_result', 'user_prompt'].includes(name);
        if (!known) continue;

        const duration = int(attrs.duration_ms);
        const start = name === 'user_prompt' ? ts : ts - duration;
        const s = sessions.get(sid) || { min: start, max: ts, project, user, environment };
        s.min = Math.min(s.min, start);
        s.max = Math.max(s.max, ts);
        sessions.set(sid, s);

        if (promptId) {
          const key = `${sid}|${promptId}`;
          const t = turns.get(key) || { sid, promptId, min: start, max: ts, prompt: null };
          t.min = Math.min(t.min, start);
          t.max = Math.max(t.max, ts);
          if (name === 'user_prompt' && attrs.prompt) t.prompt = String(attrs.prompt).slice(0, 500);
          turns.set(key, t);
        }

        const parent = promptId ? hash(16, sid, 'turn', promptId) : hash(16, sid, 'session');
        const common = {
          trace_id: hash(32, sid),
          parent_span_id: parent,
          session_id: sid,
          project,
          user,
          environment,
        };

        if (name === 'api_request') {
          const model = attrs.model || 'unknown';
          leaves.push({
            ...common,
            span_id: hash(16, sid, 'api', ts, model, attrs.input_tokens, attrs.output_tokens, attrs.duration_ms),
            op: 'llm',
            name: model,
            status: 'ok',
            model,
            start_ts: start,
            end_ts: ts,
            input_tokens: int(attrs.input_tokens),
            output_tokens: int(attrs.output_tokens),
            cache_read_tokens: int(attrs.cache_read_tokens),
            cache_write_tokens: int(attrs.cache_creation_tokens),
            ...(attrs.cost_usd !== undefined ? { cost_usd: num(attrs.cost_usd) } : {}),
            attributes: { cost_source: attrs.cost_usd !== undefined ? 'reported' : 'computed', source: 'otlp' },
          });
        } else if (name === 'tool_result') {
          const tool = attrs.tool_name || 'unknown';
          const ok = String(attrs.success) !== 'false';
          leaves.push({
            ...common,
            span_id: hash(16, sid, 'tool', ts, tool, attrs.duration_ms),
            op: 'tool',
            name: tool,
            status: ok ? 'ok' : 'error',
            start_ts: start,
            end_ts: ts,
            attributes: { tool_name: tool, source: 'otlp', ...(ok || !attrs.error ? {} : { error: String(attrs.error).slice(0, 500) }) },
          });
        }
      }
    }
  }

  const spans = [];
  for (const [sid, s] of sessions) {
    spans.push({
      trace_id: hash(32, sid),
      span_id: hash(16, sid, 'session'),
      parent_span_id: null,
      session_id: sid,
      op: 'session',
      name: `session ${s.project}`,
      status: 'running',
      project: s.project,
      user: s.user,
      environment: s.environment,
      start_ts: s.min,
      end_ts: s.max,
      attributes: { source: 'otlp' },
    });
  }
  for (const t of turns.values()) {
    const s = sessions.get(t.sid);
    spans.push({
      trace_id: hash(32, t.sid),
      span_id: hash(16, t.sid, 'turn', t.promptId),
      parent_span_id: hash(16, t.sid, 'session'),
      session_id: t.sid,
      op: 'turn',
      name: `turn ${String(t.promptId).slice(0, 8)}`,
      status: 'ok',
      project: s.project,
      user: s.user,
      environment: s.environment,
      start_ts: t.min,
      end_ts: t.max,
      attributes: { source: 'otlp', ...(t.prompt ? { prompt: t.prompt } : {}) },
    });
  }
  return [...spans, ...leaves];
}
