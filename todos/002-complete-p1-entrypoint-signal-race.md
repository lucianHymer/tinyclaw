---
status: resolved
priority: p1
issue_id: "002"
tags: [code-review, architecture, docker, data-loss]
dependencies: []
---

# Entrypoint Signal Race Condition -- Children Killed Before Graceful Shutdown

## Problem Statement

`entrypoint.sh` has a race condition where Docker's SIGTERM triggers the trap handler which kills children, but the script's main flow (`wait -n` returns, then `exit 1`) can terminate before children finish their graceful shutdown (saving `threads.json`, flushing logs). This can cause data loss on `docker compose down`.

## Findings

**Source**: architecture-strategist agent

File: `entrypoint.sh` lines 3-15

```bash
trap 'kill $TELEGRAM_PID $QUEUE_PID 2>/dev/null; wait' SIGTERM SIGINT

node dist/telegram-client.js &
TELEGRAM_PID=$!
node dist/queue-processor.js &
QUEUE_PID=$!

wait -n $TELEGRAM_PID $QUEUE_PID
kill $TELEGRAM_PID $QUEUE_PID 2>/dev/null
exit 1
```

When Docker sends SIGTERM:
1. Trap fires, kills children, calls `wait`
2. Bash resumes at line 14 after `wait -n` returns
3. `kill` on line 14 tries to kill already-dead PIDs
4. `exit 1` terminates the entrypoint immediately
5. Children may still be in graceful shutdown (saving threads.json)

**Additional concern**: When one child dies naturally (not via signal), lines 14-15 kill the other child and exit immediately without waiting for it to finish shutdown.

## Proposed Solutions

### Option 1: Wait in trap handler and exit from there (Recommended)
```bash
trap 'kill $TELEGRAM_PID $QUEUE_PID 2>/dev/null; wait $TELEGRAM_PID $QUEUE_PID 2>/dev/null; exit 0' SIGTERM SIGINT
```
- Pros: Clean, one-line fix, waits for children in trap handler itself
- Cons: None
- Effort: Small (5 minutes)
- Risk: Low

### Option 2: Add `wait` after kill on line 14
```bash
wait -n $TELEGRAM_PID $QUEUE_PID
kill $TELEGRAM_PID $QUEUE_PID 2>/dev/null
wait $TELEGRAM_PID $QUEUE_PID 2>/dev/null
exit 1
```
- Pros: Handles both signal and natural-death paths
- Cons: Two separate wait/kill/wait paths to reason about
- Effort: Small (5 minutes)
- Risk: Low

### Option 3: Add `init: true` to docker-compose.yml bot service
- Pros: Tini as PID 1 handles zombie reaping and signal forwarding properly
- Cons: Doesn't fix the natural-death-of-one-child path; belt-and-suspenders
- Effort: Small (1 line)
- Risk: Low (should be done regardless)

## Technical Details

**Affected files**:
- `entrypoint.sh`
- `docker-compose.yml` (add `init: true`)

## Acceptance Criteria

- [ ] `docker compose down` waits for both Node processes to finish shutdown
- [ ] `threads.json` is saved on graceful shutdown
- [ ] If one child crashes, the other is killed and waited for before exit
- [ ] `init: true` added to bot service in docker-compose.yml

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-10 | Created from code review | The trap + wait-n + exit pattern is a common bash entrypoint pitfall in Docker |

## Resources

- Docker signal propagation: https://docs.docker.com/compose/faq/#why-do-my-services-take-10-seconds-to-recreate-or-stop
