---
status: resolved
priority: p2
issue_id: "008"
tags: [code-review, docker, architecture]
dependencies: []
---

# Healthcheck Commands Broken -- wget Not Installed in Base Images

## Problem Statement

`docker-compose.yml` uses `wget` for health checks on broker and dashboard containers, but `node:22-slim` (dashboard) does not include `wget`. The broker uses `node:22-alpine` which has busybox wget but behavior may differ. Health checks will fail, causing Docker to report containers as unhealthy.

## Findings

**Source**: architecture-strategist agent

```yaml
# docker-compose.yml lines 14, 52
healthcheck:
  test: ["CMD", "wget", "-q", "--spider", "http://localhost:3000/health"]
```

Additional issue: Bot container has no healthcheck at all. The `depends_on: broker` uses no health condition, so the bot can start before broker is ready.

## Proposed Solutions

### Option 1: Use Node.js-based healthcheck (Recommended)
```yaml
healthcheck:
  test: ["CMD", "node", "-e", "fetch('http://localhost:3100/health').then(r => process.exit(r.ok ? 0 : 1))"]
```
Also add `depends_on: broker: condition: service_healthy`.
- Effort: Small (15 minutes)
- Risk: None

### Option 2: Install curl in Dockerfiles
Add `apt-get install -y curl` to slim images, `apk add curl` to Alpine.
- Effort: Small
- Risk: Increases image size

## Technical Details

**Affected files**:
- `docker-compose.yml` (healthcheck commands, depends_on conditions)
- Optionally: `Dockerfile`, `Dockerfile.dashboard`, `broker/Dockerfile`

## Acceptance Criteria

- [ ] Health checks pass on all containers with healthchecks
- [ ] `docker compose ps` shows healthy status for broker and dashboard
- [ ] Bot service waits for broker health before starting

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-10 | Created from code review | Always verify healthcheck tools are available in base image |
