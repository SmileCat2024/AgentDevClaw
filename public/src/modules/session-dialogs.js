/**
 * Session Dialogs 模块 (Trim / Branch)
 * 从 app-main.js 拆出 (域 R: trim/branch dialog)
 *
 * 依赖全局状态 (定义在 app-core.js):
 *   currentLanguage
 * 依赖全局函数:
 *   renderCurrentMainView, escapeHtml, closeCompactMenu,
 *   getCurrentAgentRecord, createCompactedResumeSession,
 *   loadAgents, applyManagedPrebuiltAgent, setPreferredUnitMode,
 *   markSessionLoading, clearSessionLoading, window.switchAgent
 * 导出全局函数 (window.*):
 *   openTrimDialog, closeTrimDialog, submitTrimCompact,
 *   openBranchDialog, closeBranchDialog, submitBranch
 */

/* ── Trim dialog state ── */
let trimDialogState = { agentId: '', sessionId: '', rounds: [], loading: false, keepSkillInvokes: 5 };
const trimDialog = document.getElementById('trim-dialog');
const trimRoundList = document.getElementById('trim-round-list');
const trimFooterInfo = document.getElementById('trim-footer-info');
const trimKeepSkillToggle = document.getElementById('trim-keep-skill-toggle');
const trimKeepSkillControl = document.getElementById('trim-keep-skill-control');
const trimKeepSkillValue = document.getElementById('trim-keep-skill-value');
const trimKeepSkillDec = document.getElementById('trim-keep-skill-dec');
const trimKeepSkillInc = document.getElementById('trim-keep-skill-inc');

const SKILL_INVOKE_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, Infinity];

function getSkillStepIndex(value) {
  const idx = SKILL_INVOKE_STEPS.indexOf(value);
  return idx >= 0 ? idx : 4; // default 5
}

function renderSkillStepper() {
  const enabled = trimKeepSkillToggle.checked;
  trimKeepSkillControl.classList.toggle('disabled', !enabled);
  const value = trimDialogState.keepSkillInvokes;
  trimKeepSkillValue.textContent = value === Infinity ? '∞' : String(value);
}

trimKeepSkillToggle.addEventListener('change', () => {
  if (trimKeepSkillToggle.checked) {
    trimDialogState.keepSkillInvokes = SKILL_INVOKE_STEPS[4]; // reset to 5
  } else {
    trimDialogState.keepSkillInvokes = null;
  }
  renderSkillStepper();
});

trimKeepSkillDec.addEventListener('click', () => {
  const cur = getSkillStepIndex(trimDialogState.keepSkillInvokes);
  if (cur > 0) {
    trimDialogState.keepSkillInvokes = SKILL_INVOKE_STEPS[cur - 1];
    renderSkillStepper();
  }
});

trimKeepSkillInc.addEventListener('click', () => {
  const cur = getSkillStepIndex(trimDialogState.keepSkillInvokes);
  if (cur < SKILL_INVOKE_STEPS.length - 1) {
    trimDialogState.keepSkillInvokes = SKILL_INVOKE_STEPS[cur + 1];
    renderSkillStepper();
  }
});

window.openTrimDialog = async (agentId, sessionId, archiveAfter = false) => {
  trimDialogState = { agentId, sessionId, rounds: [], loading: true, keepSkillInvokes: 5, archiveAfter };
  trimKeepSkillToggle.checked = true;
  renderSkillStepper();
  closeCompactMenu();
  // Update title and submit button to reflect archive behavior
  const trimTitleEl = trimDialog.querySelector('.trim-title');
  const trimSubmitEl = document.getElementById('trim-submit');
  if (archiveAfter) {
    if (trimTitleEl) trimTitleEl.textContent = currentLanguage === 'zh' ? '精简历史并归档原会话' : 'Trim & Archive Original';
    if (trimSubmitEl) trimSubmitEl.textContent = currentLanguage === 'zh' ? '精简并归档' : 'Trim & Archive';
  } else {
    if (trimTitleEl) trimTitleEl.textContent = currentLanguage === 'zh' ? '精简历史（Trim）' : 'Trim';
    if (trimSubmitEl) trimSubmitEl.textContent = currentLanguage === 'zh' ? '确认精简' : 'Confirm Trim';
  }
  trimDialog.style.display = '';
  document.getElementById('trim-submit').disabled = true;
  trimRoundList.innerHTML = '<div class="trim-loading">加载中...</div>';
  trimFooterInfo.textContent = '';

  try {
    const res = await fetch('/protoclaw/session_trim_preview?agentId=' + encodeURIComponent(agentId) + '&sessionId=' + encodeURIComponent(sessionId));
    if (!res.ok) throw new Error(await res.text().catch(() => 'failed'));
    const data = await res.json();
    trimDialogState.rounds = data.rounds || [];
    trimDialogState.loading = false;
    if (trimDialogState.rounds.length === 0) {
      trimRoundList.innerHTML = '<div class="trim-loading">无可用轮次</div>';
      trimFooterInfo.textContent = '';
      return;
    }
    document.getElementById('trim-submit').disabled = false;
    renderTrimRoundList();
  } catch (err) {
    trimRoundList.innerHTML = '<div class="trim-loading">加载失败：' + escapeHtml(err.message || err) + '</div>';
    trimFooterInfo.textContent = '';
  }
};

window.closeTrimDialog = () => {
  trimDialog.style.display = 'none';
  trimDialogState = { agentId: '', sessionId: '', rounds: [], loading: false, keepSkillInvokes: 5, archiveAfter: false };
};

function renderTrimRoundList() {
  const rounds = trimDialogState.rounds;
  if (!rounds.length) {
    trimRoundList.innerHTML = '<div class="trim-loading">无可用轮次</div>';
    return;
  }

  trimRoundList.innerHTML = rounds.map((r, idx) => {
    const checked = r.suggestedTrim ? ' checked' : '';
    const trimmedClass = r.suggestedTrim ? ' trimmed' : '';

    return [
      `<div class="trim-round-item${trimmedClass}" data-trim-index="${idx}">`,
      `<input type="checkbox" class="trim-checkbox" data-trim-index="${idx}"${checked} />`,
      `<div class="trim-round-content">`,
      `<div class="trim-round-index">第 ${idx + 1} 轮${r.messageCount ? ' · ' + r.messageCount + ' 条消息' : ''}${r.toolCalls && r.toolCalls.length ? ' · <span class="trim-tool-count">' + r.toolCalls.length + ' 次调用</span>' : ''}</div>`,
      r.userPreview ? `<div class="trim-round-preview">${escapeHtml(r.userPreview)}</div>` : '',
      `</div>`,
      `<button class="trim-to-here-btn" type="button" data-trim-to="${idx}">精简到此处</button>`,
      `</div>`,
    ].join('');
  }).join('');

  updateTrimFooterInfo();
}

function handleTrimCheckboxChange(event) {
  const cb = event.target;
  if (!cb.classList.contains('trim-checkbox')) return;
  const idx = parseInt(cb.dataset.trimIndex, 10);
  const item = cb.closest('.trim-round-item');
  if (cb.checked) {
    item.classList.add('trimmed');
  } else {
    item.classList.remove('trimmed');
  }
  trimDialogState.rounds[idx].suggestedTrim = cb.checked;
  updateTrimFooterInfo();
}

function handleTrimToHere(event) {
  const btn = event.target.closest('.trim-to-here-btn');
  if (!btn) return;
  const targetIdx = parseInt(btn.dataset.trimTo, 10);
  const rounds = trimDialogState.rounds;
  for (let i = 0; i < rounds.length; i++) {
    const shouldTrim = i <= targetIdx;
    rounds[i].suggestedTrim = shouldTrim;
  }
  trimRoundList.querySelectorAll('.trim-round-item').forEach((item, idx) => {
    const cb = item.querySelector('.trim-checkbox');
    if (rounds[idx].suggestedTrim) {
      item.classList.add('trimmed');
      cb.checked = true;
    } else {
      item.classList.remove('trimmed');
      cb.checked = false;
    }
  });
  updateTrimFooterInfo();
}

function updateTrimFooterInfo() {
  const rounds = trimDialogState.rounds;
  const trimmed = rounds.filter(r => r.suggestedTrim).length;
  const kept = rounds.length - trimmed;
  trimFooterInfo.textContent = currentLanguage === 'zh'
    ? `共 ${rounds.length} 轮，精简 ${trimmed} 轮，保留 ${kept} 轮`
    : `${rounds.length} rounds, trim ${trimmed}, keep ${kept}`;
}

trimRoundList.addEventListener('change', handleTrimCheckboxChange);
trimRoundList.addEventListener('click', handleTrimToHere);

window.submitTrimCompact = async () => {
  const { agentId, sessionId, rounds, keepSkillInvokes, archiveAfter } = trimDialogState;
  if (!agentId || !sessionId || !rounds.length) return;
  bumpNavigationGuard();
  const _navGuard = _navigationGuardEpoch;

  // Compute the set of turns to preserve as-is (full detail).
  // Using preservedTurns instead of fullPreserveFromTurn supports non-contiguous
  // selections (e.g. "keep round 0, fold rounds 1-N"). fullPreserveFromTurn=N
  // would preserve everything from turn N onwards, which breaks when N=0.
  const keptRounds = rounds.filter(r => !r.suggestedTrim);

  const policy = {};
  if (keptRounds.length > 0) {
    policy.preservedTurns = keptRounds.map(r => r.turnStart);
  }
  if (keepSkillInvokes != null && keepSkillInvokes > 0) {
    policy.keepRecentSkillInvokes = keepSkillInvokes;
  }

  window.closeTrimDialog();
  markSessionLoading(agentId, sessionId);
  const _oldRuntimeId = currentRuntimeAgentId;
  let archiveRollback = null;
  if (archiveAfter && typeof markSessionArchivedForMutation === 'function') {
    archiveRollback = markSessionArchivedForMutation(agentId, sessionId, 'trim');
  }
  const sourceAgent = allAgents.find((item) => item.id === agentId) || null;
  const sourceSession = getWorkspaceSessionById(sourceAgent, sessionId);
  const trimOperation = archiveRollback?.operationId
    ? getSidebarOperation(archiveRollback.operationId)
    : beginSidebarOperation({
        type: 'create',
        kind: 'trim',
        phase: 'generating',
        agentId,
        sourceSessionId: sessionId,
        sourceRuntimeId: _oldRuntimeId || '',
        projectDir: sourceSession?.openDirectory || '',
        projectName: getPathLeaf(sourceSession?.openDirectory || ''),
        title: sourceSession?.title || '',
      });

  try {
    const trimmedCount = rounds.filter(r => r.suggestedTrim).length;
    const result = await createCompactedResumeSession(agentId, sessionId, '', null, null, policy, {
      reason: 'trim',
      trimCutRounds: trimmedCount,
      archiveOriginal: archiveAfter,
      operationId: trimOperation?.operationId || '',
    });
    if (typeof applySidebarMutationDeltaWithDiagnostics === 'function') {
      applySidebarMutationDeltaWithDiagnostics(trimOperation?.operationId, agentId, result);
    } else if (typeof applySessionMutationDelta === 'function') {
      applySessionMutationDelta(agentId, result);
    }
    const archiveSucceeded = !archiveAfter || result?.archive?.succeeded === true;
    if (!archiveSucceeded && archiveRollback) {
      archiveRollback();
      archiveRollback = null;
    }
    const targetSessionId = String(result?.session?.id || '').trim();
    updateSidebarOperation(trimOperation?.operationId, {
      phase: 'target-starting',
      targetSessionId,
      title: result?.session?.title || trimOperation?.title || '',
      serverRevision: result?.revision ?? null,
    });
    let readyAgent = null;
    try {
      readyAgent = await waitForSidebarTargetRuntime(trimOperation?.operationId, agentId, targetSessionId, result);
    } catch (error) {
      console.error('Trim target runtime is not ready:', error);
    }
    const connectedTarget = readyAgent ? (upsertConnectedAgent(readyAgent) || readyAgent) : null;
    const nextRuntimeId = connectedTarget?.runtime_session_id
      || connectedTarget?.runtimeSessionId
      || connectedTarget?.id
      || null;
    if (archiveAfter && archiveSucceeded) {
      updateSessionReplacementMutation(agentId, sessionId, {
        phase: nextRuntimeId ? 'target-ready' : 'degraded',
        targetSessionId: result?.session?.id || '',
        targetRuntimeId: nextRuntimeId || '',
        serverRevision: result?.revision ?? null,
        ...(!nextRuntimeId ? { errorCode: 'target_runtime_not_ready' } : {}),
      });
    } else if (nextRuntimeId) {
      updateSidebarOperation(trimOperation?.operationId, { phase: 'target-ready', targetRuntimeId: nextRuntimeId });
    } else {
      updateSidebarOperation(trimOperation?.operationId, { phase: 'degraded', errorCode: 'target_runtime_not_ready' });
    }
    if (_navGuard !== _navigationGuardEpoch) {
      if (archiveAfter && archiveSucceeded && _oldRuntimeId) {
        updateSessionReplacementMutation(agentId, sessionId, { phase: 'source-stopping' });
        clearAgentRuntimeCache(_oldRuntimeId);
        try { await invoke('stop_agent', { agentId, sessionId }); } catch {}
        refreshSidebarRuntimeAfterMutation(500);
        settleSessionReplacementMutation(agentId, sessionId, 700);
      }
      if (archiveAfter && archiveSucceeded && !_oldRuntimeId) clearSessionReplacementMutation(agentId, sessionId);
      if (!archiveAfter && nextRuntimeId) finishSidebarOperation(trimOperation?.operationId, 'settled');
      archiveRollback = null;
      return;
    }
    if (nextRuntimeId) {
      if (archiveAfter) updateSessionReplacementMutation(agentId, sessionId, { phase: 'switching' });
      setPreferredUnitMode('chat', allAgents.find((agent) => agent.id === agentId) || getCurrentAgentRecord());
      beginChatLoadingSession();
      await requestSwitch(nextRuntimeId, 'trim');
      if (!archiveAfter) finishSidebarOperation(trimOperation?.operationId, 'settled');
    } else {
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
    }
    // 服务端已原子完成归档，只需停止旧 runtime
    if (archiveAfter && archiveSucceeded && _oldRuntimeId) {
      updateSessionReplacementMutation(agentId, sessionId, { phase: 'source-stopping' });
      clearAgentRuntimeCache(_oldRuntimeId);
      try { await invoke('stop_agent', { agentId, sessionId }); } catch {}
      refreshSidebarRuntimeAfterMutation(500);
      settleSessionReplacementMutation(agentId, sessionId, 700);
    }
    if (archiveAfter && archiveSucceeded && !_oldRuntimeId) clearSessionReplacementMutation(agentId, sessionId);
    if (archiveAfter && !archiveSucceeded) {
      window.alert((currentLanguage === 'zh' ? '新会话已创建，但原会话归档失败：' : 'The new session was created, but the original could not be archived: ') + (result?.archive?.error || 'unknown error'));
    }
    loadAgents().catch(e => console.warn(e));
    archiveRollback = null;
  } catch (error) {
    console.error('Failed to trim compact session:', error);
    if (archiveRollback) {
      archiveRollback();
      archiveRollback = null;
    } else if (trimOperation?.operationId) {
      finishSidebarOperation(trimOperation.operationId, 'failed', { errorCode: 'trim_failed' });
    }
    clearSessionLoading(agentId);
    clearChatLoadingSession();
    window.alert((currentLanguage === 'zh' ? '精简失败：' : 'Trim failed: ') + (error?.message || error));
  }
};

/* ── Branch dialog state ── */
let branchDialogState = { agentId: '', sessionId: '', rounds: [], selectedIdx: -1, archiveAfter: false };
const branchDialog = document.getElementById('branch-dialog');
const branchRoundList = document.getElementById('branch-round-list');
const branchFooterInfo = document.getElementById('branch-footer-info');

window.openBranchDialog = async (agentId, sessionId, archiveAfter = false) => {
  branchDialogState = { agentId, sessionId, rounds: [], selectedIdx: -1, archiveAfter };
  closeCompactMenu();
  // Update title and submit button to reflect archive behavior
  const branchTitleEl = branchDialog.querySelector('.trim-title');
  const branchSubmitEl = document.getElementById('branch-submit');
  if (archiveAfter) {
    if (branchTitleEl) branchTitleEl.textContent = currentLanguage === 'zh' ? '创建分支并归档原会话' : 'Branch & Archive Original';
    if (branchSubmitEl) branchSubmitEl.textContent = currentLanguage === 'zh' ? '分支并归档' : 'Branch & Archive';
  } else {
    if (branchTitleEl) branchTitleEl.textContent = currentLanguage === 'zh' ? '分支' : 'Branch';
    if (branchSubmitEl) branchSubmitEl.textContent = currentLanguage === 'zh' ? '创建分支' : 'Create Branch';
  }
  branchDialog.style.display = '';
  document.getElementById('branch-submit').disabled = true;
  branchRoundList.innerHTML = '<div class="trim-loading">加载中...</div>';
  branchFooterInfo.textContent = '';

  try {
    const res = await fetch('/protoclaw/session_trim_preview?agentId=' + encodeURIComponent(agentId) + '&sessionId=' + encodeURIComponent(sessionId));
    if (!res.ok) throw new Error(await res.text().catch(() => 'failed'));
    const data = await res.json();
    branchDialogState.rounds = data.rounds || [];
    if (branchDialogState.rounds.length === 0) {
      branchRoundList.innerHTML = '<div class="trim-loading">无可用轮次</div>';
      branchFooterInfo.textContent = '';
      return;
    }
    renderBranchRoundList();
  } catch (err) {
    branchRoundList.innerHTML = '<div class="trim-loading">加载失败：' + escapeHtml(err.message || err) + '</div>';
    branchFooterInfo.textContent = '';
  }
};

window.closeBranchDialog = () => {
  branchDialog.style.display = 'none';
  branchDialogState = { agentId: '', sessionId: '', rounds: [], selectedIdx: -1, archiveAfter: false };
};

function renderBranchRoundList() {
  const rounds = branchDialogState.rounds;
  if (!rounds.length) {
    branchRoundList.innerHTML = '<div class="trim-loading">无可用轮次</div>';
    return;
  }

  branchRoundList.innerHTML = rounds.map((r, idx) => {
    return [
      `<div class="trim-round-item branch-selectable" data-branch-index="${idx}">`,
      `<div class="trim-round-content">`,
      `<div class="trim-round-index">第 ${idx + 1} 轮${r.messageCount ? ' · ' + r.messageCount + ' 条消息' : ''}${r.toolCalls && r.toolCalls.length ? ' · <span class="trim-tool-count">' + r.toolCalls.length + ' 次调用</span>' : ''}</div>`,
      r.userPreview ? `<div class="trim-round-preview">${escapeHtml(r.userPreview)}</div>` : '',
      `</div>`,
      `</div>`,
    ].join('');
  }).join('');

  updateBranchFooterInfo();
}

function handleBranchRoundClick(event) {
  const item = event.target.closest('.trim-round-item[data-branch-index]');
  if (!item) return;
  const idx = parseInt(item.dataset.branchIndex, 10);
  if (isNaN(idx)) return;
  branchDialogState.selectedIdx = idx;
  document.getElementById('branch-submit').disabled = false;

  const items = branchRoundList.querySelectorAll('.trim-round-item[data-branch-index]');
  items.forEach((el, i) => {
    el.classList.remove('branch-kept', 'branch-cut', 'branch-dimmed');
    if (i <= idx) {
      el.classList.add('branch-kept');
    } else {
      el.classList.add('branch-dimmed');
    }
    if (i === idx) {
      el.classList.add('branch-cut');
    }
  });
  updateBranchFooterInfo();
}

function updateBranchFooterInfo() {
  const rounds = branchDialogState.rounds;
  const idx = branchDialogState.selectedIdx;
  if (idx < 0 || !rounds.length) {
    branchFooterInfo.textContent = currentLanguage === 'zh'
      ? `共 ${rounds.length} 轮，点击选择分支点`
      : `${rounds.length} rounds, click to select branch point`;
    return;
  }
  const kept = idx + 1;
  const cut = rounds.length - kept;
  branchFooterInfo.textContent = currentLanguage === 'zh'
    ? `共 ${rounds.length} 轮，保留 ${kept} 轮，截断 ${cut} 轮`
    : `${rounds.length} rounds, keep ${kept}, cut ${cut}`;
}

branchRoundList.addEventListener('click', handleBranchRoundClick);

window.submitBranch = async () => {
  const { agentId, sessionId, rounds, selectedIdx, archiveAfter } = branchDialogState;
  if (!agentId || !sessionId || selectedIdx < 0 || !rounds.length) return;
  bumpNavigationGuard();
  const _navGuard = _navigationGuardEpoch;

  const cutMsgIndexEnd = rounds[selectedIdx].msgIndexEnd;

  window.closeBranchDialog();
  markSessionLoading(agentId, sessionId);
  const _oldRuntimeId = currentRuntimeAgentId;
  let archiveRollback = null;
  if (archiveAfter && typeof markSessionArchivedForMutation === 'function') {
    archiveRollback = markSessionArchivedForMutation(agentId, sessionId, 'branch');
  }
  const sourceAgent = allAgents.find((item) => item.id === agentId) || null;
  const sourceSession = getWorkspaceSessionById(sourceAgent, sessionId);
  const branchOperation = archiveRollback?.operationId
    ? getSidebarOperation(archiveRollback.operationId)
    : beginSidebarOperation({
        type: 'create',
        kind: 'branch',
        phase: 'generating',
        agentId,
        sourceSessionId: sessionId,
        sourceRuntimeId: _oldRuntimeId || '',
        projectDir: sourceSession?.openDirectory || '',
        projectName: getPathLeaf(sourceSession?.openDirectory || ''),
        title: sourceSession?.title || '',
      });

  try {
    const res = await fetch('/protoclaw/sessions/branch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId,
        sourceSessionId: sessionId,
        cutMsgIndexEnd,
        archiveOriginal: archiveAfter,
        responseMode: 'delta',
        operationId: branchOperation?.operationId || createSidebarOperationId('branch'),
      }),
    });
    if (!res.ok) throw new Error(await res.text().catch(() => 'failed'));
    const result = await res.json();
    if (typeof applySessionMutationDelta === 'function') applySessionMutationDelta(agentId, result);
    const archiveSucceeded = !archiveAfter || result?.archive?.succeeded === true;
    if (!archiveSucceeded && archiveRollback) {
      archiveRollback();
      archiveRollback = null;
    }

    const targetSessionId = String(result?.newSessionId || '').trim();
    updateSidebarOperation(branchOperation?.operationId, {
      phase: 'target-starting',
      targetSessionId,
      title: result?.branchTitle || branchOperation?.title || '',
      serverRevision: result?.revision ?? null,
    });
    let readyAgent = null;
    try {
      readyAgent = await waitForSidebarTargetRuntime(branchOperation?.operationId, agentId, targetSessionId, result);
    } catch (error) {
      console.error('Branch target runtime is not ready:', error);
    }
    const connectedTarget = readyAgent ? (upsertConnectedAgent(readyAgent) || readyAgent) : null;
    const nextRuntimeId = connectedTarget?.runtime_session_id
      || connectedTarget?.runtimeSessionId
      || connectedTarget?.id
      || null;
    if (archiveAfter && archiveSucceeded) {
      updateSessionReplacementMutation(agentId, sessionId, {
        phase: nextRuntimeId ? 'target-ready' : 'degraded',
        targetSessionId: result?.newSessionId || '',
        targetRuntimeId: nextRuntimeId || '',
        serverRevision: result?.revision ?? null,
        ...(!nextRuntimeId ? { errorCode: 'target_runtime_not_ready' } : {}),
      });
    } else if (nextRuntimeId) {
      updateSidebarOperation(branchOperation?.operationId, { phase: 'target-ready', targetRuntimeId: nextRuntimeId });
    } else {
      updateSidebarOperation(branchOperation?.operationId, { phase: 'degraded', errorCode: 'target_runtime_not_ready' });
    }
    if (_navGuard !== _navigationGuardEpoch) {
      if (archiveAfter && archiveSucceeded && _oldRuntimeId) {
        updateSessionReplacementMutation(agentId, sessionId, { phase: 'source-stopping' });
        clearAgentRuntimeCache(_oldRuntimeId);
        try { await invoke('stop_agent', { agentId, sessionId }); } catch {}
        refreshSidebarRuntimeAfterMutation(500);
        settleSessionReplacementMutation(agentId, sessionId, 700);
      }
      if (archiveAfter && archiveSucceeded && !_oldRuntimeId) clearSessionReplacementMutation(agentId, sessionId);
      if (!archiveAfter && nextRuntimeId) finishSidebarOperation(branchOperation?.operationId, 'settled');
      archiveRollback = null;
      return;
    }
    if (nextRuntimeId) {
      if (archiveAfter) updateSessionReplacementMutation(agentId, sessionId, { phase: 'switching' });
      setPreferredUnitMode('chat', allAgents.find((agent) => agent.id === agentId) || getCurrentAgentRecord());
      beginChatLoadingSession();
      await requestSwitch(nextRuntimeId, 'branch');
      if (!archiveAfter) finishSidebarOperation(branchOperation?.operationId, 'settled');
    } else {
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
    }
    // 服务端已原子完成归档，只需停止旧 runtime
    if (archiveAfter && archiveSucceeded && _oldRuntimeId) {
      updateSessionReplacementMutation(agentId, sessionId, { phase: 'source-stopping' });
      clearAgentRuntimeCache(_oldRuntimeId);
      try { await invoke('stop_agent', { agentId, sessionId }); } catch {}
      refreshSidebarRuntimeAfterMutation(500);
      settleSessionReplacementMutation(agentId, sessionId, 700);
    }
    if (archiveAfter && archiveSucceeded && !_oldRuntimeId) clearSessionReplacementMutation(agentId, sessionId);
    if (archiveAfter && !archiveSucceeded) {
      window.alert((currentLanguage === 'zh' ? '新分支已创建，但原会话归档失败：' : 'The branch was created, but the original could not be archived: ') + (result?.archive?.error || 'unknown error'));
    }
    loadAgents().catch(e => console.warn(e));
    archiveRollback = null;
  } catch (error) {
    console.error('Failed to branch session:', error);
    if (archiveRollback) {
      archiveRollback();
      archiveRollback = null;
    } else if (branchOperation?.operationId) {
      finishSidebarOperation(branchOperation.operationId, 'failed', { errorCode: 'branch_failed' });
    }
    clearSessionLoading(agentId);
    clearChatLoadingSession();
    window.alert((currentLanguage === 'zh' ? '分支失败：' : 'Branch failed: ') + (error?.message || error));
  }
};

// ── End Session Dialogs ────────────────────────────────────────────
