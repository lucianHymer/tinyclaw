---
status: done
priority: p1
issue_id: "017"
tags: [code-review, performance]
dependencies: ["016"]
---

# Sequential N+1 Docker API Calls in getDevContainers()

## Problem Statement

`getDevContainers()` in dashboard.ts makes 2N+1 sequential HTTP requests (1 list + N inspect + N stats). The Docker `/stats?stream=false` endpoint takes 1-2 seconds per call. With 10 containers, this is 10-20 seconds of sequential waiting. Since this runs every 5 seconds in the SSE container feed, polling cycles will overlap and cascade at scale.

The same pattern is duplicated in `mcp-tools.ts` `getContainerStats` tool.

## Findings

**Source**: performance-oracle (CRITICAL-1, CRITICAL-2, CRITICAL-3)

**dashboard.ts lines 473-531**: Sequential `for` loop with `await fetchDockerJson` + `await fetchDockerStats` per container.

**mcp-tools.ts lines 170-208**: Identical sequential pattern.

**POST /api/containers/:id/memory (line 643)**: Makes 4 sequential calls PLUS a full `getDevContainers()` call (2N+1 more) just for validation. Total: 2N+4 calls for a single memory update.

**SSE overlap risk**: `setInterval` with async callback does not wait for previous invocation. If polling takes >5s, cycles overlap.

## Proposed Solutions

### Option 1: Parallelize with Promise.allSettled (Recommended)

```typescript
const results = await Promise.allSettled(
    containers.map(async (c) => {
        const [inspect, stats] = await Promise.allSettled([
            fetchDockerJson<DockerContainerInspect>(`/containers/${c.Id}/json`),
            c.State === "running" ? fetchDockerStats(c.Id) : Promise.resolve(null),
        ]);
        // ... build ContainerInfo from settled results
    })
);
```

Additionally, add overlap guard to SSE polling and add `AbortSignal.timeout(10_000)` to all Docker fetch calls.

- Pros: Reduces latency from O(N) to O(1); prevents SSE stacking
- Cons: More concurrent connections to Docker daemon
- Effort: Small-Medium
- Risk: Low

## Recommended Action

Option 1. Should be done as part of the docker-client.ts extraction (todo 016).

## Acceptance Criteria

- [x] Docker API calls within getDevContainers() are parallelized via Promise.allSettled
- [x] SSE polling has overlap guard (skip tick if previous still running)
- [x] All Docker fetch calls have a timeout (AbortSignal.timeout)
- [x] POST /api/containers/:id/memory avoids calling full getDevContainers() for validation

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-11 | Created from code review | performance-oracle flagged as P0 |
| 2026-02-11 | Implemented all 4 fixes | Promise.allSettled parallelization, overlap guard, AbortSignal.timeout, lightweight getContainerMemoryLimits |
