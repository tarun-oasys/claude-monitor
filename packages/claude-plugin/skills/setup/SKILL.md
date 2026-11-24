---
name: setup
description: Interactive setup wizard for the Claude Code telemetry monitor. Use when the user wants to configure, test or troubleshoot where Claude Code telemetry spans are sent (endpoint, API key, content capture).
disable-model-invocation: true
---

# Telemetry monitor setup

Configure the `claude-code-telemetry-monitor` plugin step by step. Ask one question at a time and wait for the answer.

## 1. Gather settings

Ask the user for:

1. **Platform URL**, e.g. `http://localhost:4318` or `https://claude-monitor.example.com`. The ingest endpoint is `<URL>/api/ingest`.
2. **Ingest API key**, the `API_KEY` configured on the platform server. Empty is allowed only for a local dev server that has no key set.
3. **Capture content?** Default **no**. When off, only metadata is sent (tool names, byte sizes, durations, token counts). When on, truncated and secret-redacted prompts, tool inputs and tool errors are also sent.
4. **Environment label** (optional), e.g. `laptop`, `ci`. Default `default`.

## 2. Check connectivity

Run, substituting the answers (omit the header line if there is no key):

```bash
curl -sS -m 5 -o /dev/null -w "%{http_code}\n" \
  -H "x-api-key: <KEY>" "<URL>/api/ingest/check"
```

- `200`: continue.
- `401`/`403`: the key is wrong, ask again.
- Connection error or other status: tell the user the platform is unreachable and ask whether to save the config anyway. Spans are spooled locally and delivered once it is reachable.

## 3. Write the config

Write `~/.claude-telemetry/config.json` with mode `600` (the key is a secret):

```bash
mkdir -p ~/.claude-telemetry
cat > ~/.claude-telemetry/config.json <<'JSON'
{
  "endpoint": "<URL>/api/ingest",
  "apiKey": "<KEY>",
  "captureContent": false,
  "environment": "default"
}
JSON
chmod 600 ~/.claude-telemetry/config.json
```

If the file already exists, show the user the current values with the key masked and ask before overwriting.

## 4. Finish

Tell the user:

- Config is read on every hook, so no restart is needed. If the plugin was only just installed, run `/reload-plugins`.
- Environment variables override the file: `CLAUDE_TELEMETRY_ENDPOINT`, `CLAUDE_TELEMETRY_API_KEY`, `CLAUDE_TELEMETRY_CAPTURE_CONTENT`, `CLAUDE_TELEMETRY_ENV`, `CLAUDE_TELEMETRY_DISABLED=1` (turns telemetry off).
- Delivery problems are logged to `$TMPDIR/claude-telemetry/worker.log` (`/tmp/claude-telemetry/worker.log` on Linux).
