---
title: Extend Memory Dashboard to All Containers
type: feat
date: 2026-02-12
deepened: 2026-02-12
---

# Extend Memory Dashboard to All Containers

## Enhancement Summary

**Deepened on:** 2026-02-12
**Sections enhanced:** All
**Agents used:** TypeScript reviewer, Security sentinel, Performance oracle, Architecture strategist, Agent-native reviewer, Code simplicity reviewer, Frontend race conditions reviewer, Pattern recognition specialist, Best practices researcher, Framework docs researcher, Frontend design skill, Agent-native architecture skill, 2x Learnings researchers

### Key Improvements from Deepening

1. **HOSTNAME introspection replaced with env var** — `process.env.HOSTNAME` is NOT the container ID when Compose sets a custom hostname. Use `COMPOSE_PROJECT` env var instead (eliminates a Docker API call from the hot path and a class of failures).
2. **Two-constant split dropped** — Single `MIN_MEMORY_BYTES = 64MB` for all containers. OOM warning is the real safety net, not the slider minimum.
3. **Server-side self-modification guards added** — Client-side `confirm()` is trivially bypassed. Server enforces higher minimums for dashboard and docker-proxy.
4. **MCP tool parity gap closed** — Shared validation code changes affect MCP tools regardless. Small Phase 4 added (~20 lines) to avoid two divergent validation models.
5. **Stacked bar dropped** — Current host bar is text-only stats. Extending with split text is simpler and more accessible than a 4-segment colored bar.
6. **Three frontend race conditions fixed** — Global pointerup listener leak, stale container pruning, cloudflared slider SSE reset.
7. **Filtered Docker API queries** — Two parallel label-filtered queries replace one unfiltered query (reduces data leakage, improves performance).
8. **`memory_stats.limit` semantic gap documented** — Docker reports host total RAM (not 0) for unlimited containers via stats. Must use `inspect.HostConfig.Memory === 0` as authoritative "unlimited" signal.

### Simplifications vs Original Plan

| Original | Simplified To | LOC Saved |
|----------|--------------|-----------|
| `MIN_MEMORY_BYTES_DEV` + `MIN_MEMORY_BYTES_INFRA` | Single `MIN_MEMORY_BYTES = 64MB` | ~15 |
| Stacked colored bar with 4 segments | Split text stats: "Infra: X \| Dev: Y" | ~35 |
| Collapsible section toggle with `data-toggle` | Static section headers | ~20 |
| "Set Limit" button + disabled slider | Slider at 0, "No Limit" text, normal interaction | ~35 |
| HOSTNAME → inspect → label extraction | `COMPOSE_PROJECT` env var | ~10 |
| Amber "caution" badge on cards | `confirm()` dialog is sufficient | ~5 |

---

## Overview

The memory dashboard currently shows only dev containers (filtered by `borg.type=dev-container` label). This plan extends it to show and allow rebalancing of **all** containers — infrastructure (bot, broker, dashboard, docker-proxy, cloudflared) and dev containers — in two distinct sections with unified validation.

The 2GB "OS reserve" is reduced to 512MB since infrastructure container limits are now tracked explicitly in the allocation budget. On a 32GB headless Proxmox VM, the kernel + system services use ~200-500MB — the 2GB reserve was always a rough proxy that implicitly covered untracked infra containers.

## Problem Statement

- Users can't see infrastructure container memory allocations or adjust them
- The 2GB OS reserve implicitly covers infra containers (~2.45GB) but doesn't track them, making the budget opaque
- If bot or broker need more memory, the only option is `docker update` from CLI
- No visibility into whether infra containers are memory-starved or over-provisioned
- Agents (MCP tools) can't see infra containers for self-diagnosis or capacity planning

## Proposed Solution

Two-section memory view with unified validation across all containers, plus MCP tool parity.

### Container Discovery

**Infra containers** identified by `com.docker.compose.project` label matching our project AND absence of `borg.type=dev-container` label. The compose project name is injected via `COMPOSE_PROJECT` environment variable in `docker-compose.yml`.

**Dev containers** identified by existing `borg.type=dev-container` label (unchanged).

**Two parallel filtered Docker API queries** (not one unfiltered query):
1. `GET /containers/json?all=true&filters={"label":["com.docker.compose.project=${composeProject}"]}` — infra containers
2. `GET /containers/json?all=true&filters={"label":["borg.type=dev-container"]}` — dev containers

Merge and deduplicate by ID (dev containers in the compose project appear in both).

> **Research insight:** Docker Compose labels (`com.docker.compose.project`, `com.docker.compose.service`) are semi-official, used by Docker's own `docker compose` commands, Traefik, Portainer, and stable for 10+ years. Safe to rely on.

### Data Model

Extend `ContainerInfo` with a `category` field and an explicit `unlimited` flag:

```typescript
// src/types.ts or src/docker-client.ts
export type ContainerCategory = "infra" | "dev";

// src/docker-client.ts:45
export interface ContainerInfo {
    id: string;
    name: string;
    status: string;
    memory: { usage: number; limit: number; usagePercent: number; unlimited: boolean };
    cpus: number;
    uptime: string;
    idle: boolean;
    sshPort?: number;
    category: ContainerCategory;
}
```

> **Research insight:** `ContainerCategory` as a named type (not inline union) enables `Record<ContainerCategory, number>` patterns and exhaustive switch checking. The `unlimited` flag avoids magic-zero semantics — every consumer no longer needs to independently check `limit === 0` vs `limit > 0`.

> **Research insight (Docker API):** `memory_stats.limit` for unlimited containers returns the **host's total RAM** (not 0) on cgroups v2. The existing code at `docker-client.ts:165` overwrites inspect limit (0) with stats limit (host total). Use `inspect.HostConfig.Memory === 0` as the authoritative "unlimited" signal. Set `unlimited: true` from inspect, and do NOT overwrite `limit` from stats when `unlimited` is true.

### Validation Model

- `OS_RESERVE_BYTES` reduced from 2GB → 512MB (document: "Reserved for Linux kernel, systemd, and base system services on a headless Proxmox VM")
- `MIN_MEMORY_BYTES` reduced from 256MB → 64MB (single constant for all containers; OOM warning is the real safety net)
- Delete old `MIN_MEMORY_BYTES` constant, replace with the new 64MB value
- `getContainerMemoryLimits()` queries ALL containers (same scope as `getAllContainers()`), excludes `unlimited` containers
- Total allocation = sum of all containers where `unlimited === false`
- `MEMORY_SNAP_BYTES` stays at 64MB (unchanged)

> **Research insight (cgroups v2):** On cgroups v2 (this Proxmox host), setting a memory limit below current usage causes **immediate OOM kill with no error returned from the API**. Consider blocking (throwing `ValidationError`) instead of just warning when `snappedLimit < currentUsage`.

### Over-Budget on First Deploy

When this feature deploys, the sum of all tracked limits may exceed `hostTotal - 512MB`. Handle gracefully:

- Show a red "Over Budget" warning on the host bar
- Allow decreases (which bring the system toward budget)
- Block increases until total is under budget

**Concrete validation logic** (replaces current `docker-client.ts:289-293`):

```typescript
const isIncrease = snappedLimit > oldLimit;
const newTotal = otherContainersTotal + snappedLimit;

if (isIncrease && newTotal > maxAllocatable) {
    throw new ValidationError(
        `Cannot increase: total allocation would be ${formatBytes(newTotal)}, ` +
        `exceeding max ${formatBytes(maxAllocatable)} ` +
        `(host ${formatBytes(hostTotalBytes)} - ${formatBytes(OS_RESERVE_BYTES)} OS reserve)`,
    );
}
```

Note: `isIncrease` compares `snappedLimit` against `oldLimit` (from inspect at line 268), not against the raw input. A decrease that is still above budget is correctly allowed.

> **Research insight:** Log a `console.warn()` whenever a memory update is applied while over-budget. Creates an audit trail for capacity planning at zero cost.

### Self-Modification Safety

Two containers are dangerous to resize from the dashboard:

- **docker-proxy**: Communication channel to Docker. Reducing it could kill the dashboard's ability to talk to Docker.
- **dashboard**: Reducing below usage OOM-kills the dashboard itself.

**Server-side guard** (client `confirm()` is trivially bypassed by direct API calls):

```typescript
// In validateAndUpdateMemory() or the POST handler
const serviceName = inspect.Config?.Labels?.["com.docker.compose.service"] || "";
if (serviceName === "dashboard" && snappedLimit < Math.max(currentUsage * 1.5, 128 * 1024 * 1024)) {
    throw new ValidationError(
        `Dashboard minimum is MAX(current usage × 1.5, 128MB). ` +
        `Current usage: ${formatBytes(currentUsage)}. Use 'docker update' from CLI for lower values.`
    );
}
if (serviceName === "docker-proxy" && snappedLimit < 64 * 1024 * 1024) {
    throw new ValidationError(`Docker-proxy minimum is 64MB. Use 'docker update' from CLI for lower values.`);
}
```

**Client-side confirmation dialog** (defense-in-depth, not sole protection):

```javascript
if (hasSensitiveChanges) {
    var ok = confirm(
        'WARNING: You are adjusting memory for: ' + sensitiveNames.join(', ') + '\n\n' +
        'These containers are required for dashboard operation. ' +
        'Reducing memory too aggressively may cause the dashboard to become unreachable.\n\n' +
        'If the dashboard becomes unresponsive, use "docker update --memory=<bytes> <container>" from the host CLI to recover.\n\n' +
        'Continue?'
    );
    if (!ok) return;
}
```

### Unlimited Container Handling (cloudflared)

- Displayed with "No Limit" badge and dashed border (breaks the solid-border visual pattern, communicating "different rules")
- Excluded from allocation sum
- A persistent info badge on the host bar: "1 container has no memory limit"
- Slider starts at 0 with "No Limit" text in the limit display — normal interaction (moving the slider creates a pending change)
- First touch on the slider sets `memoryContainerStates[id] = 'adjusting'` to prevent SSE re-render from resetting the card

> **Race condition fix:** Without setting `adjusting` state on first slider interaction, the next SSE tick would re-render the card with `limit === 0`, resetting the slider.

> **Simplification:** No "Set Limit" button, no disabled slider, no two-state card rendering. The slider at 0 communicates "no limit" and the user just drags it to set one.

## Technical Approach

### Phase 1: Backend — `src/docker-client.ts`

**New types and constants:**

```typescript
// src/docker-client.ts
export type ContainerCategory = "infra" | "dev";

/**
 * Reserved for Linux kernel, systemd, and base system services.
 * On a headless Proxmox VM, kernel + system services use ~200-500MB.
 * Previously 2GB when infra containers were untracked.
 */
export const OS_RESERVE_BYTES = 512 * 1024 * 1024;
export const MIN_MEMORY_BYTES = 64 * 1024 * 1024;  // 64MB floor (docker-proxy's current limit)
export const MEMORY_SNAP_BYTES = 64 * 1024 * 1024;  // unchanged
```

**Shared container scoping helper:**

```typescript
// Guarantees getAllContainers() and getContainerMemoryLimits() use the same scope
function isRelevantContainer(
    c: DockerContainer,
    composeProject: string,
): boolean {
    if (c.Labels["borg.type"] === "dev-container") return true;
    if (composeProject && c.Labels["com.docker.compose.project"] === composeProject) return true;
    return false;
}
```

**New function: `getAllContainers(baseUrl, composeProject)`**

```typescript
export async function getAllContainers(
    baseUrl: string,
    composeProject: string,
): Promise<ContainerInfo[]> {
    // Two parallel filtered queries (push filtering to Docker API)
    const [composeContainers, devContainers] = await Promise.all([
        composeProject
            ? fetchDockerJson<DockerContainer[]>(
                baseUrl,
                `/containers/json?all=true&filters={"label":["com.docker.compose.project=${composeProject}"]}`,
            )
            : Promise.resolve([]),
        fetchDockerJson<DockerContainer[]>(
            baseUrl,
            '/containers/json?all=true&filters={"label":["borg.type=dev-container"]}',
        ),
    ]);

    // Merge and deduplicate by Id
    const seen = new Set<string>();
    const relevant: DockerContainer[] = [];
    for (const c of [...composeContainers, ...devContainers]) {
        if (!seen.has(c.Id)) {
            seen.add(c.Id);
            relevant.push(c);
        }
    }

    // Parallel inspect + stats (TWO-LEVEL Promise.allSettled — must match getDevContainers pattern)
    const settled = await Promise.allSettled(
        relevant.map(async (c) => {
            const name = (c.Names[0] || "").replace(/^\//, "");
            // ... (same inspect + stats pattern as getDevContainers lines 144-168)

            // Determine "unlimited" from inspect, NOT stats
            const isUnlimited = inspect.HostConfig.Memory === 0;
            const limit = isUnlimited ? 0 : (stats?.memory_stats?.limit || inspect.HostConfig.Memory || 0);

            // Classify category
            const category: ContainerCategory =
                c.Labels["borg.type"] === "dev-container" ? "dev" : "infra";

            return {
                // ... all existing fields ...
                memory: { usage, limit, usagePercent: ..., unlimited: isUnlimited },
                category,
            } satisfies ContainerInfo;
        }),
    );

    // Collect fulfilled results (graceful degradation — same as getDevContainers lines 188-193)
    const results: ContainerInfo[] = [];
    for (const result of settled) {
        if (result.status === "fulfilled") results.push(result.value);
    }

    // Sort: infra by memory usage desc, then dev by memory usage desc
    results.sort((a, b) => {
        if (a.category !== b.category) return a.category === "infra" ? -1 : 1;
        return b.memory.usage - a.memory.usage;
    });
    return results;
}
```

> **Research insight:** The `c.State === "running"` guard for stats calls must be preserved — calling `stats?stream=false` on stopped containers returns 409.

> **Performance insight:** `stats?stream=false` is the dominant cost (~1-2s per call for CPU sampling). At 10 containers with parallel calls, tick duration is ~3-4s. The 5s interval with the overlap guard will handle this, but at 20+ containers, consider tiered polling (infra stats every 15s, dev stats every 5s) as a follow-up optimization.

**Refactor `getDevContainers()` to delegate** (MUST not stay as parallel implementation):

```typescript
export async function getDevContainers(baseUrl: string): Promise<ContainerInfo[]> {
    // Delegate to getAllContainers to prevent code duplication (#1 recurring risk per MEMORY.md)
    const composeProject = process.env.COMPOSE_PROJECT || "";
    const all = await getAllContainers(baseUrl, composeProject);
    return all.filter(c => c.category === "dev");
}
```

> **Institutional learning:** Code duplication between `dashboard.ts` and `mcp-tools.ts` was the #1 recurring risk in cycle 2 reviews. Two parallel container-fetching implementations WILL diverge. `getDevContainers` delegating to `getAllContainers` eliminates this.

> **Performance note:** `getDevContainers()` now fetches all containers instead of just dev-only. For MCP tools this is slightly more expensive. If this becomes a concern, `getAllContainers` can accept an optional `{ labelFilter }` parameter to push filtering server-side. But at ~10 containers the difference is negligible.

**Update `getContainerMemoryLimits()`** — same scope as `getAllContainers`:

```typescript
async function getContainerMemoryLimits(
    baseUrl: string,
    composeProject: string,
): Promise<Array<{ id: string; memoryLimit: number }>> {
    // Same two filtered queries as getAllContainers
    const [composeContainers, devContainers] = await Promise.all([
        composeProject
            ? fetchDockerJson<DockerContainer[]>(baseUrl,
                `/containers/json?all=true&filters={"label":["com.docker.compose.project=${composeProject}"]}`)
            : Promise.resolve([]),
        fetchDockerJson<DockerContainer[]>(baseUrl,
            '/containers/json?all=true&filters={"label":["borg.type=dev-container"]}'),
    ]);

    // Merge, deduplicate, parallel inspect
    // ...same merge pattern...

    return settled
        .filter((r): r is PromiseFulfilledResult<...> => r.status === "fulfilled")
        .map(r => r.value)
        .filter(c => c.memoryLimit > 0);  // Explicit: exclude unlimited from budget
}
```

**Update `validateAndUpdateMemory()`:**

```typescript
export async function validateAndUpdateMemory(
    baseUrl: string,
    containerId: string,
    newLimitBytes: number,
    hostTotalBytes: number,
    composeProject: string,  // NEW: for scoped limits query
): Promise<MemoryUpdateResult> {
    // Container ID validation (defense-in-depth — currently missing)
    if (!isValidContainerId(containerId)) {
        throw new ValidationError("Invalid container ID format");
    }

    // Minimum memory check (single constant)
    if (newLimitBytes < MIN_MEMORY_BYTES) {
        throw new ValidationError(`Limit too low. Minimum is ${formatBytes(MIN_MEMORY_BYTES)}`);
    }

    // Snap to 64MB increment
    const snappedLimit = Math.round(newLimitBytes / MEMORY_SNAP_BYTES) * MEMORY_SNAP_BYTES;

    // Inspect the container
    const inspect = await fetchDockerJson<DockerContainerInspect>(
        baseUrl, `/containers/${containerId}/json`
    );
    const containerName = (inspect.Name || "").replace(/^\//, "");
    const oldLimit = inspect.HostConfig.Memory || 0;

    // Server-side self-modification guards
    const serviceName = inspect.Config?.Labels?.["com.docker.compose.service"] || "";
    // ... (dashboard/docker-proxy minimum enforcement as shown above)

    // Read current memory usage for OOM warning
    let currentUsage = 0;
    if (inspect.State.Status === "running") { /* ... existing stats call ... */ }

    // Directional validation: allow decreases when over-budget
    const allLimits = await getContainerMemoryLimits(baseUrl, composeProject);
    const otherContainersTotal = allLimits
        .filter(c => c.id !== containerId)
        .reduce((sum, c) => sum + c.memoryLimit, 0);
    const maxAllocatable = hostTotalBytes - OS_RESERVE_BYTES;
    const newTotal = otherContainersTotal + snappedLimit;
    const isIncrease = snappedLimit > oldLimit;

    if (isIncrease && newTotal > maxAllocatable) {
        throw new ValidationError(
            `Cannot increase: total allocation would be ${formatBytes(newTotal)}, ` +
            `exceeding max ${formatBytes(maxAllocatable)}`
        );
    }

    // Log warning if applying while over-budget
    if (newTotal > maxAllocatable) {
        console.warn(`Memory update applied while over-budget: ${containerName} ` +
            `${formatBytes(oldLimit)} → ${formatBytes(snappedLimit)}, ` +
            `total ${formatBytes(newTotal)} / max ${formatBytes(maxAllocatable)}`);
    }

    // OOM warning / block (cgroups v2: immediate kill, no error)
    let warning: string | undefined;
    if (snappedLimit < currentUsage) {
        // On cgroups v2, this causes immediate OOM kill — consider throwing instead
        warning = `New limit (${formatBytes(snappedLimit)}) is below current usage (${formatBytes(currentUsage)}). Docker may OOM-kill this container immediately.`;
    } else if (currentUsage > 0 && snappedLimit < currentUsage * 1.25) {
        warning = `New limit (${formatBytes(snappedLimit)}) is close to current usage (${formatBytes(currentUsage)}).`;
    }

    // Apply: Memory == MemorySwap (no swap, documented best practice)
    await fetchDockerJson(baseUrl, `/containers/${containerId}/update`, "POST",
        { Memory: snappedLimit, MemorySwap: snappedLimit });

    return { id: containerId, name: containerName, oldLimit, newLimit: snappedLimit, warning };
}
```

### Phase 2: Backend — `src/dashboard.ts`

**Cache compose project at startup** (immutable for container lifetime):

```typescript
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT || "";
if (!COMPOSE_PROJECT) {
    console.warn("COMPOSE_PROJECT not set — infra containers will not be shown");
}
```

**SSE feed** (`startContainerFeed`, line 433):

Replace `getDevContainers()` with `getAllContainers(DOCKER_PROXY_URL, COMPOSE_PROJECT)`. Must preserve the broadcast pattern: single `setInterval`, `Set<http.ServerResponse>`, `try/catch` on `res.write()` with client removal, stop interval when idle. Add `unlimitedCount` to host data:

```typescript
const containers = await getAllContainers(DOCKER_PROXY_URL, COMPOSE_PROJECT);
const host = parseMeminfo();
const allocatedTotal = containers
    .filter(c => !c.memory.unlimited)
    .reduce((sum, c) => sum + c.memory.limit, 0);
const unlimitedCount = containers.filter(c => c.memory.unlimited).length;

const data = JSON.stringify({
    containers,
    host: {
        totalMemory: host.totalBytes,
        availableMemory: host.availableBytes,
        allocatedTotal,
        osReserve: OS_RESERVE_BYTES,
        unlimitedCount,
    },
});
```

**REST endpoints:**

- `GET /api/containers` — returns all containers (backward-compatible: adds `category` and `memory.unlimited` fields)
- `POST /api/containers/:id/memory` — resolve category from inspect labels before calling `validateAndUpdateMemory`:

```typescript
// In the POST handler, before calling validateAndUpdateMemory:
const inspect = await fetchDockerJson<DockerContainerInspect>(
    DOCKER_PROXY_URL, `/containers/${containerId}/json`
);
// validateAndUpdateMemory now has composeProject for scoped limits
const result = await validateAndUpdateMemory(
    DOCKER_PROXY_URL, containerId, limitBytes, host.totalBytes, COMPOSE_PROJECT
);
```

**Add `COMPOSE_PROJECT` to docker-compose.yml:**

```yaml
# dashboard service environment
environment:
  - DOCKER_PROXY_URL=http://docker-proxy:2375/v1.47
  - COMPOSE_PROJECT=${COMPOSE_PROJECT_NAME:-borg}
```

### Phase 3: Frontend — `static/dashboard.html`

**Two-section layout** (static headers, no collapsible toggle):

```html
<div id="view-memory" class="view">
    <h2>Memory Rebalancing</h2>
    <div class="memory-host-bar" id="memory-host-bar"></div>

    <div class="memory-section">
        <h3 class="memory-section-header" data-category="infra">
            Infrastructure <span id="infra-subtotal" class="memory-section-subtotal"></span>
        </h3>
        <div id="infra-cards"></div>
    </div>

    <div class="memory-section">
        <h3 class="memory-section-header" data-category="dev">
            Dev Containers <span id="dev-subtotal" class="memory-section-subtotal"></span>
        </h3>
        <div id="dev-cards"></div>
    </div>

    <div id="memory-footer">
        <button id="memory-apply-btn" disabled>Apply Changes</button>
        <div id="memory-validation-msg">No changes pending</div>
    </div>
</div>
```

**CSS additions** (follows existing utilitarian aesthetic):

```css
.memory-section-header {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 16px 0 8px;
  padding-left: 10px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.memory-section-header[data-category="infra"] { border-left: 3px solid var(--accent-purple); }
.memory-section-header[data-category="dev"] { border-left: 3px solid var(--accent-blue); }

.memory-section-subtotal {
  margin-left: auto;
  font-size: 11px;
  font-weight: 400;
  color: var(--text-secondary);
  letter-spacing: 0;
  text-transform: none;
}

.mem-card.infra { border-color: rgba(188, 140, 255, 0.2); }
.mem-card.infra .mem-card-header .name { font-size: 13px; color: var(--text-secondary); }

.mem-card.unlimited {
  border-style: dashed;
  border-color: rgba(210, 153, 34, 0.3);
}
```

**Card rendering changes (`renderMemoryCards`):**

- Split `containers` by `category`, render infra into `#infra-cards` and dev into `#dev-cards`
- **Per-card updates preserved** — find existing card by ID, update innerHTML. Never replace section innerHTML wholesale.
- Infra card names: display `com.docker.compose.service` label prefixed with `svc/` (e.g., `svc/bot`, `svc/broker`)
- Unlimited containers: show "No Limit" badge, dashed border, slider at 0 with normal interaction
- Wrap both sections in `<div id="memory-cards-wrapper">` and bind pointer/input handlers on the wrapper (single delegation point for both sections)

**Host bar** — extend existing text stats (no colored bar):

Split "Allocated" stat into two: "Infra Allocated: 2.4GB" and "Dev Allocated: 12.0GB". Add a fifth stat for unlimited containers if any: "1 container has no memory limit" in yellow.

Over-budget state: the "Available" stat turns red.

**Fix: Global pointerup listener leak** (existing bug):

```javascript
// initMemory() — store reference
var globalPointerUpHandler = function() {
    var ids = Object.keys(memoryContainerStates);
    for (var i = 0; i < ids.length; i++) {
        if (memoryContainerStates[ids[i]] === 'adjusting') {
            memoryContainerStates[ids[i]] = 'idle';
        }
    }
};
document.addEventListener('pointerup', globalPointerUpHandler);

// teardownView('memory') — remove it
document.removeEventListener('pointerup', globalPointerUpHandler);
```

**Fix: Prune stale container entries on SSE update:**

```javascript
function onMemorySSEUpdate(data) {
    var containers = data.containers || [];
    var currentIds = {};
    for (var i = 0; i < containers.length; i++) {
        currentIds[containers[i].id] = true;
        memoryServerData[containers[i].id] = containers[i];
    }
    // Prune entries for containers that disappeared
    Object.keys(memoryServerData).forEach(function(id) {
        if (!currentIds[id]) {
            delete memoryServerData[id];
            delete memoryPendingChanges[id];
            delete memoryContainerStates[id];
        }
    });
    // ... render both sections ...
}
```

**Footer validation** — three states:

1. **Under budget, no changes**: Gray "No changes pending"
2. **Under budget, valid changes**: Green "X.XGB remaining after changes"
3. **Over budget, all decreases**: Yellow "Over budget by X.XGB. Decreases allowed." (Apply enabled)
4. **Over budget, any increase**: Red "Cannot increase while over budget." (Apply disabled)

**Apply flow** — note for implementer: cross-section rebalances are NOT atomic. If the first change succeeds and the second fails, the system is in a partially-applied state. The existing per-container error reporting handles this correctly.

### Phase 4: MCP Tools — `src/mcp-tools.ts` + `src/session-manager.ts`

> **Why this phase was added:** The shared validation code (`OS_RESERVE_BYTES`, `getContainerMemoryLimits`, `validateAndUpdateMemory`) changes in Phase 1 affect MCP tools whether we want them to or not. Without explicit MCP updates, the agent operates on stale budget numbers (2GB reserve when the dashboard uses 512MB) — two divergent validation models running simultaneously.

**Extend `get_container_stats` to return all containers:**

```typescript
// mcp-tools.ts — in get_container_stats tool handler
// FROM: const containers = await getDevContainers(DOCKER_PROXY_URL);
// TO:
const containers = await getAllContainers(DOCKER_PROXY_URL, process.env.COMPOSE_PROJECT || "");
```

Output format includes category tag:

```
broker: running | infra | 45MB / 128MB (35.2%) | 0.0 CPUs | 3d 2h
bot: running | infra | 1.2GB / 2.0GB (60.0%) | 2.0 CPUs | 3d 2h
cloudflared: running | infra | no limit | 0.0 CPUs | 3d 2h
dev-alice: running | dev | port 2201 | 800MB / 2048MB (39.1%) | 2.0 CPUs | 1d 4h
```

Available to all threads (read-only). No access change needed.

**Extend `update_container_memory` to accept infra containers (master-only):**

Remove the `borg.type=dev-container` label filter when looking up containers. Apply the same server-side safety guards as the dashboard. The existing `warning` field in `MemoryUpdateResult` surfaces OOM risk to the agent.

**Update `get_host_memory` to show category breakdown:**

```
Total Memory:       32.0GB
OS Reserve:         512MB
Infra Allocated:    2.4GB (5 containers, 1 unlimited)
Dev Allocated:      12.0GB (6 containers)
Available Budget:   17.1GB
```

**Update system prompt** in `session-manager.ts`:

```typescript
// FROM:
"- `get_container_stats` — Get memory usage for all dev containers"
// TO:
"- `get_container_stats` — Get memory usage for all containers (infra + dev) with category tags"
```

**Add `COMPOSE_PROJECT` to bot container environment in docker-compose.yml:**

```yaml
# bot service environment (for MCP tools)
environment:
  - COMPOSE_PROJECT=${COMPOSE_PROJECT_NAME:-borg}
```

## Acceptance Criteria

- [ ] Memory view shows two sections: Infrastructure and Dev Containers
- [ ] Infrastructure section shows broker, bot, docker-proxy, dashboard, cloudflared
- [ ] Dev containers section works exactly as before (no regression)
- [ ] Cloudflared shown as "No Limit" with dashed border and slider at 0
- [ ] Host bar shows split text stats (Infra Allocated / Dev Allocated / OS Reserve / Available)
- [ ] Section subtotals display correctly
- [ ] Validation sums ALL container limits (excluding unlimited) against hostTotal - 512MB
- [ ] Over-budget state allows decreases, blocks increases
- [ ] Server-side minimum enforcement for dashboard (128MB or 1.5x usage) and docker-proxy (64MB)
- [ ] Client-side confirmation dialog for dashboard/docker-proxy changes
- [ ] SSE feed broadcasts all containers every 5s using broadcast pattern
- [ ] Slider interaction states (adjusting/applying/idle) work for both sections
- [ ] Stale container entries pruned on SSE update
- [ ] Global pointerup listener cleaned up in teardown
- [ ] MCP `get_container_stats` returns all containers with category tags
- [ ] MCP `update_container_memory` works on infra containers (master-only)
- [ ] MCP `get_host_memory` shows infra/dev allocation breakdown
- [ ] Partial apply failure shows clear error with succeeded changes reflected

## Simplifications Applied

- **No per-container minimum config** — single `MIN_MEMORY_BYTES = 64MB` for all. OOM warning is the safety net.
- **No audit log** — memory changes not logged to JSONL (console.warn for over-budget only). Can be added later.
- **No optimistic concurrency control** — last write wins for concurrent dashboard users. SSE eventually converges.
- **No custom infra container names** — display `com.docker.compose.service` as-is with `svc/` prefix.
- **No tiered polling** — all containers polled at 5s interval. If performance degrades at 20+ containers, add tiered polling (infra every 15s) as follow-up.
- **No collapsible sections** — static headers. At ~10 containers total, not needed.
- **No stacked colored bar** — text stats only. Simpler, more accessible.

## Dependencies & Risks

| Risk | Mitigation |
|------|-----------|
| Over-budget on first deploy | Allow decreases, block increases, show warning |
| Dashboard self-OOM | Server-side minimum (128MB or 1.5x usage) + client confirm dialog |
| Docker-proxy communication loss | Server-side minimum (64MB) + client confirm dialog + CLI recovery |
| Other compose projects' containers shown | Filtered Docker API queries scoped by `COMPOSE_PROJECT` env var |
| Cloudflared consuming unbounded memory | Warning badge, dashed border, encourage setting a limit |
| Two validation models diverging | MCP tools updated in Phase 4 (same shared code) |
| `stats?stream=false` latency at scale | Overlap guard handles up to ~15 containers; tiered polling deferred |
| Cross-section rebalance not atomic | Per-container error reporting shows partial success state |

## References

- `src/docker-client.ts` — all Docker API functions, `ContainerInfo` type, validation logic
- `src/dashboard.ts:427-473` — SSE container feed, broadcast pattern
- `static/dashboard.html:1715-2058` — memory view JavaScript, card rendering, apply flow
- `src/host-metrics.ts` — `parseMeminfo()` for host total/available memory
- `src/mcp-tools.ts:171-289` — MCP tools for container stats, memory update, host memory
- `src/session-manager.ts:239-263` — system prompt MCP tools block
- `docker-compose.yml` — infrastructure container definitions and memory limits
- `docs/solutions/architecture-reviews/code-review-cycle-2-systemic-patterns-and-prevention.md` — SSE broadcast pattern, shared modules, input validation, agent-native parity
- `docs/solutions/architecture-reviews/agent-driven-container-lifecycle-onboarding.md` — branded types, container ID validation, label-verified operations

### External References

- [Docker `POST /containers/{id}/update`](https://docs.docker.com/reference/api/engine/version/v1.47/) — live memory limit changes, stopped container support
- [Docker Resource Constraints](https://docs.docker.com/engine/containers/resource_constraints/) — `Memory == MemorySwap` (no swap) pattern
- [Docker Runtime Metrics](https://docs.docker.com/engine/containers/runmetrics/) — `memory_stats.limit` returns host total for unlimited containers
- [Compose Labels](https://github.com/docker/libcompose/blob/master/labels/labels.go) — `com.docker.compose.project`, `.service` — stable 10+ years
- [runc #3509](https://github.com/opencontainers/runc/issues/3509) — cgroups v2 immediate OOM kill when limit < usage
