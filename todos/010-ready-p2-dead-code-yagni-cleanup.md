---
status: resolved
priority: p2
issue_id: "010"
tags: [code-review, quality, dead-code]
dependencies: []
---

# Dead Code and YAGNI Cleanup

## Problem Statement

Multiple dead code artifacts and YAGNI violations exist from rapid architectural iteration (WhatsApp -> Discord -> Telegram, SDK v2 -> v1, bare-metal -> Docker). These add cognitive load and ~94 lines of unnecessary code.

## Findings

**Source**: code-simplicity-reviewer, git-history-analyzer, pattern-recognition-specialist agents

**Dead functions/exports**:
1. `tailJsonl` in `src/dashboard.ts:26-73` -- 47 lines, suppressed with `void tailJsonl`, comment says "future extensions"
2. `expandPath` in `src/routing-logger.ts:80-86` -- 8 lines, exported but never imported
3. `cleanupIdleSessions` in `src/session-manager.ts:229-250` -- 22 lines, for non-existent in-memory session map (SDK v2 vestige)
4. `SESSION_IDLE_TIMEOUT_MS` in `src/session-manager.ts:45` -- only used by dead `cleanupIdleSessions`
5. `queueInterval` in `src/queue-processor.ts:706` -- assigned but never cleared in shutdown handler

**Orphaned files**:
6. `systemd/tinyclaw-telegram.service` -- replaced by `systemd/tinyclaw.service`
7. `systemd/tinyclaw-queue.service` -- replaced by `systemd/tinyclaw.service`
8. `setup-wizard.sh` -- orphaned after Docker migration

**Orphaned dependency**:
9. `@grammyjs/auto-chat-action` in `package.json` -- never imported (removed from code in 77f743a but package kept)

**Minor**:
10. `MyContext` type alias in `telegram-client.ts:24` -- `type MyContext = Context` adds nothing

## Proposed Solutions

### Option 1: Delete all dead code in one cleanup pass (Recommended)
- Remove items 1-5 from source files (-94 LOC)
- Delete items 6-8 (orphaned files)
- Remove item 9 from package.json
- Remove item 10
- Effort: Small (30 minutes)
- Risk: None (all confirmed unused via grep)

## Technical Details

**Affected files**:
- `src/dashboard.ts` (remove lines 20-73)
- `src/routing-logger.ts` (remove expandPath)
- `src/session-manager.ts` (remove cleanupIdleSessions, SESSION_IDLE_TIMEOUT_MS)
- `src/queue-processor.ts` (clear queueInterval in shutdown)
- `src/telegram-client.ts` (remove MyContext alias)
- `package.json` (remove @grammyjs/auto-chat-action)
- Delete: `systemd/tinyclaw-telegram.service`, `systemd/tinyclaw-queue.service`, `setup-wizard.sh`

## Acceptance Criteria

- [ ] `npm run build` succeeds after cleanup
- [ ] No unused exports remain
- [ ] No orphaned systemd files
- [ ] No unused npm dependencies

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-10 | Created from code review | Rapid iteration leaves dead code; schedule cleanup passes |
