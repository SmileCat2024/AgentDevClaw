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

window.openTrimDialog = async (agentId, sessionId) => {
  trimDialogState = { agentId, sessionId, rounds: [], loading: true, keepSkillInvokes: 5 };
  trimKeepSkillToggle.checked = true;
  renderSkillStepper();
  closeCompactMenu();
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
  trimDialogState = { agentId: '', sessionId: '', rounds: [], loading: false, keepSkillInvokes: 5 };
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
  const { agentId, sessionId, rounds, keepSkillInvokes } = trimDialogState;
  if (!agentId || !sessionId || !rounds.length) return;

  let fullPreserveFromTurn = null;
  const firstKeptIndex = rounds.findIndex(r => !r.suggestedTrim);
  if (firstKeptIndex >= 0) {
    fullPreserveFromTurn = rounds[firstKeptIndex].turnStart;
  }

  const policy = {};
  if (keepSkillInvokes != null && keepSkillInvokes > 0) {
    policy.keepRecentSkillInvokes = keepSkillInvokes;
  }

  window.closeTrimDialog();
  markSessionLoading(agentId, sessionId);

  try {
    const result = await createCompactedResumeSession(agentId, sessionId, '', null, fullPreserveFromTurn, policy);
    if (result?.agent) {
      applyManagedPrebuiltAgent(agentId, result.agent);
    }
    await loadAgents();
    const nextRuntimeId =
      result?.agent?.runtime_session_id
      || result?.agent?.runtimeSessionId
      || null;
    if (nextRuntimeId) {
      setPreferredUnitMode('chat', allAgents.find((agent) => agent.id === agentId) || getCurrentAgentRecord());
      await requestSwitch(nextRuntimeId, 'trim');
    } else {
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
    }
  } catch (error) {
    console.error('Failed to trim compact session:', error);
    clearSessionLoading(agentId);
    window.alert((currentLanguage === 'zh' ? '精简失败：' : 'Trim failed: ') + (error?.message || error));
  }
};

/* ── Branch dialog state ── */
let branchDialogState = { agentId: '', sessionId: '', rounds: [], selectedIdx: -1 };
const branchDialog = document.getElementById('branch-dialog');
const branchRoundList = document.getElementById('branch-round-list');
const branchFooterInfo = document.getElementById('branch-footer-info');

window.openBranchDialog = async (agentId, sessionId) => {
  branchDialogState = { agentId, sessionId, rounds: [], selectedIdx: -1 };
  closeCompactMenu();
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
  branchDialogState = { agentId: '', sessionId: '', rounds: [], selectedIdx: -1 };
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
  const { agentId, sessionId, rounds, selectedIdx } = branchDialogState;
  if (!agentId || !sessionId || selectedIdx < 0 || !rounds.length) return;

  const cutMsgIndexEnd = rounds[selectedIdx].msgIndexEnd;

  window.closeBranchDialog();
  markSessionLoading(agentId, sessionId);

  try {
    const res = await fetch('/protoclaw/sessions/branch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, sourceSessionId: sessionId, cutMsgIndexEnd }),
    });
    if (!res.ok) throw new Error(await res.text().catch(() => 'failed'));
    const result = await res.json();

    if (result?.agent) {
      applyManagedPrebuiltAgent(agentId, result.agent);
    }
    await loadAgents();
    const nextRuntimeId =
      result?.agent?.runtime_session_id
      || result?.agent?.runtimeSessionId
      || null;
    if (nextRuntimeId) {
      setPreferredUnitMode('chat', allAgents.find((agent) => agent.id === agentId) || getCurrentAgentRecord());
      await requestSwitch(nextRuntimeId, 'branch');
    } else {
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
    }
  } catch (error) {
    console.error('Failed to branch session:', error);
    clearSessionLoading(agentId);
    window.alert((currentLanguage === 'zh' ? '分支失败：' : 'Branch failed: ') + (error?.message || error));
  }
};

// ── End Session Dialogs ────────────────────────────────────────────
