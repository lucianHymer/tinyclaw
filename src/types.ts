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

// ─── Error Utility ───

/**
 * Safely extract an error message from an unknown thrown value.
 */
export function toErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    return String(err);
}
