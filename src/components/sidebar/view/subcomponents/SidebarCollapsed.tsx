import { Settings, Sparkles, PanelLeftOpen, Cpu, Eye, Clock } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { AppTab } from '../../../../types/app';

type SidebarCollapsedProps = {
  onExpand: () => void;
  onShowSettings: () => void;
  updateAvailable: boolean;
  onShowVersionModal: () => void;
  activeTab?: AppTab;
  onNavigate?: (tab: AppTab) => void;
  t: TFunction;
};

const NAV_ITEMS: { id: AppTab; icon: typeof Cpu; title: string }[] = [
  { id: 'agents', icon: Cpu, title: 'Agents' },
  { id: 'observability', icon: Eye, title: 'Observe' },
  { id: 'scheduler', icon: Clock, title: 'Scheduler' },
];

export default function SidebarCollapsed({
  onExpand,
  onShowSettings,
  updateAvailable,
  onShowVersionModal,
  activeTab,
  onNavigate,
  t,
}: SidebarCollapsedProps) {
  return (
    <div className="flex h-full w-12 flex-col items-center gap-1 bg-background/80 py-3 backdrop-blur-sm">
      {/* Expand button */}
      <button
        onClick={onExpand}
        className="group flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
        aria-label={t('common:versionUpdate.ariaLabels.showSidebar')}
        title={t('common:versionUpdate.ariaLabels.showSidebar')}
      >
        <PanelLeftOpen className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
      </button>

      <div className="flex-1" />

      {/* Conductor nav */}
      {NAV_ITEMS.map(({ id, icon: Icon, title }) => (
        <button
          key={id}
          onClick={() => onNavigate?.(id)}
          className={`group flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80 ${
            activeTab === id ? 'bg-accent' : ''
          }`}
          title={title}
        >
          <Icon className={`h-4 w-4 transition-colors group-hover:text-foreground ${
            activeTab === id ? 'text-foreground' : 'text-muted-foreground'
          }`} />
        </button>
      ))}

      <div className="nav-divider my-1 w-6" />

      {/* Settings */}
      <button
        onClick={onShowSettings}
        className="group flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
        aria-label={t('actions.settings')}
        title={t('actions.settings')}
      >
        <Settings className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
      </button>

      {/* Update indicator */}
      {updateAvailable && (
        <button
          onClick={onShowVersionModal}
          className="relative flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
          aria-label={t('common:versionUpdate.ariaLabels.updateAvailable')}
          title={t('common:versionUpdate.ariaLabels.updateAvailable')}
        >
          <Sparkles className="h-4 w-4 text-blue-500" />
          <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
        </button>
      )}
    </div>
  );
}
