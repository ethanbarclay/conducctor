# Conductor - Multi-Agent Claude Code Orchestration Platform

## Project Spec

### Origin & Motivation

Conductor was born from frustrations with NanoClaw, a Discord-based multi-agent Claude Code orchestrator. NanoClaw runs real Claude Code instances (not Agent SDK) which is its core strength, but suffers from:

- **Poor observability** — no visibility into thinking, intermediate steps, or tool calls while agents execute
- **Context blowup** — conversations grow unbounded until NanoClaw gets overwhelmed and restarts
- **Discord limitations** — markdown-only rendering, no structured UI for agent state, poor mobile experience
- **No orchestration controls** — can't fork sessions, checkpoint, compact on demand, or manage agent lifecycles

Conductor keeps what works (real CC instances via `--output-format stream-json`) and replaces everything else with a purpose-built web UI and orchestration backend.

---

### Core Principles

1. **Real Claude Code, not SDK** — spawn actual `claude` CLI subprocesses. Get all built-in tools (Bash, file ops, web fetch), MCP support, worktrees, memory files for free.
2. **Full observability** — stream thinking blocks, tool calls with inputs/outputs, subagent trees, token usage, and compaction events in real time.
3. **Context lifecycle management** — never let an agent die from context overflow. Compact, fork, checkpoint, restore, and hand off summaries automatically.
4. **Multi-agent orchestration** — coordinate multiple CC instances via an MCP message broker, with shared state and a visual dashboard.
5. **Mobile-first control plane** — the web UI must work well on phones for monitoring and controlling agents on the go.

---

### Architecture

```
Browser (Desktop / Mobile)
    |
    WebSocket + REST
    |
Your Backend (Node.js + Express)
├── Process Manager        spawn/kill/monitor CC subprocesses
├── Stream Parser          stream-json events -> DB + WebSocket -> UI
├── MCP Broker Server      inter-agent messaging + shared state (port 3101)
├── Context Monitor        token tracking, auto-compact triggers, fork/checkpoint
├── Session Store          SQLite: sessions, messages, checkpoints, tasks
├── Scheduler              cron-based task runner
├── Container Manager      Docker isolation per agent
└── Hook Receiver          CC hooks -> DB for observability events
    |
    spawns
    |
CC Instances (one per agent)
    --output-format stream-json   (observability stream)
    --input-format stream-json    (control channel)
    --mcp-config { broker }       (inter-agent messaging)
    CC hooks -> POST to backend   (file changes, permissions, subagent lifecycle)
```

---

### Key Features

#### 1. Real-Time Observability

Two complementary data sources:
- **stream-json** — thinking blocks, tool call inputs/outputs, text output, token usage (live)
- **CC Hooks** — file changes, permission requests, subagent lifecycle, compaction events (event-driven)

UI components:
- **Activity Timeline** — per-agent lanes with time scrubbing (1m/5m/10m/60m)
- **Event Stream** — expandable rows: icon + type + tool name + status + summary + timestamp
- **Event Detail** — full inputs/outputs for any tool call
- **Agent Tree** — nested view of intra-session subagents spawned via CC's Agent tool
- **Token Meter** — color-coded context usage per agent (green < 50%, yellow 50-80%, red > 80%)

#### 2. Context Lifecycle Management

State machine per session:
```
ACTIVE --(80% ctx)--> WARN --(manual/auto)--> COMPACTING --> ACTIVE (fresh)
  |                                                            |
  +--(fork)------------------------------------------------> BRANCH
  |                                                            |
  +--(checkpoint)-------------------------------------------> SAVED
```

Controls exposed in UI:
- **Compact Now** — write `/compact` to CC stdin
- **Auto-compact threshold** — configurable per agent (default 75%)
- **Fork** — copy session directory, start new CC instance with `--resume`
- **Checkpoint** — snapshot session to storage, restore later
- **Summary Handoff** — compact, capture summary, kill instance, start fresh with summary injected

#### 3. Multi-Agent Orchestration

**Two layers of parallelism:**

Layer 1 — **Intra-session** (CC's built-in Agent tool): parsed from stream-json, displayed as a tree in the UI. No extra work needed.

Layer 2 — **Inter-session** (custom orchestration): multiple top-level CC instances coordinated by the backend via MCP broker.

**MCP Broker Tools** (exposed to every agent):
| Tool | Purpose |
|------|---------|
| `send_message(to, content)` | Post message to another agent |
| `read_messages()` | Poll inbox for new messages |
| `list_agents()` | Discover running agents |
| `get_shared_state(key)` | Read from shared blackboard |
| `set_shared_state(key, value)` | Write to shared blackboard |
| `request_review(reviewer, context)` | Ask another agent to review work |

**Message broker architecture:**
```
CC Instance A --> MCP tool: send_message("agent-b", "API ready")
                      |
              Backend (broker + SQLite)
                      |
CC Instance B <-- MCP tool: read_messages() -> ["API ready"]
```

#### 4. Container Isolation

Per-agent Docker containers with configurable isolation levels:
| Level | Description |
|-------|-------------|
| None | Spawn CC directly on host (fastest, least safe) |
| Worktree | Git worktree isolation (filesystem only) |
| Docker | Full container per session (recommended default) |
| Docker + gVisor | Hardened container for untrusted workloads |

Default container config: 2GB memory, 2 CPUs, workspace mounted at `/workspace:rw`, MCP broker accessible via `host.docker.internal`.

#### 5. Scheduled Tasks

Cron-based task runner:
```sql
scheduled_tasks (id, name, cron_expression, prompt, project_id, agent_role, use_container, enabled, last_run, next_run)
task_runs (id, task_id, agent_id, started_at, ended_at, status)
```

More powerful than NanoClaw because scheduled agents get full stream visibility, can participate in multi-agent workflows, and chain into other tasks.

#### 6. Mobile Control Plane

Not a responsive afterthought — a first-class mobile interface:
- Monitor all running agents, their status, and context usage
- Read thinking streams and tool call summaries
- Send messages to agents, approve/reject actions
- Kick off new tasks, pause/resume agents
- Push notifications for agent completion, errors, review requests

Desktop gets the full IDE experience (optionally with code-server iframe). Mobile gets the agent control plane.

---

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, Tailwind CSS v3, Radix UI, Lucide icons |
| Terminal | xterm.js |
| Code editor | CodeMirror |
| Backend | Node.js, Express, WebSocket (ws) |
| Database | SQLite (better-sqlite3) |
| Auth | bcrypt + JWT |
| CC Integration | `claude` CLI via child_process spawn, stream-json I/O |
| Inter-agent | Custom MCP server on port 3101 |
| Containers | Docker API |
| Scheduling | node-cron |

---

### Database Schema (Conductor additions)

```sql
-- Inter-agent messaging
agent_messages (id, from_agent, to_agent, content, read, created_at)
shared_state (key, value, updated_by, updated_at)

-- Context monitoring
context_snapshots (id, agent_id, session_id, input_tokens, output_tokens, pct_used, event, created_at)
session_checkpoints (id, agent_id, session_id, label, snapshot_path, summary, created_at)

-- Scheduling
scheduled_tasks (id, name, cron_expression, prompt, project_id, agent_role, use_container, enabled, last_run, next_run, created_at)
task_runs (id, task_id, agent_id, started_at, ended_at, status)
```

---

### Project Heritage

- **Base UI**: Forked from [claudecodeui](https://github.com/siteboon/claudecodeui) (~62K LOC) — provides session management, stream-json subprocess handling, mobile-responsive UI, WebSocket layer
- **Observability components**: Ported from [agents-observe](https://github.com/simple10/agents-observe) (~11K LOC) — ActivityTimeline, AgentLane, EventRow, EventDetail, EventFilterBar
- **Orchestration layer**: Custom-built — process manager, MCP broker, context monitor, container manager, scheduler

---

### Future Considerations

- **code-server integration** — embed VS Code (via iframe) for desktop users who want to see file changes live
- **Multi-channel input** — optionally accept commands from Telegram/WhatsApp as remote control interfaces
- **Workflow builder** — visual editor for multi-agent workflows ("when QA passes, Coordinator reviews")
- **Agent templates/roles** — pre-configured agent personas with specific CLAUDE.md, MCP tools, and skill sets
