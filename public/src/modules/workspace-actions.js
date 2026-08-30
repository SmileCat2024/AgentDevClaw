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
 *   applySessionViewPatch (session-view-state.js)
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
 *   requestArchivedSourceRuntimeCleanup, clearAgentRuntimeCache,
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

// ── 幂等键（ADR-0011）：写类提交统一携带（本地忽略、远程强制）───────────
function newIdempotencyKey() {
  const cryptoObj = (typeof crypto !== 'undefined') ? crypto : null;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}


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

  if (action.type === 'open_session' && isRemoteNamespaceAgentId(action.sessionId)) {
    // 远程历史会话激活（R2-01，ADR-0012 决策 2）：与本地同一动作入口，
    // 身份来自列表项数据层（host 级命名空间 id + 命名空间 sessionId），
    // activate 经服务端命名空间分支转发到远程。
    const hostNsId = typeof window.RemoteConnections?.getEntryHostNamespaceId === 'function'
      ? (window.RemoteConnections.getEntryHostNamespaceId(action.sessionId) || '')
      : '';
    if (!hostNsId) {
      // 目录未含该会话（连接断开/条目消失）：显式失败，不猜测宿主。
      window.alert(currentLanguage === 'zh'
        ? '远程连接不可用，无法打开该会话'
        : 'Remote connection is unavailable for this session');
      return;
    }
    await window._activateRemoteHistorySession(hostNsId, action.sessionId, triggerButton);
    return;
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
    const sourceSession = getWorkspaceSessionById(activeAgent, action.sessionId);
    let compactSessionCommitted = false;
    const compactOperation = beginSidebarOperation({
      type: 'create',
      kind: 'summary',
      phase: 'generating',
      agentId: activeAgent.id,
      sourceSessionId: action.sessionId,
      sourceRuntimeId: currentRuntimeAgentId || '',
      projectDir: sourceSession?.openDirectory || '',
      projectName: getPathLeaf(sourceSession?.openDirectory || ''),
      title: sourceSession?.title || '',
    });
    ClawToast.show({
      id: toastId,
      title: isZh ? '正在创建轻量继续会话...' : 'Creating compacted resume session...',
      status: 'loading',
    });
    try {
      const result = await createCompactedResumeSession(activeAgent.id, action.sessionId, 'summarized-nine-section', null, null, null, {
        operationId: compactOperation.operationId,
      });
      if (typeof applySidebarMutationDeltaWithDiagnostics === 'function') {
        applySidebarMutationDeltaWithDiagnostics(compactOperation.operationId, activeAgent.id, result);
      } else if (typeof applySessionMutationDelta === 'function') {
        applySessionMutationDelta(activeAgent.id, result);
      }
      const targetSessionId = String(result?.session?.id || '').trim();
      compactSessionCommitted = Boolean(targetSessionId);
      updateSidebarOperation(compactOperation.operationId, {
        phase: 'target-starting',
        targetSessionId,
        title: result?.session?.title || compactOperation.title,
        serverRevision: result?.revision ?? null,
      });
      // The server has already committed the session and performed the bounded
      // runtime startup observation. Do not block the UI on a second readiness
      // poll; a missing immediate runtime is a delayed startup, not a failure.
      const readyAgent = result?.agent || null;
      const targetStopped = false;
      const managedReadyAgent = readyAgent ? (upsertConnectedAgent(readyAgent) || readyAgent) : null;
      const nextRuntimeId = managedReadyAgent?.runtime_session_id
        || managedReadyAgent?.runtimeSessionId
        || managedReadyAgent?.id
        || null;
      if (nextRuntimeId) {
        updateSidebarOperation(compactOperation.operationId, { phase: 'target-ready', targetRuntimeId: nextRuntimeId });
        if (_navGuard === _navigationGuardEpoch) {
          setPreferredUnitMode('chat', managedReadyAgent);
          beginChatLoadingSession();
          await requestSwitch(nextRuntimeId, 'compact-resume');
        }
        finishSidebarOperation(compactOperation.operationId, 'settled');
      } else {
        // The session commit succeeded; readiness observation is deliberately
        // non-blocking and must not leave a synthetic sidebar operation behind.
        if (!targetStopped) finishSidebarOperation(compactOperation.operationId, 'settled');
        lastRenderedWorkspaceHtml = '';
        renderCurrentMainView();
      }
      loadAgents().catch(e => console.warn(e));
      ClawToast.update(toastId, {
        status: 'success',
        title: isZh ? '轻量继续会话已创建' : 'Compacted resume session created',
      });
    } catch (error) {
      console.error('Failed to compact-resume session:', error);
      if (!compactSessionCommitted) {
        finishSidebarOperation(compactOperation.operationId, 'failed', { errorCode: 'compact_resume_failed' });
        ClawToast.update(toastId, {
          status: 'error',
          title: isZh ? '轻量继续失败' : 'Compacted resume failed',
          description: (error && error.message ? error.message : String(error)),
        });
      } else {
        finishSidebarOperation(compactOperation.operationId, 'settled');
        ClawToast.update(toastId, {
          status: 'success',
          title: isZh ? '轻量继续会话已创建' : 'Compacted resume session created',
        });
      }
      clearChatLoadingSession();
    }
    return;
  }

  if (action.type === 'compact_session_menu') {
    // Target agent may differ from the currently active one when triggered
    // from another agent's sidebar runtime ctx-menu — prefer explicit agentId.
    const _csAgent = (action.agentId && allAgents.find((a) => a.id === action.agentId)) || activeAgent;
    if (!_csAgent?.id || !action.sessionId) return;
    const compactType = action.compactType || 'summary';

    if (compactType === 'trim') {
      window.openTrimDialog(_csAgent.id, action.sessionId);
      return;
    }

    // trim_all：全量精简、不生成摘要（slash /trim 入口；确认已在入口完成）
    const isTrimAll = compactType === 'trim_all';
    const strategy = isTrimAll ? '' : 'summarized-nine-section';
    const _csPolicy = isTrimAll ? { preservedTurns: [], preservedMsgRanges: [] } : null;
    const _csIsZh2 = currentLanguage === 'zh';
    if (!isTrimAll) {
      const confirmMsg = action.archiveOriginal
        ? (_csIsZh2 ? '确定要总结当前会话历史并创建新会话？原会话将被自动归档。' : 'Summarize session history and create a new session?The original session will be archived.')
        : t('workspace_compact_summary_confirm');
      if (!window.confirm(confirmMsg)) {
        return;
      }
    }

    markSessionLoading(_csAgent.id, action.sessionId);
    const _csNavGuard = _navigationGuardEpoch;
    const _csOldRuntimeId = currentRuntimeAgentId;
    const _csIsZh = currentLanguage === 'zh';
    const _csToastId = 'compact-summary-' + action.sessionId;
    let _csArchiveRollback = null;
    let _csSessionCommitted = false;
    if (action.archiveOriginal && typeof markSessionArchivedForMutation === 'function') {
      _csArchiveRollback = markSessionArchivedForMutation(_csAgent.id, action.sessionId, 'summary');
    }
    const _csSourceSession = getWorkspaceSessionById(_csAgent, action.sessionId);
    const _csOperation = _csArchiveRollback?.operationId
      ? getSidebarOperation(_csArchiveRollback.operationId)
      : beginSidebarOperation({
          type: 'create',
          kind: isTrimAll ? 'trim' : 'summary',
          phase: 'generating',
          agentId: _csAgent.id,
          sourceSessionId: action.sessionId,
          sourceRuntimeId: _csOldRuntimeId || '',
          projectDir: _csSourceSession?.openDirectory || '',
          projectName: getPathLeaf(_csSourceSession?.openDirectory || ''),
          title: _csSourceSession?.title || '',
        });
    ClawToast.show({
      id: _csToastId,
      title: _csIsZh ? (isTrimAll ? '正在精简会话...' : '正在总结会话历史...') : (isTrimAll ? 'Trimming session...' : 'Summarizing session history...'),
      status: 'loading',
    });
    const _csDoneTitle = _csIsZh ? (isTrimAll ? '精简完成' : '会话总结完成') : (isTrimAll ? 'Trim completed' : 'Session summary completed');
    const _csFailTitle = _csIsZh ? (isTrimAll ? '精简失败' : '总结失败') : (isTrimAll ? 'Trim failed' : 'Summary failed');
    try {
      const _csOptions = {
        archiveOriginal: action.archiveOriginal,
        operationId: _csOperation?.operationId || '',
      };
      if (isTrimAll) {
        _csOptions.appendSummary = false;
        _csOptions.reason = 'trim';
        _csOptions.trimCutRounds = Number(action.trimCutRounds) || 0;
      }
      const result = await createCompactedResumeSession(_csAgent.id, action.sessionId, strategy, null, null, _csPolicy, _csOptions);
      if (typeof applySidebarMutationDeltaWithDiagnostics === 'function') {
        applySidebarMutationDeltaWithDiagnostics(_csOperation?.operationId, _csAgent.id, result);
      } else if (typeof applySessionMutationDelta === 'function') {
        applySessionMutationDelta(_csAgent.id, result);
      }
      const archiveSucceeded = !action.archiveOriginal || result?.archive?.succeeded === true;
      if (!archiveSucceeded && _csArchiveRollback) {
        _csArchiveRollback();
        _csArchiveRollback = null;
      }
      if (result?.liveRuntime && result?.switched) {
        // Live-runtime shortcut path: session switch was already handled
        // inside createCompactedResumeSession — skip normal agent/runtime logic
        loadAgents().catch(e => console.warn(e));
        clearSessionLoading(_csAgent.id);
        ClawToast.update(_csToastId, {
          status: 'success',
          title: _csDoneTitle,
        });
        if (action.archiveOriginal && archiveSucceeded) {
          requestArchivedSourceRuntimeCleanup(_csAgent.id, action.sessionId, _csOldRuntimeId);
        }
        _csArchiveRollback = null;
        return;
      }
      const targetSessionId = String(result?.session?.id || '').trim();
      _csSessionCommitted = Boolean(targetSessionId);
      updateSidebarOperation(_csOperation?.operationId, {
        phase: 'target-starting',
        targetSessionId,
        title: result?.session?.title || _csOperation?.title || '',
        serverRevision: result?.revision ?? null,
      });
      // The response is authoritative for the committed session. Runtime
      // readiness may arrive after this response; never block or downgrade the
      // completed summary merely because it is not present yet.
      const _csReadyAgent = result?.agent || null;
      const _csTargetStopped = false;
      const _csConnectedTarget = _csReadyAgent ? (upsertConnectedAgent(_csReadyAgent) || _csReadyAgent) : null;
      const nextRuntimeId = _csConnectedTarget?.runtime_session_id
        || _csConnectedTarget?.runtimeSessionId
        || _csConnectedTarget?.id
        || null;
      if (action.archiveOriginal && archiveSucceeded) {
        // The successor and archive were committed by the server. Completing
        // source-runtime disposal later must not turn this summary into a
        // degraded session operation.
        finishSidebarOperation(_csOperation?.operationId, 'settled');
      } else if (nextRuntimeId) {
        updateSidebarOperation(_csOperation?.operationId, { phase: 'target-ready', targetRuntimeId: nextRuntimeId });
      } else if (_csTargetStopped) {
        updateSidebarOperation(_csOperation?.operationId, { phase: 'degraded', errorCode: 'target_runtime_stopped' });
      } else {
        finishSidebarOperation(_csOperation?.operationId, 'settled');
      }
      if (_csNavGuard !== _navigationGuardEpoch) {
        ClawToast.update(_csToastId, {
          status: 'success',
          title: _csDoneTitle,
        });
        if (action.archiveOriginal && archiveSucceeded) {
          requestArchivedSourceRuntimeCleanup(_csAgent.id, action.sessionId, _csOldRuntimeId);
        }
        if (!action.archiveOriginal && nextRuntimeId) finishSidebarOperation(_csOperation?.operationId, 'settled');
        _csArchiveRollback = null;
        return;
      }
      if (nextRuntimeId) {
        setPreferredUnitMode('chat', _csAgent);
        beginChatLoadingSession();
        await requestSwitch(nextRuntimeId, 'compact-summary');
        if (!action.archiveOriginal) finishSidebarOperation(_csOperation?.operationId, 'settled');
      } else {
        lastRenderedWorkspaceHtml = '';
        renderCurrentMainView();
      }
      ClawToast.update(_csToastId, {
        status: 'success',
        title: _csDoneTitle,
      });
      if (action.archiveOriginal && archiveSucceeded) {
        requestArchivedSourceRuntimeCleanup(_csAgent.id, action.sessionId, _csOldRuntimeId);
      }
      loadAgents().catch(e => console.warn(e));
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
      if (!_csSessionCommitted) {
        if (_csArchiveRollback) {
          _csArchiveRollback();
          _csArchiveRollback = null;
        } else if (_csOperation?.operationId) {
          finishSidebarOperation(_csOperation.operationId, 'failed', { errorCode: 'summary_failed' });
        }
        ClawToast.update(_csToastId, {
          status: 'error',
          title: _csFailTitle,
          description: (error?.message || String(error)),
        });
      } else {
        finishSidebarOperation(_csOperation?.operationId, 'settled');
        _csArchiveRollback = null;
        ClawToast.update(_csToastId, {
          status: 'success',
          title: _csDoneTitle,
        });
      }
      clearSessionLoading(_csAgent.id);
      clearChatLoadingSession();
    }
    return;
  }

  if (action.type === 'view_session_record') {
    if (!action.agentId || !action.sessionId) return;
    const recordNavigationEpoch = _navigationGuardEpoch;
    readOnlyMode = true;
    const agentId = action.agentId;
    const sessionId = action.sessionId;
    try {
      const res = await fetch('/protoclaw/session_record?agentId=' + encodeURIComponent(agentId) + '&sessionId=' + encodeURIComponent(sessionId));
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (recordNavigationEpoch !== _navigationGuardEpoch) return;
      applySessionViewPatch({
        messages: (data.messages || []).map(m => ({
          role: m.role,
          content: m.content,
        })),
        inputRequests: [],
      });
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
    const deletedWasActive = action.sessionId === (targetAgent?.active_workspace_session_id || targetAgent?.workspace_sessions?.activeSessionId || null);
    const currentSessions = getWorkspaceSessions(targetAgent);
    const deletedSession = currentSessions.find((session) => session?.id === action.sessionId) || null;
    const runtimeAgent = allAgents.find((item) => (
      item?.source !== 'prebuilt'
      && String(item?.parent_id || '') === String(activeAgent.id)
      && String(item?.active_workspace_session_id || '') === String(action.sessionId)
    )) || null;
    const affectedRuntimeId = runtimeAgent?.runtime_session_id
      || runtimeAgent?.runtimeSessionId
      || runtimeAgent?.id
      || (deletedWasActive ? (targetAgent?.runtime_session_id || targetAgent?.runtimeSessionId || null) : null);
    const deleteOperation = beginSidebarOperation({
      type: 'delete',
      kind: 'delete',
      phase: 'committing',
      agentId: activeAgent.id,
      sourceSessionId: action.sessionId,
      sourceRuntimeId: affectedRuntimeId || '',
      projectDir: deletedSession?.openDirectory || '',
      projectName: deletedSession?.openDirectory ? getPathLeaf(deletedSession.openDirectory) : '',
      title: deletedSession?.title || action.sessionId,
    });

    if (deletedWasActive) {
      applyManagedPrebuiltAgent(activeAgent.id, null);
    }
    const remainingSessions = currentSessions.filter((s) => s.id !== action.sessionId);
    const nextActiveId = remainingSessions.length > 0
      ? (targetAgent?.active_workspace_session_id === action.sessionId ? remainingSessions[0].id : targetAgent?.active_workspace_session_id)
      : null;
    updateAgentRecord(activeAgent.id, {
      workspace_sessions: { ...(targetAgent?.workspace_sessions || {}), sessions: remainingSessions, activeSessionId: nextActiveId },
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
        headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
        body: JSON.stringify({
          agentId: activeAgent.id,
          sessionId: action.sessionId,
          responseMode: 'delta',
          operationId: deleteOperation.operationId,
        }),
      });
      if (!response.ok) {
        throw new Error(await response.text().catch(() => 'delete session failed'));
      }
      const result = await response.json();
      if (typeof applySessionMutationDelta === 'function') applySessionMutationDelta(activeAgent.id, result);
      if (result?.deleted?.sessions) {
        updateAgentRecord(activeAgent.id, {
          workspace_sessions: result.deleted.sessions,
          active_workspace_session_id: result.deleted.activeSessionId || null,
        });
      }
      if (result?.agent) {
        applyManagedPrebuiltAgent(activeAgent.id, result.agent);
      }
      finishSidebarOperation(deleteOperation.operationId, 'settled', {
        serverRevision: result?.deleted?.revision ?? result?.revision ?? null,
      });
      if (affectedRuntimeId) clearAgentRuntimeCache(affectedRuntimeId);
      const targetSessionId = String(result?.targetSessionId || '').trim();
      if (targetSessionId) {
        await navigateToSessionMutationTarget(activeAgent.id, result, affectedRuntimeId);
      }
      // Refresh IM workspace draft in background — no re-render needed if DOM already updated
      if (isIMSession) {
        ensureIMWorkspaceLoaded(true).catch(e => console.warn(e));
      } else {
        loadAgents().catch(e => console.warn(e));
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
      updateAgentRecord(activeAgent.id, {
        workspace_sessions: { ...(targetAgent?.workspace_sessions || {}), sessions: currentSessions, activeSessionId: targetAgent?.active_workspace_session_id },
        active_workspace_session_id: targetAgent?.active_workspace_session_id,
      });
      finishSidebarOperation(deleteOperation.operationId, 'failed', { errorCode: 'delete_failed' });
      // Restore IM draft and re-render on failure
      if (isIMSession) {
        ensureIMWorkspaceLoaded(true).catch(e => console.warn(e));
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
    // Declared outside try so the catch block can still settle the operation.
    let sidebarOperation = null;
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
            projectName: action.projectName,
            openDirectory: action.openDirectory,
            targetDir: action.targetDir,
      };
      const runSessionOpen = async () => {
        const _navGuard = _navigationGuardEpoch;
        const previousRuntimeId = normalizeAgentIdentity(activeAgent.runtime_session_id || activeAgent.runtimeSessionId || currentRuntimeAgentId);
        const sourceSessionId = String(activeAgent?.active_workspace_session_id || activeAgent?.workspace_sessions?.activeSessionId || '').trim();
        const knownTargetSession = sessionAction.type === 'open_session'
          ? getWorkspaceSessionById(activeAgent, sessionAction.sessionId)
          : null;
        const sourceSession = sourceSessionId ? getWorkspaceSessionById(activeAgent, sourceSessionId) : null;
        sidebarOperation = beginSidebarOperation({
          type: sessionAction.type === 'open_session' ? 'activate' : 'create',
          kind: sessionAction.type === 'open_session' ? 'open' : 'create',
          phase: 'committing',
          agentId: activeAgent.id,
          sourceSessionId,
          sourceRuntimeId: previousRuntimeId || '',
          targetSessionId: knownTargetSession?.id || '',
          projectDir: knownTargetSession?.openDirectory || action.openDirectory || sourceSession?.openDirectory || '',
          projectName: getPathLeaf(knownTargetSession?.openDirectory || action.openDirectory || sourceSession?.openDirectory || ''),
          title: knownTargetSession?.title || action.agentName || action.featureName || '',
        });
        sessionAction.operationId = sidebarOperation.operationId;
        _storeVisibleSessionInputDraft();
        if (previousRuntimeId) {
          saveCurrentRuntimeToCache(previousRuntimeId, getRuntimeContextKey(previousRuntimeId, activeAgent));
        }
        const result = await openPrebuiltWorkspaceSession(activeAgent.id, sessionAction);
        // 线程宿主（coder）：新会话在服务端已建线程，刷新使徽标立即可见
        if (typeof window.refreshThreads === 'function') {
          window.refreshThreads(true).catch(() => {});
        }
        if (typeof applySessionMutationDelta === 'function') applySessionMutationDelta(activeAgent.id, result);
        const optimisticAgent = result?.session
          ? (applyOptimisticWorkspaceSession(activeAgent.id, result.session) || activeAgent)
          : activeAgent;
        const targetSessionId = String(result?.session?.id || sessionAction.sessionId || '').trim();
        updateSidebarOperation(sidebarOperation.operationId, {
          phase: 'target-starting',
          targetSessionId,
          projectDir: result?.session?.openDirectory || sidebarOperation.projectDir,
          projectName: getPathLeaf(result?.session?.openDirectory || sidebarOperation.projectDir),
          title: result?.session?.title || sidebarOperation.title,
          serverRevision: result?.revision ?? null,
        });
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
        // 用户主动打开/创建会话：立即冻结 viewer 绑定。同 runtime 的会话
        // 切换不经过 switchAgent；若不在此绑定，乐观更新与服务器确认之间
        // contextKey 会沿 allAgents 的 activeSessionId 出现瞬时漂移。
        if (targetSessionId) {
          const bindRuntimeId = String(
            nextAgent?.runtime_session_id || nextAgent?.runtimeSessionId || previousRuntimeId || '',
          ).trim();
          if (bindRuntimeId) setViewerSessionBinding(bindRuntimeId, targetSessionId);
        }
        if (isAssemblyLaunch) {
          finishSidebarOperation(sidebarOperation.operationId, 'settled');
          if (_navGuard !== _navigationGuardEpoch) return;
          setPreferredUnitMode('assembly', activeAgent);
          loadAgents().catch((error) => console.error('Failed to refresh agents after assembly launch:', error));
          renderCurrentMainView();
          return;
        }
        if (nextAgent?.runtime_session_id || nextAgent?.runtimeSessionId) {
          const nextRuntimeId = nextAgent.runtime_session_id || nextAgent.runtimeSessionId || nextAgent.id;
          updateSidebarOperation(sidebarOperation.operationId, {
            phase: 'target-ready',
            targetRuntimeId: nextRuntimeId,
          });
          if (_navGuard !== _navigationGuardEpoch) {
            finishSidebarOperation(sidebarOperation.operationId, 'settled');
            return;
          }
          setPreferredUnitMode('chat', nextAgent);
          if (nextRuntimeId === currentRuntimeAgentId) {
            beginFollowLatestEntryWindow();
            renderCurrentMainView();
          } else {
            await requestSwitch(nextRuntimeId, 'session-open');
          }
          finishSidebarOperation(sidebarOperation.operationId, 'settled');
          loadAgents().catch((error) => console.error('Failed to refresh agents after opening prebuilt session:', error));
          return;
        }
        // The session is committed and its startup has been requested. Keep the
        // operation settled, but continue the user-initiated navigation as soon
        // as the exact target runtime appears instead of leaving the workspace
        // surface selected indefinitely.
        finishSidebarOperation(sidebarOperation.operationId, 'settled');
        if (targetSessionId && _navGuard === _navigationGuardEpoch) {
          void navigateToSessionMutationTarget(activeAgent.id, {
            targetSessionId,
            operationId: sidebarOperation.operationId,
          }, previousRuntimeId);
        }
        loadAgents().catch((error) => console.error('Failed to refresh agents after starting prebuilt runtime:', error));
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
      if (sidebarOperation?.operationId) {
        finishSidebarOperation(sidebarOperation.operationId, 'failed', { errorCode: 'session_open_failed' });
      }
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


// ── Remote history session activation (R2-01, ADR-0012 决策 2) ──────────────
// 点击远程历史会话 = 与本地完全相同的激活语义（activate → 目标宿主启动
// runtime），无确认层、无远程特判 UI。激活后远程 catalog 出现运行中 runtime，
// Phase 1.5 统一投影自动带出（零新代码）；此处轮询目录条目出现后切换焦点。
// 断线/远程不可达按 ADR-0011 三分类由 operation 契约显式呈现。
window._activateRemoteHistorySession = async function(hostNsId, sessionId, triggerButton) {
  if (triggerButton) markActionLoading(triggerButton);
  try {
    const response = await fetch('/protoclaw/prebuilt_sessions/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
      body: JSON.stringify({
        agentId: hostNsId,
        sessionId,
        responseMode: 'delta',
      }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      // 契约失败形态（三分类）显式呈现，不静默排队、不伪装成功。
      throw new Error(result?.message || result?.error || (await response.text().catch(() => `HTTP ${response.status}`)));
    }
    window.ClawToast?.show?.({
      id: `remote-activate-${result?.session?.id || sessionId}`,
      status: 'success',
      title: currentLanguage === 'zh' ? '远程会话已启动' : 'Remote session started',
      description: result?.session?.title || '',
    });
    // 远程 runtime 经 Phase 1.5 投影自动进入侧栏；等待目录条目出现后切换。
    const runtimeRef = await _waitForRemoteRuntimeForSession(sessionId, 50);
    if (runtimeRef) {
      await window.switchAgent(runtimeRef);
    } else {
      // 会话已在远程激活；runtime 就绪有延迟时留给 catalog 轮询自然带出。
      void loadAgents();
      if (typeof renderCurrentMainView === 'function') renderCurrentMainView();
    }
  } catch (error) {
    window.alert(`Session failed: ${error && error.message ? error.message : error}`);
  } finally {
    if (triggerButton) triggerButton.classList.remove('action-loading');
  }
};

// 轮询远程目录直到目标会话的 runtime 出现（远程 activate 启动 runtime 的
// 就绪观察）。目录身份：entry.sessionId 命名空间化匹配目标会话。
async function _waitForRemoteRuntimeForSession(namespacedSessionId, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (typeof window.RemoteConnections?.resolveRuntimeRef === 'function') {
      const runtimeRef = window.RemoteConnections.resolveRuntimeRef(namespacedSessionId);
      if (runtimeRef) return runtimeRef;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}