<div align="center">
  <h1>Conducctor</h1>
  <p>Multi-agent orchestration platform for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a> with real-time observability, inter-agent messaging, container isolation, and scheduled tasks.</p>
  <p>Built on <a href="https://github.com/siteboon/claudecodeui">CloudCLI</a></p>
</div>

---

## What is Conducctor?

Conducctor turns Claude Code from a single-session coding assistant into a **multi-agent orchestration platform**. Spawn multiple CC instances, have them communicate via MCP tools, schedule recurring tasks, and watch everything happen in real-time through a unified observability dashboard.

The "cc" in Condu**cc**tor stands for Claude Code.

## Key Features

### Multi-Agent Orchestration
- **Spawn agents** from the UI or let agents spawn sub-agents via MCP
- **Inter-agent messaging** — agents communicate via `send_message` / `read_messages`
- **Shared state blackboard** — `get_shared_state` / `set_shared_state` for coordination
- **Auto-coordination** — sub-agents report results back, spawner auto-triggers follow-up turns

### Real-Time Observability
- **Activity Timeline** — horizontal scrolling lanes with drifting event dots per agent
- **Event Stream** — unified feed of thinking, text, tool calls, and results with filtering
- **Agent Activity Feed** — per-agent collapsible activity log with subagent tree rendering
- **CC Hooks Receiver** — captures PreToolUse, PostToolUse, SubagentStart/Stop, SessionStart/Stop

### Container Isolation
- **Docker by default** — each agent runs in an isolated container (512MB, 1 CPU)
- **Host path mapping** — containers mirror host filesystem paths for correct session tracking
- **Danger toggle** — disable container isolation with prominent warning in Quick Settings

### Scheduling
- **Cron-based scheduler** — create recurring agent tasks with proper `node-cron`
- **MCP tools** — agents can `schedule_task`, `update_scheduled_task`, `run_scheduled_task`, `list_scheduled_tasks`
- **Scheduler UI** — create, enable/disable, run now, view history
- **Configurable timezone** — `SCHEDULER_TIMEZONE` env var

### Context Lifecycle Management
- **Token usage pie** — click to access Compact, Fork, Checkpoint actions
- **Auto-compact** — configurable threshold triggers automatic compaction
- **Fork** — branch a session to explore a different direction
- **Checkpoint/Restore** — snapshot and restore session state

### 12 MCP Tools
Every agent gets access to:

| Tool | Purpose |
|------|---------|
| `send_message` | Message another agent |
| `read_messages` | Check inbox |
| `list_agents` | Discover running agents |
| `get_shared_state` / `set_shared_state` | Shared blackboard |
| `request_review` | Ask another agent to review work |
| `spawn_agent` | Create a sub-agent |
| `schedule_task` | Create a cron task |
| `list_scheduled_tasks` | View all tasks |
| `update_scheduled_task` | Modify a task |
| `run_scheduled_task` | Trigger a task now |
| `delete_scheduled_task` | Remove a task |

## Architecture

```mermaid
graph TB
    subgraph Browser["🖥️ Browser"]
        UI["Conducctor UI"]
        subgraph Tabs[" "]
            Chat["💬 Chat"]
            Shell["⌨️ Shell"]
            Agents["🤖 Agents"]
            Observe["👁️ Observe"]
            Scheduler["⏰ Scheduler"]
        end
    end

    UI <-->|"WebSocket"| Server
    UI -->|"REST API"| Server

    subgraph Server["⚡ Conducctor Server"]
        PM["Process Manager"]
        CM["Container Manager"]
        CM2["Context Monitor"]
        MCPBroker["MCP Broker :3101<br/>12 tools"]
        Sched["Scheduler<br/>node-cron"]
        Hooks["Hooks Receiver"]
        Bridge["Stream Bridge<br/>stream-json → UI"]
        DB[("SQLite<br/>agents · messages<br/>checkpoints · tasks")]
    end

    PM --> CM
    PM --> CM2
    PM <--> MCPBroker
    Sched --> PM
    Hooks --> DB
    MCPBroker --> DB

    subgraph Docker["🐳 Docker · Per-Agent Container"]
        CC["claude CLI<br/>--output-format stream-json<br/>--mcp-config conductor"]
        StdioBridge["MCP Stdio Bridge<br/>JSON-RPC → HTTP"]
        HookRelay["Hook Relay<br/>stdin → POST"]

        CC <-->|"stdio"| StdioBridge
        CC -->|"hooks"| HookRelay

        subgraph Subagents["CC Built-in Subagents"]
            Sub1["🔍 Explore"]
            Sub2["📋 Plan"]
            Sub3["🛠️ general-purpose"]
        end
        CC --> Sub1
        CC --> Sub2
        CC --> Sub3
    end

    CM -->|"docker run"| Docker
    StdioBridge -->|"HTTP POST"| MCPBroker
    HookRelay -->|"HTTP POST"| Hooks
    CC -->|"stream-json"| PM
    PM --> Bridge
    Bridge -->|"events"| UI

    MCPBroker <-.->|"send_message · spawn_agent<br/>read_messages · schedule_task"| MCPBroker

    style Browser fill:#0f172a,stroke:#22d3ee,stroke-width:2px,color:#e2e8f0
    style Server fill:#1e293b,stroke:#3b82f6,stroke-width:2px,color:#e2e8f0
    style Docker fill:#1a1a2e,stroke:#a855f7,stroke-width:2px,color:#e2e8f0
    style Tabs fill:#0f172a,stroke:#22d3ee,stroke-width:1px,color:#e2e8f0
    style Subagents fill:#1a1a2e,stroke:#a855f7,stroke-width:1px,color:#c4b5fd,stroke-dasharray:4
    style DB fill:#1e293b,stroke:#f59e0b,stroke-width:2px,color:#fbbf24
    style MCPBroker fill:#1e293b,stroke:#10b981,stroke-width:2px,color:#6ee7b7
    style CC fill:#2d1b69,stroke:#a855f7,stroke-width:2px,color:#e2e8f0
    style UI fill:#0c4a6e,stroke:#22d3ee,stroke-width:2px,color:#e2e8f0
```

## Quick Start

```bash
git clone https://github.com/ethanbarclay/conducctor.git
cd conducctor
npm install
npm run dev          # Express (3001) + Vite (5173)
```

Open **http://localhost:5173** in your browser.

### Production

```bash
npm run build
npm start            # Serves on port 3001
```

### Docker Agent Image

```bash
docker build -t conductor-agent:latest -f docker/Dockerfile.agent .
```

## UI Tabs

| Tab | Icon | Description |
|-----|------|-------------|
| Chat | MessageSquare | Standard CC chat interface |
| Shell | Terminal | xterm.js terminal |
| Files | Folder | File browser |
| Source Control | GitBranch | Git panel |
| Agents | Cpu | Multi-agent dashboard with spawn dialog |
| Observe | Eye | Timeline + event stream + filters |
| Scheduler | Clock | Scheduled tasks CRUD |

## Environment Variables

```bash
SERVER_PORT=3001              # API server port
VITE_PORT=5173                # Dev server port
HOST=0.0.0.0                  # Bind address
CONTEXT_WINDOW=160000         # Token budget
SCHEDULER_TIMEZONE=           # Cron timezone (default: system)
DATABASE_PATH=                # Custom SQLite path
CLAUDE_CLI_PATH=claude        # Custom CLI path
MCP_BROKER_PORT=3101          # MCP broker port
AUTO_COMPACT_THRESHOLD=0.75   # Auto-compact at 75%
```

## Heritage

- **Base UI**: [CloudCLI / claudecodeui](https://github.com/siteboon/claudecodeui) — session management, chat interface, mobile-responsive UI
- **Observability inspiration**: [agents-observe](https://github.com/simple10/agents-observe) — timeline concept and event visualization patterns
- **Origin**: [NanoClaw](https://github.com/dnakov/nanoclaw) — Discord-based multi-agent CC orchestrator that inspired this project
- **Orchestration layer**: Custom-built — process manager, MCP broker, stdio bridge, container manager, context monitor, scheduler, hooks receiver

## License

AGPL-3.0-or-later (inherited from CloudCLI)
