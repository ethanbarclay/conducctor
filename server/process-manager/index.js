/**
 * Conductor Process Manager
 *
 * Spawns and manages Claude Code subprocess instances.
 * Each agent session is an isolated CC process communicating
 * via --output-format stream-json / --input-format stream-json.
 */

import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'

export class ProcessManager extends EventEmitter {
  constructor({ db, contextMonitor, containerManager }) {
    super()
    this.db = db
    this.contextMonitor = contextMonitor
    this.containerManager = containerManager
    this.processes = new Map() // agentId → { process, sessionId, projectId, metadata }
  }

  /**
   * Spawn a new Claude Code agent process
   * @param {object} opts
   * @param {string} opts.prompt         - Initial prompt
   * @param {string} opts.projectId      - Project this agent belongs to
   * @param {string} opts.sessionId      - Resume existing session (optional)
   * @param {string} opts.agentId        - Override agent ID (optional)
   * @param {boolean} opts.useContainer  - Run in Docker container
   * @param {object} opts.mcpConfig      - MCP config to inject (includes broker)
   * @param {string} opts.role           - Agent role label (e.g. "frontend", "qa")
   */
  async spawn(opts) {
    const agentId = opts.agentId || randomUUID()
    const args = this._buildArgs(opts)

    const process = opts.useContainer
      ? await this.containerManager.spawn(agentId, args, opts)
      : this._spawnLocal(args)

    this.processes.set(agentId, {
      process,
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      role: opts.role || 'agent',
      startedAt: Date.now(),
      tokenUsage: { input: 0, output: 0 },
    })

    this._attachHandlers(agentId, process)
    this.emit('agent:spawned', { agentId, ...opts })
    return agentId
  }

  /**
   * Send a message/command to a running agent via stdin
   */
  sendInput(agentId, message) {
    const entry = this.processes.get(agentId)
    if (!entry) throw new Error(`Agent ${agentId} not found`)
    const payload = JSON.stringify({ type: 'user', message }) + '\n'
    entry.process.stdin.write(payload)
  }

  /**
   * Trigger compaction on a running agent
   */
  compact(agentId) {
    return this.sendInput(agentId, '/compact')
  }

  /**
   * Kill an agent process
   */
  kill(agentId, signal = 'SIGTERM') {
    const entry = this.processes.get(agentId)
    if (entry) {
      entry.process.kill(signal)
      this.processes.delete(agentId)
      this.emit('agent:killed', { agentId })
    }
  }

  /**
   * List all running agents
   */
  list() {
    return Array.from(this.processes.entries()).map(([agentId, entry]) => ({
      agentId,
      role: entry.role,
      projectId: entry.projectId,
      sessionId: entry.sessionId,
      startedAt: entry.startedAt,
      tokenUsage: entry.tokenUsage,
    }))
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  _buildArgs(opts) {
    const args = ['--output-format', 'stream-json', '--input-format', 'stream-json']
    if (opts.sessionId) args.push('--resume', opts.sessionId)
    if (opts.mcpConfig) args.push('--mcp-config', JSON.stringify(opts.mcpConfig))
    if (opts.prompt && !opts.sessionId) args.push('-p', opts.prompt)
    return args
  }

  _spawnLocal(args) {
    return spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })
  }

  _attachHandlers(agentId, proc) {
    let buffer = ''

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() // keep incomplete line
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          this._handleStreamEvent(agentId, event)
        } catch {
          // non-JSON output, emit as raw
          this.emit('agent:raw', { agentId, data: line })
        }
      }
    })

    proc.stderr.on('data', (chunk) => {
      this.emit('agent:error', { agentId, error: chunk.toString() })
    })

    proc.on('exit', (code) => {
      this.processes.delete(agentId)
      this.emit('agent:exit', { agentId, code })
    })
  }

  _handleStreamEvent(agentId, event) {
    // Track token usage for context monitor
    if (event.usage) {
      const entry = this.processes.get(agentId)
      if (entry) {
        entry.tokenUsage.input += event.usage.input_tokens || 0
        entry.tokenUsage.output += event.usage.output_tokens || 0
        this.contextMonitor?.onUsage(agentId, entry.tokenUsage)
      }
    }

    // Emit typed events for the WebSocket layer + observability
    this.emit('agent:event', { agentId, event })

    // Specific event type emissions
    if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
      this.emit('agent:thinking', { agentId, thinking: event.content_block.thinking })
    }
    if (event.type === 'content_block_delta' && event.delta?.type === 'tool_use') {
      this.emit('agent:tool_use', { agentId, tool: event.delta })
    }
  }
}
