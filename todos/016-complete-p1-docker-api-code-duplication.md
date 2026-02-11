---
status: ready
priority: p1
issue_id: "016"
tags: [code-review, architecture, quality]
dependencies: []
---

# Docker API Code Duplication Between dashboard.ts and mcp-tools.ts

## Problem Statement

Docker container management logic is independently implemented in both `dashboard.ts` and `mcp-tools.ts`. The two implementations have **divergent behavior**: the dashboard validates total allocation against host capacity, snaps to 64MB increments, warns about OOM risks, and sends Telegram notifications. The MCP tool does none of this. An agent using the MCP tool could over-allocate memory beyond host capacity.

## Findings

**Source**: kieran-typescript-reviewer, architecture-strategist, pattern-recognition-specialist, agent-native-reviewer, code-simplicity-reviewer

**Duplicated operations**:

| Operation | dashboard.ts | mcp-tools.ts |
|-----------|-------------|--------------|
| List dev containers | `getDevContainers()` line 473 | `getContainerStats` tool, line 148 |
| Fetch container stats | `fetchDockerStats()` line 463 | Inline fetch, line 179 |
| Inspect container | `fetchDockerJson<>()` line 490 | Inline fetch, line 194 |
| Update memory | POST handler line 643 | `updateContainerMemory` tool, line 237 |
| MIN_MEMORY constant | `MIN_MEMORY_BYTES` line 19 | `MIN_LIMIT` line 243 |
| Label filter | Same literal string | Same literal string |

**Behavioral divergence in memory update**:
- Dashboard: snap to 64MB, validate total allocation, OOM warning, Telegram notification
- MCP tool: 256MB minimum check only -- no allocation validation, no snap, no OOM warning

**Additional divergence**: `DOCKER_PROXY_URL` defaults differ (`localhost:2375` vs `docker-proxy:2375`).

## Proposed Solutions

### Option 1: Extract shared docker-client.ts module (Recommended)

Create `src/docker-client.ts` containing:
- All Docker API interfaces (`DockerContainer`, `DockerContainerInspect`, `DockerStats`, `ContainerInfo`)
- `fetchDockerJson<T>(baseUrl, path, method?, body?)`
- `fetchDockerStats(baseUrl, containerId)`
- `getDevContainers(baseUrl): Promise<ContainerInfo[]>`
- `validateAndUpdateMemory(baseUrl, containerId, newLimitBytes)` with full validation
- Shared constants: `MIN_MEMORY_BYTES`, `OS_RESERVE_BYTES`, `MEMORY_SNAP_BYTES`

Both `dashboard.ts` and `mcp-tools.ts` import from it, passing `DOCKER_PROXY_URL` as a parameter.

- Pros: Single source of truth, MCP tools gain allocation validation, ~180 LOC reduction
- Cons: Requires refactoring two files
- Effort: Medium
- Risk: Low

### Option 2: MCP tools call dashboard HTTP API

MCP tools call `http://dashboard:3100/api/containers` instead of talking to Docker directly.

- Pros: Zero duplication, permanent consistency
- Cons: Adds network dependency; MCP tools fail if dashboard is down
- Effort: Small
- Risk: Medium (availability coupling)

## Recommended Action

Option 1 -- extract shared module. This is the most impactful structural improvement in this branch.

## Technical Details

**Affected files**: `src/dashboard.ts`, `src/mcp-tools.ts`
**New file**: `src/docker-client.ts`

## Acceptance Criteria

- [ ] Shared `docker-client.ts` module exists with Docker API interfaces, fetch helpers, and validation
- [ ] `dashboard.ts` imports from `docker-client.ts` (no inline Docker types/fetching)
- [ ] `mcp-tools.ts` imports from `docker-client.ts` (no inline Docker types/fetching)
- [ ] MCP `update_container_memory` tool performs total allocation validation
- [ ] `DOCKER_PROXY_URL` is passed as a parameter, not duplicated as constants
- [ ] `MIN_MEMORY_BYTES` defined once in the shared module

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-11 | Created from code review | 6 of 8 agents flagged this independently |
