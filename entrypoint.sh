#!/bin/bash
set -e

trap 'kill $TELEGRAM_PID $QUEUE_PID 2>/dev/null; wait' SIGTERM SIGINT

node dist/telegram-client.js &
TELEGRAM_PID=$!
node dist/queue-processor.js &
QUEUE_PID=$!

# Wait for either process to exit
wait -n $TELEGRAM_PID $QUEUE_PID
# If one exits, kill the other
kill $TELEGRAM_PID $QUEUE_PID 2>/dev/null
exit 1
