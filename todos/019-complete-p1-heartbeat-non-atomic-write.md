---
status: done
priority: p1
issue_id: "019"
tags: [code-review, quality, heartbeat]
dependencies: []
---

# Heartbeat Cron Uses Non-Atomic File Write

## Problem Statement

`heartbeat-cron.sh` writes queue JSON files directly to the final filename without the `.tmp + rename` pattern used everywhere else. The queue processor could read a partially-written file.

## Findings

**Source**: architecture-strategist, pattern-recognition-specialist

**Location**: `/workspace/project/heartbeat-cron.sh` line 71

```bash
jq -n ... > "$QUEUE_INCOMING/${MESSAGE_ID}.json"
```

Every other queue write in the codebase uses atomic writes:
- `src/mcp-tools.ts` lines 71-74: `.json.tmp` + `renameSync`
- `src/session-manager.ts` lines 80-83: `.tmp` + `renameSync`

## Proposed Solutions

### Option 1: Add .tmp + mv (Recommended)

```bash
jq -n ... > "$QUEUE_INCOMING/${MESSAGE_ID}.json.tmp"
mv "$QUEUE_INCOMING/${MESSAGE_ID}.json.tmp" "$QUEUE_INCOMING/${MESSAGE_ID}.json"
```

- Effort: Tiny (2-line change)
- Risk: None

## Acceptance Criteria

- [x] heartbeat-cron.sh writes to `.json.tmp` then `mv` to `.json`

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-11 | Created from code review | Violates established atomic write pattern |
