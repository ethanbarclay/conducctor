/**
 * SchedulerPanel
 *
 * CRUD interface for scheduled agent tasks.
 * Connects to /api/conductor/tasks endpoints.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';

interface ScheduledTask {
  id: number;
  name: string;
  cron_expression: string;
  prompt: string;
  project_id: string | null;
  agent_role: string;
  use_container: number;
  enabled: number;
  last_run: number | null;
  next_run: number | null;
  created_at: number;
}

interface TaskRun {
  id: number;
  task_id: number;
  agent_id: string | null;
  started_at: number;
  ended_at: number | null;
  status: string;
}

async function schedulerFetch(path: string, token: string, options: RequestInit = {}) {
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

export default function SchedulerPanel({ isVisible }: { isVisible: boolean }) {
  const { token } = useAuth();
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [runs, setRuns] = useState<Record<number, TaskRun[]>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: '',
    cron: '*/5 * * * *',
    prompt: '',
    projectId: '',
    role: 'scheduled',
    useContainer: true,
  });

  const loadTasks = useCallback(async () => {
    const data = await schedulerFetch('/tasks', token);
    setTasks(data.tasks || []);
  }, [token]);

  useEffect(() => {
    if (isVisible) loadTasks();
  }, [isVisible, loadTasks]);

  const handleCreate = useCallback(async () => {
    if (!form.name.trim() || !form.prompt.trim() || creating) return;
    setCreating(true);
    await schedulerFetch('/tasks', token, {
      method: 'POST',
      body: JSON.stringify(form),
    });
    setForm({ name: '', cron: '*/5 * * * *', prompt: '', projectId: '', role: 'scheduled', useContainer: true });
    setShowCreate(false);
    setCreating(false);
    loadTasks();
  }, [form, token, creating, loadTasks]);

  const handleDelete = useCallback(async (id: number) => {
    await schedulerFetch(`/tasks/${id}`, token, { method: 'DELETE' });
    loadTasks();
  }, [token, loadTasks]);

  const handleToggle = useCallback(async (id: number, enabled: boolean) => {
    await schedulerFetch(`/tasks/${id}/${enabled ? 'enable' : 'disable'}`, token, { method: 'POST' });
    loadTasks();
  }, [token, loadTasks]);

  const loadRuns = useCallback(async (taskId: number) => {
    const data = await schedulerFetch(`/tasks/${taskId}/runs?limit=10`, token);
    setRuns((prev) => ({ ...prev, [taskId]: data.runs || [] }));
  }, [token]);

  const formatTime = (ts: number | null) => {
    if (!ts) return '--';
    return new Date(ts * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className={`h-full flex flex-col overflow-hidden ${isVisible ? 'block' : 'hidden'}`}>
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card">
        <h2 className="text-sm font-semibold">Scheduled Tasks</h2>
        <button
          onClick={() => setShowCreate((p) => !p)}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90"
        >
          + New Task
        </button>
      </div>

      {showCreate && (
        <div className="border-b border-border bg-card p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              placeholder="Task name"
              className="text-xs px-3 py-2 bg-muted border border-border rounded-md outline-none focus:ring-1 focus:ring-primary"
              autoFocus
            />
            <input
              type="text"
              value={form.cron}
              onChange={(e) => setForm((p) => ({ ...p, cron: e.target.value }))}
              placeholder="Cron expression (e.g. */5 * * * *)"
              className="text-xs px-3 py-2 bg-muted border border-border rounded-md outline-none focus:ring-1 focus:ring-primary font-mono"
            />
            <input
              type="text"
              value={form.prompt}
              onChange={(e) => setForm((p) => ({ ...p, prompt: e.target.value }))}
              placeholder="Agent prompt"
              className="text-xs px-3 py-2 bg-muted border border-border rounded-md outline-none focus:ring-1 focus:ring-primary md:col-span-2"
            />
            <input
              type="text"
              value={form.role}
              onChange={(e) => setForm((p) => ({ ...p, role: e.target.value }))}
              placeholder="Role"
              className="text-xs px-3 py-2 bg-muted border border-border rounded-md outline-none focus:ring-1 focus:ring-primary"
            />
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.useContainer}
                  onChange={(e) => setForm((p) => ({ ...p, useContainer: e.target.checked }))}
                  className="h-3.5 w-3.5 rounded"
                />
                Container
              </label>
              <button
                onClick={() => setShowCreate(false)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !form.name.trim() || !form.prompt.trim()}
                className="ml-auto text-xs px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creating ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <p className="text-sm">No scheduled tasks</p>
            <p className="mt-1 text-xs">Create a task to run agents on a schedule</p>
          </div>
        ) : (
          tasks.map((task) => (
            <div key={task.id} className="rounded-lg border border-border bg-card p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{task.name}</div>
                  <div className="text-[10px] text-muted-foreground font-mono">{task.cron_expression}</div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => handleToggle(task.id, !task.enabled)}
                    className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                      task.enabled
                        ? 'bg-green-500/20 text-green-400'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {task.enabled ? 'enabled' : 'disabled'}
                  </button>
                </div>
              </div>

              <p className="text-xs text-muted-foreground truncate">{task.prompt}</p>

              <div className="flex gap-3 text-[10px] text-muted-foreground">
                <span>Role: {task.agent_role}</span>
                <span>Last: {formatTime(task.last_run)}</span>
                <span className="ml-auto flex gap-1">
                  <button
                    onClick={() => loadRuns(task.id)}
                    className="hover:text-foreground underline"
                  >
                    History
                  </button>
                  <span>|</span>
                  <button
                    onClick={() => handleDelete(task.id)}
                    className="text-red-400 hover:text-red-300"
                  >
                    Delete
                  </button>
                </span>
              </div>

              {runs[task.id] && (
                <div className="mt-1 space-y-0.5 border-t border-border/50 pt-1">
                  {runs[task.id].length === 0 ? (
                    <p className="text-[10px] text-muted-foreground">No runs yet</p>
                  ) : (
                    runs[task.id].map((run) => (
                      <div key={run.id} className="flex gap-2 text-[10px] text-muted-foreground">
                        <span className={`font-medium ${
                          run.status === 'success' ? 'text-green-400' :
                          run.status === 'failed' ? 'text-red-400' :
                          run.status === 'running' ? 'text-blue-400' :
                          'text-muted-foreground'
                        }`}>{run.status}</span>
                        <span>{formatTime(run.started_at)}</span>
                        {run.agent_id && <span className="font-mono">{run.agent_id.slice(0, 8)}</span>}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
