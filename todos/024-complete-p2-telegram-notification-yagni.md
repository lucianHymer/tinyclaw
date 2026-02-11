---
status: ready
priority: p2
issue_id: "024"
tags: [code-review, simplicity, yagni]
dependencies: []
---

# Telegram Notification on Memory Change Contradicts Plan's Simplification

## Problem Statement

The plan's "Simplifications Applied" section explicitly states: "Deferred Telegram notification on memory changes -- admin already sees the change." Yet `notifyMemoryChange()` was implemented (25 LOC). This is one of nine claimed simplifications, and the only one violated.

## Findings

**Source**: code-simplicity-reviewer

**Location**: `/workspace/project/src/dashboard.ts` lines 388-393 (`readSettingsForDashboard`), 533-551 (`notifyMemoryChange`), 714 (call site)

Also: the `notifyMemoryChange` call at line 714 is not `await`ed, creating a silently discarded Promise.

## Proposed Solutions

### Option 1: Remove (Recommended)

Delete `notifyMemoryChange()`, `readSettingsForDashboard()`, and the call at line 714. Add back when actually needed.

### Option 2: Keep but fix the missing await

Add `void` prefix: `void notifyMemoryChange(...)` to make intent explicit.

## Recommended Action

Option 1 -- respect the plan's own simplification decision.

## Acceptance Criteria

- [ ] `notifyMemoryChange` and `readSettingsForDashboard` removed
- [ ] OR: Promise handling fixed with `void` prefix

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-11 | Created from code review | 1 of 9 claimed simplifications violated |
