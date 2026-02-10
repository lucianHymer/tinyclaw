#!/bin/bash
# TinyClaw - Telegram Forum Agent with Smart Routing

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMUX_SESSION="tinyclaw"
LOG_DIR="$SCRIPT_DIR/.tinyclaw/logs"
SETTINGS_FILE="$SCRIPT_DIR/.tinyclaw/settings.json"
QUEUE_INCOMING="$SCRIPT_DIR/.tinyclaw/queue/incoming"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

mkdir -p "$LOG_DIR"
mkdir -p "$QUEUE_INCOMING"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_DIR/daemon.log"
}

# Load settings from JSON
load_settings() {
    if [ ! -f "$SETTINGS_FILE" ]; then
        return 1
    fi

    TELEGRAM_BOT_TOKEN=$(grep -o '"telegram_bot_token"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" | cut -d'"' -f4)
    TELEGRAM_CHAT_ID=$(grep -o '"telegram_chat_id"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" | cut -d'"' -f4)
    MODEL=$(grep -o '"model"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" | cut -d'"' -f4)

    return 0
}

# Check if session exists
session_exists() {
    tmux has-session -t "$TMUX_SESSION" 2>/dev/null
}

# Start daemon
start_daemon() {
    if session_exists; then
        echo -e "${YELLOW}Session already running${NC}"
        return 1
    fi

    log "Starting TinyClaw daemon..."

    # Check if Node.js dependencies are installed
    if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
        echo -e "${YELLOW}Installing Node.js dependencies...${NC}"
        cd "$SCRIPT_DIR"
        npm install
    fi

    # Build TypeScript if needed
    if [ ! -d "$SCRIPT_DIR/dist" ] || [ "$SCRIPT_DIR/src/telegram-client.ts" -nt "$SCRIPT_DIR/dist/telegram-client.js" ] || [ "$SCRIPT_DIR/src/queue-processor.ts" -nt "$SCRIPT_DIR/dist/queue-processor.js" ]; then
        echo -e "${YELLOW}Building TypeScript...${NC}"
        cd "$SCRIPT_DIR"
        npm run build
    fi

    # Load settings or run setup wizard
    if ! load_settings; then
        echo -e "${YELLOW}No configuration found. Running setup wizard...${NC}"
        echo ""
        "$SCRIPT_DIR/setup-wizard.sh"

        # Reload settings after setup
        if ! load_settings; then
            echo -e "${RED}Setup failed or was cancelled${NC}"
            return 1
        fi
    fi

    # Validate Telegram settings
    if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
        echo -e "${RED}Telegram bot token is missing${NC}"
        echo "Run './tinyclaw.sh setup' to reconfigure"
        return 1
    fi

    if [ -z "$TELEGRAM_CHAT_ID" ]; then
        echo -e "${RED}Telegram chat ID is missing${NC}"
        echo "Run './tinyclaw.sh setup' to reconfigure"
        return 1
    fi

    echo -e "${BLUE}Channel:${NC}"
    echo -e "  ${GREEN}Telegram Forum${NC}"
    echo ""

    # 3 panes layout:
    # +----------+----------+
    # | Telegram |  Queue   |
    # +----------+----------+
    # |        Logs         |
    # +---------------------+
    tmux new-session -d -s "$TMUX_SESSION" -n "tinyclaw" -c "$SCRIPT_DIR"
    tmux split-window -v -t "$TMUX_SESSION" -c "$SCRIPT_DIR"
    tmux split-window -h -t "$TMUX_SESSION:0.0" -c "$SCRIPT_DIR"

    tmux send-keys -t "$TMUX_SESSION:0.0" "cd '$SCRIPT_DIR' && node dist/telegram-client.js" C-m
    tmux send-keys -t "$TMUX_SESSION:0.1" "cd '$SCRIPT_DIR' && node dist/queue-processor.js" C-m
    tmux send-keys -t "$TMUX_SESSION:0.2" "cd '$SCRIPT_DIR' && tail -f .tinyclaw/logs/telegram.log .tinyclaw/logs/queue.log" C-m

    tmux select-pane -t "$TMUX_SESSION:0.0" -T "Telegram"
    tmux select-pane -t "$TMUX_SESSION:0.1" -T "Queue"
    tmux select-pane -t "$TMUX_SESSION:0.2" -T "Logs"

    echo ""
    echo -e "${GREEN}TinyClaw started${NC}"
    echo ""
    echo -e "${GREEN}Commands:${NC}"
    echo "  Status:  ./tinyclaw.sh status"
    echo "  Logs:    ./tinyclaw.sh logs [telegram|queue|heartbeat|daemon]"
    echo "  Attach:  tmux attach -t $TMUX_SESSION"
    echo ""

    log "Daemon started with 3 panes (telegram)"
}

# Stop daemon
stop_daemon() {
    log "Stopping TinyClaw..."

    if session_exists; then
        tmux kill-session -t "$TMUX_SESSION"
    fi

    # Kill any remaining processes
    pkill -f "dist/telegram-client.js" || true
    pkill -f "dist/queue-processor.js" || true

    echo -e "${GREEN}TinyClaw stopped${NC}"
    log "Daemon stopped"
}

# Send message to queue from CLI
send_message() {
    local message="$1"

    mkdir -p "$QUEUE_INCOMING"

    local MESSAGE_ID="cli_$(date +%s)_$$"

    jq -n \
      --arg channel "telegram" \
      --arg source "cli" \
      --argjson threadId 1 \
      --arg sender "CLI" \
      --arg senderId "cli" \
      --arg message "$message" \
      --argjson isReply false \
      --argjson timestamp "$(date +%s)000" \
      --arg messageId "$MESSAGE_ID" \
      '{channel: $channel, source: $source, threadId: $threadId, sender: $sender, senderId: $senderId, message: $message, isReply: $isReply, timestamp: $timestamp, messageId: $messageId}' \
      > "$QUEUE_INCOMING/${MESSAGE_ID}.json"

    echo -e "${GREEN}Message queued: $MESSAGE_ID${NC}"
    log "[cli] Queued: ${message:0:50}..."
}

# Status
status_daemon() {
    echo -e "${BLUE}TinyClaw Status${NC}"
    echo "==============="
    echo ""

    if session_exists; then
        echo -e "Tmux Session:    ${GREEN}Running${NC}"
        echo "  Attach: tmux attach -t $TMUX_SESSION"
    else
        echo -e "Tmux Session:    ${RED}Not Running${NC}"
        echo "  Start: ./tinyclaw.sh start"
    fi

    echo ""

    if pgrep -f "dist/telegram-client.js" > /dev/null; then
        echo -e "Telegram Client: ${GREEN}Running${NC}"
    else
        echo -e "Telegram Client: ${RED}Not Running${NC}"
    fi

    if pgrep -f "dist/queue-processor.js" > /dev/null; then
        echo -e "Queue Processor: ${GREEN}Running${NC}"
    else
        echo -e "Queue Processor: ${RED}Not Running${NC}"
    fi

    if pgrep -f "heartbeat-cron.sh" > /dev/null; then
        echo -e "Heartbeat Cron:  ${GREEN}Running${NC}"
    else
        echo -e "Heartbeat Cron:  ${RED}Not Running${NC}"
    fi

    echo ""
    echo "Recent Telegram Activity:"
    echo "-------------------------"
    tail -n 5 "$LOG_DIR/telegram.log" 2>/dev/null || echo "  No Telegram activity yet"

    echo ""
    echo "Recent Queue Activity:"
    echo "----------------------"
    tail -n 5 "$LOG_DIR/queue.log" 2>/dev/null || echo "  No queue activity yet"

    echo ""
    echo "Recent Heartbeats:"
    echo "------------------"
    tail -n 3 "$LOG_DIR/heartbeat.log" 2>/dev/null || echo "  No heartbeat logs yet"

    echo ""
    echo "Logs:"
    echo "  Telegram:  tail -f $LOG_DIR/telegram.log"
    echo "  Queue:     tail -f $LOG_DIR/queue.log"
    echo "  Heartbeat: tail -f $LOG_DIR/heartbeat.log"
    echo "  Daemon:    tail -f $LOG_DIR/daemon.log"
}

# View logs
logs() {
    case "${1:-telegram}" in
        telegram|tg)
            tail -f "$LOG_DIR/telegram.log"
            ;;
        queue|q)
            tail -f "$LOG_DIR/queue.log"
            ;;
        heartbeat|hb)
            tail -f "$LOG_DIR/heartbeat.log"
            ;;
        daemon|all)
            tail -f "$LOG_DIR/daemon.log"
            ;;
        *)
            echo "Usage: $0 logs [telegram|queue|heartbeat|daemon]"
            ;;
    esac
}

case "${1:-}" in
    start)
        start_daemon
        ;;
    stop)
        stop_daemon
        ;;
    restart)
        stop_daemon
        sleep 2
        start_daemon
        ;;
    status)
        status_daemon
        ;;
    send)
        if [ -z "$2" ]; then
            echo "Usage: $0 send <message>"
            exit 1
        fi
        send_message "$2"
        ;;
    logs)
        logs "$2"
        ;;
    reset)
        echo -e "${YELLOW}Resetting conversation...${NC}"
        touch "$SCRIPT_DIR/.tinyclaw/reset_flag"
        echo -e "${GREEN}Reset flag set${NC}"
        echo ""
        echo "The next message will start a fresh conversation (without -c)."
        echo "After that, conversation will continue normally."
        ;;
    model)
        if [ -z "$2" ]; then
            # Show current model
            if [ -f "$SETTINGS_FILE" ]; then
                CURRENT_MODEL=$(grep -o '"model"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" | cut -d'"' -f4)
                echo -e "${BLUE}Current model: ${GREEN}$CURRENT_MODEL${NC}"
            else
                echo -e "${RED}No settings file found${NC}"
                exit 1
            fi
        else
            case "$2" in
                sonnet|opus)
                    if [ ! -f "$SETTINGS_FILE" ]; then
                        echo -e "${RED}No settings file found. Run setup first.${NC}"
                        exit 1
                    fi

                    # Update model in settings.json
                    if [[ "$OSTYPE" == "darwin"* ]]; then
                        sed -i '' "s/\"model\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"model\": \"$2\"/" "$SETTINGS_FILE"
                    else
                        sed -i "s/\"model\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"model\": \"$2\"/" "$SETTINGS_FILE"
                    fi

                    echo -e "${GREEN}Model switched to: $2${NC}"
                    echo ""
                    echo "Note: This affects the queue processor. Changes take effect on next message."
                    ;;
                *)
                    echo "Usage: $0 model {sonnet|opus}"
                    echo ""
                    echo "Examples:"
                    echo "  $0 model          # Show current model"
                    echo "  $0 model sonnet   # Switch to Sonnet"
                    echo "  $0 model opus     # Switch to Opus"
                    exit 1
                    ;;
            esac
        fi
        ;;
    attach)
        tmux attach -t "$TMUX_SESSION"
        ;;
    setup)
        "$SCRIPT_DIR/setup-wizard.sh"
        ;;
    *)
        echo -e "${BLUE}TinyClaw - Telegram Forum Agent with Smart Routing${NC}"
        echo ""
        echo "Usage: $0 {start|stop|restart|status|setup|send|logs|reset|model|attach}"
        echo ""
        echo "Commands:"
        echo "  start              Start TinyClaw"
        echo "  stop               Stop all processes"
        echo "  restart            Restart TinyClaw"
        echo "  status             Show current status"
        echo "  setup              Run setup wizard"
        echo "  send <msg>         Send message to queue from CLI"
        echo "  logs [type]        View logs (telegram|queue|heartbeat|daemon)"
        echo "  reset              Reset conversation (next message starts fresh)"
        echo "  model [sonnet|opus] Show or switch Claude model"
        echo "  attach             Attach to tmux session"
        echo ""
        echo "Examples:"
        echo "  $0 start"
        echo "  $0 status"
        echo "  $0 model opus"
        echo "  $0 send 'What time is it?'"
        echo "  $0 logs telegram"
        echo ""
        exit 1
        ;;
esac
