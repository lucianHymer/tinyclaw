# Dashboard Onboarding Wizard

**Date:** 2026-02-12
**Status:** Draft
**Branch:** TBD

## What We're Building

A full-screen, slide-by-slide onboarding wizard served at `/onboarding` on the dashboard. New developers walk through a polished, illustrated flow that:

1. Welcomes them and explains what they're getting
2. Guides them through SSH key setup (or accepts an existing key)
3. Collects their name and email
4. Creates a dev container automatically
5. Hands them connection details with a copy button

The result: a new dev goes from "I got invited" to "I'm SSH'd into my container" in under 5 minutes, entirely self-service.

## Why This Approach

### Separate page, not a dashboard route
- `dashboard.html` is already 2,000+ lines. Adding a full slide deck would bloat it further.
- Onboarding has a fundamentally different UX — full-screen, linear, no nav chrome. It doesn't belong in the dashboard shell.
- A standalone `onboarding.html` can be purpose-built for the slide deck pattern without fighting existing layout.

### Generated illustrations, not SVG/CSS
- The goal is a premium, welcoming first impression — not a developer tool aesthetic.
- Gemini-generated illustrations give each slide personality and visual warmth.
- Static images served from `/static/onboarding/` — no runtime dependency on generation APIs.

### Self-service, gated by Cloudflare Access
- Dashboard is already behind Cloudflare Access with company email SSO.
- Anyone who can reach `/onboarding` is already authenticated — no additional auth needed.
- No invite links, no tokens, no approval flow.

## The Flow (Slide by Slide)

### Slide 1: Welcome
- Hero illustration (claw machine / mascot concept)
- "Welcome to TinyClaw" headline
- Brief description: "Your own dev container with Claude, SSH access, and a Telegram thread."
- [Get Started] button

### Slide 2: SSH Key Check
- Illustration of a key / lock concept
- "Do you have an SSH key?"
- Two paths:
  - [Yes, I have one] → Skip to Slide 4 (Upload)
  - [No, help me create one] → Go to Slide 3 (Guide)

### Slide 3: SSH Key Creation Guide (conditional)
- Terminal/Mac illustration
- Step-by-step instructions for Mac:
  1. Open Terminal
  2. `ssh-keygen -t ed25519 -C "your-email"`
  3. Save to default location (`~/.ssh/id_ed25519`)
  4. Add to macOS keychain: `ssh-add --apple-use-keychain ~/.ssh/id_ed25519`
  5. Add `AddKeysToAgent yes` and `UseKeychain yes` to `~/.ssh/config`
- Expandable section for Linux/Windows alternatives
- [I've created my key] → Go to Slide 4

### Slide 4: Upload SSH Key
- Illustration of uploading/sharing
- "Paste your public SSH key"
- Instructions: `cat ~/.ssh/id_ed25519.pub | pbcopy`
- Text area for pasting the key
- Basic validation (starts with `ssh-ed25519` or `ssh-rsa`, etc.)
- [Next] button

### Slide 5: About You
- People/profile illustration
- Name field
- Email field (pre-filled from Cloudflare Access headers if available)
- [Create My Container] button

### Slide 6: Creating Your Space
- Animated/progress illustration
- "Setting up your dev container..."
- Progress steps shown as they complete:
  - Creating container...
  - Configuring SSH...
  - Injecting credentials...
  - Ready!
- Auto-advances to Slide 7 on completion
- Error state: if creation fails, show error message with retry button (plan should define specific error cases)

### Slide 7: You're In!
- Celebration illustration
- SSH config snippet with copy button (personalized with their name):
  ```
  Host tinyclaw-<name>
    HostName <server>
    Port <assigned-port>
    User dev
    IdentityFile ~/.ssh/id_ed25519
  ```
- "Paste this into `~/.ssh/config`, then run `ssh tinyclaw-<name>`"
- [Open Dashboard] button (links to `#memory` view where they can see their container)

## Key Decisions

1. **Separate HTML file** (`static/onboarding.html`) — not inside `dashboard.html`
2. **Gemini-generated static images** — generated once, committed to `static/onboarding/`
3. **Self-service** — no admin approval, Cloudflare Access is the gate
4. **Mac-first SSH guide** — ed25519 + keychain, with expandable alternatives
5. **Auto port assignment** — backend picks next available port from a range
6. **Container appears in Memory view** — no separate "my container" page needed post-onboarding
7. **Email from Cloudflare headers** — pre-fill if `Cf-Access-Authenticated-User-Email` header is present

## Backend Requirements

### New endpoint: `POST /api/containers/create`
- Accepts: `{ name, email, sshPublicKey }`
- Sanitize name (lowercase, alphanumeric + hyphens, max 32 chars)
- Auto-assign port from configured range (e.g., 2201-2299)
- Create container, inject SSH key, set git config, apply labels (`tinyclaw.type=dev-container`)
- Return: `{ containerId, name, port, host, sshConfig }`

### Docker proxy constraint
The dashboard currently reaches Docker through a restricted socket proxy (wollomatic) that only allows container listing, inspection, stats, memory updates, and ping. Container creation requires `POST /containers/create`, `POST /containers/{id}/start`, and `POST /exec` (SSH key injection + git config) — all currently blocked. The `exec` endpoint was specifically flagged as a security risk during architecture review. The plan must decide how to handle privileged container provisioning (expand proxy rules, queue-based provisioning, or privileged sidecar).

### Port management
- Derive assigned ports from running `dev-*` containers (no separate state file)
- Pick lowest available port in range, validate no collision before creating

### Container naming
- `dev-<sanitized-name>` — consistent with existing `create-dev-container.sh`

## Resolved Questions

1. **Memory default** — Fixed at 2GB. No user choice. Admin adjusts later via Memory view if needed.
2. **Email usage** — Used for `git config --global user.email` inside the container. Name used for `git config --global user.name`. Set via `docker exec` after container creation (overrides the generic system-level config in Dockerfile).
3. **Illustration style** — Playful & warm. Friendly illustrations with character, bright colors. Think Notion/Slack onboarding aesthetic.
4. **Form fields** — Only 3: name, email, SSH public key. That's everything needed. Port is auto-assigned, memory is fixed, BROKER_SECRET comes from host env.
5. **Gemini image generation** — Use Gemini API (free tier) to generate illustrations for each slide. Commit as static assets to `static/onboarding/`.
6. **Port range** — 2201-2299 (consistent with existing script example, supports up to 99 containers).
7. **Cleanup** — Admin-only. Already covered by Out of Scope.
8. **Duplicate prevention** — Not needed. Dev containers are cattle, not pets. Users can create multiple containers. If a name collides, append a number (e.g., `dev-alice-2`).

## Open Questions

None — all resolved. Dev containers are cattle (disposable, multiple per user OK), so re-onboarding just creates another container.

## Out of Scope

- Container start/stop/delete from the wizard (admin manages lifecycle via scripts or Memory view)
- IDE integration or VS Code Remote setup
- Multi-container limits (users can create as many as they want — cattle, not pets)
- Resource selection beyond memory (CPU is fixed at 2 cores)
