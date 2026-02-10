#!/bin/bash
# Heartbeat Cron - Sends heartbeat messages to all active threads via queue system

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

    THREAD_COUNT=0
    EPOCH_MS=$(date +%s)000

    for THREAD_ID in $THREAD_IDS; do
        MESSAGE_ID="heartbeat_${THREAD_ID}_$(date +%s)_$$"

        cat > "$QUEUE_INCOMING/${MESSAGE_ID}.json" << EOF
{
  "channel": "heartbeat",
  "source": "heartbeat",
  "threadId": $THREAD_ID,
  "sender": "system",
  "senderId": "heartbeat",
  "message": "$HEARTBEAT_PROMPT",
  "isReply": false,
  "timestamp": $EPOCH_MS,
  "messageId": "$MESSAGE_ID"
}
EOF

        log "Heartbeat queued for thread $THREAD_ID: $MESSAGE_ID"
        THREAD_COUNT=$((THREAD_COUNT + 1))
    done

    log "Heartbeat cycle complete: $THREAD_COUNT thread(s) queued"

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
