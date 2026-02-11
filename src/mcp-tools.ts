/**
 * In-process MCP tools for cross-thread communication.
 * Uses the Agent SDK's createSdkMcpServer — runs in the queue processor process.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import {
    type DockerContainer,
    fetchDockerJson,
    formatBytes,
    getDevContainers,
    OS_RESERVE_BYTES,
    validateAndUpdateMemory,
} from "./docker-client.js";

const PROJECT_DIR = path.resolve(__dirname, "..");
const TINYCLAW_DIR = path.join(PROJECT_DIR, ".tinyclaw");
const THREADS_FILE = path.join(TINYCLAW_DIR, "threads.json");
const QUEUE_INCOMING = path.join(TINYCLAW_DIR, "queue/incoming");
const QUEUE_OUTGOING = path.join(TINYCLAW_DIR, "queue/outgoing");
const DOCKER_PROXY_URL = process.env.DOCKER_PROXY_URL || "http://docker-proxy:2375";
const PROC_BASE = fs.existsSync("/host/proc") ? "/host/proc" : "/proc";
const PROC_MEMINFO = path.join(PROC_BASE, "meminfo");

function parseMeminfo(): { totalBytes: number; availableBytes: number } {
    try {
        const content = fs.readFileSync(PROC_MEMINFO, "utf8");
        const get = (key: string): number => {
            const match = content.match(new RegExp(`${key}:\\s+(\\d+)`));
            return match ? parseInt(match[1], 10) * 1024 : 0; // kB -> bytes
        };
        return { totalBytes: get("MemTotal"), availableBytes: get("MemAvailable") };
    } catch {
        return { totalBytes: 0, availableBytes: 0 };
    }
}

function getHostTotalMemoryBytes(): number {
    return parseMeminfo().totalBytes;
}

let prevCpuIdle = 0;
let prevCpuTotal = 0;

function parseCpuPercent(): number {
    try {
        const content = fs.readFileSync(path.join(PROC_BASE, "stat"), "utf8");
        const line = content.split("\n").find(l => l.startsWith("cpu "));
        if (!line) return 0;
        const parts = line.split(/\s+/).slice(1).map(Number);
        const idle = parts[3] + (parts[4] || 0); // idle + iowait
        const total = parts.reduce((a, b) => a + b, 0);
        const diffIdle = idle - prevCpuIdle;
        const diffTotal = total - prevCpuTotal;
        prevCpuIdle = idle;
        prevCpuTotal = total;
        if (diffTotal === 0) return 0;
        return Math.round((1 - diffIdle / diffTotal) * 100);
    } catch {
        return 0;
    }
}

function getDiskUsage(): { totalGB: number; usedGB: number; availGB: number } {
    try {
        const stats = fs.statfsSync(TINYCLAW_DIR);
        const blockSize = stats.bsize;
        const totalGB = Math.round((stats.blocks * blockSize) / 1024 ** 3 * 10) / 10;
        const availGB = Math.round((stats.bavail * blockSize) / 1024 ** 3 * 10) / 10;
        return { totalGB, usedGB: Math.round((totalGB - availGB) * 10) / 10, availGB };
    } catch {
        return { totalGB: 0, usedGB: 0, availGB: 0 };
    }
}

function countQueueFiles(dir: string): number {
    try {
        return fs.readdirSync(dir).filter(f => f.endsWith(".json")).length;
    } catch {
        return 0;
    }
}

function readThreads(): Record<string, { name: string; cwd: string; isMaster?: boolean }> {
    return JSON.parse(fs.readFileSync(THREADS_FILE, "utf8"));
}

function textContent(text: string) {
    return { type: "text" as const, text };
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
                    content: [textContent("Cannot send a message to your own thread")],
                    isError: true,
                };
            }

            let threads: ReturnType<typeof readThreads>;
            try {
                threads = readThreads();
            } catch {
                return { content: [textContent("Could not read threads.json")], isError: true };
            }

            if (!threads[String(targetThreadId)]) {
                const available = Object.entries(threads).map(([id, t]) => `${id}: ${t.name}`).join(", ");
                return {
                    content: [textContent(`Thread ${targetThreadId} not found. Available: ${available}`)],
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
            return { content: [textContent(`Message sent to thread ${targetThreadId} (${targetName})`)] };
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
                return { content: [textContent(lines.join("\n"))] };
            } catch {
                return { content: [textContent("No threads.json found — no active threads")], isError: true };
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
                        content: [textContent("Master thread (thread 1) not found or has no cwd configured")],
                        isError: true,
                    };
                }
                const filePath = path.join(masterConfig.cwd, filename);
                const content = fs.readFileSync(filePath, "utf-8");
                return { content: [textContent(content)] };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [textContent(`Could not read knowledge base file "${filename}": ${msg}`)],
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
                const containers = await getDevContainers(DOCKER_PROXY_URL);

                if (containers.length === 0) {
                    return {
                        content: [textContent("No dev containers found (label: tinyclaw.type=dev-container)")],
                    };
                }

                const lines = containers.map(c => {
                    const usageMB = (c.memory.usage / (1024 * 1024)).toFixed(0);
                    const limitMB = (c.memory.limit / (1024 * 1024)).toFixed(0);
                    const pct = c.memory.limit > 0 ? ((c.memory.usage / c.memory.limit) * 100).toFixed(1) : "?";
                    const idle = c.idle ? " (idle)" : "";
                    return `${c.name}: ${c.status} | ${usageMB}MB / ${limitMB}MB (${pct}%) | ${c.cpus.toFixed(1)} CPUs | ${c.uptime}${idle}`;
                });

                return { content: [textContent(lines.join("\n"))] };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [textContent(`Failed to get container stats: ${msg}`)],
                    isError: true,
                };
            }
        },
    );

    const updateContainerMemory = tool(
        "update_container_memory",
        "Update memory limit for a dev container. Limit in bytes. Snaps to 64MB increments, validates total allocation against host capacity, and warns about OOM risks. Only works for containers with tinyclaw.type=dev-container label.",
        { containerName: z.string(), memoryLimitBytes: z.number() },
        async ({ containerName, memoryLimitBytes }) => {
            try {
                // Find container by name among dev containers
                const containers = await fetchDockerJson<DockerContainer[]>(
                    DOCKER_PROXY_URL,
                    `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: ["tinyclaw.type=dev-container"], name: [containerName] }))}`,
                );
                const match = containers.find(c =>
                    (c.Names[0] || "").replace(/^\//, "") === containerName,
                );

                if (!match) {
                    return {
                        content: [textContent(`Container "${containerName}" not found among dev containers`)],
                        isError: true,
                    };
                }

                // Validate and apply the update with full safety checks
                const hostTotal = getHostTotalMemoryBytes();
                const result = await validateAndUpdateMemory(
                    DOCKER_PROXY_URL,
                    match.Id,
                    memoryLimitBytes,
                    hostTotal,
                );

                const parts = [`Updated ${result.name} memory limit: ${formatBytes(result.oldLimit)} -> ${formatBytes(result.newLimit)}`];
                if (result.warning) {
                    parts.push(`WARNING: ${result.warning}`);
                }

                return { content: [textContent(parts.join("\n"))] };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [textContent(`Failed to update container memory: ${msg}`)],
                    isError: true,
                };
            }
        },
    );

    const getHostMemory = tool(
        "get_host_memory",
        "Get host machine memory information: total, available, OS reserve, and max allocatable for containers. Use this before making container memory allocation decisions.",
        {},
        async () => {
            try {
                const { totalBytes, availableBytes } = parseMeminfo();
                const maxAllocatable = totalBytes - OS_RESERVE_BYTES;

                const lines = [
                    `Total Memory:     ${formatBytes(totalBytes)} (${totalBytes} bytes)`,
                    `Available Memory: ${formatBytes(availableBytes)} (${availableBytes} bytes)`,
                    `OS Reserve:       ${formatBytes(OS_RESERVE_BYTES)} (${OS_RESERVE_BYTES} bytes)`,
                    `Max Allocatable:  ${formatBytes(maxAllocatable)} (${maxAllocatable} bytes)`,
                ];

                return { content: [textContent(lines.join("\n"))] };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [textContent(`Failed to read host memory: ${msg}`)],
                    isError: true,
                };
            }
        },
    );

    const getSystemStatus = tool(
        "get_system_status",
        "Get system status overview: CPU usage, RAM usage, disk usage, load averages, and message queue depths. Use this for infrastructure health monitoring.",
        {},
        async () => {
            try {
                const cpuPercent = parseCpuPercent();
                const { totalBytes, availableBytes } = parseMeminfo();
                const usedBytes = totalBytes - availableBytes;
                const disk = getDiskUsage();
                const loadAvg = os.loadavg();

                const queueIncoming = countQueueFiles(QUEUE_INCOMING);
                const queueOutgoing = countQueueFiles(QUEUE_OUTGOING);
                const queueProcessing = countQueueFiles(path.join(TINYCLAW_DIR, "queue/processing"));
                const queueDeadLetter = countQueueFiles(path.join(TINYCLAW_DIR, "queue/dead-letter"));

                const lines = [
                    `== CPU ==`,
                    `Usage: ${cpuPercent}%`,
                    ``,
                    `== Memory ==`,
                    `Used: ${formatBytes(usedBytes)} / ${formatBytes(totalBytes)} (${totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0}%)`,
                    `Available: ${formatBytes(availableBytes)}`,
                    ``,
                    `== Disk ==`,
                    `Used: ${disk.usedGB}GB / ${disk.totalGB}GB (available: ${disk.availGB}GB)`,
                    ``,
                    `== Load Averages ==`,
                    `1m: ${loadAvg[0].toFixed(2)}  5m: ${loadAvg[1].toFixed(2)}  15m: ${loadAvg[2].toFixed(2)}`,
                    ``,
                    `== Queue Depths ==`,
                    `Incoming:    ${queueIncoming}`,
                    `Outgoing:    ${queueOutgoing}`,
                    `Processing:  ${queueProcessing}`,
                    `Dead Letter: ${queueDeadLetter}`,
                ];

                return { content: [textContent(lines.join("\n"))] };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [textContent(`Failed to get system status: ${msg}`)],
                    isError: true,
                };
            }
        },
    );

    // Build tool list: base tools for all threads, container tools for master only
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous tool schemas require type erasure
    const tools: Array<ReturnType<typeof tool<any>>> = [sendMessage, listThreads, queryKnowledgeBase];
    if (sourceThreadId === 1) {
        tools.push(getContainerStats, updateContainerMemory, getHostMemory, getSystemStatus);
    }

    return createSdkMcpServer({
        name: "tinyclaw",
        version: "1.0.0",
        tools,
    });
}
