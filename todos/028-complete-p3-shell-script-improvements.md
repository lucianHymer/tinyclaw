---
status: done
priority: p3
issue_id: "028"
tags: [code-review, quality, shell]
dependencies: []
---

# Shell Script Minor Improvements

## Problem Statement

Several minor consistency and robustness issues across shell scripts.

## Findings

**Source**: pattern-recognition-specialist, security-sentinel

1. **heartbeat-cron.sh missing `set -uo pipefail`**: Other scripts have it. `-e` intentionally omitted for the infinite loop, but `-u` and `-o pipefail` would be safe.
2. **Inconsistent timestamp format**: `borg.sh` and `heartbeat-cron.sh` use `date '+%Y-%m-%d %H:%M:%S'`, while `create-dev-container.sh` and `remove-dev-container.sh` use `date -Is`.
3. **Thread ID not validated in heartbeat-cron.sh line 57**: Should check `[[ "$THREAD_ID" =~ ^[0-9]+$ ]]`
4. **Dead symlink in Dockerfile.dev-container line 58**: `ln -sf ... /usr/local/bin/gh-real-path` -- no code references `gh-real-path`
5. **Missing apt cache cleanup in Dockerfile.dev-container**: Second and third `apt-get install` commands don't clean `/var/lib/apt/lists/*`
6. **Heartbeat stagger can produce 0-second sleep**: `INTERVAL / THREAD_COUNT` with bash integer division

## Proposed Solutions

All straightforward fixes.

- Effort: Small

## Acceptance Criteria

- [x] heartbeat-cron.sh has `set -uo pipefail` with comment about intentional `-e` omission
- [x] Consistent timestamp format across scripts
- [x] Thread ID validated as numeric in heartbeat loop
- [x] Dead symlink removed from Dockerfile
- [x] apt cache cleaned in all install layers

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-11 | Created from code review | Pattern consistency improvements |
| 2026-02-11 | All 6 findings resolved | `date '+%Y-%m-%d %H:%M:%S'` chosen as standard (4 vs 2 usage) |
