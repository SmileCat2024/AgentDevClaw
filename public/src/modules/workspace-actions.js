/**
 * workspace-actions.js — 工作区操作分发
 * 从 app-main.js 拆出（S+A3）
 * 拆出日期：2026-07-13
 *
 * 包含 runWorkspaceAction 巨型函数（原 app-main.js L1193–L1810），
 * 处理所有 workspace action.type 分支：
 *   会话操作: open_latest_session, open_session, create_session,
 *             delete_session, unarchive_session, view_session_record
 *   精简/摘要: compacted_resume_session, compact_session_menu,
 *             open_summary, generate_summary
 *   工作区操作: navigate_unit, prime_workspace_form,
 *              apply_workspace_bundle, launch_assembly_instance
 *   制品/文档预览: open_artifact_preview, close_artifact_preview,
 *                 open_project_docset_preview, close_project_docset_preview
 *   视图切换: show_chat, resume_session, show_home,
 *            show_workspace_tab, show_block
 *
 * 依赖全局状态（定义在 app-core.js）:
 *   currentLanguage, allAgents, currentRuntimeAgentId,
 *   _navigationGuardEpoch, prebuiltSessionSwitchInFlight,
 *   shouldAnimateWorkspaceSurface, currentWorkspaceArtifactDetail,
 *   currentWorkspaceDocsetDetail, readOnlyMode, currentMessages,
 *   currentInputRequests, lastRenderedInputSignature,
 *   lastRenderedWorkspaceHtml
 * 依赖全局函数:
 *   bumpNavigationGuard, t, escapeHtml, invoke (app-core.js)
 *   getCurrentAgentRecord, hasWorkspaceSessions, getWorkspaceSessions,
 *   getWorkspaceSessionById, requestSwitch, loadAgents,
 *   markSessionLoading, clearSessionLoading, markActionLoading,
 *   beginChatLoadingSession, clearChatLoadingSession,
 *   beginFollowLatestCooldown, beginFollowLatestEntryWindow,
 *   normalizeAgentIdentity, saveCurrentRuntimeToCache,
 *   getRuntimeContextKey, _storeVisibleSessionInputDraft,
 *   openPrebuiltWorkspaceSession, applyOptimisticWorkspaceSession,
 *   upsertConnectedAgent, waitForPrebuiltRuntimeSession,
 *   createCompactedResumeSession, applyManagedPrebuiltAgent,
 *   getWorkspaceFormDraft, saveWorkspaceFormDraft,
 *   normalizeWorkspaceStartupDraft, setPreferredUnitMode,
 *   getFeatureCreatorProjects, getAgentCreatorProjects,
 *   isAssemblySession, isAssemblySessionRunning,
 *   maybeWarnAssemblySessionDrift, markSessionArchivedForMutation,
 *   updateSessionReplacementMutation, settleSessionReplacementMutation,
 *   clearSessionReplacementMutation, clearAgentRuntimeCache,
 *   refreshSidebarRuntimeAfterMutation, ctxArchiveSession,
 *   getAgentWorkspaceState, getIMWorkspaceDraft, ensureIMWorkspaceLoaded (app-main.js / app-ui.js)
 *   renderCurrentMainView, updateAgentRecord (app-ui.js)
 *   ClawToast (modules/toast-notify.js)
 * window 函数:
 *   handlePrebuiltAgentClick, applyWorkspaceBundle, launchAssemblyInstance,
 *   openTrimDialog, openSummaryPopup, confirm
 * HTML onclick 引用:
 *   onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)"
 */

window.runWorkspaceAction = async (rawAction, triggerButton = undefined) => {
  bumpNavigationGuard();
  let action = rawAction || {};
  if (typeof rawAction === 'string') {
    try {
      action = JSON.parse(rawAction);
    } catch {
      action = {};
    }
  }

  const activeAgent = getCurrentAgentRecord();
  if (typeof saveCurrentWorkspaceSurfaceScroll === 'function') {
    saveCurrentWorkspaceSurfaceScroll();
  }
  const hasSessions = hasWorkspaceSessions(activeAgent);
  const shouldMarkLoading = !!(
    activeAgent?.id
    && (
      action.type === 'show_chat'
      || action.type === 'resume_session'
      || action.type === 'open_session'
      || action.type === 'open_latest_session'
      || action.type === 'create_session'
      || action.type === 'create_session_from_session'
    )
  );
  if (action.type === 'open_latest_session') {
    if (activeAgent?.id === 'feature-creator') {
      const projects = getFeatureCreatorProjects(activeAgent);
      const latestProject = projects[0] || null;
      if (!latestProject) {
        return;
      }
      action = latestProject.latestSessionId
        ? { type: 'open_session', sessionId: latestProject.latestSessionId }
        : {
            type: 'create_session',
            featureName: latestProject.featureName || '',
            openDirectory: latestProject.openDirectory || '',
            targetDir: latestProject.targetDir || '',
          };
    } else if (activeAgent?.id === 'agent-creator') {
      const projects = getAgentCreatorProjects(activeAgent);
      const latestProject = projects[0] || null;
      if (!latestProject) {
        return;
      }
      action = latestProject.latestSessionId
        ? { type: 'open_session', sessionId: latestProject.latestSessionId }
        : {
            type: 'create_session',
            agentName: latestProject.agentName || '',
            openDirectory: latestProject.openDirectory || '',
            targetDir: latestProject.targetDir || '',
          };
    } else {
      const sessions = getWorkspaceSessions(activeAgent);
      if (sessions.length > 0) {
        action = { type: 'open_session', sessionId: sessions[0].id };
      } else {
        return;
      }
    }
  }

  if (action.type === 'navigate_unit' && action.targetAgentId) {
    await window.handlePrebuiltAgentClick(action.targetAgentId);
    return;
  }

  if (action.type === 'prime_workspace_form') {
    const formId = String(action.formId || '');
    const values = action.values && typeof action.values === 'object' ? action.values : {};
    if (activeAgent?.id) {
      const draft = getWorkspaceFormDraft(activeAgent);
      draft[formId] = normalizeWorkspaceStartupDraft(activeAgent, {
        ...(draft[formId] || {}),
        ...values,
      });
      saveWorkspaceFormDraft(activeAgent.id, draft);
    }
    setPreferredUnitMode(action.target ? `block:${String(action.target)}` : `block:${formId}`, activeAgent);
    renderCurrentMainView();
    return;
  }

  if (action.type === 'open_artifact_preview') {
    currentWorkspaceArtifactDetail = {
      agentId: activeAgent?.id || '',
      blockId: String(action.blockId || ''),
      artifactId: String(action.artifactId || ''),
    };
    renderCurrentMainView();
    return;
  }

  if (action.type === 'close_artifact_preview') {
    if (currentWorkspaceArtifactDetail && currentWorkspaceArtifactDetail.agentId === (activeAgent?.id || '') && currentWorkspaceArtifactDetail.blockId === String(action.blockId || '')) {
      currentWorkspaceArtifactDetail = null;
    }
    renderCurrentMainView();
    return;
  }

  if (action.type === 'open_project_docset_preview') {
    currentWorkspaceDocsetDetail = {
      agentId: activeAgent?.id || '',
      blockId: String(action.blockId || ''),
      section: String(action.section || ''),
      itemId: String(action.itemId || ''),
    };
    renderCurrentMainView();
    return;
  }

  if (action.type === 'close_project_docset_preview') {
    if (currentWorkspaceDocsetDetail && currentWorkspaceDocsetDetail.agentId === (activeAgent?.id || '') && currentWorkspaceDocsetDetail.blockId === String(action.blockId || '')) {
      currentWorkspaceDocsetDetail = null;
    }
    renderCurrentMainView();
    return;
  }

  if (action.type === 'apply_workspace_bundle') {
    await window.applyWorkspaceBundle(action.formId || 'assembly-form', action.bundle || {});
    return;
  }

  if (action.type === 'launch_assembly_instance') {
    await window.launchAssemblyInstance();
    return;
  }

  if (action.type === 'compacted_resume_session') {
    if (!activeAgent?.id || !action.sessionId) return;
    const confirmed = window.confirm(t('workspace_compacted_resume_confirm'));
    if (!confirmed) {
      return;
    }

    const _navGuard = _navigationGuardEpoch;
    const isZh = currentLanguage === 'zh';
    const toastId = 'compact-resume-' + action.sessionId;
    ClawToast.show({
      id: toastId,
      title: isZh ? '正在创建轻量继续会话...' : 'Creating compacted resume session...',
      status: 'loading',
    });
    try {
      const result = await createCompactedResumeSession(activeAgent.id, action.sessionId);
      if (result?.agent) {
        applyManagedPrebuiltAgent(activeAgent.id, result.agent);
      }
      await loadAgents();
      if (_navGuard !== _navigationGuardEpoch) {
        ClawToast.update(toastId, {
          status: 'success',
          title: isZh ? '轻量继续会话已创建' : 'Compacted resume session created',
        });
        return;
      }
      const nextRuntimeId =
        result?.agent?.runtime_session_id
        || result?.agent?.runtimeSessionId
        || null;
      if (nextRuntimeId) {
        setPreferredUnitMode('chat', allAgents.find((agent) => agent.id === activeAgent.id) || activeAgent);
        beginChatLoadingSession();
        await requestSwitch(nextRuntimeId, 'compact-resume');
        ClawToast.update(toastId, {
          status: 'success',
          title: isZh ? '轻量继续会话已创建' : 'Compacted resume session created',
        });
      } else {
        lastRenderedWorkspaceHtml = '';
        renderCurrentMainView();
        ClawToast.update(toastId, {
          status: 'success',
          title: isZh ? '轻量继续会话已创建' : 'Compacted resume session created',
        });
      }
    } catch (error) {
      console.error('Failed to compact-resume session:', error);
      clearChatLoadingSession();
      ClawToast.update(toastId, {
        status: 'error',
        title: isZh ? '轻量继续失败' : 'Compacted resume failed',
        description: (error && error.message ? error.message : String(error)),
      });
    }
    return;
  }

  if (action.type === 'compact_session_menu') {
    if (!activeAgent?.id || !action.sessionId) return;
    const compactType = action.compactType || 'summary';

    if (compactType === 'trim') {
      window.openTrimDialog(activeAgent.id, action.sessionId);
      return;
    }

    const strategy = 'summarized-nine-section';
    const _csIsZh2 = currentLanguage === 'zh';
    const confirmMsg = action.archiveOriginal
      ? (_csIsZh2 ? '确定要总结当前会话历史并创建新会话？\n\n原会话将被自动归档。' : 'Summarize session history and create a new session?\n\nThe original session will be archived.')
      : t('workspace_compact_summary_confirm');
    const confirmed = window.confirm(confirmMsg);
    if (!confirmed) {
      return;
    }

    markSessionLoading(activeAgent.id, action.sessionId);
    const _csNavGuard = _navigationGuardEpoch;
    const _csOldRuntimeId = currentRuntimeAgentId;
    const _csIsZh = currentLanguage === 'zh';
    const _csToastId = 'compact-summary-' + action.sessionId;
    let _csArchiveRollback = null;
    if (action.archiveOriginal && typeof markSessionArchivedForMutation === 'function') {
      _csArchiveRollback = markSessionArchivedForMutation(activeAgent.id, action.sessionId, 'summary');
    }
    ClawToast.show({
      id: _csToastId,
      title: _csIsZh ? '正在总结会话历史...' : 'Summarizing session history...',
      status: 'loading',
    });
    try {
      const result = await createCompactedResumeSession(activeAgent.id, action.sessionId, strategy, null, null, null, {
        archiveOriginal: action.archiveOriginal,
      });
      const archiveSucceeded = !action.archiveOriginal || result?.archive?.succeeded === true;
      if (!archiveSucceeded && _csArchiveRollback) {
        _csArchiveRollback();
        _csArchiveRollback = null;
      }
      if (result?.liveRuntime && result?.switched) {
        // Live-runtime shortcut path: session switch was already handled
        // inside createCompactedResumeSession — skip normal agent/runtime logic
        await loadAgents();
        clearSessionLoading(activeAgent.id);
        ClawToast.update(_csToastId, {
          status: 'success',
          title: _csIsZh ? '会话总结完成' : 'Session summary completed',
        });
        // 服务端已原子完成归档，只需停止旧 runtime
        if (action.archiveOriginal && archiveSucceeded && _csOldRuntimeId) {
          updateSessionReplacementMutation(activeAgent.id, action.sessionId, { phase: 'stopping' });
          clearAgentRuntimeCache(_csOldRuntimeId);
          try { await invoke('stop_agent', { agentId: activeAgent.id, sessionId: action.sessionId }); } catch {}
          refreshSidebarRuntimeAfterMutation();
          settleSessionReplacementMutation(activeAgent.id, action.sessionId, 700);
        }
        _csArchiveRollback = null;
        return;
      }
      if (result?.agent) {
        applyManagedPrebuiltAgent(activeAgent.id, result.agent);
      }
      await loadAgents();
      if (_csNavGuard !== _navigationGuardEpoch) {
        ClawToast.update(_csToastId, {
          status: 'success',
          title: _csIsZh ? '会话总结完成' : 'Session summary completed',
        });
        if (action.archiveOriginal && archiveSucceeded && _csOldRuntimeId) {
          updateSessionReplacementMutation(activeAgent.id, action.sessionId, { phase: 'stopping' });
          clearAgentRuntimeCache(_csOldRuntimeId);
          try { await invoke('stop_agent', { agentId: activeAgent.id, sessionId: action.sessionId }); } catch {}
          refreshSidebarRuntimeAfterMutation();
          settleSessionReplacementMutation(activeAgent.id, action.sessionId, 700);
        }
        if (action.archiveOriginal && archiveSucceeded && !_csOldRuntimeId) clearSessionReplacementMutation(activeAgent.id, action.sessionId);
        _csArchiveRollback = null;
        return;
      }
      const nextRuntimeId =
        result?.agent?.runtime_session_id
        || result?.agent?.runtimeSessionId
        || null;
      if (nextRuntimeId) {
        setPreferredUnitMode('chat', allAgents.find((agent) => agent.id === activeAgent.id) || activeAgent);
        beginChatLoadingSession();
        await requestSwitch(nextRuntimeId, 'compact-summary');
      } else {
        lastRenderedWorkspaceHtml = '';
        renderCurrentMainView();
      }
      ClawToast.update(_csToastId, {
        status: 'success',
        title: _csIsZh ? '会话总结完成' : 'Session summary completed',
      });
      // 服务端已原子完成归档，只需停止旧 runtime
      if (action.archiveOriginal && archiveSucceeded && _csOldRuntimeId) {
        updateSessionReplacementMutation(activeAgent.id, action.sessionId, { phase: 'stopping' });
        clearAgentRuntimeCache(_csOldRuntimeId);
        try { await invoke('stop_agent', { agentId: activeAgent.id, sessionId: action.sessionId }); } catch {}
        refreshSidebarRuntimeAfterMutation();
        settleSessionReplacementMutation(activeAgent.id, action.sessionId, 700);
      }
      if (action.archiveOriginal && archiveSucceeded && !_csOldRuntimeId) clearSessionReplacementMutation(activeAgent.id, action.sessionId);
      if (action.archiveOriginal && !archiveSucceeded) {
        ClawToast.update(_csToastId, {
          status: 'error',
          title: _csIsZh ? '新会话已创建，但原会话归档失败' : 'New session created, but archive failed',
          description: result?.archive?.error || '',
        });
      }
      _csArchiveRollback = null;
    } catch (error) {
      console.error('Failed to compact session:', error);
      if (_csArchiveRollback) {
        _csArchiveRollback();
        _csArchiveRollback = null;
      }
      clearSessionLoading(activeAgent.id);
      clearChatLoadingSession();
      ClawToast.update(_csToastId, {
        status: 'error',
        title: _csIsZh ? '总结失败' : 'Summary failed',
        description: (error?.message || String(error)),
      });
    }
    return;
  }

  if (action.type === 'view_session_record') {
    if (!action.agentId || !action.sessionId) return;
    readOnlyMode = true;
    const agentId = action.agentId;
    const sessionId = action.sessionId;
    try {
      const res = await fetch('/protoclaw/session_record?agentId=' + encodeURIComponent(agentId) + '&sessionId=' + encodeURIComponent(sessionId));
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      currentMessages = (data.messages || []).map(m => ({
        role: m.role,
        content: m.content,
      }));
      currentInputRequests = [];
      lastRenderedInputSignature = '';
      setPreferredUnitMode('chat', allAgents.find(a => a.id === agentId) || activeAgent);
      renderCurrentMainView();
    } catch (error) {
      console.error('Failed to load session record:', error);
      window.alert('Failed to load session record: ' + (error?.message || error));
      readOnlyMode = false;
    }
    return;
  }

  if (action.type === 'open_summary') {
    if (!action.agentId || !action.sessionId) return;
    window.openSummaryPopup(action.agentId, action.sessionId);
    return;
  }

  if (action.type === 'generate_summary') {
    if (!action.agentId || !action.sessionId) return;
    window.openSummaryPopup(action.agentId, action.sessionId);
    return;
  }

  if (action.type === 'delete_session') {
    if (!activeAgent?.id || !action.sessionId) return;
    const sessionTitle = action.sessionId;
    const confirmMsg = t('workspace_session_delete_confirm').replace('{{id}}', sessionTitle);
    const confirmed = window.confirm(confirmMsg);
    if (!confirmed) {
      return;
    }

    const targetAgent = allAgents.find((item) => item.id === activeAgent.id) || null;
    const affectedRuntimeId = targetAgent?.runtime_session_id || targetAgent?.runtimeSessionId || null;
    const deletedWasActive = action.sessionId === (targetAgent?.active_workspace_session_id || targetAgent?.workspace_sessions?.activeSessionId || null);
    const currentSessions = getWorkspaceSessions(targetAgent);

    if (deletedWasActive) {
      applyManagedPrebuiltAgent(activeAgent.id, null);
    }
    const remainingSessions = currentSessions.filter((s) => s.id !== action.sessionId);
    const nextActiveId = remainingSessions.length > 0
      ? (targetAgent?.active_workspace_session_id === action.sessionId ? remainingSessions[0].id : targetAgent?.active_workspace_session_id)
      : null;
    updateAgentRecord(activeAgent.id, {
      workspace_sessions: { sessions: remainingSessions, activeSessionId: nextActiveId },
      active_workspace_session_id: nextActiveId,
    });

    // Precise DOM removal for IM workspace sessions — avoid full re-render
    const imDraft = getIMWorkspaceDraft ? getIMWorkspaceDraft() : null;
    const isIMSession = Array.isArray(imDraft?.sessions);
    if (isIMSession) {
      const idx = imDraft.sessions.findIndex((s) => s.id === action.sessionId);
      if (idx !== -1) imDraft.sessions.splice(idx, 1);
      if (String(imDraft.workspaceConfig?.receptionistSessionId) === String(action.sessionId)) {
        imDraft.workspaceConfig.receptionistSessionId = '';
      }
      const el = document.querySelector('[data-prebuilt-session-id="' + CSS.escape(action.sessionId) + '"]');
      if (el) {
        el.style.transition = 'opacity 0.2s, transform 0.2s';
        el.style.opacity = '0';
        el.style.transform = 'translateX(-10px)';
        setTimeout(() => el.remove(), 200);
      }
    } else {
      shouldAnimateWorkspaceSurface = false;
      renderCurrentMainView();
    }

    try {
      const response = await fetch('/protoclaw/prebuilt_sessions/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: activeAgent.id,
          sessionId: action.sessionId,
        }),
      });
      if (!response.ok) {
        throw new Error(await response.text().catch(() => 'delete session failed'));
      }
      const result = await response.json();
      if (result?.deleted?.sessions) {
        updateAgentRecord(activeAgent.id, {
          workspace_sessions: result.deleted.sessions,
          active_workspace_session_id: result.deleted.activeSessionId || null,
        });
      }
      if (result?.agent) {
        applyManagedPrebuiltAgent(activeAgent.id, result.agent);
      }
      // Refresh IM workspace draft in background — no re-render needed if DOM already updated
      if (isIMSession) {
        ensureIMWorkspaceLoaded(true).catch(() => {});
      } else {
        loadAgents().catch(() => {});
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
      updateAgentRecord(activeAgent.id, {
        workspace_sessions: { sessions: currentSessions, activeSessionId: targetAgent?.active_workspace_session_id },
        active_workspace_session_id: targetAgent?.active_workspace_session_id,
      });
      // Restore IM draft and re-render on failure
      if (isIMSession) {
        ensureIMWorkspaceLoaded(true).catch(() => {});
      }
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
      window.alert((currentLanguage === 'zh' ? '删除会话失败：' : 'Failed to delete session: ') + (error?.message || error));
    }
    return;
  }

  if (action.type === 'unarchive_session') {
    if (!activeAgent?.id || !action.sessionId) return;
    // Delegate to ctxArchiveSession which handles optimistic update + API + re-render
    ctxArchiveSession({ ns: activeAgent.id, id: action.sessionId });
    return;
  }

  if ((action.type === 'show_chat' || action.type === 'resume_session') && !hasSessions) {
    return;
  }

  const needsManagedSession =
    activeAgent?.source === 'prebuilt'
    && (
      action.type === 'create_session'
      || action.type === 'create_session_from_session'
      || action.type === 'open_session'
    );

  if (needsManagedSession) {
    beginChatLoadingSession();
    if (action.type === 'open_session' && action.sessionId) {
      markSessionLoading(activeAgent.id, action.sessionId);
    }
    if (triggerButton) markActionLoading(triggerButton);
    try {
      prebuiltSessionSwitchInFlight = true;
      const sessionAction = action.type === 'open_session'
        ? { type: 'open_session', sessionId: action.sessionId }
        : {
            type: action.type,
            sessionId: action.sessionId,
            formId: action.formId,
            featureName: action.featureName,
            agentName: action.agentName,
            openDirectory: action.openDirectory,
            targetDir: action.targetDir,
      };
      const runSessionOpen = async () => {
        const _navGuard = _navigationGuardEpoch;
        const previousRuntimeId = normalizeAgentIdentity(activeAgent.runtime_session_id || activeAgent.runtimeSessionId || currentRuntimeAgentId);
        _storeVisibleSessionInputDraft();
        if (previousRuntimeId) {
          saveCurrentRuntimeToCache(previousRuntimeId, getRuntimeContextKey(previousRuntimeId, activeAgent));
        }
        const result = await openPrebuiltWorkspaceSession(activeAgent.id, sessionAction);
        const optimisticAgent = result?.session
          ? (applyOptimisticWorkspaceSession(activeAgent.id, result.session) || activeAgent)
          : activeAgent;
        // Immediately render the workspace surface so the user sees the new
        // session appear in the list without waiting for the runtime to start.
        // Guard: skip render if user already navigated to a different surface.
        if (!currentRuntimeAgentId && _navGuard === _navigationGuardEpoch) {
          lastRenderedWorkspaceHtml = '';
          renderCurrentMainView();
        }
        const isAssemblyLaunch =
          activeAgent?.id === 'agent-creator'
          && action.type === 'create_session'
          && String(action.formId || '') === 'assembly-form';
        const nextAgent = result?.agent ? (upsertConnectedAgent(result.agent) || result.agent) : null;
        if (isAssemblyLaunch) {
          if (_navGuard !== _navigationGuardEpoch) return;
          setPreferredUnitMode('assembly', activeAgent);
          loadAgents().catch((error) => console.error('Failed to refresh agents after assembly launch:', error));
          renderCurrentMainView();
          return;
        }
        if (_navGuard !== _navigationGuardEpoch) return;
        if (nextAgent?.runtime_session_id || nextAgent?.runtimeSessionId) {
          setPreferredUnitMode('chat', nextAgent);
          const nextRuntimeId = nextAgent.runtime_session_id || nextAgent.runtimeSessionId || nextAgent.id;
          if (nextRuntimeId === currentRuntimeAgentId) {
            beginFollowLatestEntryWindow();
            renderCurrentMainView();
          } else {
            await requestSwitch(nextRuntimeId, 'session-open');
          }
          loadAgents().catch((error) => console.error('Failed to refresh agents after opening prebuilt session:', error));
          return;
        }
        if (result?.status?.status === 'running' && result.status.viewerAgentId) {
          const existingRuntimeId = result.status.viewerAgentId;
          if (existingRuntimeId === currentRuntimeAgentId) {
            beginFollowLatestEntryWindow();
            renderCurrentMainView();
          } else {
            await loadAgents();
            await requestSwitch(existingRuntimeId, 'session-open-existing');
          }
          return;
        }
        // Guard before the potentially long waitForPrebuiltRuntimeSession:
        // if the user already navigated away, skip the wait entirely.
        if (_navGuard !== _navigationGuardEpoch) return;
        try {
          const readyAgent = await waitForPrebuiltRuntimeSession(activeAgent.id, 30, {
            previousRuntimeId,
            expectedSessionId: result?.session?.id || '',
          });
          if (!readyAgent) return;
          // Guard again after the long wait — user may have navigated during polling.
          if (_navGuard !== _navigationGuardEpoch) return;
          const nextRuntimeId = readyAgent.runtime_session_id || readyAgent.runtimeSessionId || readyAgent.id;
          if (!nextRuntimeId) return;
          setPreferredUnitMode('chat', activeAgent);
          if (nextRuntimeId === currentRuntimeAgentId) {
            beginFollowLatestEntryWindow();
            renderCurrentMainView();
          } else {
            await requestSwitch(nextRuntimeId, 'session-open-wait');
          }
        } catch (error) {
          console.error('Failed while waiting for prebuilt runtime session:', error);
        } finally {
          loadAgents().catch((error) => console.error('Failed to refresh agents after waiting for prebuilt runtime:', error));
        }
      };
      const targetSession = sessionAction.type === 'open_session'
        ? getWorkspaceSessionById(activeAgent, sessionAction.sessionId)
        : null;
      const needsAssemblyDriftWarning = !!(
        targetSession
        && isAssemblySession(targetSession)
        && !isAssemblySessionRunning(activeAgent, targetSession)
        && (activeAgent?.id === 'flow-workspace' || activeAgent?.id === 'agent-creator')
      );
      if (needsAssemblyDriftWarning) {
        await maybeWarnAssemblySessionDrift(activeAgent, sessionAction.sessionId, runSessionOpen);
      } else {
        await runSessionOpen();
      }
    } catch (error) {
      console.error('Failed to open prebuilt session:', error);
      window.alert(`Session failed: ${error && error.message ? error.message : error}`);
      return;
    } finally {
      prebuiltSessionSwitchInFlight = false;
      // For create_session, the new session legitimately has 0 messages.
      // loadAgentData only clears loading when messages arrive, so clear
      // it here to avoid a 10s spinner on an intentionally empty session.
      if (action.type === 'create_session' || action.type === 'create_session_from_session') {
        clearChatLoadingSession();
        renderCurrentMainView();
      }
      if (shouldMarkLoading) clearSessionLoading(activeAgent.id);
      else if (triggerButton) triggerButton.classList.remove('action-loading');
    }
  }

  if (action.type === 'show_chat' || action.type === 'resume_session') {
    beginFollowLatestCooldown();
    beginFollowLatestEntryWindow();
    setPreferredUnitMode('chat', activeAgent);
  } else if (action.type === 'show_home') {
    setPreferredUnitMode('home', activeAgent);
  } else if (action.type === 'show_workspace_tab' && action.tab) {
    setPreferredUnitMode(String(action.tab), activeAgent);
  } else if (action.type === 'show_block' && action.target) {
    setPreferredUnitMode(`block:${action.target}`, activeAgent);
  }
  renderCurrentMainView();
};
