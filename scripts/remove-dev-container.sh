#!/bin/bash
# scripts/remove-dev-container.sh
# Tears down a dev container (stops and removes it).
# Usage: ./remove-dev-container.sh <name>
# Example: ./remove-dev-container.sh alice

set -euo pipefail

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

if [ $# -lt 1 ]; then
    echo "Usage: $0 <name>"
    echo "Example: $0 alice"
    exit 1
fi

DEV_NAME="$1"
CONTAINER_NAME="dev-${DEV_NAME}"

# Check if container exists
if ! docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    log "ERROR: Container $CONTAINER_NAME does not exist"
    exit 1
fi

log "Stopping container ${CONTAINER_NAME}..."
docker stop "$CONTAINER_NAME"

log "Removing container ${CONTAINER_NAME}..."
docker rm "$CONTAINER_NAME"

log "Container ${CONTAINER_NAME} removed"
