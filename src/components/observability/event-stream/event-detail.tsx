import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Copy, Check, ChevronDown, ChevronRight, Loader } from 'lucide-react'
import { api } from '@/lib/api-client'
import { getEventIcon } from '@/config/event-icons'
import { getEventSummary } from '@/lib/event-summary'
import { cn } from '@/lib/utils'
import { getAgentDisplayName } from '@/lib/agent-utils'
import type { ParsedEvent, Agent } from '@/types'
import type { SpawnInfo } from './event-row'

interface EventDetailProps {
  event: ParsedEvent
  agentMap: Map<string, Agent>
  spawnInfo?: SpawnInfo
}

const THREAD_SUBTYPES = ['UserPromptSubmit', 'Stop', 'SubagentStart', 'SubagentStop']

export function EventDetail({ event, agentMap, spawnInfo }: EventDetailProps) {
  const [copied, setCopied] = useState(false)
  const [showPayload, setShowPayload] = useState(false)
  const [thread, setThread] = useState<ParsedEvent[] | null>(null)
  const [loadingThread, setLoadingThread] = useState(false)

  const showThread = THREAD_SUBTYPES.includes(event.subtype || '')

  useEffect(() => {
    if (!showThread) return
    setLoadingThread(true)
    api
      .getThread(event.id)
      .then(setThread)
      .catch(() => setThread(null))
      .finally(() => setLoadingThread(false))
  }, [event.id, showThread])

  const payloadStr = JSON.stringify(event.payload, null, 2)

  const handleCopy = () => {
    navigator.clipboard.writeText(payloadStr)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const p = event.payload as Record<string, any>
  const cwd = p.cwd as string | undefined

  return (
    <div className="px-4 py-2 bg-muted/30 border-t border-border text-xs space-y-2">
      {/* Per-event-type rich detail */}
      <ToolDetail event={event} payload={p} cwd={cwd} thread={thread} agentMap={agentMap} spawnInfo={spawnInfo} />

      {/* Conversation thread for UserPrompt / Stop / SubagentStop events */}
      {showThread && (
        <div>
          <div className="text-muted-foreground mb-1.5 font-medium">Conversation thread:</div>
          {loadingThread && <div className="text-muted-foreground/80 dark:text-muted-foreground/60 py-2">Loading thread...</div>}
          {thread && thread.length > 0 && (
            <div className="space-y-0.5 rounded border border-border/50 bg-muted/20 p-1.5">
              {dedupeThread(thread).map((e) => (
                <ThreadEvent key={e.id} event={e} isCurrentEvent={e.id === event.id} />
              ))}
            </div>
          )}
          {thread && thread.length === 0 && (
            <div className="text-muted-foreground/80 dark:text-muted-foreground/60 py-1">No thread events found</div>
          )}
        </div>
      )}

      {/* Collapsible raw payload */}
      <div>
        <div
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          onClick={() => setShowPayload(!showPayload)}
          role="button"
          tabIndex={0}
        >
          {showPayload ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <span>Raw payload</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 ml-1"
            onClick={(e) => {
              e.stopPropagation()
              handleCopy()
            }}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </Button>
        </div>
        {showPayload && (
          <pre className="overflow-x-auto rounded bg-muted/50 p-2 font-mono text-[10px] leading-relaxed mt-1">
            {payloadStr}
          </pre>
        )}
      </div>
    </div>
  )
}

// ── Rich per-tool detail ──────────────────────────────────────

function ToolDetail({
  event,
  payload,
  cwd,
  thread,
  agentMap,
  spawnInfo,
}: {
  event: ParsedEvent
  payload: Record<string, any>
  cwd?: string
  thread?: ParsedEvent[] | null
  agentMap: Map<string, Agent>
  spawnInfo?: SpawnInfo
}) {
  const ti = payload.tool_input || {}
  const result = extractResult(payload.tool_response)

  // For non-tool events, show basic info
  if (event.subtype === 'UserPromptSubmit') {
    // Find the Stop event in the thread to get the final assistant message
    const stopEvent = thread?.find((e) => e.subtype === 'Stop' || e.subtype === 'stop_hook_summary')
    const finalMessage = (stopEvent?.payload as any)?.last_assistant_message
    return (
      <div className="space-y-1.5">
        <DetailCode label="Prompt" value={payload.prompt} />
        {finalMessage && <DetailCode label="Result" value={stripMarkdown(finalMessage)} />}
      </div>
    )
  }

  if (event.subtype === 'Stop') {
    // Find the prompt from the thread (if loaded) or payload
    const promptFromThread = thread?.find((e) => e.subtype === 'UserPromptSubmit')
    const promptText = promptFromThread
      ? (promptFromThread.payload as any)?.prompt ||
        (promptFromThread.payload as any)?.message?.content
      : null

    return (
      <div className="space-y-1.5">
        {promptText && <DetailCode label="Prompt" value={promptText} />}
        {payload.last_assistant_message && (
          <DetailCode label="Final" value={stripMarkdown(payload.last_assistant_message)} />
        )}
      </div>
    )
  }

  if (event.subtype === 'SubagentStop') {
    const agentResult = payload.last_assistant_message
    const subAgent = agentMap.get(event.agentId)
    const assignedName = subAgent ? getAgentDisplayName(subAgent) : null
    const rawName = payload.agent_name as string | undefined
    return (
      <div className="space-y-1.5">
        <AgentIdentity assignedName={assignedName} rawName={rawName} agentId={event.agentId} />
        {spawnInfo?.description && <DetailRow label="Task" value={spawnInfo.description} />}
        {spawnInfo?.prompt && <DetailCode label="Prompt" value={spawnInfo.prompt} />}
        {agentResult && <DetailCode label="Result" value={stripMarkdown(agentResult)} />}
      </div>
    )
  }

  if (event.subtype === 'SessionStart') {
    return (
      <div className="space-y-1">
        <DetailRow label="Source" value={payload.source || 'new'} />
        {cwd && <DetailRow label="Working dir" value={cwd} />}
        {payload.version && <DetailRow label="Version" value={payload.version} />}
        {payload.permissionMode && <DetailRow label="Permissions" value={payload.permissionMode} />}
      </div>
    )
  }

  if (event.subtype === 'SessionEnd') {
    return (
      <div className="space-y-1">
        <DetailRow label="Status" value="Session ended" />
      </div>
    )
  }

  if (event.subtype === 'StopFailure') {
    return (
      <div className="space-y-1">
        <DetailRow label="Error type" value={payload.error_type || 'unknown'} />
        {payload.error_message && <DetailCode label="Error" value={payload.error_message} />}
      </div>
    )
  }

  if (event.subtype === 'SubagentStart') {
    const subAgent = agentMap.get(event.agentId)
    const assignedName = subAgent ? getAgentDisplayName(subAgent) : null
    const rawName = payload.agent_name as string | undefined
    return (
      <div className="space-y-1.5">
        <AgentIdentity assignedName={assignedName} rawName={rawName} agentId={event.agentId} />
        {(spawnInfo?.description || payload.description) && (
          <DetailRow label="Task" value={spawnInfo?.description || payload.description} />
        )}
        {spawnInfo?.prompt && <DetailCode label="Prompt" value={spawnInfo.prompt} />}
      </div>
    )
  }

  if (event.subtype === 'PostToolUseFailure') {
    const ti = payload.tool_input || {}
    return (
      <div className="space-y-1.5">
        {event.toolName && <DetailRow label="Tool" value={event.toolName} />}
        {ti.command && <DetailCode label="Command" value={ti.command} />}
        {payload.error && <DetailCode label="Error" value={typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error, null, 2)} />}
      </div>
    )
  }

  if (event.subtype === 'PermissionRequest') {
    return (
      <div className="space-y-1">
        {payload.tool_name && <DetailRow label="Tool" value={payload.tool_name as string} />}
        {payload.description && <DetailRow label="Description" value={payload.description as string} />}
      </div>
    )
  }

  if (event.subtype === 'TaskCreated' || event.subtype === 'TaskCompleted') {
    return (
      <div className="space-y-1">
        {payload.description && <DetailRow label="Task" value={payload.description as string} />}
        {payload.task_description && <DetailRow label="Task" value={payload.task_description as string} />}
        {payload.status && <DetailRow label="Status" value={payload.status as string} />}
      </div>
    )
  }

  if (event.subtype === 'TeammateIdle') {
    return (
      <div className="space-y-1">
        {payload.teammate_name && <DetailRow label="Teammate" value={payload.teammate_name as string} />}
      </div>
    )
  }

  if (event.subtype === 'InstructionsLoaded') {
    return (
      <div className="space-y-1">
        {payload.file_path && <DetailRow label="File" value={relPath(payload.file_path as string, cwd)} />}
      </div>
    )
  }

  if (event.subtype === 'ConfigChange') {
    return (
      <div className="space-y-1">
        {payload.file_path && <DetailRow label="File" value={relPath(payload.file_path as string, cwd)} />}
      </div>
    )
  }

  if (event.subtype === 'CwdChanged') {
    return (
      <div className="space-y-1">
        {payload.old_cwd && <DetailRow label="From" value={payload.old_cwd as string} />}
        <DetailRow label="To" value={(payload.new_cwd || payload.cwd || '') as string} />
      </div>
    )
  }

  if (event.subtype === 'FileChanged') {
    return (
      <div className="space-y-1">
        {payload.file_path && <DetailRow label="File" value={relPath(payload.file_path as string, cwd)} />}
      </div>
    )
  }

  if (event.subtype === 'PreCompact' || event.subtype === 'PostCompact') {
    return (
      <div className="space-y-1">
        <DetailRow label="Status" value={event.subtype === 'PreCompact' ? 'Compacting...' : 'Compacted'} />
        {payload.tokens_before && <DetailRow label="Tokens before" value={String(payload.tokens_before)} />}
        {payload.tokens_after && <DetailRow label="Tokens after" value={String(payload.tokens_after)} />}
      </div>
    )
  }

  if (event.subtype === 'Elicitation') {
    return (
      <div className="space-y-1.5">
        {payload.message && <DetailCode label="Question" value={payload.message as string} />}
        {payload.question && <DetailCode label="Question" value={payload.question as string} />}
      </div>
    )
  }

  if (event.subtype === 'ElicitationResult') {
    return (
      <div className="space-y-1.5">
        {payload.response && <DetailCode label="Response" value={payload.response as string} />}
        {payload.result && <DetailCode label="Result" value={payload.result as string} />}
      </div>
    )
  }

  if (event.subtype === 'WorktreeCreate' || event.subtype === 'WorktreeRemove') {
    return (
      <div className="space-y-1">
        {payload.path && <DetailRow label="Path" value={payload.path as string} />}
        {payload.branch && <DetailRow label="Branch" value={payload.branch as string} />}
      </div>
    )
  }

  // Tool events
  if (event.subtype !== 'PreToolUse' && event.subtype !== 'PostToolUse') return null

  switch (event.toolName) {
    case 'Bash':
      return (
        <div className="space-y-1.5">
          {ti.command && <DetailCode label="Command" value={ti.command} />}
          {result && <DetailCode label="Result" value={formatResult(result)} />}
        </div>
      )
    case 'Read':
      return (
        <div className="space-y-1.5">
          <DetailRow label="File" value={relPath(ti.file_path, cwd)} />
          {ti.offset && (
            <DetailRow
              label="Range"
              value={`line ${ti.offset}${ti.limit ? `, limit ${ti.limit}` : ''}`}
            />
          )}
          {result && <DetailCode label="Content" value={formatResult(result)} />}
        </div>
      )
    case 'Write':
      return (
        <div className="space-y-1.5">
          <DetailRow label="File" value={relPath(ti.file_path, cwd)} />
          {result && <DetailCode label="Result" value={formatResult(result)} />}
        </div>
      )
    case 'Edit':
      return (
        <div className="space-y-1.5">
          <DetailRow label="File" value={relPath(ti.file_path, cwd)} />
          {ti.old_string && <DetailCode label="Old" value={ti.old_string} />}
          {ti.new_string && <DetailCode label="New" value={ti.new_string} />}
          {result && <DetailCode label="Result" value={formatResult(result)} />}
        </div>
      )
    case 'Grep':
      return (
        <div className="space-y-1.5">
          <DetailRow label="Pattern" value={`/${ti.pattern}/`} />
          {ti.path && <DetailRow label="Path" value={relPath(ti.path, cwd)} />}
          {ti.glob && <DetailRow label="Glob" value={ti.glob} />}
          {result && <DetailCode label="Result" value={formatResult(result)} />}
        </div>
      )
    case 'Glob':
      return (
        <div className="space-y-1.5">
          <DetailRow label="Pattern" value={ti.pattern} />
          {ti.path && <DetailRow label="Path" value={relPath(ti.path, cwd)} />}
          {result && <DetailCode label="Result" value={formatResult(result)} />}
        </div>
      )
    case 'Agent': {
      const spawnedAgentId = payload.tool_response?.agentId as string | undefined
      const spawnedAgent = spawnedAgentId ? agentMap.get(spawnedAgentId) : undefined
      const agentAssignedName = spawnedAgent ? getAgentDisplayName(spawnedAgent) : null
      const agentRawName = ti.name as string | undefined
      return (
        <div className="space-y-1.5">
          <AgentIdentity assignedName={agentAssignedName} rawName={agentRawName} agentId={spawnedAgentId} />
          {ti.description && <DetailRow label="Task" value={ti.description} />}
          {ti.prompt && <DetailCode label="Prompt" value={ti.prompt} />}
        </div>
      )
    }
    default:
      return (
        <div className="space-y-1.5">
          {ti.description && <DetailRow label="Description" value={ti.description} />}
          {result && <DetailCode label="Result" value={formatResult(result)} />}
        </div>
      )
  }
}

// ── Helper components ──────────────────────────────────────

function AgentIdentity({
  assignedName,
  rawName,
  agentId,
}: {
  assignedName?: string | null
  rawName?: string | null
  agentId?: string | null
}) {
  const displayName = assignedName || rawName || null
  const showRawName = rawName && assignedName && rawName !== assignedName
  const showId = agentId && agentId !== displayName

  return (
    <>
      {displayName && (
        <div className="flex gap-2">
          <span className="text-muted-foreground shrink-0 w-20 text-right">Agent:</span>
          <span className="truncate">
            {displayName}
            {showRawName && (
              <span className="text-muted-foreground/80 dark:text-muted-foreground/60 ml-1.5">({rawName})</span>
            )}
          </span>
        </div>
      )}
      {showId && (
        <div className="flex gap-2">
          <span className="text-muted-foreground shrink-0 w-20 text-right">Agent ID:</span>
          <span className="truncate font-mono text-muted-foreground/80 dark:text-muted-foreground/60">{agentId}</span>
        </div>
      )}
    </>
  )
}

function DetailRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground shrink-0 w-20 text-right">{label}:</span>
      <span className="truncate">{value}</span>
    </div>
  )
}

function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*(.*?)\*\*/g, '$1') // **bold** → bold
    .replace(/`([^`]+)`/g, '$1') // `code` → code
    .replace(/^[-*] /gm, '• ') // list items
    .trim()
}

function DetailCode({ label, value }: { label: string; value?: string }) {
  if (!value) return null
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground shrink-0 w-20 text-right">{label}:</span>
      <pre className="overflow-x-auto rounded bg-muted/50 p-1.5 font-mono text-[10px] leading-relaxed max-h-40 overflow-y-auto flex-1 min-w-0">
        {value}
      </pre>
    </div>
  )
}

// Extract a display string from tool_response, handling different formats:
// - Bash: { stdout, stderr }
// - MCP tools: [{ type: 'text', text: '...' }]
// - String: direct text
function extractResult(toolResponse: any): string | null {
  if (!toolResponse) return null
  if (typeof toolResponse === 'string') return toolResponse

  // Bash format: { stdout, stderr }
  if (toolResponse.stdout !== undefined) {
    const parts = []
    if (toolResponse.stdout) parts.push(toolResponse.stdout)
    if (toolResponse.stderr) parts.push(`stderr: ${toolResponse.stderr}`)
    return parts.join('\n') || null
  }

  // MCP format: array of content blocks [{ type: 'text', text: '...' }]
  if (Array.isArray(toolResponse)) {
    const text = toolResponse
      .map((r: any) => {
        if (typeof r === 'string') return r
        if (r?.type === 'text' && r?.text) return r.text
        return JSON.stringify(r)
      })
      .join('\n')
    return text || null
  }

  // Agent/structured format: { content: [{type:'text', text:'...'}], status, ... }
  if (Array.isArray(toolResponse.content)) {
    const text = toolResponse.content
      .map((r: any) => (r?.type === 'text' && r?.text ? r.text : ''))
      .filter(Boolean)
      .join('\n')
    if (text) return text
  }

  // Plain content string
  if (typeof toolResponse.content === 'string') return toolResponse.content

  return JSON.stringify(toolResponse, null, 2)
}

function formatResult(result: any): string {
  if (typeof result === 'string') return result
  return JSON.stringify(result, null, 2)
}

function relPath(fp: string | undefined, cwd: string | undefined): string {
  if (!fp) return ''
  if (cwd && fp.startsWith(cwd)) {
    const rel = fp.slice(cwd.length)
    return rel.startsWith('/') ? rel.slice(1) : rel
  }
  return fp
}

// ── Thread deduplication ──────────────────────────────────

// Merge PostToolUse into PreToolUse by toolUseId (same as main stream).
// Only show PreToolUse if there's no matching PostToolUse (failed tool).
function dedupeThread(events: ParsedEvent[]): ParsedEvent[] {
  const result: ParsedEvent[] = []
  const toolUseMap = new Map<string, number>()

  for (const e of events) {
    if (e.subtype === 'PreToolUse' && e.toolUseId) {
      toolUseMap.set(e.toolUseId, result.length)
      result.push({ ...e })
    } else if (e.subtype === 'PostToolUse' && e.toolUseId && toolUseMap.has(e.toolUseId)) {
      const idx = toolUseMap.get(e.toolUseId)!
      result[idx] = { ...result[idx], status: 'completed' }
    } else {
      result.push(e)
    }
  }
  return result
}

// ── Thread event (for conversation view) ──────────────────

const LABEL_MAP: Record<string, string> = {
  UserPromptSubmit: 'Prompt',
  PreToolUse: 'Tool',
  PostToolUse: 'Tool',
  PostToolUseFailure: 'ToolErr',
  stop_hook_summary: 'Stop',
  StopFailure: 'Error',
  SubagentStart: 'SubStart',
  SubagentStop: 'SubStop',
  SessionStart: 'Session',
  SessionEnd: 'Session',
}

function ThreadEvent({ event, isCurrentEvent }: { event: ParsedEvent; isCurrentEvent: boolean }) {
  const Icon = getEventIcon(event.subtype, event.toolName)
  const isTool = event.subtype === 'PreToolUse' || event.subtype === 'PostToolUse'
  const isCompleted = event.status === 'completed'
  const rawLabel = event.subtype || event.type
  const displayLabel = LABEL_MAP[rawLabel] || rawLabel
  const summary = getEventSummary(event)

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-2 py-0.5 rounded text-[11px]',
        isCurrentEvent ? 'bg-primary/10 font-medium' : 'text-muted-foreground',
      )}
    >
      <span className="shrink-0 text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="w-14 shrink-0 truncate">{displayLabel}</span>
      {isTool && (
        <span
          className={cn(
            'shrink-0',
            isCompleted ? 'text-green-600 dark:text-green-500' : 'text-yellow-600 dark:text-yellow-500/70',
          )}
        >
          {isCompleted ? <Check className="h-3 w-3" /> : <Loader className="h-3 w-3" />}
        </span>
      )}
      {isTool && event.toolName && (
        <span className="text-xs font-medium text-blue-700 dark:text-blue-400 shrink-0">{event.toolName}</span>
      )}
      <span className="truncate flex-1 text-[10px]">{summary}</span>
      <span className="text-[9px] text-muted-foreground/70 dark:text-muted-foreground/50 tabular-nums shrink-0">
        {new Date(event.timestamp).toLocaleTimeString('en-US', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })}
      </span>
    </div>
  )
}
