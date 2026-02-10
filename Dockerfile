FROM node:22-slim

WORKDIR /app

# ── System packages ──────────────────────────────────────────────────
# Install git, curl, jq, bash, and GitHub CLI (gh)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        git curl jq bash ca-certificates gnupg && \
    # GitHub CLI: add the official apt repository
    mkdir -p -m 755 /etc/apt/keyrings && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    # Cleanup apt caches to keep the image small
    rm -rf /var/lib/apt/lists/*

# ── Dependency layer (cached unless package*.json changes) ───────────
COPY package.json package-lock.json tsconfig.json ./

# Install all deps (devDependencies needed for tsc build)
RUN npm ci

# ── Build layer ──────────────────────────────────────────────────────
COPY src/ ./src/
COPY .claude/ ./.claude/

RUN npm run build

# Remove devDependencies after compilation
RUN npm prune --production

# ── Runtime setup ────────────────────────────────────────────────────
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

COPY docker/github-token-helper.sh /usr/local/bin/github-token-helper
RUN chmod +x /usr/local/bin/github-token-helper

# Configure git to use the credential broker helper
RUN git config --global credential.helper /usr/local/bin/github-token-helper

ENTRYPOINT ["./entrypoint.sh"]
