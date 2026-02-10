# TinyClaw Production Architecture — Handoff Spec

## Context

TinyClaw is a Telegram forum-based multi-session Claude agent. It consists of two Node.js processes (telegram-client and queue-processor) that communicate via a file-based queue. It's being deployed to a Hetzner Ubuntu server.

This doc covers three things that should be implemented together:

1. **Dockerized deployment** with container isolation
2. **Credential broker** for secure GitHub App authentication
3. **Monitoring dashboard** for observability and debugging

### Current State (what exists now)

- Two Node.js processes: `telegram-client.ts` and `queue-processor.ts`
- File-based queue system in `.tinyclaw/` (JSONL logs, JSON configs, queue directories)
- Smart routing engine (14-dimension scoring → haiku/sonnet/opus model selection)
- Cross-thread messaging via file queue
- **Recently added**: systemd service templates in `systemd/` and PID-based process management in `tinyclaw.sh` — these should be **replaced** by Docker-based process management. The systemd templates (`systemd/tinyclaw-telegram.service`, `systemd/tinyclaw-queue.service`) and the PID tracking in `tinyclaw.sh` were a stepping stone. Replace them with a single systemd unit that runs `docker compose up`, and rewrite `tinyclaw.sh` as a thin wrapper around `docker compose` commands.

---

## 1. Docker Architecture

### Container Layout

```
┌──────────────────────────────────────────────────────────────────┐
│                      Docker bridge network (internal)             │
│                                                                   │
│  ┌────────────────┐  ┌────────────────┐  ┌─────────────────────┐ │
│  │  Broker        │  │  Bot           │  │  Dashboard          │ │
│  │                │  │                │  │                     │ │
│  │  Holds PEM     │  │  telegram-     │  │  Express + SSE      │ │
│  │  Mints GitHub  │◀─│  client.js     │  │  Single HTML page   │ │
│  │  tokens        │  │  queue-        │  │  Reads .tinyclaw/   │─│──▶ Cloudflare Tunnel
│  │                │  │  processor.js  │  │  Reads /host/proc   │ │     (HTTPS + auth)
│  │  :3000         │  │                │  │  :3100              │ │
│  └────────────────┘  └────────────────┘  └─────────────────────┘ │
│         ▲                 │ volume             ▲ volume (ro)      │
│     /secrets/             └──── .tinyclaw/ ────┘                  │
│   (broker only)                (shared)                           │
└──────────────────────────────────────────────────────────────────┘
```

### docker-compose.yml

```yaml
services:
  broker:
    build: ./broker
    environment:
      - GITHUB_APP_ID=${GITHUB_APP_ID}
    volumes:
      - ./secrets/github-app.pem:/secrets/github-app.pem:ro
    networks:
      - internal
    restart: always
    # NOT exposed to host — only reachable from bot container

  bot:
    build: .
    environment:
      - CREDENTIAL_BROKER_URL=http://broker:3000
      - NODE_ENV=production
    volumes:
      - tinyclaw-data:/app/.tinyclaw
    networks:
      - internal
    restart: always
    depends_on:
      - broker

  dashboard:
    build:
      context: .
      dockerfile: Dockerfile.dashboard
    volumes:
      - tinyclaw-data:/app/.tinyclaw:ro
      - /proc:/host/proc:ro
    networks:
      - internal
    ports:
      - "127.0.0.1:3100:3100"  # localhost only — Cloudflare Tunnel connects here
    restart: always
    depends_on:
      - bot

volumes:
  tinyclaw-data:

networks:
  internal:
    driver: bridge
```

### Bot Container Entrypoint

The bot container runs both telegram-client and queue-processor. Use a simple entrypoint script:

```bash
#!/bin/bash
# entrypoint.sh
node dist/telegram-client.js &
TELEGRAM_PID=$!

node dist/queue-processor.js &
QUEUE_PID=$!

# Exit if either process dies
wait -n $TELEGRAM_PID $QUEUE_PID
kill $TELEGRAM_PID $QUEUE_PID 2>/dev/null
exit 1  # Docker restart: always will restart the container
```

### Host-Level systemd

One unit file to manage docker compose:

```ini
# /etc/systemd/system/tinyclaw.service
[Unit]
Description=TinyClaw (Docker Compose)
After=docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=__WORKING_DIR__
ExecStart=/usr/bin/docker compose up
ExecStop=/usr/bin/docker compose down
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### tinyclaw.sh Rewrite

Rewrite `tinyclaw.sh` to wrap docker compose. The key commands:

```
./tinyclaw.sh start    → docker compose up -d
./tinyclaw.sh stop     → docker compose down
./tinyclaw.sh restart  → docker compose restart
./tinyclaw.sh logs     → docker compose logs -f [service]
./tinyclaw.sh status   → docker compose ps + docker stats --no-stream
./tinyclaw.sh install  → install the systemd unit file
./tinyclaw.sh send     → write JSON to .tinyclaw/queue/incoming/ (same as now)
```

---

## 2. Credential Broker

### Purpose

The bot needs to push branches and open PRs across multiple GitHub orgs. It runs as a GitHub App, authenticating with a private key (PEM) to mint short-lived installation tokens. The PEM must never be accessible to the bot process — if the agent is compromised, it can only mint tokens (short-lived, scoped), not exfiltrate the signing key.

### How GitHub App Auth Works

1. App has an **App ID** and **private key** (PEM file)
2. Broker signs a **JWT** using the PEM (valid 10 minutes)
3. Broker exchanges JWT for an **installation access token** (valid 1 hour, scoped to specific repos/permissions)
4. Bot uses the token as a Bearer token against GitHub API

### Broker Implementation

Intentionally minimal. Single file:

```js
// broker/index.js
import express from "express";
import { createAppAuth } from "@octokit/auth-app";
import fs from "fs";

const app = express();
const appId = process.env.GITHUB_APP_ID;
const privateKey = fs.readFileSync("/secrets/github-app.pem", "utf8");

app.get("/token", async (req, res) => {
  const installationId = req.query.installation_id;
  if (!installationId) {
    return res.status(400).json({ error: "installation_id is required" });
  }

  try {
    const auth = createAppAuth({ appId, privateKey });
    const tokenOptions = {
      type: "installation",
      installationId: Number(installationId),
    };

    if (req.query.repositories) {
      tokenOptions.repositoryNames = req.query.repositories.split(",");
    }

    if (req.query.permissions) {
      const perms = {};
      for (const pair of req.query.permissions.split(",")) {
        const [key, value] = pair.split(":");
        perms[key] = value;
      }
      tokenOptions.permissions = perms;
    }

    const { token, expiresAt } = await auth(tokenOptions);
    res.json({ token, expires_at: expiresAt });
  } catch (err) {
    console.error("Token minting failed:", err.message);
    res.status(500).json({ error: "Failed to mint token" });
  }
});

app.listen(3000, () => console.log("Credential broker listening on :3000"));
```

### Bot Usage

```bash
# Get a scoped token
curl "http://broker:3000/token?installation_id=12345&repositories=my-repo&permissions=contents:write,pull_requests:write"
# → { "token": "ghs_xxxx", "expires_at": "2026-02-10T19:00:00Z" }

# Use it
git clone https://x-access-token:${TOKEN}@github.com/org/repo.git
GH_TOKEN=${TOKEN} gh pr create --title "..." --body "..."
```

### Security Notes

- PEM only lives in broker container. Bot has no volume mount to it.
- Tokens expire after 1 hour, scoped to specific repos/permissions.
- Broker only listens on Docker bridge network — not exposed to internet.
- **Branch protection is still the primary safety net.** Require PR reviews from humans on main. Don't grant the App `administration` permission.

### Setup Checklist

1. Create GitHub App (permissions: Contents R/W, Pull Requests R/W, Issues R/W, Metadata RO — never Administration)
2. Install the App into your org(s)
3. Download PEM to `./secrets/github-app.pem`
4. Set `GITHUB_APP_ID` in `.env`
5. `docker compose up`
6. Set up branch protection on all repos the bot touches

---

## 3. Monitoring Dashboard

### What to Build

A lightweight web dashboard for monitoring and debugging TinyClaw in production. Dev tools panel, not a marketing page. Prioritize utility and raw detail over polish.

### Tech Stack

- **Server**: Single Express or Fastify app in TypeScript (`src/dashboard.ts`)
- **Frontend**: Single HTML file with inline CSS/JS. No build step, no React, no framework. Vanilla JS + `fetch` + `EventSource` for streaming.
- **Runs in its own Docker container** with read-only access to `.tinyclaw/` volume and `/host/proc`

### Security

- Dashboard binds to `localhost:3100` only — never exposed directly
- **Cloudflare Tunnel**: zero open ports, HTTPS handled by Cloudflare, access controlled via Cloudflare Access (email OTP or GitHub SSO). No certs to manage.
- Install `cloudflared` on host, create tunnel, point `tinyclaw.yourdomain.com` → `localhost:3100`
- Add Cloudflare Access policy: email allowlist or GitHub SSO

### Pages / Views

#### 1. Overview (default)

Real-time status at a glance:

- **Host metrics**: CPU usage, RAM usage/total, disk usage, load average, uptime — read from `/host/proc/stat`, `/host/proc/meminfo`, `/host/proc/loadavg` (these are the **host** metrics, not container metrics, because we mount the host's `/proc` read-only)
- **Container health**: are bot, broker, dashboard containers running? (check via Docker socket or just process health endpoints)
- **Queue depth**: count of files in `incoming/`, `processing/`, `outgoing/`
- **Active threads**: list from `.tinyclaw/threads.json` — name, model, last active, session status
- **Message rate**: messages processed in last 1h/24h (count from `message-history.jsonl`)

#### 2. Live Feed

Server-Sent Events (SSE) stream of activity:

- Tail `.tinyclaw/message-history.jsonl` via `fs.watch` or polling
- Each entry: timestamp, direction (in/out), threadId, sender, model, message preview (first 200 chars)
- Click to expand full message text
- Color-code by direction and model (haiku/sonnet/opus)

#### 3. Thread Detail

Click a thread from overview:

- Full conversation history (from `message-history.jsonl`, filtered by threadId)
- Thread config: model, cwd, session ID, system prompt
- Chat-bubble style with metadata badges (model, routing tier, timestamp)

#### 4. Routing Inspector

Debugging view for the smart routing engine:

- Tail `.tinyclaw/routing-log.jsonl` — 14-dimension scoring breakdown
- For each message: raw input, routing scores, tier decision, effective model, reply-chain upgrade status
- Sortable/filterable by thread, model tier, time range

#### 5. Prompt Inspector (most important for debugging)

This catches issues like unnecessary prompt inflation (e.g., injecting history into every prompt when it should only happen for new sessions).

**Requires a small queue-processor change**: after assembling the full prompt (~line 381-395), log to `.tinyclaw/logs/prompts.jsonl`:

```json
{
  "timestamp": 1234567890,
  "threadId": 5,
  "messageId": "1234_abc",
  "model": "sonnet",
  "systemPrompt": "...",
  "userMessage": "...",
  "historyInjected": true,
  "historyLines": 5,
  "promptLength": 4523
}
```

Dashboard shows:
- Each prompt expandable with full system prompt and user message
- `promptLength` over time as sparkline/bar — spot prompt bloat
- Highlight `historyInjected: true` entries
- Diff view: compare two prompts side by side (catches drift)

#### 6. System Metrics

Real-time host resource monitoring:

- **RAM**: total, used, available, percentage — parsed from `/host/proc/meminfo`
- **CPU**: per-core usage, overall percentage — parsed from `/host/proc/stat` (diff two readings 1s apart)
- **Load average**: 1m, 5m, 15m — from `/host/proc/loadavg`
- **Disk**: usage of the .tinyclaw volume — `fs.statfs()`
- **Process uptime**: how long each container has been running

Implementation note: these read from `/host/proc/*` (the host's proc filesystem mounted into the container), NOT from `/proc` inside the container. This gives real host metrics. Example:

```typescript
// Read host memory info
const meminfo = fs.readFileSync("/host/proc/meminfo", "utf8");
const totalMatch = meminfo.match(/MemTotal:\s+(\d+)/);
const availMatch = meminfo.match(/MemAvailable:\s+(\d+)/);
const totalMB = parseInt(totalMatch[1]) / 1024;
const availMB = parseInt(availMatch[1]) / 1024;
```

#### 7. Logs

Raw log viewer (journalctl in a browser):

- Toggle between telegram.log, queue.log
- SSE-streamed, auto-scrolling, with pause button
- Text search/filter within the log stream

### API Endpoints

```
GET  /                          → HTML dashboard (single page, client-side routing)
GET  /api/status                → service health, queue depth, thread summary, host metrics
GET  /api/threads               → full threads.json
GET  /api/threads/:id/messages  → message history filtered by thread
GET  /api/messages/feed         → SSE stream of new messages
GET  /api/routing/feed          → SSE stream of routing decisions
GET  /api/routing/recent?n=50   → last N routing decisions
GET  /api/prompts/recent?n=20   → last N assembled prompts
GET  /api/metrics               → current CPU, RAM, disk, load average
GET  /api/logs/:type            → SSE stream of log file (type: telegram|queue)
```

### Data Sources (all read-only)

The dashboard reads these files — it never writes to them:

| File | Format | Contains |
|------|--------|----------|
| `.tinyclaw/threads.json` | JSON | Thread configs, session IDs, models |
| `.tinyclaw/message-history.jsonl` | JSONL | All messages in/out with metadata |
| `.tinyclaw/routing-log.jsonl` | JSONL | 14-dimension routing scores |
| `.tinyclaw/logs/prompts.jsonl` | JSONL | Full assembled prompts (NEW — needs queue-processor change) |
| `.tinyclaw/logs/telegram.log` | Plain text | Telegram client logs |
| `.tinyclaw/logs/queue.log` | Plain text | Queue processor logs |
| `/host/proc/meminfo` | Proc filesystem | Host RAM metrics |
| `/host/proc/stat` | Proc filesystem | Host CPU metrics |
| `/host/proc/loadavg` | Proc filesystem | Host load average |

### Implementation Notes

- Entire frontend: single `dashboard.html` (or `static/dashboard.html`). No npm frontend build.
- Use `fs.watch` or poll every 1-2s for file changes to power SSE streams.
- For JSONL files: track file byte position, only read new lines (don't re-read entire file).
- Read-only. Dashboard never modifies TinyClaw state.
- Prompt inspector requires the queue-processor logging change described above.
- Host metrics come from `/host/proc/*` (mounted read-only from host), not container's own `/proc`.

---

## Files to Change

### Replace

| File | Action | Notes |
|------|--------|-------|
| `systemd/tinyclaw-telegram.service` | Replace | Becomes single `systemd/tinyclaw.service` for docker compose |
| `systemd/tinyclaw-queue.service` | Delete | No longer needed |
| `tinyclaw.sh` | Rewrite | Wrap docker compose commands instead of PID management |

### Add

| File | Purpose |
|------|---------|
| `Dockerfile` | Bot container (telegram-client + queue-processor) |
| `Dockerfile.dashboard` | Dashboard container |
| `docker-compose.yml` | All three services |
| `entrypoint.sh` | Bot container entrypoint (runs both processes) |
| `broker/` | Credential broker (index.js, package.json, Dockerfile) |
| `src/dashboard.ts` | Dashboard server |
| `static/dashboard.html` | Dashboard frontend (single file) |
| `systemd/tinyclaw.service` | Single systemd unit for docker compose |

### Keep As-Is

| File | Notes |
|------|-------|
| `src/telegram-client.ts` | Recently added: 👀 reaction on user messages + persistent typing indicator |
| `src/queue-processor.ts` | Add prompt logging (appendFileSync to prompts.jsonl) |
| `src/router/` | No changes |
| `src/session-manager.ts` | No changes |
| `src/message-history.ts` | No changes |
| `src/mcp-tools.ts` | No changes |

---

## Deployment Sequence

1. Create GitHub App, download PEM, note App ID
2. Build Docker images: `docker compose build`
3. Create `.env` with `GITHUB_APP_ID=...`
4. Place PEM at `./secrets/github-app.pem`
5. `docker compose up -d`
6. Install systemd unit: `./tinyclaw.sh install`
7. Install `cloudflared`, create tunnel → `localhost:3100`
8. Add Cloudflare Access policy (email allowlist or GitHub SSO)
9. Set up GitHub branch protection on all repos
10. Verify: dashboard accessible at `https://tinyclaw.yourdomain.com`
