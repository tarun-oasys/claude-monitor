import { computeCost } from './cost.js';

const OPS = new Set(['session', 'turn', 'llm', 'tool']);
const STATUSES = new Set(['ok', 'error', 'running', 'cancelled']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ATTR_BYTES = 8192;
const MAX_STR = 256;
const TOKEN_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'cache_write_1h_tokens',
];

export const MAX_BATCH = 1000;

const str = (v) => (typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_STR) : null);
const isTs = (v) => Number.isFinite(v) && v > 0 && v < 4_102_444_800_000;

/**
 * Validates one span from the plugin and converts it to a DB row. Cost is
 * computed here from token counts so prices can be changed centrally.
 *
 * @returns {{ row: object } | { error: string }}
 */
export function normalizeSpan(span, pricing, now = Date.now()) {
  if (!span || typeof span !== 'object' || Array.isArray(span)) return { error: 'span must be an object' };
  if (!ID_RE.test(span.span_id || '')) return { error: 'invalid span_id' };
  if (!ID_RE.test(span.trace_id || '')) return { error: 'invalid trace_id' };
  if (span.parent_span_id != null && !ID_RE.test(span.parent_span_id)) return { error: 'invalid parent_span_id' };
  if (!str(span.session_id)) return { error: 'session_id required' };
  if (!OPS.has(span.op)) return { error: `invalid op: ${span.op}` };
  if (!isTs(span.start_ts)) return { error: 'invalid start_ts' };
  if (span.end_ts != null && !isTs(span.end_ts)) return { error: 'invalid end_ts' };

  const status = span.status ?? 'ok';
  if (!STATUSES.has(status)) return { error: `invalid status: ${status}` };

  const tokens = {};
  for (const f of TOKEN_FIELDS) {
    const v = span[f] ?? 0;
    if (!Number.isInteger(v) || v < 0) return { error: `invalid ${f}` };
    tokens[f] = v;
  }
  if (span.op !== 'llm' && TOKEN_FIELDS.some((f) => tokens[f] > 0)) {
    return { error: 'token counts are only allowed on llm spans' };
  }

  let attributes = '{}';
  if (span.attributes != null) {
    if (typeof span.attributes !== 'object' || Array.isArray(span.attributes)) return { error: 'attributes must be an object' };
    attributes = JSON.stringify(span.attributes);
    if (Buffer.byteLength(attributes) > MAX_ATTR_BYTES) return { error: 'attributes too large' };
  }

  const model = str(span.model);
  // A client-reported cost (OTLP api_request events carry one) is authoritative and also
  // covers models that have no entry in pricing.json.
  const reported = span.op === 'llm' && span.cost_usd != null;
  if (reported && !(Number.isFinite(span.cost_usd) && span.cost_usd >= 0)) return { error: 'invalid cost_usd' };
  const { cost, priced } = reported
    ? { cost: span.cost_usd, priced: true }
    : span.op === 'llm'
      ? computeCost(pricing, { model, ...tokens })
      : { cost: 0, priced: true };

  return {
    row: {
      span_id: span.span_id,
      trace_id: span.trace_id,
      parent_span_id: span.parent_span_id ?? null,
      session_id: span.session_id.slice(0, 128),
      op: span.op,
      name: str(span.name) || span.op,
      status,
      start_ts: span.start_ts,
      end_ts: span.end_ts ?? null,
      duration_ms: span.end_ts != null ? Math.max(0, span.end_ts - span.start_ts) : null,
      project: str(span.project),
      user: str(span.user),
      environment: str(span.environment),
      model,
      ...tokens,
      cost_usd: cost,
      priced: priced ? 1 : 0,
      attributes,
      received_at: now,
    },
  };
}

export function ingestSpans(upsert, pricing, spans) {
  const rows = [];
  const rejected = [];
  spans.forEach((span, index) => {
    const result = normalizeSpan(span, pricing);
    if (result.error) rejected.push({ index, error: result.error });
    else rows.push(result.row);
  });
  if (rows.length > 0) upsert(rows);
  return { accepted: rows.length, rejected };
}
