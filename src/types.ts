/**
 * Shared types and utilities used across TinyClaw modules.
 */

import type { MessageSource } from "./message-history.js";

// ─── Queue Message Types ───

export interface IncomingMessage {
    channel: string;
    source?: MessageSource;
    threadId: number;
    sourceThreadId?: number;
    sender: string;
    senderId?: string;
    message: string;
    isReply?: boolean;
    replyToText?: string;
    replyToModel?: string;
    topicName?: string;
    timestamp: number;
    messageId: string;
}

export interface OutgoingMessage {
    channel: string;
    threadId: number;
    sender: string;
    message: string;
    originalMessage: string;
    timestamp: number;
    messageId: string;
    model: string;
    targetThreadId?: number;
}

// ─── Validation Utilities ───

/**
 * Validate that a sessionId is a well-formed UUID (hex + hyphens, 36 chars).
 * Session IDs from the Claude SDK are UUIDs; anything else is suspicious.
 */
export function isValidSessionId(sessionId: string): boolean {
    return /^[a-f0-9-]{36}$/.test(sessionId);
}

// ─── Error Utility ───

/**
 * Error subclass for user-facing validation failures (e.g., invalid input).
 * Handlers can use `instanceof ValidationError` to distinguish client errors (400)
 * from upstream/infrastructure errors (502) without string matching.
 */
export class ValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ValidationError";
    }
}

/**
 * Safely extract an error message from an unknown thrown value.
 */
export function toErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    return String(err);
}
