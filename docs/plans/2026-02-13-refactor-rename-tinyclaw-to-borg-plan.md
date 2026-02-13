---
title: "Rename Borg to borg"
type: refactor
date: 2026-02-13
---

# Rename Borg to borg

## Overview

Full project rename from "Borg" to "borg" (lowercase). Short for "bot org", with a subtle Star Trek nod that doesn't lean into IP territory. The rename covers all user-facing strings, internal identifiers, directory names, Docker labels, scripts, and documentation.

## Motivation

The project has outgrown its original name. "borg" is shorter, punchier, and better reflects what the system does — orchestrating a collective of bot agents.

## Proposed Solution

A single-pass, clean rename with no backward-compatibility shims. Every reference to "borg" / "Borg" / "BORG" becomes "borg" / "Borg" / "BORG" respectively. The `.borg/` data directory becomes `.borg/`. The `borg.sh` script becomes `borg.sh`. Docker labels change from `borg.*` to `borg.*`.

A migration helper in `borg.sh` handles renaming the runtime data directory on existing instances.

## Scope & Inventory

| Category | Files | Occurrences | Risk |
|---|---|---|---|
| Source code (`src/`) | 8 files | ~95 | **High** — functional breakage if missed |
| Shell scripts | 4 files | ~55 | **High** — startup/migration paths |
| Config (package.json, compose, ignore) | 7 files | ~18 | **High** — build/deploy |
| Claude hooks (`.claude/hooks/`) | 2 files | 3 | Medium |
| Dashboard HTML (`static/`) | 1 file | 1 | Low |
| Core docs (CLAUDE.md, README) | 2 files | ~30 | Medium |
| Historical docs (plans, brainstorms, solutions) | 20+ files | ~200+ | **Low** — archival |
| Todos | 5 files | ~12 | Low |
| Data directory (`.borg/` → `.borg/`) | filesystem | 1 rename | **High** — runtime state |
| Docker labels/images | in code | ~15 | **High** — container filtering |
| Memory file (outside repo) | 1 file | 1 | Low |

## Technical Approach

### Naming Convention

| Context | Old | New |
|---|---|---|
| Brand (prose) | Borg | Borg |
| Identifiers (code, paths) | borg | borg |
| Constants | BORG | BORG |
| Data directory | `.borg/` | `.borg/` |
| Main script | `borg.sh` | `borg.sh` |
| Docker labels | `borg.type`, `borg.created-by`, etc. | `borg.type`, `borg.created-by`, etc. |
| Docker image | `borg-dev` | `borg-dev` |
| Compose project | `borg` | `borg` |
| Docker network | `borg_dev` (auto-derived) | `borg_dev` (auto-derived) |
| Docker volume | `borg_borg-data` | `borg_borg-data` |
| MCP server name | `"borg"` | `"borg"` |
| Function names | `createBorgMcpServer` | `createBorgMcpServer` |
| SSH host pattern | `borg-<name>` | `borg-<name>` |
| Git email (dev containers) | `dev@borg` | `dev@borg` |
| npm package | `borg` / `borg-broker` | `borg` / `borg-broker` |

### Implementation Strategy

This is a mechanical find-and-replace. The implementer should:
1. Use `grep -ri borg` to find all occurrences
2. Replace in each file, verifying context
3. Rename files and directories
4. Run the verification grep from Acceptance Criteria to confirm zero misses

Grouped into three commits for clean review:

### Group A: Code, Config & Scripts (single commit)

All functional changes — breakage if any are missed.

**Source files** (replace `borg` → `borg`, `Borg` → `Borg`, `BORG` → `BORG`):
- `src/types.ts` — comment
- `src/message-history.ts` — `.borg/` paths
- `src/docker-client.ts` — Docker labels (`borg.*` → `borg.*`), image name, SSH host pattern, comment
- `src/mcp-tools.ts` — `BORG_DIR` → `BORG_DIR`, `createBorgMcpServer` → `createBorgMcpServer`, MCP server `name`, `DEV_NETWORK` default, tool descriptions
- `src/session-manager.ts` — `BORG_DIR` → `BORG_DIR`, agent system prompts, `.borg/` paths in prompts, SSH config pattern
- `src/queue-processor.ts` — import + usage of `createBorgMcpServer`, `BORG_DIR`, all derived path constants, MCP server key
- `src/telegram-client.ts` — five path constants, log message, comment
- `src/dashboard.ts` — `BORG_DIR` → `BORG_DIR`, ~25 derived references, comment

**Note on agent identity prompt**: `"You are Borg"` becomes `"You are Borg"`. Review this line for tone — consider `"You are Borg, an AI assistant..."` to keep it descriptive rather than ominous.

**Shell scripts**:
- `borg.sh` → **rename to `borg.sh`**, then replace all internal references (~55 occurrences: paths, compose project name, volume name, echo messages)
- `heartbeat-cron.sh` — five `.borg/` path constants
- `scripts/create-dev-container.sh` — Docker label filter, image name, error messages
- `scripts/init-knowledge-base.sh` — `./borg.sh` → `./borg.sh`

**Add migration block to `borg.sh`** (near top, before any `.borg/` access):
```bash
if [ -d "$SCRIPT_DIR/.borg" ] && [ ! -d "$SCRIPT_DIR/.borg" ]; then
    echo "Migrating .borg/ to .borg/..."
    mv "$SCRIPT_DIR/.borg" "$SCRIPT_DIR/.borg"
    echo "Migration complete."
fi
```

**Config & Docker**:
- `package.json` — name, description
- `broker/package.json` — name
- `docker-compose.yml` — volume mounts (`.borg` → `.borg`), `DEV_NETWORK`, `COMPOSE_PROJECT` default
- `.gitignore` — nine `.borg/` entries → `.borg/`
- `.dockerignore` — `.borg` → `.borg`
- `Dockerfile.dev-container` — git email, motd path, profile.d paths
- `docker/tmux.conf` — comment

**Claude hooks**:
- `.claude/hooks/log-activity.sh` — log path
- `.claude/hooks/session-start.sh` — output text

**Dashboard HTML**:
- `static/dashboard.html` — brand text

**MOTD ASCII art** (`docker/motd`):
- Replace "dev" ASCII art with "borg" ASCII art (11 lines vs current 8)
- Keep rainbow color cycle (`\033[91m` red → `\033[33m` yellow → `\033[93m` light yellow → `\033[32m` green → `\033[36m` cyan → `\033[34m` blue → `\033[35m` magenta → cycle back)
- New art:
```
 /$$
| $$
| $$$$$$$   /$$$$$$   /$$$$$$   /$$$$$$
| $$__  $$ /$$__  $$ /$$__  $$ /$$__  $$
| $$  \ $$| $$  \ $$| $$  \__/| $$  \ $$
| $$  | $$| $$  | $$| $$      | $$  | $$
| $$$$$$$/|  $$$$$$/| $$      |  $$$$$$$
|_______/  \______/ |__/       \____  $$
                               /$$  \ $$
                              |  $$$$$$/
                               \______/
```
- Update comment from "Dev container welcome" to "Borg dev container welcome"

**Then regenerate lock files**:
```bash
npm install && cd broker && npm install
```

### Group B: Documentation (second commit)

Non-functional. Can be reviewed independently.

**Core docs** (manual review, not just find-replace):
- `CLAUDE.md` — heading, all `.borg/` paths, script name
- `README.md` — rewrite header and intro. New structure:
  - Title: `# borg` with subtitle `bot org`
  - Bullet-point feature highlights at the top:
    - Manage your org in a Telegram group — each thread is a repo with Claude Code checked out
    - Level up your repo here, level up your repo for everyone (shared knowledge compounding)
    - Dev containers that set up the perfect environment automatically
    - Secret broker for secure credential forwarding without exposing secrets to agents
    - Spin up dev data environments on request
    - Real-time dashboard with memory management and resource monitoring
  - Rest of README: update clone URL, script references (`borg.sh`), remove old tagline "The Pinchening"
- `docs/onboarding/getting-started.md`
- `docs/dashboard-spec.md` (~40 occurrences)

**Historical docs** (bulk find-replace, no manual review needed):
- `docs/plans/*.md` — 6 files
- `docs/brainstorms/*.md` — 2 files
- `docs/solutions/**/*.md` — 10 files
- `todos/*.md` — 5 files
- Rename two solution filenames: `borg-v2-*` → `borg-v2-*`

### Group C: Post-Merge Manual Steps

Not in codebase — done after deploy:
- [ ] Rename `.borg/` → `.borg/` on host (or let migration block handle it on next `borg.sh` run)
- [ ] Rename GitHub repository (`borg` → `borg`)
- [ ] Update git remote: `git remote set-url origin <new-url>`
- [ ] Rebuild Docker images: `borg.sh build`
- [ ] Migrate Docker volume: `docker volume create borg_borg-data && docker run --rm -v borg_borg-data:/from -v borg_borg-data:/to alpine cp -a /from/. /to/`
- [ ] Recreate dev containers (old `borg.*` labels won't be discovered — ephemeral by design)
- [ ] Update DNS/tunnel config if applicable
- [ ] Update Claude memory file: `MEMORY.md` heading

## Simplifications Applied

- **No backward-compat shims** — Clean rename, no fallback code that checks `.borg/` if `.borg/` missing (except the one-time migration in `borg.sh`)
- **No path consolidation refactor** — Each file keeps its own `BORG_DIR` constant. Extracting a shared `paths.ts` is YAGNI for this rename
- **Historical docs get bulk find-replace** — No manual editing of archival content, just mechanical substitution
- **Docker volume migration is manual** — One-time copy command documented in post-merge steps, not automated in scripts

## Acceptance Criteria

- [ ] `grep -ri borg src/ scripts/ *.sh *.yml *.json static/ .claude/ .gitignore .dockerignore Dockerfile*` returns zero matches
- [ ] `grep -ri borg CLAUDE.md README.md docs/onboarding/` returns zero matches
- [ ] `.borg/` directory no longer referenced anywhere in code
- [ ] `npm run build` succeeds
- [ ] `borg.sh start` launches all services correctly
- [ ] Dashboard shows "Borg Dashboard" branding
- [ ] MCP server registers as `"borg"`
- [ ] Dev container creation uses `borg-dev` image and `borg.*` labels
- [ ] Existing `.borg/` data directory auto-migrates on first `borg.sh` run
- [ ] Docker containers use `borg` compose project name

## Dependencies & Risks

**Risk: Running instances break during rename**
- Mitigation: Stop all services before deploying. The migration block in `borg.sh` handles the directory rename on restart.

**Risk: Docker volume name changes**
- The compose project name changing from `borg` to `borg` means Docker auto-names volumes differently. Existing volumes won't be found.
- Mitigation: Document manual volume rename in post-merge steps (`docker volume create borg_borg-data && docker run --rm -v borg_borg-data:/from -v borg_borg-data:/to alpine cp -a /from/. /to/`). Not automated — this is a one-time operation on one host.

**Risk: Existing dev containers become invisible**
- Containers with `borg.type=dev-container` labels won't match `borg.type=dev-container` filters.
- Mitigation: Document that existing dev containers need to be recreated. They're ephemeral by design.

**Risk: Agent sessions reference old MCP server name**
- Active SDK sessions that registered `borg` as MCP server name will error.
- Mitigation: Restart all sessions after deploy. Sessions are ephemeral.

## References

- Research: Full inventory of ~400+ occurrences cataloged across 40+ files
- Institutional learnings: atomic writes pattern, mtime cache invalidation, no compat shims
- Coding conventions: CLAUDE.md, `.js` extensions, atomic writes, JSONL appends
