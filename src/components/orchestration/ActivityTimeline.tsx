/**
 * ActivityTimeline
 *
 * Horizontal scrolling timeline with per-agent lanes and CSS-driven
 * drifting event dots. Inspired by agents-observe, built for Conducctor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent } from './hooks/useConductorWebSocket';

type TimeRange = '1m' | '5m' | '10m' | '60m';

const RANGE_MS: Record<TimeRange, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '10m': 600_000,
  '60m': 3_600_000,
};

const TICK_COUNTS: Record<TimeRange, number> = {
  '1m': 6,
  '5m': 5,
  '10m': 5,
  '60m': 6,
};

const DOT_COLORS: Record<string, string> = {
  thinking: 'bg-purple-500',
  text: 'bg-blue-500',
  tool_use: 'bg-yellow-500',
  tool_result: 'bg-green-500',
  error: 'bg-red-500',
  status: 'bg-gray-500',
};

const DOT_LABELS: Record<string, string> = {
  thinking: 'Thinking',
  text: 'Text',
  tool_use: 'Tool',
  tool_result: 'Result',
  error: 'Error',
  status: 'Status',
};

const AGENT_COLORS = [
  'text-blue-400',
  'text-green-400',
  'text-purple-400',
  'text-yellow-400',
  'text-pink-400',
  'text-cyan-400',
  'text-orange-400',
  'text-red-400',
];

interface AgentInfo {
  agentId: string;
  role: string;
  status: string;
}

interface TimelineEvent extends AgentEvent {
  agentId: string;
}

interface ActivityTimelineProps {
  agents: AgentInfo[];
  agentEvents: Record<string, AgentEvent[]>;
  onEventClick?: (agentId: string, event: AgentEvent) => void;
}

// ─── Drifting Dots ──────────────────────────────────────────────────────────

function DriftingDot({
  event,
  rangeMs,
  generation,
}: {
  event: TimelineEvent;
  rangeMs: number;
  generation: number;
}) {
  const age = Date.now() - event.timestamp;
  const position = 100 - (age / rangeMs) * 100;
  if (position < -10 || position > 100) return null;

  const remainingMs = Math.max(0, rangeMs - age);
  const color = DOT_COLORS[event.type] || 'bg-gray-400';
  const label = DOT_LABELS[event.type] || event.type;

  return (
    <button
      key={`${event.id}-${generation}`}
      className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-pointer transition-transform hover:scale-150"
      style={{ left: `${position}%` }}
      ref={(el) => {
        if (!el) return;
        requestAnimationFrame(() => {
          el.style.transition = `left ${remainingMs}ms linear`;
          el.style.left = '-5%';
        });
      }}
      title={`${label}: ${event.content.slice(0, 80)}`}
    >
      <span className={`flex h-3 w-3 items-center justify-center rounded-full ${color} shadow-sm`}>
        <span className="h-1.5 w-1.5 rounded-full bg-white/80" />
      </span>
    </button>
  );
}

// ─── Agent Lane ─────────────────────────────────────────────────────────────

function AgentLane({
  agent,
  events,
  rangeMs,
  generation,
  color,
  ticks,
}: {
  agent: AgentInfo;
  events: TimelineEvent[];
  rangeMs: number;
  generation: number;
  color: string;
  ticks: { pct: number; label: string }[];
}) {
  const visibleEvents = useMemo(
    () => events.filter((e) => Date.now() - e.timestamp < rangeMs),
    [events, rangeMs],
  );

  return (
    <div className="flex h-8 items-center border-b border-border/20">
      {/* Agent label */}
      <div className={`w-28 shrink-0 truncate px-2 text-[10px] font-medium ${color}`}>
        {agent.role}
        <span className="ml-1 text-muted-foreground/50">
          ({agent.agentId.slice(0, 6)})
        </span>
      </div>

      {/* Lane */}
      <div className="relative h-full flex-1 overflow-hidden">
        {/* Tick lines */}
        {ticks.map(({ pct, label }) => (
          <div
            key={label}
            className="absolute bottom-0 top-0"
            style={{ left: `${pct}%` }}
          >
            <div className="h-full w-px border-l border-border/15" />
          </div>
        ))}

        {/* Event dots */}
        {visibleEvents.map((event) => (
          <DriftingDot
            key={`${event.id}-${generation}`}
            event={event}
            rangeMs={rangeMs}
            generation={generation}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Main Timeline ──────────────────────────────────────────────────────────

export default function ActivityTimeline({ agents, agentEvents, onEventClick }: ActivityTimelineProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>('5m');
  const rangeMs = RANGE_MS[timeRange];

  // Periodic re-render to clean up expired dots
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5_000);
    return () => clearInterval(id);
  }, []);

  // Generation counter — increments on range change to force dot remount
  const generationRef = useRef(0);
  const prevRangeRef = useRef(rangeMs);
  if (prevRangeRef.current !== rangeMs) {
    prevRangeRef.current = rangeMs;
    generationRef.current++;
  }
  const generation = generationRef.current;

  // Build tick marks
  const ticks = useMemo(() => {
    const count = TICK_COUNTS[timeRange];
    const rangeSec = rangeMs / 1000;
    const stepSec = rangeSec / count;
    const result: { pct: number; label: string }[] = [];
    for (let i = 0; i <= count; i++) {
      const sec = i * stepSec;
      const pct = 100 - (sec / rangeSec) * 100;
      let label: string;
      if (i === 0) label = 'now';
      else if (sec < 60) label = `${sec}s`;
      else label = `${Math.round(sec / 60)}m`;
      result.push({ pct, label });
    }
    return result;
  }, [timeRange, rangeMs]);

  // Build flat events per agent
  const agentTimelineEvents = useMemo(() => {
    const map: Record<string, TimelineEvent[]> = {};
    for (const agent of agents) {
      map[agent.agentId] = (agentEvents[agent.agentId] || []).map((e) => ({
        ...e,
        agentId: agent.agentId,
      }));
    }
    return map;
  }, [agents, agentEvents]);

  // Agent color map
  const colorMap = useMemo(() => {
    const m = new Map<string, string>();
    agents.forEach((a, i) => m.set(a.agentId, AGENT_COLORS[i % AGENT_COLORS.length]));
    return m;
  }, [agents]);

  if (agents.length === 0) return null;

  return (
    <div className="border-b border-border bg-card">
      {/* Header with time range selector */}
      <div className="flex items-center justify-between border-b border-border/30 px-3 py-1">
        <span className="text-[10px] font-medium text-muted-foreground">Timeline</span>
        <div className="flex items-center gap-0.5">
          {(['1m', '5m', '10m', '60m'] as TimeRange[]).map((range) => (
            <button
              key={range}
              onClick={() => setTimeRange(range)}
              className={`rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors ${
                timeRange === range
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent'
              }`}
            >
              {range}
            </button>
          ))}
        </div>
      </div>

      {/* Tick labels row */}
      <div className="flex h-4 items-center">
        <div className="w-28 shrink-0" />
        <div className="relative flex-1">
          {ticks.map(({ pct, label }) => (
            <span
              key={label}
              className="absolute -translate-x-1/2 text-[7px] text-muted-foreground/50"
              style={{ left: `${pct}%` }}
            >
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* Agent lanes */}
      {agents.map((agent) => (
        <AgentLane
          key={agent.agentId}
          agent={agent}
          events={agentTimelineEvents[agent.agentId] || []}
          rangeMs={rangeMs}
          generation={generation}
          color={colorMap.get(agent.agentId) || 'text-muted-foreground'}
          ticks={ticks}
        />
      ))}
    </div>
  );
}
