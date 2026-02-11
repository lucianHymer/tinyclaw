---
title: "Per-Repo Heartbeat Self-Management & Cross-Pollination"
date: 2026-02-11
category: architecture-reviews
tags:
  - heartbeat-infrastructure
  - multi-thread-coordination
  - prompt-architecture
  - queue-optimization
  - file-based-state-management
  - cross-pollination
components:
  - src/session-manager.ts
  - src/queue-processor.ts
severity: medium
problem_type: "Architectural: implicit heartbeat checks, no per-repo customization, queue starvation"
resolution_time_estimate: "2-4 hours"
---

# Per-Repo Heartbeat Self-Management & Cross-Pollination

## Problem

The heartbeat system had five architectural shortcomings:

1. **No per-repo customization.** All threads ran identical heartbeat checks regardless of what repo they watched. No place for repo-specific checks like "verify CDN cache warm" or "check migration status."

2. **Checks hidden in prompt.** The real heartbeat logic was hardcoded in `buildHeartbeatPrompt()` — a ~60-line instruction block listing every git/gh command. HEARTBEAT.md was just a timestamp store. Two parallel systems existed: hidden prompt baseline + visible custom tasks. No single source of truth.

3. **Agents didn't know they should evolve their heartbeat.** The system prompt said "you can edit HEARTBEAT.md freely" but didn't teach agents to add recurring repo-specific checks, flag blockers, or organize tasks by tier.

4. **No cross-pollination.** If thread 5 added a great hourly check ("verify no open Dependabot PRs >3 days"), that idea stayed siloed. The master thread had no mechanism to review other heartbeats.

5. **Heartbeats starved user messages.** The queue was FIFO — if 5 heartbeats arrived in a burst, a user message waited behind all of them. With `max_concurrent_sessions=2`, two heartbeat slots could lock out user messages for 10-30 seconds each.

## Root Cause

The original design treated HEARTBEAT.md as a passive timestamp file and put all operational logic in the prompt. This violated the "single source of truth" principle and the "all intelligence in the prompt" pattern (which means the *orchestration* lives in the prompt, but the *data* — the checks themselves — should live in an editable file the agent owns).

The queue processor had no concept of message priority or per-source concurrency limits, treating heartbeat messages and user messages identically.

## Solution

Six interconnected changes across two files.

### A. Fully Explicit HEARTBEAT.md Template

Replaced the flat `## Tasks` section with per-tier task sections containing all checks explicitly:

```markdown
## Quick Tasks (every heartbeat)
- [ ] Run `git status` — check for uncommitted changes or untracked files
- [ ] Check Urgent Flags above — if anything is flagged, report it

## Hourly Tasks (when >60 min since last hourly)
- [ ] Run `git fetch origin` — detect upstream changes
- [ ] Run `git log HEAD..origin/main --oneline` — check for new commits on main
- [ ] Run `gh pr list --state open` and `gh pr checks` — check CI status on open PRs
- [ ] Check for merge conflicts with main

## Daily Tasks (when >24 hours since last daily)
- [ ] Summarize the day's work (`git log --since="24 hours ago" --oneline`)
- [ ] Run `gh pr list --state open` — check PR status (open, draft, review requested)
- [ ] Run `gh issue list` — check for new or aging items
- [ ] Flag stale branches (>7 days without commits)
- [ ] Send daily summary to master thread (threadId: 1) via send_message
- [ ] Review all tier task lists — prune irrelevant tasks, evolve checks
```

**Key principle:** Read HEARTBEAT.md, see everything the heartbeat does. No hidden baseline.

### B. Rewritten Heartbeat Prompt

Replaced ~60-line prompt enumerating every git/gh command with ~25-line orchestration prompt:

```
Read HEARTBEAT.md. Compare the timestamps to the current time to determine which tier
is due. Execute ALL tasks for the highest due tier (higher tiers include all lower tier
tasks).

For each tier you execute:
1. Work through every task in that tier's section
2. Check off items you've verified or completed
3. If a task is no longer relevant to this repo, remove it
4. If you notice something that should be a recurring check, add it to the right tier
5. Update the tier's timestamp when done
```

The *what* moved to the file. The *when* and *how* stayed in the prompt.

### C. Self-Management Section in System Prompts

Both master and worker prompts got a `## Heartbeat Self-Management` section (~15 lines) teaching agents they own HEARTBEAT.md and should evolve it — add repo-specific tasks, remove irrelevant ones, organize by tier (Quick < 10s, Hourly moderate, Daily thorough).

### D. Master Thread Cross-Pollination Duty

Added item #4 to Master Thread Daily Extras: read worker HEARTBEAT.md files, identify shareable patterns, send suggestions via `send_message`. Advisory only — workers evaluate and decide. Master logs propagated patterns in decisions.md. Never directly edits other threads' files.

### E. Queue Priority Sort

Filename-based sort in `processQueue()` — heartbeat files (`heartbeat_*` prefix) go to back, user messages jump ahead. Zero-cost: no file reads, pure string comparison.

```typescript
.sort((a, b) => {
  const aHB = a.name.startsWith('heartbeat_');
  const bHB = b.name.startsWith('heartbeat_');
  if (aHB && !bHB) return 1;
  if (!aHB && bHB) return -1;
  return a.time - b.time;
})
```

### F. Heartbeat Concurrency Cap

Only 1 heartbeat can process concurrently. Remaining `max_concurrent_sessions` slots reserved for user messages.

```typescript
let activeHeartbeatCount = 0;

// In dispatch loop:
if (msg.source === 'heartbeat' && activeHeartbeatCount >= 1) continue;

// When claiming slot:
if (msg.source === 'heartbeat') activeHeartbeatCount++;

// In cleanup:
if (msg.source === 'heartbeat') activeHeartbeatCount--;
```

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Per-tier vs flat task list | Per-tier sections | Matches existing tier cadence. Natural organization. Auditable. |
| Fully explicit vs hidden baseline | Fully explicit | Single source of truth. Master sees full picture for cross-pollination. |
| Cross-pollination mechanism | send_message only | Respects thread autonomy. No race conditions. Audit trail. |
| Cross-pollination authority | Advisory | Workers have repo-specific context. Not all patterns apply everywhere. |
| HEARTBEAT.md tracking | Not in git | Per-thread runtime state, not source code. Created on first heartbeat. |
| Task format | Freeform markdown | Haiku is the heartbeat model. Dead simple. No parser complexity. |
| Queue priority | Filename-based sort | Zero I/O cost. Heartbeat prefix already exists. |
| Heartbeat concurrency | Max 1 | ~10 lines of code. Eliminates starvation at scale. |

## Files Changed

| File | Lines | Change |
|------|-------|--------|
| `src/session-manager.ts` | 186-205 | Master system prompt: heartbeat self-management section |
| `src/session-manager.ts` | 247-266 | Worker system prompt: heartbeat self-management section |
| `src/session-manager.ts` | 298-327 | HEARTBEAT.md template: per-tier task sections |
| `src/session-manager.ts` | 329-354 | Heartbeat prompt: "execute your tasks" orchestration |
| `src/session-manager.ts` | 356-389 | Master daily extras: cross-pollination duty |
| `src/queue-processor.ts` | 241 | `activeHeartbeatCount` state variable |
| `src/queue-processor.ts` | 872-878 | Priority sort: user messages before heartbeats |
| `src/queue-processor.ts` | 901-902 | Heartbeat concurrency guard |
| `src/queue-processor.ts` | 907, 918 | Heartbeat count increment/decrement |

## Patterns Extracted

### 1. File-Based Config Over Prompt Hardcoding

Move operational logic (the "what") to explicit, editable files. Reserve the prompt for orchestration logic (the "when" and "how"). Applies to any agent system with periodic checks, playbooks, or configurable behavior.

**Apply when:** Checks are customizable per agent/repo, or agents should evolve their own procedures.
**Avoid when:** Configuration is truly static and universal.

### 2. Filename-Based Priority Sorting

Use naming conventions at the write point (e.g., `heartbeat_*` prefix) to enable zero-cost priority sorting at the read point. No file I/O needed — pure string comparison on filenames.

**Apply when:** Mixed-priority workloads share a queue directory.
**Key requirement:** Naming convention must be enforced at the producer (message writer), not the consumer.

### 3. Per-Source Concurrency Reservation

Track active count per message source. Cap low-priority sources to prevent starvation of high-priority work.

```
if (msg.source === 'heartbeat' && activeHeartbeatCount >= 1) continue;
```

**Apply when:** `max_concurrent_sessions` is small and periodic work can burst.

### 4. Advisory Cross-Pollination

Master reads worker state (read-only), identifies patterns, sends suggestions via messaging. Workers evaluate independently. Never directly edit another agent's files.

**Why advisory:** Workers have context masters don't. Not all patterns apply to all repos. Messaging creates an audit trail.

### 5. Agent Self-Management of Operational Playbooks

Frame agent-owned files as "your operational playbook" and explicitly teach evolution in the system prompt. Agents add tasks when they notice recurring issues, remove irrelevant tasks, and organize by appropriate tier.

**Why it works:** Emergent task discovery. Local optimization per repo. Auditable via git history.

## Anti-Patterns Avoided

| Anti-Pattern | Problem | What We Did Instead |
|-------------|---------|-------------------|
| Hardcoding checks in prompts | No customization, hidden logic, dual systems | All checks in HEARTBEAT.md, prompt orchestrates |
| FIFO-only queue with mixed priorities | Heartbeat starvation of user messages | Filename-based priority sort |
| Unlimited concurrent heartbeats | All slots consumed by periodic work | Max 1 heartbeat, remaining for users |
| Direct cross-thread file edits | Race conditions, no autonomy, no audit trail | Advisory send_message suggestions |
| "You can edit this file" without teaching how | Agents don't evolve their config | Explicit self-management section with tier guidance |

## Prevention Strategies

1. **At design time:** For every config dimension, designate ONE canonical location (file vs prompt vs code). Grep for duplicates before committing.
2. **For queues:** If mixed-priority workloads share a queue, add priority sorting from day 1. It's ~5 lines of code.
3. **For concurrency:** Ask "what percentage of slots should interactive work get?" and enforce per-source caps.
4. **For cross-agent coordination:** Default to messaging (advisory). Only use direct file edits when the agent owns the file.
5. **For agent-owned files:** Always include explicit guidance in the system prompt on *when* and *how* to evolve the file, not just permission to edit.

## Cross-References

- **Parent plan:** `docs/plans/2026-02-11-feat-onboarding-heartbeat-infra-plan.md`
- **Brainstorm:** `docs/brainstorms/2026-02-11-onboarding-heartbeat-infra-brainstorm.md`
- **Architecture review (full pipeline):** `docs/solutions/architecture-reviews/multi-agent-review-onboarding-heartbeat-infra.md`
- **Evolution doc:** `docs/solutions/integration-issues/tinyclaw-v2-evolution-from-fork-to-forum-agent.md`
- **MCP tool infrastructure:** `docs/solutions/integration-issues/sdk-v2-mcpservers-silent-ignore.md`
- **Parallel orchestration:** `docs/solutions/workflow-patterns/parallel-subagent-orchestration-bulk-todo-resolution.md`
