---
status: resolved
priority: p2
issue_id: "005"
tags: [code-review, performance, docker, architecture]
dependencies: []
---

# No Container Resource Limits -- Host OOM Risk

## Problem Statement

`docker-compose.yml` defines no `mem_limit`, `cpus`, or `deploy.resources` for any service. The bot container spawns SDK subprocesses consuming 50-100MB each (up to `MAX_CONCURRENT_SESSIONS = 10`). Without limits, a burst of activity could consume all host RAM, triggering the OOM killer on random processes.

## Findings

**Source**: performance-oracle agent, architecture-strategist agent

Additional issues:
- No `stop_grace_period` configured (default 10s may not be enough for agent queries)
- No `init: true` on bot service (bash as PID 1 doesn't reap zombies)
- Bot healthcheck is missing (no HTTP endpoint to check)

## Proposed Solutions

### Option 1: Add resource constraints + operational settings (Recommended)
```yaml
bot:
  init: true
  stop_grace_period: 30s
  deploy:
    resources:
      limits:
        memory: 2G
        cpus: '2.0'
dashboard:
  deploy:
    resources:
      limits:
        memory: 256M
broker:
  deploy:
    resources:
      limits:
        memory: 128M
```
- Pros: Prevents host OOM, gives long-running queries time to abort
- Cons: Memory limits may need tuning based on actual usage
- Effort: Small (15 minutes)
- Risk: Low

## Technical Details

**Affected files**: `docker-compose.yml`

## Acceptance Criteria

- [ ] All containers have memory limits
- [ ] Bot service has `init: true` and `stop_grace_period: 30s`
- [ ] `docker stats` shows memory limits applied

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-10 | Created from code review | Always set resource limits for production Docker deployments |
