/**
 * ObservabilityPanel
 *
 * Real-time view of all agent activity across the system.
 * Shows a unified event stream, per-agent lanes, and filtering.
 */

import { useCallback, useMemo, useState } from 'react';
import { useConductorWebSocket, type AgentEvent } from './hooks/useConductorWebSocket';

type EventFilter = 'all' | 'thinking' | 'text' | 'tool_use' | 'tool_result' | 'error';

const FILTER_OPTIONS: { value: EventFilter; label: string; color: string }[] = [
  { value: 'all', label: 'All', color: 'text-foreground' },
  { value: 'thinking', label: 'Thinking', color: 'text-purple-400' },
  { value: 'text', label: 'Text', color: 'text-blue-400' },
  { value: 'tool_use', label: 'Tools', color: 'text-yellow-400' },
  { value: 'tool_result', label: 'Results', color: 'text-green-400' },
  { value: 'error', label: 'Errors', color: 'text-red-400' },
];

const EVENT_COLORS: Record<string, string> = {
  thinking: 'border-l-purple-500',
  text: 'border-l-blue-500',
  tool_use: 'border-l-yellow-500',
  tool_result: 'border-l-green-500',
  error: 'border-l-red-500',
  status: 'border-l-gray-500',
};

const EVENT_LABELS: Record<string, string> = {
  thinking: 'THINK',
  text: 'TEXT',
  tool_use: 'TOOL',
  tool_result: 'RESULT',
  error: 'ERROR',
  status: 'STATUS',
};

const EVENT_LABEL_COLORS: Record<string, string> = {
  thinking: 'bg-purple-500/20 text-purple-400',
  text: 'bg-blue-500/20 text-blue-400',
  tool_use: 'bg-yellow-500/20 text-yellow-400',
  tool_result: 'bg-green-500/20 text-green-400',
  error: 'bg-red-500/20 text-red-400',
  status: 'bg-gray-500/20 text-gray-400',
};

interface FlatEvent extends AgentEvent {
  agentId: string;
  role: string;
}

export default function ObservabilityPanel({ isVisible }: { isVisible: boolean }) {
  const { agents, agentEvents, isConnected } = useConductorWebSocket();
  const [filter, setFilter] = useState<EventFilter>('all');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Flatten all events across agents into a single sorted stream
  const allEvents = useMemo(() => {
    const flat: FlatEvent[] = [];
    for (const agent of agents) {
      const events = agentEvents[agent.agentId] || [];
      for (const event of events) {
        flat.push({
          ...event,
          agentId: agent.agentId,
          role: agent.role || 'agent',
        });
      }
    }
    flat.sort((a, b) => b.timestamp - a.timestamp);
    return flat;
  }, [agents, agentEvents]);

  // Apply filters
  const filteredEvents = useMemo(() => {
    let events = allEvents;
    if (filter !== 'all') {
      events = events.filter((e) => e.type === filter);
    }
    if (selectedAgent) {
      events = events.filter((e) => e.agentId === selectedAgent);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      events = events.filter((e) => e.content.toLowerCase().includes(q));
    }
    return events;
  }, [allEvents, filter, selectedAgent, searchQuery]);

  // Agent color assignments
  const agentColors = useMemo(() => {
    const colors = ['text-blue-400', 'text-green-400', 'text-purple-400', 'text-yellow-400', 'text-pink-400', 'text-cyan-400', 'text-orange-400'];
    const map = new Map<string, string>();
    agents.forEach((a, i) => map.set(a.agentId, colors[i % colors.length]));
    return map;
  }, [agents]);

  const formatTime = useCallback((ts: number) => {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }, []);

  return (
    <div className={`flex h-full flex-col overflow-hidden ${isVisible ? 'block' : 'hidden'}`}>
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-2">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`} />
          <h2 className="text-sm font-semibold">Observability</h2>
          <span className="text-xs text-muted-foreground">{filteredEvents.length} events</span>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {/* Agent filter */}
          <select
            value={selectedAgent || ''}
            onChange={(e) => setSelectedAgent(e.target.value || null)}
            className="rounded-md border border-border bg-muted px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.agentId} value={a.agentId}>
                {a.role} ({(a.agentId).slice(0, 8)})
              </option>
            ))}
          </select>

          {/* Search */}
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search..."
            className="w-32 rounded-md border border-border bg-muted px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      {/* Type filter pills */}
      <div className="flex items-center gap-1 border-b border-border/50 bg-card px-4 py-1.5">
        {FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setFilter(opt.value)}
            className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium transition-colors ${
              filter === opt.value
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-accent'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Agent lanes summary */}
      {agents.length > 0 && !selectedAgent && (
        <div className="flex items-center gap-3 border-b border-border/30 px-4 py-1.5 overflow-x-auto">
          {agents.map((agent) => {
            const events = agentEvents[agent.agentId] || [];
            const latest = events[events.length - 1];
            const color = agentColors.get(agent.agentId) || 'text-muted-foreground';
            return (
              <button
                key={agent.agentId}
                onClick={() => setSelectedAgent(agent.agentId)}
                className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[10px] transition-colors hover:bg-accent/50"
              >
                <span className={`font-medium ${color}`}>{agent.role}</span>
                <span className={`rounded-full px-1 py-0.5 text-[9px] font-medium ${
                  agent.status === 'running' ? 'bg-blue-500/20 text-blue-400' :
                  agent.status === 'idle' ? 'bg-muted text-muted-foreground' :
                  'bg-red-500/20 text-red-400'
                }`}>{agent.status}</span>
                {latest && (
                  <span className="max-w-[120px] truncate text-muted-foreground">
                    {latest.content.slice(0, 40)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Event stream */}
      <div className="flex-1 overflow-y-auto">
        {filteredEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <p className="text-sm">No events</p>
            <p className="mt-1 text-xs">
              {agents.length === 0 ? 'Spawn an agent to see activity' : 'Waiting for activity...'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/20">
            {filteredEvents.map((event) => {
              const color = agentColors.get(event.agentId) || 'text-muted-foreground';
              return (
                <div
                  key={`${event.agentId}-${event.id}`}
                  className={`flex items-start gap-2 border-l-2 px-4 py-1.5 transition-colors hover:bg-accent/20 ${EVENT_COLORS[event.type] || 'border-l-transparent'}`}
                >
                  {/* Timestamp */}
                  <span className="shrink-0 pt-0.5 font-mono text-[10px] tabular-nums text-muted-foreground/60">
                    {formatTime(event.timestamp)}
                  </span>

                  {/* Agent label */}
                  <span className={`shrink-0 w-20 truncate text-[10px] font-medium ${color}`}>
                    {event.role}
                  </span>

                  {/* Event type badge */}
                  <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-medium ${EVENT_LABEL_COLORS[event.type] || ''}`}>
                    {EVENT_LABELS[event.type] || event.type}
                  </span>

                  {/* Content */}
                  <span className="min-w-0 flex-1 text-xs text-muted-foreground break-words">
                    {event.content}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
