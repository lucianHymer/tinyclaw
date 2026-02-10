---
title: "TinyClaw v2: Evolution from Fork to Telegram Forum Agent"
category: integration-issues
problem_type: architecture_evolution
components:
  - telegram-client
  - queue-processor
  - session-manager
  - router
  - message-history
  - heartbeat-cron
technologies:
  - typescript
  - agent-sdk-v2
  - grammy
  - telegram-bot-api
  - zod
severity: n/a
date_solved: 2026-02-10
authors:
  - clawcian
  - jian
tags:
  - architecture
  - migration
  - agent-sdk
  - telegram
  - smart-routing
  - cross-thread
  - openclaw
  - clawrouter
---

# TinyClaw v2: Evolution from Fork to Telegram Forum Agent

## Context

TinyClaw started as a minimal multi-channel AI assistant (WhatsApp + Discord) that wrapped the Claude CLI via `execSync`. Over the course of ~33 hours, it was completely rewritten into a Telegram forum-based multi-session agent using the Anthropic Agent SDK v2, smart model routing adapted from [ClawRouter](https://github.com/BlockRunAI/ClawRouter), and cross-thread orchestration inspired by [OpenClaw](https://openclaw.ai/).

This document captures the full evolution, architectural decisions, lessons learned, and key patterns established during the transformation.

---

## Lineage and Inspiration

### TinyClaw (Original)
Created by **Jian** (`jian@pointerhq.com`) as "TinyClaw Simple" -- a fresh-start simplification of a prior, more complex TinyClaw concept. The original vision: a lightweight wrapper around Claude Code's CLI that relays messages from chat platforms through a file-based queue.

### OpenClaw
[OpenClaw](https://openclaw.ai/) by Peter Steinberger is an open-source autonomous AI agent with 164,000+ GitHub stars. It connects to multiple messaging platforms and runs as a self-hosted personal AI assistant. TinyClaw draws inspiration from OpenClaw's multi-channel architecture, heartbeat loop pattern, and the general concept of an always-on AI agent. The workspace structure (`~/.openclaw/workspace/`) follows OpenClaw conventions.

### ClawRouter
[ClawRouter](https://github.com/BlockRunAI/ClawRouter) by BlockRunAI is a smart routing system that directs LLM API requests to the most cost-effective model. TinyClaw's 14-dimension weighted scoring router was adapted directly from ClawRouter's open-source codebase (MIT licensed). The router files were copied from a local `anthropic-router` workspace (~400 lines of pure TypeScript, zero external dependencies).

---

## Evolution Timeline

### Phase 1: WhatsApp Prototype (Feb 9, 2026 morning)
**Author**: Jian | **Duration**: ~40 minutes | **3 commits**

The original architecture:
```
WhatsApp (Puppeteer) --> file queue --> execSync("claude -c -p $msg") --> file queue --> WhatsApp
```

**What was established:**
- File-based queue system (`incoming/` -> `processing/` -> `outgoing/`) -- the one pattern that survived every rewrite
- tmux-based orchestration via `tinyclaw.sh`
- Heartbeat cron for periodic check-ins
- Claude Code hooks for context injection and activity logging

**Key limitation**: `execSync` blocked the entire Node.js event loop. One message at a time, with a 2-minute hard timeout.

### Phase 2: TypeScript + Discord (Feb 9-10, 2026)
**Author**: Jian | **Duration**: ~19 hours | **3 commits (with PR numbers)**

- JavaScript -> TypeScript migration
- Discord integration added via `discord.js`
- Setup wizard for interactive configuration
- Model selection via `.tinyclaw/model` config file
- `--dangerously-skip-permissions` flag added to CLI calls

**Problems accumulating:**
- WhatsApp pulled in Puppeteer/headless Chrome (massive dependency)
- `execSync` with string interpolation created shell injection risks
- Single shared conversation across all channels
- No streaming, 4K char cap, 2-min timeout

### Phase 3: "The Pinchening" -- Complete Rewrite (Feb 10, 2026 afternoon)
**Author**: Clawcian (co-authored with Claude Opus 4.6) | **Duration**: ~3 hours | **Single commit: +2,661 / -3,409 lines**

This was the watershed moment. A 1,075-line plan document titled **"TinyClaw 2: The Pinchening"** guided the rewrite.

**Removed entirely:**
- WhatsApp client + Puppeteer
- Discord client + discord.js
- `execSync` CLI invocation
- `--dangerously-skip-permissions` flag
- Single-conversation model

**Added:**
- Telegram forum client via grammY (each topic = independent session)
- Agent SDK v2 session management (`createSession`/`resumeSession`/`prompt`)
- 14-dimension smart router adapted from ClawRouter
- Shared JSONL message history with cross-thread visibility
- Routing decision audit trail
- `canUseTool` callback for granular permission control
- Cross-thread communication via file queue

**Version bumped from 1.0.0 to 2.0.0.**

### Phase 4: Stabilization (Feb 10, 2026 late afternoon)
**Author**: Clawcian | **Duration**: ~45 minutes | **2 commits**

1. **History context injection bug**: `buildHistoryContext()` was defined but never wired into the `UserPromptSubmit` hook. Classic "implemented but forgot to connect" bug.

2. **P1/P2 security and performance fixes** (12 findings):
   - P1: Shell injection in heredocs, missing chat ID verification
   - P2: Extracted shared types, optimized history reads (tail 64KB instead of full file), added caching for `loadThreads()`/`loadSettings()`, atomic writes, message-models.json pruning to 1000 entries

---

## Key Architectural Decisions

### 1. File-Based Queue (Survived All Phases)
The `incoming/` -> `processing/` -> `outgoing/` JSON file queue was the first pattern introduced and the only one that survived the complete rewrite. Benefits:
- **Crash recovery**: files persist on disk
- **Observability**: `ls` the queue to see state
- **Decoupling**: messaging client and AI processor are independent processes
- **Cross-thread communication**: agents write JSON with `targetThreadId` to the outgoing queue

### 2. Telegram Forum Topics as Session Boundaries
A Telegram "supergroup with Topics enabled" (called a "forum" in the Bot API) provides a single group chat with multiple independent conversation threads called "topics." Each topic maps to an independent Claude session with its own:
- Working directory (`cwd`)
- SDK session (preserved across messages)
- Model selection
- Conversation context

This replaced the single-conversation model with true multi-session architecture while keeping all management in one Telegram group.

### 3. Agent SDK v2 Over CLI Wrapping
Replacing `execSync("claude -c -p ...")` with the Agent SDK v2's session APIs was the core technical change:
- **Before**: Blocking synchronous shell calls, 2-min timeout, 4K char cap, shell injection risk
- **After**: Async session-based API, streaming, concurrent operations, granular tool control

Key SDK v2 APIs used:
- `unstable_v2_createSession()` -- new session with model, cwd, hooks, systemPrompt
- `unstable_v2_resumeSession()` -- resume with optional model switch
- `unstable_v2_prompt()` -- one-shot for heartbeats (no session overhead)

### 4. Smart Routing from ClawRouter
Instead of sending everything to one model, the router scores each message across 14 weighted dimensions to classify it as SIMPLE (haiku), MEDIUM (sonnet), or COMPLEX (opus).

**Upgrade-only rule for replies**: If you reply to a message answered by Opus, the reply also goes to Opus. Models never downgrade within a conversation thread. Fresh messages allow free model selection.

**Multilingual keywords**: The router config includes keywords in English, Chinese, and Japanese for international usage.

### 5. Master/Worker Thread Hierarchy
Thread 1 (General topic) is the "Master" with cross-thread visibility and coordination authority. Workers see only their own thread's history (20 entries). The master sees all threads (30 entries).

### 6. Per-Thread Heartbeats with Living Task Lists
Each active thread gets periodic heartbeat check-ins. Agents read and write `HEARTBEAT.md` as a working task list. Heartbeats always use haiku (cheapest model) and bypass the router entirely.

---

## Lessons Learned

### Shell Injection is Insidious
The original `execSync` approach had message content interpolated directly into shell commands. Even after the SDK rewrite eliminated `execSync`, shell injection lurked in heredocs within `tinyclaw.sh` and `heartbeat-cron.sh`. **Lesson**: Audit all shell scripts, not just application code.

### "Implemented but Not Wired" is a Common Bug Pattern
`buildHistoryContext()` was fully implemented but never called in the message processing flow. Caught within 1 minute of deployment. **Lesson**: After implementing a function, grep for its callsite. If it has zero callers, it's dead code.

### Heavy Dependencies Have Compound Costs
WhatsApp pulled in Puppeteer (headless Chrome). Discord added `discord.js`. Both were removed in v2 because neither supported the multi-topic forum model. **Lesson**: Choose the platform that matches your architectural model, not the one with the most users.

### Atomic File Writes Prevent Corruption
The original code used `fs.writeFileSync` directly. Readers could see partial files. The fix: write to `.tmp` then `fs.renameSync` (atomic on Linux). This is now a documented coding convention.

### JSONL Append Safety on Linux
On ext4, `fs.appendFileSync` is safe for concurrent writers because the kernel serializes via inode mutex. Each entry must be a complete JSON line + newline, kept under 4KB for POSIX `O_APPEND` atomicity guarantees.

### Model Routing Saves Real Money
The OpenClaw NORMS.md wisdom: "Heartbeats should never be Opus -- that's lighting money on fire." Smart routing with the 14-dimension scorer directs ~80% of messages to haiku or sonnet, reserving opus for genuinely complex tasks.

### Session Lifecycle Requires Explicit Cleanup
Each active SDK session spawns a child process (~50-100MB RAM). Failing to call `session.close()` creates orphan subprocesses. **Lesson**: Implement idle timeout cleanup (30 minutes) and graceful shutdown hooks.

---

## Technology Stack Evolution

| Component | v1.0 (Phase 1-2) | v2.0 (Phase 3-4) |
|---|---|---|
| Language | JavaScript -> TypeScript | TypeScript (nodenext) |
| Chat Platform | WhatsApp + Discord | Telegram (grammY) |
| AI Integration | `execSync("claude -c -p")` | Agent SDK v2 (sessions) |
| Model Selection | Static file | 14-dimension router |
| Session Model | Single shared conversation | Per-thread SDK sessions |
| History | None | Shared JSONL log |
| Validation | None | Zod |
| Node.js | v14+ | v22.22.0 |

---

## Prevention Strategies

### For Future Architecture Changes
1. Write a plan document first (like "The Pinchening" plan -- 1,075 lines)
2. Version bump explicitly when making breaking changes
3. Remove dead code immediately; don't leave compatibility shims

### For Security
1. Never interpolate user input into shell commands
2. Use SDK APIs instead of CLI wrappers
3. Verify chat ID on all Telegram commands
4. Deny dangerous tools via `canUseTool` callback (`AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`)

### For Reliability
1. Atomic file writes (write to .tmp, rename)
2. JSONL for append-only logs (O_APPEND safe on ext4)
3. Dead-letter queue for failed messages (max 3 retries)
4. Graceful shutdown: close all sessions, persist state

### For Cost Management
1. Smart routing with upgrade-only rule for replies
2. Heartbeats always use haiku
3. One-shot `prompt()` for heartbeats (no session overhead)
4. Idle session cleanup after 30 minutes

---

## Cross-References

- **Plan Document**: `docs/plans/2026-02-10-feat-agent-sdk-v2-smart-routing-upgrade-plan.md`
- **ClawRouter Source**: [github.com/BlockRunAI/ClawRouter](https://github.com/BlockRunAI/ClawRouter)
- **OpenClaw**: [openclaw.ai](https://openclaw.ai/)
- **Agent SDK v2 Docs**: [platform.claude.com/docs/en/agent-sdk/overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- **Telegram Bot API (Forums)**: [core.telegram.org/bots/api#forumtopic](https://core.telegram.org/bots/api#forumtopic)
- **grammY Framework**: [grammy.dev](https://grammy.dev/)
