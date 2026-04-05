/**
 * Conductor API Routes
 *
 * REST endpoints for the multi-agent orchestration layer:
 *   - Agent lifecycle (spawn, list, kill, send input)
 *   - Context controls (compact, fork, checkpoint, restore, thresholds)
 *   - Scheduler (CRUD for scheduled tasks)
 *   - MCP broker status (messages, shared state)
 */

import { Router } from 'express';

const router = Router();

// Helper to get conductor modules from app.locals
function getConductor(req) {
    return req.app.locals.conductor;
}

// ─── Agent Lifecycle ─────────────────────────────────────────────────────────

/**
 * POST /api/conductor/agents
 * Spawn a new orchestrated CC agent
 * Body: { prompt, projectPath, sessionId?, useContainer?, role?, autoCompactThreshold? }
 */
router.post('/agents', async (req, res) => {
    try {
        const { processManager, mcpBroker, contextMonitor } = getConductor(req);
        const { prompt, projectPath, sessionId, useContainer, role, provider, mangoProvider, model, permissionMode, autoCompactThreshold } = req.body;

        if (!prompt && !sessionId) {
            return res.status(400).json({ error: 'prompt or sessionId is required' });
        }

        const { randomUUID } = await import('crypto');
        const agentId = req.body.agentId || randomUUID();

        // Spawn async — don't wait for the first turn to complete.
        // Return immediately so the UI can show the agent in the grid.
        processManager.spawn({
            prompt,
            projectId: projectPath,
            sessionId,
            agentId,
            useContainer: !!useContainer,
            role: role || 'agent',
            provider: provider || 'claude',
            mangoProvider: mangoProvider || undefined,
            model: model || undefined,
            permissionMode: permissionMode || undefined,
        }).catch(err => {
            console.error(`[Conductor] Agent ${agentId} spawn error:`, err.message);
        });

        if (autoCompactThreshold !== undefined) {
            contextMonitor.setThreshold(agentId, autoCompactThreshold);
        }

        res.json({ agentId, status: 'spawned' });
    } catch (err) {
        console.error('[Conductor] Spawn error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/conductor/agents
 * List all running orchestrated agents
 */
router.get('/agents', (req, res) => {
    const { processManager } = getConductor(req);
    res.json({ agents: processManager.list() });
});

/**
 * POST /api/conductor/agents/:agentId/input
 * Send a message to a running agent via stdin
 * Body: { message }
 */
router.post('/agents/:agentId/input', (req, res) => {
    try {
        const { processManager } = getConductor(req);
        processManager.sendInput(req.params.agentId, req.body.message);
        res.json({ status: 'sent' });
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
});

/**
 * POST /api/conductor/agents/:agentId/compact
 * Trigger compaction on a running agent
 */
router.post('/agents/:agentId/compact', (req, res) => {
    try {
        const { processManager } = getConductor(req);
        processManager.compact(req.params.agentId);
        res.json({ status: 'compacting' });
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
});

/**
 * DELETE /api/conductor/agents/:agentId
 * Kill an agent process
 */
router.delete('/agents/:agentId', (req, res) => {
    const { processManager } = getConductor(req);
    processManager.kill(req.params.agentId);
    res.json({ status: 'killed' });
});

// ─── Context Lifecycle ───────────────────────────────────────────────────────

/**
 * GET /api/conductor/agents/:agentId/context
 * Get context/token usage for an agent
 */
router.get('/agents/:agentId/context', (req, res) => {
    const { contextMonitor } = getConductor(req);
    const history = contextMonitor.getUsageHistory(req.params.agentId, 50);
    res.json({ history });
});

/**
 * PUT /api/conductor/agents/:agentId/context/threshold
 * Set auto-compact threshold for an agent
 * Body: { threshold } (0-1)
 */
router.put('/agents/:agentId/context/threshold', (req, res) => {
    const { contextMonitor } = getConductor(req);
    const { threshold } = req.body;
    if (typeof threshold !== 'number' || threshold < 0 || threshold > 1) {
        return res.status(400).json({ error: 'threshold must be a number between 0 and 1' });
    }
    contextMonitor.setThreshold(req.params.agentId, threshold);
    res.json({ status: 'updated', threshold });
});

/**
 * POST /api/conductor/agents/:agentId/checkpoint
 * Checkpoint (snapshot) an agent's session
 * Body: { label? }
 */
router.post('/agents/:agentId/checkpoint', (req, res) => {
    try {
        const { contextMonitor } = getConductor(req);
        const snapshotId = contextMonitor.checkpoint(req.params.agentId, req.body.label);
        res.json({ snapshotId, status: 'checkpointed' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * GET /api/conductor/agents/:agentId/checkpoints
 * List checkpoints for an agent
 */
router.get('/agents/:agentId/checkpoints', (req, res) => {
    const { contextMonitor } = getConductor(req);
    const checkpoints = contextMonitor.listCheckpoints(req.params.agentId);
    res.json({ checkpoints });
});

/**
 * POST /api/conductor/agents/:agentId/fork
 * Fork an agent session into a new agent
 * Body: { role? }
 */
router.post('/agents/:agentId/fork', async (req, res) => {
    try {
        const { contextMonitor } = getConductor(req);
        const newAgentId = await contextMonitor.fork(req.params.agentId, req.body);
        res.json({ newAgentId, status: 'forked' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * POST /api/conductor/checkpoints/:checkpointId/restore
 * Restore a checkpoint as a new agent
 * Body: { projectId?, role? }
 */
router.post('/checkpoints/:checkpointId/restore', async (req, res) => {
    try {
        const { contextMonitor } = getConductor(req);
        const newAgentId = await contextMonitor.restore(
            parseInt(req.params.checkpointId, 10),
            req.body
        );
        res.json({ newAgentId, status: 'restored' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ─── Scheduler ───────────────────────────────────────────────────────────────

/**
 * GET /api/conductor/tasks
 * List all scheduled tasks
 */
router.get('/tasks', (req, res) => {
    const { scheduler } = getConductor(req);
    res.json({ tasks: scheduler.listTasks() });
});

/**
 * POST /api/conductor/tasks
 * Create a new scheduled task
 * Body: { name, cron, prompt, projectId?, role?, useContainer? }
 */
router.post('/tasks', (req, res) => {
    try {
        const { scheduler } = getConductor(req);
        const task = scheduler.createTask(req.body);
        res.json({ task, status: 'created' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * POST /api/conductor/tasks/:taskId/run
 * Manually trigger a scheduled task
 */
router.post('/tasks/:taskId/run', async (req, res) => {
    try {
        const { scheduler } = getConductor(req);
        const result = await scheduler.runTaskNow(parseInt(req.params.taskId, 10));
        res.json({ ...result, status: 'running' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * DELETE /api/conductor/tasks/:taskId
 * Delete a scheduled task
 */
router.delete('/tasks/:taskId', (req, res) => {
    const { scheduler } = getConductor(req);
    scheduler.deleteTask(parseInt(req.params.taskId, 10));
    res.json({ status: 'deleted' });
});

/**
 * POST /api/conductor/tasks/:taskId/enable
 */
router.post('/tasks/:taskId/enable', (req, res) => {
    const { scheduler } = getConductor(req);
    scheduler.enableTask(parseInt(req.params.taskId, 10));
    res.json({ status: 'enabled' });
});

/**
 * POST /api/conductor/tasks/:taskId/disable
 */
router.post('/tasks/:taskId/disable', (req, res) => {
    const { scheduler } = getConductor(req);
    scheduler.disableTask(parseInt(req.params.taskId, 10));
    res.json({ status: 'disabled' });
});

/**
 * GET /api/conductor/tasks/:taskId/runs
 * Get run history for a scheduled task
 */
router.get('/tasks/:taskId/runs', (req, res) => {
    const { scheduler } = getConductor(req);
    const runs = scheduler.getRunHistory(
        parseInt(req.params.taskId, 10),
        parseInt(req.query.limit || '20', 10)
    );
    res.json({ runs });
});

// ─── MCP Broker Status ──────────────────────────────────────────────────────

/**
 * GET /api/conductor/messages
 * Get recent inter-agent messages
 */
router.get('/messages', (req, res) => {
    const { mcpBroker } = getConductor(req);
    const limit = parseInt(req.query.limit || '50', 10);
    const messages = mcpBroker.db.prepare(
        'SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
    res.json({ messages });
});

/**
 * GET /api/conductor/shared-state
 * Get all shared state entries
 */
router.get('/shared-state', (req, res) => {
    const { mcpBroker } = getConductor(req);
    const state = mcpBroker.db.prepare(
        'SELECT * FROM shared_state ORDER BY updated_at DESC'
    ).all();
    res.json({ state });
});

/**
 * GET /api/conductor/containers
 * List running Docker containers
 */
router.get('/containers', async (req, res) => {
    try {
        const { containerManager } = getConductor(req);
        const containers = await containerManager.list();
        res.json({ containers });
    } catch (err) {
        res.json({ containers: [], error: err.message });
    }
});

export default router;
