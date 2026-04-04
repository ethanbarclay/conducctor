/**
 * Conductor Scheduler
 *
 * Cron-based task scheduler. Reads scheduled_tasks from DB
 * and fires Claude Code agents on schedule.
 */

import { EventEmitter } from 'events'

export class Scheduler extends EventEmitter {
  constructor({ db, processManager }) {
    super()
    this.db = db
    this.processManager = processManager
    this.jobs = new Map() // taskId → intervalHandle
    this._initDb()
  }

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        prompt          TEXT NOT NULL,
        project_id      TEXT,
        agent_role      TEXT DEFAULT 'scheduled',
        use_container   INTEGER DEFAULT 0,
        enabled         INTEGER DEFAULT 1,
        last_run        INTEGER,
        next_run        INTEGER,
        created_at      INTEGER DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS task_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id     INTEGER REFERENCES scheduled_tasks(id),
        agent_id    TEXT,
        started_at  INTEGER DEFAULT (unixepoch()),
        ended_at    INTEGER,
        status      TEXT DEFAULT 'running'
      );
    `)
  }

  start() {
    // Load all enabled tasks and schedule them
    const tasks = this.db.prepare(
      'SELECT * FROM scheduled_tasks WHERE enabled = 1'
    ).all()
    for (const task of tasks) {
      this._schedule(task)
    }
    console.log(`[Scheduler] Started with ${tasks.length} task(s)`)
  }

  stop() {
    for (const handle of this.jobs.values()) {
      clearInterval(handle)
    }
    this.jobs.clear()
  }

  createTask(opts) {
    const result = this.db.prepare(`
      INSERT INTO scheduled_tasks (name, cron_expression, prompt, project_id, agent_role, use_container)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(opts.name, opts.cron, opts.prompt, opts.projectId, opts.role || 'scheduled', opts.useContainer ? 1 : 0)

    const task = this.db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(result.lastInsertRowid)
    this._schedule(task)
    return task
  }

  deleteTask(taskId) {
    this._unschedule(taskId)
    this.db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(taskId)
  }

  enableTask(taskId) {
    this.db.prepare('UPDATE scheduled_tasks SET enabled = 1 WHERE id = ?').run(taskId)
    const task = this.db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(taskId)
    this._schedule(task)
  }

  disableTask(taskId) {
    this._unschedule(taskId)
    this.db.prepare('UPDATE scheduled_tasks SET enabled = 0 WHERE id = ?').run(taskId)
  }

  listTasks() {
    return this.db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all()
  }

  getRunHistory(taskId, limit = 20) {
    return this.db.prepare(
      'SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?'
    ).all(taskId, limit)
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  _schedule(task) {
    // TODO: Replace with proper cron parser (e.g. node-cron)
    // For now uses a simple interval-based approximation
    const intervalMs = this._cronToMs(task.cron_expression)
    if (!intervalMs) {
      console.warn(`[Scheduler] Could not parse cron: ${task.cron_expression}`)
      return
    }

    const handle = setInterval(() => this._runTask(task.id), intervalMs)
    this.jobs.set(task.id, handle)
  }

  _unschedule(taskId) {
    const handle = this.jobs.get(taskId)
    if (handle) {
      clearInterval(handle)
      this.jobs.delete(taskId)
    }
  }

  async _runTask(taskId) {
    const task = this.db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(taskId)
    if (!task || !task.enabled) return

    this.emit('task:start', { taskId, task })

    const run = this.db.prepare(
      'INSERT INTO task_runs (task_id) VALUES (?)'
    ).run(taskId)
    const runId = run.lastInsertRowid

    try {
      const agentId = await this.processManager.spawn({
        prompt: task.prompt,
        projectId: task.project_id,
        role: task.agent_role,
        useContainer: !!task.use_container,
      })

      this.db.prepare(
        'UPDATE task_runs SET agent_id = ? WHERE id = ?'
      ).run(agentId, runId)

      this.db.prepare(
        'UPDATE scheduled_tasks SET last_run = unixepoch() WHERE id = ?'
      ).run(taskId)

      // Listen for exit to mark run complete
      this.processManager.once(`agent:exit`, ({ agentId: exitedId, code }) => {
        if (exitedId === agentId) {
          this.db.prepare(
            'UPDATE task_runs SET ended_at = unixepoch(), status = ? WHERE id = ?'
          ).run(code === 0 ? 'success' : 'failed', runId)
          this.emit('task:complete', { taskId, runId, agentId, code })
        }
      })
    } catch (err) {
      this.db.prepare(
        'UPDATE task_runs SET ended_at = unixepoch(), status = ? WHERE id = ?'
      ).run('error', runId)
      this.emit('task:error', { taskId, runId, error: err.message })
    }
  }

  // Minimal cron-to-ms: handles "*/N * * * *" (every N minutes) only for now
  // Replace with node-cron for full cron support
  _cronToMs(expr) {
    const match = expr.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/)
    if (match) return parseInt(match[1]) * 60 * 1000
    // Daily at specific hour: "0 N * * *"
    const daily = expr.match(/^0\s+(\d+)\s+\*\s+\*\s+\*$/)
    if (daily) return 24 * 60 * 60 * 1000
    return null
  }
}
