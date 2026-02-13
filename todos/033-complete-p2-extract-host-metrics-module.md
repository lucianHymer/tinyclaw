---
status: complete
priority: p2
issue_id: "033"
tags: [code-review, architecture, duplication]
---
# Extract Shared Host Metrics Module

## Problem Statement
`parseMeminfo()`, `parseCpuPercent()`, `getDiskUsage()`, `countQueueFiles()`/`countFiles()`, and the `PROC_BASE` constant are copy-pasted between `dashboard.ts` and `mcp-tools.ts`. `parseCpuPercent()` carries mutable module-level state (`prevCpuIdle`, `prevCpuTotal`) in BOTH copies, meaning CPU calculations are inaccurate in both modules since each maintains independent state called at different frequencies.

## Findings
- **Source:** Pattern Recognition, Architecture Strategist, TypeScript Reviewer (all flagged independently)
- **Locations:**
  - `src/dashboard.ts` lines 67-141 (parseMeminfo, parseCpuPercent, getDiskUsage, PROC_BASE)
  - `src/mcp-tools.ts` lines 26-86 (same functions, same constant)
  - `src/dashboard.ts` line 135 (`countFiles`) / `src/mcp-tools.ts` line 80 (`countQueueFiles`) — identical function, different names
- **Additional duplication:** `toErrorMessage()` exists in `src/types.ts` but `dashboard.ts` and `mcp-tools.ts` inline the pattern 8 times
- **Project rule violation:** MEMORY.md states "Any shared integration MUST live in `src/<name>-client.ts` from day 1"

## Proposed Solutions
1. Create `src/host-metrics.ts` exporting all host metric functions and the PROC_BASE constant. Both dashboard.ts and mcp-tools.ts import from it.
   - Effort: Small
2. Also import and use `toErrorMessage()` from `src/types.ts` in both files.
   - Effort: Small

## Technical Details
- Affected: `src/dashboard.ts`, `src/mcp-tools.ts`
- New file: `src/host-metrics.ts`
- The `getDiskUsage()` function uses `BORG_DIR` for `statfsSync` — parameterize the directory argument

## Acceptance Criteria
- [ ] `parseMeminfo`, `parseCpuPercent`, `getDiskUsage`, `countQueueFiles` exist in only one location
- [ ] `PROC_BASE` defined once
- [ ] Single set of mutable CPU state
- [ ] Both dashboard.ts and mcp-tools.ts import from shared module
- [ ] `toErrorMessage()` imported from types.ts, inline patterns removed
