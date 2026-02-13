# Grindbot

Local task management tool that farms out todo items to independent Claude Code CLI processes. Define tasks through a web UI, and a polling server spawns `claude -p` for each one, captures the output, and lets you review, approve, reject, or answer questions before marking tasks complete.

## Setup

```
npm install
node server.js
```

Open http://localhost:3000.

Requires the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated.

## How it works

1. **Create a task** — give it a title and description of what Claude should do.
2. **Start polling** — the server picks up pending tasks and spawns `claude -p` with `--dangerously-skip-permissions` in the configured working directory.
3. **Review output** — when a Claude process finishes, the task moves to "review". Expand it to see what Claude did.
4. **Approve or reject** — approve to mark complete, or reject with feedback to send it back for another round.
5. **Answer questions** — if Claude outputs a `[QUESTION]:` marker, the task pauses for your input.

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
| DELETE | `/api/tasks/:id` | Delete task (kills process if running) |
| GET | `/api/config` | Get config |
| PATCH | `/api/config` | Update config |
| POST | `/api/polling/start` | Start polling engine |
| POST | `/api/polling/stop` | Stop polling engine |
| GET | `/api/polling/status` | Check if polling is active |
