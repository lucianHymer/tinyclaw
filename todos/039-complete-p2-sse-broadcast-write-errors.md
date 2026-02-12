---
status: complete
priority: p2
issue_id: "039"
tags: [code-review, performance, reliability]
---
# SSE Feeds Need Broadcast Pattern + Write Error Handling

## Problem Statement
The message and routing SSE feeds create independent setInterval per connected client, each doing file stats and reads. The container feed already implements the correct broadcast pattern (single poll interval, broadcast to all clients). Additionally, `res.write()` in message/routing feeds is not wrapped in try/catch — disconnected clients cause zombie intervals.

## Findings
- **Source:** Performance Oracle review
- **Locations:**
  - `src/dashboard.ts` lines 262-297 (messages/feed — per-client interval)
  - `src/dashboard.ts` lines 300-334 (routing/feed — per-client interval)
  - `src/dashboard.ts` lines 390-427 (containers/feed — correct broadcast pattern)
- **Impact:** With 10 dashboard tabs x 3 feeds = 30 independent intervals, each polling files every 2s. Zombie intervals on disconnect leak resources.

## Proposed Solutions
1. **Apply broadcast pattern from container feed** — Single setInterval per feed type, broadcast to Set of clients. Already implemented at `src/dashboard.ts` lines 390-427 for containers.
   - Effort: Small
2. **Wrap res.write() in try/catch** — On write error, remove client and clear interval. The container feed at lines 414-419 already does this correctly.
   - Effort: Small

## Technical Details
- Broadcast pattern already exists in codebase at lines 390-427
- `containerFeedClients` Set + `startContainerFeed`/`stopContainerFeedIfIdle` is the reference implementation
- Container feed also correctly handles write errors with try/catch at lines 414-419

## Acceptance Criteria
- [ ] Message and routing SSE feeds use broadcast pattern (single poll interval)
- [ ] res.write() wrapped in try/catch in all SSE handlers
- [ ] Client sets cleaned up on disconnect
- [ ] Idle feed intervals stopped when no clients connected
