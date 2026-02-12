---
title: "feat: Dashboard onboarding wizard for dev container provisioning"
type: feat
date: 2026-02-12
brainstorm: docs/brainstorms/2026-02-12-dashboard-onboarding-wizard-brainstorm.md
deepened: 2026-02-12
agents_used: security-sentinel, architecture-strategist, kieran-typescript-reviewer, performance-oracle, julik-frontend-races-reviewer, agent-native-reviewer, spec-flow-analyzer, pattern-recognition-specialist, code-simplicity-reviewer, best-practices-researcher, learnings-researcher
---

# Dashboard Onboarding Wizard

Self-service, slide-by-slide wizard at `/onboarding` that provisions dev containers. A new developer goes from "I got invited" to "SSH'd into my container" in under 5 minutes.

## Enhancement Summary

**Deepened on:** 2026-02-12
**Sections enhanced:** 8
**Research agents used:** 11

### Critical Findings (must address before implementation)

1. **Shell injection in entrypoint script** — `su -c "git config '${PROVISION_NAME}'"` is injectable. Fix: write `.gitconfig` directly or use `printf '%q'` quoting.
2. **MCP tool uses raw JSON Schema** — must use SDK `tool()` function with Zod schemas, matching all existing tools.
3. **No Zod validation on POST body** — project convention requires `safeParse()` at I/O boundaries.
4. **Missing secrets volume bind** — `create-dev-container.sh` mounts `/secrets/github-installations.json`, plan omits this. Without it, git/gh breaks in new containers.
5. **BROKER_SECRET eliminated from dashboard** — use bind-mounted secrets file instead of passing secret through dashboard env vars. Dashboard never sees the secret.

### Key Improvements

1. **O(1) Docker API calls** — combine port scan + name resolution into single container list call (was O(N) inspect calls)
2. **Branded types for validated input** — `SSHPublicKey`, `DevName`, `DevEmail` with parse functions prevent unvalidated data in Docker calls
3. **Extract onboarding routes** — `src/onboarding-routes.ts` keeps dashboard.ts from growing past 730 lines
4. **Container hardening** — add `SecurityOpt`, `PidsLimit`, `LogConfig` to creation spec
5. **State machine for wizard** — eliminates double-submit, transition races, and keyboard nav conflicts

### New Considerations Discovered

- Container creation needs in-process mutex (TOCTOU race on port/name)
- `fetchDockerJson` returns JSON but `POST /containers/{id}/start` returns 204 (no body) — needs special handling
- `IdentityFile` in SSH config should match the key type the user pasted
- `prefers-reduced-motion` CSS media query is mandatory for accessibility

---

## Overview

The dashboard currently has no container creation UI — provisioning is CLI-only via `scripts/create-dev-container.sh`. This adds a polished, illustrated onboarding wizard as a standalone page. The critical architectural decision is how to handle container creation through the restricted Docker socket proxy.

**Solution: env-var provisioning.** Pass SSH key, name, and email as environment variables at container creation time. The container's entrypoint script reads them and configures everything. This requires only `create` + `start` proxy rules — **no exec endpoint**, which was flagged as a security risk.

**Security boundary preserved:** The dashboard does NOT need `BROKER_SECRET`. Instead, broker credentials are delivered to dev containers via a bind-mounted secrets file (`/secrets/broker-env.sh`). The dashboard only specifies the mount path in the container creation spec — it never reads or holds the secret value. This keeps the dashboard as a read-mostly observer with no production secrets.

### Research Insights: Architecture Validation

**Institutional knowledge confirms:** The env-var provisioning approach aligns with 3 documented solution patterns:
1. **Socket proxy security** (`docs/solutions/architecture-reviews/multi-agent-review-onboarding-heartbeat-infra.md`) — wollomatic regex matching is the correct choice. Tecnativa `POST=1` enables exec for all containers.
2. **ENV propagation** (`docs/solutions/integration-issues/metadata-propagation-and-credential-forwarding-across-layers.md`) — runtime config via compose `environment:` + write to `/etc/profile.d/` in CMD, not Dockerfile `RUN`.
3. **Shared module extraction** (`docs/solutions/architecture-reviews/code-review-cycle-2-systemic-patterns-and-prevention.md`) — Docker API logic duplicated between dashboard and MCP diverged in cycle 1. Both callers must use `src/docker-client.ts`.

## Architecture Decision: Env-Var Provisioning

### Why not exec?

The Docker proxy uses wollomatic with regex URL matching. Adding `exec` would enable arbitrary code execution in any container reachable through the proxy. Even with regex scoping, exec is a privileged operation that violates the principle of minimal proxy surface.

### How env-var provisioning works

```
Dashboard                    Docker Proxy              Docker Daemon
   |                              |                         |
   |-- POST /containers/create -->|---- create container -->|
   |   (with PROVISION_* env)     |                         |
   |                              |                         |
   |-- POST /containers/{id}/start ->|---- start --------->|
   |                              |                         |
   |                              |          Container CMD runs:
   |                              |          1. Read PROVISION_SSH_KEY → authorized_keys
   |                              |          2. Read PROVISION_NAME/EMAIL → git config
   |                              |          3. /secrets/broker-env.sh already mounted at /etc/profile.d/
   |                              |          4. ssh-keygen -A
   |                              |          5. exec sshd
```

**Proxy additions (2 rules only):**
```
-allowPOST=/v1\\..{1,2}/containers/create
-allowPOST=/v1\\..{1,2}/containers/.+/start
```

**Security of env vars:** SSH public keys are not sensitive. Name and email are not sensitive. Broker credentials are delivered via bind-mounted file, not env vars — the dashboard never touches them.

## Technical Approach

### Phase 1: Backend Infrastructure

#### 1a. Entrypoint script — `docker/dev-entrypoint.sh` (new file)

Extract the inline CMD from `Dockerfile.dev-container` into a proper entrypoint script. Add provisioning logic:

```bash
#!/bin/bash
set -euo pipefail

# Credential broker env vars: delivered via bind mount at /etc/profile.d/broker-env.sh
# The host's /secrets/broker-env.sh is mounted read-only into the container.
# SSH login sessions source /etc/profile.d/* automatically.
# No need to write broker credentials here — they arrive via the mount.

# Provisioning: SSH key (from dashboard wizard or manual injection)
if [ -n "${PROVISION_SSH_KEY:-}" ]; then
  # Defense-in-depth: validate key format even though dashboard validates too
  if printf '%s' "$PROVISION_SSH_KEY" | grep -qE '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-|sk-ssh-ed25519|sk-ecdsa-sha2-)'; then
    # Use printf %s (not echo) to avoid backslash interpretation
    printf '%s\n' "$PROVISION_SSH_KEY" >> /home/dev/.ssh/authorized_keys
    chown dev:dev /home/dev/.ssh/authorized_keys
    chmod 600 /home/dev/.ssh/authorized_keys
  else
    echo "WARNING: PROVISION_SSH_KEY does not look like a valid SSH public key, skipping" >&2
  fi
fi

# Provisioning: Git config
# CRITICAL: Write .gitconfig directly instead of su -c with string interpolation.
# su -c "git config '${VAR}'" is vulnerable to shell injection if VAR contains quotes.
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

### Research Insights: Entrypoint Security

**Shell injection (CRITICAL — flagged by 6 agents):** The original `su -c "git config --global user.name '${PROVISION_NAME}'"` allows injection if `PROVISION_NAME` contains single quotes (e.g., `O'Brien` or `'; rm -rf / #`). Three safe alternatives:
1. **Direct file write** (recommended, used above) — write `.gitconfig` directly, no shell interpretation at all
2. **`printf '%q'` quoting** — `su -s /bin/bash dev -c "git config --global user.name $(printf '%q' "$PROVISION_NAME")"`
3. **`git config --system`** — runs as root, applies to all users including dev

**`printf '%s'` vs `echo`**: `echo` interprets backslash sequences on some platforms. `printf '%s'` treats input as literal. Use `printf` for all variable output.

**`${VAR:-}` pattern**: With `set -u`, unset variables cause fatal errors. The `:-` default allows graceful handling of optional provisioning env vars.

**Signal handling**: `exec /usr/sbin/sshd -D -e` replaces the shell, making sshd PID 1. Docker SIGTERM goes directly to sshd. No `trap` or `tini` needed since sshd is designed for PID 1 child reaping.

**References:**
- [Docker Best Practices: RUN, CMD, ENTRYPOINT](https://www.docker.com/blog/docker-best-practices-choosing-between-run-cmd-and-entrypoint/)
- [PID 1 Signal Handling in Docker](https://petermalmgren.com/signal-handling-docker/)

#### 1b. Dockerfile.dev-container changes

Replace the inline CMD with the entrypoint script:

```dockerfile
COPY docker/dev-entrypoint.sh /usr/local/bin/dev-entrypoint.sh
RUN chmod +x /usr/local/bin/dev-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/dev-entrypoint.sh"]
```

Remove the old CMD line. Existing `create-dev-container.sh` continues to work (exec-based SSH injection still works alongside the entrypoint, authorized_keys uses append).

#### 1c. Docker compose changes — `docker-compose.yml`

Add 2 proxy rules:

```yaml
docker-proxy:
  command:
    # ...existing rules...
    - "-allowPOST=/v1\\..{1,2}/containers/create"
    - "-allowPOST=/v1\\..{1,2}/containers/.+/start"
```

Add env vars to dashboard service (no secrets — broker credentials delivered via bind mount):

```yaml
dashboard:
  environment:
    - DOCKER_PROXY_URL=http://docker-proxy:2375
    - DEV_NETWORK_NAME=tinyclaw_dev
    - DASHBOARD_HOST=<server-hostname>
```

Create `/secrets/broker-env.sh` on the host (one-time setup):

```bash
# /secrets/broker-env.sh — mounted into dev containers at /etc/profile.d/broker-env.sh
export CREDENTIAL_BROKER_URL=http://broker:3000
export BROKER_SECRET=<actual-secret>
```

### Research Insights: Proxy Scope

The proxy rules allow creating/starting ANY container, not just dev containers. The application layer constrains this (only creates `dev-*` containers with `tinyclaw.type=dev-container` label). This matches the existing pattern — `allowPOST` for memory update also allows updating any container. Defense-in-depth is at the application layer.

**Fail-fast validation at startup:** Dashboard should check `DEV_NETWORK_NAME` and `DASHBOARD_HOST` are set at startup. If missing, log a warning. In the creation handler, return 503 if not configured.

#### 1d. Docker client additions — `src/docker-client.ts`

New function: `createDevContainer()`

**Separate user input from infrastructure config:**

```typescript
// Branded types — parse functions return these, making unvalidated input impossible
type SSHPublicKey = string & { readonly __brand: "SSHPublicKey" };
type DevName = string & { readonly __brand: "DevName" };
type DevEmail = string & { readonly __brand: "DevEmail" };

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
  // No brokerSecret — delivered via bind-mounted /secrets/broker-env.sh
}

interface CreateContainerResult {
  containerId: string;
  name: string;        // "dev-alice"
  port: number;
  host: string;
}
```

### Research Insights: Type Safety

**Branded types (HIGH — TypeScript reviewer):** The original `validate*(): void` pattern gives no type-level guarantee that validation occurred. After calling `validateSSHPublicKey(key)`, `key` is still `string`. With branded types, `createDevContainer()` physically cannot be called with unvalidated input — the compiler enforces it.

```typescript
function parseSSHPublicKey(raw: string): SSHPublicKey {
  const trimmed = raw.trim();
  if (trimmed.includes("PRIVATE KEY") || trimmed.includes("-----BEGIN")) {
    throw new ValidationError("This looks like a PRIVATE key. Paste your PUBLIC key (.pub file).");
  }
  if (Buffer.byteLength(trimmed, "utf8") > 8192) {
    throw new ValidationError("SSH key exceeds 8KB limit.");
  }
  // Single line only (authorized_keys is line-based)
  if (trimmed.split("\n").filter(l => l.length > 0).length !== 1) {
    throw new ValidationError("SSH public key must be a single line.");
  }
  // Validate type prefix + base64 data prefix match
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
  if (!validTypes[keyType]) {
    throw new ValidationError(`Unrecognized key type "${keyType}".`);
  }
  if (!base64Data.startsWith(validTypes[keyType])) {
    throw new ValidationError("Key data does not match type. The key may be corrupted.");
  }
  return trimmed as SSHPublicKey;
}
```

**Base64 prefix validation** is the critical differentiator vs. just checking the type prefix string. It catches corrupted keys, truncated copies, and type/data mismatches. This technique is derived from the OpenSSH wire format — each key type's base64 encoding starts with a known prefix.

**Module placement:** `parseSSHPublicKey()` and `parseDevEmail()` belong in `types.ts` (general validation, no Docker dependency). `parseDevName()` belongs in `docker-client.ts` (produces Docker container names). This follows the existing convention where `isValidContainerId` is in `docker-client.ts` and `isValidSessionId` is in `types.ts`.

**Implementation of `createDevContainer()`:**
1. `POST /containers/create?name=dev-${name}` via `fetchDockerJson<{Id: string; Warnings: string[]}>()` with full container spec
2. `POST /containers/{id}/start` — **NOTE:** returns 204 with no body. `fetchDockerJson` calls `resp.json()` which fails on empty response. Use raw `fetch()` for start call with `signal: AbortSignal.timeout(30_000)`.
3. Return structured result (no pre-rendered SSH config — that's a presentation concern)

**Separate `formatSSHConfig()` utility:**

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

### Research Insights: Container Creation Spec

**Full container spec with hardening (from Docker Engine API docs + OWASP):**

```typescript
const containerSpec = {
  Image: "tinyclaw-dev",
  Hostname: `dev-${name}`,
  Env: [
    `PROVISION_SSH_KEY=${sshPublicKey}`,
    `PROVISION_NAME=${name}`,
    `PROVISION_EMAIL=${email}`,
    // No broker credentials here — delivered via bind mount below
  ],
  ExposedPorts: { "22/tcp": {} },
  Labels: {
    "tinyclaw.type": "dev-container",       // REQUIRED: Memory view queries this
    "tinyclaw.created-by": "onboarding-wizard",
    "tinyclaw.created-at": new Date().toISOString(),
    "tinyclaw.dev-name": name,
    "tinyclaw.dev-email": email,
  },
  HostConfig: {
    Memory: 2 * 1024 * 1024 * 1024,        // 2GB
    MemorySwap: 2 * 1024 * 1024 * 1024,    // same = no swap
    NanoCPUs: 2 * 1e9,                      // 2 CPUs
    PidsLimit: 256,                          // prevent fork bombs (OWASP)
    CapDrop: ["NET_RAW"],                    // drop raw sockets
    SecurityOpt: ["no-new-privileges"],      // prevent setuid escalation (OWASP)
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
    EndpointsConfig: {
      [networkName]: {},
    },
  },
};
```

**New vs. original plan:**
- Added `SecurityOpt: ["no-new-privileges"]` — prevents setuid escalation inside container
- Added `PidsLimit: 256` — prevents fork bombs
- Added `LogConfig` — prevents unbounded log growth
- Added `/secrets/github-installations.json` bind mount — **critical omission in original plan** (without this, git/gh breaks)
- Added `tinyclaw.created-by` and `tinyclaw.dev-email` labels — enables auditing

**Docker API error handling:**
- 201: success `{ Id, Warnings }` — check `Warnings[]` and log
- 404: image not found or network not found — surface specific error message to user
- 409: container name already exists — return 400 to wizard
- 500: daemon error — return 502 to wizard

**References:**
- [Docker Engine API Container Creation](https://docs.docker.com/engine/api/v1.33/)
- [OWASP Docker Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html)

### Research Insights: Performance

**O(1) Port Scanning (HIGH — Performance Oracle):**

The original plan's `getNextAvailablePort()` scans all containers with N inspect calls. The Docker `/containers/json` list API already returns `Ports` in the response. Use a single list call for both port scanning and name resolution:

```typescript
// Single API call — reused for both port scan and name resolution
const containers = await fetchDockerJson<Array<{
  Names: string[];
  Ports: Array<{ PublicPort?: number }>;
}>>(
  baseUrl,
  '/containers/json?all=true&filters={"label":["tinyclaw.type=dev-container"]}',
);

// Port scan: build Set of occupied ports from single list response
const occupied = new Set<number>();
for (const c of containers) {
  for (const p of c.Ports || []) {
    if (p.PublicPort && p.PublicPort >= 2201 && p.PublicPort <= 2299) {
      occupied.add(p.PublicPort);
    }
  }
}

// Name resolution: check existing names from same response
const existingNames = new Set(
  containers.flatMap(c => c.Names.map(n => n.replace(/^\//, ""))),
);
```

| Containers | Original Plan | Optimized |
|---|---|---|
| 10 | 1 + 10 = 11 API calls | 1 API call |
| 50 | 1 + 50 = 51 API calls | 1 API call |
| 99 | 1 + 99 = 100 API calls | 1 API call |

**Creation mutex (HIGH — Performance Oracle + Spec Flow Analyzer):**

Two simultaneous wizard submissions could claim the same port/name. Add in-process mutex:

```typescript
let creationInProgress = false;

// In handler:
if (creationInProgress) {
  res.status(429).json({ error: "Another container is being created. Try again in a few seconds." });
  return;
}
creationInProgress = true;
try { /* ...creation flow... */ } finally { creationInProgress = false; }
```

**Timeout escalation:** Use `AbortSignal.timeout(30_000)` for create and start calls (the default 10s may be too short if Docker needs to extract image layers).

New function: `getNextAvailablePort()`

Uses the single container list call (above) to find lowest available port in 2201-2299. Throws `ValidationError` if range exhausted.

New function: `resolveContainerName()`

If `dev-<name>` exists, tries `dev-<name>-2`, `dev-<name>-3`, etc. Uses same container list call.

**Validation functions (in `types.ts`):**

```typescript
// SSH public key: recognized type prefix + base64 prefix match, single line, max 8KB
function parseSSHPublicKey(key: string): SSHPublicKey

// Email: basic format check (contains @), trimmed
function parseDevEmail(email: string): DevEmail
```

**Validation functions (in `docker-client.ts`):**

```typescript
// Name: lowercase alphanumeric + hyphens, starts with letter, max 32 chars
function parseDevName(name: string): DevName
```

#### 1e. Dashboard API — `src/onboarding-routes.ts` (new file)

### Research Insights: Module Organization

**Extract to separate file (HIGH — TypeScript reviewer):** `dashboard.ts` is already 730 lines with 20+ routes. Adding 3 new routes with 30-50 lines of creation logic would bloat it further. Extract to `src/onboarding-routes.ts` using Express Router:

```typescript
// src/onboarding-routes.ts
import { Router } from "express";
import { z } from "zod";

export function createOnboardingRouter(config: {
  staticDir: string;
  dockerProxyUrl: string;
  networkName: string;
  brokerSecret: string;
  dashboardHost: string;
}): Router {
  const router = Router();
  // ... routes defined here ...
  return router;
}

// In dashboard.ts (3 lines):
import { createOnboardingRouter } from "./onboarding-routes.js";
app.use(createOnboardingRouter({ staticDir: STATIC_DIR, /* ... */ }));
```

**New route: `GET /onboarding`**

```typescript
router.get("/onboarding", (_req, res) => {
  const htmlPath = path.join(config.staticDir, "onboarding.html");
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.status(404).send("Onboarding wizard not found. Place static/onboarding.html.");
  }
});
```

Note: includes `fs.existsSync()` check matching existing `GET /` pattern.

**New endpoint: `GET /api/identity`**

Returns the authenticated user's email from Cloudflare Access headers:

```typescript
router.get("/api/identity", (req, res) => {
  const raw = req.headers["cf-access-authenticated-user-email"];
  const email = typeof raw === "string" ? raw : "";
  res.json({ email });
});
```

Note: uses `typeof` check instead of `as string` assertion (the assertion on `undefined` produces `"undefined"` which is truthy, so the `|| ""` fallback never triggers).

**New endpoint: `POST /api/containers/create`**

Accepts: `{ name: string, email: string, sshPublicKey: string }`

```typescript
// Zod at I/O boundary (project convention)
const CreateContainerRequestSchema = z.object({
  name: z.string().min(1).max(64),
  email: z.string().min(1).max(256),
  sshPublicKey: z.string().min(1).max(16384),
});
```

Flow:
1. Zod-validate request body shape (`safeParse`)
2. Parse inputs with branded type functions (parseDevName, parseDevEmail, parseSSHPublicKey)
3. Fetch container list (single call, for both port and name resolution)
4. Resolve unique container name
5. Get next available port
6. Call `createDevContainer()` from docker-client
7. Return `{ containerId, name, port, host, sshConfig }` (sshConfig built by `formatSSHConfig()`)

Error handling pattern (matching existing `POST /api/containers/:id/memory`):

```typescript
} catch (err) {
  const msg = toErrorMessage(err);
  const status = err instanceof ValidationError ? 400 : 502;
  res.status(status).json({ error: msg });
}
```

Error responses:
- 400: validation errors (bad name, invalid key, port range exhausted, name collision)
- 429: another creation in progress (mutex)
- 502: Docker API failures (image not found, network not found)
- 503: not configured (missing BROKER_SECRET or DEV_NETWORK_NAME)

#### 1f. MCP tool parity — `src/mcp-tools.ts`

New tool: `create_dev_container` (master thread only, behind `sourceThreadId === 1` guard)

### Research Insights: MCP Tool Implementation

**Must use `tool()` with Zod (CRITICAL — pattern consistency):** Every existing tool uses the SDK's `tool()` function. Raw JSON Schema loses runtime validation, Zod type inference, and consistency.

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
      // ... port resolution, name resolution, container creation
      const result = await createDevContainerFn(
        { name: parsedName, email: parsedEmail, sshPublicKey: parsedKey },
        infraConfig,
      );
      const sshConfig = formatSSHConfig(result);
      return { content: [textContent(
        `Container ${result.name} created on port ${result.port}\n\n${sshConfig}`
      )] };
    } catch (err) {
      const msg = toErrorMessage(err);
      return { content: [textContent(`Failed to create container: ${msg}`)], isError: true };
    }
  },
);

// Registration (master-only guard):
if (sourceThreadId === 1) {
  tools.push(updateContainerMemory, getHostMemory, createDevContainer);
}
```

**Note:** Uses `sshPublicKey` (camelCase) not `ssh_public_key` (snake_case) — matching existing parameter naming convention (`targetThreadId`, `containerName`).

**Agent-native parity checklist (from agent-native reviewer):**
- [ ] Tool must return containerId, name, port, host, AND full SSH config snippet
- [ ] Tool uses same `createDevContainer()` from `docker-client.ts` as dashboard endpoint (shared code path)
- [ ] Tool catches all errors and returns `{ isError: true }` — never throws
- [ ] Add tool description to `buildMcpToolsBlock` in `session-manager.ts`:
  ```typescript
  "- `create_dev_container` — Create a new dev container (name, email, SSH key) [master-only]",
  ```
- [ ] The agent collects name, email, and SSH key conversationally from Telegram — no `/api/identity` equivalent needed

**Pre-existing prompt bug to fix:** `get_container_stats` and `get_system_status` are available to all threads in code (line 319 of mcp-tools.ts) but documented only in the master block of `buildMcpToolsBlock`. Move their descriptions to the all-threads section.

### Phase 2: Frontend Wizard — `static/onboarding.html`

Standalone HTML file. Dark theme matching dashboard (same CSS variables). No framework.

**Wizard state machine:**

```javascript
// States
const SLIDE_IDLE = Symbol('idle');
const SLIDE_TRANSITIONING = Symbol('transitioning');
const CREATION_IDLE = Symbol('idle');
const CREATION_INFLIGHT = Symbol('inflight');
const CREATION_DONE = Symbol('done');
const CREATION_ERRORED = Symbol('errored');

const wizard = {
  currentSlide: 0,
  slideState: SLIDE_IDLE,
  creationState: CREATION_IDLE,
  sshPublicKey: '',
  name: '',
  email: '',
  result: null,
  error: null
};
```

### Research Insights: Frontend State Machine

**A proper state machine eliminates 6 of 10 frontend race conditions** identified by the races reviewer. Every user action checks the state before proceeding:

```javascript
function canAdvance() {
  if (wizard.slideState !== SLIDE_IDLE) return false;
  if (wizard.currentSlide === 5 && wizard.creationState === CREATION_INFLIGHT) return false;
  return true;
}

function canGoBack() {
  if (wizard.slideState !== SLIDE_IDLE) return false;
  if (wizard.creationState === CREATION_INFLIGHT) return false;
  if (wizard.creationState === CREATION_DONE) return false;
  return true;
}
```

**7 slides, CSS transitions between them.** Progress dots at bottom.

| Slide | Content | Interactions |
|-------|---------|-------------|
| 0: Welcome | Hero illustration, headline, description | [Get Started] → slide 1 |
| 1: SSH Key Check | Key illustration, yes/no choice | [Yes] → slide 3, [No] → slide 2 |
| 2: SSH Guide | Terminal illustration, Mac ed25519 + keychain steps, expandable alternatives | [I've created my key] → slide 3 |
| 3: Upload Key | Upload illustration, paste textarea, validation feedback | [Next] → slide 4 (if valid) |
| 4: About You | Profile illustration, name + email fields | [Create My Container] → slide 5 |
| 5: Creating | Progress illustration, animated step list | Auto-advance on success, error + retry on failure |
| 6: You're In | Celebration illustration, SSH config with copy button | [Open Dashboard] → dashboard `#memory` |

**Key frontend behaviors:**

- **On load:** call `GET /api/identity` to pre-fill email. **Only pre-fill if field is empty and not focused** — don't clobber user typing if the fetch is slow.
- **SSH key validation:** Client-side check + server-side re-validation. Client uses lightweight regex; server uses full `parseSSHPublicKey()`. **Re-validate from input value on submit, not from cached validation state.**
- **Name sanitization preview:** as user types, show sanitized version below input. **Read from input element on submit, not from preview DOM.**
- **Creation call:** `POST /api/containers/create`. **Guard with creation state machine — CREATION_INFLIGHT rejects all clicks. CREATION_DONE is terminal.** Show indeterminate progress animation (not fake timed steps). On error, show message with [Retry] that resets to CREATION_IDLE.
- **Copy to clipboard:** `navigator.clipboard.writeText()` with visual feedback. **Cancel previous timer before starting new one. Add try-catch for HTTP contexts where Clipboard API is unavailable.**
- **Keyboard navigation:** Enter advances, Escape goes back. **Enter in textarea must NOT advance slides (SSH keys can span for RSA). Only the [Next] button should advance from slide 3.** Escape/Enter respect state machine (no nav during creation or after completion).
- **No back navigation past creation** — once container is created, can't undo

### Research Insights: Frontend Race Conditions

**10 race conditions identified and mitigated:**

| # | Race Condition | Severity | Mitigation |
|---|---|---|---|
| 1 | Double-submit creates orphan containers | CRITICAL | Creation state machine: IDLE → INFLIGHT → DONE (terminal) |
| 2 | CSS transitions overlap on rapid navigation | HIGH | Use instant transitions (display: none/block or 32ms opacity) or gate on transitionend |
| 3 | Identity fetch clobbers user typing | MEDIUM | Only pre-fill if field empty and not focused |
| 4 | Name preview DOM used as source of truth | MEDIUM | Read from input element on submit |
| 5 | Copy timer stacking | MEDIUM | clearTimeout before starting new timer |
| 6 | Escape goes back during creation in-flight | HIGH | canGoBack() checks creationState |
| 7 | Enter in textarea advances slide | HIGH | Check e.target.tagName !== 'TEXTAREA' |
| 8 | Focus set before transition completes | MEDIUM | manageFocus() in transitionend handler |
| 9 | Timed progress diverges from API latency | MEDIUM | Use indeterminate animation, not fake steps |
| 10 | Stale fetch response | LOW | Guard with creationState check after every await |

**Slide transition recommendation:** Use `display: none / display: block` (matching existing dashboard pattern at `static/dashboard.html:99`) or `opacity` with 32ms transition. At 32ms, even fastest keyboard repeat (30ms) cannot fire twice within one transition.

```css
.slide { opacity: 0; transition: opacity 32ms ease; pointer-events: none; position: absolute; }
.slide.active { opacity: 1; pointer-events: auto; position: relative; }

@media (prefers-reduced-motion: reduce) {
  .slide { transition: none; }
}
```

**Focus management:** Set focus after transition completes. Hidden slides must have `aria-hidden="true"` to prevent tab-into. Use `preventScroll: true` on `focus()` calls.

### Research Insights: Accessibility

- **`aria-live="polite"` on step counter** — screen readers announce "Step 3 of 7" on change
- **`aria-hidden="true"` on inactive slides** — prevents reading hidden content
- **`aria-describedby` on inputs linked to error messages** — announces errors when field focused
- **`@media (prefers-reduced-motion: reduce)`** — mandatory per WCAG 2.3.3, disables animations
- **Visible focus indicators** — never `outline: none` without custom focus style

**References:**
- [W3C ARIA Keyboard Interface Practices](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)
- [Creating Effective Multistep Forms (Smashing Magazine, Dec 2024)](https://www.smashingmagazine.com/2024/12/creating-effective-multistep-form-better-user-experience/)

**SSH config template (slide 6):**

```
Host tinyclaw-<name>
  HostName <server>
  Port <port>
  User dev
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 30
  ServerAliveCountMax 5
```

Note: Detect key type from pasted public key and set IdentityFile accordingly (`ssh-rsa` → `~/.ssh/id_rsa`, `ssh-ed25519` → `~/.ssh/id_ed25519`).

### Research Insights: UX Edge Cases

**Returning users:** If a user visits `/onboarding` after already creating a container, the wizard creates another one. Consider storing creation result in `localStorage` keyed by email and showing "You already have a container" with SSH config on load. This prevents accidental sprawl and gives users a config recovery path.

**Browser refresh mid-wizard:** All state is in-memory. If user refreshes after creation but before copying SSH config, the config is lost. Store creation result in `localStorage` after success. On load, check for existing result and skip to slide 6 if found.

**SSH guide content for non-Mac:** Define expandable alternatives:
- **Linux:** `ssh-keygen -t ed25519 -C "your-email"`, `eval "$(ssh-agent -s)"`, `ssh-add ~/.ssh/id_ed25519`
- **Windows (PowerShell):** `ssh-keygen -t ed25519 -C "your-email"`, `Get-Content ~/.ssh/id_ed25519.pub | clip`

**Clipboard fallback:** `navigator.clipboard.writeText()` requires HTTPS. In local dev over HTTP, add fallback with `document.execCommand('copy')` using temporary textarea, or show "Press Ctrl+C to copy" with text pre-selected.

**Image not found error:** Parse Docker 404 response and show specific message: "The dev container image has not been built yet. Ask your admin to run: `docker build -t tinyclaw-dev -f Dockerfile.dev-container .`"

### Phase 3: Illustrations

Generate 7 illustrations using Gemini API (free tier). Style: playful & warm, friendly with character, bright colors (Notion/Slack onboarding aesthetic).

Commit to `static/onboarding/` as PNG files:
- `welcome.png` — claw machine / mascot hero
- `ssh-check.png` — key / lock concept
- `ssh-guide.png` — terminal / Mac
- `upload-key.png` — uploading / sharing
- `about-you.png` — people / profile
- `creating.png` — building / constructing
- `success.png` — celebration

Target: ~400x300px, optimized for web. Generate with `/gemini-imagegen` skill.

### Research Insights: Illustrations

**Code simplicity reviewer assessment:** Illustrations are scope creep for a <10 person tool. The wizard works without them. Consider:
- Ship Phase 1-2 first without illustrations (clean dark form with CSS variables is sufficient)
- Add illustrations as an optional polish pass in a follow-up PR
- Use `loading="lazy"` on all images except slide 0 to reduce initial page load
- Consider WebP format for 30-50% size reduction over PNG

### Phase 4: Integration & Testing

- Rebuild dev container image (`docker build -t tinyclaw-dev -f Dockerfile.dev-container .`)
- Rebuild dashboard image (`docker compose build dashboard`)
- Restart docker-proxy to pick up new rules
- End-to-end test: visit `/onboarding`, complete wizard, verify SSH access
- Verify existing `create-dev-container.sh` still works (backward compatible)
- Verify Memory view shows new container
- Test error states: bad SSH key, duplicate name, port exhaustion, Docker API failure

### Research Insights: Testing Checklist

**Security tests:**
- Paste private key — should be rejected with clear message
- Paste key with shell metacharacters — should not execute
- Submit name with single quotes, backticks, `$()` — should be sanitized
- Verify `no-new-privileges` is set on created container
- Verify `PidsLimit` is set on created container

**Race condition tests (use DevTools Network throttling):**
1. Set 3s response delay. Click [Create] twice rapidly. Should not create 2 containers.
2. Set CSS transition to 2000ms. Hammer Enter 3 times. Should not overlap slides.
3. Set `/api/identity` to 5s delay. Navigate to slide 4 quickly, start typing email. Should not be clobbered.
4. Open page over `http://`. Click [Copy]. Should show fallback behavior.
5. On SSH key slide, press Enter in textarea. Should insert newline, not advance.
6. Start creation. Press Escape immediately. Should not go back.

**Full provisioning chain:**
- Container created with PROVISION_* env vars
- SSH into container without password
- `git config user.name` shows correct value
- `gh auth status` works (broker credentials available via /etc/profile.d/)
- `/secrets/github-installations.json` is mounted and readable

## Acceptance Criteria

### Functional
- [ ] `/onboarding` serves the wizard page
- [ ] Wizard collects name, email, SSH public key across slides
- [ ] SSH key creation guide shows Mac ed25519 + keychain instructions
- [ ] Container is created with correct labels, network, memory, ports
- [ ] SSH key is installed and usable immediately after creation
- [ ] Git config is set inside container (user.name + user.email)
- [ ] SSH config snippet is displayed with copy button
- [ ] Email is pre-filled from Cloudflare Access header when available
- [ ] Container appears in Memory dashboard view after creation
- [ ] Duplicate names are handled (auto-increment suffix)
- [ ] Port auto-assignment from 2201-2299 range

### Error Handling
- [ ] Invalid SSH key shows clear error message
- [ ] Port range exhaustion shows clear error
- [ ] Docker API failures show error with retry option
- [ ] Private key paste is rejected with warning
- [ ] Image not found shows admin-actionable error message
- [ ] Missing DEV_NETWORK_NAME returns 503 at creation endpoint
- [ ] Concurrent creation returns 429

### Security
- [ ] No exec endpoint added to Docker proxy
- [ ] SSH public key validated (type prefix + base64 prefix match, single line, max 8KB)
- [ ] Name sanitized (alphanumeric + hyphens only) before use in container name
- [ ] No XSS from user input in wizard UI (escapeHtml on all rendered values)
- [ ] Entrypoint script does NOT use `su -c` with string-interpolated env vars
- [ ] Container created with `no-new-privileges` and `PidsLimit`
- [ ] `/secrets/github-installations.json` bind-mounted read-only

### Backward Compatibility
- [ ] `create-dev-container.sh` still works for CLI provisioning
- [ ] Existing containers unaffected by Dockerfile changes
- [ ] Dashboard memory view unchanged

### Pattern Consistency
- [ ] MCP tool uses SDK `tool()` with Zod schemas
- [ ] MCP tool error handler uses `textContent()` + `isError: true`
- [ ] POST endpoint uses Zod `safeParse()` at I/O boundary
- [ ] Error dispatch uses `instanceof ValidationError` for 400 vs 502
- [ ] All catch blocks use `toErrorMessage(err)`
- [ ] Branded types (`SSHPublicKey`, `DevName`, `DevEmail`) prevent unvalidated input

## Simplifications Applied

1. **No Telegram notification** on container creation — admin sees it in Memory view
2. **No container health verification** in wizard — just show connection details
3. **No WebSocket for creation progress** — single API call returns in <5s, progress animation is UX sugar
4. **No undo/delete from wizard** — admin manages lifecycle
5. **No mobile responsiveness** — developer tool, desktop-only
6. **Image must be pre-built** — admin runs `docker build` on host before first wizard use
7. **No rate limiting** on creation endpoint — Cloudflare Access is the gate, plus in-process mutex prevents concurrent creation

## Files Changed

| File | Change | New/Modified |
|------|--------|-------------|
| `docker/dev-entrypoint.sh` | Entrypoint with provisioning logic (safe git config) | New |
| `Dockerfile.dev-container` | Use entrypoint script instead of inline CMD | Modified |
| `docker-compose.yml` | Add proxy rules + dashboard env vars | Modified |
| `src/docker-client.ts` | Add createDevContainer, port assignment, name resolution | Modified |
| `src/types.ts` | Add parseSSHPublicKey, parseDevEmail, branded types | Modified |
| `src/onboarding-routes.ts` | Onboarding routes (GET /onboarding, GET /api/identity, POST /api/containers/create) | New |
| `src/dashboard.ts` | Mount onboarding router (3 lines) | Modified |
| `src/mcp-tools.ts` | Add create_dev_container tool (master-only) | Modified |
| `src/session-manager.ts` | Add create_dev_container to buildMcpToolsBlock, fix read-only tool docs | Modified |
| `static/onboarding.html` | Full wizard page with state machine | New |
| `static/onboarding/*.png` | 7 Gemini-generated illustrations (optional Phase 3) | New |

## Dependencies & Prerequisites

- `tinyclaw-dev` Docker image must be pre-built on host
- `/secrets/broker-env.sh` must exist on host (contains CREDENTIAL_BROKER_URL + BROKER_SECRET exports)
- Dashboard hostname must be configured (`DASHBOARD_HOST` env var)
- Dev network must exist (created by `docker compose up`)
- `DEV_NETWORK_NAME` env var must match actual Docker network name (validate at startup)

## References

- Brainstorm: `docs/brainstorms/2026-02-12-dashboard-onboarding-wizard-brainstorm.md`
- Docker client: `src/docker-client.ts`
- Dashboard: `src/dashboard.ts`
- Existing creation script: `scripts/create-dev-container.sh`
- Dev container image: `Dockerfile.dev-container`
- Docker proxy config: `docker-compose.yml:53-76`
- Onboarding docs: `docs/onboarding/getting-started.md`
- SSH config template: `docs/onboarding/ssh-config-snippet.txt`
- Architecture review: `docs/solutions/architecture-reviews/multi-agent-review-onboarding-heartbeat-infra.md`
- Credential forwarding: `docs/solutions/integration-issues/metadata-propagation-and-credential-forwarding-across-layers.md`
- Code review patterns: `docs/solutions/architecture-reviews/code-review-cycle-2-systemic-patterns-and-prevention.md`
- Docker Engine API: https://docs.docker.com/engine/api/v1.33/
- OWASP Docker Security: https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html
- SSH Key Best Practices: https://www.brandonchecketts.com/archives/ssh-ed25519-key-best-practices-for-2025
- Accessible Multistep Forms: https://www.smashingmagazine.com/2024/12/creating-effective-multistep-form-better-user-experience/
- W3C ARIA Keyboard Practices: https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/
