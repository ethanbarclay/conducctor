import { MessageSquare, Terminal, Folder, GitBranch, ClipboardCheck, Cpu, Clock, type LucideIcon } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip, PillBar, Pill } from '../../../../shared/view/ui';
import type { AppTab } from '../../../../types/app';
import { usePlugins } from '../../../../contexts/PluginsContext';
import PluginIcon from '../../../plugins/view/PluginIcon';

type MainContentTabSwitcherProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  shouldShowTasksTab: boolean;
  hasProject: boolean;
};

type BuiltInTab = {
  kind: 'builtin';
  id: AppTab;
  labelKey: string;
  icon: LucideIcon;
  requiresProject?: boolean;
};

type PluginTab = {
  kind: 'plugin';
  id: AppTab;
  label: string;
  pluginName: string;
  iconFile: string;
  requiresProject?: boolean;
};

type TabDefinition = BuiltInTab | PluginTab;

const PROJECT_TABS: BuiltInTab[] = [
  { kind: 'builtin', id: 'chat',  labelKey: 'tabs.chat',  icon: MessageSquare, requiresProject: true },
  { kind: 'builtin', id: 'shell', labelKey: 'tabs.shell', icon: Terminal, requiresProject: true },
  { kind: 'builtin', id: 'files', labelKey: 'tabs.files', icon: Folder, requiresProject: true },
  { kind: 'builtin', id: 'git',   labelKey: 'tabs.git',   icon: GitBranch, requiresProject: true },
];

const GLOBAL_TABS: BuiltInTab[] = [
  { kind: 'builtin', id: 'agents',    labelKey: 'tabs.agents',    icon: Cpu },
  { kind: 'builtin', id: 'scheduler', labelKey: 'tabs.scheduler', icon: Clock },
];

const TASKS_TAB: BuiltInTab = {
  kind: 'builtin',
  id: 'tasks',
  labelKey: 'tabs.tasks',
  icon: ClipboardCheck,
  requiresProject: true,
};

export default function MainContentTabSwitcher({
  activeTab,
  setActiveTab,
  shouldShowTasksTab,
  hasProject,
}: MainContentTabSwitcherProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();

  const builtInTabs: BuiltInTab[] = [
    ...PROJECT_TABS,
    ...GLOBAL_TABS,
    ...(shouldShowTasksTab ? [TASKS_TAB] : []),
  ];

  const pluginTabs: PluginTab[] = plugins
    .filter((p) => p.enabled)
    .map((p) => ({
      kind: 'plugin',
      id: `plugin:${p.name}` as AppTab,
      label: p.displayName,
      pluginName: p.name,
      iconFile: p.icon,
      requiresProject: true,
    }));

  const tabs: TabDefinition[] = [...builtInTabs, ...pluginTabs];

  return (
    <PillBar>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        const isDisabled = !hasProject && tab.requiresProject;
        const displayLabel = tab.kind === 'builtin' ? t(tab.labelKey) : tab.label;

        return (
          <Tooltip key={tab.id} content={isDisabled ? `${displayLabel} (select a project)` : displayLabel} position="bottom">
            <Pill
              isActive={isActive}
              onClick={() => !isDisabled && setActiveTab(tab.id)}
              className={`px-2.5 py-[5px] ${isDisabled ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              {tab.kind === 'builtin' ? (
                <tab.icon className="h-3.5 w-3.5" strokeWidth={isActive ? 2.2 : 1.8} />
              ) : (
                <PluginIcon
                  pluginName={tab.pluginName}
                  iconFile={tab.iconFile}
                  className="flex h-3.5 w-3.5 items-center justify-center [&>svg]:h-full [&>svg]:w-full"
                />
              )}
              <span className="hidden lg:inline">{displayLabel}</span>
            </Pill>
          </Tooltip>
        );
      })}
    </PillBar>
  );
}
