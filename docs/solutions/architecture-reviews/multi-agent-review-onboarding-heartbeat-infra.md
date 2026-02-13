---
problem_type: architecture-review
title: "Full Pipeline: Brainstorm to Compound — Onboarding, Heartbeat, and Infrastructure"
date: 2026-02-11
branch: feat/onboarding-heartbeat-infra
project: Borg
pipeline_stages:
  - brainstorm
  - plan
  - deepen
  - implement
  - security-refactor
  - review
  - resolve
  - compound
components:
  - src/dashboard.ts
  - src/mcp-tools.ts
  - src/docker-client.ts
  - src/session-manager.ts
  - static/dashboard.html
  - docker-compose.yml
  - Dockerfile.dev-container
  - heartbeat-cron.sh
  - scripts/create-dev-container.sh
  - scripts/remove-dev-container.sh
  - scripts/init-knowledge-base.sh
tags:
  - code-review
  - docker
  - mcp-tools
  - typescript
  - parallel-agents
  - architecture-extraction
  - frontend-races
  - security
  - performance
  - heartbeat
  - dev-containers
  - memory-dashboard
  - compound-engineering-pipeline
---

# Full Pipeline: Brainstorm to Compound

## Timeline

All 7 commits occurred on 2026-02-11, spanning ~6 hours.

| Time (UTC) | Commit | Stage | Output |
|------------|--------|-------|--------|
| 16:09 | `4f680ec` | Brainstorm v1 | 3 features explored (131 lines) |
| 16:34 | `8bb55bd` | Brainstorm v2 | 4th feature added — memory dashboard |
| 17:15 | `fc6569d` | Deepened plan | 9 research agents, 1,034-line plan |
| 19:35 | `b80ec4c` | Implementation | 14 files, +1,775 lines, all 4 features |
| 19:41 | `e6415a7` | Security refactor | Network isolation replaces bearer auth |
| 21:56 | `1ad4e25` | Review resolution | 12 findings fixed, 32 files, +1,334/-436 |
| 22:18 | `f1e3d27` | Compound knowledge | This document |

**Total**: 38 files, +2,944 lines, ~6 hours from brainstorm to compound.

---

## Stage 1: Brainstorm

The brainstorm between Lucian and Claude identified three interconnected capabilities to transform Borg from a single-user tool into a team adoption platform, plus a fourth added 25 minutes later:

### Feature 1: Smart Heartbeat System

The existing heartbeat was a flat haiku one-shot that only asked "any pending tasks?" The brainstorm designed a three-tier cadence:
- **Every heartbeat (~5-8 min):** Quick `git status`, check urgent flags
- **Hourly:** `git fetch`, detect upstream changes, CI status, merge conflicts
- **Daily (sonnet-grade):** Summarize day to master thread, surface aging issues, flag stale branches

Key design constraint: heartbeats are one-shot (no persistent session). HEARTBEAT.md serves as both task list and state store.

### Feature 2: Master Thread as Organizational Brain

The master thread (threadId: 1) gets a local-only git repo as its working directory containing `context.md`, `decisions.md`, and `active-projects.md`. Worker threads send daily summaries; the master aggregates them.

### Feature 3: Dev Container Infrastructure

Docker containers on a shared Hetzner box (32GB RAM) for each developer, with SSH access, Claude Code CLI, GitHub credentials via the credential broker, and tmux for session persistence.

### Feature 4: Live Memory Rebalancing Dashboard (added 25 min later)

Per-container memory sliders with host capacity validation. Apply via `docker update --memory` (live, no restart).

### 9 Key Decisions from Brainstorm

1. Heartbeat intelligence lives in HEARTBEAT.md and prompt (not code)
2. Dev infrastructure = Docker on shared Hetzner
3. No swap on host (fast OOM kills)
4. Live memory rebalancing via dashboard
5. Each dev brings their own Claude Max plan
6. Purpose-built Dockerfile (not extending bot image)
7. Two developer interfaces: Telegram for quick tasks, SSH for deep work
8. Local-only knowledge base git repo (never pushed to remote)
9. `send_message` MCP tool for cross-thread daily summaries

---

## Stage 2: Plan Deepening

The plan was deepened with **9 parallel research agents**: security-sentinel, architecture-strategist, performance-oracle, agent-native-reviewer, code-simplicity-reviewer, pattern-recognition-specialist, julik-frontend-races-reviewer, best-practices-researcher, framework-docs-researcher.

### Critical Findings That Changed the Architecture

| Agent | Finding | Impact |
|-------|---------|--------|
| security-sentinel | `tecnativa/docker-socket-proxy` POST=1 enables `exec` (arbitrary code execution in any container) | Switched to `wollomatic/socket-proxy` with regex URL matching |
| security-sentinel | SSH env vars not inherited by sshd children | Added `/etc/profile.d/` runtime write pattern |
| code-simplicity-reviewer | YAML frontmatter unreliable for haiku | Replaced with plain markdown timestamps |
| architecture-strategist | Phase 1b depends on Phase 2 (not obvious) | Split Phase 1 into 1a (independent) and 1b (needs master) |
| agent-native-reviewer | Dashboard-only container management excludes agents | Added MCP tools for master thread |
| performance-oracle | Heartbeat burst injection starves user messages | Added stagger sleep between threads |
| julik-frontend-races-reviewer | SSE re-renders will destroy sliders mid-drag | Added per-container interaction state tracking |

### 9 Simplifications Applied

1. Removed YAML frontmatter — plain markdown timestamps
2. Removed `determineHeartbeatTier()` from TypeScript — agent self-determines
3. Removed model selection logic — haiku for all tiers
4. Removed `timezone` from HEARTBEAT.md — use settings.json
5. Removed hourly keyword suppression — trust HEARTBEAT_OK pattern
6. Removed 409 conflict handling — last-write-wins for 1-5 admins
7. Deferred priority queue ordering
8. Deferred repository ruleset audit
9. Deferred Telegram notification on memory changes

**Adherence**: 8 of 9 respected during implementation. The sole violation (#9, Telegram notification) was caught by review and removed.

---

## Stage 3: Implementation

All four features delivered in a single commit (~2h 20min after plan finalized).

### Feature 1: Smart Heartbeat — "All Intelligence Lives in the Prompt"

This is the most important architectural decision in the branch. The original brainstorm considered a `determineHeartbeatTier()` TypeScript function. The simplicity reviewer eliminated it — the agent self-determines its tier by reading HEARTBEAT.md timestamps and comparing to the current time injected in the prompt.

**Zero changes to `processHeartbeat()`.** The enriched prompt in `buildHeartbeatPrompt()` tells the agent:
- Read HEARTBEAT.md timestamps
- Compare to current time
- Self-determine which tier of checks to run
- Execute the checks
- Update timestamps

**Reusable pattern:** When building agentic systems, push decision-making to the prompt layer rather than the orchestration layer. The model can read a file, compare timestamps, and decide what to do. Code-level branching adds fragility for no benefit.

**Stagger pattern**: Between each thread's heartbeat injection, sleep `INTERVAL / THREAD_COUNT` seconds. Prevents queue flooding.

### Feature 2: Knowledge Base — Push + Pull Channels

Two knowledge access patterns for multi-agent coordination:
- **Push**: Worker threads send daily summaries via `send_message` MCP tool → master aggregates into `active-projects.md`
- **Pull**: Any thread can call `query_knowledge_base` MCP tool for synchronous reads of `context.md`, `decisions.md`, `active-projects.md`

**Reusable pattern:** Provide both push and pull channels. Push for async reporting, pull for synchronous context. Avoids the bottleneck of needing the coordinator to be online when a worker needs information.

### Feature 3: Dev Containers — Security Layering

**Docker socket proxy**: `wollomatic/socket-proxy` with 5 specific regex-allowed paths. Blocks exec, create, delete, start, stop. Socket mounted read-only.

**Network segmentation**: Two Docker networks — `internal` (bot, broker, dashboard, docker-proxy) and `dev` (broker only). Dev containers reach the broker for credentials but cannot see the dashboard or docker proxy.

**Credential propagation chain**:
1. Broker holds GitHub App private key
2. `docker-compose.yml` passes `BROKER_SECRET` to bot container
3. Dev containers receive env vars at runtime
4. CMD writes them to `/etc/profile.d/broker-env.sh` (NOT build-time RUN)
5. SSH sessions source `/etc/profile.d/*` on login

**Reusable pattern:** For Docker containers with sshd, write runtime env vars to `/etc/profile.d/` in the CMD, not in RUN. RUN captures build-time values (empty strings); CMD captures runtime values.

### Feature 4: Memory Dashboard — Interaction State Machine

**SSE broadcast pattern**: Single server-side `setInterval` polls Docker API, broadcasts to all SSE clients. Prevents N clients making N Docker API calls.

**Per-container interaction states**: `idle | adjusting | applying`. During `adjusting` or `applying`, SSE re-renders skip that container's card, preventing slider destruction mid-drag.

**Event delegation**: Handlers on parent `#memory-cards`, not individual slider elements. Survives DOM mutations from SSE re-renders.

**Snap-to-64MB validation chain**: Frontend slider `step` attribute snaps client-side. Server re-snaps regardless of client input, enforces 256MB minimum, validates total allocation against host RAM minus 2GB OS reserve.

### MCP Tool Layering

```
All threads:  send_message, list_threads, query_knowledge_base
Master only:  + get_container_stats, update_container_memory, get_host_memory, get_system_status
```

Tool selection at MCP server creation time via `sourceThreadId === 1` guard.

**Reusable pattern:** In multi-agent systems, tier tool access by role. All agents get communication primitives; only the coordinator gets infrastructure-mutating tools.

---

## Stage 4: Security Refactor

6 minutes post-implementation, bearer auth was replaced with network isolation. The dashboard listens on `127.0.0.1:3100`, accessible only through Cloudflare Tunnel. Dev containers on the `dev` network cannot reach the dashboard or docker proxy at all.

**Trade-off:** Network-level isolation is simpler and stronger than application-level bearer tokens. Fewer secrets, fewer lines of code, stronger security model.

---

## Stage 5: Multi-Agent Review

8 specialized agents ran in parallel, finding 15 issues triaged to 12.

### Root Cause

Docker API code duplication between `dashboard.ts` and `mcp-tools.ts` with divergent behavior. Dashboard validated memory allocation; MCP tool did not. Flagged by 6 of 8 agents independently.

### Findings by Priority

**6 P1 (Critical):** Container ID injection, Docker code duplication, N+1 sequential API calls, broken env var propagation, non-atomic writes, stuck slider state

**4 P2 (Important):** Unbounded query params, agent-native gaps, duplicate meminfo parsers, YAGNI notification

**2 P3 (Minor):** TypeScript quality, shell script improvements

**3 Deleted:** innerHTML XSS (internal tool), cloudflared (trivial), security headers (redundant with network isolation)

---

## Stage 6: 2-Phase Parallel Resolution

### Phase 1 (4 agents, parallel, non-conflicting)

- **016**: Extracted `src/docker-client.ts` (303 lines) — types, constants, validation, fetch helpers, parallelized container listing, full `validateAndUpdateMemory()` pipeline
- **018**: Dockerfile CMD writes env vars at runtime
- **019**: Heartbeat cron uses `.tmp + mv` atomic writes
- **020**: Global `pointerup` replaces buggy `pointerleave`; post-apply re-render

### Phase 2 (8 agents, parallel, after Phase 1 settles)

- **015**: Container ID hex regex validation, 400 for invalid
- **017**: `Promise.allSettled` parallelization, 10s timeouts, SSE overlap guard
- **021**: `Math.min(n, 200)` cap on all 6 endpoints
- **022**: `get_host_memory` + `get_system_status` MCP tools; system prompt docs
- **023**: Single `parseMeminfo()` returning bytes
- **024**: Removed `notifyMemoryChange()` (YAGNI)
- **027**: Type safety fixes, `textContent()` helper, safe query parsing
- **028**: `set -uo pipefail`, numeric validation, apt cleanup, consistent timestamps

**Why 2 phases:** Phase 1's docker-client.ts extraction restructured `dashboard.ts` (-180 lines) and `mcp-tools.ts` (-80 lines). 7 of 8 Phase 2 agents modify those same files. Concurrent edits to the same file would cause Edit tool string-match failures on stale content.

---

## Recurring Patterns Across Review Cycles

Comparing current cycle (015-028) with prior cycle (001-014):

### Atomic Write Violations — Found in Every Branch

- **Todo 004** (prior): `queue-processor.ts` writeFileSync without .tmp
- **Todo 019** (current): `heartbeat-cron.sh` jq output without .tmp+mv

Despite CLAUDE.md mandating atomic writes, every branch introduces at least one violation. **Needs CI enforcement, not documentation.**

### YAGNI Violations

- **Todo 010** (prior): Dead code from rapid iteration (94 LOC)
- **Todo 024** (current): `notifyMemoryChange()` implemented despite plan deferring it

### Docker Infrastructure Maturity

- **Prior**: Signal race (002), missing resource limits (005), broken healthchecks (008)
- **Current**: Container ID injection (015), N+1 API calls (017), build-time env vars (018)

### Code Duplication with Divergent Behavior

- **Todo 009** (prior): Routing logger diverged from append pattern
- **Todo 016** (current): Docker API duplicated between dashboard and MCP tools

### Convention Compliance

| Convention | Status |
|------------|--------|
| TypeScript `nodenext` + `.js` extensions | Consistently followed |
| Atomic file writes (`.tmp` + rename) | **Violated every branch** |
| JSONL appends with `appendFileSync` | Violated once (routing logger) |

---

## Prevention Strategies

### 1. Shared Modules from Day One

Every new external integration (Docker API, Telegram API, credential broker) gets a `src/<name>-client.ts` module that owns all communication. Feature modules import; they never inline API calls.

### 2. Automated CI Checks

```bash
# No writeFileSync to queue dirs without .tmp
grep -rn 'writeFileSync' src/ | grep -v '.tmp' | grep -v 'node_modules'

# No Docker API calls outside docker-client
grep -rn "/containers/\|/images/" src/ | grep -v 'docker-client'

# No unvalidated req.params interpolation
grep -rn 'req\.params\.' src/ | grep -v 'isValid\|validate'

# await-in-loop detection (potential N+1)
grep -Pzo 'for\s*\(.*\)\s*\{[^}]*await\s' src/
```

### 3. Agent-Native Parity Rule

Every dashboard endpoint must have an MCP tool counterpart considered at design time. PR descriptions include: "MCP tool parity: [tool name] added / deferred with rationale."

### 4. YAGNI Enforcement

The plan's "Simplifications Applied" is a binding contract. Cross-reference before implementing any feature that appears in the deferred list.

### 5. Docker/Infra Rules

- `ENV` for build-time constants only; runtime config via compose environment
- No `pointerleave` during pointer capture; use `pointerup`
- SSE polling needs overlap guards (`setInterval` + async = overlap risk)
- Docker socket proxies: regex URL matching only, never category-level toggles

---

## Pipeline Effectiveness

### What Would Have Shipped Without the Pipeline

| Issue | Caught At | Production Impact |
|-------|-----------|-------------------|
| tecnativa exec vulnerability | **Deepen** | Full host compromise via Docker exec |
| SSH env var propagation broken | **Deepen** | Dev containers non-functional |
| Container ID injection | **Review** | Path traversal in Docker API |
| Docker duplication divergence | **Review** | Agent silently over-allocates memory → OOM |
| N+1 sequential Docker calls | **Review** | Dashboard timeout with 10+ containers |
| Permanently stuck slider | **Deepen + Review** | Permanent UI breakage after first drag |

### Cost-Benefit

| Metric | Value |
|--------|-------|
| Pipeline token cost | ~$3-6 |
| Prevented fix cost (6 P1 issues, 10-20 dev-hours) | ~$1,000-3,000 |
| ROI | ~200-1,000x |
| Wall-clock time (review + resolve + compound) | ~2h 37min |
| False positive rate | 20% (3 deleted of 15 found) |

### Stage Value Ranking

1. **Deepen** (highest per-minute value) — Found 2 would-be-shipped vulnerabilities via external research that code review alone cannot catch
2. **Review** — Found 6 P1 code-level issues across 8 specialized perspectives
3. **Plan** — 8 of 9 simplifications respected; prevented scope creep
4. **Resolve** — 2-phase parallel cut 12 fixes into ~2 hours
5. **Brainstorm** — Set correct architectural direction (prompt-driven tiers, purpose-built images)
6. **Compound** — Institutional memory; recurring pattern detection across cycles

---

## Related Documentation

- [`docs/solutions/integration-issues/borg-v2-evolution-from-fork-to-forum-agent.md`](../integration-issues/borg-v2-evolution-from-fork-to-forum-agent.md) — Canonical patterns (atomic writes, JSONL safety)
- [`docs/solutions/integration-issues/sdk-v2-mcpservers-silent-ignore.md`](../integration-issues/sdk-v2-mcpservers-silent-ignore.md) — MCP tool infrastructure
- [`docs/solutions/integration-issues/metadata-propagation-and-credential-forwarding-across-layers.md`](../integration-issues/metadata-propagation-and-credential-forwarding-across-layers.md) — Docker env var propagation
- [`docs/solutions/workflow-patterns/parallel-subagent-orchestration-bulk-todo-resolution.md`](../workflow-patterns/parallel-subagent-orchestration-bulk-todo-resolution.md) — Parallel resolution pattern
- [`docs/plans/2026-02-11-feat-onboarding-heartbeat-infra-plan.md`](../../plans/2026-02-11-feat-onboarding-heartbeat-infra-plan.md) — The implementation plan
- [`docs/brainstorms/2026-02-11-onboarding-heartbeat-infra-brainstorm.md`](../../brainstorms/2026-02-11-onboarding-heartbeat-infra-brainstorm.md) — The original brainstorm
