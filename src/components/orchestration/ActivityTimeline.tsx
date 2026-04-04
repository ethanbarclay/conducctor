/**
 * ActivityTimeline
 *
 * Horizontal scrolling timeline with per-event-type lanes and CSS-driven
 * drifting event dots. Each agent gets a group of lanes (thinking, text,
 * tool, result). Dots are larger and show rich hover details.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
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

const EVENT_LANES = [
  { type: 'thinking', label: 'Think', color: 'bg-purple-500', dotBorder: 'ring-purple-400/40' },
  { type: 'text', label: 'Text', color: 'bg-blue-500', dotBorder: 'ring-blue-400/40' },
  { type: 'tool_use', label: 'Tool', color: 'bg-yellow-500', dotBorder: 'ring-yellow-400/40' },
  { type: 'tool_result', label: 'Result', color: 'bg-green-500', dotBorder: 'ring-green-400/40' },
  { type: 'error', label: 'Error', color: 'bg-red-500', dotBorder: 'ring-red-400/40' },
] as const;

const AGENT_COLORS = [
  'text-blue-400', 'text-green-400', 'text-purple-400', 'text-yellow-400',
  'text-pink-400', 'text-cyan-400', 'text-orange-400', 'text-red-400',
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
}

// ─── Hover tooltip ──────────────────────────────────────────────────────────

function DotTooltip({ event, style }: { event: TimelineEvent; style: React.CSSProperties }) {
  const time = new Date(event.timestamp).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const lane = EVENT_LANES.find((l) => l.type === event.type);

  return (
    <div
      className="pointer-events-none absolute z-50 w-72 rounded-lg border border-border bg-popover p-3 shadow-xl"
      style={style}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${lane?.color || 'bg-gray-500'}`} />
        <span className="text-xs font-semibold text-foreground">{lane?.label || event.type}</span>
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">{time}</span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground break-words">
        {event.content.length > 300 ? event.content.slice(0, 300) + '...' : event.content}
      </p>
    </div>
  );
}

// ─── Drifting Dot ───────────────────────────────────────────────────────────

function DriftingDot({
  event,
  rangeMs,
  generation,
  onHover,
  onLeave,
}: {
  event: TimelineEvent;
  rangeMs: number;
  generation: number;
  onHover: (event: TimelineEvent, rect: DOMRect) => void;
  onLeave: () => void;
}) {
  const age = Date.now() - event.timestamp;
  const position = 100 - (age / rangeMs) * 100;
  if (position < -10 || position > 100) return null;

  const remainingMs = Math.max(0, rangeMs - age);
  const lane = EVENT_LANES.find((l) => l.type === event.type);
  const color = lane?.color || 'bg-gray-400';
  const ring = lane?.dotBorder || 'ring-gray-400/40';

  return (
    <button
      className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 transition-transform hover:scale-[1.6] ${ring} ring-2 rounded-full`}
      style={{ left: `${position}%` }}
      ref={(el) => {
        if (!el) return;
        requestAnimationFrame(() => {
          el.style.transition = `left ${remainingMs}ms linear`;
          el.style.left = '-5%';
        });
      }}
      onMouseEnter={(e) => onHover(event, e.currentTarget.getBoundingClientRect())}
      onMouseLeave={onLeave}
    >
      <span className={`flex h-4 w-4 items-center justify-center rounded-full ${color} shadow-md`}>
        <span className="h-1.5 w-1.5 rounded-full bg-white/90" />
      </span>
    </button>
  );
}

// ─── Type Lane ──────────────────────────────────────────────────────────────

function TypeLane({
  laneConfig,
  events,
  rangeMs,
  generation,
  onHover,
  onLeave,
  isFirst,
}: {
  laneConfig: typeof EVENT_LANES[number];
  events: TimelineEvent[];
  rangeMs: number;
  generation: number;
  onHover: (event: TimelineEvent, rect: DOMRect) => void;
  onLeave: () => void;
  isFirst: boolean;
}) {
  const visibleEvents = useMemo(
    () => events.filter((e) => e.type === laneConfig.type && Date.now() - e.timestamp < rangeMs),
    [events, laneConfig.type, rangeMs],
  );

  return (
    <div className={`flex h-10 items-center ${isFirst ? '' : 'border-t border-border/10'}`}>
      {/* Lane label */}
      <div className="flex w-16 shrink-0 items-center gap-1.5 px-2">
        <span className={`h-1.5 w-1.5 rounded-full ${laneConfig.color}`} />
        <span className="text-[9px] text-muted-foreground/70">{laneConfig.label}</span>
      </div>

      {/* Dot area */}
      <div className="relative h-full flex-1 overflow-hidden">
        {visibleEvents.map((event) => (
          <DriftingDot
            key={`${event.id}-${generation}`}
            event={event}
            rangeMs={rangeMs}
            generation={generation}
            onHover={onHover}
            onLeave={onLeave}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Main Timeline ──────────────────────────────────────────────────────────

export default function ActivityTimeline({ agents, agentEvents }: ActivityTimelineProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>('5m');
  const rangeMs = RANGE_MS[timeRange];
  const containerRef = useRef<HTMLDivElement>(null);

  // Hover state
  const [hoveredEvent, setHoveredEvent] = useState<{ event: TimelineEvent; rect: DOMRect } | null>(null);

  const handleHover = (event: TimelineEvent, rect: DOMRect) => {
    setHoveredEvent({ event, rect });
  };
  const handleLeave = () => setHoveredEvent(null);

  // Periodic re-render to clean up expired dots
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5_000);
    return () => clearInterval(id);
  }, []);

  // Generation counter for range changes
  const generationRef = useRef(0);
  const prevRangeRef = useRef(rangeMs);
  if (prevRangeRef.current !== rangeMs) {
    prevRangeRef.current = rangeMs;
    generationRef.current++;
  }
  const generation = generationRef.current;

  // Tick marks
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

  // Flat events per agent
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

  const colorMap = useMemo(() => {
    const m = new Map<string, string>();
    agents.forEach((a, i) => m.set(a.agentId, AGENT_COLORS[i % AGENT_COLORS.length]));
    return m;
  }, [agents]);

  // Tooltip position relative to container
  const tooltipStyle = useMemo((): React.CSSProperties | null => {
    if (!hoveredEvent || !containerRef.current) return null;
    const containerRect = containerRef.current.getBoundingClientRect();
    const dotRect = hoveredEvent.rect;
    let left = dotRect.left - containerRect.left - 144; // center the 288px tooltip
    left = Math.max(4, Math.min(left, containerRect.width - 292));
    return {
      left,
      bottom: containerRect.bottom - dotRect.top + 8,
    };
  }, [hoveredEvent]);

  if (agents.length === 0) return null;

  return (
    <div className="relative border-b border-border bg-card" ref={containerRef}>
      {/* Header */}
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

      {/* Tick labels */}
      <div className="flex h-4 items-end">
        <div className="w-16 shrink-0" />
        <div className="relative flex-1">
          {ticks.map(({ pct, label }) => (
            <span
              key={label}
              className="absolute -translate-x-1/2 text-[7px] text-muted-foreground/40"
              style={{ left: `${pct}%` }}
            >
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* Agent groups */}
      {agents.map((agent, agentIdx) => {
        const color = colorMap.get(agent.agentId) || 'text-muted-foreground';
        const events = agentTimelineEvents[agent.agentId] || [];

        return (
          <div key={agent.agentId} className={agentIdx > 0 ? 'border-t border-border/30' : ''}>
            {/* Agent header */}
            <div className="flex h-6 items-center border-b border-border/15 bg-muted/20 px-2">
              <span className={`text-[10px] font-semibold ${color}`}>
                {agent.role}
              </span>
              <span className="ml-1 text-[9px] text-muted-foreground/50">
                ({agent.agentId.slice(0, 8)})
              </span>
              <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[8px] font-medium ${
                agent.status === 'running' ? 'bg-blue-500/20 text-blue-400' :
                agent.status === 'idle' ? 'bg-muted text-muted-foreground' :
                'bg-red-500/20 text-red-400'
              }`}>
                {agent.status}
              </span>
            </div>

            {/* Type lanes */}
            {EVENT_LANES.map((lane, laneIdx) => (
              <TypeLane
                key={lane.type}
                laneConfig={lane}
                events={events}
                rangeMs={rangeMs}
                generation={generation}
                onHover={handleHover}
                onLeave={handleLeave}
                isFirst={laneIdx === 0}
              />
            ))}

            {/* Tick gridlines (overlaid on lanes) */}
            <div className="pointer-events-none absolute right-0 top-0 bottom-0" style={{ left: '64px' }}>
              {ticks.map(({ pct, label }) => (
                <div
                  key={`grid-${agent.agentId}-${label}`}
                  className="absolute top-0 bottom-0"
                  style={{ left: `${pct}%` }}
                >
                  <div className="h-full w-px border-l border-border/10" />
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {/* Hover tooltip */}
      {hoveredEvent && tooltipStyle && (
        <DotTooltip event={hoveredEvent.event} style={tooltipStyle} />
      )}
    </div>
  );
}
