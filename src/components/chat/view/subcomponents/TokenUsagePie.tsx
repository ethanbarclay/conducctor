import { useCallback, useRef, useState } from 'react';
import { Zap, GitFork, Save, type LucideIcon } from 'lucide-react';
import { useAuth } from '../../../../contexts/AuthContext';

type TokenUsagePieProps = {
  used: number;
  total: number;
  sessionId?: string | null;
};

export default function TokenUsagePie({ used, total, sessionId }: TokenUsagePieProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { token } = useAuth();

  const handleAction = useCallback(async (action: 'compact' | 'fork' | 'checkpoint') => {
    if (!sessionId || !token) return;
    setActionStatus(action);
    try {
      const agentsRes = await fetch('/api/conductor/agents', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const { agents } = await agentsRes.json();
      const agent = agents?.find((a: { sessionId?: string; agentId?: string }) =>
        a.sessionId === sessionId || a.agentId === sessionId
      );
      if (agent) {
        await fetch(`/api/conductor/agents/${agent.agentId}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(action === 'checkpoint' ? { label: `manual-${Date.now()}` } : {}),
        });
      }
    } catch (err) {
      console.error(`Context action ${action} failed:`, err);
    }
    setActionStatus(null);
    setMenuOpen(false);
  }, [sessionId, token]);

  if (used == null || total == null || total <= 0) return null;

  const percentage = Math.min(100, (used / total) * 100);
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;

  const getColor = () => {
    if (percentage < 50) return '#3b82f6';
    if (percentage < 75) return '#f59e0b';
    return '#ef4444';
  };

  const actions = [
    { id: 'compact' as const, label: 'Compact', desc: 'Summarize and free context', Icon: Zap },
    { id: 'fork' as const, label: 'Fork', desc: 'Branch this session', Icon: GitFork },
    { id: 'checkpoint' as const, label: 'Checkpoint', desc: 'Save session snapshot', Icon: Save },
  ];

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setMenuOpen((p) => !p)}
        className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-xs text-gray-600 transition-colors hover:bg-accent/60 dark:text-gray-400"
        title={`${used.toLocaleString()} / ${total.toLocaleString()} tokens — click for context actions`}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" className="-rotate-90 transform">
          <circle cx="12" cy="12" r={radius} fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-300 dark:text-gray-600" />
          <circle cx="12" cy="12" r={radius} fill="none" stroke={getColor()} strokeWidth="2" strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round" />
        </svg>
        <span>{percentage.toFixed(1)}%</span>
      </button>

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
          <div className="absolute bottom-full right-0 z-50 mb-2 w-52 overflow-hidden rounded-lg border border-border bg-card shadow-xl">
            <div className="border-b border-border/50 px-3 py-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Context</div>
              <div className="mt-0.5 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className={`h-full rounded-full transition-all`} style={{ width: `${percentage}%`, backgroundColor: getColor() }} />
                </div>
                <span className="text-[10px] tabular-nums text-muted-foreground">{percentage.toFixed(0)}%</span>
              </div>
            </div>
            {sessionId && (
              <div className="py-1">
                {actions.map((action) => (
                  <button
                    key={action.id}
                    onClick={() => handleAction(action.id)}
                    disabled={!!actionStatus}
                    className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent/60 disabled:opacity-50"
                  >
                    <action.Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-foreground">
                        {actionStatus === action.id ? `${action.label}...` : action.label}
                      </div>
                      <div className="text-[10px] text-muted-foreground">{action.desc}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
