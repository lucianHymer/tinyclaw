/**
 * Dashboard - Real-time monitoring server for TinyClaw
 * Serves a single HTML page with 7 views and provides API + SSE endpoints.
 */

import express from "express";
import fs from "fs";
import path from "path";
import http from "http";

const SCRIPT_DIR = path.resolve(__dirname, "..");
const TINYCLAW_DIR = path.join(SCRIPT_DIR, ".tinyclaw");
const STATIC_DIR = path.join(SCRIPT_DIR, "static");
const SESSIONS_DIR = path.join(TINYCLAW_DIR, "sessions");
const PORT = parseInt(process.env.DASHBOARD_PORT || "3100", 10);

// ─── JSONL Readers ───

interface TailState {
    offset: number;
}

// Read the last N entries from a JSONL file (read from end)
function readRecentJsonl<T = unknown>(filePath: string, n: number): T[] {
    if (!fs.existsSync(filePath)) return [];
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return [];

    const TAIL_BYTES = Math.min(256 * 1024, stat.size); // 256KB max
    const fd = fs.openSync(filePath, "r");
    try {
        const buf = Buffer.alloc(TAIL_BYTES);
        const readStart = Math.max(0, stat.size - TAIL_BYTES);
        fs.readSync(fd, buf, 0, TAIL_BYTES, readStart);
        const content = buf.toString("utf8");
        const lines = content.split("\n").filter(l => l.trim());
        // Skip first line if we started mid-file (likely truncated)
        if (readStart > 0 && lines.length > 0) lines.shift();

        const entries: T[] = [];
        for (const line of lines) {
            try {
                entries.push(JSON.parse(line) as T);
            } catch {
                /* skip malformed */
            }
        }
        return entries.slice(-n);
    } finally {
        fs.closeSync(fd);
    }
}

// ─── Host Metrics Parsers ───
// Read from /host/proc/* (bind-mounted in Docker) or fall back to /proc/*

const PROC_BASE = fs.existsSync("/host/proc") ? "/host/proc" : "/proc";

function parseMeminfo(): { totalMB: number; usedMB: number; availableMB: number } {
    try {
        const content = fs.readFileSync(path.join(PROC_BASE, "meminfo"), "utf8");
        const get = (key: string): number => {
            const match = content.match(new RegExp(`${key}:\\s+(\\d+)`));
            return match ? parseInt(match[1], 10) / 1024 : 0; // kB -> MB
        };
        const total = get("MemTotal");
        const available = get("MemAvailable");
        return {
            totalMB: Math.round(total),
            usedMB: Math.round(total - available),
            availableMB: Math.round(available),
        };
    } catch {
        return { totalMB: 0, usedMB: 0, availableMB: 0 };
    }
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

function parseLoadAvg(): { load1: number; load5: number; load15: number } {
    try {
        const content = fs.readFileSync(path.join(PROC_BASE, "loadavg"), "utf8");
        const parts = content.split(/\s+/);
        return {
            load1: parseFloat(parts[0]),
            load5: parseFloat(parts[1]),
            load15: parseFloat(parts[2]),
        };
    } catch {
        return { load1: 0, load5: 0, load15: 0 };
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

// ─── Helpers ───

function countFiles(dir: string): number {
    try {
        return fs.readdirSync(dir).filter(f => f.endsWith(".json")).length;
    } catch {
        return 0;
    }
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
    } catch {
        return fallback;
    }
}

// ─── Per-client SSE tail reader ───
// Each SSE client gets its own offset tracking so multiple dashboard
// clients don't interfere with each other.

function readNewBytes(filePath: string, state: TailState): string | null {
    if (!fs.existsSync(filePath)) return null;
    const newStat = fs.statSync(filePath);
    // Detect rotation
    if (newStat.size < state.offset) state.offset = 0;
    // Nothing new
    if (newStat.size === state.offset) return null;

    const fd = fs.openSync(filePath, "r");
    try {
        const bytesToRead = newStat.size - state.offset;
        const buf = Buffer.alloc(bytesToRead);
        fs.readSync(fd, buf, 0, bytesToRead, state.offset);
        state.offset = newStat.size;
        return buf.toString("utf8");
    } finally {
        fs.closeSync(fd);
    }
}

// ─── Express App ───

const app = express();

// Serve static files
app.use("/static", express.static(STATIC_DIR));

// GET / — serves the dashboard HTML
app.get("/", (_req, res) => {
    const htmlPath = path.join(STATIC_DIR, "dashboard.html");
    if (fs.existsSync(htmlPath)) {
        res.sendFile(htmlPath);
    } else {
        res.status(404).send("Dashboard HTML not found. Place static/dashboard.html.");
    }
});

// GET /health
app.get("/health", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
});

// GET /api/status — service health, queue depth, thread summary, host metrics
app.get("/api/status", (_req, res) => {
    const threads = readJsonSafe<Record<string, unknown>>(
        path.join(TINYCLAW_DIR, "threads.json"),
        {},
    );
    const queueIncoming = countFiles(path.join(TINYCLAW_DIR, "queue/incoming"));
    const queueProcessing = countFiles(path.join(TINYCLAW_DIR, "queue/processing"));
    const queueDeadLetter = countFiles(path.join(TINYCLAW_DIR, "queue/dead-letter"));
    const mem = parseMeminfo();
    const cpu = parseCpuPercent();
    const load = parseLoadAvg();
    const disk = getDiskUsage();

    res.json({
        status: "ok",
        timestamp: Date.now(),
        queue: {
            incoming: queueIncoming,
            processing: queueProcessing,
            deadLetter: queueDeadLetter,
        },
        threads: Object.entries(threads).map(([id, cfg]) => ({
            id,
            ...(cfg as Record<string, unknown>),
        })),
        threadCount: Object.keys(threads).length,
        metrics: { cpu, mem, load, disk },
    });
});

// GET /api/threads — full threads.json
app.get("/api/threads", (_req, res) => {
    const threads = readJsonSafe(path.join(TINYCLAW_DIR, "threads.json"), {});
    res.json(threads);
});

// GET /api/threads/:id/messages — message history filtered by threadId
app.get("/api/threads/:id/messages", (req, res) => {
    const threadId = parseInt(req.params.id, 10);
    const limit = parseInt((req.query as Record<string, string>).n || "50", 10);
    const entries = readRecentJsonl<Record<string, unknown>>(
        path.join(TINYCLAW_DIR, "message-history.jsonl"),
        500,
    );
    const filtered = entries.filter(e => e.threadId === threadId).slice(-limit);
    res.json(filtered);
});

// GET /api/messages/recent?n=50 — recent messages across all threads
app.get("/api/messages/recent", (req, res) => {
    const n = parseInt((req.query as Record<string, string>).n || "50", 10);
    const entries = readRecentJsonl(path.join(TINYCLAW_DIR, "message-history.jsonl"), n);
    res.json(entries);
});

// GET /api/messages/feed — SSE stream of new messages
app.get("/api/messages/feed", (_req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    res.write(":\n\n"); // SSE comment to establish connection

    const historyFile = path.join(TINYCLAW_DIR, "message-history.jsonl");
    const clientState: TailState = { offset: 0 };

    // Initialize to current EOF so we only send new messages
    if (fs.existsSync(historyFile)) {
        const stat = fs.statSync(historyFile);
        clientState.offset = stat.size;
    }

    const interval = setInterval(() => {
        const content = readNewBytes(historyFile, clientState);
        if (content === null) return;

        const lines = content.split("\n").filter(l => l.trim());
        for (const line of lines) {
            try {
                JSON.parse(line); // validate JSON
                res.write(`data: ${line}\n\n`);
            } catch {
                /* skip malformed */
            }
        }
    }, 2000);

    _req.on("close", () => {
        clearInterval(interval);
    });
});

// GET /api/routing/feed — SSE stream of routing decisions
app.get("/api/routing/feed", (_req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    res.write(":\n\n");

    const routingFile = path.join(TINYCLAW_DIR, "logs/routing.jsonl");
    const clientState: TailState = { offset: 0 };

    if (fs.existsSync(routingFile)) {
        const stat = fs.statSync(routingFile);
        clientState.offset = stat.size;
    }

    const interval = setInterval(() => {
        const content = readNewBytes(routingFile, clientState);
        if (content === null) return;

        const lines = content.split("\n").filter(l => l.trim());
        for (const line of lines) {
            try {
                JSON.parse(line); // validate
                res.write(`data: ${line}\n\n`);
            } catch {
                /* skip malformed */
            }
        }
    }, 2000);

    _req.on("close", () => {
        clearInterval(interval);
    });
});

// GET /api/routing/recent?n=50
app.get("/api/routing/recent", (req, res) => {
    const n = parseInt((req.query as Record<string, string>).n || "50", 10);
    const entries = readRecentJsonl(path.join(TINYCLAW_DIR, "logs/routing.jsonl"), n);
    res.json(entries);
});

// GET /api/prompts/recent?n=20
app.get("/api/prompts/recent", (req, res) => {
    const n = parseInt((req.query as Record<string, string>).n || "20", 10);
    const entries = readRecentJsonl(path.join(TINYCLAW_DIR, "logs/prompts.jsonl"), n);
    res.json(entries);
});

// GET /api/metrics — CPU, RAM, disk, load
app.get("/api/metrics", (_req, res) => {
    res.json({
        cpu: parseCpuPercent(),
        mem: parseMeminfo(),
        load: parseLoadAvg(),
        disk: getDiskUsage(),
        timestamp: Date.now(),
    });
});

// ─── Session Log Helpers ───

function findSessionLogFile(sessionId: string): string | null {
    const logFile = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
    if (fs.existsSync(logFile)) return logFile;
    return null;
}

function tailLines(filePath: string, n: number): string[] {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return [];

    const TAIL_BYTES = Math.min(128 * 1024, stat.size);
    const fd = fs.openSync(filePath, "r");
    try {
        const buf = Buffer.alloc(TAIL_BYTES);
        fs.readSync(fd, buf, 0, TAIL_BYTES, Math.max(0, stat.size - TAIL_BYTES));
        const content = buf.toString("utf8");
        const lines = content.split("\n").filter(l => l.trim());
        return lines.slice(-n);
    } finally {
        fs.closeSync(fd);
    }
}

// GET /api/threads/:id/session-logs?n=20 — tail of Claude SDK session log
app.get("/api/threads/:id/session-logs", (req, res) => {
    const threadId = req.params.id;
    const n = Math.min(parseInt((req.query as Record<string, string>).n || "20", 10), 200);

    const threads = readJsonSafe<Record<string, { sessionId?: string; cwd?: string }>>(
        path.join(TINYCLAW_DIR, "threads.json"),
        {},
    );

    const threadConfig = threads[threadId];
    if (!threadConfig?.sessionId) {
        res.json({ lines: [], error: "No active session" });
        return;
    }

    const logFile = findSessionLogFile(threadConfig.sessionId);
    if (!logFile) {
        res.json({ lines: [], error: "Log file not found", sessionId: threadConfig.sessionId });
        return;
    }

    const lines = tailLines(logFile, n);
    res.json({ lines, sessionId: threadConfig.sessionId, logFile });
});

// GET /api/session-logs?n=20 — all active threads' session log tails
app.get("/api/session-logs", (req, res) => {
    const n = Math.min(parseInt((req.query as Record<string, string>).n || "20", 10), 200);

    const threads = readJsonSafe<Record<string, { sessionId?: string; name?: string }>>(
        path.join(TINYCLAW_DIR, "threads.json"),
        {},
    );

    const results: Record<string, { name: string; lines: string[]; sessionId: string }> = {};

    for (const [threadId, config] of Object.entries(threads)) {
        if (!config.sessionId) continue;

        const logFile = findSessionLogFile(config.sessionId);
        if (logFile) {
            results[threadId] = {
                name: config.name || `Thread ${threadId}`,
                lines: tailLines(logFile, n),
                sessionId: config.sessionId,
            };
        }
    }

    res.json(results);
});

// GET /api/logs/:type — SSE stream of log files (telegram | queue)
app.get("/api/logs/:type", (req, res) => {
    const type = req.params.type;
    const logFile =
        type === "telegram"
            ? path.join(TINYCLAW_DIR, "logs/telegram.log")
            : path.join(TINYCLAW_DIR, "logs/queue.log");

    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    res.write(":\n\n");

    const clientState: TailState = { offset: 0 };

    if (fs.existsSync(logFile)) {
        const stat = fs.statSync(logFile);
        // Start from last 4KB to show some initial context
        clientState.offset = Math.max(0, stat.size - 4096);
    }

    const interval = setInterval(() => {
        const content = readNewBytes(logFile, clientState);
        if (content === null) return;

        const lines = content.split("\n").filter(l => l.trim());
        for (const line of lines) {
            res.write(`data: ${JSON.stringify(line)}\n\n`);
        }
    }, 2000);

    req.on("close", () => {
        clearInterval(interval);
    });
});

// ─── Start Server ───

const server = http.createServer(app);

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Dashboard listening on http://0.0.0.0:${PORT}`);
    console.log(`Monitoring: ${TINYCLAW_DIR}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
    console.log("Dashboard shutting down...");
    server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
    console.log("Dashboard shutting down...");
    server.close(() => process.exit(0));
});
