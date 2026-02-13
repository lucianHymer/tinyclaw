---
title: Memory Dashboard Extension - Infrastructure Container Visibility and Unified Allocation Budget
date: 2026-02-12
category: architecture-reviews
tags: [docker, memory-management, dashboard, mcp-tools, infrastructure, resource-allocation, cgroups-v2, agent-native-parity]
components: [docker-client, dashboard, mcp-tools, session-manager, frontend]
trigger: Opaque memory allocation budget - infrastructure containers consumed ~2.45GB but were hidden behind a 2GB OS reserve constant
complexity: medium
files_changed: 6
lines_changed: "+454/-128"
---

# Memory Dashboard Extension: All Containers

## Problem Statement

The memory dashboard only displayed dev containers (filtered by `borg.type=dev-container` label). Infrastructure containers (bot, broker, dashboard, docker-proxy, cloudflared) were invisible to both human operators and agents.

**Specific gaps:**

1. **Opaque budget model** — The 2GB `OS_RESERVE_BYTES` implicitly covered both actual OS overhead (~200-500MB) and untracked infra containers (~2.45GB). Users couldn't distinguish between system requirements and container allocations.
2. **No infra visibility** — If bot or broker needed more memory, the only option was `docker update` from CLI. No dashboard indication of memory-starved or over-provisioned infra containers.
3. **Unlimited container risk** — cloudflared ran with no memory limit, not visible or flagged anywhere.
4. **Agent-native parity gap** — MCP tools (`get_container_stats`, `get_host_memory`) only exposed dev containers. Agents couldn't self-diagnose infrastructure capacity.
5. **Self-modification risk** — Nothing prevented accidentally OOM-killing the dashboard or docker-proxy through the UI.

## Solution Architecture

### Container Discovery: Two Parallel Filtered Queries

Infrastructure containers discovered via `com.docker.compose.project` label matching `COMPOSE_PROJECT` env var. Dev containers via existing `borg.type=dev-container` label. Two parallel Docker API queries, merged and deduplicated:

```typescript
const [composeContainers, devContainers] = await Promise.allSettled([
    composeProject
        ? fetchDockerJson<DockerContainer[]>(baseUrl,
            `/containers/json?all=true&filters=${encodeURIComponent(
                JSON.stringify({ label: [`com.docker.compose.project=${composeProject}`] })
            )}`)
        : Promise.resolve([]),
    fetchDockerJson<DockerContainer[]>(baseUrl,
        '/containers/json?all=true&filters={"label":["borg.type=dev-container"]}'),
]);
```

**Why COMPOSE_PROJECT, not HOSTNAME**: `process.env.HOSTNAME` is NOT the container ID when Compose sets a custom hostname. Environment variable is deterministic and eliminates a Docker API call from the hot path.

### Unlimited Detection: Inspect, Not Stats

Docker `memory_stats.limit` for unlimited containers returns the **host's total RAM** (not 0) on cgroups v2. The authoritative signal is `inspect.HostConfig.Memory === 0`:

```typescript
const isUnlimited = inspect.HostConfig.Memory === 0;
limit = isUnlimited ? 0 : inspect.HostConfig.Memory;
// Only use stats limit for non-unlimited containers
if (!isUnlimited && stats.memory_stats?.limit) limit = stats.memory_stats.limit;
```

### Directional Validation for Over-Budget States

When total allocation exceeds budget (expected on first deploy), allow decreases and block increases:

```typescript
const isIncrease = snappedLimit > oldLimit;
if (isIncrease && newTotal > maxAllocatable) {
    throw new ValidationError(
        `Cannot increase: total allocation would be ${formatBytes(newTotal)}, ` +
        `exceeding max ${formatBytes(maxAllocatable)}`);
}
if (newTotal > maxAllocatable) {
    console.warn(`Memory update applied while over-budget: ${containerName} ...`);
}
```

### Server-Side Self-Modification Guards

Client-side `confirm()` is trivially bypassed. Server enforces:
- **Dashboard**: minimum MAX(current usage x 1.5, 128MB)
- **Docker-proxy**: minimum 64MB
- Both include CLI escape hatch message: `Use 'docker update' from CLI for lower values.`

### Delegation to Eliminate Duplication

`getDevContainers()` delegates to `getAllContainers()` — single source of truth:

```typescript
export async function getDevContainers(baseUrl: string): Promise<ContainerInfo[]> {
    const composeProject = process.env.COMPOSE_PROJECT || "";
    const all = await getAllContainers(baseUrl, composeProject);
    return all.filter(c => c.category === "dev");
}
```

## Data Model Changes

```typescript
export type ContainerCategory = "infra" | "dev";

export interface ContainerInfo {
    id: string;
    name: string;
    status: string;
    memory: {
        usage: number;
        limit: number;
        usagePercent: number;
        unlimited: boolean;  // NEW: true when HostConfig.Memory === 0
    };
    cpus: number;
    uptime: string;
    idle: boolean;
    sshPort?: number;
    category: ContainerCategory;  // NEW: "infra" | "dev"
}
```

API response adds `unlimitedCount` to host data and `category`/`unlimited` to each container.

## Constants Changed

| Constant | Before | After | Why |
|----------|--------|-------|-----|
| `OS_RESERVE_BYTES` | 2GB | 512MB | Infra containers now tracked explicitly; only true OS overhead needed (~200-500MB on headless Proxmox VM) |
| `MIN_MEMORY_BYTES` | 256MB | 64MB | Docker-proxy runs at 64MB; OOM warnings and self-modification guards are the real safety nets |
| `MEMORY_SNAP_BYTES` | 64MB | 64MB | Unchanged |

## Files Changed

### `src/docker-client.ts` — Core logic
- New `ContainerCategory` type, `memory.unlimited` field
- `getAllContainers()`: two parallel filtered queries, merge, unlimited detection
- `getDevContainers()`: thin wrapper delegating to `getAllContainers()`
- `getContainerMemoryLimits()`: scoped to all containers, excludes unlimited
- `validateAndUpdateMemory()`: directional validation, self-modification guards, `composeProject` param

### `src/dashboard.ts` — SSE and REST
- `COMPOSE_PROJECT` env var cached at startup
- SSE feed and REST endpoints use `getAllContainers`, include `unlimitedCount`
- Memory POST passes `COMPOSE_PROJECT` to validation

### `static/dashboard.html` — Frontend
- Two-section layout: Infrastructure (purple border) + Dev Containers (blue border)
- Host bar split: Infra Allocated / Dev Allocated / OS Reserve / Available
- Unlimited containers: "No Limit" badge, dashed border, slider at 0
- Infra card names: `svc/` prefix from compose service name
- 4-state footer validation (under-budget, over-budget decreases, over-budget increases, OOM warnings)
- Confirm dialog for dashboard/docker-proxy changes

### `src/mcp-tools.ts` — Agent tools
- `get_container_stats`: all containers with category tags, unlimited handling
- `update_container_memory`: works on all containers, passes `COMPOSE_PROJECT`
- `get_host_memory`: infra/dev breakdown with unlimited count

### `src/session-manager.ts` — System prompt
- Updated MCP tools description for all-container scope

### `docker-compose.yml` — Config
- `COMPOSE_PROJECT` env var added to dashboard and bot services

## Patterns Confirmed

| Pattern | Source | Application |
|---------|--------|-------------|
| Code duplication prevention via delegation | MEMORY.md #1 risk | `getDevContainers()` delegates to `getAllContainers()` |
| Promise.allSettled for graceful degradation | MEMORY.md convention | Two-level: parallel API queries + parallel inspect/stats |
| Input validation at path boundaries | MEMORY.md | Container ID validation in `validateAndUpdateMemory()` |
| Agent-native parity at design time | MEMORY.md | Phase 4 MCP tools updated alongside dashboard |
| SSE broadcast pattern | code-review-cycle-2 | Single interval, `Set<FeedClient>`, try/catch on write |
| Defense-in-depth | agent-driven-container-lifecycle | Server guards + client confirm for sensitive containers |

## New Patterns Established

1. **COMPOSE_PROJECT env var for container discovery** — Replaces HOSTNAME introspection. Deterministic, portable, clear failure mode.
2. **Unlimited detection from inspect, not stats** — `inspect.HostConfig.Memory === 0` is authoritative. Stats returns host total on cgroups v2.
3. **Directional validation** — Over-budget allows decreases, blocks increases. Enables graceful recovery.
4. **Stale container pruning on SSE update** — Compare current IDs against cache, prune missing entries from all three frontend caches.
5. **Global event listener cleanup** — Store handler reference in view state, remove in teardown. Prevents listener accumulation.
6. **Merge-and-deduplicate for overlapping queries** — When two Docker queries may return overlapping results, merge by ID with `Set<string>`.

## Race Conditions Fixed

1. **Global pointerup listener leak** — Anonymous handler on `document` was never removed across view switches. Fixed: store reference, remove in teardown.
2. **Stale container entries** — Removed containers persisted in `memoryServerData`/`memoryPendingChanges`/`memoryContainerStates`. Fixed: prune on every SSE update.
3. **Unlimited slider SSE reset** — SSE tick re-renders card with `limit === 0`, resetting mid-drag slider. Fixed: skip render when `memoryContainerStates[id]` is `'adjusting'` or `'applying'`.

## Risks to Monitor

| Risk | Mitigation | Monitor |
|------|-----------|---------|
| Performance at 20+ containers | Overlap guard, 5s interval | SSE tick duration in logs |
| Over-budget on first deploy | Directional validation, decrease-allowed | User reports of "cannot increase" |
| Dashboard self-OOM | Server guard (128MB/1.5x), confirm dialog | Dashboard restart events |
| Unlimited memory creep | "No Limit" badge, dashed border | cloudflared memory over time |

## Simplifications Deferred

| Deferred | Why | Revisit When |
|----------|-----|-------------|
| Per-container minimum config | Single 64MB floor + OOM warnings sufficient | Users frequently hit OOM on specific services |
| Audit log (JSONL) | console.warn for over-budget only | Compliance or debugging requires trail |
| Optimistic concurrency | Last-write-wins, SSE converges | Multi-user conflicts become frequent |
| Tiered polling (infra 15s, dev 5s) | ~10 containers within 5s budget | Tick duration exceeds 4s |
| Collapsible sections | ~10 containers don't need it | Container count grows to 30+ |
| Stacked colored bar | Text stats simpler and more accessible | Visual representation requested |

## Cross-References

- [Code Review Cycle 2: Systemic Patterns](code-review-cycle-2-systemic-patterns-and-prevention.md) — SSE broadcast pattern, shared module extraction, agent-native parity gap
- [Agent-Driven Container Lifecycle](agent-driven-container-lifecycle-onboarding.md) — Branded types, defense-in-depth validation, label-verified operations, MCP tool tiering
- [Production Docker Dashboard Plan](../../plans/2026-02-10-feat-production-docker-dashboard-broker-plan.md) — Foundation: polling architecture, host metrics, dashboard layout
- [Extend Memory Dashboard Plan](../../plans/2026-02-12-feat-extend-memory-dashboard-all-containers-plan.md) — Full deepened plan with all research insights
- [Docker Runtime Metrics](https://docs.docker.com/engine/containers/runmetrics/) — `memory_stats.limit` semantic gap for unlimited containers
- [runc #3509](https://github.com/opencontainers/runc/issues/3509) — cgroups v2 immediate OOM kill when limit < usage
