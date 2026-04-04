# Conductor

Multi-agent Claude Code orchestration platform with real-time observability. Forked from claudecodeui, with observability components from agents-observe.

## Quick Start

```bash
npm install
npm run dev          # Express (3001) + Vite (5173) concurrently
npm run server       # Backend only
npm run build && npm start  # Production
```

## Project Structure

```
server/
  index.js              # Main Express server, routes, WebSocket
  cli.js                # CLI entry point (#!/usr/bin/env node)
  process-manager/      # Spawn/kill/monitor CC subprocesses (stream-json)
  mcp-broker/           # Inter-agent messaging MCP server (port 3101)
  context-monitor/      # Token tracking, auto-compact, fork, checkpoint
  container-manager/    # Docker container isolation per agent
  scheduler/            # Cron-based task runner
  routes/               # Express route modules (agent, mcp, scheduler, git, projects, etc.)
  database/             # SQLite schema + migrations
  middleware/            # Auth, error handling
  services/             # Business logic layer
  providers/            # CLI provider abstractions (claude, cursor, gemini, codex)

src/
  components/
    observability/      # Ported from agents-observe
      timeline/         # ActivityTimeline, AgentLane
      event-stream/     # EventRow, EventDetail, EventStream
    orchestration/      # Multi-agent UI
      AgentGrid.tsx     # Agent dashboard with context meters
      MessageBus.tsx    # Live inter-agent message feed
    chat/               # Chat interface + tool rendering
    shell/              # xterm.js terminal
    code-editor/        # CodeMirror editor
    sidebar/            # Navigation
    settings/           # Config panels
    task-master/        # Task management UI
  main.jsx              # Vite React entry point

shared/                 # Types/utils shared between server and client
```

## Architecture

CC instances are spawned as subprocesses with `--output-format stream-json` and `--input-format stream-json`. The backend parses the JSON event stream and forwards events over WebSocket to the browser UI.

Inter-agent communication uses a custom MCP server (port 3101) injected into each agent's config. Agents get tools: `send_message`, `read_messages`, `list_agents`, `get_shared_state`, `set_shared_state`, `request_review`.

Context lifecycle is managed by tracking token usage from stream events and triggering compact/fork/checkpoint via CC's stdin.

## Key Conventions

- **ES Modules** throughout (`"type": "module"` in package.json)
- Server code is plain JS (no TypeScript compilation needed)
- Frontend is React JSX/TSX, built with Vite
- Database is SQLite via `better-sqlite3`, stored at `~/.cloudcli/auth.db` (override with `DATABASE_PATH`)
- Styling: Tailwind CSS v3 + Radix UI primitives + Lucide icons
- Auth: bcrypt password hashing + JWT tokens

## Environment Variables

See `.env.example`. Key ones:
- `SERVER_PORT` — Express server (default 3001)
- `VITE_PORT` — Vite dev server (default 5173)
- `HOST` — Bind address (default 0.0.0.0)
- `CONTEXT_WINDOW` / `VITE_CONTEXT_WINDOW` — Token budget (default 160000)
- `DATABASE_PATH` — Custom SQLite path
- `CLAUDE_CLI_PATH` — Custom claude CLI path (default "claude")

## Working on Conductor Modules

The five conductor-specific modules live under `server/` and each export a class extending EventEmitter:

| Module | Class | Purpose |
|--------|-------|---------|
| `process-manager/` | `ProcessManager` | `spawn()`, `sendInput()`, `compact()`, `kill()`, `list()` |
| `mcp-broker/` | `MCPBroker` | `start()`, `stop()`, `getMCPConfig()`, `_callTool()` |
| `context-monitor/` | `ContextMonitor` | `onUsage()`, `setThreshold()`, `checkpoint()`, `fork()`, `restore()` |
| `container-manager/` | `ContainerManager` | `spawn()`, `stop()`, `list()`, `ensureImage()` |
| `scheduler/` | `Scheduler` | `start()`, `stop()`, `createTask()`, `deleteTask()`, `listTasks()` |

These modules need to be wired into `server/index.js` and connected to the frontend via WebSocket events.

## Current Status

The conductor modules are scaffolded but not yet fully integrated into the main server. See `SPEC.md` for the full design spec and architecture details.

## Deployment

Currently deployed on `ethan@10.1.1.4` (Debian Linux) at `~/conducctor`, running on port 3001. SSH key at `~/.ssh/id_conducctor_deploy`.
