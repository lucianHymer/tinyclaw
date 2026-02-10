#!/usr/bin/env node
/**
 * Queue Processor - Agent SDK v1 query() API
 *
 * Processes messages from all channels (Telegram, CLI, heartbeat, cross-thread, etc.)
 * one at a time via a file-based queue. Each thread gets its own persistent session
 * via the resume mechanism. Smart routing selects the cheapest model per message.
 */

import fs from "fs";
import path from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
    SDKMessage,
    SDKResultMessage,
    Options,
    Query,
    CanUseTool as SDKCanUseTool,
} from "@anthropic-ai/claude-agent-sdk";
import { route, DEFAULT_ROUTING_CONFIG, maxTier } from "./router/index.js";
import type { Tier, RoutingDecision } from "./router/index.js";
import { logDecision } from "./routing-logger.js";
import { toErrorMessage } from "./types.js";
import type { IncomingMessage, OutgoingMessage } from "./types.js";
import {
    appendHistory,
    getRecentHistory,
    buildEnrichedPrompt,
    buildHistoryContext,
} from "./message-history.js";
import { createTinyClawMcpServer } from "./mcp-tools.js";
import type { MessageSource, MessageHistoryEntry } from "./message-history.js";
import {
    loadThreads,
    saveThreads,
    loadSettings,
    resetThread,
    configureThread,
    buildThreadPrompt,
    buildHeartbeatPrompt,
} from "./session-manager.js";
import type { ThreadConfig, ThreadsMap } from "./session-manager.js";

// ─── Paths ───

const SCRIPT_DIR = path.resolve(__dirname, "..");
const TINYCLAW_DIR = path.join(SCRIPT_DIR, ".tinyclaw");
const QUEUE_INCOMING = path.join(TINYCLAW_DIR, "queue/incoming");
const QUEUE_OUTGOING = path.join(TINYCLAW_DIR, "queue/outgoing");
const QUEUE_PROCESSING = path.join(TINYCLAW_DIR, "queue/processing");
const QUEUE_DEAD_LETTER = path.join(TINYCLAW_DIR, "queue/dead-letter");
const QUEUE_COMMANDS = path.join(TINYCLAW_DIR, "queue/commands");
const LOG_FILE = path.join(TINYCLAW_DIR, "logs/queue.log");
const ROUTING_LOG = path.join(TINYCLAW_DIR, "logs/routing.jsonl");
const PROMPTS_LOG = path.join(TINYCLAW_DIR, "logs/prompts.jsonl");
const PROMPTS_LOG_BACKUP = path.join(TINYCLAW_DIR, "logs/prompts.1.jsonl");
const MAX_PROMPTS_LOG_SIZE = 10 * 1024 * 1024; // 10MB

// ─── Ensure queue directories exist ───

[QUEUE_INCOMING, QUEUE_OUTGOING, QUEUE_PROCESSING, QUEUE_DEAD_LETTER, QUEUE_COMMANDS, path.dirname(LOG_FILE)].forEach(
    (dir) => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    },
);

// ─── Startup Recovery: move stuck processing/ files back to incoming/ ───

{
    const stuckFiles = fs.readdirSync(QUEUE_PROCESSING).filter(f => f.endsWith(".json"));
    for (const file of stuckFiles) {
        try {
            fs.renameSync(path.join(QUEUE_PROCESSING, file), path.join(QUEUE_INCOMING, file));
            console.log(`[RECOVERY] Moved stuck file back to incoming: ${file}`);
        } catch {
            // Best effort — file may have been cleaned up already
        }
    }
    if (stuckFiles.length > 0) {
        console.log(`[RECOVERY] Recovered ${stuckFiles.length} stuck message(s) from processing/`);
    }
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

// ─── Prompt Logging ───

function logPrompt(entry: {
    threadId: number;
    messageId: string;
    model: string;
    systemPromptAppend: string;
    userMessage: string;
    historyInjected: boolean;
    historyLines: number;
    promptLength: number;
}): void {
    try {
        // Rotate if needed
        if (fs.existsSync(PROMPTS_LOG)) {
            const stats = fs.statSync(PROMPTS_LOG);
            if (stats.size > MAX_PROMPTS_LOG_SIZE) {
                fs.renameSync(PROMPTS_LOG, PROMPTS_LOG_BACKUP);
            }
        }
        const line = JSON.stringify({
            timestamp: Date.now(),
            ...entry,
            userMessage: entry.userMessage.substring(0, 500),
        }) + "\n";
        fs.appendFileSync(PROMPTS_LOG, line);
    } catch {
        // Logging should never crash the process
    }
}

// ─── Concurrency Guard ───

let processing = false;

// ─── SDK canUseTool Adapter ───

const sdkCanUseTool: SDKCanUseTool = async (toolName, input, _options) => {
    const { canUseTool: sessionCanUseTool } = await import("./session-manager.js");
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

// ─── Build v1 query options ───

function buildQueryOptions(
    threadId: number,
    threadConfig: ThreadConfig,
    effectiveModel: string,
): Options {
    const opts: Options = {
        model: effectiveModel,
        cwd: threadConfig.cwd,
        canUseTool: sdkCanUseTool,
        settingSources: ["project"],
        systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: buildThreadPrompt(threadConfig),
        },
        mcpServers: {
            tinyclaw: createTinyClawMcpServer(threadId),
        },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
    };

    // Resume existing session if available
    if (threadConfig.sessionId) {
        opts.resume = threadConfig.sessionId;
    }

    return opts;
}

// ─── Collect full response text from query stream ───

async function collectQueryResponse(
    q: Query,
): Promise<{ text: string; sessionId: string | undefined }> {
    const parts: string[] = [];
    let capturedSessionId: string | undefined;

    for await (const msg of q) {
        // Always capture the latest session_id (it may change after compaction)
        if ("session_id" in msg && msg.session_id) {
            capturedSessionId = msg.session_id;
        }

        if (msg.type === "assistant") {
            const content = (msg as any).message?.content;
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (block.type === "text" && typeof block.text === "string") {
                        parts.push(block.text);
                    }
                }
            }
        }

        if (msg.type === "result") {
            const result = msg as SDKResultMessage;
            if (result.subtype === "success" && "result" in result && typeof result.result === "string") {
                if (parts.length === 0) {
                    parts.push(result.result);
                }
            }
        }
    }

    return { text: parts.join(""), sessionId: capturedSessionId };
}

// ─── Heartbeat Processing (one-shot, no persistent session) ───

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

    const q = query({
        prompt: fullPrompt,
        options: {
            model: "haiku",
            cwd: threadConfig.cwd,
            canUseTool: sdkCanUseTool,
            settingSources: ["project"],
            systemPrompt: {
                type: "preset",
                preset: "claude_code",
                append: buildThreadPrompt(threadConfig),
            },
            mcpServers: {
                tinyclaw: createTinyClawMcpServer(msg.threadId),
            },
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
        },
    });

    const { text } = await collectQueryResponse(q);
    return text.trim() || "HEARTBEAT_OK";
}

// ─── Route a message to the right model ───

function routeMessage(
    msg: IncomingMessage,
    recentHistory: MessageHistoryEntry[],
): { effectiveModel: string; decision: RoutingDecision } {
    const enrichedPrompt = buildEnrichedPrompt(
        recentHistory,
        msg.message,
        msg.replyToText,
    );

    const decision = route(enrichedPrompt, undefined, {
        config: DEFAULT_ROUTING_CONFIG,
    });

    let effectiveTier: Tier;

    if (msg.isReply && msg.replyToModel) {
        const originalTier = modelToTier(msg.replyToModel);
        effectiveTier = maxTier(originalTier, decision.tier);
    } else {
        effectiveTier = decision.tier;
    }

    const effectiveModel = tierToModel(effectiveTier);

    logDecision(decision, enrichedPrompt, ROUTING_LOG);

    return { effectiveModel, decision };
}

// ─── Process a Single Message ───

async function processMessage(messageFile: string): Promise<void> {
    const filename = path.basename(messageFile);
    const processingFile = path.join(QUEUE_PROCESSING, filename);
    const retryCount = getRetryCount(filename);

    try {
        fs.renameSync(messageFile, processingFile);
    } catch (err) {
        log("ERROR", `Failed to move ${filename} to processing: ${toErrorMessage(err)}`);
        return;
    }

    let msg: IncomingMessage;
    try {
        msg = JSON.parse(fs.readFileSync(processingFile, "utf8")) as IncomingMessage;
    } catch (err) {
        log("ERROR", `Failed to parse ${filename}: ${toErrorMessage(err)}`);
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
                const defaultCwd = process.env.DEFAULT_CWD || "/home/clawcian/.openclaw/workspace";
                threadConfig = {
                    name: `Thread ${threadId}`,
                    cwd: defaultCwd,
                    model: effectiveModel,
                    isMaster: false,
                    lastActive: Date.now(),
                };
                threads[key] = threadConfig;
                saveThreads(threads);
            }

            // Update lastActive
            threads[key].lastActive = Date.now();

            // ─── Build the full prompt ───
            const now = formatCurrentTime();
            const prefix = buildSourcePrefix(msg);
            const isNewSession = !threadConfig.sessionId;
            let fullPrompt: string;
            if (isNewSession) {
                const historyContext = buildHistoryContext(threadId, threadConfig.isMaster);
                const contextBlock = historyContext ? `\n\n${historyContext}\n\n` : "\n\n";
                fullPrompt = `[${now}]${contextBlock}${prefix} ${message}`;
            } else {
                fullPrompt = `[${now}] ${prefix} ${message}`;
            }

            // ─── Log assembled prompt ───
            logPrompt({
                threadId,
                messageId,
                model: effectiveModel,
                systemPromptAppend: buildThreadPrompt(threadConfig).substring(0, 500),
                userMessage: message,
                historyInjected: isNewSession,
                historyLines: isNewSession ? (buildHistoryContext(threadId, threadConfig.isMaster).split("\n").length - 1) : 0,
                promptLength: fullPrompt.length,
            });

            // ─── Send query ───
            const options = buildQueryOptions(threadId, threadConfig, effectiveModel);
            const q = query({ prompt: fullPrompt, options });

            try {
                const { text, sessionId: newSessionId } = await collectQueryResponse(q);
                responseText = text.trim();

                // Persist session ID for future resume
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
            } catch (queryErr) {
                log("ERROR", `Query error for thread ${threadId}: ${toErrorMessage(queryErr)}`);

                // Clear stale sessionId on error
                const freshThreads = loadThreads();
                const freshKey = String(threadId);
                if (freshThreads[freshKey]) {
                    delete freshThreads[freshKey].sessionId;
                    saveThreads(freshThreads);
                }

                throw queryErr;
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
        log("ERROR", `Processing error for ${filename}: ${toErrorMessage(error)}`);
        handleRetry(processingFile, filename, retryCount);
    }
}

// ─── Retry / Dead-Letter Logic ───

function handleRetry(processingFile: string, filename: string, retryCount: number): void {
    if (!fs.existsSync(processingFile)) return;

    if (retryCount >= MAX_RETRIES - 1) {
        moveToDeadLetter(processingFile, filename);
        return;
    }

    const newRetry = retryCount + 1;
    const retryFilename = buildRetryFilename(filename, newRetry);
    const retryPath = path.join(QUEUE_INCOMING, retryFilename);

    try {
        fs.renameSync(processingFile, retryPath);
        log("WARN", `Retry ${newRetry}/${MAX_RETRIES} for ${filename} -> ${retryFilename}`);
    } catch (err) {
        log("ERROR", `Failed to move ${filename} back for retry: ${toErrorMessage(err)}`);
        moveToDeadLetter(processingFile, filename);
    }
}

function moveToDeadLetter(filePath: string, filename: string): void {
    try {
        const deadLetterPath = path.join(QUEUE_DEAD_LETTER, `${Date.now()}_${filename}`);
        fs.renameSync(filePath, deadLetterPath);
        log("ERROR", `Moved to dead-letter: ${filename}`);
    } catch (err) {
        log("ERROR", `Failed to move ${filename} to dead-letter: ${toErrorMessage(err)}`);
        try {
            fs.unlinkSync(filePath);
        } catch {
            // Nothing more we can do
        }
    }
}

// ─── Command Queue Processing ───

async function processCommands(): Promise<void> {
    if (!fs.existsSync(QUEUE_COMMANDS)) return;

    const files = fs.readdirSync(QUEUE_COMMANDS).filter(f => f.endsWith(".json"));

    for (const file of files) {
        const filePath = path.join(QUEUE_COMMANDS, file);
        try {
            const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
                command: string;
                threadId: number;
                args?: Record<string, string>;
                timestamp: number;
            };

            if (data.command === "reset") {
                resetThread(data.threadId);
                log("INFO", `Command: reset thread ${data.threadId}`);
            } else if (data.command === "setdir" && data.args?.cwd) {
                configureThread(data.threadId, { cwd: data.args.cwd });
                log("INFO", `Command: setdir thread ${data.threadId} -> ${data.args.cwd}`);
            } else {
                log("WARN", `Unknown command: ${data.command}`);
            }

            fs.unlinkSync(filePath);
        } catch (err) {
            log("ERROR", `Failed to process command ${file}: ${toErrorMessage(err)}`);
            try { fs.unlinkSync(filePath); } catch { /* ignore */ }
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
        await processCommands();

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

        for (const file of files) {
            await processMessage(file.path);
        }
    } catch (error) {
        log("ERROR", `Queue scan error: ${toErrorMessage(error)}`);
    } finally {
        processing = false;
    }
}

// ─── Graceful Shutdown ───

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    log("INFO", `Received ${signal}. Shutting down...`);

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

log("INFO", "Queue processor started (Agent SDK v1 query API + smart routing)");
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
    log("WARN", `fs.watch unavailable: ${toErrorMessage(err)}. Using interval fallback only.`);
}

// 5-second fallback interval
const queueInterval = setInterval(() => {
    void processQueue();
}, 5000);

// Initial queue drain on startup
void processQueue();
