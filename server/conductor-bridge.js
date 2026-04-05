/**
 * Conductor Bridge
 *
 * Bridges the conductor ProcessManager (which spawns real `claude` CLI
 * subprocesses, optionally in Docker) into the existing WebSocketWriter
 * flow that the UI expects.
 *
 * Translates stream-json events from the CLI into NormalizedMessage format.
 * ProcessManager runs one turn at a time (claude -p "msg" / --resume -p "msg").
 * Events stream in real-time during each turn.
 */

import { createNormalizedMessage } from './providers/types.js';

const PROVIDER = 'claude';

// Active bridges: agentId → { writer, cleanup }
const activeBridges = new Map();

/**
 * Spawn a Claude Code session via the conductor ProcessManager and stream
 * normalized events to the given writer (WebSocketWriter or SSEStreamWriter).
 */
export async function queryClaudeContainerized(command, options = {}, writer, conductor) {
  const { processManager } = conductor;
  const {
    projectPath,
    cwd,
    sessionId,
    useContainer = true,
    role = 'agent',
    provider = 'claude',
    permissionMode,
    toolsSettings,
  } = options;

  const workingDir = projectPath || cwd;

  if (!useContainer) {
    writer.send(createNormalizedMessage({
      kind: 'status',
      text: 'WARNING: Running without Docker container isolation. Agent has full host access.',
      sessionId: sessionId || '',
      provider: PROVIDER,
    }));
  }

  // Set up event listeners BEFORE spawning so we catch everything
  let realSessionId = sessionId || null;
  let lastGeminiContent = ''; // Track accumulated Gemini delta

  const eventHandler = ({ agentId: eid, event }) => {
    // We listen to all events and filter by our agentId below
    const bridge = activeBridges.get(eid);
    if (!bridge || bridge.writer !== writer) return;

    const sid = realSessionId || eid;
    console.log(`[Conductor Bridge] event type=${event.type} subtype=${event.subtype || ''} agentId=${eid}`);

    // ── system init: capture session_id (Claude: type=system/subtype=init, Gemini: type=init)
    if ((event.type === 'system' && event.subtype === 'init') || event.type === 'init') {
      if (event.session_id) {
        realSessionId = event.session_id;
        processManager.setSessionId(eid, realSessionId);
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

    // ── assistant message: extract content blocks
    if (event.type === 'assistant' && event.message?.content) {
      const content = event.message.content;
      const parentToolUseId = event.parent_tool_use_id || null;

      for (const block of content) {
        if (block.type === 'thinking' && block.thinking) {
          writer.send(createNormalizedMessage({
            kind: 'thinking',
            content: block.thinking,
            sessionId: realSessionId || sid,
            provider: PROVIDER,
            ...(parentToolUseId && { parentToolUseId }),
          }));
        } else if (block.type === 'text' && block.text) {
          writer.send(createNormalizedMessage({
            kind: 'text',
            role: 'assistant',
            content: block.text,
            sessionId: realSessionId || sid,
            provider: PROVIDER,
            ...(parentToolUseId && { parentToolUseId }),
          }));
        } else if (block.type === 'tool_use') {
          writer.send(createNormalizedMessage({
            kind: 'tool_use',
            toolName: block.name,
            toolInput: block.input,
            toolId: block.id,
            sessionId: realSessionId || sid,
            provider: PROVIDER,
            ...(parentToolUseId && { parentToolUseId }),
          }));
        }
      }

      // Token budget from usage
      if (event.message.usage) {
        const u = event.message.usage;
        const used = (u.input_tokens || 0) + (u.output_tokens || 0)
          + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        const contextWindow = parseInt(process.env.CONTEXT_WINDOW) || 160000;
        writer.send(createNormalizedMessage({
          kind: 'status',
          text: 'token_budget',
          tokenBudget: { used, total: contextWindow },
          sessionId: realSessionId || sid,
          provider: PROVIDER,
        }));
      }
      return;
    }

    // ── user message (tool results)
    if (event.type === 'user' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_result') {
          writer.send(createNormalizedMessage({
            kind: 'tool_result',
            toolId: block.tool_use_id || '',
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            isError: Boolean(block.is_error),
            sessionId: realSessionId || sid,
            provider: PROVIDER,
          }));
        }
      }
      return;
    }

    // ── MangoCode: text_delta events (no init event — send session_created on first event)
    if (event.type === 'text_delta' && event.text) {
      if (!realSessionId) {
        realSessionId = eid;
        processManager.setSessionId(eid, realSessionId);
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
      writer.send(createNormalizedMessage({
        kind: 'stream_delta',
        content: event.text,
        sessionId: realSessionId || sid,
        provider: PROVIDER,
      }));
      return;
    }

    // ── Gemini: message events (type: "message" with role)
    if (event.type === 'message') {
      if (event.role === 'assistant' && event.content) {
        const fullContent = event.content;
        // Gemini delta messages contain the FULL accumulated text.
        // Extract only the new portion to avoid duplicates.
        const newContent = fullContent.startsWith(lastGeminiContent)
          ? fullContent.slice(lastGeminiContent.length)
          : (lastGeminiContent && fullContent.includes(lastGeminiContent))
            ? fullContent.slice(fullContent.indexOf(lastGeminiContent) + lastGeminiContent.length)
            : fullContent;
        lastGeminiContent = fullContent;
        if (newContent) {
          writer.send(createNormalizedMessage({
            kind: 'stream_delta',
            content: newContent,
            sessionId: realSessionId || sid,
            provider: PROVIDER,
          }));
        }
      }
      // Skip user message echo
      return;
    }

    // ── Gemini: tool call events
    if (event.type === 'toolCall') {
      writer.send(createNormalizedMessage({
        kind: 'tool_use',
        toolName: event.name || event.toolName || 'unknown',
        toolInput: event.input || event.args || {},
        toolId: event.id || '',
        sessionId: realSessionId || sid,
        provider: PROVIDER,
      }));
      return;
    }

    if (event.type === 'toolResult') {
      writer.send(createNormalizedMessage({
        kind: 'tool_result',
        toolId: event.id || '',
        content: typeof event.output === 'string' ? event.output : JSON.stringify(event.output || ''),
        isError: Boolean(event.isError),
        sessionId: realSessionId || sid,
        provider: PROVIDER,
      }));
      return;
    }

    // ── result: final token budget (both Claude and Gemini)
    if (event.type === 'result') {
      // Send stream_end to close any streaming delta
      writer.send(createNormalizedMessage({
        kind: 'stream_end',
        sessionId: realSessionId || sid,
        provider: PROVIDER,
      }));
      lastGeminiContent = ''; // Reset for next turn

      // Handle Gemini error results
      if (event.status === 'error' && event.error) {
        writer.send(createNormalizedMessage({
          kind: 'error',
          content: event.error.message || JSON.stringify(event.error),
          sessionId: realSessionId || sid,
          provider: PROVIDER,
        }));
        return;
      }

      // Claude format
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
            sessionId: realSessionId || sid,
            provider: PROVIDER,
          }));
        }
      }
      // Gemini format
      if (event.stats) {
        const s = event.stats;
        const used = (s.input_tokens || s.input || 0) + (s.output_tokens || 0);
        const contextWindow = parseInt(process.env.CONTEXT_WINDOW) || 160000;
        writer.send(createNormalizedMessage({
          kind: 'status',
          text: 'token_budget',
          tokenBudget: { used, total: contextWindow },
          sessionId: realSessionId || sid,
          provider: PROVIDER,
        }));
      }
      return;
    }
  };

  const errorHandler = ({ agentId: eid, error }) => {
    const bridge = activeBridges.get(eid);
    if (!bridge || bridge.writer !== writer) return;
    console.log(`[Conductor Bridge] ERROR agentId=${eid}:`, error);
    writer.send(createNormalizedMessage({
      kind: 'error',
      content: error,
      sessionId: realSessionId || eid,
      provider: PROVIDER,
    }));
  };

  const turnCompleteHandler = ({ agentId: eid, code }) => {
    const bridge = activeBridges.get(eid);
    if (!bridge || bridge.writer !== writer) return;
    console.log(`[Conductor Bridge] TURN COMPLETE agentId=${eid} code=${code}`);
    lastGeminiContent = ''; // Reset delta tracker for next turn
    writer.send(createNormalizedMessage({
      kind: 'complete',
      exitCode: code,
      sessionId: realSessionId || eid,
      provider: PROVIDER,
    }));
  };

  // Register listeners
  processManager.on('agent:event', eventHandler);
  processManager.on('agent:error', errorHandler);
  processManager.on('agent:turn_complete', turnCompleteHandler);

  function cleanup() {
    processManager.removeListener('agent:event', eventHandler);
    processManager.removeListener('agent:error', errorHandler);
    processManager.removeListener('agent:turn_complete', turnCompleteHandler);
    activeBridges.delete(agentId);
  }

  // Pre-generate agentId and register bridge BEFORE spawning,
  // so event handlers can match events during the awaited first turn
  const { randomUUID } = await import('crypto');
  const agentId = randomUUID();
  activeBridges.set(agentId, { writer, cleanup, realSessionId: () => realSessionId });

  console.log(`[Conductor Bridge] Spawning agentId=${agentId} useContainer=${useContainer}`);

  try {
    await processManager.spawn({
      prompt: command || undefined,
      projectId: workingDir,
      sessionId: sessionId || undefined,
      useContainer,
      role,
      provider,
      agentId, // pass pre-generated ID
      permissionMode,
      allowedTools: toolsSettings?.allowedTools,
      disallowedTools: toolsSettings?.disallowedTools,
      skipPermissions: toolsSettings?.skipPermissions,
    });
  } catch (err) {
    cleanup();
    writer.send(createNormalizedMessage({
      kind: 'error',
      content: `Failed to spawn agent: ${err.message}`,
      sessionId: sessionId || '',
      provider: PROVIDER,
    }));
    return;
  }

  console.log(`[Conductor Bridge] First turn complete agentId=${agentId}`);

  return agentId;
}

/**
 * Abort/kill a containerized session
 */
export function abortContainerizedSession(agentId, conductor) {
  const bridge = activeBridges.get(agentId);
  if (bridge) bridge.cleanup();
  conductor.processManager.kill(agentId);
}
