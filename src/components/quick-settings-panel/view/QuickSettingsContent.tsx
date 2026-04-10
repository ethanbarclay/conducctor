import { useCallback, useState } from 'react';
import { Moon, Sun, Shield, ShieldOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DarkModeToggle } from '../../../shared/view/ui';
import LanguageSelector from '../../../shared/view/ui/LanguageSelector';
import {
  INPUT_SETTING_TOGGLES,
  SETTING_ROW_CLASS,
  TOOL_DISPLAY_TOGGLES,
  VIEW_OPTION_TOGGLES,
} from '../constants';
import type {
  PreferenceToggleItem,
  PreferenceToggleKey,
  QuickSettingsPreferences,
} from '../types';
import { getClaudeSettings, CLAUDE_SETTINGS_KEY, safeLocalStorage } from '../../chat/utils/chatStorage';
import QuickSettingsSection from './QuickSettingsSection';
import QuickSettingsToggleRow from './QuickSettingsToggleRow';

type QuickSettingsContentProps = {
  isDarkMode: boolean;
  preferences: QuickSettingsPreferences;
  onPreferenceChange: (key: PreferenceToggleKey, value: boolean) => void;
};

export default function QuickSettingsContent({
  isDarkMode,
  preferences,
  onPreferenceChange,
}: QuickSettingsContentProps) {
  const { t } = useTranslation('settings');

  // Container isolation toggle (stored in claude-settings, not UI preferences)
  const [containerIsolation, setContainerIsolation] = useState(() => {
    const settings = getClaudeSettings();
    return settings.containerIsolation !== false;
  });

  const handleContainerToggle = useCallback((enabled: boolean) => {
    setContainerIsolation(enabled);
    const settings = getClaudeSettings();
    settings.containerIsolation = enabled;
    safeLocalStorage.setItem(CLAUDE_SETTINGS_KEY, JSON.stringify(settings));
  }, []);

  const renderToggleRows = (items: PreferenceToggleItem[]) => (
    items.map(({ key, labelKey, icon }) => (
      <QuickSettingsToggleRow
        key={key}
        label={t(labelKey)}
        icon={icon}
        checked={preferences[key]}
        onCheckedChange={(value) => onPreferenceChange(key, value)}
      />
    ))
  );

  return (
    <div className="flex-1 space-y-6 overflow-y-auto overflow-x-hidden bg-background p-4">
      <QuickSettingsSection title={t('quickSettings.sections.appearance')}>
        <div className={SETTING_ROW_CLASS}>
          <span className="flex items-center gap-2 text-sm text-gray-900 dark:text-white">
            {isDarkMode ? (
              <Moon className="h-4 w-4 text-gray-600 dark:text-gray-400" />
            ) : (
              <Sun className="h-4 w-4 text-gray-600 dark:text-gray-400" />
            )}
            {t('quickSettings.darkMode')}
          </span>
          <DarkModeToggle />
        </div>
        <LanguageSelector compact />
      </QuickSettingsSection>

      <QuickSettingsSection title={t('quickSettings.sections.toolDisplay')}>
        {renderToggleRows(TOOL_DISPLAY_TOGGLES)}
      </QuickSettingsSection>

      <QuickSettingsSection title={t('quickSettings.sections.viewOptions')}>
        {renderToggleRows(VIEW_OPTION_TOGGLES)}
      </QuickSettingsSection>

      <QuickSettingsSection title={t('quickSettings.sections.inputSettings')}>
        {renderToggleRows(INPUT_SETTING_TOGGLES)}
        <p className="ml-3 text-xs text-gray-500 dark:text-gray-400">
          {t('quickSettings.sendByCtrlEnterDescription')}
        </p>
      </QuickSettingsSection>

      <QuickSettingsSection title="Agent Isolation">
        <label className={`${SETTING_ROW_CLASS} cursor-pointer ${!containerIsolation ? 'border-red-500 dark:border-red-500 bg-red-50 dark:bg-red-950' : 'border-green-500/30 dark:border-green-500/30'}`}>
          <span className="flex items-center gap-2 text-sm text-gray-900 dark:text-white">
            {containerIsolation ? (
              <Shield className="h-4 w-4 text-green-600 dark:text-green-400" />
            ) : (
              <ShieldOff className="h-4 w-4 text-red-600 dark:text-red-400" />
            )}
            Container Isolation
          </span>
          <input
            type="checkbox"
            checked={containerIsolation}
            onChange={(event) => handleContainerToggle(event.target.checked)}
            className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 dark:text-blue-500 focus:ring-blue-500 focus:ring-2 bg-gray-100 dark:bg-gray-800 checked:bg-blue-600 dark:checked:bg-blue-600"
          />
        </label>
        {!containerIsolation && (
          <div className="rounded-lg border border-red-500 bg-red-50 dark:bg-red-950/50 p-3">
            <p className="text-xs font-semibold text-red-700 dark:text-red-400">
              DANGER: Agents run directly on host
            </p>
            <p className="mt-1 text-xs text-red-600 dark:text-red-400/80">
              Full access to filesystem, processes, and credentials. Enable container isolation for safe execution.
            </p>
          </div>
        )}
        {containerIsolation && (
          <p className="ml-3 text-xs text-green-600 dark:text-green-400/80">
            Agents run in isolated Docker containers with limited resources.
          </p>
        )}
      </QuickSettingsSection>
    </div>
  );
}
