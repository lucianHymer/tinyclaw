/**
 * JSONL Logger for Routing Decisions
 *
 * Logs every routing decision for analysis.
 * Uses sync I/O (appendFileSync) matching codebase convention.
 * Rotates at 10MB matching message-history.ts pattern.
 */

import fs from "fs";
import { createHash } from "crypto";
import type { RoutingDecision, Tier } from "./router/types.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export type LogEntry = {
  ts: number;
  promptHash: string;
  tier: Tier;
  model: string;
  tokens: number;
  confidence: number;
  signals: string[];
};

/**
 * Log a routing decision to JSONL file.
 * Uses sync I/O to ensure writes are durable. Rotates at 10MB.
 */
export function logDecision(
  decision: RoutingDecision,
  prompt: string,
  logPath: string,
): void {
  try {
    // Check file size and rotate if needed
    if (fs.existsSync(logPath)) {
      const stats = fs.statSync(logPath);
      if (stats.size > MAX_FILE_SIZE) {
        fs.renameSync(logPath, logPath.replace(".jsonl", ".1.jsonl"));
      }
    }

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

    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(logPath, line);
  } catch {
    // Silently fail — logging shouldn't break routing
  }
}
