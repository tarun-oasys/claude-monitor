import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createApp } from '../server/app.js';
import { loadPricing } from '../server/cost.js';
import { openDb } from '../server/db.js';
import { LogsRequest } from '../server/otlp.js';

const str = (key, v) => ({ key, value: { stringValue: String(v) } });
const NOW = Date.now();

const event = (name, attrs, offsetMs) => ({
  timeUnixNano: String(BigInt(NOW + offsetMs) * 1_000_000n),
  body: { stringValue: `claude_code.${name}` },
  attributes: [str('event.name', name), str('session.id', 'otel-s1'), str('prompt.id', 'p-1'), str('user.id', 'u1'), ...attrs],
});

const payload = () => ({
  resourceLogs: [
    {
      resource: { attributes: [str('project', 'demo')] },
      scopeLogs: [
        {
          logRecords: [
            event('user_prompt', [str('prompt_length', 5)], -5000),
            event('api_request', [
              str('model', 'claude-fable-5-1'), str('cost_usd', '0.0421'), str('duration_ms', 1500),
              str('input_tokens', 100), str('output_tokens', 300), str('cache_read_tokens', 4000), str('cache_creation_tokens', 200),
            ], -3000),
            event('tool_result', [str('tool_name', 'Bash'), str('success', 'true'), str('duration_ms', 200)], -2500),
            event('tool_result', [str('tool_name', 'Read'), str('success', 'false'), str('duration_ms', 50)], -2000),
          ],
        },
      ],
    },
  ],
});

async function withServer(fn) {
  const db = openDb(':memory:');
  const server = createApp({ db, pricing: loadPricing(), ingestKey: 'k' }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    db.close();
  }
}

async function checkIngested(url) {
  const ov = await (await fetch(`${url}/api/overview`)).json();
  assert.equal(ov.totals.llm_calls, 1);
  assert.equal(ov.totals.cost_usd, 0.0421, 'reported cost is used even for a model with no pricing entry');
  assert.equal(ov.totals.cache_read_tokens, 4000);
  assert.equal(ov.totals.cache_write_tokens, 200);
  assert.equal(ov.totals.tool_calls, 2);
  assert.equal(ov.totals.tool_errors, 1);
  assert.equal(ov.totals.sessions, 1);
  assert.equal(ov.totals.turns, 1);
  assert.equal(ov.models[0].priced, true);
  assert.equal(ov.projects[0].project, 'demo');
}

test('OTLP JSON logs become session/turn/llm/tool spans', async () => {
  await withServer(async (url) => {
    const res = await fetch(`${url}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify(payload()),
    });
    assert.equal(res.status, 200);
    await checkIngested(url);
    const detail = await (await fetch(`${url}/api/sessions/otel-s1`)).json();
    const turn = detail.spans.find((s) => s.op === 'turn');
    assert.ok(detail.spans.filter((s) => s.op !== 'session' && s.op !== 'turn').every((s) => s.parent_span_id === turn.span_id));
  });
});

test('OTLP protobuf (gzip) is decoded and re-delivery is idempotent', async () => {
  await withServer(async (url) => {
    const body = zlib.gzipSync(Buffer.from(LogsRequest.encode(LogsRequest.fromObject(payload())).finish()));
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${url}/v1/logs`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-protobuf', 'content-encoding': 'gzip', 'x-api-key': 'k' },
        body,
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/x-protobuf');
    }
    await checkIngested(url);
  });
});

test('OTLP endpoints require the key and metrics are acknowledged', async () => {
  await withServer(async (url) => {
    const noKey = await fetch(`${url}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noKey.status, 401);
    const metrics = await fetch(`${url}/v1/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: '{"resourceMetrics":[]}',
    });
    assert.equal(metrics.status, 200);
    const garbage = await fetch(`${url}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf', 'x-api-key': 'k' },
      body: Buffer.from([0xff, 0xff, 0xff]),
    });
    assert.equal(garbage.status, 400);
  });
});
