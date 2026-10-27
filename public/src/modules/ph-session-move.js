/**
 * PH 会话移动（本地）：默认项目 ↔ 项目（同目录内）。
 *
 * 入口：
 *  - 会话条目 ⋯ 菜单「移动到…」（单条，ctx-menu-items.js 分发 move-session）
 *  - 会话列表工具条「多选」→ 勾选 →「移动到…」（批量）
 *
 * 契约（POST /protoclaw/ph_project/sessions_move）：
 *  { agentId:'programming-helper', sessionIds:[...],
 *    target:{type:'project',id:'prj_...'} | {type:'directory',openDirectory:'绝对路径'} }
 *  成功 {ok:true,movedSessionIds,releasedSessionIds,revision,target}；
 *  busy 409 code=ph_sessions_busy（可读提示，不假成功）；其余错误用 payload.error。
 *
 * 语义边界：移动改变归属（配置随归属生效，历史不变），不是选择器切换——
 * 浏览目标不动；目标只列同目录（默认 ↔ 项目 ↔ 项目），跨目录不支持。
 * 单条入口（ctx 菜单）可能来自侧栏/搜索等其他上下文——归属一律从会话记录
 * 的 owner 字段（projectId / openDirectory）解析，不拿页面焦点当来源。
 * 多选状态绑定 workspace + 浏览目标 + 当前切片：渲染期和解清理不可见 id；
 * 异步移动成功时若工作空间/浏览目标已切换，不重拉、不覆盖当前页面。
 * 只本地 PH：远程会话不进入多选与移动。
 */

window.ClawFW = window.ClawFW || {};
window.ClawFW.phSessionMove = {
  selectMode: false,
  selected: new Set(),
  scopeKey: '',
};

function _phMoveState() {
  return window.ClawFW.phSessionMove;
}

function _phMoveScopeKey(agent, target) {
  // viewId 规范与 getProgrammingHelperProjects 的桶 id 一致（目录桶 = dir:<小写路径>），
  // 否则渲染期 sync 会把 toggle 时记录的 scope 误判为漂移、整体作废多选。
  const viewId = (target?.type === 'project') ? String(target.id || '')
    : 'dir:' + String(target?.openDirectory || '').replace(/\\/g, '/').toLowerCase();
  return String(agent?.id || '') + '||' + viewId;
}

/** 多选状态整体作废（目录/归属切换、移动完成、退出多选时调用）。 */
window.phSessionMoveReset = () => {
  const state = _phMoveState();
  state.selectMode = false;
  state.selected.clear();
  state.scopeKey = '';
};

/**
 * 渲染期和解：多选状态绑定 workspace + 浏览目标 + 当前切片。切换目录/归属、
 * 轮询或切片更换后，不可见 id 在此清理——光靠切换回调 reset 不够。
 */
window.phSessionMoveSyncScope = (agentId, viewId, visibleIds) => {
  const state = _phMoveState();
  if (!state.selectMode) return;
  const key = String(agentId || '') + '||' + String(viewId || '');
  if (state.scopeKey !== key) {
    window.phSessionMoveReset();
    return;
  }
  const visible = new Set(visibleIds || []);
  for (const id of [...state.selected]) {
    if (!visible.has(id)) state.selected.delete(id);
  }
};

window.phToggleSessionSelectMode = () => {
  const state = _phMoveState();
  if (!state.selectMode) {
    const agent = getCurrentAgentRecord();
    const target = (typeof getPhBrowsingTarget === 'function') ? getPhBrowsingTarget(agent) : null;
    state.scopeKey = _phMoveScopeKey(agent, target);
    state.selectMode = true;
  } else {
    window.phSessionMoveReset();
  }
  lastRenderedWorkspaceHtml = '';
  renderCurrentMainView();
};

window.phToggleSessionSelection = (sessionId, checked) => {
  const state = _phMoveState();
  const id = String(sessionId || '').trim();
  if (!id) return;
  if (checked) state.selected.add(id);
  else state.selected.delete(id);
  // 就地更新计数徽标（避免全量重渲染打断勾选交互）
  const count = state.selected.size;
  document.querySelectorAll('.ph-select-count').forEach((el) => {
    el.textContent = count + ' ' + (currentLanguage === 'zh' ? '已选' : 'selected');
  });
};

/**
 * 会话归属解析（冻结来源）：读会话记录自身的 owner 字段——projectId 优先
 * （按项目实体解析绑定目录），否则 openDirectory。记录不可见或归属不可解析
 * 返回 null，调用方显式失败，不猜测页面焦点。
 */
function _phResolveSessionOwnership(sessionId) {
  const agent = getCurrentAgentRecord();
  // 内联等价查找（getWorkspaceSessions 语义）：避免依赖 session-ui.js 的
  // 加载顺序（本模块在任何只装部分模块的宿主里也应可用）。
  const sessions = (typeof getWorkspaceSessions === 'function')
    ? getWorkspaceSessions(agent) : (agent?.workspace_sessions?.sessions || []);
  const session = sessions.find((item) => item?.id === String(sessionId || '').trim()) || null;
  if (!session) return null;
  const projectId = String(session.projectId || '').trim();
  if (projectId) {
    const entity = (window.ClawFW.phProjectEntities?.projects || [])
      .find((p) => p.id === projectId && !p.archived);
    if (entity?.openDirectory) {
      return { directory: entity.openDirectory, ownerKey: 'project:' + entity.id };
    }
    return null;
  }
  const directory = String(session.openDirectory || '').trim();
  if (directory) {
    return {
      directory,
      ownerKey: 'directory:' + directory.replace(/\\/g, '/').toLowerCase(),
    };
  }
  return null;
}

/**
 * 归属解析的权威兜底：切片缓存（当前浏览目标分页 60 条）与项目实体缓存
 * 都不是归属事实源——单条 ctx 入口可从侧栏/搜索发起，会话不在当前切片、
 * 或 projectId 有值但实体缓存未加载时，本地解析返回 null，不等于归属
 * 不可解析。这里走既有列表接口的 sessionId 精确过滤（索引读模型），返回
 * 记录与切片同一条 wire 投影管线产出，字段名（projectId / openDirectory）
 * 与 workspace_sessions.sessions 一致。失败才返回 null（调用方显式报错，
 * 不猜测页面焦点）。
 */
async function _phResolveSessionOwnershipFromServer(sessionId) {
  try {
    const agent = getCurrentAgentRecord();
    const params = new URLSearchParams({
      agentId: String(agent?.id || ''),
      sessionId: String(sessionId || ''),
    });
    const response = await fetch('/protoclaw/prebuilt_sessions?' + params.toString());
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const record = Array.isArray(payload?.sessions) && payload.sessions.length > 0
      ? payload.sessions[0] : null;
    if (!record) return null;
    const projectId = String(record.projectId || '').trim();
    if (projectId) {
      const projectDirectory = String(record.openDirectory || '').trim();
      if (!projectDirectory) return null;
      return { directory: projectDirectory, ownerKey: 'project:' + projectId };
    }
    const directory = String(record.openDirectory || '').trim();
    if (!directory) return null;
    return { directory, ownerKey: 'directory:' + directory.replace(/\\/g, '/').toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * 移动成功后按服务端 releasedSessionIds 事实注册侧栏乐观退场（与关闭/
 * 归档链路共用 markPendingRuntimeStop）。releasedSessionIds 是服务端释放
 * 事实（waitForPersistence 停妥才返回），注册后侧栏投影立即隐藏条目，不等
 * 下一轮 loadAgents 重投影（快照一轮 ~3s，期间条目原样挂着，表现为
 * 「移动后侧栏卡几秒」）。轮询快照到达后由 reconcilePendingRuntimeStops
 * 收敛，TTL 兜底条目回可见。
 */
function _phApplyMoveReleasedSessions(releasedSessionIds, agentId, movingRuntimeIds) {
  if (!Array.isArray(releasedSessionIds) || releasedSessionIds.length === 0) return false;
  if (typeof markPendingRuntimeStop !== 'function') return false;
  for (const releasedSid of releasedSessionIds) {
    markPendingRuntimeStop(agentId, releasedSid, movingRuntimeIds.get(releasedSid) || '');
  }
  if (typeof invalidateSidebarProjection === 'function') invalidateSidebarProjection();
  if (typeof renderAgentList === 'function') renderAgentList();
  return true;
}

window.phOpenSessionMoveDialog = async (sessionIds) => {
  const agent = getCurrentAgentRecord();
  if (!agent || typeof isPhStyleWorkspaceAgent !== 'function' || !isPhStyleWorkspaceAgent(agent)) return;
  const isZh = currentLanguage === 'zh';
  // 无参调用 = 工具条批量入口：勾选状态在渲染后才变化（就地更新计数，
  // 不重渲染），渲染期冻结的 id 列表会过期——这里读实时选中集合。
  const source = (sessionIds === undefined || sessionIds === null)
    ? [..._phMoveState().selected]
    : (Array.isArray(sessionIds) ? sessionIds : [sessionIds]);
  const ids = source.map((id) => String(id || '').trim()).filter(Boolean);
  if (ids.length === 0) {
    window.alert(isZh ? '请先选择要移动的对话' : 'Select conversations to move first');
    return;
  }
  // 归属来源：单条（ctx 菜单）从会话记录冻结 owner 解析——可能来自侧栏/搜索
  // 等其他上下文，不拿页面焦点当来源；本地切片/实体缓存解析不到时按服务端
  // 索引权威兜底。批量全部来自当前视图，用当前目录。
  let sourceDirectory = '';
  const ownerKeys = [];
  if (ids.length === 1) {
    let ownership = _phResolveSessionOwnership(ids[0]);
    if (!ownership) {
      ownership = await _phResolveSessionOwnershipFromServer(ids[0]);
      // 服务端解析是异步的：期间工作空间可能被切换，旧 agent 上下文不再
      // 适合作弹窗宿主，静默放弃（不弹窗不报错，切换后的链路自洽）。
      const agentNow = getCurrentAgentRecord();
      if (!agentNow || agentNow.id !== agent.id) return;
    }
    if (!ownership) {
      window.alert(isZh ? '无法确定该会话的归属目录，不能移动' : 'Cannot resolve the owning directory of this conversation to move');
      return;
    }
    sourceDirectory = ownership.directory;
    ownerKeys.push(ownership.ownerKey);
  } else {
    const dirContext = (typeof getPhCurrentDirectoryContext === 'function')
      ? getPhCurrentDirectoryContext(agent) : null;
    if (!dirContext || !dirContext.openDirectory) {
      window.alert(isZh ? '当前视图无目录上下文，无法移动' : 'No directory context to move within');
      return;
    }
    sourceDirectory = dirContext.openDirectory;
    for (const id of ids) {
      const ownership = _phResolveSessionOwnership(id);
      if (ownership) ownerKeys.push(ownership.ownerKey);
    }
  }
  const allSameOwner = (ownerKey) => ownerKeys.length > 0 && ownerKeys.every((k) => k === ownerKey);

  const directoryOwnerKey = 'directory:' + sourceDirectory.replace(/\\/g, '/').toLowerCase();
  const projects = (typeof getPhProjectsInDirectory === 'function')
    ? getPhProjectsInDirectory(sourceDirectory) : [];
  const moveTargets = {
    items: [
      {
        target: { type: 'directory', openDirectory: sourceDirectory },
        key: 'directory',
        name: isZh ? '默认项目' : 'Directory Chats (default)',
        path: sourceDirectory,
        disabled: allSameOwner(directoryOwnerKey),
      },
      ...projects.map((entity) => ({
        target: { type: 'project', id: entity.id },
        key: entity.id,
        name: entity.name,
        path: entity.directorySource === 'managed'
          ? (isZh ? '托管目录' : 'Managed directory')
          : entity.openDirectory,
        disabled: allSameOwner('project:' + entity.id),
      })),
    ],
  };

  let host = document.getElementById('ph-move-dialog-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ph-move-dialog-host';
    document.body.appendChild(host);
  }
  host.innerHTML = '';

  const overlay = document.createElement('div');
  overlay.className = 'feature-detail-overlay';
  const firstEnabled = moveTargets.items.findIndex((item) => !item.disabled);
  const targetRows = moveTargets.items.map((item, index) => [
    '<label class="ph-move-target-item' + (item.disabled ? ' disabled' : '') + (index === firstEnabled ? ' selected' : '') + '">',
    '<input type="radio" name="ph-move-target" value="' + index + '"' + (item.disabled ? ' disabled' : '') + (index === firstEnabled ? ' checked' : '') + '>',
    '<div class="ph-project-dropdown-info">',
    '<div class="ph-project-dropdown-name">' + escapeHtml(item.name) + '</div>',
    '<div class="ph-project-dropdown-path">' + escapeHtml(item.path) + '</div>',
    '</div>',
    '</label>',
  ].join(''));
  overlay.innerHTML = [
    '<form class="feature-detail-window ph-move-window" role="dialog" aria-modal="true" novalidate>',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? '移动对话' : 'Move Conversations') + '</div>',
    '<div class="feature-detail-subtitle">' + (isZh
      ? '已选 ' + ids.length + ' 个对话。移动后归属改变（配置随归属生效），历史消息不变。'
      : ids.length + ' conversation(s) selected. Ownership changes (config follows); history is untouched.') + '</div>',
    '</div>',
    '<button type="button" class="feature-detail-close ph-move-cancel">&times;</button>',
    '</div>',
    '<div class="settings-section">',
    '<div class="settings-field">',
    '<label>' + (isZh ? '移动到（仅同目录目标）' : 'Move to (same directory only)') + '</label>',
    '<div class="ph-move-target-list">' + targetRows.join('') + '</div>',
    '</div>',
    '<div class="ph-move-note">' + (isZh
      ? '仅支持同目录内移动：默认项目 ↔ 项目；跨目录移动暂不支持。'
      : 'Same-directory moves only: directory chats ↔ projects. Cross-directory moves are not supported.') + '</div>',
    '<div class="ph-new-project-error ph-move-error" hidden></div>',
    '</div>',
    '<div class="settings-actions">',
    '<button type="button" class="settings-btn settings-btn-secondary ph-move-cancel">' + (isZh ? '取消' : 'Cancel') + '</button>',
    '<button type="submit" class="settings-btn settings-btn-primary">' + (isZh ? '移动' : 'Move') + '</button>',
    '</div>',
    '</form>',
  ].join('');
  host.appendChild(overlay);

  const errorEl = overlay.querySelector('.ph-move-error');
  const submitBtn = overlay.querySelector('button[type="submit"]');
  const previousFocus = document.activeElement;

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
    if (previousFocus && previousFocus.isConnected) previousFocus.focus();
  };
  const onKeydown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  };
  document.addEventListener('keydown', onKeydown);
  overlay.querySelectorAll('.ph-move-cancel').forEach((btn) => btn.addEventListener('click', close));
  overlay.querySelectorAll('.ph-move-target-item input[type="radio"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      overlay.querySelectorAll('.ph-move-target-item').forEach((row) => row.classList.remove('selected'));
      const row = radio.closest('.ph-move-target-item');
      if (row) row.classList.add('selected');
    });
  });

  // 提交前冻结上下文：异步竞态守卫的比对基准
  const submitAgentId = agent.id;
  const targetAtOpen = (typeof getPhBrowsingTarget === 'function') ? getPhBrowsingTarget(agent) : null;
  const submitTargetKey = _phMoveScopeKey(agent, targetAtOpen);

  overlay.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const checked = overlay.querySelector('input[name="ph-move-target"]:checked');
    if (!checked) {
      errorEl.textContent = isZh ? '请选择移动目标' : 'Pick a move target';
      errorEl.hidden = false;
      return;
    }
    const item = moveTargets.items[Number(checked.value)];
    if (!item || item.disabled) {
      errorEl.textContent = isZh ? '目标不可用' : 'Target unavailable';
      errorEl.hidden = false;
      return;
    }
    submitBtn.disabled = true;
    errorEl.hidden = true;
    // 提交前快照被移动会话的运行实例映射：成功响应携带的 releasedSessionIds
    // 是服务端释放事实（waitForPersistence 停妥才返回），据此注册乐观退场需要
    // sessionId → runtimeId 对应关系。会话不在运行则无条目，注册自然跳过。
    const movingRuntimeIds = new Map();
    if (Array.isArray(allAgents)) {
      for (const runtimeItem of allAgents) {
        if (String(runtimeItem?.parent_id || '') !== String(agent.id)) continue;
        const runningSid = String(runtimeItem?.active_workspace_session_id || '').trim();
        if (runningSid && ids.includes(runningSid)) {
          movingRuntimeIds.set(
            runningSid,
            String(runtimeItem?.runtime_session_id || runtimeItem?.runtimeSessionId || runtimeItem?.id || '').trim(),
          );
        }
      }
    }
    try {
      const response = await fetch('/protoclaw/ph_project/sessions_move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: 'programming-helper',
          sessionIds: ids,
          target: item.target,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (response.status === 409 && (payload?.legacyCode === 'ph_sessions_busy' || payload?.code === 'ph_sessions_busy')) {
        // busy 是显式拒绝：服务端未做任何改动，不假成功
        throw new Error(isZh
          ? '有对话正在执行（未做任何改动）。请等该轮结束后重试。'
          : 'Some conversations are busy (nothing changed). Retry after the current turn finishes.');
      }
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || ('HTTP ' + response.status));
      }
      close();
      window.phSessionMoveReset();
      // 乐观退场：见 _phApplyMoveReleasedSessions（released 事实 → 投影
      // 立即隐藏，轮询收敛）。注册在竞态守卫之前——工作空间/浏览目标切走
      // 时实例同样已停，退场事实与浏览上下文无关。
      _phApplyMoveReleasedSessions(payload?.releasedSessionIds, agent.id, movingRuntimeIds);
      // 被移动会话含当前停靠 runtime 时切回工作台面（对齐 thread-delete /
      // thread-archive 回退口径）：移动释放了实例，停留在已无 runtime 的
      // 对话视图上表现为消息流僵死、输入无响应。判定用同步全局
      // currentRuntimeAgentId（stale check 只信同步值）。
      for (const movingRuntimeId of movingRuntimeIds.values()) {
        if (movingRuntimeId && String(currentRuntimeAgentId || '') === movingRuntimeId) {
          if (typeof selectWorkspaceSurface === 'function') selectWorkspaceSurface(agent.id);
          break;
        }
      }
      // 线程视图缓存随移动事实刷新（对齐 delete 链路）：移动的会话可能属
      // 线程（整链移动），历史时间锚 / 归档呈现依赖的线程数据重拉。
      if (Array.isArray(payload?.movedSessionIds) && payload.movedSessionIds.length > 0
          && typeof window.refreshThreads === 'function') {
        window.refreshThreads(true).catch(() => {});
      }
      // 异步竞态守卫：移动期间工作空间或浏览目标被切换，不再重拉/覆盖当前
      // 页面——侧栏与切片由切换后的正常链路负责。
      const agentNow = getCurrentAgentRecord();
      const targetNow = (agentNow && typeof getPhBrowsingTarget === 'function')
        ? getPhBrowsingTarget(agentNow) : null;
      if (!agentNow || agentNow.id !== submitAgentId
        || _phMoveScopeKey(agentNow, targetNow) !== submitTargetKey) {
        return;
      }
      // 成功后刷新：切片重拉 + 搜索重拉 + 恢复卡片（随渲染调度）+ 侧栏运行态
      // （loadAgents 重投影，已释放旧实例不沿用）。
      const ownership = targetNow?.type === 'project'
        ? { projectId: targetNow.id }
        : { projectDir: targetNow?.openDirectory || '' };
      await phLoadProjectSessions(ownership);
      if (String(phSearchQuery || '').trim() && typeof window.phSearchRetry === 'function') {
        window.phSearchRetry();
      }
      if (typeof window.loadAgents === 'function') {
        try {
          await window.loadAgents();
          if (typeof renderAgentList === 'function') renderAgentList();
        } catch { /* 侧栏刷新失败不阻断移动结果呈现 */ }
      }
      if (typeof ClawToast !== 'undefined' && ClawToast?.show) {
        ClawToast.show({
          id: 'ph-session-move',
          title: isZh ? '已移动 ' + (payload.movedSessionIds?.length ?? ids.length) + ' 个对话' : ('Moved ' + (payload.movedSessionIds?.length ?? ids.length) + ' conversation(s)'),
          status: 'success',
        });
      }
    } catch (error) {
      submitBtn.disabled = false;
      errorEl.textContent = (isZh ? '移动失败：' : 'Move failed: ') + (error?.message || error);
      errorEl.hidden = false;
    }
  });
};
