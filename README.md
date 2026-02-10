# TinyClaw

Multi-session Claude agent orchestrated through a Telegram forum, powered by the Anthropic Agent SDK v2 and smart model routing.

## What is TinyClaw?

TinyClaw turns a single Telegram group into a multi-repo AI development environment. The idea is simple:

1. Set up a machine in the cloud (VPS, dedicated server, etc.)
2. Clone all of your team's repositories onto it
3. Create a Telegram supergroup with Topics enabled (a "forum")
4. Each topic in that forum becomes an independent Claude Code session running in a specific repo
5. All sessions can communicate with each other through a shared message history and cross-thread queue
6. A heartbeat loop keeps each session proactive -- checking for tasks, running tests, monitoring for issues

Each topic is a full Claude Code agent (via the [Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)) with file access, code editing, terminal commands, and web search. Messages are automatically routed to the right model (haiku, sonnet, or opus) based on complexity. Sessions persist across messages so context is never lost.

```
Telegram Forum Group
├── General (Master)     → ~/.openclaw/workspace/          (coordinates all threads)
├── Passport             → ~/.openclaw/workspace/passport  (Claude session in passport repo)
├── API Server           → ~/.openclaw/workspace/api       (Claude session in api repo)
├── Frontend             → ~/.openclaw/workspace/frontend  (Claude session in frontend repo)
└── ...                  → each topic = its own agent session in a repo
```

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     Telegram Forum Group                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐           │
│  │ General  │ │ Repo A   │ │ Repo B   │ │ Repo C   │  ...      │
│  │ (Master) │ │ (Worker) │ │ (Worker) │ │ (Worker) │           │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘           │
└───────┼─────────────┼────────────┼─────────────┼────────────────┘
        │             │            │             │
        └─────────────┴────────────┴─────────────┘
                          │
                   ┌──────┴──────┐
                   │  Telegram   │  grammY bot (I/O only)
                   │   Client    │  tags messages with threadId
                   └──────┬──────┘
                          │
                   File-based Queue
                  incoming/ → processing/ → outgoing/
                          │
                   ┌──────┴──────┐
                   │   Queue     │  Agent SDK v2 sessions
                   │  Processor  │  smart routing, history injection
                   └──────┬──────┘
                          │
              ┌───────────┼───────────┐
              │           │           │
        ┌─────┴─────┐ ┌──┴───┐ ┌────┴────┐
        │  Session   │ │Router│ │ Message │
        │  Manager   │ │ (14d)│ │ History │
        │            │ │      │ │ (JSONL) │
        └────────────┘ └──────┘ └─────────┘
```

**Key components:**

- **Telegram Client** (`src/telegram-client.ts`) -- grammY bot handling all forum topics, pure I/O
- **Queue Processor** (`src/queue-processor.ts`) -- Agent SDK v2 sessions, routing, history injection
- **Session Manager** (`src/session-manager.ts`) -- threadId-to-session lifecycle, threads.json
- **Smart Router** (`src/router/`) -- 14-dimension weighted scoring engine for model selection
- **Message History** (`src/message-history.ts`) -- shared JSONL log tagged by threadId
- **Routing Logger** (`src/routing-logger.ts`) -- JSONL audit trail of routing decisions

## How It Works

### Smart Model Routing

Every message is scored across 14 weighted dimensions (code presence, reasoning markers, token count, technical terms, multi-step patterns, and more) to classify it as:

| Tier | Model | When |
|---|---|---|
| SIMPLE | Haiku | Quick questions, simple lookups, status checks |
| MEDIUM | Sonnet | Code review, moderate analysis, standard tasks |
| COMPLEX | Opus | Architecture decisions, complex debugging, multi-step reasoning |

Replies to bot messages can only **upgrade** the model (never downgrade). Fresh messages allow free model selection. Heartbeats always use haiku.

The router runs locally in <1ms with zero API calls. Adapted from [ClawRouter](https://github.com/BlockRunAI/ClawRouter).

### Cross-Thread Communication

All sessions share visibility through:

- **Shared JSONL history** -- any session can grep `.tinyclaw/message-history.jsonl` for any thread's messages
- **threads.json** -- all sessions can read the active thread list and their configurations
- **Queue-to-queue messaging** -- write JSON to `.tinyclaw/queue/outgoing/` with a `targetThreadId` field to message another thread

The Master thread (General topic, threadId 1) has elevated visibility: it receives history from all threads and can coordinate across sessions.

### Heartbeat Loop

Each active thread gets periodic heartbeat check-ins via `heartbeat-cron.sh`. The heartbeat:
- Reads `HEARTBEAT.md` in the thread's working directory (a living task list)
- Takes action on pending tasks, runs checks, reports status
- Uses haiku (cheapest model) and bypasses the router
- Filters `HEARTBEAT_OK` responses to avoid cluttering Telegram

## Prerequisites

- Linux (tested on Debian/Ubuntu; macOS should work)
- [Node.js 22+](https://nodejs.org/) (v22.22.0 recommended for `require(esm)` support)
- [Claude Code](https://claude.com/claude-code) installed
- An [Anthropic API key](https://console.anthropic.com/) (set as `ANTHROPIC_API_KEY`)
- tmux
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- A Telegram supergroup with Topics enabled

## Quick Start

```bash
# Clone the repo
git clone https://github.com/lucianHymer/tinyclaw.git
cd tinyclaw

# Install dependencies
npm install

# Build TypeScript
npm run build

# Start (first run triggers the setup wizard)
./tinyclaw.sh start
```

### Setup Wizard

On first run, you'll be prompted to configure:

- **Telegram bot token** -- from @BotFather
- **Telegram group chat ID** -- the numeric ID of your supergroup
- **Timezone** -- for timestamp injection (e.g., `America/Denver`)
- **Heartbeat interval** -- seconds between check-ins (default: 500)

Configuration is saved to `.tinyclaw/settings.json`.

### Creating a Telegram Forum Group

1. Create a new Telegram group
2. Go to group settings and enable **Topics** (this turns it into a "forum")
3. Add your bot to the group and make it an admin
4. The "General" topic becomes the Master thread
5. Create additional topics for each repo you want a Claude session in

### Configuring Threads

Use the `/setdir` command in any topic to set its working directory:

```
/setdir /home/user/repos/my-project
```

Or use `/status` to see the current configuration for a thread.

## CLI Commands

```bash
# Start all processes (Telegram client + queue processor) in tmux
./tinyclaw.sh start

# Stop everything
./tinyclaw.sh stop

# Restart
./tinyclaw.sh restart

# Check status
./tinyclaw.sh status

# Send a message from the CLI
./tinyclaw.sh send "Run the test suite"

# Reset conversation for next message
./tinyclaw.sh reset

# Switch or check model
./tinyclaw.sh model           # Show current
./tinyclaw.sh model sonnet    # Switch to sonnet
./tinyclaw.sh model opus      # Switch to opus

# View logs
./tinyclaw.sh logs telegram   # Telegram activity
./tinyclaw.sh logs queue      # Queue processing
./tinyclaw.sh logs heartbeat  # Heartbeat checks

# Attach to tmux session
./tinyclaw.sh attach
```

### Telegram Commands

Send these as messages in any topic:

- `/reset` -- Reset the session for this thread (next message starts fresh)
- `/setdir <path>` -- Set the working directory for this thread
- `/status` -- Show thread configuration, session info, and queue state

## Configuration

### Settings (`/.tinyclaw/settings.json`)

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

### Thread Config (`.tinyclaw/threads.json`)

Auto-managed. Each thread entry:

```json
{
  "1": {
    "name": "Master",
    "cwd": "/home/user/.openclaw/workspace",
    "sessionId": "abc-123",
    "model": "sonnet",
    "isMaster": true,
    "lastActive": 1707580800000
  }
}
```

## Directory Structure

```
tinyclaw/
├── src/
│   ├── telegram-client.ts    # Telegram I/O (grammY)
│   ├── queue-processor.ts    # Message processing, SDK sessions, routing
│   ├── session-manager.ts    # Thread lifecycle, system prompts, tool control
│   ├── message-history.ts    # Shared JSONL history
│   ├── routing-logger.ts     # Routing decision audit trail
│   ├── types.ts              # Shared type definitions
│   └── router/
│       ├── index.ts          # Route entry point
│       ├── config.ts         # 14-dimension weights, keywords, thresholds
│       ├── rules.ts          # Weighted classifier
│       └── types.ts          # Tier, RoutingDecision, ScoringConfig
├── dist/                     # TypeScript build output
├── .tinyclaw/                # Runtime data (gitignored)
│   ├── settings.json         # Bot token, chat ID, timezone, intervals
│   ├── threads.json          # Thread configurations
│   ├── message-history.jsonl # All messages across all threads
│   ├── message-models.json   # Telegram messageId -> model mapping
│   ├── queue/
│   │   ├── incoming/         # New messages
│   │   ├── processing/       # Being processed
│   │   ├── outgoing/         # Responses and cross-thread messages
│   │   └── dead-letter/      # Failed messages (after 3 retries)
│   └── logs/
│       ├── telegram.log
│       ├── queue.log
│       ├── routing.jsonl
│       └── heartbeat.log
├── .claude/                  # Claude Code hooks
│   └── hooks/
├── docs/
│   └── plans/                # Architecture plans
├── tinyclaw.sh               # tmux orchestrator
├── heartbeat-cron.sh         # Per-thread heartbeat loop
├── setup-wizard.sh           # Interactive first-run config
├── CLAUDE.md                 # Agent system instructions
├── HEARTBEAT.md              # Living task list (per-repo)
├── package.json
└── tsconfig.json
```

## Message Flow

```
User sends message in Telegram topic
       │
       ▼
Telegram Client tags with threadId, writes to incoming/ queue
       │
       ▼
Queue Processor picks up message
       │
       ▼
Smart Router scores across 14 dimensions → selects model tier
       │
       ▼
Session Manager gets or creates SDK session for this thread
       │
       ▼
UserPromptSubmit hook injects conversation history + timestamp
       │
       ▼
Agent SDK v2 processes prompt (streaming)
       │
       ▼
Response written to outgoing/ queue + appended to JSONL history
       │
       ▼
Telegram Client sends response back to the correct topic
```

## Credits

TinyClaw stands on the shoulders of:

- **[TinyClaw](https://github.com/lucianHymer/tinyclaw)** (original) by **Jian** -- the initial vision of a minimal AI assistant with a file-based queue architecture. The queue pattern survives in v2.
- **[ClawRouter](https://github.com/BlockRunAI/ClawRouter)** by **BlockRunAI** -- the 14-dimension weighted scoring engine for smart model routing. Adapted under the MIT license.
- **[OpenClaw](https://openclaw.ai/)** by **Peter Steinberger** -- inspiration for the always-on agent concept, heartbeat loop pattern, and multi-channel architecture.
- **[Claude Code](https://claude.com/claude-code)** and the **[Anthropic Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)** -- the AI engine powering every session.
- **[grammY](https://grammy.dev/)** -- the TypeScript-first Telegram bot framework.

## License

MIT
