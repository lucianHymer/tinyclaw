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
const THREADS_FILE = path.join(SCRIPT_DIR, ".tinyclaw/threads.json");
const SETTINGS_FILE = path.join(SCRIPT_DIR, ".tinyclaw/settings.json");
export const MAX_CONCURRENT_SESSIONS = 10;
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// ─── In-memory caches ───

let threadsCache: ThreadsMap | null = null;
let settingsCache: Settings | null = null;

// ─── Thread Persistence ───

export function loadThreads(): ThreadsMap {
    if (threadsCache) return threadsCache;
    try {
        const data = fs.readFileSync(THREADS_FILE, "utf8");
        threadsCache = JSON.parse(data) as ThreadsMap;
        return threadsCache;
    } catch {
        threadsCache = {
            "1": {
                name: "Master",
                cwd: "/home/clawcian/.openclaw/workspace",
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
    if (settingsCache) return settingsCache;
    const defaults: Settings = {
        timezone: "UTC",
        telegram_bot_token: "",
        telegram_chat_id: "",
        heartbeat_interval: 300,
        max_concurrent_sessions: MAX_CONCURRENT_SESSIONS,
        session_idle_timeout_minutes: 30,
    };

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

You can:
- See all active threads and their status in .tinyclaw/threads.json
- Read any thread's history from .tinyclaw/message-history.jsonl
- Message any thread by writing to .tinyclaw/queue/outgoing/ with targetThreadId
- Broadcast to all threads by writing multiple outgoing messages
- Reset a thread: Write {"command": "reset", "threadId": N, "timestamp": <epoch_ms>} to .tinyclaw/queue/commands/
- Change working directory: Write {"command": "setdir", "threadId": N, "args": {"cwd": "/path"}, "timestamp": <epoch_ms>} to .tinyclaw/queue/commands/

You receive periodic heartbeat messages. Read HEARTBEAT.md in your working directory
and follow it. You can edit HEARTBEAT.md to maintain your own task list. Reply
HEARTBEAT_OK if nothing needs attention.

Keep responses concise — Telegram messages over 4000 characters get split.${runtimeBlock}`;
    }

    return `You are TinyClaw, an AI assistant that users communicate with through Telegram. You are a full Claude Code agent with file access, code editing, terminal commands, and web search. Users send you messages in a Telegram forum topic and you respond there. Treat every incoming message as a direct conversation with the user — be helpful, conversational, and action-oriented.

Multiple team members may message you. Each message is prefixed with the sender's name (e.g. "[Lucian via Telegram]:"). Pay attention to who is talking — address them by name when appropriate and keep track of what each person is working on or asking about.

You are operating in thread "${config.name}", working in ${config.cwd}. This is your primary project directory.

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
    return `Heartbeat check for thread "${config.name}".

Instructions:
- Read HEARTBEAT.md in your working directory (${config.cwd})
- Edit HEARTBEAT.md to maintain it as your task list
- If nothing needs your attention, reply with exactly: HEARTBEAT_OK
- If something needs attention, describe it in your response
- To report to other threads, write JSON messages to .tinyclaw/queue/outgoing/ with the targetThreadId field`;
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
            cwd: filtered.cwd ?? "/home/clawcian/.openclaw/workspace",
            model: filtered.model ?? "sonnet",
            isMaster: filtered.isMaster ?? false,
            lastActive: filtered.lastActive ?? Date.now(),
        };
    }
    saveThreads(threads);
}

// ─── Session Tracking ───

export function cleanupIdleSessions(sessions: Map<number, unknown>): number[] {
    const threads = loadThreads();
    const now = Date.now();
    const closed: number[] = [];

    for (const [threadId, session] of sessions) {
        const key = String(threadId);
        const config = threads[key];
        if (!config) continue;

        if (config.lastActive > 0 && now - config.lastActive > SESSION_IDLE_TIMEOUT_MS) {
            // Close the session if it has a close method
            if (session && typeof (session as { close?: () => void }).close === "function") {
                (session as { close: () => void }).close();
            }
            sessions.delete(threadId);
            closed.push(threadId);
        }
    }

    return closed;
}
