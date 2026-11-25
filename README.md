# claude-monitor

Self-hosted observability and cost monitoring for Claude Code, in the spirit of Sentry's AI agent monitoring.

| Workspace | What it is |
|---|---|
| [`packages/claude-plugin`](packages/claude-plugin) | Claude Code plugin. Hooks record sessions, turns, LLM calls (exact tokens from the transcript) and tool runs as spans and ship them asynchronously. Zero dependencies. |
| [`packages/platform`](packages/platform) | Express ingest API, cost engine, SQLite store (`better-sqlite3`) and a React dashboard (Vite). |

## Quick start

```bash
npm install
npm run build                       # builds the dashboard
API_KEY=dev-key npm start           # http://localhost:4318
```

Install the plugin in Claude Code:

```text
/plugin marketplace add /absolute/path/to/claude-monitor
/plugin install claude-code-telemetry-monitor@claude-monitor
/reload-plugins
/claude-code-telemetry-monitor:setup
```

Docker: `cp .env.example .env && docker compose up -d`.

Development: `npm run dev:server` and `npm run dev:dashboard` (Vite on :5173, proxies `/api`). Tests: `npm test`.

## Data model

One `spans` table, upserted by `span_id` (re-sending is safe):

`session` → `turn` → `llm` | `tool`, all sharing a `trace_id` per session. Token counts and cost live only on `llm` spans, so sums never double count.

## Ingest API

`POST /api/ingest` with header `x-api-key: $API_KEY`, body `{ "spans": [ ... ] }` (max 1000). Per-span validation errors come back as `{ accepted, rejected: [{ index, error }] }`; a batch with no valid span returns 400 so clients drop instead of retry. Span fields: `trace_id`, `span_id`, `parent_span_id`, `session_id`, `op`, `name`, `status` (`ok|error|running|cancelled`), `start_ts`/`end_ts` (epoch ms), `project`, `user`, `environment`, `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cache_write_1h_tokens`, `attributes`.

Read endpoints (guarded by `DASHBOARD_KEY` when set): `/api/overview`, `/api/sessions`, `/api/sessions/:id`, `/api/projects`, all accepting `from`, `to` (epoch ms) and `project`. `/api/health` is open.

## Cost engine

Cost is computed at ingest from token counts using `packages/platform/server/pricing.json` (USD per million tokens; cache read 0.1x, cache write 1.25x for 5m and 2x for 1h unless overridden per model). **Check the prices against Anthropic's current pricing for your models.** Models without an entry are stored at $0 and flagged "unpriced" in the dashboard. After editing prices run `npm run recost -w claude-monitor-platform` to recompute history.

## Security notes

- Set `API_KEY` and `DASHBOARD_KEY` for any shared deployment, and put the server behind TLS (the keys travel in headers).
- The plugin sends metadata only by default; see its README for the opt-in content capture and redaction limits.
- No rate limiting is built in; use your reverse proxy for that.

## OTLP receiver (no plugin or hooks needed)

The platform also accepts Claude Code's built-in OpenTelemetry export, which works where hooks are blocked by policy (`allowManagedHooksOnly`).

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf      # or http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=<API_KEY>"
export OTEL_RESOURCE_ATTRIBUTES="project=my-repo"     # optional; shows in the Projects table
```

`POST /v1/logs` is converted to spans: `api_request` events become LLM spans (tokens, model, latency and the cost Claude Code reports, so models missing from `pricing.json` are still costed), `tool_result` events become tool spans, and sessions/turns are derived from `session.id` / `prompt.id`. `/v1/metrics` and `/v1/traces` are acknowledged and ignored, since the log events already carry the same numbers. Gzip bodies are supported.

Limits compared with the plugin: no content capture beyond what Claude Code itself logs, project is `unknown` unless set via `OTEL_RESOURCE_ATTRIBUTES`, and the user is `user.email` or `user.id` from the events. Do not run both the plugin and OTLP for the same sessions: they use different span ids, so usage would be counted twice.
# claude-monitor
# claude-monitor

## Local transcripts (no hooks, no OTLP)

`IMPORT_TRANSCRIPTS=1` makes the server import your local Claude Code transcripts (`~/.claude/projects/**/*.jsonl`) every time the dashboard requests data, so refreshing the page shows new sessions. Only changed files are re-read, and requests within ~1.5s share one pass.

```bash
IMPORT_TRANSCRIPTS=1 API_KEY=dev-key npm start     # TRANSCRIPT_DIR and TRANSCRIPT_DAYS (default 30) are optional
```

Cost is the per-model session total Claude Code records in each transcript, split across that model's calls; calls from sessions with no recorded total are $0 until the model has an entry in `pricing.json`. This only works when the server runs on the same machine as the transcripts. `scripts/import-transcripts.js` does the same over HTTP for a remote server.
