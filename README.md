# Grindbot

Local task management tool that farms out todo items to independent Claude Code CLI processes. Define tasks through a web UI, and a polling server spawns Claude for each one, captures the output, and lets you review, approve, reject, or answer questions before marking tasks complete.

When tmux is installed, tasks run as interactive Claude sessions inside tmux — you can click "Open" on a running task to attach a Terminal window and watch or interact with Claude in real time.

## Setup

```
npm install
brew install tmux   # optional but recommended
node server.js
```

Open http://localhost:3000.

Requires the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated.

### tmux (recommended)

With tmux installed, Claude runs in interactive mode inside tmux sessions. This lets you:
- Click the **Open** button on a running task to watch Claude work in Terminal.app
- Interact with the Claude session directly (ask follow-ups, provide guidance)
- Claude stays alive after responding, waiting for further input

Without tmux, the server falls back to non-interactive `claude -p` mode (original behavior, no terminal button).

## How it works

1. **Create a task** — give it a title and description of what Claude should do.
2. **Start polling** — the server picks up pending tasks and spawns Claude with `--dangerously-skip-permissions` in the configured working directory.
3. **Watch live** (tmux mode) — click "Open" on a running task to attach a terminal and interact with Claude.
4. **Review output** — when Claude finishes (or the tmux session ends), the task moves to "review". Expand it to see what Claude did.
5. **Approve or reject** — approve to mark complete, or reject with feedback to send it back for another round.
6. **Answer questions** — if Claude outputs a `[QUESTION]:` marker, the task pauses for your input.

## Task lifecycle

```
pending → running → review → completed
                  ↘ question → pending (answered) → running → ...
         review → pending (rejected with feedback) → running → ...
```

## Configuration

- **Polling interval** — how often the server checks for pending tasks (adjustable in the UI header)
- **Working directory** — the cwd passed to Claude processes (set in Settings at the bottom of the page)
- **Dark mode** — toggle via the moon/sun button in the header (persisted in localStorage)

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tasks` | List all tasks |
| POST | `/api/tasks` | Create task (`{ title, description }`) |
| PATCH | `/api/tasks/:id` | Update task (status transitions, feedback) |
| DELETE | `/api/tasks/:id` | Delete task (kills process/session if running) |
| POST | `/api/tasks/:id/terminal` | Open Terminal.app attached to the task's tmux session |
| GET | `/api/config` | Get config (includes `hasTmux` flag) |
| PATCH | `/api/config` | Update config |
| POST | `/api/polling/start` | Start polling engine |
| POST | `/api/polling/stop` | Stop polling engine |
| GET | `/api/polling/status` | Check if polling is active |
