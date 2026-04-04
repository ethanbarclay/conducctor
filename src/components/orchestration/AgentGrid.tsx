/**
 * AgentGrid
 *
 * Top-level multi-agent dashboard. Shows all running CC agent instances
 * with live status, context usage, role, and quick actions.
 */

import { useState } from 'react'

interface Agent {
  agentId: string
  role: string
  projectId: string
  sessionId?: string
  startedAt: number
  tokenUsage: { input: number; output: number }
  status: 'running' | 'thinking' | 'idle' | 'compacting' | 'stopped'
  contextPct: number
}

interface AgentGridProps {
  agents: Agent[]
  onCompact: (agentId: string) => void
  onFork: (agentId: string) => void
  onCheckpoint: (agentId: string) => void
  onKill: (agentId: string) => void
  onSendMessage: (agentId: string, message: string) => void
  onSpawnAgent: () => void
}

function ContextMeter({ pct }: { pct: number }) {
  const color =
    pct >= 0.8 ? 'bg-red-500' :
    pct >= 0.6 ? 'bg-yellow-500' :
    'bg-green-500'

  return (
    <div className="w-full">
      <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
        <span>Context</span>
        <span>{Math.round(pct * 100)}%</span>
      </div>
      <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${pct * 100}%` }}
        />
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: Agent['status'] }) {
  const styles: Record<Agent['status'], string> = {
    running:    'bg-blue-500/20 text-blue-400',
    thinking:   'bg-purple-500/20 text-purple-400 animate-pulse',
    idle:       'bg-muted text-muted-foreground',
    compacting: 'bg-yellow-500/20 text-yellow-400',
    stopped:    'bg-red-500/20 text-red-400',
  }
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${styles[status]}`}>
      {status}
    </span>
  )
}

export function AgentGrid({
  agents,
  onCompact,
  onFork,
  onCheckpoint,
  onKill,
  onSendMessage,
  onSpawnAgent,
}: AgentGridProps) {
  const [messageInputs, setMessageInputs] = useState<Record<string, string>>({})

  const handleSend = (agentId: string) => {
    const msg = messageInputs[agentId]
    if (!msg?.trim()) return
    onSendMessage(agentId, msg)
    setMessageInputs((prev) => ({ ...prev, [agentId]: '' }))
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Agents
          <span className="ml-2 text-xs text-muted-foreground font-normal">
            {agents.filter(a => a.status !== 'stopped').length} active
          </span>
        </h2>
        <button
          onClick={onSpawnAgent}
          className="text-xs px-3 py-1.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
        >
          + Spawn Agent
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {agents.map((agent) => (
          <div
            key={agent.agentId}
            className="border border-border rounded-lg p-3 space-y-3 bg-card"
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate capitalize">{agent.role}</div>
                <div className="text-[10px] text-muted-foreground font-mono truncate">
                  {agent.agentId.slice(0, 12)}…
                </div>
              </div>
              <StatusBadge status={agent.status} />
            </div>

            {/* Context meter */}
            <ContextMeter pct={agent.contextPct} />

            {/* Token stats */}
            <div className="flex gap-3 text-[10px] text-muted-foreground">
              <span>↑ {(agent.tokenUsage.input / 1000).toFixed(1)}k</span>
              <span>↓ {(agent.tokenUsage.output / 1000).toFixed(1)}k</span>
              <span className="ml-auto">
                {new Date(agent.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>

            {/* Message input */}
            <div className="flex gap-1.5">
              <input
                type="text"
                value={messageInputs[agent.agentId] || ''}
                onChange={(e) =>
                  setMessageInputs((prev) => ({ ...prev, [agent.agentId]: e.target.value }))
                }
                onKeyDown={(e) => e.key === 'Enter' && handleSend(agent.agentId)}
                placeholder="Send message…"
                className="flex-1 text-xs px-2 py-1 bg-muted border border-border rounded-md outline-none focus:ring-1 focus:ring-primary min-w-0"
              />
              <button
                onClick={() => handleSend(agent.agentId)}
                className="text-xs px-2 py-1 bg-muted hover:bg-accent border border-border rounded-md transition-colors"
              >
                →
              </button>
            </div>

            {/* Actions */}
            <div className="flex gap-1 flex-wrap">
              <button
                onClick={() => onCompact(agent.agentId)}
                className="text-[10px] px-2 py-1 bg-muted hover:bg-accent border border-border rounded transition-colors"
                title="Compact context"
              >
                Compact
              </button>
              <button
                onClick={() => onFork(agent.agentId)}
                className="text-[10px] px-2 py-1 bg-muted hover:bg-accent border border-border rounded transition-colors"
                title="Fork this session"
              >
                Fork
              </button>
              <button
                onClick={() => onCheckpoint(agent.agentId)}
                className="text-[10px] px-2 py-1 bg-muted hover:bg-accent border border-border rounded transition-colors"
                title="Save checkpoint"
              >
                Checkpoint
              </button>
              <button
                onClick={() => onKill(agent.agentId)}
                className="text-[10px] px-2 py-1 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded transition-colors ml-auto"
                title="Kill agent"
              >
                Kill
              </button>
            </div>
          </div>
        ))}

        {agents.length === 0 && (
          <div className="col-span-full flex flex-col items-center justify-center py-12 text-muted-foreground">
            <p className="text-sm">No agents running</p>
            <p className="text-xs mt-1">Spawn an agent to get started</p>
          </div>
        )}
      </div>
    </div>
  )
}
