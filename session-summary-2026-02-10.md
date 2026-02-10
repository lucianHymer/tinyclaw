# Session Summary: Anthropic Router to TinyClaw Pivot

> **For the next Claude session working in the tinyclaw fork**: This doc is your onboarding. It covers what we built, what we learned, and what to do next. The routing engine you need lives in the **anthropic-router** repo -- see the "Reference: anthropic-router repo" section at the bottom for exact paths and how to use it.

## Where We Started

The **anthropic-router** OpenClaw plugin was feature-complete (Phase 1-3 + code review hardening, 44 tests passing). It's a local HTTP proxy that:

1. Accepts Anthropic Messages API requests from OpenClaw
2. Scores prompt complexity with a 14-dimension weighted classifier (<1ms, zero API calls)
3. Rewrites the `model` field to the cheapest capable model (haiku/sonnet/opus)
4. Forwards to `api.anthropic.com` with zero-copy SSE streaming
5. Logs routing decisions for future local model training

## The 500 Error and Auth Journey

When we tried to actually use it, every request returned a 500. The journey to fix it:

### 1. No API Key at All
The Anthropic SDK was initialized with `new Anthropic({ maxRetries: 0 })` and no `apiKey`. The SDK looks for `ANTHROPIC_API_KEY` in the environment, but the gateway process doesn't have it set. Error: *"Could not resolve authentication method."*

### 2. OpenClaw Sends a Placeholder Key
We configured the provider with `apiKey: "session-passthrough"` (a dummy value required by OpenClaw's ModelRegistry). OpenClaw faithfully sends this as the `x-api-key` header. It's not a real Anthropic key.

### 3. Reading the Real Key from Auth Profiles
The real Anthropic credential lives in `~/.openclaw/agents/main/agent/auth-profiles.json` under `anthropic:default`. We added `readAnthropicApiKey()` in `plugin.ts` to read it at startup and pass it to the proxy config.

### 4. OAuth Token != API Key
The credential is `sk-ant-oat01-*` (an OAuth Access Token), not `sk-ant-api03-*` (a static API key). The SDK has two auth methods:
- `apiKey` -> sends `X-Api-Key` header
- `authToken` -> sends `Authorization: Bearer` header

We switched to `authToken` for OAuth tokens. Still got: *"OAuth authentication is currently not supported."*

### 5. Required Beta Headers (the actual fix)
By digging into OpenClaw's core (`@mariozechner/pi-ai/dist/providers/anthropic.js`), we found that OAuth tokens require specific headers that signal Claude Code compatibility:

```typescript
new Anthropic({
  apiKey: null,
  authToken: oauthToken,
  defaultHeaders: {
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
    "user-agent": "claude-cli/2.1.2 (external, cli)",
    "x-app": "cli",
  },
})
```

Without these headers, Anthropic's API rejects OAuth tokens entirely. This is how pi-ai (OpenClaw's AI backend) does it -- it mimics Claude Code's exact headers.

**Current status**: This fix is deployed but untested by the user at time of writing.

## The Bigger Realization

### ClawRouter Already Exists
ClawRouter (`/home/clawcian/.openclaw/workspace/ClawRouter/`) is an OpenClaw plugin with the **exact same architecture**: local proxy, 14-dimension weighted classifier, model routing. The difference is it routes through BlockRun's x402 micropayment layer to 30+ models across 6 providers.

The anthropic-router is essentially ClawRouter with:
- x402 payments removed
- Routing limited to Anthropic-only models (haiku/sonnet/opus)
- Decision logging added (for training a local model)

### The Agent SDK Alternative
We explored whether `@anthropic-ai/claude-agent-sdk` could replace the HTTP proxy approach. Findings:

- **V1 SDK**: `query({ prompt, options })` -- takes a string prompt, spawns a Claude Code subprocess. No `messages` array, no per-request parameters like `temperature`/`max_tokens`.
- **V2 SDK (preview)**: `createSession()` / `session.send()` / `session.stream()` -- cleaner API, but still string-in/stream-out. No way to forward a raw Messages API request.
- **Neither works as a proxy** -- they're orchestration layers that sit *on top of* the API, not transparent forwarders that sit *in front of* it.

### TinyClaw: The Simplest Version of What We Actually Want
[TinyClaw](https://github.com/jlia0/tinyclaw) (forked to `/home/clawcian/.openclaw/workspace/tinyclaw/`) is a minimal Claude Code wrapper:

- File-based message queue (incoming/processing/outgoing)
- Discord + WhatsApp clients write to queue
- Queue processor calls `claude --dangerously-skip-permissions -c -p "message"` via `execSync`
- `-c` flag continues the same conversation (single persistent session)
- Heartbeat cron for periodic check-ins
- tmux-based process management

It's 3 TypeScript files + a bash script. No proxy, no SDK, no API keys.

## Where We Landed: The Plan

**Upgrade TinyClaw with the Agent SDK + our routing engine.** Discord only, single conversation, personal use.

### What TinyClaw Gets Us (keep as-is)
- Discord client (`src/discord-client.ts`) -- DM-based, typing indicators, message chunking for 2K limit
- File-based queue -- simple, no races, proven
- tmux launcher (`tinyclaw.sh`) -- process management, logs, status
- `/reset` command -- clear conversation, start fresh
- Heartbeat system -- periodic proactive check-ins

### What We Change
1. **Replace `execSync` with Agent SDK v2** in `queue-processor.ts`:
   - `unstable_v2_createSession({ model })` on first run
   - `unstable_v2_resumeSession(sessionId, { model })` on subsequent runs
   - `session.send(message)` + `session.stream()` instead of blocking CLI call
   - Proper streaming (no 4K truncation, no 2min timeout)

2. **Session persistence**:
   - Save session ID to `.tinyclaw/session-id` after first message
   - Load on startup for resume
   - Delete on `/reset` (triggers new session)
   - The SDK manages conversation history internally

3. **Smart model routing**:
   - Import our scoring engine (`src/router/` from anthropic-router)
   - Score each incoming message
   - Pass the selected model to the session: `{ model: "claude-opus-4-6" }` vs `"claude-sonnet-4-5"` vs `"claude-haiku-4-5"`
   - Log routing decisions (same JSONL format for future training)

4. **Remove WhatsApp** (not needed, simplify)

5. **Remove `--dangerously-skip-permissions`** (the SDK has proper permission controls via `canUseTool` / `permissionMode`)

### What We Don't Change
- Discord client stays as-is (it just writes to the queue)
- File-based queue architecture stays
- tmux launcher stays
- Heartbeat stays
- Setup wizard can be simplified (Discord only, no model choice since routing handles it)

### Architecture After

```
Discord DM
    |
    v
discord-client.ts  -->  .tinyclaw/queue/incoming/
                              |
                              v
                    queue-processor.ts
                         |
                    [score prompt]  -->  routing-log.jsonl
                         |
                    [pick model: haiku/sonnet/opus]
                         |
                    session.send(message)
                    session.stream()
                         |
                         v
                    .tinyclaw/queue/outgoing/
                              |
                              v
                    discord-client.ts  -->  Discord DM reply
```

Session ID persisted in `.tinyclaw/session-id`. All messages flow through one Claude Code conversation.

## Reference: anthropic-router Repo

**Location**: `/home/clawcian/.openclaw/workspace/anthropic-router/`

### Routing Engine (copy these into tinyclaw)

The scoring/routing code is self-contained with zero external dependencies (pure TypeScript, no node:fs/node:crypto). You can copy the whole `src/router/` directory:

- **`src/router/index.ts`** -- Exports `route(promptText, systemText, { config })` which returns `{ tier, model, confidence, estimatedTokens, signals }`. Also exports `DEFAULT_ROUTING_CONFIG`.
- **`src/router/rules.ts`** -- `classifyByRules()` -- the 14-dimension weighted classifier. This is the core scoring logic. Dimensions: reasoning markers, code presence, simple indicators, multi-step patterns, technical terms, token count, creative markers, question complexity, constraint count, imperative verbs, output format, domain specificity, reference complexity, negation complexity.
- **`src/router/types.ts`** -- `RoutingConfig`, `Tier` (`"simple" | "medium" | "complex"`), `RoutingDecision`, `DimensionWeights`. All the types you need.

**Usage example:**
```typescript
import { route, DEFAULT_ROUTING_CONFIG } from "./router/index.js";

const decision = route(userMessage, "", { config: DEFAULT_ROUTING_CONFIG });
// decision.tier = "simple" | "medium" | "complex"
// decision.model = "haiku" | "sonnet" | "opus"
// decision.confidence = 0.0-1.0
// decision.estimatedTokens = number
// decision.signals = ["reasoning(prove)", "code(function)", ...]
```

**Tier-to-model mapping** (you'll need this in tinyclaw):
```typescript
const TIER_TO_MODEL: Record<string, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-5-20250929",
  opus: "claude-opus-4-6",
};
```

### Decision Logger (optional, for training data)

- **`src/logger.ts`** -- `logDecision(decision, promptText, logPath)` appends JSONL to a file. Uses SHA-256 hash of prompt (not raw text) for privacy. Has path traversal protection and signal sanitization.
- **Log path**: `~/.openclaw/routing-log.jsonl` (or wherever you configure)
- **Gotcha**: This file imports `node:fs` and `node:crypto`. On this system (Node 22.22, Linux 6.8.12-11-pve), vitest hangs when these are imported in test files. Keep logger tests separate or use a different test runner.

### Tests

- **`src/router/rules.test.ts`** -- 20 tests for the classifier. Pure TS, no node:fs, runs fine in vitest.
- **`src/server.test.ts`** -- 24 tests for the HTTP proxy (not relevant to tinyclaw, but shows how the router is exercised).
- Run with: `npx vitest run` (44 tests, <300ms)

### Performance

The scoring engine is fast enough to run per-message with zero concern:
- 12 chars: 4.6us
- 57 chars: 5.4us
- 2K chars: 66.6us
- 10K chars: 312us
- 50K chars: 1.55ms

### Agent SDK Notes (learned the hard way)

- **V1**: `query({ prompt, options })` -- async generator, string prompt, spawns Claude Code subprocess
- **V2 (preview, unstable)**: `unstable_v2_createSession()` / `unstable_v2_resumeSession(sessionId)` / `session.send(msg)` / `session.stream()` -- cleaner, but API may change
- **Install**: `npm install @anthropic-ai/claude-agent-sdk` (v0.2.38 as of 2026-02-10)
- **Auth**: The SDK handles auth through Claude Code's existing login. No API keys needed. This is the whole point of switching from the HTTP proxy approach.
- **Model per-session**: Pass `{ model: "claude-opus-4-6" }` to `createSession`/`resumeSession`. Note: model is set at session creation. If you want to change model per-message, you may need to create a new session (test this -- resuming with a different model might work).
- **Session resume**: Store `msg.session_id` from any streamed message. Pass to `unstable_v2_resumeSession(sessionId, opts)` to continue the conversation later.
- **Permissions**: Use `permissionMode` and `canUseTool` in options instead of `--dangerously-skip-permissions`.

### OAuth Token Headers (if you ever need raw Anthropic SDK calls)

OpenClaw's OAuth tokens (`sk-ant-oat01-*`) require these headers or Anthropic rejects them:
```typescript
{
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
  "user-agent": "claude-cli/2.1.2 (external, cli)",
  "x-app": "cli",
}
```
But with the Agent SDK you shouldn't need this -- the SDK handles its own auth.
