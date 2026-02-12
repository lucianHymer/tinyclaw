---
title: "Agent-Driven Dev Container Lifecycle Management"
date: 2026-02-12
category: architecture-reviews
component: dev-container-provisioning
problem_type: architecture-redesign
tags:
  - docker-api
  - mcp-tools
  - security-hardening
  - agent-native-parity
  - credential-forwarding
  - entrypoint-provisioning
  - socket-proxy-security
  - branded-types
severity: medium
related_files:
  - src/docker-client.ts
  - src/mcp-tools.ts
  - src/types.ts
  - src/session-manager.ts
  - docker/dev-entrypoint.sh
  - Dockerfile.dev-container
  - docker-compose.yml
  - scripts/create-dev-container.sh
---

# Agent-Driven Dev Container Lifecycle Management

## Problem Statement

Container provisioning was CLI-only via `scripts/create-dev-container.sh`. The original plan proposed a 7-slide dashboard wizard UI for developer onboarding. After deepening, this was identified as the wrong UX: a web form adds complexity (state machine, race conditions, new endpoints, secrets handling) for a 3-field interaction that the agent handles conversationally.

## Architecture Decision: Why Agent-Only?

| Decision | Rationale |
|----------|-----------|
| **Agent-driven (not dashboard wizard)** | Chat agent is better UX for 3-field collection. No frontend state machine, no new dashboard secrets, no race conditions. |
| **Env-var provisioning (not exec)** | Exec endpoint enables arbitrary code execution in any container through the socket proxy. Env vars at create time + entrypoint parsing is safer. |
| **Branded types for validation** | Compile-time safety prevents unvalidated input from reaching Docker API. Parse functions act as boundaries. |
| **Direct .gitconfig write (not `su -c`)** | Eliminates shell injection risk entirely. No string interpolation in privileged context. |
| **Bind-mounted broker-env.sh** | Docker ENV vars don't propagate to SSH sessions. Mounted file is sourced by `/etc/profile.d/` for all login shells. |
| **Two-phase error handling** | Distinguish "created but failed to start" (retry start) from "creation failed" (different issue). |
| **Master-only MCP tools** | Lifecycle mutations guarded by `sourceThreadId === 1`. Read-only tools available to all threads. |

## Implementation Patterns

### 1. Branded Types at Validation Boundaries

TypeScript branded types (`SSHPublicKey`, `DevName`, `DevEmail`) make unvalidated input impossible to pass to Docker API functions. Parse functions are the only way to obtain branded types:

```typescript
export type SSHPublicKey = string & { readonly __brand: "SSHPublicKey" };

export function parseSSHPublicKey(raw: string): SSHPublicKey {
    const trimmed = raw.trim();
    // Layer 1: Private key detection
    if (trimmed.includes("PRIVATE KEY") || trimmed.includes("-----BEGIN")) {
        throw new ValidationError("This looks like a PRIVATE key. Paste your PUBLIC key (.pub file).");
    }
    // Layer 2: Size limit (8KB)
    // Layer 3: Single-line check
    // Layer 4: Key type whitelist
    // Layer 5: Base64 prefix match (catches corrupted keys)
    return trimmed as SSHPublicKey;
}
```

**Future extensions must follow this pattern**: any function accepting external input needs a corresponding parse function returning a branded type.

### 2. Defense-in-Depth Validation (4 Layers)

1. **MCP Tool Layer** — Zod schemas enforce string types
2. **Parse Functions** — Business logic validation (key format, email regex, name constraints)
3. **Docker Client** — Container ID regex check before API path construction
4. **Entrypoint Script** — Re-validates SSH key format (defense against compromised bot process)

### 3. O(1) Port Scanning

Single Docker list call with label filter replaces N inspect calls:

```typescript
const containers = await fetchDockerJson(baseUrl,
    '/containers/json?all=true&filters={"label":["tinyclaw.type=dev-container"]}');
const occupied = new Set<number>();
for (const c of containers) {
    for (const p of c.Ports || []) {
        if (p.PublicPort >= 2201 && p.PublicPort <= 2299) occupied.add(p.PublicPort);
    }
}
```

### 4. Label-Verified Destructive Operations

Delete inspects the container and verifies `tinyclaw.type=dev-container` label before allowing removal. Prevents accidental deletion of unrelated containers even if name resolution has a bug.

### 5. Two-Phase Error Handling

```typescript
try {
    const result = await createDevContainerFn(...);
    try {
        await startContainer(DOCKER_PROXY_URL, result.containerId);
    } catch (startErr) {
        // Container exists but didn't start — user can retry via start_dev_container
        return { content: [textContent(`Created but failed to start: ...`)], isError: true };
    }
} catch (err) {
    // Creation failed entirely — different debugging path
    return { content: [textContent(`Failed to create: ...`)], isError: true };
}
```

## Security Measures

| Measure | Location | Purpose |
|---------|----------|---------|
| No exec endpoint | `docker-compose.yml` proxy rules | Prevents arbitrary code execution in containers |
| `no-new-privileges` | Container spec `SecurityOpt` | Prevents setuid escalation |
| `PidsLimit: 256` | Container spec `HostConfig` | Fork bomb protection |
| `CapDrop: ["NET_RAW"]` | Container spec `HostConfig` | Disables raw socket access |
| Private key detection | `parseSSHPublicKey()` + entrypoint | Rejects paste of private keys with clear error |
| Base64 prefix validation | `parseSSHPublicKey()` | Catches corrupted/truncated keys |
| Safe git config write | `dev-entrypoint.sh` | `printf '%s'` instead of `su -c` with interpolation |
| Read-only bind mounts | Container spec `Binds` | Secrets files cannot be modified by container |
| Container ID validation | `isValidContainerId()` | Rejects path traversal in Docker API paths |
| SSH hardening | `Dockerfile.dev-container` | No passwords, no forwarding, MaxAuthTries 3 |

## Backward Compatibility

The entrypoint preserves compatibility with `scripts/create-dev-container.sh` via a fallback:

```bash
# MCP-created containers: broker-env.sh arrives via bind mount
# CLI-created containers: env vars set, no bind mount — write the file
if [ ! -f /etc/profile.d/broker-env.sh ] && [ -n "${CREDENTIAL_BROKER_URL:-}" ]; then
  printf 'export CREDENTIAL_BROKER_URL=%s\nexport BROKER_SECRET=%s\n' \
    "$CREDENTIAL_BROKER_URL" "${BROKER_SECRET:-}" > /etc/profile.d/broker-env.sh
fi
```

Both paths append to `authorized_keys` (using `>>`), so CLI and MCP provisioning coexist.

## Systemic Patterns Addressed

| Pattern (from Memory) | Status |
|----------------------|--------|
| **Code duplication** (#1 recurring risk) | All Docker logic in `src/docker-client.ts`. MCP tools call shared functions, never reimplement. |
| **Agent-native parity gap** | Every container operation available as MCP tool. Read-only for all threads, mutations master-only. |
| **Input validation at path boundaries** | Branded types + regex validation + entrypoint defense-in-depth. |
| **Atomic writes** | Queue writes use `.tmp` + `renameSync` pattern. |

## Risks to Monitor

| Risk | Monitoring | Mitigation |
|------|-----------|------------|
| Port exhaustion (99 ports) | `get_container_stats` shows ports | Error on full range; expand 2201-2299 if needed |
| Image not built | Docker API error caught | Agent sees "tinyclaw-dev image not built" |
| Network missing | Docker API error caught | Network created by `docker compose up` |
| Memory overallocation | `get_host_memory` shows capacity | Allocation check before create (host total - 2GB OS reserve) |
| Concurrent creation race | Single master thread serializes | Add idempotency if multi-threaded later |

## Files Changed

| File | Change | Type |
|------|--------|------|
| `docker/dev-entrypoint.sh` | Entrypoint with SSH key + git config provisioning | New |
| `Dockerfile.dev-container` | Use entrypoint script instead of inline CMD | Modified |
| `docker-compose.yml` | 4 proxy rules (create, start, stop, delete) + 2 env vars | Modified |
| `src/types.ts` | SSHPublicKey, DevName, DevEmail branded types + parsers | Modified |
| `src/docker-client.ts` | Container CRUD, port scanning, name resolution, formatSSHConfig | Modified |
| `src/mcp-tools.ts` | 4 lifecycle MCP tools (master-only), SSH port in stats | Modified |
| `src/session-manager.ts` | buildOnboardingBlock(), fixed buildMcpToolsBlock | Modified |

## Deferred to Phase 2

- `get_container_logs` tool (requires `GET /containers/{id}/logs` proxy rule)
- Per-user quotas for multi-tenant support
- Auto-stop idle containers

## Cross-References

- [Docker Architecture Plan](../../plans/2026-02-10-feat-production-docker-dashboard-broker-plan.md) — Foundation: broker, proxy, dashboard
- [Onboarding & Heartbeat Plan](../../plans/2026-02-11-feat-onboarding-heartbeat-infra-plan.md) — Phase 3-4: dev container infrastructure
- [Credential Forwarding](../integration-issues/metadata-propagation-and-credential-forwarding-across-layers.md) — Broker wrapper pattern, `/etc/profile.d/` env vars
- [Multi-Agent Review](./multi-agent-review-onboarding-heartbeat-infra.md) — Socket proxy security analysis
- [Code Review Systemic Patterns](./code-review-cycle-2-systemic-patterns-and-prevention.md) — Shared module extraction pattern
- [Heartbeat Self-Management](./per-repo-heartbeat-self-management-and-cross-pollination.md) — File-based state, queue priority patterns
