---
status: done
priority: p2
issue_id: "022"
tags: [code-review, agent-native, mcp-tools]
dependencies: ["016"]
---

# Agent-Native Parity Gaps: Missing MCP Tools

## Problem Statement

The dashboard exposes 18 GET endpoints and 1 POST endpoint, but agents only have 5 MCP tools. The master agent cannot query host memory, system metrics, or routing stats -- critical information for making informed infrastructure decisions.

## Findings

**Source**: agent-native-reviewer

**Missing tools (high impact)**:
1. **`get_host_memory`** (master-only) -- Agent has `update_container_memory` but cannot query host total/available/reserve to validate allocations. Flying blind.
2. **`get_system_status`** (master-only) -- CPU, RAM, disk, load, queue depth. Master thread daily report needs this.

**Missing documentation**:
3. System prompts do not mention `get_container_stats`, `update_container_memory`, or `query_knowledge_base` tools.

**Behavioral divergence**:
4. MCP `update_container_memory` lacks dashboard's validation logic (covered in todo 016).

**Score**: 5 of 13 actionable dashboard capabilities have agent equivalents.

## Proposed Solutions

### Phase 1: Add critical missing tools

Add `get_host_memory` and `get_system_status` MCP tools (master-only). Both are thin wrappers around existing functions in dashboard.ts (or the shared docker-client.ts after todo 016).

### Phase 2: Document tools in system prompts

Add `## MCP Tools` section to master and worker prompts listing available tools.

- Effort: Medium
- Risk: Low

## Acceptance Criteria

- [x] `get_host_memory` MCP tool returns totalMemory, availableMemory, osReserve, maxAllocatable
- [x] `get_system_status` MCP tool returns CPU, RAM, disk, load, queue depths
- [x] System prompts document available MCP tools for master and worker threads

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-11 | Created from code review | agent-native-reviewer rated NEEDS WORK |
| 2026-02-11 | Implemented all 3 acceptance criteria | Added get_host_memory + get_system_status tools to mcp-tools.ts; documented tools in session-manager.ts prompts for master (7 tools) and worker (3 tools) |
