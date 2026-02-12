---
status: complete
priority: p2
issue_id: "038"
tags: [code-review, performance, architecture]
---
# loadThreads() Needs mtime Cache + readThreads() Should Use It

## Problem Statement
`loadThreads()` in `session-manager.ts` always reads from disk (readFileSync + JSON.parse) on every call. It's called 3+ times per message, plus every 5 seconds by `syncAllActiveSessionLogs()`. Meanwhile, `loadSettings()` already implements mtime-based caching. Additionally, `mcp-tools.ts` has its own `readThreads()` function that bypasses `loadThreads()` entirely, using a weaker shadow type with no error recovery.

## Findings
- **Source:** Performance Oracle, Architecture Strategist, TypeScript Reviewer (all flagged independently)
- **Locations:**
  - `src/session-manager.ts` lines 54-73 (loadThreads — no cache)
  - `src/session-manager.ts` lines 88-117 (loadSettings — has mtime cache)
  - `src/mcp-tools.ts` lines 88-90 (readThreads — shadow implementation, weak type)
- **Impact:** 12+ unnecessary disk reads per minute when idle. readThreads() returns `Record<string, { name, cwd, isMaster? }>` instead of `ThreadsMap`.

## Proposed Solutions
1. **Add mtime-based cache to loadThreads()** — Mirror the loadSettings() pattern. Single statSync (cheap) instead of readFileSync + JSON.parse.
   - Effort: Small
2. **Replace readThreads() in mcp-tools.ts with import** — `import { loadThreads } from "./session-manager.js"`. Use canonical `ThreadsMap` type.
   - Effort: Small

## Technical Details
- `loadThreads()` comment says "Always read from disk" for cross-process safety. mtime cache preserves this safety while avoiding redundant reads.
- `syncAllActiveSessionLogs()` runs every 5 seconds, calling loadThreads() each time.
- Queue scan calls loadSettings() which already caches, but loadThreads() doesn't.

## Acceptance Criteria
- [ ] loadThreads() uses mtime-based cache like loadSettings()
- [ ] readThreads() in mcp-tools.ts replaced with loadThreads() import
- [ ] ThreadsMap type used consistently across all modules
- [ ] Cross-process staleness still detected via mtime check
