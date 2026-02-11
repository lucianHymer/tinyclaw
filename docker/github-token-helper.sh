#!/bin/bash
set -euo pipefail
# Git credential helper — called by git with protocol/host/path on stdin
# Parses org from the path, looks up installation ID, calls the broker

# Only handle "get" operations
if [ "$1" != "get" ]; then
  exit 0
fi

# Parse git's credential request from stdin
ORG=""
while IFS='=' read -r key value; do
  case "$key" in
    path) ORG="${value%%/*}" ;;
  esac
done

# Fallback: if git didn't send path (credential.useHttpPath not set),
# use the first org in github-installations.json
if [ -z "$ORG" ]; then
  ORG=$(jq -r 'keys[0] // empty' /secrets/github-installations.json 2>/dev/null || true)
fi

if [ -z "$ORG" ]; then
  exit 1  # No org available from path or installations
fi

# Look up installation ID for this org
INSTALL_ID=$(jq -r --arg org "$ORG" '.[$org] // empty' /secrets/github-installations.json 2>/dev/null)
if [ -z "$INSTALL_ID" ]; then
  exit 1  # No installation for this org — git will prompt or fail
fi

# Call the credential broker
RESULT=$(curl -sf --connect-timeout 5 --max-time 10 -H "Authorization: Bearer $BROKER_SECRET" "${CREDENTIAL_BROKER_URL:-http://broker:3000}/token?installation_id=$INSTALL_ID")
if [ $? -ne 0 ] || [ -z "$RESULT" ]; then
  exit 1
fi

TOKEN=$(echo "$RESULT" | jq -r '.token // empty')
if [ -z "$TOKEN" ]; then
  exit 1
fi

echo "protocol=https"
echo "host=github.com"
echo "username=x-access-token"
echo "password=$TOKEN"
