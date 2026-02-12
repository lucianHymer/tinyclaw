# Getting Started with TinyClaw

## Two Ways to Work

**Telegram** — Quick tasks, questions, kicking things off. Open the Telegram group,
pick a forum topic (each one is a separate Claude session on a specific repo),
and message it. Claude reads the code, does the work, responds.

**Claude Code CLI** — Deep work. SSH into your container, run
`claude --dangerously-skip-permissions` in a repo, and let it loose on complex
multi-file changes, long debugging sessions, or anything that needs
bypass-permissions mode.

Both interfaces talk to the same repos. Use whichever fits the task.

## Telegram Setup

1. Join the Telegram group (link from your admin)
2. Pick a topic and say hi

## CLI Setup

### One-time setup (30 seconds)

Add this to your ~/.ssh/config:

    Host claude-dev
        HostName <hetzner-ip>
        Port 220X
        User dev
        IdentityFile ~/.ssh/<your-key>

### First connection

    ssh claude-dev
    claude login          # One-time: authenticates with your Claude Max plan

### Every time after that

    ssh claude-dev        # You're back where you left off, even after disconnects
    cd repos/<project>
    claude                # Start Claude Code

### If you need a second terminal pane

    Right-click -> "Split Right" or "Split Below"
    Click a pane to switch to it
    Drag borders to resize

    This is using tmux, if you want to go deeper and/or customize your ~/.tmuxconf
