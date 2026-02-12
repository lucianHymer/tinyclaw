/**
 * Shared Docker API client for TinyClaw.
 * Provides typed Docker API access, container listing, and memory validation.
 * All functions accept a baseUrl parameter — no hardcoded Docker endpoint.
 */

import { ValidationError, type SSHPublicKey, type DevName, type DevEmail } from "./types.js";

// ─── Constants ───

export const MIN_MEMORY_BYTES = 256 * 1024 * 1024; // 256MB minimum per container
export const OS_RESERVE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB reserved for OS
export const MEMORY_SNAP_BYTES = 64 * 1024 * 1024; // 64MB snap increment

// ─── Docker API Types ───

export interface DockerContainer {
    Id: string;
    Names: string[];
    State: string;
    Status: string;
    Labels: Record<string, string>;
    Created: number;
    HostConfig?: { NanoCpus?: number };
}

export interface DockerContainerInspect {
    Id: string;
    Name: string;
    State: { Status: string; StartedAt: string; Pid: number };
    Config?: { Labels?: Record<string, string> };
    HostConfig: {
        Memory: number;
        MemorySwap: number;
        NanoCpus: number;
        PortBindings?: Record<string, Array<{ HostIp: string; HostPort: string }>>;
    };
}

export interface DockerStats {
    memory_stats: { usage: number; limit: number };
    pids_stats: { current: number };
}

export interface ContainerInfo {
    id: string;
    name: string;
    status: string;
    memory: { usage: number; limit: number; usagePercent: number };
    cpus: number;
    uptime: string;
    idle: boolean;
    sshPort?: number;
}

// ─── Result type for memory validation ───

export interface MemoryUpdateResult {
    id: string;
    name: string;
    oldLimit: number;
    newLimit: number;
    warning?: string;
}

// ─── Validation ───

/**
 * Validate that a string is a legitimate Docker container ID.
 * Docker container IDs are 12-64 character lowercase hex strings.
 * This rejects path traversal characters, slashes, and any non-hex input.
 */
export function isValidContainerId(id: string): boolean {
    return /^[a-f0-9]{12,64}$/i.test(id);
}

// ─── Helpers ───

export function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + "GB";
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + "MB";
    return bytes + "B";
}

export function formatUptime(startedAt: string): string {
    const started = new Date(startedAt).getTime();
    if (isNaN(started)) return "unknown";
    const diffMs = Date.now() - started;
    const days = Math.floor(diffMs / 86400000);
    const hours = Math.floor((diffMs % 86400000) / 3600000);
    if (days > 0) return `${days}d ${hours}h`;
    const minutes = Math.floor((diffMs % 3600000) / 60000);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

// ─── Docker API Fetch Helpers ───

export async function fetchDockerJson<T>(baseUrl: string, urlPath: string, method = "GET", body?: unknown): Promise<T> {
    const url = `${baseUrl}${urlPath}`;
    const opts: RequestInit = {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
    };
    const resp = await fetch(url, opts);
    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Docker API ${method} ${urlPath}: ${resp.status} ${text}`);
    }
    return (await resp.json()) as T;
}

export async function fetchDockerStats(baseUrl: string, containerId: string): Promise<DockerStats> {
    // stream=false returns a single stats snapshot
    const url = `${baseUrl}/containers/${containerId}/stats?stream=false`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) {
        throw new Error(`Docker stats ${containerId}: ${resp.status}`);
    }
    return (await resp.json()) as DockerStats;
}

// ─── Container Listing ───

export async function getDevContainers(baseUrl: string): Promise<ContainerInfo[]> {
    // List all containers, then filter by label
    const containers = await fetchDockerJson<DockerContainer[]>(
        baseUrl,
        '/containers/json?all=true&filters={"label":["tinyclaw.type=dev-container"]}',
    );

    // Parallelize inspect + stats calls across all containers
    const settled = await Promise.allSettled(
        containers.map(async (c) => {
            const name = (c.Names[0] || "").replace(/^\//, "");
            let usage = 0;
            let limit = 0;
            let cpus = 0;
            let uptime = "";
            let idle = true;
            let sshPort: number | undefined;

            const [inspectResult, statsResult] = await Promise.allSettled([
                fetchDockerJson<DockerContainerInspect>(baseUrl, `/containers/${c.Id}/json`),
                c.State === "running"
                    ? fetchDockerStats(baseUrl, c.Id)
                    : Promise.resolve(null),
            ]);

            if (inspectResult.status === "fulfilled") {
                const inspect = inspectResult.value;
                limit = inspect.HostConfig.Memory || 0;
                cpus = inspect.HostConfig.NanoCpus ? inspect.HostConfig.NanoCpus / 1e9 : 0;
                uptime = inspect.State.StartedAt ? formatUptime(inspect.State.StartedAt) : "";
                const portBindings = inspect.HostConfig?.PortBindings?.["22/tcp"];
                if (portBindings?.[0]?.HostPort) {
                    sshPort = parseInt(portBindings[0].HostPort, 10);
                }
            }

            if (statsResult.status === "fulfilled" && statsResult.value) {
                const stats = statsResult.value;
                usage = stats.memory_stats?.usage || 0;
                if (stats.memory_stats?.limit) limit = stats.memory_stats.limit;
                // Consider container idle if only 1-2 processes (init + sshd)
                idle = (stats.pids_stats?.current || 0) <= 2;
            }

            return {
                id: c.Id,
                name,
                status: c.State,
                memory: {
                    usage,
                    limit,
                    usagePercent: limit > 0 ? Math.round((usage / limit) * 1000) / 10 : 0,
                },
                cpus: Math.round(cpus * 10) / 10,
                uptime,
                idle,
                sshPort,
            } satisfies ContainerInfo;
        }),
    );

    // Collect fulfilled results, skip containers where the entire mapping failed
    const results: ContainerInfo[] = [];
    for (const result of settled) {
        if (result.status === "fulfilled") {
            results.push(result.value);
        }
    }

    // Sort by memory usage descending
    results.sort((a, b) => b.memory.usage - a.memory.usage);
    return results;
}

// ─── Lightweight Container Memory Query ───

/**
 * Get memory limits for all dev containers using only list + parallel inspect.
 * No stats calls — much faster than getDevContainers() for allocation validation.
 * Returns array of { id, memoryLimit } for each container.
 */
async function getContainerMemoryLimits(baseUrl: string): Promise<Array<{ id: string; memoryLimit: number }>> {
    const containers = await fetchDockerJson<DockerContainer[]>(
        baseUrl,
        '/containers/json?all=true&filters={"label":["tinyclaw.type=dev-container"]}',
    );

    const settled = await Promise.allSettled(
        containers.map(async (c) => {
            const inspect = await fetchDockerJson<DockerContainerInspect>(
                baseUrl,
                `/containers/${c.Id}/json`,
            );
            return { id: c.Id, memoryLimit: inspect.HostConfig.Memory || 0 };
        }),
    );

    const results: Array<{ id: string; memoryLimit: number }> = [];
    for (const result of settled) {
        if (result.status === "fulfilled") {
            results.push(result.value);
        }
    }
    return results;
}

// ─── Memory Validation & Update ───

/**
 * Validate and update a container's memory limit with full safety checks:
 * - Snap to 64MB increments
 * - Enforce minimum memory limit (256MB)
 * - Validate total allocation against host capacity
 * - Warn if new limit is below or close to current usage (OOM risk)
 *
 * @param baseUrl - Docker API base URL
 * @param containerId - Docker container ID
 * @param newLimitBytes - Desired new memory limit in bytes
 * @param hostTotalBytes - Total host memory in bytes (for allocation validation)
 * @returns MemoryUpdateResult with old/new limits and optional warning
 * @throws Error if validation fails or Docker API call fails
 */
export async function validateAndUpdateMemory(
    baseUrl: string,
    containerId: string,
    newLimitBytes: number,
    hostTotalBytes: number,
): Promise<MemoryUpdateResult> {
    // Minimum memory check
    if (newLimitBytes < MIN_MEMORY_BYTES) {
        throw new ValidationError(`Limit too low. Minimum is ${formatBytes(MIN_MEMORY_BYTES)}`);
    }

    // Snap to 64MB increment
    const snappedLimit = Math.round(newLimitBytes / MEMORY_SNAP_BYTES) * MEMORY_SNAP_BYTES;

    // Inspect the container
    const inspect = await fetchDockerJson<DockerContainerInspect>(
        baseUrl,
        `/containers/${containerId}/json`,
    );
    const containerName = (inspect.Name || "").replace(/^\//, "");
    const oldLimit = inspect.HostConfig.Memory || 0;

    // Read current memory usage for OOM warning
    let currentUsage = 0;
    if (inspect.State.Status === "running") {
        try {
            const stats = await fetchDockerStats(baseUrl, containerId);
            currentUsage = stats.memory_stats?.usage || 0;
        } catch {
            // Can't read stats — proceed with caution
        }
    }

    // Validate total allocation across all dev containers (lightweight: no stats calls)
    const allLimits = await getContainerMemoryLimits(baseUrl);
    const otherContainersTotal = allLimits
        .filter(c => c.id !== containerId)
        .reduce((sum, c) => sum + c.memoryLimit, 0);
    const maxAllocatable = hostTotalBytes - OS_RESERVE_BYTES;
    const newTotal = otherContainersTotal + snappedLimit;

    if (newTotal > maxAllocatable) {
        throw new ValidationError(
            `Total allocation would be ${formatBytes(newTotal)}, exceeding max ${formatBytes(maxAllocatable)} (host ${formatBytes(hostTotalBytes)} - ${formatBytes(OS_RESERVE_BYTES)} OS reserve)`,
        );
    }

    // OOM warning checks
    let warning: string | undefined;
    if (snappedLimit < currentUsage) {
        warning = `New limit (${formatBytes(snappedLimit)}) is below current usage (${formatBytes(currentUsage)}). Docker may OOM-kill this container immediately.`;
    } else if (currentUsage > 0 && snappedLimit < currentUsage * 1.25) {
        warning = `New limit (${formatBytes(snappedLimit)}) is close to current usage (${formatBytes(currentUsage)}). The container may be OOM-killed under load.`;
    }

    // Apply the update: set both Memory and MemorySwap to match
    await fetchDockerJson(
        baseUrl,
        `/containers/${containerId}/update`,
        "POST",
        { Memory: snappedLimit, MemorySwap: snappedLimit },
    );

    return {
        id: containerId,
        name: containerName,
        oldLimit,
        newLimit: snappedLimit,
        warning,
    };
}

// ─── Dev Container Lifecycle ───

const DEV_PORT_MIN = 2201;
const DEV_PORT_MAX = 2299;

/** Lightweight container listing for port scanning and name resolution. */
export async function listDevContainers(baseUrl: string): Promise<Array<{
    Names: string[];
    Ports: Array<{ PublicPort?: number }>;
    Id: string;
    State: string;
    Labels: Record<string, string>;
}>> {
    return fetchDockerJson(
        baseUrl,
        '/containers/json?all=true&filters={"label":["tinyclaw.type=dev-container"]}',
    );
}

/** Find the next available SSH port in the 2201-2299 range. */
export function findNextAvailablePort(
    containers: Array<{ Ports: Array<{ PublicPort?: number }> }>,
): number {
    const occupied = new Set<number>();
    for (const c of containers) {
        for (const p of c.Ports || []) {
            if (p.PublicPort && p.PublicPort >= DEV_PORT_MIN && p.PublicPort <= DEV_PORT_MAX) {
                occupied.add(p.PublicPort);
            }
        }
    }
    for (let port = DEV_PORT_MIN; port <= DEV_PORT_MAX; port++) {
        if (!occupied.has(port)) return port;
    }
    throw new ValidationError(`All ports in range ${DEV_PORT_MIN}-${DEV_PORT_MAX} are occupied.`);
}

// Re-export parseDevName from types.ts for backward compat
export { parseDevName } from "./types.js";

/**
 * Resolve a unique container name. If "dev-alice" exists, try "dev-alice-2", "dev-alice-3", etc.
 */
export function resolveUniqueName(
    containers: Array<{ Names: string[] }>,
    name: DevName,
): string {
    const existingNames = new Set(
        containers.flatMap(c => c.Names.map(n => n.replace(/^\//, ""))),
    );
    const baseName = `dev-${name}`;
    if (!existingNames.has(baseName)) return baseName;

    for (let i = 2; i <= 99; i++) {
        const candidate = `${baseName}-${i}`;
        if (!existingNames.has(candidate)) return candidate;
    }
    throw new ValidationError(`Cannot find unique name for "${name}" (tried up to 99 suffixes).`);
}

/** Find a container by name among dev containers. Throws if not found. */
export async function findContainerByName(
    baseUrl: string,
    name: string,
): Promise<{ Id: string; State: string; port?: number; Labels: Record<string, string> }> {
    const containers = await listDevContainers(baseUrl);
    for (const c of containers) {
        const containerName = (c.Names[0] || "").replace(/^\//, "");
        if (containerName === name) {
            const port = c.Ports?.find(
                p => p.PublicPort && p.PublicPort >= DEV_PORT_MIN && p.PublicPort <= DEV_PORT_MAX,
            )?.PublicPort;
            return { Id: c.Id, State: c.State, port, Labels: c.Labels };
        }
    }
    throw new ValidationError(`Container "${name}" not found among dev containers.`);
}

// ─── Container CRUD ───

export interface DevContainerUserInput {
    name: string;
    email: DevEmail;
    sshPublicKey: SSHPublicKey;
}

export interface DevContainerInfraConfig {
    port: number;
    networkName: string;
    dashboardHost: string;
    dockerBaseUrl: string;
}

export interface CreateContainerResult {
    containerId: string;
    name: string;
    port: number;
    host: string;
}

export async function createDevContainer(
    input: DevContainerUserInput,
    config: DevContainerInfraConfig,
): Promise<CreateContainerResult> {
    const containerSpec = {
        Image: "tinyclaw-dev",
        Hostname: input.name,
        Env: [
            `PROVISION_SSH_KEY=${input.sshPublicKey}`,
            `PROVISION_NAME=${input.name}`,
            `PROVISION_EMAIL=${input.email}`,
        ],
        ExposedPorts: { "22/tcp": {} },
        Labels: {
            "tinyclaw.type": "dev-container",
            "tinyclaw.created-by": "mcp-tool",
            "tinyclaw.created-at": new Date().toISOString(),
            "tinyclaw.dev-name": input.name,
            "tinyclaw.dev-email": input.email,
        },
        HostConfig: {
            Memory: 2 * 1024 * 1024 * 1024,
            MemorySwap: 2 * 1024 * 1024 * 1024,
            NanoCPUs: 2_000_000_000,
            PidsLimit: 256,
            CapDrop: ["NET_RAW"],
            Binds: [
                "/secrets/github-installations.json:/secrets/github-installations.json:ro",
                "/secrets/broker-env.sh:/etc/profile.d/broker-env.sh:ro",
            ],
            PortBindings: {
                "22/tcp": [{ HostIp: "127.0.0.1", HostPort: String(config.port) }],
            },
            RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
            LogConfig: {
                Type: "json-file",
                Config: { "max-size": "10m", "max-file": "3" },
            },
        },
        NetworkingConfig: {
            EndpointsConfig: { [config.networkName]: {} },
        },
    };

    const result = await fetchDockerJson<{ Id: string; Warnings: string[] }>(
        config.dockerBaseUrl,
        `/containers/create?name=${encodeURIComponent(input.name)}`,
        "POST",
        containerSpec,
    );

    return {
        containerId: result.Id,
        name: input.name,
        port: config.port,
        host: config.dashboardHost,
    };
}

/** Start a container by ID. Returns when the container is started. */
export async function startContainer(baseUrl: string, containerId: string): Promise<void> {
    if (!isValidContainerId(containerId)) {
        throw new ValidationError("Invalid container ID.");
    }
    const resp = await fetch(`${baseUrl}/containers/${containerId}/start`, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
    });
    // 204 = started, 304 = already running — both OK
    if (resp.status !== 204 && resp.status !== 304) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Start container ${containerId}: ${resp.status} ${text}`);
    }
}

/** Stop a container by ID. */
export async function stopDevContainer(baseUrl: string, containerId: string): Promise<void> {
    if (!isValidContainerId(containerId)) {
        throw new ValidationError("Invalid container ID.");
    }
    const resp = await fetch(`${baseUrl}/containers/${containerId}/stop`, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
    });
    // 204 = stopped, 304 = already stopped — both OK
    if (resp.status !== 204 && resp.status !== 304) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Stop container ${containerId}: ${resp.status} ${text}`);
    }
}

/**
 * Delete a container by ID. Verifies tinyclaw.type=dev-container label first.
 * Always uses force=true (stops running containers before deletion).
 */
export async function deleteDevContainer(
    baseUrl: string,
    containerId: string,
): Promise<void> {
    if (!isValidContainerId(containerId)) {
        throw new ValidationError("Invalid container ID.");
    }

    // Safety: verify this is a dev container
    const inspect = await fetchDockerJson<DockerContainerInspect>(
        baseUrl,
        `/containers/${containerId}/json`,
    );
    if (inspect.Config?.Labels?.["tinyclaw.type"] !== "dev-container") {
        throw new ValidationError("Refusing to delete: container does not have tinyclaw.type=dev-container label.");
    }

    const resp = await fetch(`${baseUrl}/containers/${containerId}?force=true`, {
        method: "DELETE",
        signal: AbortSignal.timeout(30_000),
    });
    if (resp.status !== 204) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Delete container ${containerId}: ${resp.status} ${text}`);
    }
}

/**
 * Format an SSH config snippet for a newly created container.
 */
export function formatSSHConfig(result: CreateContainerResult, keyType?: string): string {
    let identityFile = "~/.ssh/id_ed25519";
    if (keyType === "ssh-rsa") identityFile = "~/.ssh/id_rsa";
    else if (keyType?.startsWith("ecdsa-sha2-")) identityFile = "~/.ssh/id_ecdsa";
    else if (keyType?.startsWith("sk-ecdsa-sha2-")) identityFile = "~/.ssh/id_ecdsa_sk";
    else if (keyType?.startsWith("sk-ssh-ed25519")) identityFile = "~/.ssh/id_ed25519_sk";
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
