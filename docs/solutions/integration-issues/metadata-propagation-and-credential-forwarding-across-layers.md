---
title: "Telegram Topic Names and gh CLI Auth via Credential Broker Wrapper"
date: "2026-02-10"
category: "integration-issues"
tags:
  - telegram-forum
  - github-integration
  - docker
  - authentication
  - credential-broker
  - metadata-propagation
component:
  - telegram-client.ts
  - queue-processor.ts
  - session-manager.ts
  - docker/gh-wrapper.sh
  - Dockerfile
severity: medium
symptoms:
  - "Generic thread names ('Thread 2') in threads.json instead of actual Telegram topic names"
  - "gh CLI commands fail inside Docker container with 'not logged in' error"
  - "Agents claim they don't have GitHub access despite credential broker running"
root_cause:
  - "Telegram client captured message_thread_id but never cached topic names from forum service messages"
  - "Queue processor hardcoded generic Thread ${threadId} naming"
  - "gh CLI has separate auth from git credential helpers — GH_TOKEN or gh auth login required"
related:
  - docs/solutions/integration-issues/sdk-v2-mcpservers-silent-ignore.md
  - docs/plans/2026-02-10-feat-production-docker-dashboard-broker-plan.md
---

# Telegram Topic Names and gh CLI Auth via Credential Broker Wrapper

## Problem

Two related integration gaps where information/capability available in one layer wasn't reaching where it was needed:

1. **Telegram topic names lost in transit.** The Telegram client had access to forum topic names via `forum_topic_created` service messages, but this metadata was never captured or passed through the queue. The queue processor hardcoded `Thread ${threadId}` when creating new thread entries in `threads.json`.

2. **gh CLI unauthenticated in Docker.** The credential broker (minting GitHub App installation tokens) was wired up for `git` operations via a git credential helper, but the `gh` CLI has its own completely separate auth system. Inside the container, `gh auth status` returned "not logged in" even though `git clone` worked fine. The system prompt also didn't tell agents about GitHub access.

## Investigation

### Discovering the bot runs in Docker

Checked the queue-processor's environment via `/proc/PID/environ`:

```
HOSTNAME=f9d7febf757f
PWD=/app
CREDENTIAL_BROKER_URL=http://broker:3000
BROKER_SECRET=...
```

This revealed the bot was containerized (not running directly on host as initially assumed).

### Verifying the credential broker works

```bash
docker exec borg-bot-1 sh -c \
  'curl -s -H "Authorization: Bearer $BROKER_SECRET" \
   "http://broker:3000/token?installation_id=109312648"'
# {"token":"ghs_...","expires_at":"2026-02-10T23:18:51Z"}
```

Broker successfully mints tokens. Git credential helper uses this and works.

### Identifying the gh auth gap

```bash
docker exec borg-bot-1 gh auth status
# You are not logged into any GitHub hosts.
```

`gh` doesn't use git credential helpers. It needs `GH_TOKEN` env var or `gh auth login`. Since broker tokens expire hourly, a static token won't work — need dynamic token minting per invocation.

### Tracing topic name loss

Searched for where threads.json entries are created:
- `queue-processor.ts:419` — `name: "Thread ${threadId}"` (hardcoded)
- `session-manager.ts:226` — `name: filtered.name ?? "Thread ${threadId}"` (fallback)

The Telegram client only extracted `message_thread_id` (numeric). Topic names from `forum_topic_created` events were never captured.

## Solution

### Fix 1: Telegram Topic Names

**types.ts** — Added `topicName?: string` to `IncomingMessage`:

```typescript
export interface IncomingMessage {
    // ...existing fields...
    topicName?: string;
    timestamp: number;
    messageId: string;
}
```

**telegram-client.ts** — Cache topic names from service messages:

```typescript
const topicNames = new Map<number, string>();

bot.on("message:forum_topic_created", (ctx) => {
    const threadId = ctx.msg.message_thread_id;
    const name = ctx.msg.forum_topic_created.name;
    if (threadId && name) {
        topicNames.set(threadId, name);
    }
});

bot.on("message:forum_topic_edited", (ctx) => {
    const threadId = ctx.msg.message_thread_id;
    const name = ctx.msg.forum_topic_edited.name;
    if (threadId && name) {
        topicNames.set(threadId, name);
        configureThread(threadId, { name });
    }
});
```

Pass through queue payload:

```typescript
const topicName = topicNames.get(threadId);
const queueData = { ...existingFields, topicName, timestamp, messageId };
```

**queue-processor.ts** — Use topic name + backfill:

```typescript
if (!threadConfig) {
    threadConfig = {
        name: msg.topicName ?? `Thread ${threadId}`,
        // ...
    };
} else if (msg.topicName && threadConfig.name === `Thread ${threadId}`) {
    // Backfill for threads created before name tracking
    threadConfig.name = msg.topicName;
    saveThreads(threads);
}
```

### Fix 2: gh CLI Auth Wrapper

**docker/gh-wrapper.sh** — Fetches broker token, sets `GH_TOKEN`, exec's real gh:

```bash
#!/bin/bash
set -euo pipefail

ORG="${GH_DEFAULT_ORG:-}"
if [ -z "$ORG" ]; then
    ORG=$(jq -r 'keys[0] // empty' /secrets/github-installations.json 2>/dev/null || true)
fi

INSTALL_ID=$(jq -r --arg org "$ORG" '.[$org] // empty' /secrets/github-installations.json)
RESULT=$(curl -sf --connect-timeout 5 --max-time 10 \
    -H "Authorization: Bearer $BROKER_SECRET" \
    "${CREDENTIAL_BROKER_URL:-http://broker:3000}/token?installation_id=$INSTALL_ID")
TOKEN=$(echo "$RESULT" | jq -r '.token // empty')

GH_TOKEN="$TOKEN" exec /usr/bin/gh-real "$@"
```

**Dockerfile** — Replace `/usr/bin/gh` with wrapper:

```dockerfile
RUN mv /usr/bin/gh /usr/bin/gh-real
COPY docker/gh-wrapper.sh /usr/bin/gh
RUN chmod +x /usr/bin/gh
```

**session-manager.ts** — Updated system prompts:

```
GitHub access:
- `git` and `gh` are both authenticated via the credential broker
- You can clone, push, create PRs, file issues, etc.
- Available orgs: check /secrets/github-installations.json
```

## Why These Design Choices

**Backfill logic for topic names:** Threads created before this fix have generic names. The backfill updates them on first message without requiring manual migration.

**Wrapper replacing `/usr/bin/gh` (not alias/symlink):** Agents call `gh` directly in bash commands. An alias wouldn't work in non-interactive shells. Replacing the binary with a wrapper is transparent to all callers.

**`exec` in wrapper:** `exec /usr/bin/gh-real "$@"` replaces the wrapper process — no zombie overhead, correct exit codes, proper signal handling.

**Fresh token per invocation:** Broker tokens expire in 1 hour. Minting a fresh one per `gh` call avoids expiry issues during long agent sessions. The broker caches tokens internally (reuses if >5 min TTL remaining).

## Prevention Patterns

### 1. Metadata Inventory at Source Boundaries

When a component receives data from an external source (Telegram, GitHub, etc.), explicitly list all useful metadata available and decide what to pass downstream. Don't assume "we only need the ID" — topic names, user display names, timestamps all have value.

### 2. Independent Auth Verification per Tool

When adding CLI tools to a Docker container, verify each tool's auth mechanism independently:
- `git` uses credential helpers
- `gh` uses `GH_TOKEN` or config files
- `curl` uses headers directly
- Don't assume one tool's auth covers another

### 3. System Prompt Must Match Container Reality

If the system prompt claims "gh is authenticated", verify it actually works inside the container. Test with `docker exec <container> gh auth status` before claiming capabilities.

## Verification

```bash
# Topic names: create a forum topic, send a message, check threads.json
cat .borg/threads.json | jq '.[] | .name'

# gh auth: test from inside container
docker exec borg-bot-1 gh repo list passportxyz --limit 2

# git auth: test clone
docker exec borg-bot-1 git ls-remote https://github.com/passportxyz/passport

# Ask agent to use GitHub
# Send message: "List the open issues on passportxyz/passport"
```
