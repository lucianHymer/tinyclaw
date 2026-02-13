---
title: "MCP Tools Not Accessible in SDK v2 Sessions — Silent API Limitation"
date: 2026-02-10
category: integration-issues
tags:
  - MCP
  - Claude Agent SDK
  - cross-thread communication
  - v1 vs v2 API
  - createSdkMcpServer
components:
  - src/queue-processor.ts
  - src/mcp-tools.ts
  - src/telegram-client.ts
severity: P1
root_cause_type: API limitation (silent option drop)
resolution_type: API migration (v2 -> v1 query)
---

# SDK v2 `mcpServers` Option Silently Ignored — Migrate to v1 `query()` API

## Problem

Agents running in Claude Agent SDK sessions could not see custom MCP tools (`send_message`, `list_threads`) needed for cross-thread communication in Borg's Telegram forum multi-agent system. The agent explicitly said: *"I don't have a built-in tool to send messages across threads."*

## Root Cause

Two distinct issues:

1. **The v2 `unstable_v2_*` API silently drops the `mcpServers` option.** No error, no warning, no type error. The option is accepted at compile time (via `as SDKSessionOptions` cast) but ignored at runtime. Only the v1 `query()` API supports `mcpServers`.

2. **Cross-thread messages only wrote to the outgoing queue** (for Telegram display). The bot's self-filter (`ctx.from.id !== bot.botInfo.id` in `telegram-client.ts:193`) prevented these from being re-queued as incoming messages for the target agent.

## Investigation Timeline

### Attempt 1: v2 with `createSdkMcpServer` (in-process)

```typescript
// Passed McpSdkServerConfigWithInstance via cast — compiled fine, silently ignored
mcpServers: { borg: createBorgMcpServer(threadId) }
```

`McpSdkServerConfigWithInstance` contains a live `McpServer` object that isn't serializable across the process boundary. But even if it were, v2 ignores `mcpServers` entirely.

### Attempt 2: v2 with stdio-based `McpStdioServerConfig`

```typescript
// Fully serializable config — still silently ignored
mcpServers: { borg: { command: "node", args: ["dist/mcp-server.js"] } }
```

Confirmed: v2 doesn't support `mcpServers` in any form.

### Attempt 3: `.mcp.json` project file

Would work via `settingSources: ["project"]`, but requires placing `.mcp.json` in every project working directory. Untenable for a multi-tenant agent system where each thread has its own `cwd`.

### Attempt 4: Discovered bot self-filter bug

Cross-thread messages appeared in Telegram but the target agent never processed them. The bot posts to the target topic using its own account, and `telegram-client.ts` filters out all bot-originated messages to prevent loops.

## Working Solution

### 1. Migrate from v2 to v1 `query()` API

The v1 `query()` function has typed `mcpServers: Record<string, McpServerConfig>` support:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
    prompt: fullPrompt,
    options: {
        model: effectiveModel,
        cwd: threadConfig.cwd,
        mcpServers: {
            borg: createBorgMcpServer(threadId),
        },
        resume: threadConfig.sessionId,  // session continuity
        settingSources: ["project"],
        systemPrompt: { type: "preset", preset: "claude_code", append: threadPrompt },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
    },
});

const { text, sessionId } = await collectQueryResponse(q);
```

### 2. In-process MCP via `createSdkMcpServer`

No separate process, no `.mcp.json`, thread-aware instances:

```typescript
// src/mcp-tools.ts
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

export function createBorgMcpServer(sourceThreadId: number) {
    const sendMessage = tool(
        "send_message",
        "Send a message to another Borg thread.",
        { targetThreadId: z.number(), message: z.string() },
        async ({ targetThreadId, message }) => {
            // Write to BOTH queues (see below)
        },
    );

    return createSdkMcpServer({
        name: "borg",
        tools: [sendMessage, listThreads],
    });
}
```

### 3. Dual-queue writes for cross-thread messages

The `send_message` MCP tool writes to **both** queues:

- **Incoming queue** (`queue/incoming/`) — so the target agent processes the message
- **Outgoing queue** (`queue/outgoing/`) — so it appears in the Telegram topic for human visibility

```typescript
// Incoming: target agent processes it
fs.writeFileSync(inTmp, JSON.stringify({
    channel: "telegram",
    source: "cross-thread",
    threadId: targetThreadId,
    sourceThreadId,
    sender: sourceName,
    message,
    timestamp: ts,
    messageId: id,
}));
fs.renameSync(inTmp, inFinal);

// Outgoing: appears in Telegram topic
fs.writeFileSync(outTmp, JSON.stringify({
    channel: "telegram",
    targetThreadId,
    sender: sourceName,
    message,
    messageId: `${id}_tg`,
    ...
}));
fs.renameSync(outTmp, outFinal);
```

### 4. Simplified session management

Removed `activeSessions` cache. Each message is a self-contained `query()` call. Session continuity via `resume: sessionId` in options. The v1 API handles session state server-side.

## Key Insights

1. **v2 `unstable_v2_*` does not support `mcpServers`** — not typed on `SDKSessionOptions`, silently dropped at runtime. Other untyped options like `settingSources` and `systemPrompt` work via cast-through, but `mcpServers` does not.

2. **v1 `query()` supports `mcpServers` including in-process `createSdkMcpServer`** — the v1 API handles the bridge between the subprocess and the in-process MCP server. No standalone server process needed.

3. **`as` casts hide API gaps** — the existing code used `as SDKSessionOptions` to pass extra options. This worked for some fields but masked the `mcpServers` failure. Prefer checking actual SDK type definitions.

4. **Cross-thread messaging requires dual-queue writes** — the outgoing queue is for Telegram visibility, the incoming queue is for agent processing. Bot self-filtering makes outgoing-only insufficient.

5. **Factory pattern for thread-aware MCP** — `createBorgMcpServer(threadId)` gives each query its own MCP instance with the correct `sourceThreadId`, enabling proper routing.

## Prevention

- When passing options not in a type definition, verify at runtime that the feature is active (e.g., check `mcp_servers` in the SDK init message)
- For cross-thread/cross-process messaging, always consider whether the sender's identity will cause filtering at the receiver
- Pin SDK versions and test MCP tool visibility after upgrades
- Avoid `as` casts for SDK options — if it's not typed, it might not work

## Related

- [borg-v2-evolution-from-fork-to-forum-agent.md](./borg-v2-evolution-from-fork-to-forum-agent.md) — original v2 migration
- [borg-v2-first-live-run-fixes.md](./borg-v2-first-live-run-fixes.md) — first deployment issues
- SDK types: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` lines 242 (`createSdkMcpServer`), 670 (`mcpServers` on Options), 1549 (`SDKSessionOptions` — no mcpServers)
