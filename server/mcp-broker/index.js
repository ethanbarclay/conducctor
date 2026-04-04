/**
 * Conductor MCP Broker
 *
 * Exposes a local MCP server that all spawned CC agents connect to.
 * Provides inter-agent messaging, shared state, agent discovery,
 * and the ability to spawn new agents.
 *
 * Tools exposed to agents:
 *   - send_message(to, content)
 *   - read_messages()
 *   - list_agents()
 *   - get_shared_state(key)
 *   - set_shared_state(key, value)
 *   - request_review(from, context)
 *   - spawn_agent(prompt, role, projectPath)
 */

import { EventEmitter } from 'events'
import { createServer } from 'http'
import { randomUUID } from 'crypto'

const MCP_TOOLS = [
  {
    name: 'send_message',
    description: 'Send a message to another agent by name or ID',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target agent ID or role name' },
        content: { type: 'string', description: 'Message content' },
      },
      required: ['to', 'content'],
    },
  },
  {
    name: 'read_messages',
    description: 'Read pending messages in your inbox',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_agents',
    description: 'List all currently running agents',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_shared_state',
    description: 'Read a value from the shared agent blackboard',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'set_shared_state',
    description: 'Write a value to the shared agent blackboard',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { type: 'string', description: 'JSON-serializable value' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'request_review',
    description: 'Ask another agent to review your work',
    inputSchema: {
      type: 'object',
      properties: {
        reviewer: { type: 'string', description: 'Agent ID or role to review' },
        context: { type: 'string', description: 'What to review and why' },
      },
      required: ['reviewer', 'context'],
    },
  },
  {
    name: 'spawn_agent',
    description: 'Spawn a new Claude Code agent to work on a subtask. Returns immediately with the new agent ID.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Task prompt for the new agent' },
        role: { type: 'string', description: 'Role name (e.g. "researcher", "qa", "frontend")' },
        project_path: { type: 'string', description: 'Project directory (defaults to same as caller)' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'schedule_task',
    description: 'Create a recurring scheduled task that spawns an agent on a cron schedule. Common patterns: "*/5 * * * *" (every 5 min), "0 * * * *" (hourly), "0 9 * * *" (daily at 9am), "0 9 * * 1" (weekly Monday 9am).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-readable task name' },
        cron: { type: 'string', description: 'Cron expression (e.g. "*/5 * * * *" for every 5 minutes)' },
        prompt: { type: 'string', description: 'Prompt the scheduled agent will execute each run' },
        role: { type: 'string', description: 'Agent role (default: "scheduled")' },
        project_path: { type: 'string', description: 'Project directory for the agent' },
      },
      required: ['name', 'cron', 'prompt'],
    },
  },
  {
    name: 'list_scheduled_tasks',
    description: 'List all scheduled tasks with their cron expressions, status, and last run time',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_scheduled_task',
    description: 'Delete a scheduled task by ID',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'ID of the task to delete' },
      },
      required: ['task_id'],
    },
  },
]

export class MCPBroker extends EventEmitter {
  constructor({ db, processManager, scheduler, port = 3101 }) {
    super()
    this.db = db
    this.processManager = processManager
    this.scheduler = scheduler
    this.port = port
    this._initDb()
  }

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent  TEXT NOT NULL,
        to_agent    TEXT NOT NULL,
        content     TEXT NOT NULL,
        read        INTEGER DEFAULT 0,
        created_at  INTEGER DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS shared_state (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_by  TEXT,
        updated_at  INTEGER DEFAULT (unixepoch())
      );
    `)
  }

  /**
   * Get MCP config object to inject into a CC agent process
   */
  getMCPConfig(agentId) {
    return {
      mcpServers: {
        conductor: {
          url: `http://localhost:${this.port}/mcp`,
          headers: { 'x-agent-id': agentId },
        },
      },
    }
  }

  start() {
    this.server = createServer((req, res) => {
      const agentId = req.headers['x-agent-id'] || 'unknown'

      if (req.method === 'POST' && req.url === '/mcp') {
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          try {
            const msg = JSON.parse(body)
            const result = this._handleMCPRequest(agentId, msg)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (e) {
            res.writeHead(400)
            res.end(JSON.stringify({ error: e.message }))
          }
        })
      } else if (req.method === 'GET' && req.url === '/mcp/tools') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ tools: MCP_TOOLS }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })

    this.server.listen(this.port, () => {
      console.log(`[MCP Broker] Listening on port ${this.port}`)
    })
  }

  stop() {
    this.server?.close()
  }

  // ─── Tool Handlers ───────────────────────────────────────────────────────────

  _handleMCPRequest(fromAgentId, msg) {
    const { method, params } = msg

    if (method === 'tools/list') {
      return { tools: MCP_TOOLS }
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params
      return this._callTool(fromAgentId, name, args)
    }

    return { error: `Unknown method: ${method}` }
  }

  _callTool(fromAgentId, name, args) {
    switch (name) {
      case 'send_message': {
        this.db.prepare(
          'INSERT INTO agent_messages (from_agent, to_agent, content) VALUES (?, ?, ?)'
        ).run(fromAgentId, args.to, args.content)
        this.emit('message:sent', { from: fromAgentId, to: args.to, content: args.content })
        return { content: [{ type: 'text', text: `Message sent to ${args.to}` }] }
      }

      case 'read_messages': {
        const messages = this.db.prepare(
          'SELECT * FROM agent_messages WHERE to_agent = ? AND read = 0 ORDER BY created_at ASC'
        ).all(fromAgentId)
        this.db.prepare(
          'UPDATE agent_messages SET read = 1 WHERE to_agent = ? AND read = 0'
        ).run(fromAgentId)
        return {
          content: [{
            type: 'text',
            text: messages.length === 0
              ? 'No new messages.'
              : messages.map(m => `[${m.from_agent}]: ${m.content}`).join('\n'),
          }],
        }
      }

      case 'list_agents': {
        const agents = this.processManager.list()
        return {
          content: [{
            type: 'text',
            text: agents.length === 0
              ? 'No other agents running.'
              : agents.map(a => `${a.agentId} (${a.role}) — project: ${a.projectId}`).join('\n'),
          }],
        }
      }

      case 'get_shared_state': {
        const row = this.db.prepare('SELECT value FROM shared_state WHERE key = ?').get(args.key)
        return {
          content: [{ type: 'text', text: row ? row.value : 'null' }],
        }
      }

      case 'set_shared_state': {
        this.db.prepare(`
          INSERT INTO shared_state (key, value, updated_by) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = unixepoch()
        `).run(args.key, args.value, fromAgentId)
        this.emit('state:updated', { key: args.key, value: args.value, by: fromAgentId })
        return { content: [{ type: 'text', text: `State updated: ${args.key}` }] }
      }

      case 'request_review': {
        // Send a structured message to the reviewer
        const content = `[REVIEW REQUEST] ${args.context}`
        this.db.prepare(
          'INSERT INTO agent_messages (from_agent, to_agent, content) VALUES (?, ?, ?)'
        ).run(fromAgentId, args.reviewer, content)
        this.emit('review:requested', { from: fromAgentId, reviewer: args.reviewer, context: args.context })
        return { content: [{ type: 'text', text: `Review requested from ${args.reviewer}` }] }
      }

      case 'spawn_agent': {
        const callerAgent = this.processManager.agents?.get(fromAgentId)
        const newAgentId = randomUUID()
        const role = args.role || 'sub-agent'

        // Augment the sub-agent prompt with coordination instructions
        const augmentedPrompt = [
          args.prompt,
          '',
          '---',
          'IMPORTANT: You are a sub-agent spawned by another agent.',
          `Your spawner's agent ID is: ${fromAgentId}`,
          'When you have completed your task, you MUST use the send_message tool to report your findings back:',
          `  send_message(to: "${fromAgentId}", content: "<your full results here>")`,
          'Do NOT skip this step. Your spawner is waiting for your results.',
          'Complete your task thoroughly, then send the results back.',
        ].join('\n')

        // Spawn asynchronously — don't block the caller
        this.processManager.spawn({
          agentId: newAgentId,
          prompt: augmentedPrompt,
          projectId: args.project_path || callerAgent?.projectId,
          role,
          useContainer: callerAgent?.useContainer ?? false,
          permissionMode: callerAgent?.permissionMode || 'bypassPermissions',
          model: callerAgent?.model || null,
        }).then(() => {
          // Sub-agent turn completed — notify the spawner
          console.log(`[MCP Broker] Sub-agent ${newAgentId} (${role}) completed, notifying spawner ${fromAgentId}`)

          // Insert a system message to the spawner
          this.db.prepare(
            'INSERT INTO agent_messages (from_agent, to_agent, content) VALUES (?, ?, ?)'
          ).run(newAgentId, fromAgentId, `[COMPLETED] Sub-agent "${role}" (${newAgentId.slice(0, 8)}) has finished its task. Use read_messages() to see the results.`)

          this.emit('message:sent', {
            from: newAgentId,
            to: fromAgentId,
            content: `Sub-agent "${role}" completed`,
          })

          // Auto-trigger a follow-up turn on the spawner to read results
          const spawner = this.processManager.agents?.get(fromAgentId)
          if (spawner && spawner.sessionId && !spawner.busy) {
            console.log(`[MCP Broker] Auto-triggering spawner ${fromAgentId} to read results`)
            this.processManager.sendInput(
              fromAgentId,
              `Your sub-agent "${role}" has completed its task. Use read_messages() to retrieve the results and continue your work.`
            ).catch(err => {
              console.error(`[MCP Broker] Failed to auto-trigger spawner:`, err.message)
            })
          }
        }).catch(err => {
          console.error(`[MCP Broker] spawn_agent failed:`, err.message)
          // Notify spawner of failure
          this.db.prepare(
            'INSERT INTO agent_messages (from_agent, to_agent, content) VALUES (?, ?, ?)'
          ).run('system', fromAgentId, `[ERROR] Sub-agent "${role}" failed: ${err.message}`)
        })

        this.emit('agent:spawned-by-agent', {
          spawner: fromAgentId,
          newAgentId,
          role,
          prompt: args.prompt,
        })

        return {
          content: [{
            type: 'text',
            text: `Agent ${newAgentId.slice(0, 8)} spawned with role "${role}". It will automatically report results back to you when done. Use read_messages() to check for replies.`,
          }],
        }
      }

      case 'schedule_task': {
        const task = this.scheduler.createTask({
          name: args.name,
          cron: args.cron,
          prompt: args.prompt,
          role: args.role || 'scheduled',
          projectId: args.project_path || null,
          useContainer: true,
        })
        this.emit('task:created', { by: fromAgentId, task })
        return {
          content: [{
            type: 'text',
            text: `Scheduled task "${task.name}" created (ID: ${task.id}). Cron: ${task.cron_expression}. It will spawn an agent each time it fires.`,
          }],
        }
      }

      case 'list_scheduled_tasks': {
        const tasks = this.scheduler.listTasks()
        if (tasks.length === 0) {
          return { content: [{ type: 'text', text: 'No scheduled tasks.' }] }
        }
        const lines = tasks.map(t =>
          `[${t.id}] "${t.name}" — ${t.cron_expression} — ${t.enabled ? 'enabled' : 'disabled'} — last: ${t.last_run ? new Date(t.last_run * 1000).toISOString() : 'never'}`
        )
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      case 'delete_scheduled_task': {
        this.scheduler.deleteTask(args.task_id)
        return { content: [{ type: 'text', text: `Scheduled task ${args.task_id} deleted.` }] }
      }

      default:
        return { error: `Unknown tool: ${name}` }
    }
  }
}
