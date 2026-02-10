#!/bin/bash
# TinyClaw - Telegram Forum Agent with Smart Routing

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/.tinyclaw/logs"
SETTINGS_FILE="$SCRIPT_DIR/.tinyclaw/settings.json"
QUEUE_INCOMING="$SCRIPT_DIR/.tinyclaw/queue/incoming"
PID_DIR="$SCRIPT_DIR/.tinyclaw/pids"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

mkdir -p "$LOG_DIR" "$QUEUE_INCOMING" "$PID_DIR"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_DIR/daemon.log"
}

# Check if systemd services are installed
has_systemd() {
    systemctl list-unit-files tinyclaw-telegram.service &>/dev/null
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

# Check if processes are running
is_running() {
    pgrep -f "dist/$1.js" > /dev/null 2>&1
}

# Start daemon
start_daemon() {
    if is_running "telegram-client" && is_running "queue-processor"; then
        echo -e "${YELLOW}TinyClaw is already running${NC}"
        return 1
    fi

    log "Starting TinyClaw..."

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

    if has_systemd; then
        # Use systemd
        sudo systemctl start tinyclaw-telegram tinyclaw-queue
        echo -e "${GREEN}TinyClaw started via systemd${NC}"
        echo "  Logs: journalctl -f -u tinyclaw-telegram -u tinyclaw-queue"
    else
        # Fallback: background processes with PID tracking
        cd "$SCRIPT_DIR"
        node dist/telegram-client.js >> "$LOG_DIR/telegram.log" 2>&1 &
        echo $! > "$PID_DIR/telegram.pid"

        node dist/queue-processor.js >> "$LOG_DIR/queue.log" 2>&1 &
        echo $! > "$PID_DIR/queue.pid"

        echo -e "${GREEN}TinyClaw started (background processes)${NC}"
        echo "  Logs: ./tinyclaw.sh logs"
    fi

    log "TinyClaw started"
}

# Stop daemon
stop_daemon() {
    log "Stopping TinyClaw..."

    if has_systemd; then
        sudo systemctl stop tinyclaw-telegram tinyclaw-queue 2>/dev/null
    fi

    # Kill by PID files
    for svc in telegram queue; do
        local pidfile="$PID_DIR/$svc.pid"
        if [ -f "$pidfile" ]; then
            kill "$(cat "$pidfile")" 2>/dev/null
            rm -f "$pidfile"
        fi
    done

    # Fallback: pkill
    pkill -f "dist/telegram-client.js" 2>/dev/null || true
    pkill -f "dist/queue-processor.js" 2>/dev/null || true

    echo -e "${GREEN}TinyClaw stopped${NC}"
    log "TinyClaw stopped"
}

# Install systemd services
install_systemd() {
    echo -e "${BLUE}Installing systemd services...${NC}"

    # Update WorkingDirectory and User in service files
    local user
    user=$(whoami)

    for svc in tinyclaw-telegram tinyclaw-queue; do
        local src="$SCRIPT_DIR/systemd/$svc.service"
        if [ ! -f "$src" ]; then
            echo -e "${RED}Missing $src${NC}"
            return 1
        fi

        # Substitute placeholders for this machine
        sed "s|__USER__|$user|g;s|__WORKING_DIR__|$SCRIPT_DIR|g" \
            "$src" | sudo tee "/etc/systemd/system/$svc.service" > /dev/null
    done

    sudo systemctl daemon-reload
    sudo systemctl enable tinyclaw-telegram tinyclaw-queue

    echo -e "${GREEN}Systemd services installed and enabled${NC}"
    echo "  Start:   ./tinyclaw.sh start"
    echo "  Logs:    journalctl -f -u tinyclaw-telegram -u tinyclaw-queue"
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

    if has_systemd; then
        echo -e "${BLUE}Mode: systemd${NC}"
        echo ""
        systemctl --no-pager status tinyclaw-telegram 2>/dev/null | head -4
        echo ""
        systemctl --no-pager status tinyclaw-queue 2>/dev/null | head -4
    else
        echo -e "${BLUE}Mode: background processes${NC}"
    fi

    echo ""

    if is_running "telegram-client"; then
        echo -e "Telegram Client: ${GREEN}Running${NC}"
    else
        echo -e "Telegram Client: ${RED}Not Running${NC}"
    fi

    if is_running "queue-processor"; then
        echo -e "Queue Processor: ${GREEN}Running${NC}"
    else
        echo -e "Queue Processor: ${RED}Not Running${NC}"
    fi

    echo ""
    echo "Recent Telegram Activity:"
    echo "-------------------------"
    tail -n 5 "$LOG_DIR/telegram.log" 2>/dev/null || echo "  No Telegram activity yet"

    echo ""
    echo "Recent Queue Activity:"
    echo "----------------------"
    tail -n 5 "$LOG_DIR/queue.log" 2>/dev/null || echo "  No queue activity yet"
}

# View logs
logs() {
    if has_systemd; then
        case "${1:-all}" in
            telegram|tg)
                journalctl -f -u tinyclaw-telegram
                ;;
            queue|q)
                journalctl -f -u tinyclaw-queue
                ;;
            *)
                journalctl -f -u tinyclaw-telegram -u tinyclaw-queue
                ;;
        esac
    else
        case "${1:-telegram}" in
            telegram|tg)
                tail -f "$LOG_DIR/telegram.log"
                ;;
            queue|q)
                tail -f "$LOG_DIR/queue.log"
                ;;
            daemon|all)
                tail -f "$LOG_DIR/daemon.log"
                ;;
            *)
                echo "Usage: $0 logs [telegram|queue|daemon]"
                ;;
        esac
    fi
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
    install)
        install_systemd
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

                    if [[ "$OSTYPE" == "darwin"* ]]; then
                        sed -i '' "s/\"model\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"model\": \"$2\"/" "$SETTINGS_FILE"
                    else
                        sed -i "s/\"model\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"model\": \"$2\"/" "$SETTINGS_FILE"
                    fi

                    echo -e "${GREEN}Model switched to: $2${NC}"
                    echo "Note: Changes take effect on next message."
                    ;;
                *)
                    echo "Usage: $0 model {sonnet|opus}"
                    exit 1
                    ;;
            esac
        fi
        ;;
    setup)
        "$SCRIPT_DIR/setup-wizard.sh"
        ;;
    *)
        echo -e "${BLUE}TinyClaw - Telegram Forum Agent with Smart Routing${NC}"
        echo ""
        echo "Usage: $0 {start|stop|restart|status|install|setup|send|logs|reset|model}"
        echo ""
        echo "Commands:"
        echo "  start              Start TinyClaw"
        echo "  stop               Stop all processes"
        echo "  restart            Restart TinyClaw"
        echo "  status             Show current status"
        echo "  install            Install systemd services (Ubuntu)"
        echo "  setup              Run setup wizard"
        echo "  send <msg>         Send message to queue from CLI"
        echo "  logs [type]        View logs (telegram|queue|all)"
        echo "  reset              Reset conversation"
        echo "  model [sonnet|opus] Show or switch Claude model"
        echo ""
        exit 1
        ;;
esac
