/**
 * OrchestrationPanel
 *
 * Main view for the multi-agent orchestration dashboard.
 * Connects to /conductor-ws, renders AgentGrid + MessageBus,
 * and wires up all agent lifecycle actions to the REST API.
 */

import { useCallback, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { AgentGrid } from './AgentGrid';
import { MessageBus } from './MessageBus';
import { useConductorWebSocket } from './hooks/useConductorWebSocket';

interface SpawnDialogState {
  open: boolean;
  prompt: string;
  role: string;
  projectPath: string;
  useContainer: boolean;
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

export default function OrchestrationPanel({ isVisible }: { isVisible: boolean }) {
  const { token } = useAuth();
  const { agents, messages, isConnected } = useConductorWebSocket();

  const [spawnDialog, setSpawnDialog] = useState<SpawnDialogState>({
    open: false,
    prompt: '',
    role: 'agent',
    projectPath: '',
    useContainer: true,
  });

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
    setSpawnDialog((prev) => ({ ...prev, open: true }));
  }, []);

  const handleSpawnSubmit = useCallback(async () => {
    if (!spawnDialog.prompt.trim()) return;
    await conductorFetch('/agents', token, {
      method: 'POST',
      body: JSON.stringify({
        prompt: spawnDialog.prompt,
        projectPath: spawnDialog.projectPath || undefined,
        role: spawnDialog.role,
        useContainer: spawnDialog.useContainer,
      }),
    });
    setSpawnDialog({ open: false, prompt: '', role: 'agent', projectPath: '', useContainer: true });
  }, [spawnDialog, token]);

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
              onClick={() => setSpawnDialog((prev) => ({ ...prev, open: false }))}
              className="text-xs text-muted-foreground hover:text-foreground"
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
            />
            <input
              type="text"
              value={spawnDialog.role}
              onChange={(e) => setSpawnDialog((prev) => ({ ...prev, role: e.target.value }))}
              placeholder="Role (e.g. researcher, coder)"
              className="text-xs px-3 py-2 bg-muted border border-border rounded-md outline-none focus:ring-1 focus:ring-primary"
            />
            <input
              type="text"
              value={spawnDialog.projectPath}
              onChange={(e) => setSpawnDialog((prev) => ({ ...prev, projectPath: e.target.value }))}
              placeholder="Project path (optional)"
              className="text-xs px-3 py-2 bg-muted border border-border rounded-md outline-none focus:ring-1 focus:ring-primary"
            />
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={spawnDialog.useContainer}
                  onChange={(e) =>
                    setSpawnDialog((prev) => ({ ...prev, useContainer: e.target.checked }))
                  }
                  className="h-3.5 w-3.5 rounded border-gray-300"
                />
                Container isolation
              </label>
              <button
                onClick={handleSpawnSubmit}
                className="ml-auto text-xs px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
              >
                Spawn
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Agent grid */}
      <div className="flex-1 overflow-y-auto">
        <AgentGrid
          agents={agents}
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
