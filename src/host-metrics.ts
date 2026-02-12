/**
 * Shared host metrics — CPU, memory, disk, and queue-file helpers.
 * Single source of truth consumed by both dashboard.ts and mcp-tools.ts.
 */

import fs from "fs";
import path from "path";

// Read from /host/proc/* (bind-mounted in Docker) or fall back to /proc/*
export const PROC_BASE = fs.existsSync("/host/proc") ? "/host/proc" : "/proc";

export function parseMeminfo(): { totalBytes: number; availableBytes: number } {
    try {
        const content = fs.readFileSync(path.join(PROC_BASE, "meminfo"), "utf8");
        const get = (key: string): number => {
            const match = content.match(new RegExp(`${key}:\\s+(\\d+)`));
            return match ? parseInt(match[1], 10) * 1024 : 0; // kB -> bytes
        };
        return {
            totalBytes: get("MemTotal"),
            availableBytes: get("MemAvailable"),
        };
    } catch {
        return { totalBytes: 0, availableBytes: 0 };
    }
}

let prevCpuIdle = 0;
let prevCpuTotal = 0;

export function parseCpuPercent(): number {
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

export function getDiskUsage(dir: string): { totalGB: number; usedGB: number; availGB: number } {
    try {
        const stats = fs.statfsSync(dir);
        const blockSize = stats.bsize;
        const totalGB = Math.round((stats.blocks * blockSize) / 1024 ** 3 * 10) / 10;
        const availGB = Math.round((stats.bavail * blockSize) / 1024 ** 3 * 10) / 10;
        return { totalGB, usedGB: Math.round((totalGB - availGB) * 10) / 10, availGB };
    } catch {
        return { totalGB: 0, usedGB: 0, availGB: 0 };
    }
}

export function countQueueFiles(dir: string): number {
    try {
        return fs.readdirSync(dir).filter(f => f.endsWith(".json")).length;
    } catch {
        return 0;
    }
}
