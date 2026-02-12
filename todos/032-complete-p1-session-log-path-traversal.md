---
status: complete
priority: p1
issue_id: "032"
tags: [code-review, security]
---
# Session Log Path Traversal via sessionId

## Problem Statement
The `sessionId` field from `threads.json` is used directly in `path.join` to construct file paths for session log reading and syncing, with no format validation. Since agents can modify `threads.json` (it's in their working directory with bypassPermissions), a tampered `sessionId` like `../../etc/passwd` could enable arbitrary file read via the dashboard API and file append via `syncSessionLog`.

## Findings
- **Source:** Security Sentinel review
- **Location:** `src/queue-processor.ts` lines 137-141 (`syncSessionLog`), `src/dashboard.ts` lines 554-558 (`findSessionLogFile`)
- **Vector:** `syncSessionLog` constructs path: `path.join(SESSIONS_DIR, sessionId + ".jsonl")` — no validation on sessionId
- **Impact:** Arbitrary file read via dashboard `/api/threads/:id/session-logs`, arbitrary file append via `syncSessionLog`

## Proposed Solutions
1. **Validate sessionId format** — Check against UUID regex (`/^[a-f0-9-]{36}$/`) before use in path construction.
   - Pros: Simple, effective. Session IDs from the SDK are UUIDs.
   - Cons: If SDK format changes, regex needs updating.
   - Effort: Small

2. **Apply path.basename() and resolve check** — Use `path.basename(sessionId)` to strip directory components, then verify the resolved path stays within `SESSIONS_DIR`.
   - Pros: Defense in depth regardless of sessionId format.
   - Cons: Slightly more complex.
   - Effort: Small

## Technical Details
- `syncSessionLog()` reads from `~/.claude/projects/{slug}/{sessionId}.jsonl` and appends to `SESSIONS_DIR/{sessionId}.jsonl`
- Dashboard `findSessionLogFile()` reads from `SESSIONS_DIR/{sessionId}.jsonl`
- `threads.json` is writable by agents (it's in their filesystem scope)

## Acceptance Criteria
- [ ] sessionId is validated against UUID format before path construction
- [ ] path.basename() applied as defense in depth
- [ ] Resolved paths verified to stay within intended directories
- [ ] Tests confirm path traversal attempts are rejected
