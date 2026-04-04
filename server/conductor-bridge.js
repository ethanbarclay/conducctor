/**
 * Conductor Bridge
 *
 * Bridges the conductor ProcessManager (which spawns real `claude` CLI
 * subprocesses, optionally in Docker) into the existing WebSocketWriter
 * flow that the UI expects.
 *
 * Translates stream-json events from the CLI into NormalizedMessage format,
 * matching the interface used by queryClaudeSDK().
 *
 * CLI stream-json event types (with --verbose):
 *   { type: "system", subtype: "init", session_id, cwd, tools, model, ... }
 *   { type: "assistant", message: { role: "assistant", content: [{type:"thinking",...}, {type:"text",...}, {type:"tool_use",...}] }, session_id }
 *   { type: "user", message: { role: "user", content: [{type:"tool_result",...}] }, session_id }
 *   { type: "result", subtype: "success"|"error", result, session_id, modelUsage, ... }
 */

import { createNormalizedMessage } from './providers/types.js';

const PROVIDER = 'claude';

/**
 * Spawn a Claude Code session via the conductor ProcessManager and stream
 * normalized events to the given writer (WebSocketWriter or SSEStreamWriter).
 *
 * This is the containerized alternative to queryClaudeSDK().
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

  let agentId;
  try {
    agentId = await processManager.spawn({
      prompt: command || undefined,
      projectId: workingDir,
      sessionId: sessionId || undefined,
      useContainer,
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

  // Track the real session ID from the CLI (set on init event)
  let realSessionId = sessionId || agentId;

  if (writer.setSessionId) {
    writer.setSessionId(realSessionId);
  }

  // Bridge stream-json events → NormalizedMessage → writer
  const eventHandler = ({ agentId: eid, event }) => {
    if (eid !== agentId) return;

    // ── system init: capture session_id ──────────────────────────────────
    if (event.type === 'system' && event.subtype === 'init') {
      if (event.session_id) {
        realSessionId = event.session_id;
        if (writer.setSessionId) {
          writer.setSessionId(realSessionId);
        }
        writer.send(createNormalizedMessage({
          kind: 'session_created',
          newSessionId: realSessionId,
          sessionId: realSessionId,
          provider: PROVIDER,
        }));
      }
      return;
    }

    // ── assistant message: extract content blocks ────────────────────────
    if (event.type === 'assistant' && event.message?.content) {
      const content = event.message.content;
      const parentToolUseId = event.parent_tool_use_id || null;

      for (const block of content) {
        if (block.type === 'thinking' && block.thinking) {
          writer.send(createNormalizedMessage({
            kind: 'thinking',
            content: block.thinking,
            sessionId: realSessionId,
            provider: PROVIDER,
            ...(parentToolUseId && { parentToolUseId }),
          }));
        } else if (block.type === 'text' && block.text) {
          writer.send(createNormalizedMessage({
            kind: 'text',
            role: 'assistant',
            content: block.text,
            sessionId: realSessionId,
            provider: PROVIDER,
            ...(parentToolUseId && { parentToolUseId }),
          }));
        } else if (block.type === 'tool_use') {
          writer.send(createNormalizedMessage({
            kind: 'tool_use',
            toolName: block.name,
            toolInput: block.input,
            toolId: block.id,
            sessionId: realSessionId,
            provider: PROVIDER,
            ...(parentToolUseId && { parentToolUseId }),
          }));
        }
      }

      // Send token budget from usage data on assistant messages
      if (event.message.usage) {
        const u = event.message.usage;
        const used = (u.input_tokens || 0) + (u.output_tokens || 0)
          + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        const contextWindow = parseInt(process.env.CONTEXT_WINDOW) || 160000;
        writer.send(createNormalizedMessage({
          kind: 'status',
          text: 'token_budget',
          tokenBudget: { used, total: contextWindow },
          sessionId: realSessionId,
          provider: PROVIDER,
        }));
      }
      return;
    }

    // ── user message (tool results coming back) ──────────────────────────
    if (event.type === 'user' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_result') {
          writer.send(createNormalizedMessage({
            kind: 'tool_result',
            toolId: block.tool_use_id || '',
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            isError: Boolean(block.is_error),
            sessionId: realSessionId,
            provider: PROVIDER,
          }));
        }
      }
      return;
    }

    // ── result: session complete ─────────────────────────────────────────
    if (event.type === 'result') {
      // Extract final token budget from modelUsage
      if (event.modelUsage) {
        const modelKey = Object.keys(event.modelUsage)[0];
        const m = event.modelUsage[modelKey];
        if (m) {
          const used = (m.inputTokens || 0) + (m.outputTokens || 0)
            + (m.cacheReadInputTokens || 0) + (m.cacheCreationInputTokens || 0);
          const contextWindow = parseInt(process.env.CONTEXT_WINDOW) || 160000;
          writer.send(createNormalizedMessage({
            kind: 'status',
            text: 'token_budget',
            tokenBudget: { used, total: contextWindow },
            sessionId: realSessionId,
            provider: PROVIDER,
          }));
        }
      }
      // Note: completion is sent on agent:exit, not here, since the CLI
      // process may still be running (interactive mode)
      return;
    }

    // ── rate_limit_event: ignore silently ────────────────────────────────
    if (event.type === 'rate_limit_event') {
      return;
    }
  };

  const errorHandler = ({ agentId: eid, error }) => {
    if (eid !== agentId) return;
    writer.send(createNormalizedMessage({
      kind: 'error',
      content: error,
      sessionId: realSessionId,
      provider: PROVIDER,
    }));
  };

  const exitHandler = ({ agentId: eid, code }) => {
    if (eid !== agentId) return;
    cleanup();
    writer.send(createNormalizedMessage({
      kind: 'complete',
      exitCode: code,
      sessionId: realSessionId,
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
