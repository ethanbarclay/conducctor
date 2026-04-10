import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Folder, MessageSquare, Search, Cpu, Clock, GitBranch } from 'lucide-react';
import type { TFunction } from 'i18next';
import { ScrollArea } from '../../../../shared/view/ui';
import type { Project, ProjectSession } from '../../../../types/app';
import type { ReleaseInfo } from '../../../../types/sharedTypes';
import type { ConversationSearchResults, SearchProgress } from '../../hooks/useSidebarController';
import { getAllSessions, getSessionDate, getSessionName } from '../../utils/utils';
import { useConductorWebSocket } from '../../../orchestration/hooks/useConductorWebSocket';
import { api } from '../../../../utils/api';
import SidebarFooter from './SidebarFooter';
import SidebarHeader from './SidebarHeader';
import SidebarProjectList, { type SidebarProjectListProps } from './SidebarProjectList';

type AgentMeta = { agentId: string; role: string; status: string };

type ProvenanceOrigin = 'manual_agent' | 'scheduled' | 'mcp_spawn' | 'user_chat';

type Provenance = {
  origin: ProvenanceOrigin;
  role?: string | null;
  parentRole?: string | null;
  parentSessionId?: string | null;
  scheduledTaskName?: string | null;
};

type ProvenanceRow = {
  session_id: string;
  origin: ProvenanceOrigin;
  role: string | null;
  agent_id: string | null;
  parent_session_id: string | null;
  parent_agent_id: string | null;
  parent_role: string | null;
  scheduled_task_id: number | null;
  scheduled_task_name: string | null;
  project_id: string | null;
  created_at: number;
};

type FlatItem =
  | {
      kind: 'session';
      session: ProjectSession & { __provider?: string };
      projectName: string;
      projectDisplayName: string;
      agent?: AgentMeta;
      provenance?: Provenance;
    }
  | { kind: 'agent'; agentId: string; role: string; status: string; projectId: string; startedAt: number };

type SearchMode = 'projects' | 'conversations';

function HighlightedSnippet({ snippet, highlights }: { snippet: string; highlights: { start: number; end: number }[] }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const h of highlights) {
    if (h.start > cursor) {
      parts.push(snippet.slice(cursor, h.start));
    }
    parts.push(
      <mark key={h.start} className="rounded-sm bg-yellow-200 px-0.5 text-foreground dark:bg-yellow-800">
        {snippet.slice(h.start, h.end)}
      </mark>
    );
    cursor = h.end;
  }
  if (cursor < snippet.length) {
    parts.push(snippet.slice(cursor));
  }
  return (
    <span className="text-xs leading-relaxed text-muted-foreground">
      {parts}
    </span>
  );
}

type SidebarContentProps = {
  isPWA: boolean;
  isMobile: boolean;
  isLoading: boolean;
  projects: Project[];
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SearchMode;
  onSearchModeChange: (mode: SearchMode) => void;
  conversationResults: ConversationSearchResults | null;
  isSearching: boolean;
  searchProgress: SearchProgress | null;
  onConversationResultClick: (projectName: string, sessionId: string, provider: string, messageTimestamp?: string | null, messageSnippet?: string | null) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onCollapseSidebar: () => void;
  updateAvailable: boolean;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  activeTab?: import('../../../../types/app').AppTab;
  onNavigate?: (tab: import('../../../../types/app').AppTab) => void;
  projectListProps: SidebarProjectListProps;
  t: TFunction;
};

export default function SidebarContent({
  isPWA,
  isMobile,
  isLoading,
  projects,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  searchMode,
  onSearchModeChange,
  conversationResults,
  isSearching,
  searchProgress,
  onConversationResultClick,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onCollapseSidebar,
  updateAvailable,
  releaseInfo,
  latestVersion,
  onShowVersionModal,
  onShowSettings,
  activeTab,
  onNavigate,
  projectListProps,
  t,
}: SidebarContentProps) {
  const showConversationSearch = searchMode === 'conversations' && searchFilter.trim().length >= 2;
  const showFlatConversations = searchMode === 'conversations' && searchFilter.trim().length < 2;
  const hasPartialResults = conversationResults && conversationResults.results.length > 0;

  // Conductor agents for sidebar integration
  const { agents: conductorAgents } = useConductorWebSocket();

  // Persistent session provenance (origin, parent links, scheduled task names).
  // Fetched once on mount and refreshed whenever the conductor agent list
  // changes (a new spawn writes a new row).
  const [provenanceMap, setProvenanceMap] = useState<Map<string, Provenance>>(new Map());
  useEffect(() => {
    let cancelled = false;
    api.sessionProvenance()
      .then((r: Response) => (r.ok ? r.json() : { provenance: [] }))
      .then((data: { provenance?: ProvenanceRow[] }) => {
        if (cancelled) return;
        const next = new Map<string, Provenance>();
        for (const row of data.provenance || []) {
          next.set(row.session_id, {
            origin: row.origin,
            role: row.role,
            parentRole: row.parent_role,
            parentSessionId: row.parent_session_id,
            scheduledTaskName: row.scheduled_task_name,
          });
        }
        setProvenanceMap(next);
      })
      .catch(() => { /* ignore — sidebar still works without provenance */ });
    return () => { cancelled = true; };
  }, [conductorAgents.length]);

  // Flat recency-sorted sessions + conductor agents
  const flatItems = useMemo((): FlatItem[] => {
    if (!showFlatConversations) return [];
    const items: FlatItem[] = [];

    // Index conductor agents by sessionId so we can merge them into their
    // persisted session entry rather than showing a separate row.
    const agentBySessionId = new Map<string, typeof conductorAgents[number]>();
    for (const agent of conductorAgents) {
      if (agent.sessionId) agentBySessionId.set(agent.sessionId, agent);
    }
    const matchedSessionIds = new Set<string>();

    // Add sessions (decorated with agent + provenance metadata if available)
    for (const project of projects) {
      const sessions = getAllSessions(project, {});
      for (const session of sessions) {
        const matchedAgent = agentBySessionId.get(session.id);
        if (matchedAgent) matchedSessionIds.add(session.id);
        items.push({
          kind: 'session',
          session,
          projectName: project.name,
          projectDisplayName: project.displayName || project.name,
          agent: matchedAgent
            ? { agentId: matchedAgent.agentId, role: matchedAgent.role, status: matchedAgent.status }
            : undefined,
          provenance: provenanceMap.get(session.id),
        });
      }
    }

    // Only show standalone agent rows for agents whose session .jsonl
    // hasn't been persisted yet (e.g. just-spawned agents).
    for (const agent of conductorAgents) {
      if (agent.sessionId && matchedSessionIds.has(agent.sessionId)) continue;
      items.push({
        kind: 'agent',
        agentId: agent.agentId,
        role: agent.role,
        status: agent.status,
        projectId: agent.projectId || '',
        startedAt: agent.startedAt,
      });
    }

    // Sort by recency
    items.sort((a, b) => {
      const timeA = a.kind === 'session' ? getSessionDate(a.session).getTime() : a.startedAt;
      const timeB = b.kind === 'session' ? getSessionDate(b.session).getTime() : b.startedAt;
      return timeB - timeA;
    });

    return items.slice(0, 50);
  }, [showFlatConversations, projects, conductorAgents, provenanceMap]);

  return (
    <div
      className="flex h-full flex-col bg-background/80 backdrop-blur-sm md:w-72 md:select-none"
      style={{}}
    >
      <SidebarHeader
        isPWA={isPWA}
        isMobile={isMobile}
        isLoading={isLoading}
        projectsCount={projects.length}
        searchFilter={searchFilter}
        onSearchFilterChange={onSearchFilterChange}
        onClearSearchFilter={onClearSearchFilter}
        searchMode={searchMode}
        onSearchModeChange={onSearchModeChange}
        onRefresh={onRefresh}
        isRefreshing={isRefreshing}
        onCreateProject={onCreateProject}
        onCollapseSidebar={onCollapseSidebar}
        t={t}
      />

      <ScrollArea className="flex-1 overflow-y-auto overscroll-contain md:px-1.5 md:py-2">
        {showFlatConversations ? (
          flatItems.length === 0 ? (
            <div className="px-4 py-12 text-center md:py-8">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
                <MessageSquare className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">No conversations yet</h3>
              <p className="text-sm text-muted-foreground">Start a chat session or spawn an agent</p>
            </div>
          ) : (
            <div className="space-y-0.5 px-1">
              {flatItems.map((item) => {
                if (item.kind === 'agent') {
                  const now = new Date();
                  const diffMin = Math.floor((now.getTime() - item.startedAt) / 60000);
                  const timeLabel = diffMin < 1 ? 'now'
                    : diffMin < 60 ? `${diffMin}m ago`
                    : diffMin < 1440 ? `${Math.floor(diffMin / 60)}h ago`
                    : `${Math.floor(diffMin / 1440)}d ago`;
                  const isRunning = item.status === 'running';
                  const projectName = item.projectId ? item.projectId.split('/').pop() || item.projectId : '';

                  return (
                    <div
                      key={`agent-${item.agentId}`}
                      className="w-full rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent/50"
                    >
                      <div className="flex items-center gap-1.5">
                        {isRunning && (
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500 animate-pulse" />
                        )}
                        {!isRunning && item.status !== 'stopped' && (
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-gray-400" />
                        )}
                        <Cpu className="h-3 w-3 shrink-0 text-purple-400" />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground capitalize">
                          {item.role}
                        </span>
                        <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-medium ${
                          isRunning ? 'bg-blue-500/20 text-blue-400' :
                          item.status === 'idle' ? 'bg-muted text-muted-foreground' :
                          'bg-red-500/20 text-red-400'
                        }`}>
                          {item.status}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">{timeLabel}</span>
                      </div>
                      {projectName && (
                        <div className="mt-0.5 flex items-center gap-1 pl-0">
                          <Folder className="h-2.5 w-2.5 shrink-0 text-muted-foreground/50" />
                          <span className="truncate text-[10px] text-muted-foreground/70">{projectName}</span>
                        </div>
                      )}
                      <div className="mt-0.5 pl-0">
                        <span className="font-mono text-[9px] text-muted-foreground/40">{item.agentId.slice(0, 12)}</span>
                      </div>
                    </div>
                  );
                }

                // Regular session (possibly agent-backed)
                const { session, projectName, projectDisplayName, agent, provenance } = item;
                const sessionDate = getSessionDate(session);
                const now = new Date();
                const diffMin = Math.floor((now.getTime() - sessionDate.getTime()) / 60000);
                const timeLabel = diffMin < 1 ? 'now'
                  : diffMin < 60 ? `${diffMin}m ago`
                  : diffMin < 1440 ? `${Math.floor(diffMin / 60)}h ago`
                  : `${Math.floor(diffMin / 1440)}d ago`;
                const isActive = diffMin < 10;
                const agentRunning = agent?.status === 'running';

                // Pick the icon + label that best describes this conversation's origin.
                // Provenance (persistent) wins; live agent status is a secondary signal.
                let originIcon: ReactNode = null;
                let originBadge: ReactNode = null;
                let displayTitle: ReactNode = getSessionName(session, t);

                if (provenance?.origin === 'scheduled') {
                  originIcon = <Clock className="h-3 w-3 shrink-0 text-amber-400" />;
                  originBadge = (
                    <span className="shrink-0 rounded bg-amber-500/20 px-1 py-0.5 text-[9px] font-medium text-amber-400">
                      scheduled
                    </span>
                  );
                  if (provenance.scheduledTaskName) {
                    displayTitle = <span className="capitalize">{provenance.scheduledTaskName}</span>;
                  }
                } else if (provenance?.origin === 'mcp_spawn') {
                  originIcon = <GitBranch className="h-3 w-3 shrink-0 text-emerald-400" />;
                  originBadge = (
                    <span className="shrink-0 rounded bg-emerald-500/20 px-1 py-0.5 text-[9px] font-medium text-emerald-400">
                      sub-agent
                    </span>
                  );
                  if (provenance.role) {
                    displayTitle = <span className="capitalize">{provenance.role}</span>;
                  }
                } else if (provenance?.origin === 'manual_agent' || agent) {
                  originIcon = <Cpu className="h-3 w-3 shrink-0 text-purple-400" />;
                  originBadge = (
                    <span className="shrink-0 rounded bg-purple-500/20 px-1 py-0.5 text-[9px] font-medium text-purple-400">
                      agent
                    </span>
                  );
                  if (provenance?.role || agent?.role) {
                    displayTitle = <span className="capitalize">{provenance?.role || agent?.role}</span>;
                  }
                }

                return (
                  <button
                    key={`${projectName}-${session.id}`}
                    className="w-full rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent/50"
                    onClick={() => onConversationResultClick(
                      projectName,
                      session.id,
                      session.__provider || 'claude',
                      null,
                      null,
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      {agentRunning && (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500 animate-pulse" />
                      )}
                      {!agentRunning && !provenance && isActive && (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
                      )}
                      {originIcon}
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                        {displayTitle}
                      </span>
                      {session.__provider && session.__provider !== 'claude' && (
                        <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] uppercase text-muted-foreground">
                          {session.__provider}
                        </span>
                      )}
                      {originBadge}
                      <span className="shrink-0 text-[10px] text-muted-foreground">{timeLabel}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 pl-0">
                      <Folder className="h-2.5 w-2.5 shrink-0 text-muted-foreground/50" />
                      <span className="truncate text-[10px] text-muted-foreground/70">{projectDisplayName}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )
        ) : showConversationSearch ? (
          isSearching && !hasPartialResults ? (
            <div className="px-4 py-12 text-center md:py-8">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              </div>
              <p className="text-sm text-muted-foreground">{t('search.searching')}</p>
              {searchProgress && (
                <p className="mt-1 text-xs text-muted-foreground/60">
                  {t('search.projectsScanned', { count: searchProgress.scannedProjects })}/{searchProgress.totalProjects}
                </p>
              )}
            </div>
          ) : !isSearching && conversationResults && conversationResults.results.length === 0 ? (
            <div className="px-4 py-12 text-center md:py-8">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
                <Search className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">{t('search.noResults')}</h3>
              <p className="text-sm text-muted-foreground">{t('search.tryDifferentQuery')}</p>
            </div>
          ) : hasPartialResults ? (
            <div className="space-y-3 px-2">
              <div className="flex items-center justify-between px-1">
                <p className="text-xs text-muted-foreground">
                  {t('search.matches', { count: conversationResults.totalMatches })}
                </p>
                {isSearching && searchProgress && (
                  <div className="flex items-center gap-1.5">
                    <div className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-muted-foreground/40 border-t-primary" />
                    <p className="text-[10px] text-muted-foreground/60">
                      {searchProgress.scannedProjects}/{searchProgress.totalProjects}
                    </p>
                  </div>
                )}
              </div>
              {isSearching && searchProgress && (
                <div className="mx-1 h-0.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary/60 transition-all duration-300"
                    style={{ width: `${Math.round((searchProgress.scannedProjects / searchProgress.totalProjects) * 100)}%` }}
                  />
                </div>
              )}
              {conversationResults.results.map((projectResult) => (
                <div key={projectResult.projectName} className="space-y-1">
                  <div className="flex items-center gap-1.5 px-1 py-1">
                    <Folder className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                    <span className="truncate text-xs font-medium text-foreground">
                      {projectResult.projectDisplayName}
                    </span>
                  </div>
                  {projectResult.sessions.map((session) => (
                    <button
                      key={`${projectResult.projectName}-${session.sessionId}`}
                      className="w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/50"
                      onClick={() => onConversationResultClick(
                        projectResult.projectName,
                        session.sessionId,
                        session.provider || session.matches[0]?.provider || 'claude',
                        session.matches[0]?.timestamp,
                        session.matches[0]?.snippet
                      )}
                    >
                      <div className="mb-1 flex items-center gap-1.5">
                        <MessageSquare className="h-3 w-3 flex-shrink-0 text-primary" />
                        <span className="truncate text-xs font-medium text-foreground">
                          {session.sessionSummary}
                        </span>
                        {session.provider && session.provider !== 'claude' && (
                          <span className="flex-shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] uppercase text-muted-foreground">
                            {session.provider}
                          </span>
                        )}
                      </div>
                      <div className="space-y-1 pl-4">
                        {session.matches.map((match, idx) => (
                          <div key={idx} className="flex items-start gap-1">
                            <span className="mt-0.5 flex-shrink-0 text-[10px] font-medium uppercase text-muted-foreground/60">
                              {match.role === 'user' ? 'U' : 'A'}
                            </span>
                            <HighlightedSnippet
                              snippet={match.snippet}
                              highlights={match.highlights}
                            />
                          </div>
                        ))}
                      </div>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : null
        ) : (
          <SidebarProjectList {...projectListProps} />
        )}
      </ScrollArea>

      <SidebarFooter
        updateAvailable={updateAvailable}
        releaseInfo={releaseInfo}
        latestVersion={latestVersion}
        onShowVersionModal={onShowVersionModal}
        onShowSettings={onShowSettings}
        activeTab={activeTab}
        onNavigate={onNavigate}
        t={t}
      />
    </div>
  );
}
