---
title: "Per-Repo Heartbeat Self-Management & Cross-Pollination"
type: feat
date: 2026-02-11
brainstorm: docs/brainstorms/2026-02-11-onboarding-heartbeat-infra-brainstorm.md
parent-plan: docs/plans/2026-02-11-feat-onboarding-heartbeat-infra-plan.md
---

# Per-Repo Heartbeat Self-Management & Cross-Pollination

## Overview

Transform HEARTBEAT.md from a generic timestamp tracker into a **per-repo living task list** where each thread agent defines, evolves, and manages its own tier-specific tasks. All checks are explicit in HEARTBEAT.md — no hidden baseline in the prompt. Add master thread cross-pollination duty, teach all agents how to manage their own heartbeat, and add queue priority so user messages always jump ahead of heartbeats.

## Problem Statement

The current HEARTBEAT.md template has one flat `## Tasks` section with a generic placeholder (`- [ ] Review pending items`). The tier checks (git status, git fetch, daily summary) are hardcoded in the heartbeat prompt and identical across all threads. This means:

1. **No per-repo customization.** A thread watching a frontend repo runs the same heartbeat checks as one watching an infra repo. There's no place for "check if the CDN cache is warm" or "verify the migration ran."

2. **Checks are implicit.** Looking at a thread's HEARTBEAT.md doesn't tell you what the heartbeat actually does — the real checks are hidden in the prompt. No single source of truth.

3. **Agents don't know they should evolve their heartbeat.** The system prompt says "You can edit the Tasks and Notes sections of HEARTBEAT.md freely as your own scratch space" — but doesn't teach agents to add recurring repo-specific checks, flag blockers, or organize tasks by tier.

4. **No cross-pollination.** If thread 5 adds a great hourly check ("verify no open Dependabot PRs >3 days"), that idea stays siloed. The master thread doesn't review other heartbeats.

5. **Heartbeats can starve user messages.** The queue is FIFO — if 5 heartbeats arrive, a user message waits behind all of them. With `max_concurrent_sessions=2`, two heartbeat slots mean the user is blocked.

## Proposed Solution

### 1. Fully Explicit HEARTBEAT.md — No Hidden Baseline

**Everything the heartbeat does is visible in HEARTBEAT.md.** The heartbeat prompt tells agents to execute their task list, but the tasks themselves live in the file, not the prompt. The template seeds each tier with sensible defaults that agents can modify, remove, or extend.

The prompt's role becomes: "Read your HEARTBEAT.md, determine which tier is due, execute those tasks, update timestamps." The *what* lives in the file. The *when* and *how* live in the prompt.

```markdown
## Timestamps
- Last quick: (never)
- Last hourly: (never)
- Last daily: (never)

## Urgent Flags
(none — flag anything needing human attention here)

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
- [ ] Review all tier task lists — prune irrelevant tasks, evolve checks based on what you've learned

## Notes
(scratch space — observations, ideas, context for future heartbeats)
```

**Why fully explicit:**
- HEARTBEAT.md is the single source of truth — read it, you see everything the heartbeat does
- Agents can customize even the "standard" checks per repo (remove `gh issue list` if the repo doesn't use issues, add repo-specific checks)
- Master thread cross-pollination sees the full picture, not just an additive layer
- One system, not two parallel ones (hidden prompt checks + visible custom tasks)

**Risk of agents removing important checks:** Low. The master thread cross-pollination catches drift ("hey thread 5, you have no git status check — every other thread has one"). The template seeds good defaults. Agents naturally keep useful checks.

### 2. Enrich Prompts — Teach Agents to Self-Manage

**In `buildHeartbeatPrompt()`** — the prompt becomes shorter and more focused. Instead of listing every check, it tells the agent to execute its HEARTBEAT.md:

```
Heartbeat check for thread "${config.name}".

The current time is ${now} (${isoNow}) in ${settings.timezone}.

Read HEARTBEAT.md in your working directory (${config.cwd}). If it doesn't exist,
create it from the template below.

Compare the timestamps in HEARTBEAT.md to the current time to determine which tier
of checks are due. Execute ALL tasks for the highest due tier (higher tiers include
all lower tier tasks).

For each tier you execute:
1. Work through every task in that tier's section
2. Check off items you've verified or completed (change `[ ] ` to `[x]`)
3. If a task is no longer relevant to this repo, remove it
4. If you notice something that should be a recurring check, add it to the right tier
5. Update the tier's timestamp when done

## Tier Rules
- Quick Tasks: always execute
- Hourly Tasks: execute if >60 minutes since "Last hourly" or "(never)"
- Daily Tasks: execute if >24 hours since "Last daily" or "(never)"
- "(never)" means the check has NEVER been run — it is due immediately

## After executing
- Update timestamps AFTER completing each tier's checks
- Reply HEARTBEAT_OK if nothing needs attention (suppresses Telegram delivery)
- If something needs attention, describe it clearly — it will be sent to the thread
- You can edit any section of HEARTBEAT.md freely — it's your operational playbook

[template block if HEARTBEAT.md doesn't exist]
```

**In `buildThreadPrompt()`** — replace the current 3-line HEARTBEAT.md mention:

```
## Heartbeat Self-Management

You receive periodic heartbeat messages (~8 min interval). Your working directory has a
HEARTBEAT.md file — your complete operational playbook for this repo.

HEARTBEAT.md has per-tier task sections (Quick Tasks, Hourly Tasks, Daily Tasks).
Every check the heartbeat performs is listed explicitly in this file.

You own this file. Evolve it as you learn about this repo:
- Add tasks when you notice recurring issues or patterns specific to this repo
- Check off completed tasks, remove irrelevant ones
- Put the right tasks in the right tier:
  - Quick Tasks: fast checks (< 10 seconds) — git status, file existence, flag checks
  - Hourly Tasks: moderate checks — git fetch, CI status, upstream changes
  - Daily Tasks: thorough checks — PR reviews, stale branch cleanup, daily summaries
- Use "Urgent Flags" for anything needing human attention (blockers, broken CI, security)
- Keep "Notes" as scratch space for context between heartbeats

You can update HEARTBEAT.md anytime — during heartbeats or during normal conversation.
Reply HEARTBEAT_OK during heartbeats if nothing needs attention (suppresses Telegram delivery).
```

### 3. Master Thread Cross-Pollination Duty

Add to the master thread's daily heartbeat extras:

```
4. **Cross-pollinate heartbeat patterns:** Read HEARTBEAT.md from each active worker
   thread's working directory (construct path from threads.json: {thread.cwd}/HEARTBEAT.md).
   Look for:
   - Useful tasks that could benefit other repos
   - Good patterns one thread developed that others haven't adopted
   - Important checks that a thread is missing (e.g., no git status in Quick Tasks)
   - Tasks in the wrong tier (slow check in Quick Tasks, etc.)

   If you find a pattern worth sharing, send a message to the target thread(s) via
   send_message: "Cross-pollination suggestion: consider adding '{task}' to your
   {tier} Tasks in HEARTBEAT.md. Thread {N} ({name}) found this useful because {reason}."

   Workers will evaluate the suggestion for their repo — they may accept or ignore it.
   Log propagated patterns in decisions.md.
   Do NOT directly edit other threads' HEARTBEAT.md files.
```

Master's own HEARTBEAT.md Daily Tasks section should include:

```markdown
- [ ] Cross-pollinate: review worker thread heartbeats for patterns worth sharing
- [ ] Check which threads haven't sent a daily report (may have broken heartbeat)
```

**Future:** A `/heartbeat` skill for user-facing interactive management (bulk-add tasks, view all heartbeats at a glance) can be added later without touching the core prompt changes.

### 4. Queue Priority & Heartbeat Concurrency Cap

Small TypeScript change in `processQueue()` to prevent heartbeats from starving user messages.

**Priority sort:** User messages jump ahead of heartbeats in the queue. The heartbeat cron already names files with a `heartbeat_` prefix, so this is a zero-cost filename check — no file reads needed:

```typescript
// In processQueue(), replace the current .sort((a, b) => a.time - b.time) with:
.sort((a, b) => {
  const aHB = a.name.startsWith('heartbeat_');
  const bHB = b.name.startsWith('heartbeat_');
  if (aHB && !bHB) return 1;   // heartbeats go to back
  if (!aHB && bHB) return -1;  // user messages jump ahead
  return a.time - b.time;      // within same priority, FIFO
})
```

**Concurrency cap:** Only 1 of the `max_concurrent_sessions` slots can be a heartbeat. The rest are reserved for user messages:

```typescript
// In processQueue() for loop, after peeking at msg:
if (msg.source === 'heartbeat' && activeHeartbeatCount >= 1) continue;

// Track active heartbeats alongside activeCount:
let activeHeartbeatCount = 0;
// In processMessage dispatch:
if (msg.source === 'heartbeat') activeHeartbeatCount++;
processMessage(file.path).finally(() => {
  if (msg.source === 'heartbeat') activeHeartbeatCount--;
  activeCount--;
  activeThreads.delete(msg.threadId);
  void processQueue();
});
```

**Why this isn't over-engineering:** At 8 threads with ~8 min heartbeat interval, heartbeats arrive in staggered bursts. With `max_concurrent_sessions=2`, two heartbeats can lock out user messages for 10-30 seconds each. The priority sort + cap is ~15 lines of code and eliminates the problem entirely.

## Technical Approach

### Files to Change

| File | Change | Scope |
|------|--------|-------|
| `src/session-manager.ts:264-278` | Replace HEARTBEAT.md template with fully explicit per-tier version | Small (template) |
| `src/session-manager.ts:282-327` | Rewrite tier instructions — "execute your tasks" instead of listing checks | Medium (prompt) |
| `src/session-manager.ts:230-232` | Replace 3-line HEARTBEAT.md mention with self-management section | Medium (prompt) |
| `src/session-manager.ts:186-188` | Same change for master thread prompt | Medium (prompt) |
| `src/session-manager.ts:329-341` | Add cross-pollination duty to master daily heartbeat extras | Medium (prompt) |
| `src/queue-processor.ts:871` | Priority sort: user messages before heartbeats | Small (~5 lines) |
| `src/queue-processor.ts:880-909` | Heartbeat concurrency cap: max 1 active heartbeat | Small (~10 lines) |

### Heartbeat Prompt Changes (Detailed)

**Current approach:** The prompt lists every check (git status, git fetch, gh pr list, etc.) in a 60-line instruction block. The HEARTBEAT.md is mostly a timestamp store.

**New approach:** The prompt says "execute your HEARTBEAT.md tasks for this tier." The checks live in the file. The prompt is ~30 lines focused on: read the file, determine the tier, execute, update timestamps.

This makes `buildHeartbeatPrompt()` significantly shorter — it no longer needs to enumerate every git/gh command. Those live in the HEARTBEAT.md template instead.

### System Prompt Changes (Detailed)

**Current (lines 186-188 / 230-232):**
```
You receive periodic heartbeat messages. Read HEARTBEAT.md in your working directory
and follow it. You can edit HEARTBEAT.md to maintain your own task list. Reply
HEARTBEAT_OK if nothing needs attention.
```

**Proposed (see Section 2 above):** ~15 lines explaining tier structure, self-management, and how to evolve the file.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Per-tier task sections vs flat task list | Per-tier sections | User explicitly wants "its own daily and hourly and quick." Matches existing tier cadence. |
| Fully explicit (all checks in file) vs hidden baseline + additive | Fully explicit | Single source of truth. Read HEARTBEAT.md, see everything. No dual system. Agents can customize even baseline checks. Master sees full picture for cross-pollination. |
| Instructions in prompt vs skill | Prompt (primary), skill (deferred) | Prompt is always available during heartbeat (one-shot haiku). Skill useful later for human-facing management. |
| Cross-pollination via send_message vs direct file edit | send_message only | Respects thread autonomy. Worker evaluates, decides if relevant. Avoids race conditions. |
| Cross-pollination as advisory vs mandatory | Advisory | Not all patterns apply to all repos. Workers have repo-specific context. |
| HEARTBEAT.md in git vs .gitignore | Not tracked — lives in working directory | Per-thread runtime state, not source code. Created on first heartbeat if missing. |
| Structured task metadata vs freeform checklist | Freeform checklist | Haiku is the heartbeat model. Keep it dead simple — markdown checklists. |
| Queue priority for user messages | Yes — filename-based sort | Zero-cost (no file reads). Heartbeat filenames already have `heartbeat_` prefix. |
| Heartbeat concurrency cap | Max 1 concurrent heartbeat | ~10 lines of code. Prevents heartbeat storms from starving user messages at scale. |

## Acceptance Criteria

- [x] HEARTBEAT.md template has per-tier task sections with all checks explicit (no hidden prompt baseline)
- [x] Heartbeat prompt instructs agents to execute tasks from HEARTBEAT.md (not enumerate checks itself)
- [x] Heartbeat prompt instructs agents to evolve their task list (add/remove/check off)
- [x] System prompt (worker) teaches agents about HEARTBEAT.md self-management
- [x] System prompt (master) teaches agents about HEARTBEAT.md self-management
- [x] Master thread daily heartbeat includes cross-pollination duty
- [x] Master cross-pollination uses send_message (not direct file edits)
- [x] Master logs propagated patterns to decisions.md
- [x] Workers treat propagation suggestions as advisory (evaluate, may reject)
- [x] Queue sorts user messages ahead of heartbeats (filename-based)
- [x] Only 1 heartbeat can process concurrently (remaining slots reserved for user messages)

## Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Agent removes important check (e.g., git status) | Low | Medium | Master cross-pollination catches drift. Template seeds good defaults. Agent naturally keeps useful checks. |
| Haiku adds too many tasks, bloating HEARTBEAT.md | Medium | Low | Daily tier includes "prune irrelevant tasks." Organic — no hard limit needed. |
| Master over-propagates irrelevant patterns | Low | Low | Advisory-only — workers ignore irrelevant suggestions. |
| Concurrent edits (heartbeat haiku + user session) | Low | Low | Heartbeat is fast one-shot (~10s). Low collision probability. |
| Agent doesn't evolve tasks, leaves template defaults | Medium | Low | Prompt explicitly says to evolve. Template defaults are still useful. |
| Heartbeat queue starvation | Eliminated | N/A | Priority sort + concurrency cap (this plan). |

## References

### Internal
- Parent plan: `docs/plans/2026-02-11-feat-onboarding-heartbeat-infra-plan.md`
- Brainstorm: `docs/brainstorms/2026-02-11-onboarding-heartbeat-infra-brainstorm.md`
- Architecture review: `docs/solutions/architecture-reviews/multi-agent-review-onboarding-heartbeat-infra.md`
- Heartbeat prompt: `src/session-manager.ts:237-343`
- System prompts: `src/session-manager.ts:139-235`
- Heartbeat processor: `src/queue-processor.ts:431-466`
- Queue scanner: `src/queue-processor.ts:853-914`
- MCP tools (send_message): `src/mcp-tools.ts:101-171`

### Institutional Learnings Applied
- "All intelligence in the prompt" — checks live in HEARTBEAT.md, prompt just orchestrates
- Plain markdown timestamps — no YAML, no structured metadata
- Push + pull channels — send_message for cross-pollination, query_knowledge_base for context
- Heartbeat filename convention (`heartbeat_` prefix) enables zero-cost queue priority sorting
