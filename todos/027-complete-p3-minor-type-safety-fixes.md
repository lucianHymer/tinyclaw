---
status: ready
priority: p3
issue_id: "027"
tags: [code-review, quality, typescript]
dependencies: []
---

# Minor TypeScript Quality Issues

## Problem Statement

Several small TypeScript quality issues identified across the branch.

## Findings

**Source**: kieran-typescript-reviewer

1. **`Record<string, any>` in mcp-tools.ts line 39**: Should use `ReturnType<typeof readThreads>`
2. **`eslint-disable` for `any` in mcp-tools.ts line 310-311**: Consider a type alias or `unknown`
3. **`req.query as Record<string, string>` casts (lines 238, 249, 331, 338, 787)**: `req.query` can be `string | string[] | undefined`, not just `string`
4. **Two `new Date()` instances in session-manager.ts lines 221, 231**: Could differ by milliseconds; use single Date instance
5. **Heartbeat prompt concatenation style (lines 308-323)**: Trailing `+` operator hard to read
6. **`type: "text" as const` repeated ~20 times in mcp-tools.ts**: Extract helper functions `textContent()` / `errorContent()`
7. **Missing `void` prefix on `notifyMemoryChange` call (line 714)**: Discarded Promise

## Proposed Solutions

All are straightforward fixes. Address during the docker-client.ts extraction (todo 016) for maximum efficiency.

- Effort: Small

## Acceptance Criteria

- [ ] No explicit `any` without justification
- [ ] Safe query param parsing
- [ ] Single Date instance in buildHeartbeatPrompt

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-11 | Created from code review | Collection of minor TS improvements |
