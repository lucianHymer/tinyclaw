---
status: complete
priority: p2
issue_id: "034"
tags: [code-review, agent-native]
---
# Workers Should Be Able to Check Their Own Container Stats

## Problem Statement
Worker thread agents (threadId != 1) can't check their own container memory usage or resource stats via MCP tools. The `get_container_stats` and `get_system_status` tools are master-only. Workers can use bash to check `/proc/meminfo` etc., but a simple MCP tool for "how's my container doing?" would let them self-diagnose memory pressure without shell gymnastics.

## Findings
- **Source:** Agent-Native Reviewer
- **Location:** `src/mcp-tools.ts` lines 378-383 — container tools gated behind `sourceThreadId === 1`
- **Gap:** Workers have full bash capabilities but no convenient MCP tool for own-container stats

## Proposed Solutions
1. **Add read-only `get_container_stats` to all threads** — Workers can see their own container's memory/CPU. Keep mutating tools (`update_container_memory`) master-only.
   - Effort: Small — move `getContainerStats` out of the `if (sourceThreadId === 1)` block, or create a lighter `get_own_stats` variant.

## Technical Details
- MCP tools defined in `src/mcp-tools.ts`
- Tool tiering at lines 378-383 (`sourceThreadId === 1` guard)
- `getContainerStats` already exists — just needs to be available to all threads
- Mutating tools (`updateContainerMemory`) stay master-only

## Acceptance Criteria
- [ ] Worker agents can check container stats via MCP tool (read-only)
- [ ] `update_container_memory` remains master-only
