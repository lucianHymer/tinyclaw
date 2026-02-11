---
status: resolved
priority: p2
issue_id: "012"
tags: [code-review, security, shell]
dependencies: ["003"]
---

# Credential Helper: Missing Strict Mode, Timeouts, Error Handling

## Problem Statement

`docker/github-token-helper.sh` lacks shell best practices that could cause silent failures or hangs during git operations.

## Findings

**Source**: pattern-recognition-specialist agent

1. **No `set -euo pipefail`** -- `tinyclaw.sh` uses it (line 5), but the credential helper does not. If `ORG` is never set (no `path=` in stdin), `jq` receives an empty string instead of failing early.

2. **No curl timeout** -- `curl -sf` will hang until TCP timeout (~120s) if the broker is unresponsive. Git operations appear frozen.

3. **No token validation** -- If broker returns `{"error": "..."}` with status 200, `jq -r .token` outputs `null`, and git authenticates with password `null` (401 error).

## Proposed Solutions

### Option 1: Add strictness, timeouts, and validation (Recommended)
```bash
#!/bin/bash
set -euo pipefail

# ... existing parsing ...

RESULT=$(curl -sf --connect-timeout 5 --max-time 10 \
  "${CREDENTIAL_BROKER_URL:-http://broker:3000}/token?installation_id=$INSTALL_ID")

TOKEN=$(echo "$RESULT" | jq -r '.token // empty')
if [ -z "$TOKEN" ]; then
  exit 1
fi
```
- Effort: Small (15 minutes)
- Risk: None

## Technical Details

**Affected files**: `docker/github-token-helper.sh`

## Acceptance Criteria

- [ ] Script uses `set -euo pipefail`
- [ ] Curl has `--connect-timeout 5 --max-time 10`
- [ ] Token validated (not empty, not "null") before outputting

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-10 | Created from code review | Shell scripts that handle credentials need strict mode and timeouts |
