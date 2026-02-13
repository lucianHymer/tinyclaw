---
title: "Production Architecture: Docker, Credential Broker, Monitoring Dashboard"
type: feat
date: 2026-02-10
---

# Production Architecture: Docker, Credential Broker, Monitoring Dashboard

## Overview

Containerize Borg with a 3-service Docker Compose stack (bot, credential broker, monitoring dashboard), replacing the current bare-metal PID/systemd deployment. The dashboard provides 7 real-time views for observability and debugging. The credential broker isolates GitHub App PEM from the agent process, minting scoped short-lived tokens on demand.

**Source spec**: `docs/dashboard-spec.md`

## Problem Statement

Borg currently runs as two bare-metal Node.js processes managed by PID files and optional systemd units. This creates several production pain points:

1. **No isolation** — agent runs with full host filesystem access and the user's shell environment
2. **No observability** — debugging requires SSH + manual log tailing
3. **No credential isolation** — GitHub App PEM would sit alongside the agent process
4. **Fragile process management** — PID-based tracking with `pkill` fallbacks
5. **No standard deployment workflow** — manual restarts, no health checks, no recovery

## Proposed Solution

Three Docker containers on a bridge network with a shared data volume:

```
┌──────────────────────────────────────────────────────────────────┐
│                      Docker bridge network (internal)             │
│                                                                   │
│  ┌────────────────┐  ┌────────────────┐  ┌─────────────────────┐ │
│  │  Broker        │  │  Bot           │  │  Dashboard          │ │
│  │  :3000         │  │  telegram +    │  │  Express + SSE      │ │
│  │  Mints GitHub  │◀─│  queue-proc    │  │  Single HTML page   │ │
│  │  tokens        │  │                │  │  :3100              │ │
│  └────────────────┘  └────────────────┘  └─────────────────────┘ │
│         ▲                 │ volume             ▲ volume (ro)      │
│     /secrets/             └──── .borg/ ────┘                  │
│   (broker only)                (shared)                           │
└──────────────────────────────────────────────────────────────────┘
                                                    │
                                              Cloudflare Tunnel
                                              (HTTPS + Access)
```

## Technical Approach

### Architecture Decisions

#### AD-1: Agent filesystem access inside Docker

**The single most consequential decision.** The Claude Agent SDK spawns subprocesses that need filesystem access (Read, Write, Edit, Bash tools). Current code hardcodes `cwd` to host paths like `/home/clawcian/.openclaw/workspace`.

**Decision: Bind-mount the workspace root into the bot container.**

```yaml
# docker-compose.yml (bot service)
volumes:
  - borg-data:/app/.borg
  - ${WORKSPACE_ROOT:-/home/clawcian/.openclaw/workspace}:/workspace
```

- Agent's `cwd` defaults to `/workspace` (or `/workspace/borg`)
- Hardcoded paths in `session-manager.ts` replaced with `DEFAULT_CWD` env var
- Trade-off: less isolation, but the agent's purpose IS to read/write code
- `.borg/` stays on a named volume (shared with dashboard)

#### AD-2: Signal propagation in entrypoint

Add `trap` + `exec` pattern so SIGTERM from `docker compose down` reaches both Node processes, triggering their graceful shutdown handlers (saving `threads.json`, stopping the bot).

```bash
#!/bin/bash
trap 'kill $TELEGRAM_PID $QUEUE_PID 2>/dev/null; wait' SIGTERM SIGINT

node dist/telegram-client.js &
TELEGRAM_PID=$!
node dist/queue-processor.js &
QUEUE_PID=$!

wait -n $TELEGRAM_PID $QUEUE_PID
kill $TELEGRAM_PID $QUEUE_PID 2>/dev/null
exit 1
```

#### AD-3: Broker integration via git credential helper (multi-org)

Rather than relying on the agent to `curl` the broker (fragile, depends on system prompt compliance), configure a **git credential helper** script inside the bot container.

**Multi-org support from day one.** The GitHub App is installed on multiple orgs, each with a different installation ID. The helper maps org → installation ID via a JSON config file.

Config file (`secrets/github-installations.json`, mounted into bot container):
```json
{
  "openclaw": "12345",
  "other-org": "67890"
}
```

Credential helper:
```bash
#!/bin/bash
# /usr/local/bin/github-token-helper
# Git credential helper — called by git with protocol/host/path on stdin

# Parse org from git's credential request (stdin: protocol=, host=, path=org/repo)
while IFS='=' read -r key value; do
  case "$key" in
    path) ORG="${value%%/*}" ;;
  esac
done

# Look up installation ID for this org
INSTALL_ID=$(jq -r --arg org "$ORG" '.[$org] // empty' /secrets/github-installations.json)
if [ -z "$INSTALL_ID" ]; then
  exit 1  # No installation for this org — git will prompt or fail
fi

RESULT=$(curl -sf "$CREDENTIAL_BROKER_URL/token?installation_id=$INSTALL_ID")
echo "protocol=https"
echo "host=github.com"
echo "username=x-access-token"
echo "password=$(echo "$RESULT" | jq -r .token)"
```

Configure in bot Dockerfile: `git config --global credential.helper /usr/local/bin/github-token-helper`.

Adding a new org: install the GitHub App on the org, add the installation ID to `secrets/github-installations.json`, restart the bot container.

#### AD-4: Dashboard uses polling, not `fs.watch`

`fs.watch` is unreliable on Docker named volumes (inotify does not propagate across bind mounts consistently). **Default to polling every 2s** with byte-offset tracking. Detect file rotation (size < last offset) and reset.

#### AD-5: Cloudflare Tunnel as Docker service

Add `cloudflared` as a fourth service in docker-compose.yml so it survives reboots without a separate systemd unit.

#### AD-6: Dashboard built with same tsconfig

The dashboard TypeScript source lives in `src/dashboard.ts` and compiles with the existing `tsconfig.json`. The `Dockerfile.dashboard` builds the full project but only runs `dist/dashboard.js`. This keeps the build simple — one `npm run build` produces everything.

### Implementation Phases

#### Phase 1: Foundation — Docker + Bot Container

**Goal**: Bot runs in Docker with the same behavior as bare-metal.

**Tasks**:

- [ ] **Fix hardcoded paths** in `src/session-manager.ts` (lines 63, 215) and `src/queue-processor.ts` (line 368)
  - Replace `/home/clawcian/.openclaw/workspace` with `process.env.DEFAULT_CWD || "/workspace"`
  - Affects: `session-manager.ts`, `queue-processor.ts`
- [ ] **Add startup recovery**: on queue-processor start, move any files from `processing/` back to `incoming/` (recovers from mid-processing crashes)
  - Affects: `src/queue-processor.ts` (startup section, ~line 58-64)
- [ ] **Create `Dockerfile`** (bot container)
  - Base: `node:22-slim`
  - `WORKDIR /app` (critical — `__dirname` resolves to `/app/dist`, `..` gives `/app`, so `.borg/` mounts at `/app/.borg`)
  - Install: `git`, `gh` (GitHub CLI), `curl`, `jq`, `bash`
  - COPY: `package*.json`, `tsconfig.json`, `src/`, `.claude/` (hooks)
  - RUN: `npm ci && npm run build` (needs devDependencies for `tsc`, then prune)
  - No CMD — uses `entrypoint.sh`
- [ ] **Create `entrypoint.sh`** with signal trapping (AD-2)
- [ ] **Create `docker-compose.yml`** with bot service only (broker + dashboard added in later phases)
  - Environment: `ANTHROPIC_API_KEY`, `NODE_ENV=production`, `DEFAULT_CWD=/workspace`, `CREDENTIAL_BROKER_URL`
  - Volumes: `borg-data:/app/.borg`, workspace bind mount, `./secrets/github-installations.json:/secrets/github-installations.json:ro`
- [ ] **Create `.env.example`** documenting all required environment variables
  - `ANTHROPIC_API_KEY`, `GITHUB_APP_ID`, `WORKSPACE_ROOT`, `TUNNEL_TOKEN`
  - Bot token and chat ID remain in `.borg/settings.json` (loaded at runtime from the volume)
  - GitHub installation IDs live in `secrets/github-installations.json` (org → ID mapping)
- [ ] **Create `.dockerignore`**: `node_modules`, `dist`, `.borg`, `secrets`, `.env`, `*.log`
- [ ] **Test**: `docker compose up` starts bot, processes a Telegram message, response appears

**Success criteria**: Bot container processes messages identically to bare-metal. `docker compose down` triggers graceful shutdown (threads.json saved).

#### Phase 2: Credential Broker

**Goal**: GitHub App PEM isolated in broker container, bot mints scoped tokens on demand.

**Tasks**:

- [ ] **Create `broker/` directory** with:
  - `broker/index.js` — Express server (single file, ~60 lines, as spec'd)
  - `broker/package.json` — `express`, `@octokit/auth-app`
  - `broker/Dockerfile` — `node:22-alpine`, minimal
- [ ] **Add health endpoint** to broker: `GET /health` returns 200 when Express is listening
- [ ] *(Optional)* **Add token caching** — in-memory cache keyed by `(installationId, repositories, permissions)`, reuse tokens with >5 min remaining TTL. Defer if not hitting rate limits.
- [ ] **Add broker service** to `docker-compose.yml`:
  - `depends_on` with no health check (broker starts fast — Express listen is <100ms)
  - Volume: `./secrets/github-app.pem:/secrets/github-app.pem:ro`
  - Environment: `GITHUB_APP_ID`
  - Network: `internal` only, no port exposure to host
- [ ] **Create git credential helper** script (`docker/github-token-helper.sh`) installed in bot container
- [ ] **Configure git** in bot Dockerfile: `git config --global credential.helper /usr/local/bin/github-token-helper`
- [ ] **Create `secrets/` directory** with `.gitkeep` (PEM + installations JSON placed manually, never committed)
  - `secrets/github-app.pem` — GitHub App private key
  - `secrets/github-installations.json` — org → installation ID mapping
- [ ] **Test**: Bot container can `git clone` a private repo using broker-minted token

**Success criteria**: `docker exec bot git clone https://github.com/org/repo.git` succeeds using a broker-minted token. PEM is not accessible from the bot container.

#### Phase 3: Monitoring Dashboard — Backend

**Goal**: Express server with all API endpoints, SSE streams, reading `.borg/` data.

**Tasks**:

- [ ] **Add prompt logging** to `src/queue-processor.ts` (~line 395, after prompt assembly)
  - Log to `.borg/logs/prompts.jsonl` via `appendFileSync`
  - Fields: `timestamp`, `threadId`, `messageId`, `model`, `systemPromptAppend` (the thread-specific part), `userMessage` (first 500 chars), `historyInjected`, `historyLines`, `promptLength`
  - Add 10MB rotation (same pattern as `message-history.ts`)
  - Affects: `src/queue-processor.ts`
- [ ] **Reconcile routing log path**: code writes to `.borg/logs/routing.jsonl`, dashboard expects the same. Verify `routing-logger.ts` path matches.
- [ ] **Create `src/dashboard.ts`** — Express server with these endpoints:
  - `GET /` — serves `static/dashboard.html`
  - `GET /api/status` — service health, queue depth, thread summary, host metrics
  - `GET /api/threads` — full `threads.json`
  - `GET /api/threads/:id/messages` — message history filtered by threadId
  - `GET /api/messages/feed` — SSE stream of new messages (poll `message-history.jsonl` every 2s)
  - `GET /api/routing/feed` — SSE stream of routing decisions
  - `GET /api/routing/recent?n=50` — last N routing decisions
  - `GET /api/prompts/recent?n=20` — last N assembled prompts
  - `GET /api/metrics` — CPU, RAM, disk, load average from `/host/proc/*`
  - `GET /api/logs/:type` — SSE stream of log file (`telegram` | `queue`)
  - `GET /health` — health check endpoint
- [ ] **Implement JSONL tail reader** utility:
  - Track byte offset per file
  - On poll: read from offset to EOF, parse new lines
  - Detect rotation: if file size < offset, reset to 0
  - Handle missing files gracefully (return empty, don't crash)
- [ ] **Implement `/host/proc` parsers**:
  - `/host/proc/meminfo` → total, used, available RAM
  - `/host/proc/stat` → CPU percentage (diff two readings 1s apart)
  - `/host/proc/loadavg` → 1m, 5m, 15m
  - `fs.statfs()` → disk usage of `.borg/` volume
- [ ] **Add `express` + `@types/express`** to `package.json` (express as dependency, types as devDependency)
- [ ] **Test**: `curl localhost:3100/api/status` returns valid JSON with queue depth and thread list

**Dependency note**: Express is added to the main `package.json`. The dashboard imports only `express` and `fs/path/http` — no grammy, no Claude SDK. The `Dockerfile.dashboard` builds everything but only runs `dist/dashboard.js`.

**Success criteria**: All API endpoints return correct data. SSE streams emit events when JSONL files are appended to.

#### Phase 4: Monitoring Dashboard — Frontend

**Goal**: Single HTML file with all 7 views, no build step.

**Tasks**:

- [ ] **Create `static/dashboard.html` shell** — single file with inline CSS + JS
  - Design: dev tools aesthetic — dark theme, monospace, dense information display
  - Client-side routing via hash fragments (`#overview`, `#feed`, `#thread/5`, etc.)
  - Navigation bar, layout skeleton, shared styles
  - No framework, no build step — vanilla JS + `fetch` + `EventSource`
- [ ] **View 1: Overview** (default) — host metrics, queue depth, active threads table, message rate (1h/24h), dead-letter count. Fetches `/api/status` on load + auto-refresh every 5s.
- [ ] **View 2: Live Feed** — SSE-connected message stream (`/api/messages/feed`), color-coded by model, click-to-expand, auto-scroll with pause button.
- [ ] **View 3: Thread Detail** — chat-bubble layout with metadata badges (model, tier, timestamp), full conversation history from `/api/threads/:id/messages`. Linked from Overview thread table.
- [ ] **View 4: Routing Inspector** — 14-dimension scoring breakdown from `/api/routing/recent`, sortable/filterable table, tier distribution summary.
- [ ] **View 5: Prompt Inspector** — expandable prompt entries from `/api/prompts/recent`, promptLength bar chart, highlight `historyInjected: true`. Side-by-side diff deferred (add when needed).
- [ ] **View 6: System Metrics** — CPU/RAM/disk/load from `/api/metrics`, simple bar charts, auto-refresh every 5s.
- [ ] **View 7: Logs** — SSE-streamed log viewer (`/api/logs/:type`), tab toggle (telegram/queue), search filter, auto-scroll + pause.
- [ ] **Test**: Open dashboard in browser, all views render, SSE streams connect.

**Success criteria**: All 7 views display correct data. Live Feed and Logs auto-update. Prompt Inspector shows expandable entries.

#### Phase 5: Docker Compose Integration + Infrastructure

**Goal**: All 3 services running together, systemd unit, borg.sh rewrite, Cloudflare Tunnel.

**Tasks**:

- [ ] **Create `Dockerfile.dashboard`**
  - Base: `node:22-slim`
  - COPY + build same as bot Dockerfile
  - CMD: `node dist/dashboard.js`
  - EXPOSE: 3100
- [ ] **Add dashboard service** to `docker-compose.yml`:
  - Volumes: `borg-data:/app/.borg:ro`, `/proc:/host/proc:ro`
  - Ports: `127.0.0.1:3100:3100` (localhost only)
  - `depends_on: bot`
- [ ] **Add cloudflared service** to `docker-compose.yml`:
  - Image: `cloudflare/cloudflared:latest`
  - Command: `tunnel run`
  - Environment: `TUNNEL_TOKEN` from `.env`
  - Network: `internal`
  - `depends_on: dashboard`
- [ ] **Replace systemd files**:
  - Delete `systemd/borg-telegram.service`
  - Delete `systemd/borg-queue.service`
  - Create `systemd/borg.service` — single unit running `docker compose up`
- [ ] **Rewrite `borg.sh`** as docker compose wrapper:
  - `start` → `docker compose up -d`
  - `stop` → `docker compose down`
  - `restart` → `docker compose restart`
  - `status` → `docker compose ps` + `docker stats --no-stream`
  - `logs [service]` → `docker compose logs -f [service]`
  - `install` → install systemd unit with path substitution
  - `send <msg>` → write JSON to queue (same as now, but target the volume)
  - `migrate` → copy host `.borg/` into Docker volume (one-time migration)
- [ ] **Create data migration command** (`borg.sh migrate`):
  - Copy `.borg/threads.json`, `message-history.jsonl`, `settings.json`, `message-models.json` into the Docker volume
  - Clear `sessionId` from migrated `threads.json` (sessions won't survive container boundary)
- [ ] **Test full stack**: `docker compose up -d` starts all 4 services, message processing works, dashboard accessible at `localhost:3100`

**Success criteria**: Full stack starts with one command. Messages flow through bot. Dashboard shows live data. Graceful shutdown saves state.

## Acceptance Criteria

### Functional Requirements

- [ ] Bot container processes Telegram messages with smart routing (haiku/sonnet/opus)
- [ ] Cross-thread messaging works via MCP tools through the file queue
- [ ] Credential broker mints scoped GitHub installation tokens on demand
- [ ] Bot container can clone repos and create PRs using broker-minted tokens
- [ ] Dashboard Overview shows host metrics, queue depth, active threads, message rate
- [ ] Dashboard Live Feed streams new messages in real-time via SSE
- [ ] Dashboard Thread Detail shows full conversation with chat-bubble layout
- [ ] Dashboard Routing Inspector shows 14-dimension scoring breakdown
- [ ] Dashboard Prompt Inspector shows assembled prompts with length tracking
- [ ] Dashboard System Metrics shows CPU, RAM, disk, load average
- [ ] Dashboard Logs view streams telegram and queue logs in real-time
- [ ] `borg.sh` commands all work as docker compose wrappers
- [ ] `borg.sh migrate` successfully migrates existing state to Docker volume
- [ ] Cloudflare Tunnel provides HTTPS access to dashboard with Access authentication

### Non-Functional Requirements

- [ ] Graceful shutdown: `docker compose down` triggers SIGTERM handlers, saves `threads.json`
- [ ] Crash recovery: `restart: always` restarts crashed containers; `processing/` recovery on startup
- [ ] Dashboard polling interval: 2s for JSONL files, 5s for system metrics
- [ ] JSONL tail reader handles file rotation (size < offset → reset)
- [ ] Dashboard handles missing files gracefully (empty state, not crash)
- [ ] PEM never accessible from bot container — only broker has `/secrets/` mount
- [ ] Dashboard binds to `127.0.0.1:3100` only — not exposed to network
- [ ] Dead-letter queue visible in dashboard Overview

### Quality Gates

- [ ] All containers start and pass health checks
- [ ] Bot processes at least one message end-to-end in Docker
- [ ] Dashboard loads all 7 views without errors
- [ ] `docker compose down && docker compose up -d` preserves all state
- [ ] Signal propagation test: `docker compose stop` saves threads.json

## Dependencies & Prerequisites

| Dependency | Status | Notes |
|---|---|---|
| Docker + Docker Compose V2 | Required | Must be installed on Hetzner server |
| Cloudflare account + domain | Required | For tunnel + Access authentication |
| GitHub App | Required | For credential broker (App ID + PEM) |
| `ANTHROPIC_API_KEY` | Required | For Claude Agent SDK |
| Node.js 22 Docker image | Available | `node:22-slim` |
| `cloudflared` Docker image | Available | `cloudflare/cloudflared:latest` |

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `fs.watch` unreliable on Docker volumes | High | Dashboard SSE streams appear dead | Use polling (AD-4), not fs.watch |
| Agent filesystem access too broad | Medium | Security — agent can access host files | Bind-mount only workspace dir, not `/` |
| Signal not forwarded to Node processes | High | Data loss on shutdown | Trap in entrypoint.sh (AD-2) |
| JSONL rotation breaks tail reader | Medium | Dashboard stops updating | Detect size < offset, reset (Phase 3) |
| Hardcoded host paths in code | Certain | Container crashes on path resolution | Fix in Phase 1 (env var `DEFAULT_CWD`) |
| Broker token not cached → GitHub rate limit | Low | Git operations fail | Add in-memory cache (Phase 2) |
| `processing/` files stuck after crash | Medium | Messages permanently lost | Startup recovery (Phase 1) |
| Dashboard starts before log files exist | Medium | Dashboard crashes | Handle missing files gracefully |

## Files to Create

| File | Purpose |
|---|---|
| `Dockerfile` | Bot container (telegram-client + queue-processor + git + gh) |
| `Dockerfile.dashboard` | Dashboard container |
| `docker-compose.yml` | All 4 services (broker, bot, dashboard, cloudflared) |
| `entrypoint.sh` | Bot container entrypoint with signal trapping |
| `.dockerignore` | Exclude node_modules, dist, .borg, secrets, .env |
| `.env.example` | Document all required environment variables |
| `broker/index.js` | Credential broker Express server |
| `broker/package.json` | Broker dependencies (express, @octokit/auth-app) |
| `broker/Dockerfile` | Broker container (node:22-alpine) |
| `docker/github-token-helper.sh` | Git credential helper that calls broker |
| `src/dashboard.ts` | Dashboard Express server with API + SSE endpoints |
| `static/dashboard.html` | Dashboard frontend (single file, inline CSS/JS) |
| `systemd/borg.service` | Single systemd unit for docker compose |
| `secrets/.gitkeep` | Placeholder for PEM + installations JSON |
| `secrets/github-installations.json.example` | Example org → installation ID mapping |

## Files to Modify

| File | Change |
|---|---|
| `src/queue-processor.ts` | Add prompt logging to `.borg/logs/prompts.jsonl` (~line 395) |
| `src/session-manager.ts` | Replace hardcoded paths (lines 63, 215) with `process.env.DEFAULT_CWD` |
| `src/queue-processor.ts` | Replace hardcoded path (line 368) with `process.env.DEFAULT_CWD` |
| `src/queue-processor.ts` | Add startup recovery: move `processing/` files back to `incoming/` |
| `package.json` | Add `express` + `@types/express` dependencies, add `dashboard` script |
| `borg.sh` | Full rewrite as docker compose wrapper |
| `.gitignore` | Add `secrets/`, `.env`, ignore Docker build artifacts |

## Files to Delete

| File | Reason |
|---|---|
| `systemd/borg-telegram.service` | Replaced by single `systemd/borg.service` |
| `systemd/borg-queue.service` | Replaced by single `systemd/borg.service` |

## Open Questions

### Resolved during planning

1. ~~Agent filesystem access inside Docker~~ → Bind-mount workspace root (AD-1)
2. ~~Signal propagation~~ → Trap in entrypoint.sh (AD-2)
3. ~~Dashboard file watching~~ → Polling, not fs.watch (AD-4)
4. ~~Multi-org credential helper~~ → JSON config mapping org → installation ID (AD-3)

### Remaining (can be resolved during implementation)

1. **What additional binaries does the bot container need?** The Claude Agent SDK's `query()` runs as a Node.js function, but the agent's Bash tool executes arbitrary shell commands. The plan includes `git`, `gh`, `curl`, `jq`, `bash`. Should it also include `python3`, `ripgrep`, or other developer tools the agent might invoke? **Default: start minimal, add tools if agent errors on missing binaries.**

2. **Should `settings.json` secrets move to env vars?** Currently `telegram_bot_token` and `telegram_chat_id` live in `.borg/settings.json` on the shared volume. The dashboard container mounts this volume read-only and could theoretically read the bot token. Options: (a) keep as-is, accept the risk since dashboard is trusted code, (b) move token/chat ID to env vars and strip from settings.json. **Default: keep as-is for now, the dashboard is our own code.**

3. **Static file path in dashboard container.** `src/dashboard.ts` serves `static/dashboard.html`. Inside Docker, this needs `COPY static/ /app/static/` in the Dockerfile. The path resolution (`path.resolve(__dirname, "../static")`) depends on WORKDIR. **Default: add COPY + verify path in Dockerfile.**

4. **`gh` CLI authentication inside the bot container.** The git credential helper handles `git` operations, but `gh pr create` uses `GH_TOKEN` env var separately. The agent would need to set `GH_TOKEN` before running `gh` commands, or the system prompt must instruct it to fetch a token first. **Default: set `GH_TOKEN` via a wrapper script or instruct via system prompt.**

## Future Considerations

- **Container health endpoints**: Add `/health` to bot processes (HTTP server on internal port) for proper `depends_on: condition: service_healthy`
- **Alerting**: Dashboard currently only displays — add webhook/Telegram alerts for disk >90%, dead-letter accumulation, container restarts
- **Multi-host**: If Borg grows beyond one server, the file-based queue becomes the bottleneck — consider Redis or SQLite
- **Dashboard authentication**: Currently relies entirely on Cloudflare Access — could add JWT validation of `Cf-Access-Jwt-Assertion` header for defense in depth
- **Log rotation**: Add rotation for `telegram.log`, `queue.log`, `routing.jsonl`, `prompts.jsonl` (currently only `message-history.jsonl` rotates at 10MB)
- **Metrics history**: Dashboard only shows current state — could persist metrics to a time-series file for historical graphs

## References

### Internal

- Architecture spec: `docs/dashboard-spec.md`
- Queue processor (prompt assembly): `src/queue-processor.ts:380-395`
- Session manager (hardcoded paths): `src/session-manager.ts:63`, `src/session-manager.ts:215`
- Routing logger: `src/routing-logger.ts`
- Message history (rotation logic): `src/message-history.ts:42-44`
- Current borg.sh: `borg.sh` (357 lines, PID management)
- Current systemd files: `systemd/borg-telegram.service`, `systemd/borg-queue.service`

### Institutional Learnings

- SDK v2 silently ignores mcpServers: `docs/solutions/integration-issues/sdk-v2-mcpservers-silent-ignore.md`
- First live run fixes (6 issues): `docs/solutions/integration-issues/borg-v2-first-live-run-fixes.md`
- Architecture evolution lessons: `docs/solutions/integration-issues/borg-v2-evolution-from-fork-to-forum-agent.md`

### Key Insights from Learnings

- **Atomic file writes** (`.tmp` + `rename`) protect against reader corruption — maintain this pattern in all new code
- **JSONL append safety** on ext4 with `appendFileSync` — continue using for all new log files
- **Session cleanup** (30-min idle timeout) prevents memory bloat — each SDK session spawns 50-100MB subprocess
- **History injection is conditional** (new sessions only) — the Prompt Inspector is specifically designed to catch regressions here
- **`processing/` recovery** is needed — current code has a bug where mid-processing crashes leave messages stuck (add startup recovery)
