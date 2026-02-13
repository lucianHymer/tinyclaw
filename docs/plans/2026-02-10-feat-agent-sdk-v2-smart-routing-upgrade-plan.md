---
title: "feat: Borg 2: The Pinchening"
type: feat
date: 2026-02-10
---

# Borg 2: The Pinchening

### Telegram Forum-Based Multi-Session Agent with SDK v2, Smart Routing, and Cross-Thread Orchestration

## Overview

Replace Borg's `execSync` CLI wrapper with the Agent SDK v2 session-based API, built around a Telegram forum group where each topic is an independent Claude session with its own working directory. Add the 14-dimension prompt routing engine from anthropic-router, a shared JSONL message history, cross-thread communication via system prompt instructions, and remove both WhatsApp and Discord.

## Architecture

```
+-----------------------------------------------+
|         Telegram Forum Group                   |
|                                                |
|  +----------+ +----------+ +----------+       |
|  | General  | | Passport | | Borg |  ...  |
|  | (Master) | |  topic   | |  topic   |       |
|  | thread:1 | | thread:5 | | thread:9 |       |
|  +----+-----+ +----+-----+ +----+-----+       |
+-------|-----------|-----------|---------+------+
        |           |           |
        v           v           v
+-----------------------------------------------+
|           Telegram Client (grammy)             |
|  - Receives all messages from all topics       |
|  - Tags with threadId, isReply                 |
|  - Writes to incoming queue                    |
|  - Polls outgoing queue                        |
|  - Routes responses to correct topic           |
|  - Handles cross-thread messages               |
+------------------+----------------------------+
                   |
            +------v------+
            |  File Queue  |
            |  incoming/   |
            |  outgoing/   |
            |  processing/ |
            +------+------+
                   |
+------------------v----------------------------+
|            Queue Processor                     |
|                                                |
|  +------------------------------------------+ |
|  |  Session Manager                          | |
|  |  threads.json -> threadId:session         | |
|  |  create / resume / close                  | |
|  +--------------------+---------------------+ |
|                       |                        |
|  +--------------------v---------------------+ |
|  |  Router (per message)                     | |
|  |  enriched with same-thread history        | |
|  |  reply = upgrade-only (maxTier)           | |
|  |  fresh message = free pick                | |
|  +--------------------+---------------------+ |
|                       |                        |
|  +--------------------v---------------------+ |
|  |  SDK Sessions (one per thread)            | |
|  |  cwd: thread-specific                     | |
|  |  model: router-selected                   | |
|  |  hooks: UserPromptSubmit history injection | |
|  |  systemPrompt: thread-aware               | |
|  +------------------------------------------+ |
|                                                |
|  +------------------------------------------+ |
|  |  Shared JSONL History                     | |
|  |  tagged by threadId                       | |
|  |  all threads read/write                   | |
|  +------------------------------------------+ |
+------------------------------------------------+
```

**Five components, clean separation:**

1. **Telegram Client** -- single process, handles all topics, pure I/O
2. **File Queue** -- JSON files in incoming/processing/outgoing directories
3. **Session Manager** -- maps threadId -> SDK session lifecycle
4. **Router** -- 14-dimension scoring engine from anthropic-router
5. **JSONL History** -- shared log, tagged by threadId

## Problem Statement / Motivation

The current `queue-processor.ts` calls Claude via `execSync("claude --dangerously-skip-permissions -c -p ...")`. This has several problems:

1. **Blocking**: `execSync` freezes the Node.js event loop -- no health checks, no graceful shutdown, no concurrent operations during Claude processing
2. **Shell injection risk**: Messages are interpolated into a shell command with only double-quote escaping. Backticks, `$()`, and `\` in user messages can be interpreted by the shell
3. **No streaming**: Responses are returned as one blob, capped at 4,000 chars and a 2-minute timeout
4. **Blanket permissions**: `--dangerously-skip-permissions` grants unrestricted system access with no ability to restrict specific tools
5. **No model intelligence**: A static model config file -- every message uses the same model regardless of complexity
6. **No message history access**: The agent can't look back at previous messages. Conversation context is locked inside the CLI session
7. **Discord + WhatsApp dead weight**: WhatsApp pulls in Puppeteer (headless Chrome). Discord adds a heavy dependency. Neither supports the multi-topic forum model we want
8. **Single conversation**: All channels feed into one Claude conversation. No way to have parallel conversations about different projects

## Core Design Decisions

### 1. Telegram Forum Group as the Platform

One Telegram supergroup with forum/topics enabled. Each topic is an independent conversation thread.

- **General topic (thread_id: 1)** = Master channel. Always exists, can't be deleted. Coordinates other threads, has cross-thread visibility.
- **Other topics** = Project threads. Each maps to a repo/workspace with its own Claude session.
- **Bot requires admin** with `can_manage_topics` permission.
- **Bot can create topics programmatically** via `createForumTopic()`. The master can spin up new project threads.
- **6 icon colors available** for visual distinction (blue, yellow, purple, green, pink, red).
- **grammY >= 1.37.1** auto-replies to the correct topic. No plugin needed.
- **Bots can't list existing topics** via Bot API. We track them in `threads.json`.

### 2. Session-Per-Topic

Each Telegram topic maps to exactly one Claude SDK session. Sessions are independent -- different working directories, different models, different conversation contexts.

**Thread configuration** stored in `.borg/threads.json`:

```json
{
  "1": {
    "name": "Master",
    "cwd": "/home/clawcian/.openclaw/workspace",
    "sessionId": "abc-123",
    "model": "sonnet",
    "isMaster": true,
    "lastActive": 1707580800000
  },
  "5": {
    "name": "Passport",
    "cwd": "/home/clawcian/.openclaw/workspace/passport",
    "sessionId": "def-456",
    "model": "opus",
    "isMaster": false,
    "lastActive": 1707581400000
  }
}
```

**Session lifecycle per topic:**
- First message in a new/unconfigured topic -> prompt user for `cwd` via `/setdir <path>`, or master creates it with config
- First message in a configured topic -> `createSession()` with thread-specific options
- Subsequent messages -> `resumeSession(sessionId, options)`
- Resume failure -> delete sessionId, fall back to `createSession()`
- Model change -> `session.close()` then `resumeSession(sessionId, { model: newModel })` -- preserves full conversation history
- `/reset` in a topic -> delete that topic's sessionId, next message creates fresh session

### 3. Reply = Upgrade-Only Routing Signal

Replies and fresh messages have different routing semantics:

- **Reply to a bot message** (`ctx.msg.reply_to_message?.from?.id === bot.botInfo.id`): Model can only go UP from the **model that generated the replied-to message**. Uses `maxTier(replyToModel, routedTier)`. Rationale: replying implies "continue this thread of thought at the same quality level or higher."
- **Fresh message** (not a reply): Router picks freely. Can downgrade. Rationale: new thought, let the router assess fresh.

The `isReply` flag and `replyToModel` are set by the Telegram client and passed through the queue.

**Reply-to-model tracking:** When the Telegram client sends a bot response, it stores `{ telegramMessageId → model }` in `.borg/message-models.json`. When a reply comes in, it looks up `ctx.msg.reply_to_message.message_id` to get the model that produced it.

```typescript
// Telegram client -- on sending response
const sent = await ctx.reply(responseText);
storeMessageModel(sent.message_id, response.model); // persist mapping

// Telegram client -- on receiving reply
const replyToModel = isReplyToBot
  ? lookupMessageModel(ctx.msg.reply_to_message.message_id)
  : undefined;

const queueData = {
  // ...existing fields
  isReply: isReplyToBot,
  replyToText,
  replyToModel, // "opus" | "sonnet" | "haiku" | undefined
};
```

### 4. Router Enriched with Thread History

The router from anthropic-router is stateless -- it scores a single string. To avoid misclassifying short replies like "yes do it" that follow complex questions, we enrich the router input with recent same-thread history:

```typescript
const recentHistory = getRecentHistory({ threadId, limit: 5 });
const enrichedPrompt = recentHistory
  .map(m => `[${m.sender}]: ${m.message}`)
  .join('\n') + '\n[current]: ' + message;

const decision = route(enrichedPrompt, undefined, { config });
```

Additionally, when the user replies to a specific bot message, `reply_to_message.text` is available and can be prepended for even better context.

### 5. Model Switching via Session Resume

The SDK v2 does not support `setModel()` mid-session. But `resumeSession(sessionId, { model: newModel })` works -- it preserves the full conversation history while switching the model.

**Strategy:**
1. Every message gets routed (not just the first)
2. If `isReply` -> `effectiveTier = maxTier(replyToModel, routedTier)` (upgrade only from the model that produced the replied-to message)
3. If fresh message -> `effectiveTier = routedTier` (free pick)
4. If `effectiveTier` differs from current session model -> `session.close()` then `resumeSession(id, { model: effectiveTier })`
5. If same -> use existing session directly
6. Heartbeat messages bypass router AND session -- use `unstable_v2_prompt()` one-shot with haiku

~1-1.5s overhead per resume (subprocess restart). Acceptable for a queue processor.

### 6. Cross-Thread Communication via System Prompt

Each session gets cross-thread communication instructions in its `systemPrompt.append`. No MCP server needed -- agents use their existing Read, Write, Grep tools.

**Worker threads:**
```
You are Borg, operating in thread "Passport" (/home/clawcian/.openclaw/workspace/passport).

Cross-thread communication:
- Active threads: Read .borg/threads.json
- Other threads' history: Grep .borg/message-history.jsonl for their threadId
- Message another thread: Write JSON to .borg/queue/outgoing/ with targetThreadId field
- If you lose context after compaction: tail .borg/message-history.jsonl for your threadId
```

**Master thread (General topic):**
```
You are Borg Master, the coordination thread. You have visibility across all projects.

You can:
- See all active threads and their status in .borg/threads.json
- Read any thread's history from .borg/message-history.jsonl
- Message any thread by writing to .borg/queue/outgoing/ with targetThreadId
- Create new topics via Telegram (the bot handles createForumTopic)
- Broadcast to all threads by writing multiple outgoing messages

Your UserPromptSubmit hook injects recent activity from ALL threads, not just yours.
```

### 7. General Topic (Master) vs Other Topics

The master differs from other topics only in configuration, not code paths:

| Concern | General (Master) | Other Topics |
|---|---|---|
| `cwd` | `~/workspace/` (parent) | `~/workspace/passport/` etc. |
| System prompt | Coordination instructions | Standard thread instructions |
| History injection | Recent activity from ALL threads | Only THIS thread's history |
| Always exists | Hardcoded in threads.json | Dynamic, created/removed |
| `isMaster` flag | `true` | `false` |

In code:

```typescript
const isMaster = threadId === 1;
const history = isMaster
  ? getRecentHistory({ limit: 30 })                // ALL threads
  : getRecentHistory({ threadId, limit: 20 });      // just this thread
```

### 8. Message Source Typing

Every queue message carries a `source` field identifying its origin:

```typescript
type MessageSource =
  | "user"           // human typed in Telegram
  | "cross-thread"   // another session sent this via outgoing queue
  | "heartbeat"      // periodic check-in from heartbeat-cron.sh
  | "cli"            // borg.sh send command
  | "system";        // internal event (startup, reset, etc.)
```

**Why this matters:** Cross-thread messages are written directly to the incoming queue by the Telegram client (queue-to-queue canonical path). The Telegram post to the target topic is optional visibility only. The bot always filters its own Telegram messages (`ctx.from.id === bot.botInfo.id`), which is a universal bot pattern. The `source` field lets the queue processor and session distinguish message origins without relying on implicit coupling.

**Source-aware prompt formatting:**

```typescript
const prefix = {
  "user":         `[${msg.sender} via Telegram]:`,
  "cross-thread": `[Cross-thread from ${msg.sender} (thread ${msg.sourceThreadId})]:`,
  "heartbeat":    `[Heartbeat check-in]:`,
  "cli":          `[CLI message]:`,
  "system":       `[System event]:`,
}[msg.source];
```

The queue processor processes ALL sources -- no filtering by source type. The source only affects how the message is presented to the session.

### 9. Per-Thread Heartbeats with HEARTBEAT.md

Each active thread gets its own periodic heartbeat. The heartbeat prompt is generic -- the thread's CWD makes it project-specific.

**Heartbeat prompt** (same for all threads):

```
Read HEARTBEAT.md if it exists. Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK.
```

**How CWD makes it per-thread:**
- Passport thread (`cwd: ~/workspace/passport/`) reads `~/workspace/passport/HEARTBEAT.md`
- Borg thread (`cwd: ~/workspace/borg/`) reads `~/workspace/borg/HEARTBEAT.md`
- Master thread (`cwd: ~/workspace/`) reads `~/workspace/HEARTBEAT.md`

**HEARTBEAT.md is a living document.** The agent reads AND writes to it. It is both an input and a working to-do list:

    # HEARTBEAT.md

    ## Time-Boxed Tasks
    - [ ] Review PR #42 by end of day
    - [x] Update auth module tests

    ## Periodic Checks
    - [ ] Uncommitted changes on feature branches
    - [ ] Failing tests
    - [ ] Stale PRs

    ## Background Work
    - [ ] Update documentation after auth refactor

The agent checks off items, adds new ones, removes stale ones. Each heartbeat is productive work, not just a ping.

**Heartbeat cron iterates threads.json:**

```bash
# heartbeat-cron.sh
for each active thread in threads.json:
  THREAD_ID=$(extract threadId)
  PROMPT="Read HEARTBEAT.md if it exists. Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK."
  write heartbeat JSON to incoming queue with:
    threadId: $THREAD_ID
    source: "heartbeat"
    message: "$PROMPT"
```

**Heartbeat routing rules:**
- Heartbeats bypass the router AND the thread's session entirely
- Use `unstable_v2_prompt()` (one-shot SDK function) with haiku -- no session management, no model ping-pong
- "Heartbeats should never be Opus -- that's lighting money on fire." (from OpenClaw NORMS.md)
- The one-shot call gets the thread's `cwd` and `settingSources` so it can read HEARTBEAT.md and project files
- No conversation context needed -- heartbeats read files, not chat history

```typescript
const result = await unstable_v2_prompt(heartbeatPrompt, {
  model: "haiku",
  cwd: threadConfig.cwd,
  settingSources: ["project"] as const,
  canUseTool,
  systemPrompt: {
    type: "preset" as const,
    preset: "claude_code" as const,
    append: buildHeartbeatPrompt(threadConfig),
  },
});
```

The heartbeat system prompt includes cross-thread reporting instructions:

```typescript
function buildHeartbeatPrompt(threadConfig: ThreadConfig): string {
  return `You are Borg heartbeat for "${threadConfig.name}" (${threadConfig.cwd}).

Read HEARTBEAT.md if it exists and follow it. You can edit HEARTBEAT.md to update task status.
Reply HEARTBEAT_OK if nothing needs attention.

If something significant happened, failed, or needs attention from another thread:
- Write a JSON file to .borg/queue/outgoing/ with a targetThreadId field to notify that thread
- To notify the Master thread, use targetThreadId: 1
- Format: {"channel":"telegram","targetThreadId":1,"sourceThreadId":${threadConfig.threadId},"sender":"borg:${threadConfig.name}","message":"<what happened>","timestamp":${Date.now()},"messageId":"heartbeat_alert_<unique>"}

Active threads are listed in .borg/threads.json if you need to find the right targetThreadId.`;
}
```

This means the heartbeat can:
- Read HEARTBEAT.md and act on it (via cwd)
- Edit HEARTBEAT.md to track progress
- Check git status, run tests, inspect files (via tools)
- Report failures or notable events to the Master thread (via queue)
- Report to specific threads when relevant (e.g., "Passport: your tests are failing")

**`HEARTBEAT_OK` convention:** If nothing needs attention, the agent replies with just `HEARTBEAT_OK`. Short, cheap tokens. The heartbeat cron can detect this and skip posting to Telegram (no need to clutter the topic with "all clear" messages).

**heartbeat-state.json** (optional, per-thread): The agent can track when checks were last performed to avoid redundant work:

```json
{
  "lastChecks": {
    "uncommittedChanges": 1707580800000,
    "failingTests": 1707570000000,
    "stalePRs": 1707500000000
  }
}
```

**System prompt addition** (all threads):

```
You receive periodic heartbeat messages. Read HEARTBEAT.md in your working directory
and follow it. You can edit HEARTBEAT.md to maintain your own task list. Reply
HEARTBEAT_OK if nothing needs attention.
```

### 10. Timezone and Time Injection

Every message gets the current local time prepended via the `UserPromptSubmit` hook. The timezone is configured in settings.

**In `.borg/settings.json`:**

```json
{
  "timezone": "America/Denver"
}
```

**In the `UserPromptSubmit` hook:**

```typescript
const now = new Date().toLocaleString("en-US", {
  timeZone: config.timezone,
  weekday: "long",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

additionalContext: `[${now}]\n\n${historyContext}`
// e.g. "[Monday, Feb 10, 2026, 3:42 PM MST]\n\nRecent messages: ..."
```

This means the agent always knows what time it is, which affects:
- Heartbeat behavior (stay quiet late at night)
- Time-relative responses ("earlier today", "this morning")
- Deadline awareness in HEARTBEAT.md tasks

### 11. ESM Compatibility: Option C (Minimal Change)

Node 22.22.0 supports `require(esm)` natively (unflagged since 22.12.0). The SDK has no top-level await, so it loads via `require()`.

**Only tsconfig changes needed:**

```json
{
  "target": "ES2022",
  "module": "nodenext",
  "moduleResolution": "nodenext"
}
```

- `__dirname` keeps working (files stay CJS)
- No `.js` extension changes needed (no relative imports exist between current files)
- Grammy is dual-format CJS+ESM, works without changes
- Risk: if SDK adds top-level `await` in future, `require(esm)` breaks. Low likelihood.

## Proposed Solution

### 1. Agent SDK v2 Integration

Replace the `execSync` CLI call with the SDK's session-based API:

```typescript
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from "@anthropic-ai/claude-agent-sdk";

const sessionOptions = {
  model: selectedModel,
  cwd: threadConfig.cwd,
  canUseTool,
  settingSources: ["project"] as const,
  systemPrompt: {
    type: "preset" as const,
    preset: "claude_code" as const,
    append: buildThreadPrompt(threadConfig),
  },
  hooks: {
    UserPromptSubmit: [{
      hooks: [async (input) => ({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: buildHistoryContext(threadConfig),
        },
      })],
    }],
  },
};

const session = threadConfig.sessionId
  ? unstable_v2_resumeSession(threadConfig.sessionId, sessionOptions)
  : unstable_v2_createSession(sessionOptions);

await session.send(message);
let response = "";
for await (const msg of session.stream()) {
  threadConfig.sessionId = msg.session_id; // always capture (may change on resume)
  if (msg.type === "assistant") {
    response += msg.message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
  }
}
session.close(); // required -- prevents orphan subprocess
```

**Key SDK details:**
- `systemPrompt: { type: 'preset', preset: 'claude_code', append: '...' }` preserves Claude Code's full system prompt
- `settingSources: ['project']` loads the target repo's CLAUDE.md
- `UserPromptSubmit` hook with `additionalContext` injects dynamic history before each message
- Session resume can return a different `session_id` -- always capture from stream
- Peer dependency on `zod ^4.0.0`
- `session.close()` is required to prevent orphan child processes

### 2. Session Manager

New module `src/session-manager.ts` that manages the threadId -> session mapping:

**Responsibilities:**
- Load/save `threads.json`
- Create new sessions for unconfigured topics
- Resume existing sessions
- Handle resume failures (fall back to create)
- Model switching via close + resume
- Session cleanup on shutdown
- Track active sessions for resource management (cap concurrent sessions)

**Concurrency:** One message processed at a time across all threads. The concurrency guard prevents overlapping async calls. Future optimization: process messages from different threads concurrently (each has its own session).

```typescript
let processing = false;

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    // ... process next message
  } finally {
    processing = false;
  }
}
```

### 3. Local JSONL Message History

Store every message (inbound and outbound, from any thread) in `.borg/message-history.jsonl`.

**Log format:**

```jsonl
{"ts":1707580800000,"threadId":5,"channel":"telegram","sender":"alice","direction":"in","message":"Can you refactor the auth module?","sessionId":"def-456"}
{"ts":1707580830000,"threadId":5,"channel":"telegram","sender":"borg","direction":"out","message":"I'll look at the auth module...","sessionId":"def-456","model":"opus"}
{"ts":1707581400000,"threadId":1,"channel":"heartbeat","sender":"system","direction":"in","message":"Quick status check","sessionId":"abc-123"}
```

**Agent access (two mechanisms):**

1. **UserPromptSubmit hook injection**: Before each `session.send()`, the hook injects recent history as `additionalContext`. Worker threads get their own thread's history. Master gets all threads' history.

2. **Self-service recovery**: The system prompt tells the agent to `tail` or `grep` the JSONL when it notices context gaps after compaction.

**Concurrent append safety:** On Linux ext4, `fs.appendFileSync` uses `O_APPEND` with kernel inode mutex serialization. Multiple processes appending complete lines (each under 4KB) will produce intact, non-interleaved output. Safe for our use case.

**Rotation:** When file exceeds ~10MB, rotate to `message-history.1.jsonl` (keep 1 backup).

### 4. Smart Model Routing

Copy the 14-dimension weighted scoring engine from `anthropic-router/src/router/` (4 files, ~400 lines of pure TypeScript, zero external deps):

| File | Purpose | Lines |
|---|---|---|
| `src/router/types.ts` | Tier, RoutingDecision, ScoringConfig types | 85 |
| `src/router/rules.ts` | 14-dimension weighted classifier | 243 |
| `src/router/config.ts` | DEFAULT_ROUTING_CONFIG with weights/thresholds | 131 |
| `src/router/index.ts` | `route()` entry point | 80 |

Plus the optional logger (`src/logger.ts`, 87 lines, uses `node:fs` + `node:crypto`).

**14 scoring dimensions** (weights sum to 1.0):

| Dimension | Weight | What it detects |
|---|---|---|
| reasoningMarkers | 0.18 | "prove", "step by step", "chain of thought" |
| codePresence | 0.15 | function, class, import, async |
| simpleIndicators | 0.12 | "what is", "define", "hello" (negative scores) |
| multiStepPatterns | 0.12 | "first...then", numbered lists |
| technicalTerms | 0.10 | algorithm, kubernetes, distributed |
| tokenCount | 0.08 | Short (<50) vs long (>500 tokens) |
| creativeMarkers | 0.05 | story, poem, brainstorm |
| questionComplexity | 0.05 | Multiple question marks |
| constraintCount | 0.04 | "at most", "within", "budget" |
| imperativeVerbs | 0.03 | build, create, implement |
| outputFormat | 0.03 | json, yaml, csv, table |
| referenceComplexity | 0.02 | "above", "previous", "the docs" |
| domainSpecificity | 0.02 | quantum, fpga, genomics |
| negationComplexity | 0.01 | "don't", "avoid", "except" |

**Model mapping:** `SIMPLE -> "haiku"`, `MEDIUM -> "sonnet"`, `COMPLEX -> "opus"`. The SDK resolves short names to latest versions.

**Reasoning fast-path:** 2+ reasoning keywords in user text forces COMPLEX at 85%+ confidence, regardless of other dimensions.

**Router integration with reply-based routing:**

```typescript
const recentHistory = getRecentHistory({ threadId, limit: 5 });
const enrichedPrompt = buildEnrichedPrompt(recentHistory, message, replyToText);
const decision = route(enrichedPrompt, undefined, { config });

const effectiveTier = isReply && msg.replyToModel
  ? maxTier(msg.replyToModel, decision.tier)  // reply = upgrade only from replied-to model
  : decision.tier;                             // fresh = free pick
```

**Import extensions:** The router source uses `.js` import extensions (`from "./types.js"`), which matches `"module": "nodenext"` resolution.

### 5. Telegram Client (grammY)

Single Telegram client using [grammY](https://grammy.dev/) that handles all topics in one forum group.

```typescript
import { Bot } from "grammy";
import { autoChatAction, AutoChatActionFlavor } from "@grammyjs/auto-chat-action";
import { autoRetry } from "@grammyjs/auto-retry";

type MyContext = Context & AutoChatActionFlavor;
const bot = new Bot<MyContext>(process.env.TELEGRAM_BOT_TOKEN!);

// Plugins
bot.use(autoChatAction());
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));

// Error handler (mandatory -- default stops the bot)
bot.catch((err) => {
  console.error(`Error handling update ${err.ctx.update.update_id}:`, err.error);
});

// Skip bot's own messages (cross-thread goes through queue, not Telegram)
bot.on("message:text").filter(
  (ctx) => ctx.from.id !== bot.botInfo.id,
  async (ctx) => {
  const threadId = ctx.msg.message_thread_id ?? 1; // default to General
  const isReplyToBot = ctx.msg.reply_to_message?.from?.id === bot.botInfo.id;
  const replyToText = isReplyToBot ? ctx.msg.reply_to_message?.text : undefined;

  ctx.chatAction = "typing"; // auto-repeats until handler returns

  const messageId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const queueData = {
    channel: "telegram",
    source: "user" as const,
    threadId,
    sender: ctx.from.first_name,
    senderId: String(ctx.from.id),
    message: ctx.message.text,
    isReply: isReplyToBot,
    replyToText,
    timestamp: Date.now(),
    messageId,
  };

  writeFileSync(
    `.borg/queue/incoming/telegram_${messageId}.json`,
    JSON.stringify(queueData),
  );

  pendingMessages.set(messageId, { ctx, chatId: ctx.chat.id, threadId });
});

// Commands
bot.command("reset", async (ctx) => {
  const threadId = ctx.msg.message_thread_id ?? 1;
  // Delete sessionId for this thread, next message creates fresh session
  resetThread(threadId);
  await ctx.reply("Session reset! Starting fresh.");
});

bot.command("setdir", async (ctx) => {
  const threadId = ctx.msg.message_thread_id ?? 1;
  const dir = ctx.match?.trim();
  if (!dir) return ctx.reply("Usage: /setdir /path/to/repo");
  configureThread(threadId, { cwd: dir });
  await ctx.reply(`Working directory set to: ${dir}`);
});

bot.command("status", async (ctx) => {
  const threads = loadThreads();
  // Format active threads with model, cwd, last activity
  await ctx.reply(formatThreadStatus(threads));
});

// Graceful shutdown
process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());

bot.start({ onStart: () => console.log("Borg Telegram bot started") });
```

**Key features:**
- `autoChatAction` plugin auto-repeats typing indicator until handler finishes
- `autoRetry` plugin handles Telegram 429 rate limits with backoff
- Messages without `message_thread_id` default to General topic (thread 1)
- `ctx.reply()` auto-targets the correct topic (grammY >= 1.37.1)
- Message splitting at 4,096 chars (paragraph-aware, implemented manually)
- Outgoing queue polling: check for `telegram_*.json` and cross-thread messages (`targetThreadId`)
- Restrict to a single forum group by chat ID in config

### 6. Tool Permission Control (Arbiter Pattern)

```typescript
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

export const canUseTool: CanUseTool = async (toolName, input) => {
  if (toolName === "AskUserQuestion") {
    return {
      behavior: "deny",
      message: "No human is available. State what you need in your response text.",
    };
  }

  if (toolName === "EnterPlanMode" || toolName === "ExitPlanMode") {
    return { behavior: "deny", message: "Plan mode is not available." };
  }

  return { behavior: "allow", updatedInput: input };
};
```

### 7. Queue Processor with fs.watch

Replace 1-second `setInterval` polling with `fs.watch` + fallback:

```typescript
import { watch } from "fs";

// Primary: event-driven via inotify
watch(QUEUE_INCOMING, (eventType) => {
  if (eventType === "rename") processQueue();
});

// Fallback: relaxed polling every 5 seconds
setInterval(processQueue, 5000);
```

`fs.watch` on a single flat directory on Linux ext4 is reliable. The fallback catches any missed events.

### 8. WhatsApp and Discord Removal

Delete both clients and all references:

| File | Action |
|---|---|
| `src/whatsapp-client.ts` | Delete entirely |
| `src/discord-client.ts` | Delete entirely |
| `package.json` | Remove `whatsapp-web.js`, `qrcode-terminal`, `@types/qrcode-terminal`, `discord.js`, `dotenv`; add `@anthropic-ai/claude-agent-sdk`, `grammy`, `@grammyjs/auto-chat-action`, `@grammyjs/auto-retry`, `zod` |
| `borg.sh` | Rewrite for Telegram-only: 3 panes (telegram + queue + logs) |
| `setup-wizard.sh` | Remove WhatsApp/Discord options, add Telegram bot token + group chat ID |
| `README.md` | Remove WhatsApp/Discord references, document Telegram forum setup |
| `.claude/hooks/session-start.sh` | Update to reflect new architecture |
| `.gitignore` | Remove `.borg/whatsapp-session/`, `.wwebjs_cache`; add `.borg/threads.json`, `.borg/message-history.jsonl` |

## Queue Message Format

### Incoming (user message via Telegram)

```json
{
  "channel": "telegram",
  "source": "user",
  "threadId": 5,
  "sender": "alice",
  "senderId": "123456789",
  "message": "Can you refactor the auth module?",
  "isReply": false,
  "replyToText": null,
  "timestamp": 1707580800000,
  "messageId": "1707580800000_abc123"
}
```

### Incoming (per-thread heartbeat)

```json
{
  "channel": "heartbeat",
  "source": "heartbeat",
  "threadId": 5,
  "sender": "system",
  "senderId": "heartbeat",
  "message": "Read HEARTBEAT.md if it exists. Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK.",
  "isReply": false,
  "timestamp": 1707580800000,
  "messageId": "heartbeat_5_1707580800_12345"
}
```

### Incoming (cross-thread, written directly to queue by Telegram client)

```json
{
  "channel": "telegram",
  "source": "cross-thread",
  "threadId": 1,
  "sourceThreadId": 5,
  "sender": "borg:Passport",
  "message": "Completed auth refactor. Ready for review.",
  "isReply": false,
  "timestamp": 1707580900000,
  "messageId": "cross_1707580900_xyz"
}
```

### Outgoing (standard response)

```json
{
  "channel": "telegram",
  "threadId": 5,
  "sender": "alice",
  "message": "Claude's response text here...",
  "originalMessage": "Can you refactor the auth module?",
  "timestamp": 1707580830000,
  "messageId": "1707580800000_abc123",
  "model": "opus"
}
```

### Outgoing (cross-thread message)

```json
{
  "channel": "telegram",
  "targetThreadId": 1,
  "sender": "borg",
  "message": "Completed auth refactor in Passport thread.",
  "timestamp": 1707580900000,
  "messageId": "cross_1707580900_xyz",
  "sourceThreadId": 5
}
```

The Telegram client checks for `targetThreadId` and posts to that topic instead of the originating one.

## Technical Considerations

### SDK Package & Build

- **Package**: `@anthropic-ai/claude-agent-sdk` (v0.2.38)
- **ESM compatibility**: SDK is ESM-only (`sdk.mjs`). Node 22.22.0's `require(esm)` loads it natively. No top-level await in the SDK.
- **tsconfig changes**: `"module": "nodenext"`, `"moduleResolution": "nodenext"`, `"target": "ES2022"`
- **No `__dirname` changes needed**: Files remain CJS (no `"type": "module"` in package.json)
- **No import extension changes needed**: No relative imports exist between current source files. Future files with relative imports will need `.js` extensions per `nodenext` rules.
- **Peer dependency**: `zod ^4.0.0`
- **Session cleanup**: Must call `session.close()` in try/finally. The SDK spawns a child process per session.

### Session Lifecycle

```
NO_SESSION -> CREATING -> ACTIVE -> STREAMING -> ACTIVE (loop)
                                        |
                                   ERROR -> delete sessionId -> NO_SESSION
                                        |
                                  MODEL_SWITCH -> close + resume -> ACTIVE
```

### Error Handling

| Error | Action |
|---|---|
| `createSession()` fails | Log, return error to user, retry on next poll |
| `resumeSession()` fails | Delete sessionId, fall back to `createSession()` |
| `session.send()` fails | Log, return error, keep session (may be transient) |
| Stream errors mid-iteration | Return partial response if any, log, keep session |
| Router scoring throws | Default to MEDIUM tier (sonnet), log |
| Session resume returns different session_id | Update threads.json with new ID |
| Telegram client `GrammyError` | Log, continue (bot.catch handles) |
| Telegram 429 rate limit | auto-retry plugin handles with backoff |

### threads.json Atomic Writes

Multiple components read/write `threads.json`: the session manager, the heartbeat cron (read-only), and agents (read-only via Read tool). Use write-then-rename for all writes:

```typescript
const tmp = `${THREADS_FILE}.tmp.${process.pid}`;
writeFileSync(tmp, JSON.stringify(threads, null, 2));
renameSync(tmp, THREADS_FILE); // atomic on same filesystem
```

Readers will always see either the old or new version, never a partial file.

### Graceful Shutdown

On SIGINT/SIGTERM, the queue processor must close all active SDK sessions to prevent orphan subprocesses:

```typescript
async function gracefulShutdown() {
  console.log("Shutting down...");
  for (const [threadId, session] of activeSessions) {
    try { session.close(); } catch (e) { /* log and continue */ }
  }
  saveThreads(); // persist latest session IDs
  process.exit(0);
}

process.once("SIGINT", gracefulShutdown);
process.once("SIGTERM", gracefulShutdown);
```

### Retry and Dead-Letter Handling

Messages that fail processing get a retry counter. After 3 failures, move to a dead-letter directory instead of retrying forever:

- `.borg/queue/dead-letter/` -- messages that failed 3 times
- Retry counter tracked in the filename: `telegram_msg123_retry2.json`
- Dead-letter messages logged with error details for manual inspection

### Concurrent Append Safety (JSONL)

On Linux ext4, `fs.appendFileSync` uses `O_APPEND` with kernel inode mutex serialization. Multiple processes appending complete JSON lines (each under 4KB) produce intact, non-interleaved output. Safe for our single-machine use case. Not safe on NFS.

### Resource Management

Each active SDK session spawns a child process (~50-100MB RAM). To prevent resource exhaustion:

- Cap active sessions (e.g., 10 concurrent)
- Auto-close sessions idle for >30 minutes
- Track session count and memory in `threads.json` metadata
- On cap hit: close least-recently-active session. It will resume on next message.

### Telegram Forum Group Setup (Manual Prerequisites)

1. Create a Telegram supergroup
2. Enable "Topics" in group settings (must be done by group owner in Telegram client)
3. Create the bot via @BotFather, get token
4. Add bot to the group as admin with `can_manage_topics` permission
5. Get the group chat ID (negative number, e.g., `-1001234567890`)
6. Configure in `.borg/settings.json`: `telegram_bot_token`, `telegram_chat_id`, `timezone`

### Settings Format

```json
{
  "telegram_bot_token": "123456:aBcDeF...",
  "telegram_chat_id": "-1001234567890",
  "timezone": "America/Denver",
  "heartbeat_interval": 500,
  "max_concurrent_sessions": 10,
  "session_idle_timeout_minutes": 30
}
```

## Acceptance Criteria

### Core (SDK + Sessions)
- [x] Queue processor uses Agent SDK v2 (`createSession` / `resumeSession`) instead of `execSync`
- [x] One session per Telegram topic, persisted in `threads.json`
- [x] Session resume failure gracefully falls back to new session creation
- [x] Model switching via close + resume preserves conversation history
- [x] `canUseTool` callback denies `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`
- [x] Concurrency guard prevents overlapping async message processing
- [x] `session.close()` called in all code paths (try/finally)

### Message History
- [x] All messages (in/out, all threads) appended to `.borg/message-history.jsonl`
- [x] `UserPromptSubmit` hook injects same-thread history for workers, all-thread history for master
- [x] System prompt includes compaction recovery instructions
- [x] Agent can search older history via Grep/Bash on the JSONL file

### Routing
- [x] Router scores incoming messages using 14-dimension weighted classifier
- [x] Router input enriched with last 5 same-thread messages
- [x] Reply to bot message = upgrade-only (`maxTier`)
- [x] Fresh message = free pick (can downgrade)
- [x] Model switch triggers close + resume with new model
- [x] Routing decisions logged to `.borg/routing-log.jsonl`
- [x] Heartbeat messages bypass router, always use haiku

### Per-Thread Heartbeats
- [x] `heartbeat-cron.sh` iterates all active threads in `threads.json`
- [x] Each thread gets its own heartbeat message with its `threadId`
- [x] Heartbeat prompt: "Read HEARTBEAT.md if it exists. Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK."
- [x] Agent can read and edit `HEARTBEAT.md` in its `cwd` as a living task list
- [x] `HEARTBEAT_OK` responses optionally suppressed from Telegram (no clutter)
- [x] Heartbeat interval configurable in settings

### Time Awareness
- [x] Timezone configured in `.borg/settings.json`
- [x] `UserPromptSubmit` hook injects current local time before every message
- [x] Format: `[Monday, Feb 10, 2026, 3:42 PM MST]`

### Message Source Typing
- [x] All queue messages carry a `source` field: `"user"`, `"cross-thread"`, `"heartbeat"`, `"cli"`, `"system"`
- [x] Queue processor processes all sources without filtering
- [x] Source-aware prompt formatting (different prefixes per source type)
- [x] Cross-thread messages written directly to incoming queue (queue-to-queue canonical path)
- [x] Telegram post of cross-thread messages is optional visibility only

### Telegram
- [x] Bot receives all messages from forum group topics
- [x] Messages tagged with `threadId` (from `message_thread_id`)
- [x] `autoChatAction` plugin keeps typing indicator active
- [x] `autoRetry` plugin handles 429 rate limits
- [x] Message splitting at 4,096-char Telegram limit (paragraph-aware)
- [x] `/reset` resets session for the current topic
- [x] `/setdir` configures working directory for a topic
- [x] `/status` shows active threads with models and last activity
- [x] Cross-thread messages (with `targetThreadId`) posted to correct topic
- [x] Bot restricted to configured group chat ID
- [x] `bot.catch()` error handler installed

### Cross-Thread Communication
- [x] Worker system prompts include cross-thread instructions (read threads.json, grep history, write outgoing with targetThreadId)
- [x] Master system prompt includes coordination role and all-thread visibility
- [x] Telegram client routes outgoing messages with `targetThreadId` to correct topic
- [x] threads.json readable by all sessions

### Cleanup
- [x] WhatsApp client fully removed (code, deps, shell scripts, docs)
- [x] Discord client fully removed (code, deps, shell scripts, docs)
- [x] `package.json` updated (old deps removed, new deps added)
- [x] `borg.sh` rewritten for Telegram-only (3 panes: telegram + queue + logs)
- [x] `setup-wizard.sh` updated for Telegram config
- [x] CLAUDE.md created with agent system instructions
- [x] Queue polling upgraded to `fs.watch` + 5-second fallback
- [x] tsconfig updated to `nodenext`

## Implementation Order

- [x] 1. **Remove WhatsApp + Discord** (all files, atomic commit)
- [x] 2. **Update tsconfig** to `nodenext` + ES2022
- [x] 3. **Add dependencies** (`@anthropic-ai/claude-agent-sdk`, `grammy`, `@grammyjs/auto-chat-action`, `@grammyjs/auto-retry`, `zod`)
- [x] 4. **Add router files + routing logger** (copy 4 router files + logger from anthropic-router)
- [x] 5. **Add JSONL message history module** (`src/message-history.ts` -- append, read, rotate, source-typed entries)
- [x] 6. **Add session manager** (`src/session-manager.ts` -- threads.json with atomic writes, create/resume/close/model-switch, graceful shutdown)
- [x] 7. **Rewrite queue-processor.ts** (SDK integration, routing, history injection, time injection, source-aware formatting, concurrency guard, fs.watch, retry with max 3 attempts)
- [x] 8. **Add Telegram client** (`src/telegram-client.ts` -- grammY, forum topics, commands, outgoing polling, cross-thread queue-to-queue routing, bot-self-message filter)
- [x] 9. **Create CLAUDE.md** with agent system instructions
- [ ] 10. **Create per-project HEARTBEAT.md** templates (workspace-level + example per-repo)
- [x] 11. **Update heartbeat-cron.sh** (iterate threads.json, per-thread heartbeats, generic prompt)
- [x] 12. **Update borg.sh** (3 panes: telegram + queue + logs)
- [x] 13. **Update setup-wizard.sh** (Telegram bot token + group chat ID + timezone)
- [x] 14. **Add routing decision logger** (`src/routing-logger.ts`)
- [ ] 15. **Test end-to-end** via Telegram forum topic (user messages, cross-thread, heartbeats, model switching)

## Dependencies & Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SDK v2 API changes (unstable prefix) | Medium | High | Pin SDK version, wrap in adapter module |
| SDK requires top-level await in future | Low | Medium | Switch to full ESM migration (Option A) |
| Session resume returns different session_id | Confirmed | Medium | Always capture new ID from stream, update threads.json |
| Router misclassifies messages | Medium | Medium | History enrichment + upgrade-only on replies + JSONL logging for review |
| Too many concurrent sessions (resource) | Medium | Medium | Cap at 10 active, auto-close idle sessions |
| ~1.5s subprocess overhead per resume | Confirmed | Low | Acceptable for queue processor, not latency-critical |
| JSONL append interleaving | Very Low | Low | Linux ext4 kernel mutex serialization, keep lines under 4KB |
| grammY API changes | Low | Low | Actively maintained, semver, pin version |
| Telegram forum mode removed | Very Low | High | Core Telegram feature, unlikely to be removed |

## References

### Internal
- Queue processor: `src/queue-processor.ts` (201 lines, core rewrite target)
- Discord client: `src/discord-client.ts` (269 lines, delete entirely)
- WhatsApp client: `src/whatsapp-client.ts` (287 lines, delete entirely)
- tmux launcher: `borg.sh` (556 lines, significant rewrite)
- Router source: `/home/clawcian/.openclaw/workspace/anthropic-router/src/router/` (4 files, zero external deps)
- Decision logger: `/home/clawcian/.openclaw/workspace/anthropic-router/src/logger.ts`

### External
- Agent SDK v2 docs: https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview
- Agent SDK sessions: https://platform.claude.com/docs/en/agent-sdk/sessions
- Agent SDK hooks: https://platform.claude.com/docs/en/agent-sdk/hooks
- Agent SDK system prompts: https://platform.claude.com/docs/en/agent-sdk/modifying-system-prompts
- SDK npm: https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk (v0.2.38)
- grammY docs: https://grammy.dev/
- grammY auto-chat-action: https://github.com/grammyjs/auto-chat-action
- grammY auto-retry: https://grammy.dev/plugins/auto-retry
- Telegram Bot API forum topics: https://core.telegram.org/bots/api#forumtopic
