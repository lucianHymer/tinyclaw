#!/usr/bin/env node
/**
 * Telegram Client - grammY-based Telegram bot for TinyClaw
 * Handles incoming messages, commands, and outgoing queue polling.
 */

import fs from "fs";
import path from "path";
import { Bot, Context } from "grammy";
import { autoChatAction, AutoChatActionFlavor } from "@grammyjs/auto-chat-action";
import { autoRetry } from "@grammyjs/auto-retry";
import {
    loadThreads,
    saveThreads,
    loadSettings,
    resetThread,
    configureThread,
} from "./session-manager.js";
import type { ThreadConfig, ThreadsMap, Settings } from "./session-manager.js";
import type { OutgoingMessage } from "./types.js";
import { toErrorMessage } from "./types.js";

// ─── Context Type ───

type MyContext = Context & AutoChatActionFlavor;

// ─── Constants ───

const SCRIPT_DIR = path.resolve(__dirname, "..");
const QUEUE_INCOMING = path.join(SCRIPT_DIR, ".tinyclaw/queue/incoming");
const QUEUE_OUTGOING = path.join(SCRIPT_DIR, ".tinyclaw/queue/outgoing");
const LOG_FILE = path.join(SCRIPT_DIR, ".tinyclaw/logs/telegram.log");
const MESSAGE_MODELS_FILE = path.join(SCRIPT_DIR, ".tinyclaw/message-models.json");

// ─── Ensure Directories Exist ───

[QUEUE_INCOMING, QUEUE_OUTGOING, path.dirname(LOG_FILE), path.dirname(MESSAGE_MODELS_FILE)].forEach(
    (dir) => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    },
);

// ─── Logger ───

function log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    console.log(logMessage.trim());
    fs.appendFileSync(LOG_FILE, logMessage);
}

// ─── Message Model Tracking ───

let messageModelsCache: Record<string, string> | null = null;

function loadMessageModels(): Record<string, string> {
    if (messageModelsCache) return messageModelsCache;
    try {
        const data = fs.readFileSync(MESSAGE_MODELS_FILE, "utf8");
        messageModelsCache = JSON.parse(data) as Record<string, string>;
        return messageModelsCache;
    } catch {
        messageModelsCache = {};
        return messageModelsCache;
    }
}

function saveMessageModels(models: Record<string, string>): void {
    // Prune to last 1000 entries
    const keys = Object.keys(models);
    if (keys.length > 1000) {
        const toRemove = keys.slice(0, keys.length - 1000);
        for (const key of toRemove) {
            delete models[key];
        }
    }
    const tmp = MESSAGE_MODELS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(models, null, 2));
    fs.renameSync(tmp, MESSAGE_MODELS_FILE);
    messageModelsCache = models;
}

function storeMessageModel(messageId: number, model: string): void {
    const models = loadMessageModels();
    models[String(messageId)] = model;
    saveMessageModels(models);
}

function lookupMessageModel(messageId: number): string | undefined {
    const models = loadMessageModels();
    return models[String(messageId)];
}

// ─── Pending Messages ───

interface PendingMessage {
    ctx: MyContext;
    chatId: number;
    threadId: number;
}

const pendingMessages = new Map<string, PendingMessage>();

// ─── Message Splitting ───

function splitMessage(text: string, maxLength = 4096): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }

        let splitIndex = remaining.lastIndexOf("\n\n", maxLength);
        if (splitIndex <= 0) splitIndex = remaining.lastIndexOf("\n", maxLength);
        if (splitIndex <= 0) splitIndex = remaining.lastIndexOf(" ", maxLength);
        if (splitIndex <= 0) splitIndex = maxLength;

        chunks.push(remaining.substring(0, splitIndex));
        remaining = remaining.substring(splitIndex).replace(/^\n+/, "");
    }

    return chunks;
}

// ─── Bot Setup ───

const settings = loadSettings();
const bot = new Bot<MyContext>(settings.telegram_bot_token);

bot.use(autoChatAction());
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));

// ─── Commands ───

bot.command("reset", async (ctx) => {
    if (String(ctx.chat?.id) !== settings.telegram_chat_id) return;
    const threadId = ctx.msg.message_thread_id ?? 1;
    resetThread(threadId);
    await ctx.reply("Session reset! Starting fresh.", {
        message_thread_id: ctx.msg.message_thread_id,
    });
    log("INFO", `Thread ${threadId} reset by ${ctx.from?.first_name ?? "unknown"}`);
});

bot.command("setdir", async (ctx) => {
    if (String(ctx.chat?.id) !== settings.telegram_chat_id) return;
    const threadId = ctx.msg.message_thread_id ?? 1;
    const dir = ctx.match?.trim();

    if (!dir) {
        await ctx.reply("Usage: /setdir <path>", {
            message_thread_id: ctx.msg.message_thread_id,
        });
        return;
    }

    configureThread(threadId, { cwd: dir });
    await ctx.reply(`Working directory set to: ${dir}`, {
        message_thread_id: ctx.msg.message_thread_id,
    });
    log("INFO", `Thread ${threadId} cwd set to ${dir} by ${ctx.from?.first_name ?? "unknown"}`);
});

bot.command("status", async (ctx) => {
    if (String(ctx.chat?.id) !== settings.telegram_chat_id) return;
    const threads = loadThreads();
    const lines: string[] = ["Active threads:"];

    for (const [id, config] of Object.entries(threads)) {
        const lastActive = config.lastActive
            ? new Date(config.lastActive).toLocaleString()
            : "never";
        lines.push(
            `  Thread ${id} (${config.name}): model=${config.model}, cwd=${config.cwd}, last=${lastActive}`,
        );
    }

    await ctx.reply(lines.join("\n"), {
        message_thread_id: ctx.msg.message_thread_id,
    });
});

// ─── Message Handler ───

bot.on("message:text").filter(
    (ctx) => ctx.from.id !== bot.botInfo.id,
    async (ctx) => {
        const threadId = ctx.msg.message_thread_id ?? 1;
        const isReplyToBot = ctx.msg.reply_to_message?.from?.id === bot.botInfo.id;
        const replyToText = isReplyToBot ? ctx.msg.reply_to_message?.text : undefined;
        const replyToModel =
            isReplyToBot && ctx.msg.reply_to_message
                ? lookupMessageModel(ctx.msg.reply_to_message.message_id)
                : undefined;

        // Restrict to configured chat ID
        if (String(ctx.chat.id) !== settings.telegram_chat_id) return;

        ctx.chatAction = "typing";

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
            replyToModel,
            timestamp: Date.now(),
            messageId,
        };

        const queueFile = path.join(QUEUE_INCOMING, `telegram_${messageId}.json`);
        const tmpFile = queueFile + ".tmp";
        fs.writeFileSync(tmpFile, JSON.stringify(queueData, null, 2));
        fs.renameSync(tmpFile, queueFile);

        pendingMessages.set(messageId, { ctx, chatId: ctx.chat.id, threadId });
        log(
            "INFO",
            `Queued message from ${ctx.from.first_name} in thread ${threadId}: ${ctx.message.text.substring(0, 80)}`,
        );
    },
);

// ─── Outgoing Queue Polling ───

async function pollOutgoingQueue(): Promise<void> {
    try {
        if (!fs.existsSync(QUEUE_OUTGOING)) return;

        const files = fs
            .readdirSync(QUEUE_OUTGOING)
            .filter((f) => f.endsWith(".json"));

        for (const file of files) {
            const filePath = path.join(QUEUE_OUTGOING, file);

            try {
                const data: OutgoingMessage = JSON.parse(fs.readFileSync(filePath, "utf8"));

                if (data.targetThreadId) {
                    // Cross-thread message: post to the target topic
                    const chatId = settings.telegram_chat_id;
                    const chunks = splitMessage(data.message);

                    for (const chunk of chunks) {
                        const sent = await bot.api.sendMessage(chatId, chunk, {
                            message_thread_id: data.targetThreadId,
                        });
                        if (data.model) {
                            storeMessageModel(sent.message_id, data.model);
                        }
                    }

                    log(
                        "INFO",
                        `Cross-thread message sent to thread ${data.targetThreadId} (${chunks.length} chunk(s))`,
                    );
                } else {
                    // Standard response: find the pending message and reply
                    const pending = pendingMessages.get(data.messageId);

                    if (pending) {
                        const chunks = splitMessage(data.message);

                        for (const chunk of chunks) {
                            const sent = await pending.ctx.reply(chunk, {
                                message_thread_id: pending.ctx.msg?.message_thread_id,
                            });
                            if (data.model) {
                                storeMessageModel(sent.message_id, data.model);
                            }
                        }

                        pendingMessages.delete(data.messageId);
                        log(
                            "INFO",
                            `Response sent to ${data.sender} in thread ${pending.threadId} (${chunks.length} chunk(s))`,
                        );
                    } else {
                        log(
                            "WARN",
                            `No pending message found for messageId ${data.messageId}, sending to chat directly`,
                        );

                        // Fallback: send to the configured chat
                        const chatId = settings.telegram_chat_id;
                        const chunks = splitMessage(data.message);

                        for (const chunk of chunks) {
                            const sent = await bot.api.sendMessage(chatId, chunk);
                            if (data.model) {
                                storeMessageModel(sent.message_id, data.model);
                            }
                        }
                    }
                }

                // Delete the queue file after processing
                fs.unlinkSync(filePath);
            } catch (err) {
                log("ERROR", `Failed to process outgoing file ${file}: ${toErrorMessage(err)}`);
            }
        }
    } catch (err) {
        log("ERROR", `Outgoing queue poll error: ${toErrorMessage(err)}`);
    }
}

// ─── Pending Message Cleanup ───

function cleanupPendingMessages(): void {
    const now = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutes

    for (const [messageId, pending] of pendingMessages) {
        const parts = messageId.split("_");
        const timestamp = parseInt(parts[0], 10);

        if (now - timestamp > timeout) {
            pendingMessages.delete(messageId);
            log("DEBUG", `Cleaned up stale pending message: ${messageId}`);
        }
    }
}

// ─── Error Handler ───

bot.catch((err) => {
    log("ERROR", `Bot error: ${err.message}`);
});

// ─── Graceful Shutdown ───

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());

// ─── Start ───

// Poll outgoing queue every 1 second
setInterval(pollOutgoingQueue, 1000);

// Clean up stale pending messages every 60 seconds
setInterval(cleanupPendingMessages, 60_000);

bot.start({ onStart: () => log("INFO", "TinyClaw Telegram bot started") });
