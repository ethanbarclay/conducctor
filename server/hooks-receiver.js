/**
 * Conductor Hooks Receiver
 *
 * HTTP endpoint that receives Claude Code hook events from both
 * SDK callbacks and containerized hook relay scripts.
 * Stores events in SQLite and broadcasts via WebSocket.
 */

import { Router } from 'express'

const router = Router()

export function createHooksReceiver({ db, broadcastFn }) {
  // Create hooks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS hook_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    TEXT,
      session_id  TEXT,
      hook_event  TEXT NOT NULL,
      tool_name   TEXT,
      tool_input  TEXT,
      tool_output TEXT,
      metadata    TEXT,
      created_at  INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_hook_events_agent ON hook_events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_hook_events_session ON hook_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_hook_events_time ON hook_events(created_at);
  `)

  const insertStmt = db.prepare(`
    INSERT INTO hook_events (agent_id, session_id, hook_event, tool_name, tool_input, tool_output, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  /**
   * POST /api/conductor/hooks
   * Receives hook events from SDK callbacks or container relay scripts.
   */
  router.post('/', (req, res) => {
    try {
      const {
        agent_id,
        session_id,
        hook_event_name,
        tool_name,
        tool_input,
        tool_response,
        message,
        source,
        // Catch-all for extra fields
        ...extra
      } = req.body

      // MangoCode uses 'event' and 'tool_output'; Claude uses 'hook_event_name' and 'tool_response'
      const eventName = hook_event_name || req.body.hookEventName || req.body.event || 'unknown'
      const toolOutput = tool_response || req.body.tool_output

      // Prefer x-agent-id header (set by CONDUCTOR_AGENT_ID env var in hook-relay.sh)
      // over body fields, since MangoCode sends session_id but not agent_id in the body.
      const resolvedAgentId = req.headers['x-agent-id'] || agent_id || null;

      insertStmt.run(
        resolvedAgentId,
        session_id || null,
        eventName,
        tool_name || null,
        tool_input ? JSON.stringify(tool_input) : null,
        toolOutput ? JSON.stringify(toolOutput).slice(0, 10000) : null,
        JSON.stringify({ message, source, ...extra }),
      )

      // Broadcast to WebSocket clients
      if (broadcastFn) {
        broadcastFn('hook:event', {
          agentId: resolvedAgentId,
          sessionId: session_id,
          hookEvent: eventName,
          toolName: tool_name,
          toolInput: tool_input,
          toolOutput: toolOutput ? String(toolOutput).slice(0, 500) : null,
          message,
          source,
          timestamp: Date.now(),
        })
      }

      res.json({ ok: true })
    } catch (err) {
      console.error('[Hooks] Error processing hook event:', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  /**
   * GET /api/conductor/hooks
   * Query recent hook events.
   */
  router.get('/', (req, res) => {
    const limit = parseInt(req.query.limit || '100', 10)
    const agentId = req.query.agent_id
    const hookEvent = req.query.hook_event

    let query = 'SELECT * FROM hook_events'
    const conditions = []
    const params = []

    if (agentId) {
      conditions.push('agent_id = ?')
      params.push(agentId)
    }
    if (hookEvent) {
      conditions.push('hook_event = ?')
      params.push(hookEvent)
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ')
    }
    query += ' ORDER BY created_at DESC LIMIT ?'
    params.push(limit)

    const events = db.prepare(query).all(...params)
    res.json({ events })
  })

  return router
}
