---
status: complete
priority: p3
issue_id: "040"
tags: [code-review, architecture]
---
# System Prompt Text Duplication Between Master and Worker

## Problem Statement
`buildThreadPrompt()` contains two large string literals (master at lines 151-218, worker at lines 221-268) sharing approximately 60% identical text: preamble, GitHub access block, cross-thread communication block, heartbeat self-management block. Changes to shared sections must be manually applied in both blocks, risking drift.

## Findings
- **Source:** Architecture Strategist, Pattern Recognition reviews
- **Location:** `src/session-manager.ts` lines 139-269
- **Shared blocks:** Preamble (2 paragraphs), GitHub access (4 lines), heartbeat self-management (17 lines)
- **Divergent blocks:** Master has knowledge base section, MCP tools differ (container tools for master)

## Proposed Solutions
1. **Decompose into composable builder functions** — Create `buildPreamble()`, `buildGithubBlock()`, `buildHeartbeatBlock()`, `buildMcpToolsBlock(isMaster)` and assemble them.
   - Effort: Small

## Technical Details
- Only `src/session-manager.ts` affected
- No functional change — pure refactoring of string construction

## Acceptance Criteria
- [ ] Shared prompt sections defined once, not duplicated
- [ ] Master and worker prompts assembled from shared components
- [ ] No behavioral change in prompt content
