import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { loadPricing } from '../server/cost.js';
import { openDb } from '../server/db.js';

const line = (o) => JSON.stringify(o) + '\n';
const iso = (offset) => new Date(Date.now() - offset).toISOString();
const base = { sessionId: 'tr-1', cwd: '/work/demo-repo' };

const prompt = (offset, text) => line({ ...base, type: 'user', uuid: `u${offset}`, promptId: `p${offset}`, timestamp: iso(offset), message: { role: 'user', content: text } });
const reply = (offset, id) =>
  line({
    ...base, type: 'assistant', uuid: `a${id}`, timestamp: iso(offset),
    message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000 }, content: [{ type: 'tool_use', id: `t${id}`, name: 'Bash' }] },
  });
const result = (offset, id, isError) =>
  line({ ...base, type: 'user', uuid: `r${id}`, timestamp: iso(offset), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${id}`, is_error: isError }] } });
const cost = (usd) => line({ ...base, type: 'cost-state', modelUsage: { 'claude-sonnet-5-5': { costUSD: usd } } });

test('dashboard requests import new and changed local transcripts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-tr-'));
  const proj = path.join(dir, '-work-demo-repo');
  fs.mkdirSync(proj);
  const file = path.join(proj, 'tr-1.jsonl');
  fs.writeFileSync(file, prompt(5000, 'hello') + reply(4000, 'm1') + result(3500, 'm1', false) + cost(0.5));

  const db = openDb(':memory:');
  const server = createApp({ db, pricing: loadPricing(), transcriptDir: dir }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const overview = async () => (await fetch(`${url}/api/overview`)).json();

  try {
    let ov = await overview();
    assert.equal(ov.totals.sessions, 1);
    assert.equal(ov.totals.turns, 1);
    assert.equal(ov.totals.llm_calls, 1);
    assert.equal(ov.totals.tool_calls, 1);
    assert.equal(ov.totals.cost_usd, 0.5, 'reported session cost is used for a model with no pricing entry');
    assert.equal(ov.projects[0].project, 'demo-repo');

    // A second session file appears and the first one grows; wait out the 1.5s throttle.
    fs.writeFileSync(path.join(proj, 'tr-2.jsonl'), prompt(2000, 'again').replaceAll('tr-1', 'tr-2'));
    fs.appendFileSync(file, prompt(1000, 'more') + reply(900, 'm2') + result(800, 'm2', true) + cost(1.5));
    await new Promise((r) => setTimeout(r, 1700));

    ov = await overview();
    assert.equal(ov.totals.sessions, 2);
    assert.equal(ov.totals.turns, 3);
    assert.equal(ov.totals.llm_calls, 2);
    assert.equal(ov.totals.tool_errors, 1);
    assert.ok(Math.abs(ov.totals.cost_usd - 1.5) < 1e-9, 'latest cost-state total replaces the earlier one');
  } finally {
    server.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
