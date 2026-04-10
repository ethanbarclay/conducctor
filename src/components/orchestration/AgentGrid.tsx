/**
 * AgentGrid
 *
 * Top-level multi-agent dashboard. Shows all running CC agent instances
 * with live status, context usage, role, quick actions, and activity feed.
 */

import { useState } from 'react';
import type { AgentEvent } from './hooks/useConductorWebSocket';

interface Agent {
  agentId: string;
  role: string;
  projectId: string;
  sessionId?: string;
  startedAt: number;
  tokenUsage: { input: number; output: number };
  status: 'running' | 'thinking' | 'idle' | 'compacting' | 'stopped';
  contextPct: number;
}

interface AgentGridProps {
  agents: Agent[];
  agentEvents: Record<string, AgentEvent[]>;
  expandedAgents: Set<string>;
  onToggleExpanded: (agentId: string) => void;
  onCompact: (agentId: string) => void;
  onFork: (agentId: string) => void;
  onCheckpoint: (agentId: string) => void;
  onKill: (agentId: string) => void;
  onSendMessage: (agentId: string, message: string) => void;
  onSpawnAgent: () => void;
}

function ContextMeter({ pct }: { pct: number }) {
  const color =
    pct >= 0.8
      ? 'bg-red-500'
      : pct >= 0.6
        ? 'bg-yellow-500'
        : 'bg-green-500';

  return (
    <div className="w-full">
      <div className="mb-1 flex justify-between text-[10px] text-muted-foreground">
        <span>Context</span>
        <span>{Math.round(pct * 100)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${pct * 100}%` }}
        />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Agent['status'] }) {
  const styles: Record<Agent['status'], string> = {
    running: 'bg-blue-500/20 text-blue-400',
    thinking: 'bg-purple-500/20 text-purple-400 animate-pulse',
    idle: 'bg-muted text-muted-foreground',
    compacting: 'bg-yellow-500/20 text-yellow-400',
    stopped: 'bg-red-500/20 text-red-400',
  };
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${styles[status]}`}
    >
      {status}
    </span>
  );
}

const EVENT_ICONS: Record<AgentEvent['type'], string> = {
  thinking: '💭',
  text: '💬',
  tool_use: '🔧',
  tool_result: '📋',
  error: '❌',
  status: 'ℹ️',
};

function AgentActivity({ events }: { events: AgentEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="px-2 py-3 text-center text-[10px] text-muted-foreground">
        No activity yet
      </div>
    );
  }

  // Sort newest-first with id as a stable tie-breaker. Multiple events from a
  // single assistant turn (thinking → tool_use → tool_result) often share the
  // same Date.now() timestamp; relying on Array.reverse() leaves their order
  // dependent on arrival sequence and breaks visually.
  const sortedEvents = [...events].sort((a, b) => {
    if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
    return b.id - a.id;
  });

  return (
    <div className="max-h-48 space-y-0.5 overflow-y-auto">
      {sortedEvents.map((evt) => {
        const depth = evt.depth || 0;
        return (
        <div
          key={evt.id}
          className={`flex items-start gap-1.5 rounded py-1 text-[10px] hover:bg-accent/30 ${depth > 0 ? 'bg-muted/20 opacity-80' : ''}`}
          style={{ paddingLeft: `${8 + depth * 12}px`, paddingRight: '8px' }}
        >
          <span className="shrink-0 pt-0.5">{depth > 0 ? '↳' : EVENT_ICONS[evt.type]}</span>
          <span className="min-w-0 flex-1 break-words text-muted-foreground">
            {evt.content}
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground/50">
            {new Date(evt.timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </span>
        </div>
        );
      })}
    </div>
  );
}

export function AgentGrid({
  agents,
  agentEvents,
  expandedAgents,
  onToggleExpanded,
  onCompact,
  onFork,
  onCheckpoint,
  onKill,
  onSendMessage,
  onSpawnAgent,
}: AgentGridProps) {
  const [messageInputs, setMessageInputs] = useState<Record<string, string>>(
    {},
  );

  const handleSend = (agentId: string) => {
    const msg = messageInputs[agentId];
    if (!msg?.trim()) return;
    onSendMessage(agentId, msg);
    setMessageInputs((prev) => ({ ...prev, [agentId]: '' }));
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Agents
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {agents.filter((a) => a.status !== 'stopped').length} active
          </span>
        </h2>
        <button
          onClick={onSpawnAgent}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90"
        >
          + Spawn Agent
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {agents.map((agent) => {
          const isExpanded = expandedAgents.has(agent.agentId);
          const events = agentEvents[agent.agentId] || [];

          return (
            <div
              key={agent.agentId}
              className="space-y-3 rounded-lg border border-border bg-card p-3"
            >
              {/* Header */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium capitalize">
                    {agent.role || 'agent'}
                  </div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground">
                    {(agent.agentId || '').slice(0, 12)}...
                  </div>
                </div>
                <StatusBadge status={agent.status} />
              </div>

              {/* Context meter */}
              <ContextMeter pct={agent.contextPct} />

              {/* Token stats */}
              <div className="flex gap-3 text-[10px] text-muted-foreground">
                <span>
                  ↑ {(agent.tokenUsage.input / 1000).toFixed(1)}k
                </span>
                <span>
                  ↓ {(agent.tokenUsage.output / 1000).toFixed(1)}k
                </span>
                <span className="ml-auto">
                  {new Date(agent.startedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>

              {/* Activity toggle + feed */}
              <div>
                <button
                  onClick={() => onToggleExpanded(agent.agentId)}
                  className="mb-1 flex w-full items-center justify-between rounded px-1 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent/50"
                >
                  <span>
                    Activity{' '}
                    {events.length > 0 && (
                      <span className="text-primary">({events.length})</span>
                    )}
                  </span>
                  <span>{isExpanded ? '▼' : '▶'}</span>
                </button>
                {isExpanded && (
                  <div className="rounded border border-border/50 bg-muted/30">
                    <AgentActivity events={events} />
                  </div>
                )}
              </div>

              {/* Message input */}
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={messageInputs[agent.agentId] || ''}
                  onChange={(e) =>
                    setMessageInputs((prev) => ({
                      ...prev,
                      [agent.agentId]: e.target.value,
                    }))
                  }
                  onKeyDown={(e) =>
                    e.key === 'Enter' && handleSend(agent.agentId)
                  }
                  placeholder="Send message..."
                  className="min-w-0 flex-1 rounded-md border border-border bg-muted px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
                />
                <button
                  onClick={() => handleSend(agent.agentId)}
                  className="rounded-md border border-border bg-muted px-2 py-1 text-xs transition-colors hover:bg-accent"
                >
                  →
                </button>
              </div>

              {/* Actions */}
              <div className="flex flex-wrap gap-1">
                <button
                  onClick={() => onCompact(agent.agentId)}
                  className="rounded border border-border bg-muted px-2 py-1 text-[10px] transition-colors hover:bg-accent"
                  title="Compact context"
                >
                  Compact
                </button>
                <button
                  onClick={() => onFork(agent.agentId)}
                  className="rounded border border-border bg-muted px-2 py-1 text-[10px] transition-colors hover:bg-accent"
                  title="Fork this session"
                >
                  Fork
                </button>
                <button
                  onClick={() => onCheckpoint(agent.agentId)}
                  className="rounded border border-border bg-muted px-2 py-1 text-[10px] transition-colors hover:bg-accent"
                  title="Save checkpoint"
                >
                  Checkpoint
                </button>
                <button
                  onClick={() => onKill(agent.agentId)}
                  className="ml-auto rounded border border-red-500/20 bg-red-500/10 px-2 py-1 text-[10px] text-red-400 transition-colors hover:bg-red-500/20"
                  title="Kill agent"
                >
                  Kill
                </button>
              </div>
            </div>
          );
        })}

        {agents.length === 0 && (
          <div className="col-span-full flex flex-col items-center justify-center py-12 text-muted-foreground">
            <p className="text-sm">No agents running</p>
            <p className="mt-1 text-xs">Spawn an agent to get started</p>
          </div>
        )}
      </div>
    </div>
  );
}
