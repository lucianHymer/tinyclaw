#!/usr/bin/env node
/**
 * Queue Processor - Agent SDK v2 Integration
 *
 * Processes messages from all channels (Telegram, CLI, heartbeat, cross-thread, etc.)
 * one at a time via a file-based queue. Each thread gets its own persistent SDK session.
 * Smart routing selects the cheapest model capable of handling each message.
 */

import fs from "fs";
import path from "path";
import {
    unstable_v2_createSession,
    unstable_v2_resumeSession,
    unstable_v2_prompt,
} from "@anthropic-ai/claude-agent-sdk";
import type {
    SDKSession,
    SDKMessage,
    SDKSessionOptions,
    SDKResultMessage,
    CanUseTool as SDKCanUseTool,
} from "@anthropic-ai/claude-agent-sdk";
import { route, DEFAULT_ROUTING_CONFIG, maxTier } from "./router/index.js";
import type { Tier, RoutingDecision } from "./router/index.js";
import { logDecision, expandPath } from "./routing-logger.js";
import {
    appendHistory,
    getRecentHistory,
    buildEnrichedPrompt,
    buildHistoryContext,
} from "./message-history.js";
import type { MessageSource, MessageHistoryEntry } from "./message-history.js";
import {
    loadThreads,
    saveThreads,
    loadSettings,
    canUseTool as sessionCanUseTool,
    buildThreadPrompt,
    buildHeartbeatPrompt,
    cleanupIdleSessions,
} from "./session-manager.js";
import type { ThreadConfig, ThreadsMap } from "./session-manager.js";

// ─── Paths ───

const SCRIPT_DIR = path.resolve(__dirname, "..");
const TINYCLAW_DIR = path.join(SCRIPT_DIR, ".tinyclaw");
const QUEUE_INCOMING = path.join(TINYCLAW_DIR, "queue/incoming");
const QUEUE_OUTGOING = path.join(TINYCLAW_DIR, "queue/outgoing");
const QUEUE_PROCESSING = path.join(TINYCLAW_DIR, "queue/processing");
const QUEUE_DEAD_LETTER = path.join(TINYCLAW_DIR, "queue/dead-letter");
const LOG_FILE = path.join(TINYCLAW_DIR, "logs/queue.log");
const ROUTING_LOG = path.join(TINYCLAW_DIR, "logs/routing.jsonl");

// ─── Ensure queue directories exist ───

[QUEUE_INCOMING, QUEUE_OUTGOING, QUEUE_PROCESSING, QUEUE_DEAD_LETTER, path.dirname(LOG_FILE)].forEach(
    (dir) => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    },
);

// ─── Types ───

interface IncomingMessage {
    channel: string;
    source?: MessageSource;
    threadId: number;
    sourceThreadId?: number;
    sender: string;
    senderId?: string;
    message: string;
    isReply?: boolean;
    replyToText?: string;
    replyToModel?: string;
    timestamp: number;
    messageId: string;
}

interface OutgoingMessage {
    channel: string;
    threadId: number;
    sender: string;
    message: string;
    originalMessage: string;
    timestamp: number;
    messageId: string;
    model: string;
    targetThreadId?: number;
}

// ─── Tier / Model Mapping ───

const TIER_TO_MODEL: Record<Tier, string> = {
    SIMPLE: "haiku",
    MEDIUM: "sonnet",
    COMPLEX: "opus",
};

const MODEL_TO_TIER: Record<string, Tier> = {
    haiku: "SIMPLE",
    sonnet: "MEDIUM",
    opus: "COMPLEX",
};

function modelToTier(model: string): Tier {
    return MODEL_TO_TIER[model] ?? "MEDIUM";
}

function tierToModel(tier: Tier): string {
    return TIER_TO_MODEL[tier];
}

// ─── Logger ───

function log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    console.log(logMessage.trim());
    try {
        fs.appendFileSync(LOG_FILE, logMessage);
    } catch {
        // Logging should never crash the process
    }
}

// ─── Concurrency Guard ───

let processing = false;

// ─── Active Session Tracking ───

const activeSessions = new Map<number, SDKSession>();

// ─── SDK canUseTool Adapter ───
// The SDK expects a 3-arg canUseTool; our session-manager exports a simpler 2-arg version.
// We adapt it here so the type system is satisfied.

const sdkCanUseTool: SDKCanUseTool = async (toolName, input, _options) => {
    const result = await sessionCanUseTool(toolName, input);
    if (result.behavior === "allow") {
        return { behavior: "allow", updatedInput: result.updatedInput as Record<string, unknown> | undefined };
    }
    return { behavior: "deny", message: result.message };
};

// ─── Retry Helpers ───

const MAX_RETRIES = 3;

function getRetryCount(filename: string): number {
    const match = filename.match(/_retry(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
}

function buildRetryFilename(filename: string, retryNum: number): string {
    // Remove any existing _retryN suffix before adding the new one
    const base = filename.replace(/_retry\d+/, "");
    const ext = path.extname(base);
    const stem = base.slice(0, -ext.length);
    return `${stem}_retry${retryNum}${ext}`;
}

// ─── Time Injection ───

function formatCurrentTime(): string {
    const settings = loadSettings();
    return new Date().toLocaleString("en-US", {
        timeZone: settings.timezone,
        weekday: "long",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
    });
}

// ─── Source-Aware Prefix ───

function buildSourcePrefix(msg: IncomingMessage): string {
    const prefixMap: Record<string, string> = {
        user: `[${msg.sender} via Telegram]:`,
        "cross-thread": `[Cross-thread from ${msg.sender} (thread ${msg.sourceThreadId})]:`,
        heartbeat: `[Heartbeat check-in]:`,
        cli: `[CLI message]:`,
        system: `[System event]:`,
    };
    return prefixMap[msg.source ?? "user"];
}

// ─── SDK Session Builder ───

function buildSessionOptions(
    threadConfig: ThreadConfig,
    effectiveModel: string,
): SDKSessionOptions {
    return {
        model: effectiveModel,
        cwd: threadConfig.cwd,
        canUseTool: sdkCanUseTool,
        settingSources: ["project"] as const,
        systemPrompt: {
            type: "preset" as const,
            preset: "claude_code" as const,
            append: buildThreadPrompt(threadConfig),
        },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
    } as SDKSessionOptions;
}

// ─── Collect full response text from SDK stream ───

async function collectStreamResponse(
    session: SDKSession,
): Promise<{ text: string; sessionId: string | undefined }> {
    const parts: string[] = [];
    let capturedSessionId: string | undefined;

    for await (const msg of session.stream()) {
        // Always capture the latest session_id (it may change after compaction)
        if ("session_id" in msg && msg.session_id) {
            capturedSessionId = msg.session_id;
        }

        if (msg.type === "assistant") {
            const content = msg.message?.content;
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (block.type === "text" && typeof block.text === "string") {
                        parts.push(block.text);
                    }
                }
            }
        }

        if (msg.type === "result") {
            if (msg.subtype === "success" && "result" in msg && typeof msg.result === "string") {
                // Use the result field as the canonical response if available
                if (parts.length === 0) {
                    parts.push(msg.result);
                }
            }
        }
    }

    return { text: parts.join(""), sessionId: capturedSessionId };
}

// ─── Heartbeat Processing (one-shot, no session) ───

async function processHeartbeat(msg: IncomingMessage): Promise<string> {
    const threads = loadThreads();
    const threadConfig = threads[String(msg.threadId)];
    if (!threadConfig) {
        return "HEARTBEAT_OK";
    }

    const heartbeatPrompt = buildHeartbeatPrompt(threadConfig);
    const now = formatCurrentTime();
    const fullPrompt = `[${now}] ${heartbeatPrompt}`;

    log("INFO", `Heartbeat one-shot for thread ${msg.threadId}`);

    const result: SDKResultMessage = await unstable_v2_prompt(fullPrompt, {
        model: "haiku",
        cwd: threadConfig.cwd,
        canUseTool: sdkCanUseTool,
        settingSources: ["project"] as const,
        systemPrompt: {
            type: "preset" as const,
            preset: "claude_code" as const,
            append: buildThreadPrompt(threadConfig),
        },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
    } as SDKSessionOptions);

    if (result.subtype === "success" && "result" in result) {
        return result.result;
    }

    return "HEARTBEAT_OK";
}

// ─── Route a message to the right model ───

function routeMessage(
    msg: IncomingMessage,
    recentHistory: MessageHistoryEntry[],
): { effectiveModel: string; decision: RoutingDecision } {
    // Build enriched prompt for the router
    const enrichedPrompt = buildEnrichedPrompt(
        recentHistory,
        msg.message,
        msg.replyToText,
    );

    // Run the router
    const decision = route(enrichedPrompt, undefined, {
        config: DEFAULT_ROUTING_CONFIG,
    });

    let effectiveTier: Tier;

    if (msg.isReply && msg.replyToModel) {
        // Reply: upgrade only (never downgrade from original model)
        const originalTier = modelToTier(msg.replyToModel);
        effectiveTier = maxTier(originalTier, decision.tier);
    } else {
        // Fresh message: router picks freely
        effectiveTier = decision.tier;
    }

    const effectiveModel = tierToModel(effectiveTier);

    // Log the routing decision
    logDecision(decision, enrichedPrompt, ROUTING_LOG);

    return { effectiveModel, decision };
}

// ─── Get or Create SDK Session ───

async function getSession(
    threadId: number,
    threadConfig: ThreadConfig,
    effectiveModel: string,
): Promise<SDKSession> {
    const existing = activeSessions.get(threadId);
    const options = buildSessionOptions(threadConfig, effectiveModel);

    // If model changed, close old session and resume with new model
    if (existing && threadConfig.model !== effectiveModel && threadConfig.sessionId) {
        log("INFO", `Model changed for thread ${threadId}: ${threadConfig.model} -> ${effectiveModel}. Re-creating session.`);
        try {
            existing.close();
        } catch {
            // Ignore close errors
        }
        activeSessions.delete(threadId);

        try {
            const session = unstable_v2_resumeSession(threadConfig.sessionId, {
                ...options,
                model: effectiveModel,
            });
            activeSessions.set(threadId, session);
            return session;
        } catch (err) {
            log("WARN", `Failed to resume session for thread ${threadId} after model change: ${(err as Error).message}. Creating new session.`);
            // Fall through to create new session
        }
    }

    // If we have a cached session and model didn't change, return it
    if (existing) {
        return existing;
    }

    // Try to resume existing session
    if (threadConfig.sessionId) {
        try {
            const session = unstable_v2_resumeSession(threadConfig.sessionId, options);
            activeSessions.set(threadId, session);
            return session;
        } catch (err) {
            log("WARN", `Failed to resume session ${threadConfig.sessionId} for thread ${threadId}: ${(err as Error).message}. Creating new session.`);
            // Clear stale sessionId
            const threads = loadThreads();
            const key = String(threadId);
            if (threads[key]) {
                delete threads[key].sessionId;
                saveThreads(threads);
            }
        }
    }

    // Create a fresh session
    const session = unstable_v2_createSession(options);
    activeSessions.set(threadId, session);
    return session;
}

// ─── Process a Single Message ───

async function processMessage(messageFile: string): Promise<void> {
    const filename = path.basename(messageFile);
    const processingFile = path.join(QUEUE_PROCESSING, filename);
    const retryCount = getRetryCount(filename);

    try {
        // Move to processing
        fs.renameSync(messageFile, processingFile);
    } catch (err) {
        log("ERROR", `Failed to move ${filename} to processing: ${(err as Error).message}`);
        return;
    }

    let msg: IncomingMessage;
    try {
        msg = JSON.parse(fs.readFileSync(processingFile, "utf8")) as IncomingMessage;
    } catch (err) {
        log("ERROR", `Failed to parse ${filename}: ${(err as Error).message}`);
        moveToDeadLetter(processingFile, filename);
        return;
    }

    const { channel, threadId, sender, message, messageId, source } = msg;
    log("INFO", `Processing [${channel}] thread=${threadId} from ${sender}: ${message.substring(0, 80)}...`);

    // Log incoming message to history
    appendHistory({
        ts: Date.now(),
        threadId,
        channel,
        sender,
        direction: "in",
        message,
        source: source ?? "user",
        sourceThreadId: msg.sourceThreadId,
    });

    let responseText: string;
    let effectiveModel: string;

    try {
        // ─── Heartbeat: one-shot, skip router and session ───
        if (source === "heartbeat") {
            effectiveModel = "haiku";
            responseText = await processHeartbeat(msg);
        } else {
            // ─── Route the message ───
            const recentHistory = getRecentHistory({ threadId, limit: 5 });
            const routingResult = routeMessage(msg, recentHistory);
            effectiveModel = routingResult.effectiveModel;

            log(
                "INFO",
                `Routed thread=${threadId}: tier=${routingResult.decision.tier} model=${effectiveModel} ` +
                `confidence=${routingResult.decision.confidence.toFixed(2)} signals=[${routingResult.decision.signals.join(", ")}]`,
            );

            // ─── Load thread config ───
            const threads = loadThreads();
            const key = String(threadId);
            let threadConfig = threads[key];

            if (!threadConfig) {
                // Auto-create thread config for unknown threads
                threadConfig = {
                    name: `Thread ${threadId}`,
                    cwd: path.join("/home/clawcian/.openclaw/workspace"),
                    model: effectiveModel,
                    isMaster: false,
                    lastActive: Date.now(),
                };
                threads[key] = threadConfig;
                saveThreads(threads);
            }

            // Update lastActive
            threads[key].lastActive = Date.now();

            // ─── Build the full prompt with history context ───
            const now = formatCurrentTime();
            const prefix = buildSourcePrefix(msg);
            const historyContext = buildHistoryContext(threadId, threadConfig.isMaster);
            const contextBlock = historyContext ? `\n\n${historyContext}\n\n` : "\n\n";
            const fullPrompt = `[${now}]${contextBlock}${prefix} ${message}`;

            // ─── Get or create session ───
            const session = await getSession(threadId, threadConfig, effectiveModel);

            try {
                // Send the message
                await session.send(fullPrompt);

                // Collect the response
                const { text, sessionId: newSessionId } = await collectStreamResponse(session);
                responseText = text.trim();

                // Persist updated sessionId if it changed
                if (newSessionId) {
                    const freshThreads = loadThreads();
                    const freshKey = String(threadId);
                    if (freshThreads[freshKey]) {
                        freshThreads[freshKey].sessionId = newSessionId;
                        freshThreads[freshKey].model = effectiveModel;
                        freshThreads[freshKey].lastActive = Date.now();
                        saveThreads(freshThreads);
                    }
                }
            } catch (sessionErr) {
                // Session error: close and remove from cache, let retry handle it
                log("ERROR", `Session error for thread ${threadId}: ${(sessionErr as Error).message}`);
                try {
                    const cached = activeSessions.get(threadId);
                    if (cached) {
                        cached.close();
                    }
                } catch {
                    // Ignore
                }
                activeSessions.delete(threadId);

                // Clear stale sessionId
                const freshThreads = loadThreads();
                const freshKey = String(threadId);
                if (freshThreads[freshKey]) {
                    delete freshThreads[freshKey].sessionId;
                    saveThreads(freshThreads);
                }

                throw sessionErr;
            }
        }

        // Fallback for empty responses
        if (!responseText) {
            responseText = "(No response generated)";
        }

        // Truncate very long responses
        if (responseText.length > 4000) {
            responseText = responseText.substring(0, 3900) + "\n\n[Response truncated...]";
        }

        // ─── Log outgoing message to history ───
        appendHistory({
            ts: Date.now(),
            threadId,
            channel,
            sender: "assistant",
            direction: "out",
            message: responseText,
            model: effectiveModel,
            source: source ?? "user",
        });

        // ─── Write response to outgoing queue ───
        const responseData: OutgoingMessage = {
            channel,
            threadId,
            sender,
            message: responseText,
            originalMessage: message,
            timestamp: Date.now(),
            messageId,
            model: effectiveModel,
        };

        const responseFile =
            channel === "heartbeat"
                ? path.join(QUEUE_OUTGOING, `${messageId}.json`)
                : path.join(QUEUE_OUTGOING, `${channel}_${messageId}_${Date.now()}.json`);

        fs.writeFileSync(responseFile, JSON.stringify(responseData, null, 2));

        log(
            "INFO",
            `Response ready [${channel}] thread=${threadId} model=${effectiveModel} (${responseText.length} chars)`,
        );

        // Clean up processing file
        if (fs.existsSync(processingFile)) {
            fs.unlinkSync(processingFile);
        }
    } catch (error) {
        log("ERROR", `Processing error for ${filename}: ${(error as Error).message}`);
        handleRetry(processingFile, filename, retryCount);
    }
}

// ─── Retry / Dead-Letter Logic ───

function handleRetry(processingFile: string, filename: string, retryCount: number): void {
    if (!fs.existsSync(processingFile)) return;

    if (retryCount >= MAX_RETRIES - 1) {
        // Max retries exhausted - move to dead-letter
        moveToDeadLetter(processingFile, filename);
        return;
    }

    // Rename with incremented retry count and move back to incoming
    const newRetry = retryCount + 1;
    const retryFilename = buildRetryFilename(filename, newRetry);
    const retryPath = path.join(QUEUE_INCOMING, retryFilename);

    try {
        fs.renameSync(processingFile, retryPath);
        log("WARN", `Retry ${newRetry}/${MAX_RETRIES} for ${filename} -> ${retryFilename}`);
    } catch (err) {
        log("ERROR", `Failed to move ${filename} back for retry: ${(err as Error).message}`);
        moveToDeadLetter(processingFile, filename);
    }
}

function moveToDeadLetter(filePath: string, filename: string): void {
    try {
        const deadLetterPath = path.join(QUEUE_DEAD_LETTER, `${Date.now()}_${filename}`);
        fs.renameSync(filePath, deadLetterPath);
        log("ERROR", `Moved to dead-letter: ${filename}`);
    } catch (err) {
        log("ERROR", `Failed to move ${filename} to dead-letter: ${(err as Error).message}`);
        // Last resort: just delete the processing file so it doesn't block the queue
        try {
            fs.unlinkSync(filePath);
        } catch {
            // Nothing more we can do
        }
    }
}

// ─── Queue Scanning ───

interface QueueFile {
    name: string;
    path: string;
    time: number;
}

async function processQueue(): Promise<void> {
    if (processing) return;
    processing = true;

    try {
        const files: QueueFile[] = fs
            .readdirSync(QUEUE_INCOMING)
            .filter((f) => f.endsWith(".json"))
            .map((f) => ({
                name: f,
                path: path.join(QUEUE_INCOMING, f),
                time: fs.statSync(path.join(QUEUE_INCOMING, f)).mtimeMs,
            }))
            .sort((a, b) => a.time - b.time);

        if (files.length > 0) {
            log("DEBUG", `Found ${files.length} message(s) in queue`);
        }

        // Process one at a time
        for (const file of files) {
            await processMessage(file.path);
        }
    } catch (error) {
        log("ERROR", `Queue scan error: ${(error as Error).message}`);
    } finally {
        processing = false;
    }
}

// ─── Idle Session Cleanup ───

function cleanupIdle(): void {
    const closed = cleanupIdleSessions(activeSessions as Map<number, unknown>);
    if (closed.length > 0) {
        log("INFO", `Cleaned up ${closed.length} idle session(s): [${closed.join(", ")}]`);
    }
}

// ─── Graceful Shutdown ───

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    log("INFO", `Received ${signal}. Shutting down...`);

    // Close all active sessions
    for (const [threadId, session] of activeSessions) {
        try {
            log("INFO", `Closing session for thread ${threadId}`);
            session.close();
        } catch (err) {
            log("WARN", `Error closing session for thread ${threadId}: ${(err as Error).message}`);
        }
    }
    activeSessions.clear();

    // Save threads state
    try {
        const threads = loadThreads();
        saveThreads(threads);
        log("INFO", "Saved threads.json");
    } catch {
        // Best effort
    }

    log("INFO", "Queue processor shut down.");
    process.exit(0);
}

process.on("SIGINT", () => {
    void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
});

// ─── Startup ───

log("INFO", "Queue processor started (Agent SDK v2 + smart routing)");
log("INFO", `Watching: ${QUEUE_INCOMING}`);

// fs.watch for near-instant pickup
try {
    fs.watch(QUEUE_INCOMING, { persistent: false }, (_eventType, filename) => {
        if (filename && filename.endsWith(".json") && !processing) {
            void processQueue();
        }
    });
    log("INFO", "fs.watch active on incoming queue");
} catch (err) {
    log("WARN", `fs.watch unavailable: ${(err as Error).message}. Using interval fallback only.`);
}

// 5-second fallback interval
const queueInterval = setInterval(() => {
    void processQueue();
}, 5000);

// Periodic idle session cleanup (every 5 minutes)
const cleanupInterval = setInterval(cleanupIdle, 5 * 60 * 1000);

// Initial queue drain on startup
void processQueue();
