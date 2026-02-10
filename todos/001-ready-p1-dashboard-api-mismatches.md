---
status: resolved
priority: p1
issue_id: "001"
tags: [code-review, quality, dashboard]
dependencies: []
---

# Dashboard Frontend-Backend API Mismatches (4 of 7 Views Broken)

## Problem Statement

The dashboard frontend (`static/dashboard.html`) and backend (`src/dashboard.ts`) disagree on multiple API contracts. 4 of 7 dashboard views are non-functional due to endpoint/shape mismatches. The dashboard cannot provide monitoring value until these are fixed.

## Findings

**Source**: code-simplicity-reviewer agent

**Mismatch A**: `/api/messages/recent` does not exist.
- `static/dashboard.html:989` calls `api('/api/messages/recent?n=50')`
- Backend has no `GET /api/messages/recent` endpoint. Only `/api/threads/:id/messages` exists.

**Mismatch B**: `/api/threads/:id` (without `/messages`) does not exist.
- `static/dashboard.html:1069` calls `api('/api/threads/' + threadId)` expecting `{ config, messages }`
- Backend only serves `/api/threads` (full map) and `/api/threads/:id/messages`

**Mismatch C**: Overview stats shape disagreement.
- Frontend expects: `data.system.cpuPercent`, `data.system.ramUsedMB`, `data.system.loadAverage` (array)
- Backend returns: `data.metrics.cpu`, `data.metrics.mem.usedMB`, `data.metrics.load.load1` (nested objects)

**Mismatch D**: Threads rendering.
- Frontend at line 918 does `Object.keys(threads)` treating `data.threads` as a map
- Backend returns `data.threads` as an array of `{ id, ...cfg }` objects (line 264-268)

## Proposed Solutions

### Option 1: Fix frontend to match backend (Recommended)
Update `static/dashboard.html` to use the actual API contract from `src/dashboard.ts`.
- Pros: Backend is likely the "source of truth" since it matches actual data structures
- Cons: Need to verify every frontend reference
- Effort: Medium (2-3 hours)
- Risk: Low

### Option 2: Fix backend to match frontend
Add missing endpoints and reshape responses to match frontend expectations.
- Pros: Frontend HTML is already written and may have been user-tested
- Cons: Adds complexity to backend; frontend expectations may be arbitrary
- Effort: Medium (2-3 hours)
- Risk: Low

## Recommended Action

(Leave blank for triage)

## Technical Details

**Affected files**:
- `static/dashboard.html` (lines 858-867, 918, 989, 1069)
- `src/dashboard.ts` (lines 243-271, 264-268, 280-289)

## Acceptance Criteria

- [ ] All 7 dashboard views render correctly with real data
- [ ] Frontend API calls match backend endpoint paths
- [ ] Response shapes match frontend destructuring
- [ ] SSE streams connect and display live data

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-10 | Created from code review | Frontend and backend were likely developed in parallel without integration testing |

## Resources

- PR branch: `feat/agent-sdk-v2-telegram-forum`
- Plan: `docs/plans/2026-02-10-feat-production-docker-dashboard-broker-plan.md`
