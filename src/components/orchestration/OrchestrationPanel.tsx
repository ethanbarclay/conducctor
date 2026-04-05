/**
 * OrchestrationPanel
 *
 * Main view for the multi-agent orchestration dashboard.
 * Connects to /conductor-ws, renders AgentGrid + MessageBus,
 * and wires up all agent lifecycle actions to the REST API.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { AgentGrid } from './AgentGrid';
import { MessageBus } from './MessageBus';
import { useConductorWebSocket } from './hooks/useConductorWebSocket';

interface SpawnDialogState {
  open: boolean;
  prompt: string;
  role: string;
  projectPath: string;
  provider: string;
  model: string;
  permissionMode: string;
  useContainer: boolean;
  spawning: boolean;
}

async function conductorFetch(path: string, token: string, options: RequestInit = {}) {
  const res = await fetch(`/api/conductor${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  return res.json();
}

interface ProjectOption {
  name: string;
  displayName: string;
  fullPath: string;
}

export default function OrchestrationPanel({ isVisible, selectedProjectPath = '' }: { isVisible: boolean; selectedProjectPath?: string }) {
  const { token } = useAuth();
  const { agents, messages, agentEvents, isConnected, addAgent } = useConductorWebSocket();

  // Fetch projects for the dropdown
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  useEffect(() => {
    if (!isVisible || !token) return;
    fetch('/api/projects', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => {
        const list = (data.projects || data || []) as Array<{ name: string; displayName?: string; fullPath?: string; path?: string }>;
        setProjects(list.map(p => ({
          name: p.name,
          displayName: p.displayName || p.name,
          fullPath: p.fullPath || p.path || '',
        })));
      })
      .catch(() => {});
  }, [isVisible, token]);

  const [spawnDialog, setSpawnDialog] = useState<SpawnDialogState>({
    open: false,
    prompt: '',
    role: 'agent',
    projectPath: '',
    provider: 'claude',
    model: 'sonnet',
    permissionMode: 'bypassPermissions',
    useContainer: true,
    spawning: false,
  });

  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());

  const agentRoles = agents.reduce<Record<string, string>>((acc, a) => {
    acc[a.agentId] = a.role;
    return acc;
  }, {});

  const handleCompact = useCallback(
    (agentId: string) => {
      conductorFetch(`/agents/${agentId}/compact`, token, { method: 'POST' });
    },
    [token],
  );

  const handleFork = useCallback(
    (agentId: string) => {
      conductorFetch(`/agents/${agentId}/fork`, token, { method: 'POST' });
    },
    [token],
  );

  const handleCheckpoint = useCallback(
    (agentId: string) => {
      conductorFetch(`/agents/${agentId}/checkpoint`, token, {
        method: 'POST',
        body: JSON.stringify({ label: `manual-${Date.now()}` }),
      });
    },
    [token],
  );

  const handleKill = useCallback(
    (agentId: string) => {
      conductorFetch(`/agents/${agentId}`, token, { method: 'DELETE' });
    },
    [token],
  );

  const handleSendMessage = useCallback(
    (agentId: string, message: string) => {
      conductorFetch(`/agents/${agentId}/input`, token, {
        method: 'POST',
        body: JSON.stringify({ message }),
      });
    },
    [token],
  );

  const handleSpawnAgent = useCallback(() => {
    setSpawnDialog((prev) => ({ ...prev, open: true, projectPath: prev.projectPath || selectedProjectPath }));
  }, [selectedProjectPath]);

  const handleSpawnSubmit = useCallback(async () => {
    if (!spawnDialog.prompt.trim() || !spawnDialog.projectPath.trim() || spawnDialog.spawning) return;
    setSpawnDialog((prev) => ({ ...prev, spawning: true }));
    try {
      const result = await conductorFetch('/agents', token, {
        method: 'POST',
        body: JSON.stringify({
          prompt: spawnDialog.prompt,
          projectPath: spawnDialog.projectPath || undefined,
          role: spawnDialog.role,
          provider: spawnDialog.provider,
          model: spawnDialog.model,
          permissionMode: spawnDialog.permissionMode,
          useContainer: spawnDialog.useContainer,
        }),
      });
      // Immediately add to grid without waiting for WebSocket
      if (result.agentId) {
        addAgent({
          agentId: result.agentId,
          role: spawnDialog.role,
          projectId: spawnDialog.projectPath || '',
          startedAt: Date.now(),
          tokenUsage: { input: 0, output: 0 },
          status: 'running',
          contextPct: 0,
        });
      }
      setSpawnDialog({
        open: false,
        prompt: '',
        role: 'agent',
        projectPath: '',
        useContainer: true,
        spawning: false,
      });
    } catch {
      setSpawnDialog((prev) => ({ ...prev, spawning: false }));
    }
  }, [spawnDialog, token]);

  const toggleAgentExpanded = useCallback((agentId: string) => {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }, []);

  return (
    <div className={`h-full flex flex-col overflow-hidden ${isVisible ? 'block' : 'hidden'}`}>
      {/* Connection status bar */}
      <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border bg-card">
        <span
          className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`}
        />
        <span className="text-xs text-muted-foreground">
          {isConnected ? 'Connected' : 'Reconnecting...'}
        </span>
        <span className="text-xs text-muted-foreground ml-auto">
          {agents.filter((a) => a.status !== 'stopped').length} active agents
        </span>
      </div>

      {/* Spawn dialog */}
      {spawnDialog.open && (
        <div className="border-b border-border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Spawn New Agent</span>
            <button
              onClick={() => setSpawnDialog((prev) => ({ ...prev, open: false, spawning: false }))}
              className="text-xs text-muted-foreground hover:text-foreground"
              disabled={spawnDialog.spawning}
            >
              Cancel
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <input
              type="text"
              value={spawnDialog.prompt}
              onChange={(e) => setSpawnDialog((prev) => ({ ...prev, prompt: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && handleSpawnSubmit()}
              placeholder="Initial prompt..."
              className="text-xs px-3 py-2 bg-muted border border-border rounded-md outline-none focus:ring-1 focus:ring-primary"
              autoFocus
              disabled={spawnDialog.spawning}
            />
            <input
              type="text"
              value={spawnDialog.role}
              onChange={(e) => setSpawnDialog((prev) => ({ ...prev, role: e.target.value }))}
              placeholder="Role (e.g. researcher, coder)"
              className="text-xs px-3 py-2 bg-muted border border-border rounded-md outline-none focus:ring-1 focus:ring-primary"
              disabled={spawnDialog.spawning}
            />
            <select
              value={spawnDialog.projectPath}
              onChange={(e) => setSpawnDialog((prev) => ({ ...prev, projectPath: e.target.value }))}
              className={`text-xs px-3 py-2 bg-muted border rounded-md outline-none focus:ring-1 focus:ring-primary ${
                !spawnDialog.projectPath.trim() ? 'border-red-500/50' : 'border-border'
              }`}
              disabled={spawnDialog.spawning}
            >
              <option value="">Select workspace...</option>
              {projects.map((p) => (
                <option key={p.name} value={p.fullPath}>
                  {p.displayName} — {p.fullPath}
                </option>
              ))}
            </select>
            <select
              value={spawnDialog.provider}
              onChange={(e) => setSpawnDialog((prev) => ({ ...prev, provider: e.target.value }))}
              className="text-xs px-3 py-2 bg-muted border border-border rounded-md outline-none focus:ring-1 focus:ring-primary"
              disabled={spawnDialog.spawning}
            >
              <option value="claude">Claude Code</option>
              <option value="gemini">Gemini CLI</option>
            </select>
            <select
              value={spawnDialog.model}
              onChange={(e) => setSpawnDialog((prev) => ({ ...prev, model: e.target.value }))}
              className="text-xs px-3 py-2 bg-muted border border-border rounded-md outline-none focus:ring-1 focus:ring-primary"
              disabled={spawnDialog.spawning}
            >
              {spawnDialog.provider === 'gemini' ? (
                <>
                  <option value="">Auto</option>
                  <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                  <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                </>
              ) : (
                <>
                  <option value="sonnet">Sonnet (fast)</option>
                  <option value="opus">Opus (powerful)</option>
                  <option value="haiku">Haiku (cheap)</option>
                </>
              )}
            </select>
            <select
              value={spawnDialog.permissionMode}
              onChange={(e) => setSpawnDialog((prev) => ({ ...prev, permissionMode: e.target.value }))}
              className="text-xs px-3 py-2 bg-muted border border-border rounded-md outline-none focus:ring-1 focus:ring-primary"
              disabled={spawnDialog.spawning}
            >
              <option value="bypassPermissions">Bypass Permissions</option>
              <option value="default">Default (ask)</option>
              <option value="plan">Plan Mode</option>
              <option value="auto">Auto</option>
            </select>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={spawnDialog.useContainer}
                  onChange={(e) =>
                    setSpawnDialog((prev) => ({ ...prev, useContainer: e.target.checked }))
                  }
                  className="h-3.5 w-3.5 rounded border-gray-300"
                  disabled={spawnDialog.spawning}
                />
                Container isolation
              </label>
              <button
                onClick={handleSpawnSubmit}
                disabled={spawnDialog.spawning || !spawnDialog.prompt.trim() || !spawnDialog.projectPath.trim()}
                className="ml-auto text-xs px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {spawnDialog.spawning && (
                  <div className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-primary-foreground/40 border-t-primary-foreground" />
                )}
                {spawnDialog.spawning ? 'Spawning...' : 'Spawn'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Agent grid with activity */}
      <div className="flex-1 overflow-y-auto">
        <AgentGrid
          agents={agents}
          agentEvents={agentEvents}
          expandedAgents={expandedAgents}
          onToggleExpanded={toggleAgentExpanded}
          onCompact={handleCompact}
          onFork={handleFork}
          onCheckpoint={handleCheckpoint}
          onKill={handleKill}
          onSendMessage={handleSendMessage}
          onSpawnAgent={handleSpawnAgent}
        />
      </div>

      {/* Message bus */}
      <MessageBus messages={messages} agentRoles={agentRoles} />
    </div>
  );
}
