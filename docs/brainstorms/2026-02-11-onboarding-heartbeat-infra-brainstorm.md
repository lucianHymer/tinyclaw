# Brainstorm: Team Onboarding, Heartbeat Superpowers & Dev Infrastructure

**Date:** 2026-02-11
**Status:** Draft
**Participants:** Lucian, Claude

---

## What We're Building

Three interconnected capabilities to turn Borg into a team adoption platform:

### 1. Smart Heartbeat System

Transform the current minimal heartbeat ("any pending tasks?") into a tiered monitoring system that makes each thread proactively aware of its repo's state.

**Frequency tiers** (agent tracks timing via HEARTBEAT.md):

| Cadence | What it does | Model |
|---------|-------------|-------|
| **Every heartbeat (~5-8 min)** | Quick `git status`, check for urgent flags in HEARTBEAT.md | haiku |
| **Hourly** | `git fetch origin`, detect new upstream commits, check if branch is behind or PR was merged, `gh pr checks` for CI status, detect merge conflicts with main | haiku |
| **Daily** | Summarize day's work to master thread via `send_message`, surface new issues/PRs and aging review requests, flag stale branches and untracked files, repository ruleset audit (`gh api repos/{owner}/{repo}/rulesets`) | sonnet |

**Key constraint — heartbeats are one-shot:** Each heartbeat fires a fresh query with no persistent session (currently haiku model). The agent has no memory between pulses except what it writes to HEARTBEAT.md. This is the design: HEARTBEAT.md is both task list and state store (last fetch time, last daily report timestamp, etc.). Quick checks stay on haiku; daily checks that need `gh api` calls or cross-repo reasoning may need sonnet.

The current time and timezone should be made SUPER CLEAR to the heartbeat agent, and it should be thoroughly told to think twice about time comparisons.

**Implementation approach:** The heartbeat prompt (`buildHeartbeatPrompt` in session-manager.ts) gets significantly richer. No code changes to the heartbeat cron itself -- all intelligence lives in the prompt and HEARTBEAT.md.

### 2. Master Thread as Organizational Brain

The master thread (threadId: 1) gets its own local-only git repo as its working directory. This repo is:
- Never pushed to GitHub (local-only, backed up with Hetzner snapshots)
- Used for version tracking and rollback of organizational knowledge
- The "company memory" that doesn't belong to any specific repo

**Proposed structure (start minimal, let it grow organically):**
```
knowledge-base/
  context.md          # Who we are, what we're building, team members
  decisions.md        # Key decisions log (append-only)
  active-projects.md  # What each repo/thread is working on (auto-updated from thread reports)
  .git/               # Local-only git history
```

**Thread reporting flow:**
1. Individual threads send daily summaries to master via `send_message` MCP tool (only if something changed)
2. Master thread aggregates into `active-projects.md`

**Master thread heartbeat extras:**
- Aggregate thread reports
- Maintain the knowledge base structure
- Run the repository ruleset audit across all repos
- Surface anything that needs human attention

### 3. Dev Container Infrastructure (Shared Hetzner Box)

Give each developer their own Docker container on the existing Hetzner instance for running Claude Code sessions directly.

**Architecture:**
```
Hetzner Box (32GB RAM upgrade)
├── Borg Stack (existing docker-compose)
│   ├── broker (credential broker - GitHub App tokens)
│   ├── bot (Borg Telegram bot + queue processor)
│   └── dashboard
├── Dev Container: alice (SSH on port 2201)
│   ├── Claude Code CLI (pre-installed)
│   ├── git (configured with credential broker)
│   ├── sshd
│   └── ~/repos/ (workspace)
├── Dev Container: bob (SSH on port 2202)
│   └── (same structure)
└── ...
```

**Key design decisions:**

- **Anthropic API credentials:** Each dev uses their own Claude Max plan. They run `claude login` once inside their container.
- **GitHub credentials:** Provided automatically via the existing credential broker. Dev containers join the same Docker network (`internal`) and use the same `github-token-helper.sh` / `gh-wrapper.sh` scripts.
- **SSH access:** Each container runs sshd on a unique port (2201, 2202, ...). Devs get shell aliases: `alias claude-dev='ssh -p 2201 me@hetzner-box'`. Also works with VS Code Remote SSH for devs who want an IDE experience.
- **Resource limits:** Docker cgroup hard limits per container, no swap on the host (swap causes thrashing -- no swap means fast clean OOM kills scoped to the offending container). Current 8GB box: bot at 4GB, dev containers at 4GB each. At 32GB: bot at 6-8GB, dev containers at 3GB default. Use `docker update --memory` to burst individual containers when needed. Dashboard provides a live memory rebalancing UI (see section 4).
- **Repo access:** Any repo the GitHub App has access to. Safety comes from repository rulesets (audited by heartbeat).
- **Isolation:** Each container is its own filesystem. Devs can't see each other's containers. SSH keys control access.

**Onboarding flow for a new dev:**
1. You create their container (automated script)
2. They add their SSH key
3. They SSH in: `ssh -p 220X user@hetzner`
4. They run `claude login` (one-time, uses their Max plan)
5. They clone repos: `git clone https://github.com/org/repo` (credentials auto-provided by broker)
6. They run `claude` in any repo -- it picks up the repo's CLAUDE.md, skills, and memory automatically

**Onboarding kit for devs:**
- Shell alias to add to `.zshrc`/`.bashrc`
- SSH config snippet
- One-pager: "Your first 10 minutes with Claude Code"

### 4. Live Memory Rebalancing Dashboard

A new page on the existing Borg dashboard that shows real-time memory usage per container and lets you rebalance limits on the fly.

**What it shows:**
- Host total RAM and current usage
- Per-container: current memory usage vs. hard limit (bar chart or slider)
- Which containers are idle vs. active (helps decide who to borrow from)

**What it does:**
- Drag sliders or input new limits per container
- Validates that the sum of all limits doesn't exceed host RAM (minus ~2GB for OS)
- Applies changes via `docker update --memory` (live, no restart)
- Posts a notification to the Telegram general channel when limits are adjusted (e.g., "Memory rebalanced: dev-alice raised to 8GB, dev-bob lowered to 2GB")

**Implementation notes:**
- The dashboard container needs access to the Docker socket (`/var/run/docker.sock`) to read container stats and run `docker update`
- Uses the Docker Engine API: `GET /containers/{id}/stats` for live usage, `POST /containers/{id}/update` for limit changes
- The existing dashboard already reads host metrics from `/proc` -- this extends that pattern
- Notification to Telegram goes through the existing queue system (write JSON to `.borg/queue/incoming/` targeting the general thread)

---

## Why This Approach

**Heartbeat tiers, not heartbeat features:** By keeping all intelligence in the prompt + HEARTBEAT.md (not code changes), we avoid complexity in the queue processor. The agent manages its own schedule by tracking timestamps in its task file. This is the YAGNI approach -- no cron redesign, no frequency configuration, just a smarter prompt.

**Local-only knowledge base:** The master thread needs a place to accumulate knowledge that isn't tied to a specific code repo. A local git repo gives version tracking without the overhead of GitHub integration. Hetzner backups provide durability.

**Shared box over individual instances:** At 5-10 devs, a single 32GB box ($50/mo) is dramatically cheaper than 10 individual instances ($40-80/mo each). The constraint is concurrent active sessions, but in practice, 3-5 simultaneous sessions is plenty for a team of 10 who are just getting started.

**The Trojan horse effect:** As devs work in these containers on repos that have Borg-enhanced CLAUDE.md files, skills, and memory -- those improvements are in the repo. When they eventually run Claude Code locally on their MacBook, it all just works. The Telegram channel and the dev containers are both teaching and delivery mechanisms.

---

## Key Decisions

1. **Heartbeat intelligence lives in HEARTBEAT.md and prompt, not in code** -- agents self-manage their check cadence
2. **Master thread gets a local-only git repo** as its working directory for organizational knowledge
3. **Dev infrastructure = Docker containers on shared Hetzner box** (32GB upgrade)
4. **Each dev brings their own Claude Max plan** credentials; GitHub creds come from the existing broker
5. **SSH access per container** on unique ports with shell aliases for easy connection
6. **Repository ruleset audit** added to heartbeat as a safety guardrail
7. **Thread-to-master reporting** is daily, opt-in (only if something changed), via existing `send_message` MCP tool
8. **No swap on host** -- cgroup hard limits per container, fast OOM kills scoped to offending container only
9. **Live memory rebalancing** via dashboard UI -- `docker update` for burst, Telegram notification on changes

---

## Open Questions

1. **Dev container Dockerfile:** Do we extend the existing bot Dockerfile or create a purpose-built one? The bot Dockerfile has Claude Agent SDK stuff we don't need; the dev container needs Claude CLI, sshd, and common dev tools.
2. **Container lifecycle:** When a dev is inactive for N days, do we stop their container to reclaim RAM? Auto-start on SSH connection?
3. **Repo checkout strategy:** Do devs manage their own clones, or do we pre-populate repos when creating the container?
4. **Claude Code version management:** How do we keep Claude Code updated across all containers? Shared volume? Rebuild?
5. **Adding new GitHub orgs/repos:** The credential broker uses `github-installations.json` to map orgs to GitHub App installation IDs. When a dev needs access to a new org, someone needs to update this file. Automate or document?
6. **32GB sizing validation:** Need to benchmark actual memory usage of Claude Code sessions under load before committing to the upgrade tier.
