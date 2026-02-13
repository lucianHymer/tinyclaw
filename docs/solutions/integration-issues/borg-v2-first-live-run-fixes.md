---
title: "Borg v2 First Live Run — Six Issues Found and Fixed"
category: integration-issues
problem_type: first-deployment
components:
  - telegram-client
  - queue-processor
  - session-manager
  - router
  - message-history
technologies:
  - telegram-bot-api
  - agent-sdk-v2
  - grammy
  - typescript
severity: critical
date_solved: 2026-02-10
authors:
  - clawcian
tags:
  - first-run
  - telegram
  - privacy-mode
  - system-prompts
  - multi-user
  - model-routing
  - emoji-reactions
  - tier-boundaries
  - session-management
  - history-injection
---

# Borg v2 First Live Run — Six Issues Found and Fixed

The first live deployment of Borg v2 surfaced six issues across Telegram configuration, agent identity, routing, and session management. All were resolved in a single session.

---

## Issue 1: Telegram Bot Not Receiving Messages

### Problem
Bot started successfully and logged "Borg Telegram bot started," but no messages appeared in logs. Complete silence — no errors, no warnings.

### Root Cause
Telegram bots in groups have **privacy mode** enabled by default. With privacy mode on, bots only see:
- Messages starting with `/` (commands)
- Direct replies to the bot's messages
- @mentions of the bot

Regular messages are invisible to the bot. The bot was not a group admin either.

### Fix
No code changes — Telegram configuration only:
1. Disabled Group Privacy via @BotFather (`/mybots` > Bot Settings > Group Privacy > Turn off)
2. Removed and re-added bot to the group (required for privacy change to take effect)

### Verification
Sent a test message via the Bot API to confirm the chat ID was correct:
```bash
curl -s "https://api.telegram.org/bot<TOKEN>/sendMessage" \
  -d "chat_id=-100XXXXXXXXXX&text=test"
```
This succeeded, proving the chat ID was fine — the issue was purely privacy mode.

---

## Issue 2: Agent Identity Confusion

### Problem
When messaged, the agent responded: *"I'm Claude Code (the AI assistant for software engineering in this IDE), not the Telegram bot."*

### Root Cause
The system prompt in `buildThreadPrompt()` was purely operational:
```
You are Borg Master, the coordination thread. You have visibility across all projects.
```
No mention of Telegram, no conversational framing. The agent defaulted to Claude Code's base identity.

### Fix
Rewrote system prompt to establish identity upfront:
```
You are Borg, an AI assistant that users communicate with through Telegram.
You are a full Claude Code agent with file access, code editing, terminal commands,
and web search. Users send you messages in a Telegram forum topic and you respond
there. Treat every incoming message as a direct conversation with the user — be
helpful, conversational, and action-oriented.
```
Also added: "Keep responses concise — Telegram messages over 4000 characters get split."

### Files Changed
- `src/session-manager.ts` — `buildThreadPrompt()` for both master and worker prompts

---

## Issue 3: No Multi-User Awareness

### Problem
Agent didn't know who was talking. Treated all messages as if from a single anonymous user.

### Root Cause
Messages were correctly prefixed with `[Lucian via Telegram]:` by `buildSourcePrefix()` in the queue processor, but the system prompt never explained this pattern or mentioned that multiple team members could message.

### Fix
Added to system prompt (both master and worker):
```
Multiple team members may message you. Each message is prefixed with the sender's
name (e.g. "[Lucian via Telegram]:"). Pay attention to who is talking — address
them by name when appropriate and keep track of what each person is working on or
asking about.
```

### Files Changed
- `src/session-manager.ts` — `buildThreadPrompt()` for both master and worker prompts

---

## Issue 4: No Model Visibility

### Problem
No way to tell which model (haiku/sonnet/opus) handled each response. The smart routing system was working but invisible to users.

### Root Cause
The routing decision was logged internally (routing.jsonl) and stored in message-models.json, but nothing was surfaced to the user in Telegram.

### Fix
Added emoji reactions to bot responses using Telegram's `setMessageReaction` API:

| Model | Emoji | Meaning |
|-------|-------|---------|
| haiku | ⚡ | Fast/lightweight |
| sonnet | ✍ | Writing hand |
| opus | 🔥 | Fire/powerful |

Implementation:
```typescript
const MODEL_REACTIONS: Record<string, string> = {
    haiku: "⚡",
    sonnet: "✍",
    opus: "🔥",
};

async function reactWithModel(chatId, messageId, model): Promise<void> {
    const emoji = MODEL_REACTIONS[model];
    if (!emoji) return;
    try {
        await bot.api.setMessageReaction(chatId, messageId,
            [{ type: "emoji", emoji: emoji as any }]);
    } catch {
        // Reactions may not be available in all groups — silently ignore
    }
}
```

Called after every `sendMessage` in all three send paths (standard reply, cross-thread, fallback).

**Gotcha:** Not all emoji are valid Telegram reactions. `🎵` (musical note) returns `REACTION_INVALID`. The valid set is limited — test via the API before choosing. `✍` (writing hand) works.

### Files Changed
- `src/telegram-client.ts` — added `MODEL_REACTIONS`, `reactWithModel()`, and wired into all send paths

---

## Issue 5: Haiku Tier Unreachable

### Problem
Even trivial messages like "hi" or "what time is it?" always routed to sonnet. Haiku was never selected.

### Root Cause
Three compounding issues:

1. **Boundary too low:** `tierBoundaries.simpleMedium` was `0.0`. A message needs a *negative* weighted score to classify as SIMPLE. The only negative contributors are `simpleIndicators` (weight 0.12, score -1.0 = -0.12) and `tokenCount` for short messages (weight 0.08, score -1.0 = -0.08). Max negative: -0.20, but any other dimension scoring even slightly positive overwhelms this.

2. **Ambiguous default:** `ambiguousDefaultTier: "MEDIUM"` — anything with low confidence defaults to sonnet.

3. **History inflation:** The enriched prompt for routing includes the last 5 messages of conversation history. Prior messages about code, architecture, etc. inject keywords that inflate the score for a simple follow-up.

### Fix
Raised tier boundaries:
```typescript
tierBoundaries: {
    simpleMedium: 0.0 → 0.08,   // Messages below 0.08 → haiku
    mediumComplex: 0.15 → 0.20,  // Messages above 0.20 → opus
}
```

This creates realistic separation: casual messages with only mild positive signals from history context still land in SIMPLE.

### Files Changed
- `src/router/config.ts` — `tierBoundaries.simpleMedium` and `tierBoundaries.mediumComplex`

---

## Issue 6: History Context Injected on Every Message

### Problem
`buildHistoryContext()` prepended 20-30 history entries to every prompt, even on resumed sessions where the SDK already had the full conversation context.

### Root Cause
The queue processor called `buildHistoryContext()` unconditionally for every message. It didn't distinguish between:
- **New sessions** — need history injected to provide context the session lacks
- **Resumed sessions** — already have full conversation state in the SDK

### Fix
Made `getSession()` return whether the session is new:
```typescript
async function getSession(...): Promise<{ session: SDKSession; isNew: boolean }>
```

Then conditional injection:
```typescript
const { session, isNew } = await getSession(threadId, threadConfig, effectiveModel);

if (isNew) {
    const historyContext = buildHistoryContext(threadId, threadConfig.isMaster);
    fullPrompt = `[${now}]\n\n${historyContext}\n\n${prefix} ${message}`;
} else {
    fullPrompt = `[${now}] ${prefix} ${message}`;
}
```

Resumed and cached sessions get just timestamp + sender prefix + message. The system prompt still tells the agent where to find history (`tail .borg/message-history.jsonl`) if it needs it after compaction.

Also fixed a stale comment in `message-history.ts` that said "for UserPromptSubmit hook injection" — the actual implementation is inline in the queue processor, not hook-based.

### Files Changed
- `src/queue-processor.ts` — `getSession()` return type, conditional history injection
- `src/message-history.ts` — fixed stale comment

---

## First Live Run Deployment Checklist

Based on these findings, use this checklist for future Borg deployments:

### Telegram Bot Setup
- [ ] Bot privacy mode is **OFF** (@BotFather > Bot Settings > Group Privacy)
- [ ] Bot is added to the group **after** changing privacy mode
- [ ] Bot is a group admin (alternative to disabling privacy mode)
- [ ] Test: send a regular message (not a command) — verify it appears in logs

### System Prompt Verification
- [ ] System prompt mentions "Telegram" in the first sentence
- [ ] System prompt establishes conversational identity (not just operational role)
- [ ] System prompt mentions multi-user sender prefix pattern
- [ ] System prompt mentions 4000-char Telegram message limit
- [ ] Test: send "hello, who are you?" — response should mention Telegram and the sender's name

### Model Routing
- [ ] Send a simple message ("hi") — verify it routes to haiku (⚡ reaction)
- [ ] Send a complex message — verify it routes to opus (🔥 reaction)
- [ ] Check `routing.jsonl` for tier distribution across first 10 messages
- [ ] If haiku never appears, raise `simpleMedium` threshold

### Session Management
- [ ] First message creates a new session (check logs for "Creating new session")
- [ ] Second message resumes the session (no "injecting history" in logs)
- [ ] `/reset` creates a fresh session on next message
- [ ] Verify `threads.json` has valid `sessionId` after first exchange

---

## Cross-References

- **Evolution doc:** `docs/solutions/integration-issues/borg-v2-evolution-from-fork-to-forum-agent.md`
- **Architecture plan:** `docs/plans/2026-02-10-feat-agent-sdk-v2-smart-routing-upgrade-plan.md`
- **ClawRouter (routing source):** [github.com/BlockRunAI/ClawRouter](https://github.com/BlockRunAI/ClawRouter)
- **Telegram Bot API reactions:** [core.telegram.org/bots/api#setmessagereaction](https://core.telegram.org/bots/api#setmessagereaction)
- **Agent SDK v2 sessions:** [platform.claude.com/docs/en/agent-sdk/overview](https://platform.claude.com/docs/en/agent-sdk/overview)
