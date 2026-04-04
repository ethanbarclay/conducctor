/**
 * Conductor Bridge
 *
 * Bridges the conductor ProcessManager (which spawns real `claude` CLI
 * subprocesses, optionally in Docker) into the existing WebSocketWriter
 * flow that the UI expects.
 *
 * Translates stream-json events from the CLI into NormalizedMessage format,
 * matching the interface used by queryClaudeSDK().
 */

import { createNormalizedMessage } from './providers/types.js';
import { claudeAdapter } from './providers/claude/adapter.js';

const PROVIDER = 'claude';

/**
 * Spawn a Claude Code session via the conductor ProcessManager and stream
 * normalized events to the given writer (WebSocketWriter or SSEStreamWriter).
 *
 * This is the containerized alternative to queryClaudeSDK().
 *
 * @param {string} command - User prompt
 * @param {object} options - Session options (projectPath, sessionId, model, useContainer, role, etc.)
 * @param {object} writer - WebSocketWriter instance
 * @param {object} conductor - { processManager, mcpBroker, contextMonitor }
 */
export async function queryClaudeContainerized(command, options = {}, writer, conductor) {
  const { processManager, mcpBroker } = conductor;
  const {
    projectPath,
    cwd,
    sessionId,
    useContainer = true,
    role = 'agent',
  } = options;

  const workingDir = projectPath || cwd;

  // Warn if running without container
  if (!useContainer) {
    writer.send(createNormalizedMessage({
      kind: 'status',
      text: 'WARNING: Running without Docker container isolation. Agent has full host access.',
      sessionId: sessionId || '',
      provider: PROVIDER,
    }));
  }

  // Get MCP config for inter-agent communication
  const mcpConfig = mcpBroker.getMCPConfig('pending');

  let agentId;
  try {
    agentId = await processManager.spawn({
      prompt: command || undefined,
      projectId: workingDir,
      sessionId: sessionId || undefined,
      useContainer,
      mcpConfig,
      role,
    });
  } catch (err) {
    writer.send(createNormalizedMessage({
      kind: 'error',
      content: `Failed to spawn agent: ${err.message}`,
      sessionId: sessionId || '',
      provider: PROVIDER,
    }));
    return;
  }

  // Send session_created if this is a new session
  if (!sessionId) {
    writer.send(createNormalizedMessage({
      kind: 'session_created',
      newSessionId: agentId,
      sessionId: agentId,
      provider: PROVIDER,
    }));
  }

  if (writer.setSessionId) {
    writer.setSessionId(sessionId || agentId);
  }

  // Bridge stream-json events → NormalizedMessage → writer
  const eventHandler = ({ agentId: eid, event }) => {
    if (eid !== agentId) return;

    const sid = sessionId || agentId;

    // Try normalizing via the Claude adapter (handles content_block_delta,
    // content_block_stop, assistant messages, tool_use, tool_result, thinking, etc.)
    const normalized = claudeAdapter.normalizeMessage(event, sid);
    if (normalized.length > 0) {
      for (const msg of normalized) {
        if (event.parent_tool_use_id && !msg.parentToolUseId) {
          msg.parentToolUseId = event.parent_tool_use_id;
        }
        writer.send(msg);
      }
      return;
    }

    // Handle stream-json specific events that the adapter doesn't cover
    if (event.type === 'system' && event.subtype === 'init') {
      // Session init — capture the session_id from CLI
      if (event.session_id) {
        writer.send(createNormalizedMessage({
          kind: 'session_created',
          newSessionId: event.session_id,
          sessionId: event.session_id,
          provider: PROVIDER,
        }));
        if (writer.setSessionId) {
          writer.setSessionId(event.session_id);
        }
      }
      return;
    }

    if (event.type === 'result') {
      // Extract token budget from result
      const usage = event.usage || event.modelUsage;
      if (usage) {
        const modelKey = typeof usage === 'object' ? Object.keys(usage)[0] : null;
        const modelData = modelKey ? usage[modelKey] : usage;
        if (modelData) {
          const inputTokens = modelData.cumulativeInputTokens || modelData.inputTokens || modelData.input_tokens || 0;
          const outputTokens = modelData.cumulativeOutputTokens || modelData.outputTokens || modelData.output_tokens || 0;
          const contextWindow = parseInt(process.env.CONTEXT_WINDOW) || 160000;
          writer.send(createNormalizedMessage({
            kind: 'status',
            text: 'token_budget',
            tokenBudget: { used: inputTokens + outputTokens, total: contextWindow },
            sessionId: sid,
            provider: PROVIDER,
          }));
        }
      }
      return;
    }
  };

  const errorHandler = ({ agentId: eid, error }) => {
    if (eid !== agentId) return;
    writer.send(createNormalizedMessage({
      kind: 'error',
      content: error,
      sessionId: sessionId || agentId,
      provider: PROVIDER,
    }));
  };

  const exitHandler = ({ agentId: eid, code }) => {
    if (eid !== agentId) return;
    cleanup();
    writer.send(createNormalizedMessage({
      kind: 'complete',
      exitCode: code,
      sessionId: sessionId || agentId,
      provider: PROVIDER,
    }));
  };

  function cleanup() {
    processManager.removeListener('agent:event', eventHandler);
    processManager.removeListener('agent:error', errorHandler);
    processManager.removeListener('agent:exit', exitHandler);
  }

  processManager.on('agent:event', eventHandler);
  processManager.on('agent:error', errorHandler);
  processManager.on('agent:exit', exitHandler);

  // Return agentId so caller can track/abort
  return agentId;
}

/**
 * Send input to a running containerized session
 */
export function sendContainerizedInput(agentId, message, conductor) {
  conductor.processManager.sendInput(agentId, message);
}

/**
 * Abort/kill a containerized session
 */
export function abortContainerizedSession(agentId, conductor) {
  conductor.processManager.kill(agentId);
}
