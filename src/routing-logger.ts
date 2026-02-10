/**
 * JSONL Logger for Routing Decisions
 *
 * Logs every routing decision for analysis.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { RoutingDecision, Tier } from "./router/types.js";

export type LogEntry = {
  ts: number;
  promptHash: string;
  tier: Tier;
  model: string;
  tokens: number;
  confidence: number;
  signals: string[];
};

/** Track which directories we have already ensured exist. */
const ensuredDirs = new Set<string>();

/**
 * Ensure a directory exists. Synchronous on first call per dir (cold start only),
 * then cached for all subsequent calls.
 */
function ensureDir(dirPath: string): void {
  if (ensuredDirs.has(dirPath)) return;
  if (!existsSync(dirPath)) {
    // Async mkdir for cold-start — fire-and-forget, cache after success
    mkdir(dirPath, { recursive: true, mode: 0o700 })
      .then(() => ensuredDirs.add(dirPath))
      .catch(() => {});
    return;
  }
  ensuredDirs.add(dirPath);
}

/**
 * Log a routing decision to JSONL file.
 * Uses async fire-and-forget I/O to avoid blocking the event loop.
 */
export function logDecision(
  decision: RoutingDecision,
  prompt: string,
  logPath: string,
): void {
  try {
    ensureDir(dirname(logPath));

    // Hash prompt for privacy (full SHA-256)
    const promptHash = createHash("sha256")
      .update(prompt)
      .digest("hex");

    const entry: LogEntry = {
      ts: Date.now(),
      promptHash,
      tier: decision.tier,
      model: decision.model,
      tokens: decision.estimatedTokens,
      confidence: Math.round(decision.confidence * 100) / 100,
      signals: decision.signals,
    };

    // Fire-and-forget async write — never blocks the event loop
    appendFile(logPath, JSON.stringify(entry) + "\n").catch(() => {});
  } catch {
    // Silently fail — logging shouldn't break routing
  }
}

/**
 * Expand ~ to home directory.
 * Returns unexpanded path if HOME is unset.
 */
export function expandPath(filePath: string): string {
  const home = process.env.HOME;
  if (home && (filePath === "~" || filePath.startsWith("~/"))) {
    return resolve(filePath.replace("~", home));
  }
  return resolve(filePath);
}
