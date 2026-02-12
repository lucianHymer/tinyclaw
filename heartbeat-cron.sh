#!/bin/bash
# Heartbeat Cron - Sends heartbeat messages to all active threads via queue system
# Note: -e is intentionally omitted — the infinite loop must survive individual failures.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/.tinyclaw/logs/heartbeat.log"
QUEUE_INCOMING="$SCRIPT_DIR/.tinyclaw/queue/incoming"
SETTINGS_FILE="$SCRIPT_DIR/.tinyclaw/settings.json"
THREADS_FILE="$SCRIPT_DIR/.tinyclaw/threads.json"

# Read interval from settings.json, default to 500
if [ -f "$SETTINGS_FILE" ]; then
    INTERVAL=$(grep -o '"heartbeat_interval"[[:space:]]*:[[:space:]]*[0-9]*' "$SETTINGS_FILE" | grep -o '[0-9]*$')
fi
INTERVAL=${INTERVAL:-500}

HEARTBEAT_PROMPT="Read HEARTBEAT.md if it exists. Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK."

mkdir -p "$QUEUE_INCOMING"
mkdir -p "$(dirname "$LOG_FILE")"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

log "Heartbeat cron started (interval: ${INTERVAL}s)"

while true; do
    sleep "$INTERVAL"

    log "Heartbeat cycle starting..."

    # Check if threads.json exists
    if [ ! -f "$THREADS_FILE" ]; then
        log "No threads.json found at $THREADS_FILE, skipping cycle"
        continue
    fi

    # Check if jq is available
    if ! command -v jq &> /dev/null; then
        log "ERROR: jq is required but not installed"
        continue
    fi

    # Iterate all active threads from threads.json
    THREAD_IDS=$(jq -r 'keys[]' "$THREADS_FILE" 2>/dev/null)

    if [ -z "$THREAD_IDS" ]; then
        log "No active threads found, skipping cycle"
        continue
    fi

    THREAD_COUNT=$(echo "$THREAD_IDS" | wc -w)
    STAGGER_SLEEP=$(( (INTERVAL / THREAD_COUNT) > 0 ? (INTERVAL / THREAD_COUNT) : 1 ))
    EPOCH_MS=$(date +%s)000

    CURRENT_THREAD=0
    for THREAD_ID in $THREAD_IDS; do
        if ! [[ "$THREAD_ID" =~ ^[0-9]+$ ]]; then
            log "WARN" "Skipping non-numeric thread ID: $THREAD_ID"
            continue
        fi

        MESSAGE_ID="heartbeat_${THREAD_ID}_$(date +%s)_$$"

        jq -n \
          --arg channel "heartbeat" \
          --arg source "heartbeat" \
          --argjson threadId "$THREAD_ID" \
          --arg sender "system" \
          --arg senderId "heartbeat" \
          --arg message "$HEARTBEAT_PROMPT" \
          --argjson isReply false \
          --argjson timestamp "$EPOCH_MS" \
          --arg messageId "$MESSAGE_ID" \
          '{channel: $channel, source: $source, threadId: $threadId, sender: $sender, senderId: $senderId, message: $message, isReply: $isReply, timestamp: $timestamp, messageId: $messageId}' \
          > "$QUEUE_INCOMING/${MESSAGE_ID}.json.tmp"
        mv "$QUEUE_INCOMING/${MESSAGE_ID}.json.tmp" "$QUEUE_INCOMING/${MESSAGE_ID}.json"

        log "Heartbeat queued for thread $THREAD_ID: $MESSAGE_ID"
        CURRENT_THREAD=$((CURRENT_THREAD + 1))

        # Stagger: sleep between thread iterations to prevent queue flooding
        if [ "$CURRENT_THREAD" -lt "$THREAD_COUNT" ]; then
            log "Stagger: sleeping ${STAGGER_SLEEP}s before next thread"
            sleep "$STAGGER_SLEEP"
        fi
    done

    log "Heartbeat cycle complete: $CURRENT_THREAD thread(s) queued"

    # Optional: wait 30s and check for HEARTBEAT_OK responses to clean up
    sleep 30

    for THREAD_ID in $THREAD_IDS; do
        RESPONSE_PATTERN="$SCRIPT_DIR/.tinyclaw/queue/outgoing/heartbeat_${THREAD_ID}_*.json"
        for RESPONSE_FILE in $RESPONSE_PATTERN; do
            if [ -f "$RESPONSE_FILE" ]; then
                RESPONSE=$(jq -r '.message // empty' "$RESPONSE_FILE" 2>/dev/null)
                if echo "$RESPONSE" | grep -q "HEARTBEAT_OK"; then
                    log "Thread $THREAD_ID: HEARTBEAT_OK - cleaning up response"
                    rm -f "$RESPONSE_FILE"
                elif [ -n "$RESPONSE" ]; then
                    log "Thread $THREAD_ID response: ${RESPONSE:0:100}..."
                fi
            fi
        done
    done
done
