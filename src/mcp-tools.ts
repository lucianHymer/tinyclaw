/**
 * In-process MCP tools for cross-thread communication.
 * Uses the Agent SDK's createSdkMcpServer — runs in the queue processor process.
 */

import fs from "fs";
import path from "path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

const PROJECT_DIR = path.resolve(__dirname, "..");
const TINYCLAW_DIR = path.join(PROJECT_DIR, ".tinyclaw");
const THREADS_FILE = path.join(TINYCLAW_DIR, "threads.json");
const QUEUE_INCOMING = path.join(TINYCLAW_DIR, "queue/incoming");
const QUEUE_OUTGOING = path.join(TINYCLAW_DIR, "queue/outgoing");

function readThreads(): Record<string, { name: string; cwd: string; isMaster?: boolean }> {
    return JSON.parse(fs.readFileSync(THREADS_FILE, "utf8"));
}

/**
 * Create an MCP server bound to a specific source thread.
 * Each query gets its own instance so cross-thread messages carry the correct sourceThreadId.
 */
export function createTinyClawMcpServer(sourceThreadId: number) {
    const sendMessage = tool(
        "send_message",
        "Send a message to another TinyClaw thread (Telegram forum topic). The message will appear in that thread and be processed by its agent.",
        { targetThreadId: z.number(), message: z.string() },
        async ({ targetThreadId, message }) => {
            if (targetThreadId === sourceThreadId) {
                return {
                    content: [{ type: "text" as const, text: "Cannot send a message to your own thread" }],
                    isError: true,
                };
            }

            let threads: Record<string, any>;
            try {
                threads = readThreads();
            } catch {
                return { content: [{ type: "text" as const, text: "Could not read threads.json" }], isError: true };
            }

            if (!threads[String(targetThreadId)]) {
                const available = Object.entries(threads).map(([id, t]) => `${id}: ${t.name}`).join(", ");
                return {
                    content: [{ type: "text" as const, text: `Thread ${targetThreadId} not found. Available: ${available}` }],
                    isError: true,
                };
            }

            const ts = Date.now();
            const id = `cross_${ts}_${Math.random().toString(36).slice(2, 6)}`;
            const sourceName = threads[String(sourceThreadId)]?.name ?? `Thread ${sourceThreadId}`;

            // Write to incoming queue so the target agent processes it
            const incoming = {
                channel: "telegram",
                source: "cross-thread",
                threadId: targetThreadId,
                sourceThreadId,
                sender: sourceName,
                message,
                timestamp: ts,
                messageId: id,
            };

            fs.mkdirSync(QUEUE_INCOMING, { recursive: true });
            const inTmp = path.join(QUEUE_INCOMING, `${id}.json.tmp`);
            const inFinal = path.join(QUEUE_INCOMING, `${id}.json`);
            fs.writeFileSync(inTmp, JSON.stringify(incoming));
            fs.renameSync(inTmp, inFinal);

            // Write to outgoing queue so it appears in the Telegram topic
            const outgoing = {
                channel: "telegram",
                targetThreadId,
                sender: sourceName,
                message,
                originalMessage: "",
                timestamp: ts,
                messageId: `${id}_tg`,
                model: "",
            };

            fs.mkdirSync(QUEUE_OUTGOING, { recursive: true });
            const outTmp = path.join(QUEUE_OUTGOING, `${id}_tg.json.tmp`);
            const outFinal = path.join(QUEUE_OUTGOING, `${id}_tg.json`);
            fs.writeFileSync(outTmp, JSON.stringify(outgoing));
            fs.renameSync(outTmp, outFinal);

            const targetName = threads[String(targetThreadId)].name;
            return { content: [{ type: "text" as const, text: `Message sent to thread ${targetThreadId} (${targetName})` }] };
        },
    );

    const listThreads = tool(
        "list_threads",
        "List all active TinyClaw threads (Telegram forum topics) with their IDs and names.",
        {},
        async () => {
            try {
                const threads = readThreads();
                const lines = Object.entries(threads).map(([id, t]) => {
                    const parts = [`Thread ${id}: ${t.name}`];
                    if (t.isMaster) parts.push("(master)");
                    if (t.cwd) parts.push(`cwd=${t.cwd}`);
                    if (Number(id) === sourceThreadId) parts.push("(you)");
                    return parts.join(" ");
                });
                return { content: [{ type: "text" as const, text: lines.join("\n") }] };
            } catch {
                return { content: [{ type: "text" as const, text: "No threads.json found — no active threads" }], isError: true };
            }
        },
    );

    return createSdkMcpServer({
        name: "tinyclaw",
        version: "1.0.0",
        tools: [sendMessage, listThreads],
    });
}
