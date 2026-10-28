/**
 * Session Dialogs 模块 (Branch)
 * 从 app-main.js 拆出 (域 R: trim/branch dialog)
 *
 * Trim 对话框已由统一精简页面（trim-page.js）替代并删除；
 * 本模块只保留分支对话框。
 *
 * 依赖全局状态 (定义在 app-core.js):
 *   currentLanguage
 * 依赖全局函数:
 *   renderCurrentMainView, escapeHtml, closeCompactMenu,
 *   getCurrentAgentRecord, createCompactedResumeSession,
 *   loadAgents, applyManagedPrebuiltAgent, setPreferredUnitMode,
 *   markSessionLoading, clearSessionLoading, window.switchAgent,
 *   fmtPct (app-core.js，trim/branch 共用口径)
 * 导出全局函数 (window.*):
 *   openBranchDialog, closeBranchDialog, submitBranch,
 *   phOpenRenameDialog, phCloseRenameDialog（重命名对话框，动态 overlay）
 */

/* ── Branch dialog state ── */
let branchDialogState = { agentId: '', sessionId: '', rounds: [], preamblePercent: 0, selectedIdx: -1, archiveAfter: false };
const branchDialog = document.getElementById('branch-dialog');
const branchRoundList = document.getElementById('branch-round-list');
const branchFooterInfo = document.getElementById('branch-footer-info');

function renderPreambleItem(preamblePercent) {
  if (preamblePercent <= 0) return '';
  const pct = fmtPct(preamblePercent);
  return `<div class="trim-preamble-item"><span class="trim-preamble-label">系统上下文</span><span class="trim-preamble-pct">${pct}</span></div>`;
}

// ── 幂等键（ADR-0011）：写类提交统一携带（本地忽略、远程强制）───────────
function newIdempotencyKey() {
  const cryptoObj = (typeof crypto !== 'undefined') ? crypto : null;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

window.openBranchDialog = async (agentId, sessionId, archiveAfter = false) => {
  // 线程宿主（ADR-0032）：分支即新线程，源会话留在原线程链内——「归档原
  // 会话」只对链中旧快照打不可见标志，与用户「归档这条对话」的预期错位，
  // 钳制关闭。远程会话不在本地线程索引（保守 false），归档透传契约不变。
  if (archiveAfter && typeof window.isThreadHostAgentId === 'function'
    && window.isThreadHostAgentId(agentId, sessionId)) {
    archiveAfter = false;
  }
  branchDialogState = { agentId, sessionId, rounds: [], preamblePercent: 0, selectedIdx: -1, archiveAfter };
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
    branchDialogState.snapshotRevision = data.snapshotRevision;
    branchDialogState.rounds = data.rounds || [];
    branchDialogState.preamblePercent = typeof data.preamblePercent === 'number' ? data.preamblePercent : 0;
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
  branchDialogState = { agentId: '', sessionId: '', rounds: [], preamblePercent: 0, selectedIdx: -1, archiveAfter: false };
};

function renderBranchRoundList() {
  const rounds = branchDialogState.rounds;
  if (!rounds.length) {
    branchRoundList.innerHTML = '<div class="trim-loading">无可用轮次</div>';
    return;
  }

  const preambleHtml = renderPreambleItem(branchDialogState.preamblePercent);

  const roundsHtml = rounds.map((r, idx) => {
    const pctText = fmtPct(r.charPercent || 0);
    const cumText = fmtPct(r.cumulativePercent || 0);

    return [
      `<div class="trim-round-item branch-selectable" data-branch-index="${idx}">`,
      `<div class="trim-round-content">`,
      `<div class="trim-round-meta">`,
      `<span class="trim-round-index">第 ${idx + 1} 轮${r.messageCount ? ' · ' + r.messageCount + ' 条消息' : ''}${r.toolCalls && r.toolCalls.length ? ' · ' + r.toolCalls.length + ' 次调用' : ''}</span>`,
      `<span class="trim-round-ctx">${pctText}<span class="trim-round-ctx-cum"> · 累计 ${cumText}</span></span>`,
      `</div>`,
      r.userPreview ? `<div class="trim-round-preview">${escapeHtml(r.userPreview)}</div>` : '',
      r.assistantPreview ? `<div class="trim-round-preview-sub">${escapeHtml(r.assistantPreview)}</div>` : '',
      `</div>`,
      `</div>`,
    ].join('');
  }).join('');

  branchRoundList.innerHTML = preambleHtml + roundsHtml;

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
  const cumPct = fmtPct(rounds[idx].cumulativePercent || 0);
  branchFooterInfo.innerHTML = currentLanguage === 'zh'
    ? `保留 ${kept} 轮 · 截断 ${cut} 轮 · 占用约 <span class="trim-footer-pct">${cumPct}</span> 上下文`
    : `Keep ${kept} · cut ${cut} · ~<span class="trim-footer-pct">${cumPct}</span> context`;
}

branchRoundList.addEventListener('click', handleBranchRoundClick);

window.submitBranch = async () => {
  const { agentId, sessionId, rounds, selectedIdx, archiveAfter, snapshotRevision } = branchDialogState;
  if (!agentId || !sessionId || selectedIdx < 0 || !rounds.length) return;
  bumpNavigationGuard();
  const _navGuard = _navigationGuardEpoch;

  const cutMsgIndexEnd = rounds[selectedIdx].msgIndexEnd;

  window.closeBranchDialog();
  markSessionLoading(agentId, sessionId);
  const _oldRuntimeId = currentRuntimeAgentId;
  let archiveRollback = null;
  let branchSessionCommitted = false;
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
        projectId: sourceSession?.projectId || '',
        projectDir: sourceSession?.openDirectory || '',
        projectName: getPathLeaf(sourceSession?.openDirectory || ''),
        title: sourceSession?.title || '',
      });

  try {
    // R2-02（ADR-0011）：远程命名空间 sessionId → 请求身份收敛为宿主级命名
    // 空间 id，服务端命名空间分支转发远程（新会话文件、checkpoint 提取全部
    // 发生在远程端）；本地身份原样。远程写强制幂等键（本地忽略）。
    const isRemoteSession = typeof isRemoteNamespaceAgentId === 'function' && isRemoteNamespaceAgentId(sessionId);
    const requestAgentId = isRemoteSession
      ? (window.RemoteConnections?.getHostNamespaceIdForSession?.(sessionId, agentId) || agentId)
      : agentId;
    const res = await fetch('/protoclaw/sessions/branch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
      body: JSON.stringify({
        agentId: requestAgentId,
        sourceSessionId: sessionId,
        cutMsgIndexEnd,
        snapshotRevision,
        archiveOriginal: archiveAfter,
        responseMode: 'delta',
        operationId: branchOperation?.operationId || createSidebarOperationId('branch'),
      }),
    });
    if (!res.ok) throw new Error(await res.text().catch(() => 'failed'));
    let result = await res.json();
    if (isRemoteSession) {
      // 远程响应中的裸新会话 id 数据层命名空间化（ADR-0012）。
      result = window.RemoteConnections?.namespaceMutationResult?.(sessionId, result) || result;
    }
    if (typeof applySessionMutationDelta === 'function') applySessionMutationDelta(agentId, result);
    const archiveSucceeded = !archiveAfter || result?.archive?.succeeded === true;
    if (!archiveSucceeded && archiveRollback) {
      archiveRollback();
      archiveRollback = null;
    }
    // 归档已提交：源 runtime 处置与新会话导航解耦，立即发起（内部含侧栏条目
    // 的乐观退场）。停靠在导航之后会让老条目等新会话页面完全加载完才开始关闭。
    if (archiveAfter && archiveSucceeded && !isRemoteSession) {
      reconcileArchivedSourceRuntime(agentId, sessionId, _oldRuntimeId);
    }

    const targetSessionId = String(result?.newSessionId || '').trim();
    branchSessionCommitted = Boolean(targetSessionId);
    updateSidebarOperation(branchOperation?.operationId, {
      phase: 'target-starting',
      targetSessionId,
      title: result?.branchTitle || branchOperation?.title || '',
      serverRevision: result?.revision ?? null,
    });
    // 远程目标：响应中的 agent 是远程端 runtime 形态（裸 id），不进入本地
    // allAgents——切换走目录轮询（R2-01 activate 同链路）。
    const readyAgent = (isRemoteSession ? null : result?.agent) || null;
    const connectedTarget = readyAgent ? (upsertConnectedAgent(readyAgent) || readyAgent) : null;
    const nextRuntimeId = connectedTarget ? (getRuntimeId(connectedTarget) || null) : null;
    // 服务端早响应（runtimeStart: 'async'）：本地分支的 runtime 在服务端后台
    // 启动，响应不含 agent。侧栏 operation 占位持续呈现"启动中"，就绪后由
    // 本任务接管导航——与 replacement 流程同一条 waitForRuntimeReady 管道。
    const backgroundRuntimeWait = (!readyAgent && !isRemoteSession && targetSessionId)
      ? waitForSidebarTargetRuntime(branchOperation?.operationId, agentId, targetSessionId, result, 300)
      : null;
    if (archiveAfter && archiveSucceeded) {
      // 归档与分支已共同提交；操作收尾只等 runtime 就绪接管导航，不因无关的
      // 源会话清理保持开启。
      if (!backgroundRuntimeWait) finishSidebarOperation(branchOperation?.operationId, 'settled');
    } else if (nextRuntimeId) {
      updateSidebarOperation(branchOperation?.operationId, { phase: 'target-ready', targetRuntimeId: nextRuntimeId });
    } else if (backgroundRuntimeWait) {
      // 保留 target-starting 占位，导航在 runtime 就绪后接管（下方 async 分支）。
    } else {
      finishSidebarOperation(branchOperation?.operationId, 'settled');
    }
    if (_navGuard !== _navigationGuardEpoch) {
      if (!archiveAfter && nextRuntimeId) finishSidebarOperation(branchOperation?.operationId, 'settled');
      archiveRollback = null;
      return;
    }
    if (isRemoteSession) {
      // 远程分支（ADR-0011/0012）：新会话与 runtime 都在远程端，等待远程
      // 目录投影带出新 runtime 后按命名空间引用切换（与 R2-01 activate 同
      // 链路）；请求失败由 sessionDelta/operation 契约呈现，不伪装成功。
      const runtimeRef = typeof window.RemoteConnections?.waitForRuntimeForSession === 'function'
        ? await window.RemoteConnections.waitForRuntimeForSession(targetSessionId, 50)
        : null;
      if (runtimeRef && _navGuard === _navigationGuardEpoch) {
        setPreferredUnitMode('chat', allAgents.find((agent) => agent.id === agentId) || getCurrentAgentRecord());
        beginChatLoadingSession();
        await requestSwitch(runtimeRef, 'branch');
        if (!archiveAfter) finishSidebarOperation(branchOperation?.operationId, 'settled');
      } else {
        lastRenderedWorkspaceHtml = '';
        renderCurrentMainView();
      }
    } else if (nextRuntimeId) {
      setPreferredUnitMode('chat', allAgents.find((agent) => agent.id === agentId) || getCurrentAgentRecord());
      beginChatLoadingSession();
      await requestSwitch(nextRuntimeId, 'branch');
      if (!archiveAfter) finishSidebarOperation(branchOperation?.operationId, 'settled');
    } else if (backgroundRuntimeWait) {
      // 本地分支 + runtime 后台启动中：等待就绪（轻量 runtime_status 轮询，
      // attempts=300 × 200ms 覆盖最慢的共享进程恢复场景），期间对话框已关闭、
      // 占位常驻，用户可继续其他操作。就绪即接管导航；超时/停止降级呈现。
      const navigationEpoch = _navigationGuardEpoch;
      backgroundRuntimeWait.then((targetAgent) => {
        if (navigationEpoch !== _navigationGuardEpoch) {
          // 用户已在等待期间发起其他导航：不降级也不抢焦点，runtime 叶子
          // 由侧栏轮询自然带出，操作静默收尾。
          finishSidebarOperation(branchOperation?.operationId, 'settled');
          return;
        }
        if (!targetAgent) {
          updateSidebarOperation(branchOperation?.operationId, { phase: 'degraded', errorCode: 'target_runtime_stopped' });
          return;
        }
        const runtimeTarget = upsertConnectedAgent(targetAgent) || targetAgent;
        const runtimeId = getRuntimeId(runtimeTarget) || '';
        if (!runtimeId) {
          updateSidebarOperation(branchOperation?.operationId, { phase: 'degraded', errorCode: 'target_runtime_stopped' });
          return;
        }
        updateSidebarOperation(branchOperation?.operationId, { phase: 'target-ready', targetRuntimeId: runtimeId });
        setPreferredUnitMode('chat', allAgents.find((agent) => agent.id === agentId) || getCurrentAgentRecord());
        beginChatLoadingSession();
        return requestSwitch(runtimeId, 'branch').then(() => {
          finishSidebarOperation(branchOperation?.operationId, 'settled');
        });
      }).catch(() => {
        updateSidebarOperation(branchOperation?.operationId, { phase: 'degraded', errorCode: 'target_runtime_stopped' });
      });
    } else {
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
    }
    if (archiveAfter && !archiveSucceeded) {
      window.alert((currentLanguage === 'zh' ? '新分支已创建，但原会话归档失败：' : 'The branch was created, but the original could not be archived: ') + (result?.archive?.error || 'unknown error'));
    }
    loadAgents().catch(e => console.warn(e));
    archiveRollback = null;
  } catch (error) {
    console.error('Failed to branch session:', error);
    if (!branchSessionCommitted) {
      if (archiveRollback) {
        archiveRollback();
        archiveRollback = null;
      } else if (branchOperation?.operationId) {
        finishSidebarOperation(branchOperation.operationId, 'failed', { errorCode: 'branch_failed' });
      }
      window.alert((currentLanguage === 'zh' ? '分支失败：' : 'Branch failed: ') + (error?.message || error));
    } else {
      finishSidebarOperation(branchOperation?.operationId, 'settled');
      archiveRollback = null;
    }
    clearSessionLoading(agentId);
    clearChatLoadingSession();
  }
};

/* ════════════════════════════════════════════════════════════
   Rename dialog（统一对话菜单的主列表「重命名」入口）
   动态 overlay 配方复用 feature-detail-overlay/window（ph-thread-history
   同款），不自造同类控件。保存链路与侧栏内联重命名（ctxRenameSession）
   同一端点与刷新路径。
   ════════════════════════════════════════════════════════════ */
let _renameOverlay = null;

function _closeRenameDialog() {
  if (_renameOverlay && _renameOverlay.parentNode) {
    _renameOverlay.parentNode.removeChild(_renameOverlay);
  }
  _renameOverlay = null;
}

window.phCloseRenameDialog = _closeRenameDialog;

window.phOpenRenameDialog = async function (agentId, sessionId) {
  _closeRenameDialog();
  if (!agentId || !sessionId) return;
  const isZh = currentLanguage === 'zh';
  // 当前标题：本地缓存优先，取不到时由列表行数据兜底
  const agent = (typeof allAgents !== 'undefined' ? allAgents : []).find((item) => item.id === agentId) || null;
  const session = (agent?.workspace_sessions?.sessions || []).find((s) => s.id === sessionId) || null;
  const currentTitle = session?.title || sessionId;

  const overlay = document.createElement('div');
  overlay.className = 'feature-detail-overlay';
  overlay.innerHTML = [
    '<form class="feature-detail-window" role="dialog" aria-modal="true" onsubmit="return false" style="max-width:420px">',
    '<div class="feature-detail-header">',
    '<div class="feature-detail-title">' + (isZh ? '重命名对话' : 'Rename Conversation') + '</div>',
    '<button type="button" class="feature-detail-close" onclick="window.phCloseRenameDialog()" aria-label="' + (isZh ? '关闭' : 'Close') + '">&times;</button>',
    '</div>',
    '<div style="display:flex;flex-direction:column;gap:12px;padding:16px">',
    '<input type="text" class="agent-name-edit-input" data-rename-input value="' + escapeHtml(currentTitle) + '"',
    ' maxlength="120" placeholder="' + (isZh ? '输入标题' : 'Enter title') + '"',
    ' style="width:100%;box-sizing:border-box;padding:8px 10px"> ',
    '<div style="display:flex;justify-content:flex-end;gap:8px">',
    '<button type="button" class="workspace-action secondary" onclick="window.phCloseRenameDialog()">' + (isZh ? '取消' : 'Cancel') + '</button>',
    '<button type="button" class="workspace-action" data-rename-save>' + (isZh ? '保存' : 'Save') + '</button>',
    '</div>',
    '</div>',
    '</form>',
  ].join('');
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) _closeRenameDialog();
  });

  const input = overlay.querySelector('[data-rename-input]');
  const saveBtn = overlay.querySelector('[data-rename-save]');
  let saved = false;

  const save = async () => {
    if (saved) return;
    const newTitle = String(input.value || '').trim();
    if (!newTitle || newTitle === currentTitle) {
      _closeRenameDialog();
      return;
    }
    saved = true;
    saveBtn.disabled = true;
    try {
      const resp = await fetch('/protoclaw/prebuilt_sessions/' + encodeURIComponent(sessionId) + '/title', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
        body: JSON.stringify({ agentId, title: newTitle }),
      });
      const result = await resp.json();
      if (resp.ok && result.ok) {
        _closeRenameDialog();
        if (typeof applySessionMutationDelta === 'function') applySessionMutationDelta(agentId, result);
        if (typeof lastRenderedWorkspaceHtml !== 'undefined') lastRenderedWorkspaceHtml = '';
        if (typeof renderCurrentMainView === 'function') renderCurrentMainView();
        if (typeof renderAgentList === 'function') renderAgentList();
      } else {
        saved = false;
        saveBtn.disabled = false;
        ClawToast.show({ title: (isZh ? '重命名失败：' : 'Rename failed: ') + (result?.error || 'unknown'), status: 'error' });
      }
    } catch (error) {
      saved = false;
      saveBtn.disabled = false;
      ClawToast.show({ title: (isZh ? '重命名失败：' : 'Rename failed: ') + (error?.message || error), status: 'error' });
    }
  };

  saveBtn.addEventListener('click', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); _closeRenameDialog(); }
  });

  document.body.appendChild(overlay);
  _renameOverlay = overlay;
  input.focus();
  input.select();
};

// ── End Session Dialogs ────────────────────────────────────────────
