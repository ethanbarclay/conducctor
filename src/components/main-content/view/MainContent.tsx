import React, { useEffect } from 'react';
import ChatInterface from '../../chat/view/ChatInterface';
import FileTree from '../../file-tree/view/FileTree';
import StandaloneShell from '../../standalone-shell/view/StandaloneShell';
import GitPanel from '../../git-panel/view/GitPanel';
import PluginTabContent from '../../plugins/view/PluginTabContent';
import type { MainContentProps } from '../types/types';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import EditorSidebar from '../../code-editor/view/EditorSidebar';
import type { Project } from '../../../types/app';
import { TaskMasterPanel } from '../../task-master';
import OrchestrationPanel from '../../orchestration/OrchestrationPanel';
import SchedulerPanel from '../../orchestration/SchedulerPanel';
import ObservabilityPanel from '../../orchestration/ObservabilityPanel';
import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';

type TaskMasterContextValue = {
  currentProject?: Project | null;
  setCurrentProject?: ((project: Project) => void) | null;
};

type TasksSettingsContextValue = {
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  isTaskMasterReady: boolean | null;
};

function MainContent({
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  latestMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  processingSessions,
  onReplaceTemporarySession,
  onNavigateToSession,
  onShowSettings,
  externalMessageUpdate,
}: MainContentProps) {
  const { preferences } = useUiPreferences();
  const { autoExpandTools, showRawParameters, showThinking, autoScrollToBottom, sendByCtrlEnter } = preferences;

  const { currentProject, setCurrentProject } = useTaskMaster() as TaskMasterContextValue;
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings() as TasksSettingsContextValue;

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });

  useEffect(() => {
    const selectedProjectName = selectedProject?.name;
    const currentProjectName = currentProject?.name;

    if (selectedProject && selectedProjectName !== currentProjectName) {
      setCurrentProject?.(selectedProject);
    }
  }, [selectedProject, currentProject?.name, setCurrentProject]);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  if (isLoading) {
    return <MainContentStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  return (
    <div className="flex h-full flex-col">
      <MainContentHeader
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        shouldShowTasksTab={shouldShowTasksTab}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''} flex-1`}>

          {/* Show empty state for project-dependent tabs when no project selected */}
          {!selectedProject && (activeTab === 'chat' || activeTab === 'shell' || activeTab === 'files' || activeTab === 'git' || activeTab === 'tasks') && (
            <MainContentStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />
          )}

          {selectedProject && (
            <div className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
              <ErrorBoundary showDetails>
                <ChatInterface
                  selectedProject={selectedProject}
                  selectedSession={selectedSession}
                  ws={ws}
                  sendMessage={sendMessage}
                  latestMessage={latestMessage}
                  onFileOpen={handleFileOpen}
                  onInputFocusChange={onInputFocusChange}
                  onSessionActive={onSessionActive}
                  onSessionInactive={onSessionInactive}
                  onSessionProcessing={onSessionProcessing}
                  onSessionNotProcessing={onSessionNotProcessing}
                  processingSessions={processingSessions}
                  onReplaceTemporarySession={onReplaceTemporarySession}
                  onNavigateToSession={onNavigateToSession}
                  onShowSettings={onShowSettings}
                  autoExpandTools={autoExpandTools}
                  showRawParameters={showRawParameters}
                  showThinking={showThinking}
                  autoScrollToBottom={autoScrollToBottom}
                  sendByCtrlEnter={sendByCtrlEnter}
                  externalMessageUpdate={externalMessageUpdate}
                  onShowAllTasks={tasksEnabled ? () => setActiveTab('tasks') : null}
                />
              </ErrorBoundary>
            </div>
          )}

          {selectedProject && activeTab === 'files' && (
            <div className="h-full overflow-hidden">
              <FileTree selectedProject={selectedProject} onFileOpen={handleFileOpen} />
            </div>
          )}

          {selectedProject && activeTab === 'shell' && (
            <div className="h-full w-full overflow-hidden">
              <StandaloneShell
                project={selectedProject}
                session={selectedSession}
                showHeader={false}
                isActive={activeTab === 'shell'}
              />
            </div>
          )}

          {selectedProject && activeTab === 'git' && (
            <div className="h-full overflow-hidden">
              <GitPanel selectedProject={selectedProject} isMobile={isMobile} onFileOpen={handleFileOpen} />
            </div>
          )}

          {selectedProject && shouldShowTasksTab && <TaskMasterPanel isVisible={activeTab === 'tasks'} />}

          {/* Global tabs — always available regardless of project selection */}
          <OrchestrationPanel isVisible={activeTab === 'agents'} />
          <ObservabilityPanel isVisible={activeTab === 'observability'} />
          <SchedulerPanel isVisible={activeTab === 'scheduler'} />

          <div className={`h-full overflow-hidden ${activeTab === 'preview' ? 'block' : 'hidden'}`} />

          {selectedProject && activeTab.startsWith('plugin:') && (
            <div className="h-full overflow-hidden">
              <PluginTabContent
                pluginName={activeTab.replace('plugin:', '')}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
              />
            </div>
          )}
        </div>

        {selectedProject && (
          <EditorSidebar
            editingFile={editingFile}
            isMobile={isMobile}
            editorExpanded={editorExpanded}
            editorWidth={editorWidth}
            hasManualWidth={hasManualWidth}
            resizeHandleRef={resizeHandleRef}
            onResizeStart={handleResizeStart}
            onCloseEditor={handleCloseEditor}
            onToggleEditorExpand={handleToggleEditorExpand}
            projectPath={selectedProject.path}
            fillSpace={activeTab === 'files'}
          />
        )}
      </div>
    </div>
  );
}

export default React.memo(MainContent);
