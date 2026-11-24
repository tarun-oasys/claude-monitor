'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cctm-test-'));
process.env.CLAUDE_TELEMETRY_DIR = tmp;
process.env.CLAUDE_TELEMETRY_CONFIG = path.join(tmp, 'none.json');
process.env.CLAUDE_TELEMETRY_ENDPOINT = 'http://127.0.0.1:1/api/ingest';

const { parseTranscript } = require('../src/transcript-parser');
const { redact } = require('../src/hook-handler');

const HANDLER = path.join(__dirname, '..', 'src', 'hook-handler.js');

function fire(event, payload) {
  const r = spawnSync(process.execPath, [HANDLER], {
    input: JSON.stringify({ hook_event_name: event, session_id: 's1', cwd: '/work/demo', ...payload }),
    env: process.env,
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.length, 0, 'hook must not write to stdout');
}

function spooledSpans() {
  const dir = path.join(tmp, 'spool');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .flatMap((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
}

const line = (o) => JSON.stringify(o) + '\n';

test('transcript parser merges streamed chunks and reads cache usage', () => {
  const file = path.join(tmp, 't.jsonl');
  fs.writeFileSync(
    file,
    line({ type: 'user', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user' } }) +
      line({
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { id: 'm1', model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 1 }, content: [] },
      }) +
      line({
        type: 'assistant',
        timestamp: '2026-01-01T00:00:03.000Z',
        message: {
          id: 'm1',
          model: 'claude-sonnet-4-5',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use' }],
          usage: {
            input_tokens: 10,
            output_tokens: 42,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 100,
            cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 40 },
          },
        },
      }) +
      line({ type: 'assistant', timestamp: '2026-01-01T00:00:04.000Z', isApiErrorMessage: true, message: { id: 'e', model: '<synthetic>', usage: {} } }) +
      '{"type":"assistant","partial',
  );
  const { messages } = parseTranscript(file, 0);
  assert.strictEqual(messages.length, 1);
  const [m] = messages;
  assert.deepStrictEqual(m.usage, {
    input_tokens: 10,
    output_tokens: 42,
    cache_read_tokens: 500,
    cache_write_tokens: 100,
    cache_write_1h_tokens: 40,
  });
  assert.strictEqual(m.stop_reason, 'tool_use');
  assert.strictEqual(m.end_ts - m.start_ts, 3000);
});

test('transcript parser resumes from endOffset without re-reading', () => {
  const file = path.join(tmp, 't2.jsonl');
  const a = line({ type: 'assistant', timestamp: '2026-01-01T00:00:01.000Z', message: { id: 'a', model: 'x', usage: { output_tokens: 1 } } });
  fs.writeFileSync(file, a);
  const first = parseTranscript(file, 0);
  fs.appendFileSync(file, line({ type: 'assistant', timestamp: '2026-01-01T00:00:02.000Z', message: { id: 'b', model: 'x', usage: { output_tokens: 2 } } }));
  const second = parseTranscript(file, first.endOffset);
  assert.deepStrictEqual(second.messages.map((m) => m.message_id), ['b']);
});

test('redact masks secrets and truncates', () => {
  assert.ok(!redact('curl -H "Authorization: Bearer abc.def.ghi" x').includes('abc.def'));
  assert.ok(!redact('export API_KEY=hunter2hunter2').includes('hunter2'));
  assert.ok(!redact('sk-ant-abcdefghijklmnop').includes('abcdefghijklmnop'));
  assert.ok(redact('x'.repeat(2000)).length <= 501);
});

test('full session lifecycle emits session/turn/tool/llm spans', () => {
  const transcript = path.join(tmp, 'life.jsonl');
  fs.writeFileSync(transcript, '');

  fire('SessionStart', { source: 'startup' });
  fire('UserPromptSubmit', { prompt: 'fix the bug', transcript_path: transcript });
  fs.appendFileSync(
    transcript,
    line({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: { id: 'life1', model: 'claude-opus-4-5', usage: { input_tokens: 5, output_tokens: 7 }, content: [] },
    }),
  );
  fire('PreToolUse', { tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: 'ls' } });
  fire('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: 'ls' }, tool_response: { stdout: 'a' } });
  fire('PreToolUse', { tool_name: 'Read', tool_use_id: 'tu2', tool_input: { file_path: '/x' } });
  fire('PostToolUseFailure', { tool_name: 'Read', tool_use_id: 'tu2', tool_input: { file_path: '/x' }, error: 'ENOENT' });
  fire('Stop', { transcript_path: transcript });
  fire('SessionEnd', { reason: 'other' });

  const spans = spooledSpans();
  const ops = (op) => spans.filter((s) => s.op === op);

  assert.strictEqual(new Set(spans.map((s) => s.trace_id)).size, 1, 'one trace per session');
  assert.strictEqual(ops('llm').length, 1);
  assert.strictEqual(ops('llm')[0].output_tokens, 7);
  assert.strictEqual(ops('llm')[0].model, 'claude-opus-4-5');

  const tools = ops('tool');
  assert.deepStrictEqual(tools.map((t) => [t.name, t.status]).sort(), [['Bash', 'ok'], ['Read', 'error']]);
  assert.ok(!('input' in tools[0].attributes), 'content not captured by default');

  const turnFinal = ops('turn').find((t) => t.status === 'ok');
  assert.ok(turnFinal && turnFinal.end_ts >= turnFinal.start_ts);
  for (const t of tools) assert.strictEqual(t.parent_span_id, turnFinal.span_id);

  const sessionFinal = ops('session').filter((s) => s.status === 'ok');
  assert.strictEqual(sessionFinal.length, 1);
  assert.ok(!fs.existsSync(path.join(tmp, 'state', 's1')), 'state cleaned up on SessionEnd');
});

test('disabled flag suppresses all output', () => {
  const before = spooledSpans().length;
  const r = spawnSync(process.execPath, [HANDLER], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'off', cwd: '/x' }),
    env: { ...process.env, CLAUDE_TELEMETRY_DISABLED: '1' },
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(spooledSpans().length, before);
});

test('invalid stdin exits 0 silently', () => {
  const r = spawnSync(process.execPath, [HANDLER], { input: 'not json', env: process.env });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.length, 0);
});
