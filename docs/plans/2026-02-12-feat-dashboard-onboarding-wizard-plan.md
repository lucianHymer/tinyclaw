---
title: "feat: Agent-driven dev container lifecycle management"
type: feat
date: 2026-02-12
brainstorm: docs/brainstorms/2026-02-12-dashboard-onboarding-wizard-brainstorm.md
deepened: 2026-02-12
pivot: "Pivoted from dashboard wizard to agent-only. The master thread handles onboarding conversationally — a form is the wrong UX for a 3-field interaction when you already have a chat agent."
agents_used: security-sentinel, architecture-strategist, kieran-typescript-reviewer, performance-oracle, agent-native-reviewer, pattern-recognition-specialist, code-simplicity-reviewer, best-practices-researcher, learnings-researcher
---

# Agent-Driven Dev Container Lifecycle

The master thread manages dev container lifecycle via MCP tools: create, stop, start, delete. A new developer messages the Telegram forum, the agent walks them through SSH key setup if needed, collects their info, and provisions their container. No dashboard UI needed — the agent is a better form.

## Overview

Container provisioning is currently CLI-only via `scripts/create-dev-container.sh`. This adds MCP tools so the master thread can manage the full container lifecycle conversationally. The memory dashboard already shows containers visually — that stays. The interaction of "paste your SSH key and tell me your name" is better handled by the agent than a web form.

**Solution: env-var provisioning.** Pass SSH key, name, and email as environment variables at container creation time. The container's entrypoint script reads them and configures everything. This requires `create`, `start`, `stop`, and `delete` proxy rules — **no exec endpoint**, which was flagged as a security risk.

**Security boundary preserved:** The dashboard does NOT need any new secrets or endpoints. Broker credentials are delivered to dev containers via a bind-mounted secrets file (`/secrets/broker-env.sh`). The MCP tools run in the bot process which already has Docker proxy access.

## Architecture Decision: Env-Var Provisioning

### Why not exec?

The Docker proxy uses wollomatic with regex URL matching. Adding `exec` would enable arbitrary code execution in any container reachable through the proxy. Even with regex scoping, exec is a privileged operation that violates the principle of minimal proxy surface.

### How env-var provisioning works

```
Bot (MCP tool)               Docker Proxy              Docker Daemon
   |                              |                         |
   |-- POST /containers/create -->|---- create container -->|
   |   (with PROVISION_* env)     |                         |
   |                              |                         |
   |-- POST /containers/{id}/start ->|---- start --------->|
   |                              |                         |
   |                              |          Container entrypoint runs:
   |                              |          1. Read PROVISION_SSH_KEY → authorized_keys
   |                              |          2. Read PROVISION_NAME/EMAIL → .gitconfig
   |                              |          3. /secrets/broker-env.sh already at /etc/profile.d/
   |                              |          4. ssh-keygen -A
   |                              |          5. exec sshd
```

### Research Insights: Architecture Validation

**Institutional knowledge confirms this approach aligns with 3 documented solution patterns:**
1. **Socket proxy security** (`docs/solutions/architecture-reviews/multi-agent-review-onboarding-heartbeat-infra.md`) — wollomatic regex matching is the correct choice. Tecnativa `POST=1` enables exec for all containers.
2. **ENV propagation** (`docs/solutions/integration-issues/metadata-propagation-and-credential-forwarding-across-layers.md`) — runtime config via compose `environment:` + write to `/etc/profile.d/` in CMD, not Dockerfile `RUN`.
3. **Shared module extraction** (`docs/solutions/architecture-reviews/code-review-cycle-2-systemic-patterns-and-prevention.md`) — Docker API logic must live in `src/docker-client.ts` to prevent duplication divergence.

## Technical Approach

### Phase 1: Entrypoint & Docker Infrastructure

#### 1a. Entrypoint script — `docker/dev-entrypoint.sh` (new file)

Extract the inline CMD from `Dockerfile.dev-container` into a proper entrypoint script:

```bash
#!/bin/bash
set -euo pipefail

# Credential broker env vars: delivered via bind mount at /etc/profile.d/broker-env.sh
# The host's /secrets/broker-env.sh is mounted read-only into the container.
# SSH login sessions source /etc/profile.d/* automatically.

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
```

**Key security decisions (flagged by 6 research agents):**
- **Direct `.gitconfig` write** instead of `su -c "git config '${VAR}'"` — eliminates shell injection entirely
- **`printf '%s'`** instead of `echo` — avoids backslash interpretation
- **`${VAR:-}`** defaults — graceful handling with `set -u`
- **`exec sshd`** — replaces shell as PID 1, Docker signals go directly to sshd

#### 1b. Dockerfile.dev-container changes

```dockerfile
COPY docker/dev-entrypoint.sh /usr/local/bin/dev-entrypoint.sh
RUN chmod +x /usr/local/bin/dev-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/dev-entrypoint.sh"]
```

Remove the old CMD line. Existing `create-dev-container.sh` continues to work (authorized_keys uses append).

#### 1c. Docker compose changes — `docker-compose.yml`

Add 4 proxy rules for full lifecycle:

```yaml
docker-proxy:
  command:
    # ...existing rules...
    - "-allowPOST=/v1\\..{1,2}/containers/create"
    - "-allowPOST=/v1\\..{1,2}/containers/.+/start"
    - "-allowPOST=/v1\\..{1,2}/containers/.+/stop"
    - "-allowDELETE=/v1\\..{1,2}/containers/.+"
```

Create `/secrets/broker-env.sh` on the host (one-time setup):

```bash
# /secrets/broker-env.sh — mounted into dev containers at /etc/profile.d/broker-env.sh
export CREDENTIAL_BROKER_URL=http://broker:3000
export BROKER_SECRET=<actual-secret>
```

No changes to dashboard service env vars. The dashboard stays read-only.

### Phase 2: Docker Client Functions — `src/docker-client.ts`

#### Branded types and validation

```typescript
// Branded types — parse functions return these, making unvalidated input impossible
type SSHPublicKey = string & { readonly __brand: "SSHPublicKey" };
type DevName = string & { readonly __brand: "DevName" };
type DevEmail = string & { readonly __brand: "DevEmail" };
```

**Parse functions (`parseSSHPublicKey` and `parseDevEmail` in `types.ts`, `parseDevName` in `docker-client.ts`):**

```typescript
function parseSSHPublicKey(raw: string): SSHPublicKey {
  const trimmed = raw.trim();
  if (trimmed.includes("PRIVATE KEY") || trimmed.includes("-----BEGIN")) {
    throw new ValidationError("This looks like a PRIVATE key. Paste your PUBLIC key (.pub file).");
  }
  if (Buffer.byteLength(trimmed, "utf8") > 8192) {
    throw new ValidationError("SSH key exceeds 8KB limit.");
  }
  if (trimmed.split("\n").filter(l => l.length > 0).length !== 1) {
    throw new ValidationError("SSH public key must be a single line.");
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) throw new ValidationError("Invalid SSH key format.");
  const [keyType, base64Data] = parts;
  const validTypes: Record<string, string> = {
    "ssh-ed25519": "AAAAC3NzaC1lZDI1NTE5",
    "ssh-rsa": "AAAAB3NzaC1yc2E",
    "ecdsa-sha2-nistp256": "AAAAE2VjZHNhLXNoYTItbmlzdHAyNT",
    "ecdsa-sha2-nistp384": "AAAAE2VjZHNhLXNoYTItbmlzdHAzODQ",
    "ecdsa-sha2-nistp521": "AAAAE2VjZHNhLXNoYTItbmlzdHA1MjE",
  };
  if (!validTypes[keyType]) throw new ValidationError(`Unrecognized key type "${keyType}".`);
  if (!base64Data.startsWith(validTypes[keyType])) {
    throw new ValidationError("Key data does not match type. The key may be corrupted.");
  }
  return trimmed as SSHPublicKey;
}
```

**Base64 prefix validation** catches corrupted keys, truncated copies, and type/data mismatches — not just the type prefix string.

#### createDevContainer()

```typescript
interface DevContainerUserInput {
  name: DevName;
  email: DevEmail;
  sshPublicKey: SSHPublicKey;
}

interface DevContainerInfraConfig {
  port: number;
  networkName: string;
  dashboardHost: string;
  dockerBaseUrl: string;
}

interface CreateContainerResult {
  containerId: string;
  name: string;        // "dev-alice"
  port: number;
  host: string;
}
```

**Container spec with hardening:**

```typescript
const containerSpec = {
  Image: "tinyclaw-dev",
  Hostname: `dev-${name}`,
  Env: [
    `PROVISION_SSH_KEY=${sshPublicKey}`,
    `PROVISION_NAME=${name}`,
    `PROVISION_EMAIL=${email}`,
  ],
  ExposedPorts: { "22/tcp": {} },
  Labels: {
    "tinyclaw.type": "dev-container",
    "tinyclaw.created-by": "mcp-tool",
    "tinyclaw.created-at": new Date().toISOString(),
    "tinyclaw.dev-name": name,
    "tinyclaw.dev-email": email,
  },
  HostConfig: {
    Memory: 2 * 1024 * 1024 * 1024,        // 2GB
    MemorySwap: 2 * 1024 * 1024 * 1024,    // same = no swap
    NanoCPUs: 2 * 1e9,                      // 2 CPUs
    PidsLimit: 256,                          // prevent fork bombs
    CapDrop: ["NET_RAW"],
    SecurityOpt: ["no-new-privileges"],      // prevent setuid escalation
    Binds: [
      "/secrets/github-installations.json:/secrets/github-installations.json:ro",
      "/secrets/broker-env.sh:/etc/profile.d/broker-env.sh:ro",
    ],
    PortBindings: {
      "22/tcp": [{ HostIp: "0.0.0.0", HostPort: String(port) }],
    },
    RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
    LogConfig: {
      Type: "json-file",
      Config: { "max-size": "10m", "max-file": "3" },
    },
  },
  NetworkingConfig: {
    EndpointsConfig: { [networkName]: {} },
  },
};
```

Implementation:
1. `POST /containers/create?name=dev-${name}` via `fetchDockerJson` — returns `{ Id, Warnings }`
2. `POST /containers/{id}/start` — returns 204 with no body, use raw `fetch()` with `AbortSignal.timeout(30_000)`
3. Return structured `CreateContainerResult`

#### stopDevContainer(), deleteDevContainer()

```typescript
async function stopDevContainer(baseUrl: string, containerId: string): Promise<void> {
  // POST /containers/{id}/stop returns 204 or 304 (already stopped)
}

async function deleteDevContainer(baseUrl: string, containerId: string, force?: boolean): Promise<void> {
  // DELETE /containers/{id}?force=true for running containers
  // Only operates on tinyclaw.type=dev-container (verify via inspect first)
}
```

**Safety check:** Before delete, inspect the container and verify `tinyclaw.type=dev-container` label exists. Refuse to delete containers without this label.

#### O(1) Port Scanning + Name Resolution

Single container list call serves both port scanning and name resolution:

```typescript
const containers = await fetchDockerJson<Array<{
  Names: string[];
  Ports: Array<{ PublicPort?: number }>;
}>>(
  baseUrl,
  '/containers/json?all=true&filters={"label":["tinyclaw.type=dev-container"]}',
);

const occupied = new Set<number>();
for (const c of containers) {
  for (const p of c.Ports || []) {
    if (p.PublicPort && p.PublicPort >= 2201 && p.PublicPort <= 2299) {
      occupied.add(p.PublicPort);
    }
  }
}

const existingNames = new Set(
  containers.flatMap(c => c.Names.map(n => n.replace(/^\//, ""))),
);
```

Reduces port scan from O(N) inspect calls to O(1).

#### formatSSHConfig()

Presentation utility, separate from Docker client logic:

```typescript
function formatSSHConfig(result: CreateContainerResult, keyType?: string): string {
  const identityFile = keyType === "ssh-rsa" ? "~/.ssh/id_rsa" : "~/.ssh/id_ed25519";
  return [
    `Host tinyclaw-${result.name.replace(/^dev-/, "")}`,
    `  HostName ${result.host}`,
    `  Port ${result.port}`,
    `  User dev`,
    `  IdentityFile ${identityFile}`,
    `  ServerAliveInterval 30`,
    `  ServerAliveCountMax 5`,
  ].join("\n");
}
```

### Phase 3: MCP Tools — `src/mcp-tools.ts`

Four new tools, all master-only (`sourceThreadId === 1`):

#### create_dev_container

```typescript
const createDevContainer = tool(
  "create_dev_container",
  "Create a new dev container for a developer. Provisions SSH access, git config, and credential broker. Returns SSH connection details.",
  {
    name: z.string().describe("Developer name (lowercase, alphanumeric + hyphens)"),
    email: z.string().describe("Developer email (for git config)"),
    sshPublicKey: z.string().describe("SSH public key (ed25519, RSA, or ECDSA)"),
  },
  async ({ name, email, sshPublicKey }) => {
    try {
      const parsedName = parseDevName(name);
      const parsedEmail = parseDevEmail(email);
      const parsedKey = parseSSHPublicKey(sshPublicKey);

      const containers = await listDevContainers(DOCKER_PROXY_URL);
      const port = findNextAvailablePort(containers);
      const containerName = resolveUniqueName(containers, parsedName);

      const result = await createDevContainerFn(
        { name: containerName, email: parsedEmail, sshPublicKey: parsedKey },
        { port, networkName: DEV_NETWORK, dashboardHost: DASHBOARD_HOST, dockerBaseUrl: DOCKER_PROXY_URL },
      );
      const sshConfig = formatSSHConfig(result);
      return { content: [textContent(
        `Container ${result.name} created on port ${result.port}.\n\nSSH config:\n\`\`\`\n${sshConfig}\n\`\`\``
      )] };
    } catch (err) {
      return { content: [textContent(`Failed: ${toErrorMessage(err)}`)], isError: true };
    }
  },
);
```

#### stop_dev_container

```typescript
const stopDevContainerTool = tool(
  "stop_dev_container",
  "Stop a running dev container by name (e.g., 'dev-alice').",
  {
    name: z.string().describe("Container name (e.g., 'dev-alice')"),
  },
  async ({ name }) => {
    try {
      const container = await findContainerByName(DOCKER_PROXY_URL, name);
      await stopDevContainer(DOCKER_PROXY_URL, container.Id);
      return { content: [textContent(`Stopped ${name}.`)] };
    } catch (err) {
      return { content: [textContent(`Failed: ${toErrorMessage(err)}`)], isError: true };
    }
  },
);
```

#### start_dev_container

```typescript
const startDevContainerTool = tool(
  "start_dev_container",
  "Start a stopped dev container by name.",
  {
    name: z.string().describe("Container name (e.g., 'dev-alice')"),
  },
  async ({ name }) => {
    // Similar pattern — find by name, POST /containers/{id}/start
  },
);
```

#### delete_dev_container

```typescript
const deleteDevContainerTool = tool(
  "delete_dev_container",
  "Permanently delete a dev container by name. Stops it first if running. This cannot be undone.",
  {
    name: z.string().describe("Container name (e.g., 'dev-alice')"),
  },
  async ({ name }) => {
    try {
      const container = await findContainerByName(DOCKER_PROXY_URL, name);
      // Safety: verify tinyclaw.type=dev-container label
      await deleteDevContainer(DOCKER_PROXY_URL, container.Id, true);
      return { content: [textContent(`Deleted ${name}. Port ${container.port} is now available.`)] };
    } catch (err) {
      return { content: [textContent(`Failed: ${toErrorMessage(err)}`)], isError: true };
    }
  },
);
```

**Registration:**

```typescript
if (sourceThreadId === 1) {
  tools.push(
    updateContainerMemory, getHostMemory,
    createDevContainer, stopDevContainerTool, startDevContainerTool, deleteDevContainerTool,
  );
}
```

### Phase 4: System Prompt — `src/session-manager.ts`

Update `buildMcpToolsBlock` to document the new tools:

```typescript
// Master-only tools (inside isMaster block):
"- `create_dev_container` — Create a new dev container (name, email, SSH public key). Returns SSH config.",
"- `stop_dev_container` — Stop a running dev container by name.",
"- `start_dev_container` — Start a stopped dev container by name.",
"- `delete_dev_container` — Permanently delete a dev container by name. Cannot be undone.",
```

**Pre-existing bug to fix:** `get_container_stats` and `get_system_status` are available to all threads in code but documented only in the master block of `buildMcpToolsBlock`. Move their descriptions to the all-threads section.

### Phase 5: Integration & Testing

- Rebuild dev container image (`docker build -t tinyclaw-dev -f Dockerfile.dev-container .`)
- Restart docker-proxy to pick up new rules
- Test via master thread Telegram:
  1. "Create a dev container for Alice, email alice@company.com, SSH key: ssh-ed25519 AAAA..."
  2. Verify SSH access works
  3. "Stop dev-alice"
  4. "Start dev-alice"
  5. "Delete dev-alice"
- Verify existing `create-dev-container.sh` still works
- Verify Memory view shows created/stopped/deleted containers correctly
- Test error states: bad SSH key, duplicate name, port exhaustion, image not found

**Security tests:**
- Paste private key — should be rejected with clear error
- Name with shell metacharacters — should be sanitized
- Verify `no-new-privileges` set on created container
- Verify `PidsLimit` set on created container
- Verify delete refuses containers without `tinyclaw.type=dev-container` label

## Acceptance Criteria

### Functional
- [ ] Master thread can create dev containers via `create_dev_container` tool
- [ ] Master thread can stop/start/delete containers via corresponding tools
- [ ] Container created with correct labels, network, memory, ports, security opts
- [ ] SSH key installed and usable immediately after creation
- [ ] Git config set inside container (user.name + user.email)
- [ ] SSH config snippet returned by create tool
- [ ] Container appears in Memory dashboard view after creation
- [ ] Duplicate names handled (auto-increment suffix)
- [ ] Port auto-assignment from 2201-2299 range
- [ ] Delete verifies `tinyclaw.type=dev-container` label before removing

### Error Handling
- [ ] Invalid SSH key returns clear error via tool
- [ ] Private key paste rejected with explanation
- [ ] Port range exhaustion returns clear error
- [ ] Docker API failures return actionable error messages
- [ ] Image not found: "tinyclaw-dev image not built. Run docker build..."
- [ ] Delete of non-dev container refused

### Security
- [ ] No exec endpoint added to Docker proxy
- [ ] SSH public key validated (type + base64 prefix match, single line, max 8KB)
- [ ] Name sanitized before use in container name
- [ ] Entrypoint does NOT use `su -c` with string interpolation
- [ ] Container created with `no-new-privileges` and `PidsLimit: 256`
- [ ] Both secrets files bind-mounted read-only
- [ ] Dashboard has no new secrets or endpoints

### Backward Compatibility
- [ ] `create-dev-container.sh` still works for CLI provisioning
- [ ] Existing containers unaffected by Dockerfile changes
- [ ] Dashboard memory view unchanged
- [ ] Existing MCP tools unchanged

### Pattern Consistency
- [ ] All MCP tools use SDK `tool()` with Zod schemas
- [ ] All error handlers use `textContent()` + `isError: true`
- [ ] All catch blocks use `toErrorMessage(err)`
- [ ] Branded types prevent unvalidated input in Docker calls
- [ ] Container ID validated before use in API paths

## Files Changed

| File | Change | New/Modified |
|------|--------|-------------|
| `docker/dev-entrypoint.sh` | Entrypoint with provisioning logic (safe git config) | New |
| `Dockerfile.dev-container` | Use entrypoint script instead of inline CMD | Modified |
| `docker-compose.yml` | Add 4 proxy rules (create, start, stop, delete) | Modified |
| `src/docker-client.ts` | Add create/stop/delete functions, port assignment, name resolution, formatSSHConfig | Modified |
| `src/types.ts` | Add parseSSHPublicKey, parseDevEmail, branded types | Modified |
| `src/mcp-tools.ts` | Add 4 container lifecycle tools (master-only) | Modified |
| `src/session-manager.ts` | Document new tools in buildMcpToolsBlock, fix read-only tool docs | Modified |

## Dependencies & Prerequisites

- `tinyclaw-dev` Docker image must be pre-built on host
- `/secrets/broker-env.sh` must exist on host (CREDENTIAL_BROKER_URL + BROKER_SECRET)
- `/secrets/github-installations.json` must exist on host
- `DASHBOARD_HOST` env var configured for bot process
- Dev network must exist (created by `docker compose up`)

## What We Cut (and Why)

| Cut | Reason |
|-----|--------|
| `static/onboarding.html` (7-slide wizard) | Agent handles the 3-field interaction conversationally. No frontend code, no race conditions, no state machine. |
| `src/onboarding-routes.ts` | No dashboard API endpoints needed — MCP tools go through the bot process. |
| Dashboard `GET /api/identity` endpoint | Agent reads user identity from Telegram, not Cloudflare headers. |
| `POST /api/containers/create` endpoint | Agent uses MCP tool directly. |
| 7 Gemini-generated illustrations | No wizard, no illustrations. |
| `BROKER_SECRET` in dashboard env | Bind-mounted secrets file instead. Dashboard stays read-only. |

## References

- Brainstorm: `docs/brainstorms/2026-02-12-dashboard-onboarding-wizard-brainstorm.md`
- Docker client: `src/docker-client.ts`
- Existing creation script: `scripts/create-dev-container.sh`
- Dev container image: `Dockerfile.dev-container`
- Docker proxy config: `docker-compose.yml:53-76`
- Architecture review: `docs/solutions/architecture-reviews/multi-agent-review-onboarding-heartbeat-infra.md`
- Credential forwarding: `docs/solutions/integration-issues/metadata-propagation-and-credential-forwarding-across-layers.md`
- Code review patterns: `docs/solutions/architecture-reviews/code-review-cycle-2-systemic-patterns-and-prevention.md`
- Docker Engine API: https://docs.docker.com/engine/api/v1.33/
- OWASP Docker Security: https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html
