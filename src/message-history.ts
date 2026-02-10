/**
 * Message History - JSONL-based message history for cross-thread context
 * Stores and retrieves conversation history across all threads/channels
 */

import fs from "fs";
import path from "path";

const SCRIPT_DIR = path.resolve(__dirname, "..");
const HISTORY_FILE = path.join(SCRIPT_DIR, ".tinyclaw/message-history.jsonl");
const HISTORY_BACKUP = path.join(SCRIPT_DIR, ".tinyclaw/message-history.1.jsonl");
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export type MessageSource = "user" | "cross-thread" | "heartbeat" | "cli" | "system";

export interface MessageHistoryEntry {
    ts: number;
    threadId: number;
    channel: string;
    sender: string;
    direction: "in" | "out";
    message: string;
    sessionId?: string;
    model?: string;
    source?: MessageSource;
    sourceThreadId?: number;
}

/**
 * Append a message history entry as a JSONL line.
 * Ensures the directory exists and rotates the file if it exceeds 10MB.
 */
export function appendHistory(entry: MessageHistoryEntry): void {
    const dir = path.dirname(HISTORY_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Check file size and rotate if needed
    if (fs.existsSync(HISTORY_FILE)) {
        const stats = fs.statSync(HISTORY_FILE);
        if (stats.size > MAX_FILE_SIZE) {
            fs.renameSync(HISTORY_FILE, HISTORY_BACKUP);
        }
    }

    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(HISTORY_FILE, line);
}

/**
 * Read recent history entries from the JSONL file.
 * Optionally filter by threadId. Default limit: 20.
 */
export function getRecentHistory(options: { threadId?: number; limit?: number }): MessageHistoryEntry[] {
    const limit = options.limit ?? 20;

    if (!fs.existsSync(HISTORY_FILE)) {
        return [];
    }

    const content = fs.readFileSync(HISTORY_FILE, "utf8");
    const lines = content.split("\n").filter(line => line.trim() !== "");

    let entries: MessageHistoryEntry[] = [];
    for (const line of lines) {
        try {
            entries.push(JSON.parse(line) as MessageHistoryEntry);
        } catch {
            // Skip malformed lines
        }
    }

    if (options.threadId !== undefined) {
        entries = entries.filter(e => e.threadId === options.threadId);
    }

    return entries.slice(-limit);
}

/**
 * Build a history context string for UserPromptSubmit hook injection.
 * Master threads get recent 30 entries from all threads.
 * Worker threads get recent 20 entries from their thread only.
 */
export function buildHistoryContext(threadId: number, isMaster: boolean): string {
    const entries = isMaster
        ? getRecentHistory({ limit: 30 })
        : getRecentHistory({ threadId, limit: 20 });

    if (entries.length === 0) {
        return "";
    }

    const lines = entries.map(e => {
        const truncated = e.message.length > 200
            ? e.message.substring(0, 200) + "..."
            : e.message;
        return `[${e.channel}] ${e.sender}: ${truncated}`;
    });

    return "Recent messages:\n" + lines.join("\n");
}

/**
 * Build an enriched prompt with recent history context for router enrichment.
 * Formats history as [sender]: message lines, appends current message,
 * and optionally prepends reply-to context.
 */
export function buildEnrichedPrompt(
    recentHistory: MessageHistoryEntry[],
    currentMessage: string,
    replyToText?: string,
): string {
    const parts: string[] = [];

    if (replyToText) {
        parts.push(`[replying-to]: ${replyToText}`);
    }

    for (const entry of recentHistory) {
        parts.push(`[${entry.sender}]: ${entry.message}`);
    }

    parts.push(`[current]: ${currentMessage}`);

    return parts.join("\n");
}
