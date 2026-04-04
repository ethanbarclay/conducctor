/**
 * Conductor Context Monitor
 *
 * Tracks token usage per agent session. Triggers warnings and
 * automatic compaction when context thresholds are reached.
 * Supports manual compact, fork, checkpoint, and summary handoff.
 */

import { EventEmitter } from 'events'
import { cpSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'

// Claude's context window (tokens). Adjust if using different models.
const CONTEXT_LIMIT = 200_000

export class ContextMonitor extends EventEmitter {
  constructor({ db, processManager, defaultAutoCompactThreshold = 0.75 }) {
    super()
    this.db = db
    this.processManager = processManager
    this.defaultThreshold = defaultAutoCompactThreshold
    this.agentThresholds = new Map() // agentId → threshold (0-1)
    this._initDb()
  }

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS context_snapshots (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id    TEXT NOT NULL,
        session_id  TEXT,
        input_tokens  INTEGER,
        output_tokens INTEGER,
        pct_used    REAL,
        event       TEXT,
        created_at  INTEGER DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS session_checkpoints (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id    TEXT,
        session_id  TEXT NOT NULL,
        label       TEXT,
        snapshot_path TEXT,
        summary     TEXT,
        created_at  INTEGER DEFAULT (unixepoch())
      );
    `)
  }

  /**
   * Called by ProcessManager on every usage event
   */
  onUsage(agentId, tokenUsage) {
    const total = tokenUsage.input + tokenUsage.output
    const pct = total / CONTEXT_LIMIT
    const threshold = this.agentThresholds.get(agentId) ?? this.defaultThreshold

    // Persist snapshot
    const entry = this.processManager.processes?.get(agentId)
    this.db.prepare(`
      INSERT INTO context_snapshots (agent_id, session_id, input_tokens, output_tokens, pct_used, event)
      VALUES (?, ?, ?, ?, ?, 'usage')
    `).run(agentId, entry?.sessionId ?? null, tokenUsage.input, tokenUsage.output, pct)

    // Emit for UI
    this.emit('usage', { agentId, tokenUsage, pct, limit: CONTEXT_LIMIT })

    // Warn at 60%
    if (pct >= 0.6) {
      this.emit('warning', { agentId, pct, threshold })
    }

    // Auto-compact at threshold
    if (pct >= threshold) {
      this.emit('auto-compact', { agentId, pct })
      this.processManager.compact(agentId)
    }
  }

  /**
   * Set per-agent auto-compact threshold (0-1)
   */
  setThreshold(agentId, threshold) {
    this.agentThresholds.set(agentId, threshold)
  }

  /**
   * Checkpoint: snapshot the CC session directory
   */
  checkpoint(agentId, label = null) {
    const entry = this.processManager.processes?.get(agentId)
    if (!entry?.sessionId) throw new Error('No session ID for agent')

    const src = this._sessionPath(entry.sessionId)
    const snapshotId = randomUUID()
    const dest = join(homedir(), '.conductor', 'checkpoints', snapshotId)

    mkdirSync(dest, { recursive: true })
    cpSync(src, dest, { recursive: true })

    this.db.prepare(`
      INSERT INTO session_checkpoints (agent_id, session_id, label, snapshot_path)
      VALUES (?, ?, ?, ?)
    `).run(agentId, entry.sessionId, label, dest)

    this.emit('checkpoint', { agentId, snapshotId, label, dest })
    return snapshotId
  }

  /**
   * Fork: copy session and spawn a new agent from the same point
   */
  async fork(agentId, opts = {}) {
    const entry = this.processManager.processes?.get(agentId)
    if (!entry?.sessionId) throw new Error('No session ID to fork from')

    const newSessionId = randomUUID()
    const src = this._sessionPath(entry.sessionId)
    const dest = this._sessionPath(newSessionId)

    mkdirSync(dest, { recursive: true })
    cpSync(src, dest, { recursive: true })

    const newAgentId = await this.processManager.spawn({
      ...opts,
      projectId: entry.projectId,
      sessionId: newSessionId,
      role: opts.role || `${entry.role}-fork`,
    })

    this.emit('fork', { fromAgentId: agentId, newAgentId, newSessionId })
    return newAgentId
  }

  /**
   * Restore a checkpoint and spawn a new agent from it
   */
  async restore(checkpointId, opts = {}) {
    const checkpoint = this.db.prepare(
      'SELECT * FROM session_checkpoints WHERE id = ?'
    ).get(checkpointId)
    if (!checkpoint) throw new Error(`Checkpoint ${checkpointId} not found`)

    const newSessionId = randomUUID()
    const dest = this._sessionPath(newSessionId)

    mkdirSync(dest, { recursive: true })
    cpSync(checkpoint.snapshot_path, dest, { recursive: true })

    const newAgentId = await this.processManager.spawn({
      ...opts,
      sessionId: newSessionId,
    })

    this.emit('restore', { checkpointId, newAgentId, newSessionId })
    return newAgentId
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  _sessionPath(sessionId) {
    return join(homedir(), '.claude', 'projects', sessionId)
  }

  getUsageHistory(agentId, limit = 100) {
    return this.db.prepare(
      'SELECT * FROM context_snapshots WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(agentId, limit)
  }

  listCheckpoints(agentId) {
    return this.db.prepare(
      'SELECT * FROM session_checkpoints WHERE agent_id = ? ORDER BY created_at DESC'
    ).all(agentId)
  }
}
