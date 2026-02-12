---
status: done
priority: p1
issue_id: "015"
tags: [code-review, security, dashboard]
dependencies: []
---

# Container ID Injection in Docker API Calls

## Problem Statement

Container IDs from URL path parameters are passed directly into Docker API URL construction with no validation. A crafted container ID containing path traversal characters could potentially bypass the socket proxy's allowlist regex patterns.

## Findings

**Source**: security-sentinel, kieran-typescript-reviewer

**Location**: `/workspace/project/src/dashboard.ts` lines 619, 645, 664-665

```typescript
const containerId = String(req.params.id);
const stats = await fetchDockerStats(containerId);
const inspect = await fetchDockerJson<DockerContainerInspect>(
    `/containers/${containerId}/json`,
);
```

The `fetchDockerJson` function at line 448 concatenates the container ID directly into the URL:
```typescript
const url = `${DOCKER_PROXY_URL}${urlPath}`;
```

Docker container IDs are always 64 hex characters (12 for short form). No validation enforces this.

## Proposed Solutions

### Option 1: Add container ID validation regex (Recommended)

Add a validation function and call it at each endpoint:

```typescript
function isValidContainerId(id: string): boolean {
    return /^[a-f0-9]{12,64}$/i.test(id);
}
```

- Pros: Simple, 5-line fix, high impact
- Cons: None
- Effort: Small
- Risk: None

### Option 2: URL-encode the container ID

Use `encodeURIComponent(containerId)` in URL construction.

- Pros: Prevents path traversal
- Cons: Doesn't reject invalid IDs early; obscures intent
- Effort: Small
- Risk: Low

## Recommended Action

Option 1 -- add the regex validation at each endpoint. Return 400 for invalid IDs.

## Technical Details

**Affected files**: `src/dashboard.ts` (lines 619, 645, 664)
**Affected endpoints**: `GET /api/containers/:id/stats`, `POST /api/containers/:id/memory`

## Acceptance Criteria

- [x] Container IDs are validated against `/^[a-f0-9]{12,64}$/i` before use
- [x] Invalid IDs return 400 with a clear error message
- [x] Validation applied to both GET and POST container endpoints

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-11 | Created from code review | security-sentinel flagged as CRITICAL-01 |
| 2026-02-11 | Implemented fix | Added `isValidContainerId()` to docker-client.ts, applied at both `:id` endpoints in dashboard.ts. Returns 400 for invalid IDs. Build passes. |
