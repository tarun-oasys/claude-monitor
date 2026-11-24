# claude-code-telemetry-monitor

Claude Code plugin that records every session, conversation turn, LLM call (exact token usage and model) and tool execution as spans, and streams them to the self-hosted platform in `packages/platform`.

Zero npm dependencies. Node.js 18+ only (`fs`, `http/https`, `crypto`, `child_process`).

## Install

From inside Claude Code:

```text
/plugin marketplace add /absolute/path/to/claude-monitor
/plugin install claude-code-telemetry-monitor@claude-monitor
/reload-plugins
```

The marketplace manifest lives at the repo root (`.claude-plugin/marketplace.json`). If you host the repo on GitLab/GitHub, use `/plugin marketplace add <git-url>` instead.

Then configure the endpoint:

```text
/claude-code-telemetry-monitor:setup
```

or set environment variables / write `~/.claude-telemetry/config.json`:

```json
{
  "endpoint": "http://localhost:4318/api/ingest",
  "apiKey": "change-me",
  "captureContent": false,
  "environment": "default"
}
```

| Env var | Meaning | Default |
|---|---|---|
| `CLAUDE_TELEMETRY_ENDPOINT` | Ingest URL | `http://localhost:4318/api/ingest` |
| `CLAUDE_TELEMETRY_API_KEY` | Sent as `x-api-key` | none |
| `CLAUDE_TELEMETRY_CAPTURE_CONTENT` | Also send redacted, truncated prompts / tool inputs / errors | `false` |
| `CLAUDE_TELEMETRY_USER` | User label | OS username |
| `CLAUDE_TELEMETRY_ENV` | Environment label | `default` |
| `CLAUDE_TELEMETRY_DISABLED` | `1` turns everything off | `false` |
| `CLAUDE_TELEMETRY_DIR` | State and spool directory | `$TMPDIR/claude-telemetry` |

## How it works

```text
Claude Code ──hook JSON on stdin──▶ hook-handler.js  (fast: local files only, exits 0)
                                         │ writes spans to spool/*.json
                                         └─ spawns detached ─▶ worker.js ──HTTP batch──▶ platform /api/ingest
```

- `hooks/hooks.json` registers `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStop`, `Stop`, `SessionEnd`.
- `src/state-manager.js` keeps span ids and start times on disk (one directory per session, one file per in-flight tool so parallel tool hooks do not race).
- `src/transcript-parser.js` reads the session transcript JSONL on `Stop` / `SubagentStop` to get exact per-response token usage (input, output, cache read, cache write 5m/1h) and model. Streamed duplicates are merged by message id.
- `src/worker.js` batches up to 100 spans per request, retries transient failures with exponential backoff, and leaves undelivered files in the spool for the next worker (offline fallback). The spool is capped at 1000 files / 24 h. Failures are logged to `<spool root>/worker.log`.

Span tree per session: `session` → `turn` → (`llm`, `tool`). Span ids for LLM and tool spans are deterministic, so re-sending is idempotent (the platform upserts by `span_id`).

## Privacy

Default sends metadata only: tool names, input/output byte sizes, durations, statuses, token counts, model, project directory *basename*, username. Prompt text, tool inputs and file paths are sent only with `captureContent=true`, and then truncated to 500 chars with common secret patterns (API keys, bearer tokens, `password=...`) masked. Redaction is best effort; do not enable content capture for sensitive repos.

## Troubleshooting

- Nothing arrives: `cat $TMPDIR/claude-telemetry/worker.log`, and `ls $TMPDIR/claude-telemetry/spool` (files there = not yet delivered).
- Check the key and URL: `curl -H "x-api-key: $KEY" <URL>/api/ingest/check`.
- Tests: `npm test` (from this directory).
