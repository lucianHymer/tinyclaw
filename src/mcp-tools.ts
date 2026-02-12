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
    listDevContainers,
    findNextAvailablePort,
    parseDevName,
    resolveUniqueName,
    findContainerByName,
    createDevContainer as createDevContainerFn,
    startContainer,
    stopDevContainer,
    deleteDevContainer,
    formatSSHConfig,
} from "./docker-client.js";
import { parseMeminfo, parseCpuPercent, getDiskUsage, countQueueFiles } from "./host-metrics.js";
import { loadThreads } from "./session-manager.js";
import { toErrorMessage, parseSSHPublicKey, parseDevEmail } from "./types.js";

const PROJECT_DIR = path.resolve(__dirname, "..");
const TINYCLAW_DIR = path.join(PROJECT_DIR, ".tinyclaw");
const QUEUE_INCOMING = path.join(TINYCLAW_DIR, "queue/incoming");
const QUEUE_OUTGOING = path.join(TINYCLAW_DIR, "queue/outgoing");
const DOCKER_PROXY_URL = process.env.DOCKER_PROXY_URL || "http://docker-proxy:2375";
const DASHBOARD_HOST = process.env.DASHBOARD_HOST || "localhost";
const DEV_NETWORK = process.env.DEV_NETWORK || "tinyclaw_dev";

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

            let threads: ReturnType<typeof loadThreads>;
            try {
                threads = loadThreads();
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
                const threads = loadThreads();
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
                const masterConfig = loadThreads()["1"];
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
                const msg = toErrorMessage(err);
                return {
                    content: [textContent(`Could not read knowledge base file "${filename}": ${msg}`)],
                    isError: true,
                };
            }
        },
    );

    // ─── Container & system tools (read-only ones available to all threads) ───

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
                    const parts: string[] = [c.name + ":"];
                    parts.push(c.status);
                    if (c.sshPort) parts.push(`| port ${c.sshPort}`);
                    if (c.status === "running") {
                        const usageMB = (c.memory.usage / (1024 * 1024)).toFixed(0);
                        const limitMB = (c.memory.limit / (1024 * 1024)).toFixed(0);
                        const pct = c.memory.limit > 0 ? ((c.memory.usage / c.memory.limit) * 100).toFixed(1) : "?";
                        parts.push(`| ${usageMB}MB / ${limitMB}MB (${pct}%)`);
                    } else {
                        const limitMB = (c.memory.limit / (1024 * 1024)).toFixed(0);
                        parts.push(`| ${limitMB}MB allocated`);
                    }
                    parts.push(`| ${c.cpus.toFixed(1)} CPUs`);
                    if (c.status === "running") {
                        parts.push(`| ${c.uptime}`);
                        if (c.idle) parts.push("(idle)");
                    }
                    return parts.join(" ");
                });

                return { content: [textContent(lines.join("\n"))] };
            } catch (err) {
                const msg = toErrorMessage(err);
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
                const hostTotal = parseMeminfo().totalBytes;
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
                const msg = toErrorMessage(err);
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
                const msg = toErrorMessage(err);
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
                const disk = getDiskUsage(TINYCLAW_DIR);
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
                const msg = toErrorMessage(err);
                return {
                    content: [textContent(`Failed to get system status: ${msg}`)],
                    isError: true,
                };
            }
        },
    );

    // ─── Container Lifecycle Tools (master-only) ───

    const createDevContainerTool = tool(
        "create_dev_container",
        "Create a new dev container for a developer. Accepts name (lowercase alphanumeric, e.g. 'alice'), email, and SSH public key (paste the full key starting with ssh-ed25519 or ssh-rsa). Auto-assigns an SSH port from 2201-2299 and a unique container name (dev-alice). Returns SSH config snippet the developer can paste into ~/.ssh/config. The container gets 2GB RAM, 2 CPUs, and credential broker access. If the name is taken, a suffix is auto-incremented (dev-alice-2). IMPORTANT: Always confirm the developer's details before calling this tool.",
        {
            name: z.string().describe("Developer name (lowercase, alphanumeric + hyphens)"),
            email: z.string().describe("Developer email (for git config — must match their GitHub account for commit attribution)"),
            sshPublicKey: z.string().describe("SSH public key (ed25519, RSA, or ECDSA)"),
        },
        async ({ name, email, sshPublicKey }) => {
            try {
                const parsedName = parseDevName(name);
                const parsedEmail = parseDevEmail(email);
                const parsedKey = parseSSHPublicKey(sshPublicKey);

                const containers = await listDevContainers(DOCKER_PROXY_URL);
                const port = findNextAvailablePort(containers);
                const containerName = resolveUniqueName(containers, parsedName);

                const result = await createDevContainerFn(
                    { name: containerName, email: parsedEmail, sshPublicKey: parsedKey },
                    { port, networkName: DEV_NETWORK, dashboardHost: DASHBOARD_HOST, dockerBaseUrl: DOCKER_PROXY_URL },
                );

                // Two-phase error handling: distinguish create-failed from start-failed
                try {
                    await startContainer(DOCKER_PROXY_URL, result.containerId);
                } catch (startErr) {
                    return {
                        content: [textContent(
                            `Container ${result.name} created but failed to start: ${toErrorMessage(startErr)}. ` +
                            `Use start_dev_container to retry.`,
                        )],
                        isError: true,
                    };
                }

                const keyType = sshPublicKey.trim().split(/\s+/)[0];
                const sshConfig = formatSSHConfig(result, keyType);
                return {
                    content: [textContent(
                        `Container ${result.name} created and running on port ${result.port}.\n\nSSH config:\n\`\`\`\n${sshConfig}\n\`\`\``,
                    )],
                };
            } catch (err) {
                return {
                    content: [textContent(`Failed to create container: ${toErrorMessage(err)}`)],
                    isError: true,
                };
            }
        },
    );

    const stopDevContainerTool = tool(
        "stop_dev_container",
        "Stop a running dev container by name (e.g., 'dev-alice'). This is reversible — use start_dev_container to restart it. The container's data and port assignment are preserved. Use this for idle containers to free resources.",
        {
            name: z.string().describe("Container name (e.g., 'dev-alice')"),
        },
        async ({ name }) => {
            try {
                const container = await findContainerByName(DOCKER_PROXY_URL, name);
                await stopDevContainer(DOCKER_PROXY_URL, container.Id);
                return { content: [textContent(`Stopped ${name}.`)] };
            } catch (err) {
                return {
                    content: [textContent(`Failed: ${toErrorMessage(err)}`)],
                    isError: true,
                };
            }
        },
    );

    const startDevContainerTool = tool(
        "start_dev_container",
        "Start a stopped dev container by name (e.g., 'dev-alice'). The container resumes with its existing data and port assignment. SSH access becomes available after a few seconds.",
        {
            name: z.string().describe("Container name (e.g., 'dev-alice')"),
        },
        async ({ name }) => {
            try {
                const container = await findContainerByName(DOCKER_PROXY_URL, name);
                await startContainer(DOCKER_PROXY_URL, container.Id);
                return { content: [textContent(`Started ${name}.`)] };
            } catch (err) {
                return {
                    content: [textContent(`Failed: ${toErrorMessage(err)}`)],
                    isError: true,
                };
            }
        },
    );

    const deleteDevContainerTool = tool(
        "delete_dev_container",
        "Permanently delete a dev container by name (e.g., 'dev-alice'). This is IRREVERSIBLE — all data inside the container is lost and the port is freed. Stops the container first if running. Only works on containers with the tinyclaw.type=dev-container label. IMPORTANT: Always confirm with the user before calling this tool.",
        {
            name: z.string().describe("Container name (e.g., 'dev-alice')"),
        },
        async ({ name }) => {
            try {
                const container = await findContainerByName(DOCKER_PROXY_URL, name);
                await deleteDevContainer(DOCKER_PROXY_URL, container.Id);
                const portInfo = container.port ? ` Port ${container.port} is now available.` : "";
                return { content: [textContent(`Deleted ${name}.${portInfo}`)] };
            } catch (err) {
                return {
                    content: [textContent(`Failed: ${toErrorMessage(err)}`)],
                    isError: true,
                };
            }
        },
    );

    // Build tool list: base tools + read-only monitoring for all threads, mutating tools for master only
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous tool schemas require type erasure
    const tools: Array<ReturnType<typeof tool<any>>> = [
        sendMessage, listThreads, queryKnowledgeBase,
        getContainerStats, getSystemStatus,
    ];
    if (sourceThreadId === 1) {
        tools.push(
            updateContainerMemory, getHostMemory,
            createDevContainerTool, stopDevContainerTool, startDevContainerTool, deleteDevContainerTool,
        );
    }

    return createSdkMcpServer({
        name: "tinyclaw",
        version: "1.0.0",
        tools,
    });
}
