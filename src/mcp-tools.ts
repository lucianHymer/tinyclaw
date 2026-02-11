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
const DOCKER_PROXY_URL = process.env.DOCKER_PROXY_URL || "http://docker-proxy:2375";

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

    const queryKnowledgeBase = tool(
        "query_knowledge_base",
        "Read a file from the master thread's knowledge base (context.md, decisions.md, active-projects.md)",
        { filename: z.enum(["context.md", "decisions.md", "active-projects.md"]) },
        async ({ filename }) => {
            try {
                const masterConfig = readThreads()["1"];
                if (!masterConfig?.cwd) {
                    return {
                        content: [{ type: "text" as const, text: "Master thread (thread 1) not found or has no cwd configured" }],
                        isError: true,
                    };
                }
                const filePath = path.join(masterConfig.cwd, filename);
                const content = fs.readFileSync(filePath, "utf-8");
                return { content: [{ type: "text" as const, text: content }] };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Could not read knowledge base file "${filename}": ${msg}` }],
                    isError: true,
                };
            }
        },
    );

    // ─── Master-only tools: container management ───

    const getContainerStats = tool(
        "get_container_stats",
        "Get memory usage stats for all running dev containers (tinyclaw.type=dev-container). Returns container names, memory usage, limits, CPU count, uptime, and idle status.",
        {},
        async () => {
            try {
                const resp = await fetch(
                    `${DOCKER_PROXY_URL}/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: ["tinyclaw.type=dev-container"] }))}`,
                );
                if (!resp.ok) {
                    return {
                        content: [{ type: "text" as const, text: `Docker API error: ${resp.status} ${resp.statusText}` }],
                        isError: true,
                    };
                }
                const containers = (await resp.json()) as Array<{
                    Id: string;
                    Names: string[];
                    State: string;
                }>;

                const lines: string[] = [];
                for (const c of containers) {
                    const name = (c.Names[0] || "").replace(/^\//, "");
                    let usage = 0;
                    let limit = 0;
                    let cpus = 0;
                    let pids = 0;

                    if (c.State === "running") {
                        try {
                            const statsResp = await fetch(
                                `${DOCKER_PROXY_URL}/containers/${c.Id}/stats?stream=false`,
                            );
                            if (statsResp.ok) {
                                const stats = (await statsResp.json()) as {
                                    memory_stats: { usage: number; limit: number };
                                    pids_stats: { current: number };
                                };
                                usage = stats.memory_stats?.usage || 0;
                                limit = stats.memory_stats?.limit || 0;
                                pids = stats.pids_stats?.current || 0;
                            }
                        } catch {
                            // stats unavailable
                        }
                        try {
                            const inspResp = await fetch(
                                `${DOCKER_PROXY_URL}/containers/${c.Id}/json`,
                            );
                            if (inspResp.ok) {
                                const inspect = (await inspResp.json()) as {
                                    HostConfig: { Memory: number; NanoCpus: number };
                                };
                                if (inspect.HostConfig.Memory) limit = inspect.HostConfig.Memory;
                                cpus = inspect.HostConfig.NanoCpus ? inspect.HostConfig.NanoCpus / 1e9 : 0;
                            }
                        } catch {
                            // inspect unavailable
                        }
                    }

                    const usageMB = (usage / (1024 * 1024)).toFixed(0);
                    const limitMB = (limit / (1024 * 1024)).toFixed(0);
                    const pct = limit > 0 ? ((usage / limit) * 100).toFixed(1) : "?";
                    const idle = pids <= 2 ? " (idle)" : "";

                    lines.push(
                        `${name}: ${c.State} | ${usageMB}MB / ${limitMB}MB (${pct}%) | ${cpus.toFixed(1)} CPUs | ${pids} procs${idle}`,
                    );
                }

                if (lines.length === 0) {
                    return {
                        content: [{ type: "text" as const, text: "No dev containers found (label: tinyclaw.type=dev-container)" }],
                    };
                }

                return { content: [{ type: "text" as const, text: lines.join("\n") }] };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Failed to get container stats: ${msg}` }],
                    isError: true,
                };
            }
        },
    );

    const updateContainerMemory = tool(
        "update_container_memory",
        "Update memory limit for a dev container. Limit in bytes. Also sets MemorySwap to match. Only works for containers with tinyclaw.type=dev-container label.",
        { containerName: z.string(), memoryLimitBytes: z.number() },
        async ({ containerName, memoryLimitBytes }) => {
            try {
                const MIN_LIMIT = 256 * 1024 * 1024; // 256MB
                if (memoryLimitBytes < MIN_LIMIT) {
                    return {
                        content: [{ type: "text" as const, text: `Limit too low. Minimum is ${MIN_LIMIT} bytes (256MB).` }],
                        isError: true,
                    };
                }

                // Find container by name
                const listResp = await fetch(
                    `${DOCKER_PROXY_URL}/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: ["tinyclaw.type=dev-container"], name: [containerName] }))}`,
                );
                if (!listResp.ok) {
                    return {
                        content: [{ type: "text" as const, text: `Docker API error listing containers: ${listResp.status}` }],
                        isError: true,
                    };
                }

                const matches = (await listResp.json()) as Array<{ Id: string; Names: string[] }>;
                const match = matches.find(c =>
                    (c.Names[0] || "").replace(/^\//, "") === containerName,
                );

                if (!match) {
                    return {
                        content: [{ type: "text" as const, text: `Container "${containerName}" not found among dev containers` }],
                        isError: true,
                    };
                }

                // Apply the update
                const updateResp = await fetch(
                    `${DOCKER_PROXY_URL}/containers/${match.Id}/update`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            Memory: memoryLimitBytes,
                            MemorySwap: memoryLimitBytes,
                        }),
                    },
                );

                if (!updateResp.ok) {
                    const errText = await updateResp.text().catch(() => "");
                    return {
                        content: [{ type: "text" as const, text: `Docker update failed: ${updateResp.status} ${errText}` }],
                        isError: true,
                    };
                }

                const limitMB = (memoryLimitBytes / (1024 * 1024)).toFixed(0);
                return {
                    content: [{ type: "text" as const, text: `Updated ${containerName} memory limit to ${limitMB}MB (${memoryLimitBytes} bytes)` }],
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `Failed to update container memory: ${msg}` }],
                    isError: true,
                };
            }
        },
    );

    // Build tool list: base tools for all threads, container tools for master only
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: Array<ReturnType<typeof tool<any>>> = [sendMessage, listThreads, queryKnowledgeBase];
    if (sourceThreadId === 1) {
        tools.push(getContainerStats, updateContainerMemory);
    }

    return createSdkMcpServer({
        name: "tinyclaw",
        version: "1.0.0",
        tools,
    });
}
