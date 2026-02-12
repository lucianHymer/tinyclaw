#!/bin/bash
set -euo pipefail

# Credential broker env vars: MCP-created containers get /etc/profile.d/broker-env.sh via
# bind mount. CLI-created containers (create-dev-container.sh) pass env vars instead.
# Fallback: if the file doesn't exist and env vars are set, write it for backward compat.
if [ ! -f /etc/profile.d/broker-env.sh ] && [ -n "${CREDENTIAL_BROKER_URL:-}" ]; then
  printf 'export CREDENTIAL_BROKER_URL=%s\nexport BROKER_SECRET=%s\n' \
    "$CREDENTIAL_BROKER_URL" "${BROKER_SECRET:-}" > /etc/profile.d/broker-env.sh
fi

# Provisioning: SSH key
if [ -n "${PROVISION_SSH_KEY:-}" ]; then
  # Defense-in-depth: validate key format even though the MCP tool validates too
  if printf '%s' "$PROVISION_SSH_KEY" | grep -qE '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-|sk-ssh-ed25519|sk-ecdsa-sha2-)'; then
    printf '%s\n' "$PROVISION_SSH_KEY" >> /home/dev/.ssh/authorized_keys
    chown dev:dev /home/dev/.ssh/authorized_keys
    chmod 600 /home/dev/.ssh/authorized_keys
  else
    echo "WARNING: PROVISION_SSH_KEY does not look like a valid SSH public key, skipping" >&2
  fi
fi

# Provisioning: Git config
# Write .gitconfig directly — NOT su -c with string interpolation (shell injection risk).
if [ -n "${PROVISION_NAME:-}" ] || [ -n "${PROVISION_EMAIL:-}" ]; then
  GITCONFIG="/home/dev/.gitconfig"
  {
    echo "[user]"
    [ -n "${PROVISION_NAME:-}" ] && printf '    name = %s\n' "$PROVISION_NAME"
    [ -n "${PROVISION_EMAIL:-}" ] && printf '    email = %s\n' "$PROVISION_EMAIL"
  } > "$GITCONFIG"
  chown dev:dev "$GITCONFIG"
fi

# Generate SSH host keys + start sshd
ssh-keygen -A
exec /usr/sbin/sshd -D -e
