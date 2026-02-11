---
status: done
priority: p1
issue_id: "018"
tags: [code-review, security, docker]
dependencies: []
---

# Dev Container /etc/profile.d/ Environment Variables Are Empty

## Problem Statement

The Dockerfile.dev-container writes `/etc/profile.d/broker-env.sh` during build time with shell variable references `${CREDENTIAL_BROKER_URL}` and `${BROKER_SECRET}`. Since no `ARG` or `ENV` is set at build time, the resulting file exports **empty strings**. SSH sessions into dev containers will not have the credential broker URL or secret available, breaking git operations and `gh` CLI.

## Findings

**Source**: pattern-recognition-specialist

**Location**: `/workspace/project/Dockerfile.dev-container` lines 74-77

```dockerfile
RUN echo '#!/bin/bash' > /etc/profile.d/broker-env.sh \
    && echo 'export CREDENTIAL_BROKER_URL="${CREDENTIAL_BROKER_URL}"' >> /etc/profile.d/broker-env.sh \
    && echo 'export BROKER_SECRET="${BROKER_SECRET}"' >> /etc/profile.d/broker-env.sh \
    && chmod +x /etc/profile.d/broker-env.sh
```

Single quotes around the entire `echo` string mean the `${...}` references are written literally. At SSH login time, bash expands them -- but the variables are not in the sshd process environment (they're Docker ENV vars on PID 1 only).

The CMD does not propagate environment variables to profile.d before starting sshd:
```dockerfile
CMD ["bash", "-c", "ssh-keygen -A && exec /usr/sbin/sshd -D -e"]
```

## Proposed Solutions

### Option 1: Write env vars at container start time in CMD (Recommended)

```dockerfile
CMD ["bash", "-c", "echo \"export CREDENTIAL_BROKER_URL=$CREDENTIAL_BROKER_URL\" > /etc/profile.d/broker-env.sh && echo \"export BROKER_SECRET=$BROKER_SECRET\" >> /etc/profile.d/broker-env.sh && ssh-keygen -A && exec /usr/sbin/sshd -D -e"]
```

Remove the build-time RUN that writes the file (lines 74-77) since it would be overwritten.

- Pros: Env vars are correctly propagated from Docker runtime to SSH sessions
- Cons: Longer CMD line
- Effort: Small
- Risk: None

### Option 2: Use an entrypoint script

Create `docker/dev-entrypoint.sh` that writes env vars to profile.d then starts sshd.

- Pros: Cleaner, more maintainable
- Cons: One more file
- Effort: Small
- Risk: None

## Recommended Action

Option 2 for cleanliness, but Option 1 works fine for MVP.

## Acceptance Criteria

- [ ] SSH sessions into dev containers have `CREDENTIAL_BROKER_URL` and `BROKER_SECRET` set
- [ ] `git push` and `gh` commands work from SSH sessions
- [ ] Build-time RUN for profile.d is either removed or documented as a template

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-11 | Created from code review | pattern-recognition-specialist identified functional bug |
| 2026-02-11 | Fixed: removed build-time RUN, moved env var writing to CMD using printf | Runtime ENV expansion in CMD captures Docker-provided env vars correctly |
