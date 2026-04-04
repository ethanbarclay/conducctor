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
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

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
      model: opts.model || null,
      useContainer: !!opts.useContainer,
      permissionMode: opts.permissionMode || null,
      skipPermissions: !!opts.skipPermissions,
      allowedTools: opts.allowedTools || [],
      disallowedTools: opts.disallowedTools || [],
      startedAt: Date.now(),
      tokenUsage: { input: 0, output: 0 },
      busy: false,
    })

    this.emit('agent:spawned', { agentId, ...opts })

    // If there's a prompt, run it now
    if (opts.prompt) {
      await this._runTurn(agentId, opts.prompt, opts.sessionId)
    }

    return agentId
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

      const args = ['--output-format', 'stream-json', '--verbose']

      // Model
      if (agent.model) {
        args.push('--model', agent.model)
      }

      // Permission mode
      if (agent.permissionMode) {
        args.push('--permission-mode', agent.permissionMode)
      }
      if (agent.skipPermissions) {
        args.push('--dangerously-skip-permissions')
      }

      // MCP config for inter-agent communication
      const mcpConfigJson = this._buildMCPConfigArg(agentId)
      if (mcpConfigJson) {
        args.push('--mcp-config', mcpConfigJson)
      }

      // Allowed/disallowed tools — always include conductor MCP tools
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
        'mcp__conductor__delete_scheduled_task',
      ]
      const allAllowed = [...(agent.allowedTools || []), ...conductorTools]
      args.push('--allowedTools', ...allAllowed)

      if (agent.disallowedTools?.length) {
        args.push('--disallowedTools', ...agent.disallowedTools)
      }

      if (sessionId) {
        args.push('--resume', sessionId, '-p', message)
      } else {
        // Force a fresh session — don't auto-continue previous conversations
        args.push('--session-id', agentId, '-p', message)
      }

      const proc = agent.useContainer
        ? this.containerManager.spawn(agentId, args, { projectPath: agent.projectId })
        : Promise.resolve(this._spawnLocal(args))

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
          this.emit('agent:error', { agentId, error: chunk.toString() })
        })

        childProc.on('exit', (code) => {
          this.activeProcs.delete(agentId)
          agent.busy = false
          this.emit('agent:turn_complete', { agentId, code })
          resolve(code)
        })
      }).catch((err) => {
        agent.busy = false
        reject(err)
      })
    })
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

  _spawnLocal(args) {
    return spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })
  }

  _handleStreamEvent(agentId, event) {
    // Capture the real CLI session_id
    if (event.session_id) {
      const agent = this.agents.get(agentId)
      if (agent && !agent.sessionId) {
        agent.sessionId = event.session_id
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
