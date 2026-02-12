---
status: done
priority: p2
issue_id: "021"
tags: [code-review, security, dashboard]
dependencies: []
---

# Unbounded `n` Query Parameter on Several Endpoints

## Problem Statement

Several API endpoints accept an `n` query parameter without an upper bound, while others correctly cap at 200. Requesting `?n=999999999` could cause excessive memory consumption.

## Findings

**Source**: security-sentinel (MEDIUM-01)

**Uncapped endpoints** (`src/dashboard.ts`):
- Line 238: `/api/threads/:id/messages`
- Line 249: `/api/messages/recent`
- Line 331: `/api/routing/recent`
- Line 338: `/api/prompts/recent`

**Correctly capped endpoints**:
- Line 787: `/api/threads/:id/session-logs` -- `Math.min(n, 200)`
- Line 812: `/api/session-logs` -- `Math.min(n, 200)`

## Proposed Solutions

Apply `Math.min(n, 200)` consistently across all endpoints accepting `n`.

- Effort: Tiny (4 one-line changes)

## Acceptance Criteria

- [x] All endpoints with `n` parameter cap at 200

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-11 | Created from code review | Inconsistent validation pattern |
| 2026-02-11 | Applied Math.min(n, 200) to all 4 uncapped endpoints | All 6 endpoints now consistent |
