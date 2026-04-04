/**
 * WebSocket hook for the /conductor-ws endpoint.
 * Provides real-time agent state, events, and inter-agent messages.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';

interface Agent {
  agentId: string;
  role: string;
  projectId: string;
  sessionId?: string;
  startedAt: number;
  tokenUsage: { input: number; output: number };
  busy?: boolean;
  status: 'running' | 'thinking' | 'idle' | 'compacting' | 'stopped';
  contextPct: number;
}

interface AgentMessage {
  id: number;
  from_agent: string;
  to_agent: string;
  content: string;
  read: boolean;
  created_at: number;
}

export interface AgentEvent {
  id: number;
  type: 'thinking' | 'text' | 'tool_use' | 'tool_result' | 'error' | 'status';
  content: string;
  timestamp: number;
}

interface ConductorState {
  agents: Agent[];
  messages: AgentMessage[];
  agentEvents: Record<string, AgentEvent[]>; // agentId → recent events
  isConnected: boolean;
}

const CONTEXT_WINDOW = parseInt(
  (typeof window !== 'undefined' && (window as Record<string, unknown>).VITE_CONTEXT_WINDOW as string) || '160000',
  10,
);

function deriveStatus(agent: { busy?: boolean; tokenUsage: { input: number; output: number } }): Agent['status'] {
  if (agent.busy) return 'running';
  const total = agent.tokenUsage.input + agent.tokenUsage.output;
  if (total === 0) return 'idle';
  return 'idle';
}

function deriveContextPct(agent: { tokenUsage: { input: number; output: number } }): number {
  const total = agent.tokenUsage.input + agent.tokenUsage.output;
  return Math.min(total / CONTEXT_WINDOW, 1);
}

export function useConductorWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { token } = useAuth();

  const [state, setState] = useState<ConductorState>({
    agents: [],
    messages: [],
    agentEvents: {},
    isConnected: false,
  });

  let eventCounter = 0;

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (!token) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/conductor-ws?token=${encodeURIComponent(token)}`;

    const ws = new WebSocket(url);

    ws.onopen = () => {
      wsRef.current = ws;
      setState((prev) => ({ ...prev, isConnected: true }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleMessage(data);
      } catch {
        // ignore non-JSON
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      setState((prev) => ({ ...prev, isConnected: false }));
      // Reconnect after 3s
      reconnectTimerRef.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [token]);

  const handleMessage = useCallback((data: Record<string, unknown>) => {
    const type = data.type as string;

    if (type === 'conductor:init') {
      const rawAgents = (data.agents as Array<Record<string, unknown>>) || [];
      setState((prev) => ({
        ...prev,
        agents: rawAgents.filter((a) => a.agentId).map((a) => ({
          agentId: a.agentId as string,
          role: (a.role as string) || 'agent',
          projectId: (a.projectId as string) || '',
          sessionId: a.sessionId as string | undefined,
          startedAt: (a.startedAt as number) || Date.now(),
          tokenUsage: (a.tokenUsage as { input: number; output: number }) || { input: 0, output: 0 },
          busy: a.busy as boolean,
          status: deriveStatus(a as Agent),
          contextPct: deriveContextPct(a as Agent),
        })),
      }));
      return;
    }

    if (type === 'agent:spawned') {
      const agentId = data.agentId as string;
      if (!agentId) return;
      setState((prev) => {
        if (prev.agents.some((a) => a.agentId === agentId)) return prev;
        return {
          ...prev,
          agents: [
            ...prev.agents,
            {
              agentId,
              role: (data.role as string) || 'agent',
              projectId: (data.projectId as string) || '',
              sessionId: data.sessionId as string | undefined,
              startedAt: Date.now(),
              tokenUsage: { input: 0, output: 0 },
              status: 'running',
              contextPct: 0,
            },
          ],
        };
      });
      return;
    }

    if (type === 'agent:exit' || type === 'agent:killed') {
      const agentId = data.agentId as string;
      setState((prev) => ({
        ...prev,
        agents: prev.agents.map((a) =>
          a.agentId === agentId ? { ...a, status: 'stopped' as const } : a,
        ),
      }));
      return;
    }

    if (type === 'agent:turn_complete') {
      const agentId = data.agentId as string;
      setState((prev) => ({
        ...prev,
        agents: prev.agents.map((a) =>
          a.agentId === agentId ? { ...a, status: 'idle' as const } : a,
        ),
      }));
      return;
    }

    if (type === 'context:usage') {
      const agentId = data.agentId as string;
      const tokenUsage = data.tokenUsage as { input: number; output: number };
      const pct = (data.pct as number) || 0;
      setState((prev) => ({
        ...prev,
        agents: prev.agents.map((a) =>
          a.agentId === agentId ? { ...a, tokenUsage, contextPct: pct } : a,
        ),
      }));
      return;
    }

    if (type === 'context:auto-compact') {
      const agentId = data.agentId as string;
      setState((prev) => ({
        ...prev,
        agents: prev.agents.map((a) =>
          a.agentId === agentId ? { ...a, status: 'compacting' as const } : a,
        ),
      }));
      return;
    }

    if (type === 'mcp:message') {
      const msg: AgentMessage = {
        id: Date.now(),
        from_agent: data.from as string,
        to_agent: data.to as string,
        content: data.content as string,
        read: false,
        created_at: Math.floor(Date.now() / 1000),
      };
      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, msg].slice(-200),
      }));
      return;
    }

    // ── agent:event — capture thinking, text, tool_use from stream ────
    if (type === 'agent:event') {
      const agentId = data.agentId as string;
      const event = data.event as Record<string, unknown>;
      if (!agentId || !event) return;

      const newEvents: AgentEvent[] = [];

      // Update agent status based on event type
      if (event.type === 'assistant' && event.message) {
        const msg = event.message as { content?: Array<Record<string, unknown>> };
        if (msg.content) {
          for (const block of msg.content) {
            if (block.type === 'thinking' && block.thinking) {
              newEvents.push({
                id: ++eventCounter,
                type: 'thinking',
                content: (block.thinking as string).slice(0, 200),
                timestamp: Date.now(),
              });
            } else if (block.type === 'text' && block.text) {
              newEvents.push({
                id: ++eventCounter,
                type: 'text',
                content: block.text as string,
                timestamp: Date.now(),
              });
            } else if (block.type === 'tool_use') {
              newEvents.push({
                id: ++eventCounter,
                type: 'tool_use',
                content: `${block.name as string}(${JSON.stringify(block.input || {}).slice(0, 100)})`,
                timestamp: Date.now(),
              });
            }
          }
        }

        // Update agent to 'thinking' or 'running' while active
        setState((prev) => ({
          ...prev,
          agents: prev.agents.map((a) =>
            a.agentId === agentId ? { ...a, status: 'running' as const } : a,
          ),
          agentEvents: {
            ...prev.agentEvents,
            [agentId]: [...(prev.agentEvents[agentId] || []), ...newEvents].slice(-50),
          },
        }));
        return;
      }

      if (event.type === 'user' && event.message) {
        const msg = event.message as { content?: Array<Record<string, unknown>> };
        if (msg.content) {
          for (const block of msg.content) {
            if (block.type === 'tool_result') {
              const content = typeof block.content === 'string'
                ? (block.content as string).slice(0, 150)
                : JSON.stringify(block.content || '').slice(0, 150);
              newEvents.push({
                id: ++eventCounter,
                type: 'tool_result',
                content,
                timestamp: Date.now(),
              });
            }
          }
        }

        if (newEvents.length > 0) {
          setState((prev) => ({
            ...prev,
            agentEvents: {
              ...prev.agentEvents,
              [agentId]: [...(prev.agentEvents[agentId] || []), ...newEvents].slice(-50),
            },
          }));
        }
        return;
      }
    }

    // ── hook:event — CC hooks data (file changes, subagent lifecycle, etc.)
    if (type === 'hook:event') {
      const agentId = (data.agentId as string) || (data.sessionId as string);
      const hookEvent = data.hookEvent as string;
      const toolName = data.toolName as string | undefined;
      const toolInput = data.toolInput as unknown;
      const toolOutput = data.toolOutput as string | undefined;

      if (!agentId) return;

      let eventType: AgentEvent['type'] = 'status';
      let content = hookEvent;

      if (hookEvent === 'PreToolUse' && toolName) {
        eventType = 'tool_use';
        content = `${toolName}(${JSON.stringify(toolInput || {}).slice(0, 120)})`;
      } else if (hookEvent === 'PostToolUse' && toolName) {
        eventType = 'tool_result';
        content = toolOutput || `${toolName} completed`;
      } else if (hookEvent === 'SubagentStart') {
        eventType = 'status';
        content = `Subagent started: ${(data.message as string) || ''}`;
      } else if (hookEvent === 'SubagentStop') {
        eventType = 'status';
        content = `Subagent stopped: ${(data.message as string) || ''}`;
      } else if (hookEvent === 'SessionStart') {
        eventType = 'status';
        content = `Session started (${(data.source as string) || 'startup'})`;
      } else if (hookEvent === 'Stop') {
        eventType = 'status';
        content = 'Session stopped';
      }

      const newEvent: AgentEvent = {
        id: ++eventCounter,
        type: eventType,
        content,
        timestamp: (data.timestamp as number) || Date.now(),
      };

      setState((prev) => ({
        ...prev,
        agentEvents: {
          ...prev.agentEvents,
          [agentId]: [...(prev.agentEvents[agentId] || []), newEvent].slice(-50),
        },
      }));
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const addAgent = useCallback((agent: Omit<Agent, 'busy'>) => {
    setState((prev) => {
      if (prev.agents.some((a) => a.agentId === agent.agentId)) return prev;
      return { ...prev, agents: [...prev.agents, { ...agent, busy: false }] };
    });
  }, []);

  return { ...state, addAgent };
}
