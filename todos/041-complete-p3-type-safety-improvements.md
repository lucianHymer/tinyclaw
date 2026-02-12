---
status: complete
priority: p3
issue_id: "041"
tags: [code-review, typescript, quality]
---
# Type Safety Improvements

## Problem Statement
Several type safety issues across the codebase: `buildSourcePrefix` uses `Record<string, string>` instead of `Record<MessageSource, string>` losing exhaustiveness checking; `JSON.parse` results are cast with `as T` on external input without runtime validation; `parseMemoryLimit` returns 0 on invalid input giving misleading errors; error HTTP status determined by string matching on error messages.

## Findings
- **Source:** TypeScript Reviewer
- **Locations:**
  - `src/queue-processor.ts` line 293 — buildSourcePrefix Record<string, string>
  - `src/queue-processor.ts` lines 520-522 — JSON.parse as IncomingMessage
  - `src/queue-processor.ts` line 814 — JSON.parse as command type
  - `src/dashboard.ts` line 370 — parseMemoryLimit returns 0
  - `src/dashboard.ts` lines 517-518 — HTTP status from string matching

## Proposed Solutions
1. **Use `Record<MessageSource, string>` in buildSourcePrefix** — TypeScript enforces all variants covered.
2. **Add zod validation for queue messages** — Already depends on zod/v4. Validate IncomingMessage shape on parse.
3. **Return null from parseMemoryLimit on invalid input** — Caller handles explicitly.
4. **Use custom error class instead of string matching** — `class ValidationError extends Error` in docker-client.ts.

## Technical Details
- zod already available (`zod/v4`) — used in mcp-tools.ts
- `MessageSource` type exists in `message-history.ts`

## Acceptance Criteria
- [ ] buildSourcePrefix uses Record<MessageSource, string>
- [ ] Queue message parsing validates shape at boundary
- [ ] parseMemoryLimit failure is distinguishable from valid 0
- [ ] Error classification uses types, not string matching
