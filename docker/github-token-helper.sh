#!/bin/bash
# Git credential helper — called by git with protocol/host/path on stdin
# Parses org from the path, looks up installation ID, calls the broker

# Only handle "get" operations
if [ "$1" != "get" ]; then
  exit 0
fi

# Parse git's credential request from stdin
while IFS='=' read -r key value; do
  case "$key" in
    path) ORG="${value%%/*}" ;;
  esac
done

# Look up installation ID for this org
INSTALL_ID=$(jq -r --arg org "$ORG" '.[$org] // empty' /secrets/github-installations.json 2>/dev/null)
if [ -z "$INSTALL_ID" ]; then
  exit 1  # No installation for this org — git will prompt or fail
fi

# Call the credential broker
RESULT=$(curl -sf "${CREDENTIAL_BROKER_URL:-http://broker:3000}/token?installation_id=$INSTALL_ID")
if [ $? -ne 0 ] || [ -z "$RESULT" ]; then
  exit 1
fi

echo "protocol=https"
echo "host=github.com"
echo "username=x-access-token"
echo "password=$(echo "$RESULT" | jq -r .token)"
