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

interface ConductorState {
  agents: Agent[];
  messages: AgentMessage[];
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
    isConnected: false,
  });

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
        messages: [...prev.messages, msg].slice(-200), // keep last 200
      }));
      return;
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return state;
}
