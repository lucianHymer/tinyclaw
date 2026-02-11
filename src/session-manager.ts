/**
 * Session Manager - Thread lifecycle, settings, and SDK session management
 * Handles thread configuration, system prompts, and tool access control.
 */

import fs from "fs";
import path from "path";

// ─── Types ───

export interface ThreadConfig {
    name: string;
    cwd: string;
    sessionId?: string;
    model: string;
    isMaster: boolean;
    lastActive: number;
}

export type ThreadsMap = Record<string, ThreadConfig>;

export type CanUseToolResult =
    | { behavior: "allow"; updatedInput: unknown }
    | { behavior: "deny"; message: string };

export type CanUseTool = (toolName: string, input: unknown) => Promise<CanUseToolResult>;

export interface Settings {
    timezone: string;
    telegram_bot_token: string;
    telegram_chat_id: string;
    heartbeat_interval: number;
    max_concurrent_sessions: number;
    session_idle_timeout_minutes: number;
}

// ─── Constants ───

const SCRIPT_DIR = path.resolve(__dirname, "..");
const TINYCLAW_DIR = path.join(SCRIPT_DIR, ".tinyclaw");
const THREADS_FILE = path.join(TINYCLAW_DIR, "threads.json");
const SETTINGS_FILE = path.join(TINYCLAW_DIR, "settings.json");
const DEFAULT_CWD = process.env.DEFAULT_CWD || "/home/clawcian/.openclaw/workspace";
export const MAX_CONCURRENT_SESSIONS = 2;

// ─── In-memory caches ───

let threadsCache: ThreadsMap | null = null;
let settingsCache: Settings | null = null;
let settingsMtime: number = 0;

// ─── Thread Persistence ───

export function loadThreads(): ThreadsMap {
    // Always read from disk — two processes (telegram-client, queue-processor)
    // share this file, so an in-memory cache causes cross-process staleness.
    try {
        const data = fs.readFileSync(THREADS_FILE, "utf8");
        threadsCache = JSON.parse(data) as ThreadsMap;
        return threadsCache;
    } catch {
        threadsCache = {
            "1": {
                name: "Master",
                cwd: DEFAULT_CWD,
                model: "sonnet",
                isMaster: true,
                lastActive: 0,
            },
        };
        return threadsCache;
    }
}

export function saveThreads(threads: ThreadsMap): void {
    const dir = path.dirname(THREADS_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = THREADS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(threads, null, 2));
    fs.renameSync(tmp, THREADS_FILE);
    threadsCache = threads;
}

// ─── Settings ───

export function loadSettings(): Settings {
    const defaults: Settings = {
        timezone: "UTC",
        telegram_bot_token: "",
        telegram_chat_id: "",
        heartbeat_interval: 300,
        max_concurrent_sessions: MAX_CONCURRENT_SESSIONS,
        session_idle_timeout_minutes: 30,
    };

    try {
        const currentMtime = fs.statSync(SETTINGS_FILE).mtimeMs;
        if (settingsCache && currentMtime === settingsMtime) {
            return settingsCache;
        }
        settingsMtime = currentMtime;
    } catch {
        // File doesn't exist yet, fall through to read attempt
    }

    try {
        const data = fs.readFileSync(SETTINGS_FILE, "utf8");
        const parsed = JSON.parse(data) as Partial<Settings>;
        settingsCache = { ...defaults, ...parsed };
        return settingsCache;
    } catch {
        settingsCache = defaults;
        return settingsCache;
    }
}

// ─── Tool Access Control ───

export const canUseTool: CanUseTool = async (toolName, input) => {
    if (toolName === "AskUserQuestion") {
        return {
            behavior: "deny",
            message: "No human is available. State what you need in your response text.",
        };
    }
    if (toolName === "EnterPlanMode" || toolName === "ExitPlanMode") {
        return {
            behavior: "deny",
            message: "Plan mode is not available.",
        };
    }
    return { behavior: "allow", updatedInput: input };
};

// ─── System Prompts ───

export function buildThreadPrompt(config: ThreadConfig, runtime?: { threadId?: number; model?: string }): string {
    const runtimeBlock = `

Your runtime context:
- Thread ID: ${runtime?.threadId ?? "unknown"}
- Model: ${runtime?.model ?? config.model}
- Outgoing message format: {"channel": "...", "threadId": N, "message": "...", "targetThreadId": N, ...}
- Message history log: .tinyclaw/message-history.jsonl
- Routing log: .tinyclaw/logs/routing.jsonl
- Response truncation limit: 4000 characters`;

    if (config.isMaster) {
        return `You are TinyClaw, an AI assistant that users communicate with through Telegram. You are a full Claude Code agent with file access, code editing, terminal commands, and web search. Users send you messages in a Telegram forum topic and you respond there. Treat every incoming message as a direct conversation with the user — be helpful, conversational, and action-oriented.

Multiple team members may message you. Each message is prefixed with the sender's name (e.g. "[Lucian via Telegram]:"). Pay attention to who is talking — address them by name when appropriate and keep track of what each person is working on or asking about.

You are the Master thread, coordinating across all project threads. Each Telegram forum topic is a separate Claude Code session running in a different repo. You have visibility across all of them.

GitHub access:
- \`git\` and \`gh\` are both authenticated via the credential broker (GitHub App installation tokens)
- You can clone, push, create PRs, file issues, etc. — just use \`git\` and \`gh\` normally
- Available orgs: check \`/secrets/github-installations.json\` for configured organizations

You can:
- See all active threads and their status in .tinyclaw/threads.json
- Read any thread's history from .tinyclaw/message-history.jsonl
- Message any thread by writing to .tinyclaw/queue/outgoing/ with targetThreadId
- Broadcast to all threads by writing multiple outgoing messages
- Reset a thread: Write {"command": "reset", "threadId": N, "timestamp": <epoch_ms>} to .tinyclaw/queue/commands/
- Change working directory: Write {"command": "setdir", "threadId": N, "args": {"cwd": "/path"}, "timestamp": <epoch_ms>} to .tinyclaw/queue/commands/

## Knowledge Base

Your working directory is a local-only git repo for organizational knowledge.

Files you maintain:
- context.md — Who we are, what we're building, team members
- decisions.md — Append-only log of key decisions (date, decision, rationale)
- active-projects.md — Current status of each repo/thread (updated from daily reports)

When you receive daily summaries from worker threads:
1. Update active-projects.md with the thread's current status
2. If any key decisions were made, append to decisions.md
3. Commit changes: git add -A && git commit -m "Update: <brief description>"

When asked about project status, read active-projects.md first.

You receive periodic heartbeat messages. Read HEARTBEAT.md in your working directory
and follow it. You can edit HEARTBEAT.md to maintain your own task list. Reply
HEARTBEAT_OK if nothing needs attention.

Keep responses concise — Telegram messages over 4000 characters get split.${runtimeBlock}`;
    }

    return `You are TinyClaw, an AI assistant that users communicate with through Telegram. You are a full Claude Code agent with file access, code editing, terminal commands, and web search. Users send you messages in a Telegram forum topic and you respond there. Treat every incoming message as a direct conversation with the user — be helpful, conversational, and action-oriented.

Multiple team members may message you. Each message is prefixed with the sender's name (e.g. "[Lucian via Telegram]:"). Pay attention to who is talking — address them by name when appropriate and keep track of what each person is working on or asking about.

You are operating in thread "${config.name}", working in ${config.cwd}. This is your primary project directory.

GitHub access:
- \`git\` and \`gh\` are both authenticated via the credential broker (GitHub App installation tokens)
- You can clone, push, create PRs, file issues, etc. — just use \`git\` and \`gh\` normally
- Available orgs: check \`/secrets/github-installations.json\` for configured organizations

Cross-thread communication:
- Active threads: Read .tinyclaw/threads.json
- Other threads' history: Grep .tinyclaw/message-history.jsonl for their threadId
- Message another thread: Write JSON to .tinyclaw/queue/outgoing/ with targetThreadId field
- If you lose context after compaction: tail .tinyclaw/message-history.jsonl for your threadId
- Reset a thread: Write {"command": "reset", "threadId": N, "timestamp": <epoch_ms>} to .tinyclaw/queue/commands/
- Change working directory: Write {"command": "setdir", "threadId": N, "args": {"cwd": "/path"}, "timestamp": <epoch_ms>} to .tinyclaw/queue/commands/

You receive periodic heartbeat messages. Read HEARTBEAT.md in your working directory
and follow it. You can edit HEARTBEAT.md to maintain your own task list. Reply
HEARTBEAT_OK if nothing needs attention.

Keep responses concise — Telegram messages over 4000 characters get split.${runtimeBlock}`;
}

export function buildHeartbeatPrompt(config: ThreadConfig): string {
    const settings = loadSettings();
    const now = new Date().toLocaleString("en-US", {
        timeZone: settings.timezone,
        weekday: "long",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
    });
    const isoNow = new Date().toISOString();

    // Build thread inventory for daily tier
    const threads = loadThreads();
    const threadInventory = Object.entries(threads)
        .map(([id, t]) => `threadId=${id} (${t.name}, repo: ${t.cwd})`)
        .join(", ");

    return `Heartbeat check for thread "${config.name}".

The current time is ${now} (${isoNow}) in ${settings.timezone}.

You must read HEARTBEAT.md in your working directory (${config.cwd}). If HEARTBEAT.md does not exist, create it from this template FIRST:

\`\`\`markdown
## Timestamps
- Last quick: (never)
- Last hourly: (never)
- Last daily: (never)

## Urgent Flags
(none)

## Tasks
- [ ] Review pending items

## Notes
(agent scratch space)
\`\`\`

Read the timestamps from HEARTBEAT.md and compare them to the current time to determine which tier of checks are due. Perform ALL checks for the highest due tier (higher tiers include all lower tier checks).

## Quick Tier (every heartbeat)
Always perform these checks:
1. Run \`git status\` to check for uncommitted changes or untracked files
2. Check the "Urgent Flags" section of HEARTBEAT.md for anything flagged
3. Update the "Last quick" timestamp in HEARTBEAT.md to: ${isoNow}
4. If nothing needs attention, reply with exactly: HEARTBEAT_OK

## Hourly Tier (if >60 minutes since "Last hourly" timestamp)
Perform all Quick checks, PLUS:
1. Run \`git fetch origin\` to detect upstream changes
2. Run \`git log HEAD..origin/main --oneline\` to see new commits on main
3. Run \`gh pr list --state open\` and for any open PRs run \`gh pr checks\` to check CI status
4. Check for merge conflicts with main: \`git merge-tree $(git merge-base HEAD origin/main) HEAD origin/main\`
5. Update the "Last hourly" timestamp in HEARTBEAT.md to: ${isoNow}
6. Report anything notable. If nothing needs attention, reply with exactly: HEARTBEAT_OK

## Daily Tier (if >24 hours since "Last daily" timestamp)
Perform all Hourly checks, PLUS:

Active threads in the system: ${threadInventory}

1. Summarize the day's work by running \`git log --since="24 hours ago" --oneline\` and reviewing HEARTBEAT.md tasks
2. Run \`gh pr list --state open\` to get current PR status (open, draft, review requested)
3. Run \`gh issue list\` to check for new or aging items
4. Flag any stale branches (>7 days without commits): \`git branch -r --sort=-committerdate --format='%(committerdate:relative) %(refname:short)'\`
5. Compile a daily summary and send it to the master thread (threadId: 1) using the \`send_message\` MCP tool. The summary MUST include:
   - **What was worked on:** key commits from git log (with brief descriptions)
   - **PR status:** any open PRs, their CI status, review state
   - **Blockers:** anything stuck, failing, or needing human attention
   - **Stale branches:** any branches flagged in step 4
   - If there were NO commits in the last 24 hours and no open PRs, skip sending the summary
6. Update the "Last daily" timestamp in HEARTBEAT.md to: ${isoNow}
7. After sending the daily summary to the master thread, reply with exactly: HEARTBEAT_OK (this suppresses local delivery since the summary was sent to the master thread)

## Timestamp Comparison Rules
- "(never)" means the check has NEVER been run — it is due immediately
- Compare the stored ISO timestamp to the current time: ${now} (${isoNow})
- If "Last hourly" is more than 60 minutes ago or "(never)", the hourly tier is due
- If "Last daily" is more than 24 hours ago or "(never)", the daily tier is due

## Important
- Always update timestamps AFTER completing the checks for that tier
- Reply HEARTBEAT_OK if nothing needs attention (this suppresses the message from being sent to Telegram)
- If something needs attention, describe it clearly in your response — it will be sent to the Telegram thread
- To report to other threads, write JSON messages to .tinyclaw/queue/outgoing/ with the targetThreadId field
- You can edit the Tasks and Notes sections of HEARTBEAT.md freely as your own scratch space`

    + (config.isMaster ? `

## Master Thread Daily Extras (applies to Daily Tier only)
As the master thread, you do NOT send a daily summary to yourself. Instead, skip step 5 of the Daily Tier above (sending via send_message). Your daily responsibilities are:

1. **Aggregate thread reports:** Check .tinyclaw/queue/incoming/ for any unprocessed daily summaries from worker threads. Read and incorporate them into active-projects.md in your knowledge base. Commit after updating: \`git add -A && git commit -m "Update: daily report aggregation"\`
2. **Surface items needing human attention:** After reviewing all thread reports and your own checks, compile a list of anything across ALL threads that needs human intervention:
   - Failed CI checks or broken builds
   - PRs waiting on human review for >24 hours
   - Threads reporting blockers
   - Stale branches or abandoned work
   If there are items needing attention, include them in your response (do NOT reply HEARTBEAT_OK — let the message reach Telegram so the human sees it).
3. **Thread health overview:** Note any threads that have NOT sent a daily report in the last 24 hours (they may be idle or have a broken heartbeat). Active threads: ${threadInventory}` : "")
    ;
}

// ─── Thread Management ───

export function resetThread(threadId: number): void {
    const threads = loadThreads();
    const key = String(threadId);
    if (threads[key]) {
        delete threads[key].sessionId;
        saveThreads(threads);
    }
}

export function configureThread(threadId: number, updates: Partial<ThreadConfig>): void {
    const threads = loadThreads();
    const key = String(threadId);
    // Filter out undefined values from updates
    const filtered = Object.fromEntries(
        Object.entries(updates).filter(([, v]) => v !== undefined)
    ) as Partial<ThreadConfig>;

    if (threads[key]) {
        threads[key] = { ...threads[key], ...filtered };
    } else {
        threads[key] = {
            name: filtered.name ?? `Thread ${threadId}`,
            cwd: filtered.cwd ?? DEFAULT_CWD,
            model: filtered.model ?? "sonnet",
            isMaster: filtered.isMaster ?? false,
            lastActive: filtered.lastActive ?? Date.now(),
        };
    }
    saveThreads(threads);
}

