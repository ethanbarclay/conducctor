/**
 * MessageBus
 *
 * Live feed of inter-agent messages routed through the MCP broker.
 * Shows from/to agent, content, and timestamp.
 */

interface AgentMessage {
  id: number
  from_agent: string
  to_agent: string
  content: string
  read: boolean
  created_at: number
}

interface MessageBusProps {
  messages: AgentMessage[]
  agentRoles: Record<string, string> // agentId → role label
}

export function MessageBus({ messages, agentRoles }: MessageBusProps) {
  const label = (id: string) => agentRoles[id] || id.slice(0, 8)

  return (
    <div className="border-t border-border">
      <div className="flex items-center justify-between px-3 py-1 border-b border-border/50">
        <span className="text-xs text-muted-foreground font-medium">Message Bus</span>
        <span className="text-[10px] text-muted-foreground">{messages.length} messages</span>
      </div>

      <div className="overflow-y-auto max-h-40">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-10 text-xs text-muted-foreground">
            No inter-agent messages yet
          </div>
        ) : (
          [...messages].reverse().map((msg) => (
            <div
              key={msg.id}
              className="flex items-start gap-2 px-3 py-1.5 border-b border-border/30 hover:bg-accent/30 text-xs"
            >
              <span className="text-muted-foreground tabular-nums shrink-0 text-[10px] pt-0.5">
                {new Date(msg.created_at * 1000).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </span>
              <span className="shrink-0 font-medium text-blue-400">{label(msg.from_agent)}</span>
              <span className="text-muted-foreground shrink-0">→</span>
              <span className="shrink-0 font-medium text-green-400">{label(msg.to_agent)}</span>
              <span className="text-muted-foreground truncate flex-1">{msg.content}</span>
              {!msg.read && (
                <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-blue-400 mt-1.5" />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
