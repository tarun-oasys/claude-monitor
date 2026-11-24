import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { computeCost, loadPricing } from '../server/cost.js';
import { openDb } from '../server/db.js';

const pricing = loadPricing();
const NOW = Date.now();

test('cost: input/output/cache tiers priced per million tokens', () => {
  const { cost, priced } = computeCost(pricing, {
    model: 'claude-sonnet-4-5-20250929',
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_tokens: 1_000_000,
    cache_write_tokens: 2_000_000,
    cache_write_1h_tokens: 1_000_000,
  });
  // 3 + 15 + 0.3 + (1M * 3.75) + (1M * 6) = 28.05
  assert.equal(priced, true);
  assert.ok(Math.abs(cost - 28.05) < 1e-9);
});

test('cost: longest model match wins and unknown models are unpriced', () => {
  const opus45 = computeCost(pricing, { model: 'claude-opus-4-5-x', input_tokens: 1_000_000 });
  const opus41 = computeCost(pricing, { model: 'claude-opus-4-1-x', input_tokens: 1_000_000 });
  assert.equal(opus45.cost, 5);
  assert.equal(opus41.cost, 15);
  assert.deepEqual(computeCost(pricing, { model: 'mystery-model', input_tokens: 10 }), { cost: 0, priced: false });
});

async function withServer(opts, fn) {
  const db = openDb(':memory:');
  const app = createApp({ db, pricing, ...opts });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, db);
  } finally {
    server.close();
    db.close();
  }
}

const post = (base, body, headers = {}) =>
  fetch(`${base}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const base = { trace_id: 't1', session_id: 'sess-1', project: 'demo', user: 'u' };
const spans = () => [
  { ...base, span_id: 'a1', op: 'session', name: 'session demo', status: 'running', start_ts: NOW - 5000 },
  { ...base, span_id: 'b1', parent_span_id: 'a1', op: 'turn', name: 'turn 1', status: 'ok', start_ts: NOW - 4000, end_ts: NOW - 1000 },
  {
    ...base, span_id: 'c1', parent_span_id: 'b1', op: 'llm', name: 'claude-opus-4-5', model: 'claude-opus-4-5',
    start_ts: NOW - 3500, end_ts: NOW - 3000, input_tokens: 1000, output_tokens: 2000,
  },
  { ...base, span_id: 'c2', parent_span_id: 'b1', op: 'llm', name: 'new-model', model: 'new-model', start_ts: NOW - 2500, end_ts: NOW - 2000, output_tokens: 10 },
  { ...base, span_id: 'd1', parent_span_id: 'b1', op: 'tool', name: 'Bash', status: 'ok', start_ts: NOW - 2900, end_ts: NOW - 2800 },
  { ...base, span_id: 'd2', parent_span_id: 'b1', op: 'tool', name: 'Bash', status: 'error', start_ts: NOW - 2700, end_ts: NOW - 2600 },
];

test('ingest is idempotent and aggregates correctly', async () => {
  await withServer({}, async (url) => {
    for (let i = 0; i < 2; i++) {
      const res = await post(url, { spans: spans() });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { accepted: 6, rejected: [] });
    }
    const ov = await (await fetch(`${url}/api/overview`)).json();
    assert.equal(ov.totals.llm_calls, 2);
    assert.equal(ov.totals.tool_calls, 2);
    assert.equal(ov.totals.tool_errors, 1);
    assert.equal(ov.totals.sessions, 1);
    // 1000*5/1M + 2000*25/1M = 0.055
    assert.ok(Math.abs(ov.totals.cost_usd - 0.055) < 1e-9);
    assert.equal(ov.models.find((m) => m.model === 'new-model').priced, false);
    assert.equal(ov.tools[0].name, 'Bash');
  });
});

test('upsert closes a running session without losing its start', async () => {
  await withServer({}, async (url) => {
    await post(url, { spans: spans() });
    await post(url, { spans: [{ ...base, span_id: 'a1', op: 'session', name: 's', status: 'ok', start_ts: NOW - 5000, end_ts: NOW }] });
    const detail = await (await fetch(`${url}/api/sessions/sess-1`)).json();
    assert.equal(detail.session.status, 'ok');
    assert.equal(detail.session.duration_ms, 5000);
    assert.equal(detail.totals.tool_errors, 1);
    const list = await (await fetch(`${url}/api/sessions`)).json();
    assert.equal(list.total, 1);
    assert.equal(list.sessions[0].llm_calls, 2);
  });
});

test('validation rejects bad spans per-item and fully-bad batches with 400', async () => {
  await withServer({}, async (url) => {
    const mixed = await post(url, { spans: [spans()[0], { ...base, span_id: 'x', op: 'bogus', start_ts: NOW }] });
    const body = await mixed.json();
    assert.equal(mixed.status, 200);
    assert.equal(body.accepted, 1);
    assert.equal(body.rejected[0].index, 1);

    const bad = await post(url, { spans: [{ ...base, span_id: 'y', op: 'turn', start_ts: NOW, input_tokens: 5 }] });
    assert.equal(bad.status, 400);
    assert.equal((await post(url, { nope: 1 })).status, 400);
    assert.equal((await post(url, { spans: new Array(1001).fill({}) })).status, 413);
  });
});

test('api keys gate ingest and dashboard routes independently', async () => {
  await withServer({ ingestKey: 'ik', dashboardKey: 'dk' }, async (url) => {
    assert.equal((await post(url, { spans: [] })).status, 401);
    assert.equal((await post(url, { spans: [] }, { 'x-api-key': 'ik' })).status, 200);
    assert.equal((await fetch(`${url}/api/ingest/check`, { headers: { 'x-api-key': 'ik' } })).status, 200);
    assert.equal((await fetch(`${url}/api/overview`)).status, 401);
    assert.equal((await fetch(`${url}/api/overview`, { headers: { authorization: 'Bearer dk' } })).status, 200);
    assert.equal((await fetch(`${url}/api/health`)).status, 200);
  });
});
