/**
 * Conductor Process Manager
 *
 * Spawns and manages Claude Code subprocess instances.
 * First message uses -p (print mode). Follow-up messages spawn a new
 * process with --resume to continue the same session.
 */

import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { sessionProvenanceDb } from '../database/db.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const BRIDGE_SCRIPT = join(__dirname, '..', 'mcp-stdio-bridge.js')

export class ProcessManager extends EventEmitter {
  constructor({ db, contextMonitor, containerManager }) {
    super()
    this.db = db
    this.contextMonitor = contextMonitor
    this.containerManager = containerManager
    this.agents = new Map() // agentId → { sessionId, projectId, role, ... }
    this.activeProcs = new Map() // agentId → child_process (only while running)
  }

  /**
   * Spawn a new Claude Code agent process.
   * Uses -p for the initial prompt (reliable single-shot with output).
   * Follow-up messages use --resume with the captured session ID.
   */
  async spawn(opts) {
    const agentId = opts.agentId || randomUUID()

    this.agents.set(agentId, {
      sessionId: opts.sessionId || null,
      projectId: opts.projectId,
      role: opts.role || 'agent',
      provider: opts.provider || 'claude',
      mangoProvider: opts.mangoProvider || 'google-vertex',
      model: opts.model || null,
      useContainer: !!opts.useContainer,
      permissionMode: opts.permissionMode || null,
      skipPermissions: !!opts.skipPermissions,
      allowedTools: opts.allowedTools || [],
      disallowedTools: opts.disallowedTools || [],
      startedAt: Date.now(),
      tokenUsage: { input: 0, output: 0 },
      busy: false,
      // Spawn provenance — written to session_provenance once sessionId arrives.
      // Caller-supplied; absence means we won't record a row (treated as plain chat).
      provenance: opts.provenance || null,
    })

    // If a sessionId was supplied up-front (e.g. resuming) record provenance now.
    if (opts.sessionId && opts.provenance) {
      this._writeProvenance(agentId, opts.sessionId)
    }

    this.emit('agent:spawned', { agentId, ...opts })

    // If there's a prompt, run it now
    if (opts.prompt) {
      await this._runTurn(agentId, opts.prompt, opts.sessionId)
    }

    return agentId
  }

  /**
   * Write the agent's pending provenance row to SQLite. Idempotent — uses upsert.
   */
  _writeProvenance(agentId, sessionId) {
    const agent = this.agents.get(agentId)
    if (!agent || !agent.provenance || !sessionId) return
    sessionProvenanceDb.record({
      sessionId,
      origin: agent.provenance.origin,
      role: agent.provenance.role ?? agent.role,
      agentId,
      parentSessionId: agent.provenance.parentSessionId,
      parentAgentId: agent.provenance.parentAgentId,
      parentRole: agent.provenance.parentRole,
      scheduledTaskId: agent.provenance.scheduledTaskId,
      scheduledTaskName: agent.provenance.scheduledTaskName,
      projectId: agent.projectId || agent.provenance.projectId,
    })
  }

  /**
   * Send a follow-up message to an agent. Spawns a new --resume process.
   * If the agent is busy, queues the message for when the current turn completes.
   */
  async sendInput(agentId, message) {
    const agent = this.agents.get(agentId)
    if (!agent) throw new Error(`Agent ${agentId} not found`)
    if (!agent.sessionId) throw new Error(`Agent ${agentId} has no session to resume`)

    if (agent.busy) {
      // Queue the message for after the current turn
      if (!agent.pendingMessages) agent.pendingMessages = []
      agent.pendingMessages.push(message)
      console.log(`[ProcessManager] Agent ${agentId.slice(0, 8)} busy, queued message (${agent.pendingMessages.length} pending)`)
      return
    }

    await this._runTurn(agentId, message, agent.sessionId)

    // Process any queued messages
    while (agent.pendingMessages?.length > 0) {
      const next = agent.pendingMessages.shift()
      await this._runTurn(agentId, next, agent.sessionId)
    }
  }

  /**
   * Trigger compaction on an agent
   */
  async compact(agentId) {
    return this.sendInput(agentId, '/compact')
  }

  /**
   * Kill an active agent process
   */
  kill(agentId, signal = 'SIGTERM') {
    const proc = this.activeProcs.get(agentId)
    if (proc) {
      proc.kill(signal)
      this.activeProcs.delete(agentId)
    }
    this.agents.delete(agentId)
    this.emit('agent:killed', { agentId })
  }

  /**
   * List all agents (both idle and busy)
   */
  list() {
    return Array.from(this.agents.entries()).map(([agentId, entry]) => ({
      agentId,
      role: entry.role,
      projectId: entry.projectId,
      sessionId: entry.sessionId,
      startedAt: entry.startedAt,
      tokenUsage: entry.tokenUsage,
      busy: entry.busy,
    }))
  }

  /**
   * Update the stored session ID for an agent
   */
  setSessionId(agentId, sessionId) {
    const agent = this.agents.get(agentId)
    if (agent) {
      agent.sessionId = sessionId
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  /**
   * Run a single turn: spawn claude -p "message" (or --resume), collect output, emit events
   */
  _runTurn(agentId, message, sessionId) {
    return new Promise((resolve, reject) => {
      const agent = this.agents.get(agentId)
      if (!agent) return reject(new Error('Agent not found'))

      agent.busy = true

      const isGemini = agent.provider === 'gemini'
      const isMango = agent.provider === 'mangocode'
      const cliBinary = isGemini ? 'gemini' : isMango ? 'mangocode' : 'claude'
      const args = ['--output-format', 'stream-json']

      if (!isGemini && !isMango) args.push('--verbose')

      // MangoCode provider flag (e.g. google-vertex)
      if (isMango) {
        args.push('--provider', agent.mangoProvider || 'google-vertex')
        // Ensure Vertex env vars are set for the process
        if (!process.env.VERTEX_PROJECT_ID) {
          process.env.VERTEX_PROJECT_ID = process.env.VERTEX_PROJECT_ID || 'projectpee'
          process.env.VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1'
          process.env.VERTEX_AUTH_MODE = 'gcloud'
        }
      }

      // Model
      if (agent.model) {
        args.push('--model', agent.model)
      }

      if (isGemini) {
        // Gemini-specific flags
        args.push('--yolo') // auto-approve all tools
      } else {
        // Claude + MangoCode shared flags
        if (agent.skipPermissions || agent.permissionMode === 'bypassPermissions') {
          args.push('--dangerously-skip-permissions')
        } else if (agent.permissionMode && agent.permissionMode !== 'default') {
          // MangoCode uses kebab-case permission modes
          const modeMap = { acceptEdits: 'accept-edits', plan: 'plan' }
          const mode = isMango ? (modeMap[agent.permissionMode] || agent.permissionMode) : agent.permissionMode
          args.push('--permission-mode', mode)
        }

        // Hook settings for observability (Claude + MangoCode)
        const hookSettings = this._buildHookSettings(agent)
        if (hookSettings) {
          args.push('--settings', hookSettings)
        }

        // Allowed tools (Claude only — Gemini uses --yolo)
        const conductorTools = [
          'mcp__conductor__send_message',
          'mcp__conductor__read_messages',
          'mcp__conductor__list_agents',
          'mcp__conductor__get_shared_state',
          'mcp__conductor__set_shared_state',
          'mcp__conductor__request_review',
          'mcp__conductor__spawn_agent',
          'mcp__conductor__schedule_task',
          'mcp__conductor__list_scheduled_tasks',
          'mcp__conductor__update_scheduled_task',
          'mcp__conductor__run_scheduled_task',
          'mcp__conductor__delete_scheduled_task',
          'WebSearch', 'WebFetch',
          'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'NotebookEdit', 'TodoWrite',
        ]
        const allAllowed = [...(agent.allowedTools || []), ...conductorTools]
        if (isMango) {
          // MangoCode takes comma-separated string
          args.push('--allowed-tools', allAllowed.join(','))
        } else {
          // Claude takes space-separated arguments
          args.push('--allowedTools', ...allAllowed)
        }

        // Disallow built-in tools that conflict with conductor equivalents
        const conductorDisallowed = [
          'RemoteTrigger',
          'CronCreate',
          'CronDelete',
          'CronList',
        ]
        const allDisallowed = [...(agent.disallowedTools || []), ...conductorDisallowed]
        if (isMango) {
          args.push('--disallowed-tools', allDisallowed.join(','))
        } else {
          args.push('--disallowedTools', ...allDisallowed)
        }
      }

      // System prompt to orient agents toward conductor tools
      args.push('--system-prompt', 'You are running inside Conducctor, a multi-agent orchestration platform. You have access to conductor MCP tools (mcp__conductor__*) for: scheduling tasks (schedule_task, list_scheduled_tasks, update_scheduled_task, run_scheduled_task, delete_scheduled_task), inter-agent communication (send_message, read_messages, list_agents), shared state (get_shared_state, set_shared_state), spawning sub-agents (spawn_agent), and requesting reviews (request_review). Always prefer these conductor tools over built-in alternatives like RemoteTrigger or CronCreate. Scheduled tasks run locally on this server with full filesystem access.')

      // MCP config for inter-agent communication (both providers)
      const mcpConfigJson = this._buildMCPConfigArg(agentId)
      if (mcpConfigJson && !isGemini) {
        args.push('--mcp-config', mcpConfigJson)
      }

      // Prompt / session
      if (isGemini) {
        if (sessionId) {
          args.push('--resume', sessionId, '-p', message)
        } else {
          args.push('-p', message)
        }
      } else if (sessionId) {
        args.push('--resume', sessionId, '-p', message)
      } else {
        args.push('--session-id', agentId, '-p', message)
      }

      const proc = agent.useContainer
        ? this.containerManager.spawn(agentId, args, { projectPath: agent.projectId, provider: agent.provider })
        : Promise.resolve(this._spawnLocal(args, cliBinary))

      Promise.resolve(proc).then((childProc) => {
        this.activeProcs.set(agentId, childProc)
        let buffer = ''

        childProc.stdout.on('data', (chunk) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop()
          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const event = JSON.parse(line)
              this._handleStreamEvent(agentId, event)
            } catch {
              this.emit('agent:raw', { agentId, data: line })
            }
          }
        })

        childProc.stderr.on('data', (chunk) => {
          const text = chunk.toString()
          // Filter out noisy startup/debug messages from Gemini and MangoCode
          if (text.includes('YOLO mode') || text.includes('STARTUP') || text.includes('cleanup_ops') || text.includes('Skipping metrics')) return
          if (text.includes('DEBUG') || text.includes('INFO') || text.includes('Connecting to MCP') || text.includes('MCP server connected') || text.includes('Plugins loaded') || text.includes('Cron scheduler') || text.includes('Dispatching to') || text.includes('starting new connection') || text.includes('connecting to') || text.includes('connected to')) return
          this.emit('agent:error', { agentId, error: text })
        })

        childProc.on('exit', (code) => {
          this.activeProcs.delete(agentId)
          agent.busy = false

          // MangoCode: detect session ID from most recent session file
          if (isMango && !agent.sessionId) {
            try {
              const sessDir = join(homedir(), '.mangocode', 'sessions')
              const files = readdirSync(sessDir)
                .filter(f => f.endsWith('.json'))
                .map(f => ({ name: f, mtime: statSync(join(sessDir, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime)
              if (files.length > 0) {
                agent.sessionId = files[0].name.replace('.json', '')
                this._writeProvenance(agentId, agent.sessionId)
              }
            } catch { /* ignore */ }
          }

          this.emit('agent:turn_complete', { agentId, code })
          resolve(code)
        })
      }).catch((err) => {
        agent.busy = false
        reject(err)
      })
    })
  }

  _buildHookSettings(agent) {
    // The hook relay script is mounted at /opt/conductor/hook-relay.sh in Docker
    // or available locally at the repo path
    const relayPath = agent.useContainer
      ? '/opt/conductor/hook-relay.sh'
      : join(__dirname, '..', 'hook-relay.sh')

    const hookCommand = relayPath
    const hookEvents = ['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'SessionStart', 'Stop']

    const hooks = {}
    for (const event of hookEvents) {
      hooks[event] = [{
        matcher: '',
        hooks: [hookCommand],
      }]
    }

    return JSON.stringify({ hooks })
  }

  _buildMCPConfigArg(agentId) {
    const agent = this.agents.get(agentId)
    if (!agent) return null

    const brokerPort = this.containerManager?.mcpBrokerPort || 3101
    const brokerUrl = agent.useContainer
      ? `http://host.docker.internal:${brokerPort}/mcp`
      : `http://localhost:${brokerPort}/mcp`

    // Inside Docker the bridge script is mounted at /opt/conductor/
    // Locally it's resolved relative to this module
    const bridgePath = agent.useContainer
      ? '/opt/conductor/mcp-stdio-bridge.js'
      : BRIDGE_SCRIPT

    return JSON.stringify({
      mcpServers: {
        conductor: {
          command: 'node',
          args: [bridgePath],
          env: {
            CONDUCTOR_MCP_URL: brokerUrl,
            CONDUCTOR_AGENT_ID: agentId,
          },
        },
      },
    })
  }

  _spawnLocal(args, binary = 'claude') {
    const env = { ...process.env }
    // Ensure gcloud is in PATH for MangoCode Vertex auth
    if (binary === 'mangocode' && !env.PATH?.includes('google-cloud-sdk')) {
      const home = env.HOME || '/home/ethan'
      env.PATH = `${home}/google-cloud-sdk/bin:${env.PATH}`
    }
    return spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })
  }

  _handleStreamEvent(agentId, event) {
    // Capture the real CLI session_id
    if (event.session_id) {
      const agent = this.agents.get(agentId)
      if (agent && !agent.sessionId) {
        agent.sessionId = event.session_id
        // Persist provenance now that we know which session this agent owns.
        this._writeProvenance(agentId, event.session_id)
      }
    }

    // Track token usage
    if (event.message?.usage) {
      const agent = this.agents.get(agentId)
      if (agent) {
        const u = event.message.usage
        agent.tokenUsage.input = u.input_tokens || agent.tokenUsage.input
        agent.tokenUsage.output = u.output_tokens || agent.tokenUsage.output
        this.contextMonitor?.onUsage(agentId, agent.tokenUsage)
      }
    }

    // Emit for bridge + WebSocket
    this.emit('agent:event', { agentId, event })
  }
}
