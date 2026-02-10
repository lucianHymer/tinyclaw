#!/bin/bash
# TinyClaw Setup Wizard - Telegram Forum Configuration

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS_FILE="$SCRIPT_DIR/.tinyclaw/settings.json"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

mkdir -p "$SCRIPT_DIR/.tinyclaw"

echo ""
echo -e "${BLUE}------------------------------------------------------${NC}"
echo -e "${GREEN}  TinyClaw - Telegram Forum Setup Wizard${NC}"
echo -e "${BLUE}------------------------------------------------------${NC}"
echo ""

# Telegram bot token
echo "Enter your Telegram bot token:"
echo -e "${YELLOW}(Get one from @BotFather on Telegram)${NC}"
echo ""
read -rp "Token: " TELEGRAM_BOT_TOKEN

if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
    echo -e "${RED}Telegram bot token is required${NC}"
    exit 1
fi
echo -e "${GREEN}Telegram bot token saved${NC}"
echo ""

# Telegram group chat ID
echo "Enter your Telegram group chat ID:"
echo -e "${YELLOW}(The numeric ID of your Telegram group/forum)${NC}"
echo ""
read -rp "Chat ID: " TELEGRAM_CHAT_ID

if [ -z "$TELEGRAM_CHAT_ID" ]; then
    echo -e "${RED}Telegram chat ID is required${NC}"
    exit 1
fi
echo -e "${GREEN}Telegram chat ID saved${NC}"
echo ""

# Timezone
echo "Enter your timezone:"
echo -e "${YELLOW}(e.g. America/Denver, America/New_York, UTC)${NC}"
echo ""
read -rp "Timezone [default: America/Denver]: " TIMEZONE_INPUT
TIMEZONE=${TIMEZONE_INPUT:-America/Denver}
echo -e "${GREEN}Timezone: $TIMEZONE${NC}"
echo ""

# Heartbeat interval
echo "Heartbeat interval (seconds)?"
echo -e "${YELLOW}(How often the heartbeat cron checks active threads)${NC}"
echo ""
read -rp "Interval [default: 500]: " HEARTBEAT_INPUT
HEARTBEAT_INTERVAL=${HEARTBEAT_INPUT:-500}

# Validate it's a number
if ! [[ "$HEARTBEAT_INTERVAL" =~ ^[0-9]+$ ]]; then
    echo -e "${RED}Invalid interval, using default 500${NC}"
    HEARTBEAT_INTERVAL=500
fi
echo -e "${GREEN}Heartbeat interval: ${HEARTBEAT_INTERVAL}s${NC}"
echo ""

# Write settings.json
cat > "$SETTINGS_FILE" <<EOF
{
  "telegram_bot_token": "$TELEGRAM_BOT_TOKEN",
  "telegram_chat_id": "$TELEGRAM_CHAT_ID",
  "timezone": "$TIMEZONE",
  "heartbeat_interval": $HEARTBEAT_INTERVAL,
  "max_concurrent_sessions": 10,
  "session_idle_timeout_minutes": 30
}
EOF

echo -e "${GREEN}Configuration saved to .tinyclaw/settings.json${NC}"
echo ""
echo "You can now start TinyClaw:"
echo -e "  ${GREEN}./tinyclaw.sh start${NC}"
echo ""
