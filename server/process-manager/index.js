/**
 * Conductor Process Manager
 *
 * Spawns and manages Claude Code subprocess instances.
 * Uses interactive mode (--input-format stream-json) so processes stay
 * alive across multiple messages. The initial prompt is sent via stdin.
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
   * Spawn a new Claude Code agent process.
   * Always uses interactive mode so the process stays alive for follow-up messages.
   * The initial prompt is sent via stdin after the process starts.
   */
  async spawn(opts) {
    const agentId = opts.agentId || randomUUID()
    const args = this._buildArgs(opts)

    const proc = opts.useContainer
      ? await this.containerManager.spawn(agentId, args, opts)
      : this._spawnLocal(args)

    this.processes.set(agentId, {
      process: proc,
      sessionId: opts.sessionId || null, // updated when CLI reports real session_id
      projectId: opts.projectId,
      role: opts.role || 'agent',
      startedAt: Date.now(),
      tokenUsage: { input: 0, output: 0 },
    })

    this._attachHandlers(agentId, proc)
    this.emit('agent:spawned', { agentId, ...opts })

    // Send initial prompt via stdin (interactive mode)
    if (opts.prompt && !opts.sessionId) {
      this._writeStdin(proc, opts.prompt)
    }

    return agentId
  }

  /**
   * Send a user message to a running agent via stdin
   */
  sendInput(agentId, message) {
    const entry = this.processes.get(agentId)
    if (!entry) throw new Error(`Agent ${agentId} not found`)
    this._writeStdin(entry.process, message)
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

  /**
   * Update the stored session ID for an agent (called when CLI reports real session_id)
   */
  setSessionId(agentId, sessionId) {
    const entry = this.processes.get(agentId)
    if (entry) {
      entry.sessionId = sessionId
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  _buildArgs(opts) {
    // Always use interactive mode with stream-json I/O
    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
    ]
    if (opts.sessionId) {
      args.push('--resume', opts.sessionId)
    }
    return args
  }

  _writeStdin(proc, message) {
    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message },
    }) + '\n'
    proc.stdin.write(payload)
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
    // Capture the real CLI session_id
    if (event.session_id) {
      const entry = this.processes.get(agentId)
      if (entry && !entry.sessionId) {
        entry.sessionId = event.session_id
      }
    }

    // Track token usage for context monitor
    if (event.message?.usage) {
      const entry = this.processes.get(agentId)
      if (entry) {
        const u = event.message.usage
        entry.tokenUsage.input = u.input_tokens || entry.tokenUsage.input
        entry.tokenUsage.output = u.output_tokens || entry.tokenUsage.output
        this.contextMonitor?.onUsage(agentId, entry.tokenUsage)
      }
    }

    // Emit typed events for the WebSocket layer + observability
    this.emit('agent:event', { agentId, event })
  }
}
