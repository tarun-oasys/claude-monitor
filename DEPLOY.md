# Deploying claude-monitor

Sized for a handful of users on one small VM (1 vCPU / 1 GB RAM is plenty). SQLite stores everything in a Docker volume.

## 1. Get a VM and a hostname
- Any Linux VM with Docker (AWS Lightsail/EC2, DigitalOcean, Hetzner, ...). Open ports 80 and 443.
- Create a DNS **A record** (e.g. `monitor.yourdomain.com`) pointing to the VM's public IP. Caddy needs this to get a free HTTPS certificate.

## 2. Configure and start
```bash
git clone <your-repo-url> claude-monitor && cd claude-monitor
cp .env.example .env
```
Edit `.env`: set `DOMAIN`, a long random `API_KEY` (`openssl rand -hex 24`) and a different `DASHBOARD_KEY`. Then:
```bash
docker compose up -d --build
curl https://$DOMAIN/api/health     # {"status":"ok"}
```
Open `https://<DOMAIN>`; the dashboard asks for the dashboard key.

## 3. Connect each tester
Give testers the URL and `API_KEY`. Two ways to send data:

**Plugin** (live; needs hooks to be allowed on their machine):
```text
/plugin marketplace add <your-repo-url>
/plugin install claude-code-telemetry-monitor@claude-monitor
/claude-code-telemetry-monitor:setup
```

**Transcript import** (works even where hooks are blocked; sends metadata from the user's own local transcripts, never prompt text). Needs Node 18+ and a clone of the repo:
```bash
npm install
API_KEY=<key> node packages/platform/scripts/import-transcripts.js --url https://<DOMAIN> --watch
```

## Operating it
- **Update:** `git pull && docker compose up -d --build`
- **Logs:** `docker compose logs -f monitor`
- **Back up:** `docker run --rm -v claude-monitor_monitor-data:/data -v $PWD:/out busybox cp /data/monitor.db /out/monitor-backup.db`
- **Limit disk growth:** set `RETENTION_DAYS=90` in `.env`.
- **Prices:** add models to `packages/platform/server/pricing.json`, rebuild, then `docker compose exec monitor node packages/platform/scripts/recost.js`.

## Growing beyond a handful of users
SQLite handles one server process. Before opening this to many people, plan: per-user API keys instead of one shared key, a Postgres backend so several server copies can run, and rate limiting at the proxy. None of that is built yet.
