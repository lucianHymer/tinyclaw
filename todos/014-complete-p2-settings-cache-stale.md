---
status: resolved
priority: p2
issue_id: "014"
tags: [code-review, architecture, quality]
dependencies: []
---

# Settings Cache Never Invalidated -- Runtime Changes Require Restart

## Problem Statement

`session-manager.ts` caches settings in memory on first read and never invalidates. Changes to `settings.json` (e.g., `borg.sh model sonnet`) are not reflected until process restart. The `borg.sh model` command's comment "Changes take effect on next message" is incorrect.

## Findings

**Source**: architecture-strategist agent

File: `src/session-manager.ts` lines 87-107
```typescript
let settingsCache: Settings | null = null;
export function loadSettings(): Settings {
    if (settingsCache) return settingsCache;
    // ...
}
```

`loadSettings()` is called on every message (via `formatCurrentTime()` in queue-processor). Once cached, settings never re-read from disk.

## Proposed Solutions

### Option 1: Add file mtime check (Recommended)
Cache the `mtime` of `settings.json`. On each call, `statSync` the file and compare mtime. If changed, re-read. Cost: one `statSync` per message (~0.1ms).
- Effort: Small (15 minutes)
- Risk: Low

### Option 2: Clear cache periodically
Set cache to null every 60 seconds via `setTimeout`.
- Effort: Small
- Risk: Low (but arbitrary interval)

### Option 3: Move settings to env vars
Settings that change at runtime (model, timezone) become env vars. Requires container restart.
- Effort: Medium
- Risk: Medium (changes operational workflow)

## Technical Details

**Affected files**: `src/session-manager.ts`

## Acceptance Criteria

- [ ] `borg.sh model sonnet` takes effect on next message without restart
- [ ] Settings file re-read when mtime changes

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-10 | Created from code review | Cache invalidation strategy should match update frequency |
