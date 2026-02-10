---
status: resolved
priority: p1
issue_id: "004"
tags: [code-review, architecture, data-loss, pattern-violation]
dependencies: []
---

# Non-Atomic Outgoing Queue Write in queue-processor.ts

## Problem Statement

`queue-processor.ts:530` writes outgoing responses directly with `writeFileSync` instead of the `.tmp` + `renameSync` atomic write pattern used everywhere else in the codebase. If the process is killed mid-write, the telegram-client reads a partial JSON file, fails to parse it, logs an error, and `unlinkSync`s the corrupt file -- permanently losing the agent response.

## Findings

**Source**: architecture-strategist agent, pattern-recognition-specialist agent

File: `src/queue-processor.ts` line 530:
```typescript
fs.writeFileSync(responseFile, JSON.stringify(responseData, null, 2));
```

Every other file write in the codebase uses atomic writes:
- `session-manager.ts` `saveThreads()`: `.tmp` + `renameSync`
- `telegram-client.ts` `saveMessageModels()`: `.tmp` + `renameSync`
- `telegram-client.ts` message queueing: `.tmp` + `renameSync`
- `mcp-tools.ts` cross-thread write: `.tmp` + `renameSync`

The plan document explicitly states: "Atomic file writes (.tmp + rename) protect against reader corruption -- maintain this pattern in all new code."

## Proposed Solutions

### Option 1: Apply atomic write pattern (Recommended)
```typescript
const tmpFile = responseFile + ".tmp";
fs.writeFileSync(tmpFile, JSON.stringify(responseData, null, 2));
fs.renameSync(tmpFile, responseFile);
```
- Pros: Consistent with codebase convention, prevents data loss
- Cons: None
- Effort: Small (5 minutes)
- Risk: None

## Technical Details

**Affected files**:
- `src/queue-processor.ts` (line 530)

## Acceptance Criteria

- [ ] Outgoing queue writes use `.tmp` + `renameSync` pattern
- [ ] No direct `writeFileSync` to queue directories

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-10 | Created from code review | Always grep for `writeFileSync` to queue dirs after adding new write paths |
