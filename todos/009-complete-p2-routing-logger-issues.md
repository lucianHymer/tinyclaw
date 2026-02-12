---
status: resolved
priority: p2
issue_id: "009"
tags: [code-review, pattern-violation, performance]
dependencies: []
---

# Routing Logger: Async Fire-and-Forget, No Rotation, ensureDir Race

## Problem Statement

`src/routing-logger.ts` diverges from established codebase patterns in three ways:
1. Uses async `appendFile` with `.catch(() => {})` (fire-and-forget) instead of sync `appendFileSync`
2. Has no log rotation (unlike message-history at 10MB and prompt log at 10MB)
3. `ensureDir` uses fire-and-forget async `mkdir`, so the first log write on cold start silently fails

## Findings

**Source**: architecture-strategist agent, pattern-recognition-specialist agent, performance-oracle agent

File: `src/routing-logger.ts`
- Line 70: `appendFile(logPath, ...).catch(() => {})` -- async, fire-and-forget
- Lines 24-40: `ensureDir` returns before `mkdir` completes
- Uses `node:` import prefix (inconsistent with all other files)
- Exports `expandPath` (dead code, never imported)

At one message per minute: ~6.5MB/month routing log growth. After months of operation, unbounded.

## Proposed Solutions

### Option 1: Align with established patterns (Recommended)
- Replace async `appendFile` with sync `appendFileSync`
- Add 10MB rotation matching `message-history.ts` pattern
- Remove `ensureDir` (queue-processor already creates logs directory at startup)
- Delete `expandPath` (dead code)
- Normalize imports to bare names (no `node:` prefix)
- Effort: Small (30 minutes)
- Risk: Low

## Technical Details

**Affected files**:
- `src/routing-logger.ts`

## Acceptance Criteria

- [ ] Routing logger uses `appendFileSync` (sync)
- [ ] Routing log rotates at 10MB
- [ ] `expandPath` and `ensureDir` removed
- [ ] Import style matches codebase convention

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-10 | Created from code review | File was likely written quickly and not reviewed against existing patterns |
