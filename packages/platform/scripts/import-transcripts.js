// Imports real Claude Code sessions from local transcripts into a running server over HTTP.
// (The server can also do this itself on every dashboard load: start it with IMPORT_TRANSCRIPTS=1.)
//   API_KEY=dev-key node scripts/import-transcripts.js [--days 30] [--dir ~/.claude/projects] [--url http://localhost:4318] [--watch]
// --watch re-imports every 30s, reading only files that changed. Safe to re-run: the server upserts.
import os from 'node:os';
import path from 'node:path';
import { syncTranscripts } from '../server/transcripts.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const days = Number(opt('days', 30));
const dir = opt('dir', path.join(os.homedir(), '.claude', 'projects'));
const base = opt('url', 'http://localhost:4318');
const state = { seen: new Map() };
let accepted = 0;
let rejected = 0;

const emit = async (spans) => {
  const res = await fetch(`${base}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.API_KEY || '' },
    body: JSON.stringify({ spans }),
  });
  if (res.status === 401) throw new Error('401: set API_KEY to the server ingest key');
  const out = await res.json().catch(() => ({}));
  accepted += out.accepted || 0;
  rejected += (out.rejected || []).length;
  if (!res.ok && !out.rejected) throw new Error(`server returned ${res.status}`);
};

async function pass() {
  accepted = rejected = 0;
  const stats = await syncTranscripts(state, { dir, days, emit });
  console.log(`changed files ${stats.files}, sessions ${stats.sessions}, ${accepted} spans accepted, ${rejected} rejected`);
}

await pass();
if (args.includes('--watch')) {
  console.log('watching every 30s (Ctrl+C to stop)');
  for (;;) {
    await new Promise((r) => setTimeout(r, 30_000));
    try {
      await pass();
    } catch (e) {
      console.warn(`pass failed: ${e.message}`);
    }
  }
}
