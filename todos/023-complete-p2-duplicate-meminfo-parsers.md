---
status: ready
priority: p2
issue_id: "023"
tags: [code-review, quality, dashboard]
dependencies: ["016"]
---

# Duplicate /proc/meminfo Parsers in dashboard.ts

## Problem Statement

`dashboard.ts` has two separate functions that parse `/proc/meminfo`:
- `parseMeminfo()` (line 64) returns MB via `PROC_BASE`
- `getHostMemoryBytes()` (line 406) returns bytes via `PROC_MEMINFO`

Two path constants (`PROC_BASE`, `PROC_MEMINFO`) resolve to the same directory. Also `readSettingsForDashboard()` duplicates `loadSettings()` from session-manager.ts. And an unused `pid` variable (lines 487, 496) is assigned but never read.

## Findings

**Source**: kieran-typescript-reviewer, pattern-recognition-specialist, code-simplicity-reviewer

## Proposed Solutions

1. Consolidate into one function returning bytes, convert to MB at call sites
2. Remove `PROC_MEMINFO` constant, keep only `PROC_BASE`
3. Remove unused `pid` variable
4. Import settings reading from session-manager.ts or accept the narrow type

- Effort: Small

## Acceptance Criteria

- [ ] Single /proc/meminfo parser function
- [ ] Single PROC path constant
- [ ] No unused variables

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-11 | Created from code review | Multiple agents flagged independently |
