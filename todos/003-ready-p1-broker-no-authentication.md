---
status: resolved
priority: p1
issue_id: "003"
tags: [code-review, security, architecture]
dependencies: []
---

# Credential Broker Has No Authentication -- Any Container Can Mint Tokens

## Problem Statement

The credential broker (`broker/index.js`) serves GitHub installation tokens on `GET /token?installation_id=X` with zero authentication. Any container on the Docker bridge network can mint tokens for any org. The agent explicitly has `permissionMode: "bypassPermissions"` and can execute `curl http://broker:3000/token?installation_id=12345` to mint tokens at will.

## Findings

**Source**: architecture-strategist agent, git-history-analyzer agent

File: `broker/index.js` lines 12-38

```javascript
app.get("/token", async (req, res) => {
  const installationId = req.query.installation_id;
  // ... mints token immediately with no auth check
});
```

The broker trusts any caller on the Docker bridge network. While today only 4 trusted containers exist on the `internal` network, the agent's Bash tool can execute arbitrary commands including `curl` to the broker. The plan document says "PEM never accessible from bot container" but the token endpoint is entirely open.

## Proposed Solutions

### Option 1: Shared secret via env var (Recommended)
Pass a `BROKER_SECRET` env var to both broker and bot containers. Validate via `Authorization: Bearer $BROKER_SECRET` header on every `/token` request. The git credential helper already runs inside the bot container and can read the env var.
- Pros: Simple, effective, minimal code change
- Cons: Agent's Bash tool could read the env var via `echo $BROKER_SECRET`
- Effort: Small (30 minutes)
- Risk: Low

### Option 2: IP-based allowlist
Restrict `/token` to the bot container's IP on the Docker network.
- Pros: No shared secret needed
- Cons: Docker IPs can change; harder to configure; still vulnerable to agent curl from bot container
- Effort: Medium
- Risk: Medium (fragile)

### Option 3: Accept the risk, document it
The agent IS trusted code running our SDK. It needs git access. The broker just provides a cleaner way than having the PEM in the bot container.
- Pros: No code change
- Cons: Any future container on the network gets token access
- Effort: None
- Risk: Medium (defense in depth violation)

## Technical Details

**Affected files**:
- `broker/index.js` (add auth check)
- `docker-compose.yml` (add `BROKER_SECRET` env var)
- `docker/github-token-helper.sh` (add `Authorization` header to curl)
- `.env.example` (document `BROKER_SECRET`)

## Acceptance Criteria

- [ ] Broker rejects requests without valid authorization
- [ ] Git credential helper passes authorization header
- [ ] Unauthenticated curl from any container returns 401

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-10 | Created from code review | Defense in depth: even within a trusted network, authenticate service-to-service calls |

## Resources

- OWASP API Security: Broken Authentication
