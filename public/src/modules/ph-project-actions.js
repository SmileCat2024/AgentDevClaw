/**
 * ph-project-actions.js — PH 项目操作 / Model Config
 * 从 app-main.js 拆出（Phase A-4）
 * 拆出日期：2026-07-03
 *
 * 依赖全局状态（定义在 app-core.js）:
 *   currentLanguage
 * 依赖全局函数:
 *   getCurrentAgentRecord (app-main.js)
 *   renderCurrentMainView (app-ui.js)
 *   renderPhModelConfigOverlay (modules/ph-model-config.js)
 *   updateAgentRecord (app-ui.js)
 *   updateAgentWorkspaceState (app-ui.js)
 *   invoke (app-core.js)
 *   ClawToast (modules/toast-notify.js)
 * 依赖全局变量:
 *   lastRenderedWorkspaceHtml (app-ui.js)
 *   phSearchQuery, phSearchResults, phSearchLoading, _phSearchTimer (app-main.js)
 * window 函数:
 *   phOpenModelConfig, phCloseModelConfig, phAutoSaveModelConfig,
 *   phOpenProject, phSwitchProject, phToggleProjectDropdown,
 *   phOpenInExplorer, phToggleModelSlot
 * HTML onclick 引用:
 *   onclick="phOpenModelConfig()"
 *   onclick="phCloseModelConfig()"
 *   onchange="phAutoSaveModelConfig()"
 *   onclick="phOpenProject()"
 *   onclick="phSwitchProject(...)"
 *   onclick="phToggleProjectDropdown(...)"
 *   onclick="phOpenInExplorer(...)"
 *   onclick="phToggleModelSlot()"
 */

window.phOpenModelConfig = async () => {
  const agent = getCurrentAgentRecord();
  if (!agent) return;
  let presets = window.ClawFW?._modelPresets || [];
  if (!presets.length) {
    try {
      const resp = await fetch('/protoclaw/model_config');
      const data = await resp.json();
      presets = Array.isArray(data?.presets) ? data.presets : [];
      if (window.ClawFW) window.ClawFW._modelPresets = presets;
    } catch (e) {
      console.error('Failed to load presets:', e);
    }
  }
  window.phModelConfigAgentId = typeof getLogicalAgentId === 'function' ? getLogicalAgentId(agent) : agent.id;
  // coder 身份的模型配置存 agent-configs/coder.json（运行时同源读取），
  // 与主身份分开拉取；面板渲染与保存共用这份缓存。
  if (window.phModelConfigAgentId === 'programming-helper'
    && !(window.ClawFW && window.ClawFW._coderModelPresets)) {
    try {
      const resp = await fetch('/protoclaw/agent_model_presets?agentId=coder');
      const data = resp.ok ? await resp.json() : null;
      if (window.ClawFW) {
        window.ClawFW._coderModelPresets = (data && data.modelPresets) || {};
      }
    } catch (e) {
      console.error('Failed to load coder presets:', e);
    }
  }
  renderPhModelConfigOverlay(agent, presets);
};

window.phCloseModelConfig = () => {
  // Feature 设置二级页持有共享配置编辑器实例，关闭弹窗时一并释放
  if (typeof _closePhFeatureEditor === 'function') _closePhFeatureEditor();
  const host = document.getElementById('ph-model-config-host');
  if (host) host.innerHTML = '';
};

window.phAutoSaveModelConfig = async () => {
  const agentId = window.phModelConfigAgentId;
  if (!agentId) return;
  const selects = document.querySelectorAll('#ph-model-config-host .ph-mc-select');
  const modelPresets = { default: null, system: null };

  // 收集所有select的值
  const collected = {};
  selects.forEach(function(sel) {
    const role = sel.dataset.presetRole;
    const slot = sel.dataset.slot;
    if (!role) return;
    if (!collected[role]) collected[role] = {};
    collected[role][slot || 'primary'] = sel.value || null;
  });

  // 构建最终格式：default用双槽位，其他角色用单值
  for (const role of Object.keys(modelPresets)) {
    const data = collected[role] || {};
    if (role === 'default') {
      // 主代理：双槽位格式
      const primary = data.primary || null;
      const secondary = data.secondary || null;
      if (primary || secondary) {
        modelPresets[role] = { primary, secondary };
      } else {
        modelPresets[role] = null;
      }
    } else {
      // 其他角色：单值格式
      modelPresets[role] = data.primary || null;
    }
  }

  // coder 行单独保存到 agent-configs/coder.json 的 default 角色
  // （运行时按 sessionType=coder 读取该文件）；面板无 coder 行时跳过
  const hasCoderRow = Object.prototype.hasOwnProperty.call(collected, 'coder');

  try {
    const resp = await fetch('/protoclaw/agent_model_presets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, modelPresets }),
    });
    const result = await resp.json();
    if (result.ok) {
      const agent = getCurrentAgentRecord();
      if (agent) agent.modelPresets = modelPresets;
      try {
        const freshRes = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(agentId));
        if (freshRes.ok) {
          const fresh = await freshRes.json();
          updateAgentRecord(agentId, {
            workspace_sessions: fresh,
            active_workspace_session_id: fresh?.activeSessionId || null,
          });
        }
      } catch (e) { /* ignore refresh error */ }
    }
    if (hasCoderRow) {
      const coderPreset = collected.coder.primary || null;
      const coderResp = await fetch('/protoclaw/agent_model_presets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'coder', modelPresets: { default: coderPreset } }),
      });
      const coderResult = await coderResp.json();
      if (coderResult.ok && window.ClawFW) {
        window.ClawFW._coderModelPresets = { default: coderPreset };
      }
    }
    // 刷新覆层以更新 info 文本
    const presets = window.ClawFW?._modelPresets || [];
    const agent = getCurrentAgentRecord();
    if (agent) renderPhModelConfigOverlay(agent, presets);
    renderCurrentMainView();
  } catch (e) {
    console.error('Failed to save model preset:', e);
  }
};

window.phOpenProject = async () => {
  const currentAgent = getCurrentAgentRecord();
  if (!currentAgent || !isPhStyleWorkspaceAgent(currentAgent)) {
    console.error('Not in a PH-style workspace');
    return;
  }

  try {
    const result = await invoke('select_directory');
    const chosenPath = Array.isArray(result?.paths) ? String(result.paths[0] || '').trim() : (typeof result?.path === 'string' ? result.path.trim() : '');
    if (!chosenPath) {
      return;
    }

    // Open project: add + set as active in one call
    const openRes = await fetch('/protoclaw/ph_project/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: currentAgent.id, openDirectory: chosenPath }),
    });
    if (!openRes.ok) {
      throw new Error(await openRes.text().catch(() => 'Failed to open project'));
    }

    const openResult = await openRes.json();
    // Use returned state directly — no extra fetch
    const freshState = openResult.state || await (await fetch('/protoclaw/workspace_state?agentId=' + encodeURIComponent(currentAgent.id))).json();
    updateAgentWorkspaceState(currentAgent.id, freshState);

    // 新项目会话列表首屏（按项目切片拉取）
    const loaded = await phLoadProjectSessions(chosenPath);
    if (!loaded) {
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
    }
  } catch (error) {
    console.error('Failed to open project:', error);
    window.alert((currentLanguage === 'zh' ? '打开项目失败：' : 'Failed to open project: ') + (error?.message || error));
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
  }
};

window.phSwitchProject = async (projectId) => {
  const currentAgent = getCurrentAgentRecord();
  if (!currentAgent || !isPhStyleWorkspaceAgent(currentAgent)) {
    return;
  }

  // 远程独有项目（ADR-0012 决策 1）：仅切换 surface 视图，不改变本地工作区
  // 目录——本地 ph_project/switch 会把工作区切到远程路径，属错误语义。
  // 守卫迁移（能力驱动）：门控问题从「这是远程桶吗」改为「本地工作区切换
  // 这个动作的能力可用吗」——按项目本地宿主身份查询能力矩阵（本地身份恒
  // 可用；能力不可用即保持视图切换路由）。remoteOnly 桶的目录仅存在于
  // 远程主机、没有本地宿主：这是真本地事实而非能力位（原则：不造伪能力
  // 位），桶标记仅作数据描述保留，经数据层 getProjectLocalHostAgentId
  // 解析（见 project-data.js），与能力不可用同样走视图切换。
  // 视图覆盖标记（phSurfaceViewProjectId）属纯视图逻辑，不属能力语义，照旧设置。
  const projects = (typeof getProgrammingHelperProjects === 'function'
    ? getProgrammingHelperProjects(currentAgent)
    : []);
  const targetProject = projects.find((p) => p.id === projectId) || null;
  const localHostAgentId = getProjectLocalHostAgentId(targetProject, currentAgent.id);
  const canSwitchLocalWorkspace = localHostAgentId !== ''
    && window.RemoteConnections?.capabilityFor?.(localHostAgentId, 'write') !== false;
  if (targetProject && !canSwitchLocalWorkspace) {
    window.ClawFW = window.ClawFW || {};
    window.ClawFW.phSurfaceViewProjectId = projectId;
    phSearchQuery = '';
    phSearchResults = null;
    phSearchLoading = false;
    if (_phSearchTimer) { clearTimeout(_phSearchTimer); _phSearchTimer = null; }
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
    return;
  }
  if (window.ClawFW) window.ClawFW.phSurfaceViewProjectId = null;

  try {
    const switchRes = await fetch('/protoclaw/ph_project/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: currentAgent.id, projectId }),
    });
    if (!switchRes.ok) {
      throw new Error(await switchRes.text().catch(() => 'Failed to switch project'));
    }

    const switchResult = await switchRes.json();
    // Use returned state directly — no extra fetch
    const freshState = switchResult.state || await (await fetch('/protoclaw/workspace_state?agentId=' + encodeURIComponent(currentAgent.id))).json();
    updateAgentWorkspaceState(currentAgent.id, freshState);

    // Close dropdown
    const dropdown = document.querySelector('.ph-project-dropdown');
    if (dropdown) dropdown.classList.remove('open');

    // Clear search state on project switch
    phSearchQuery = '';
    phSearchResults = null;
    phSearchLoading = false;
    if (_phSearchTimer) { clearTimeout(_phSearchTimer); _phSearchTimer = null; }

    // 会话列表按项目分页：切换后拉取新项目首屏（替换旧项目切片）
    const switched = await phLoadProjectSessions(targetProject?.openDirectory || freshState?.openDirectory || '');
    if (!switched) {
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
    }
  } catch (error) {
    console.error('Failed to switch project:', error);
    window.alert((currentLanguage === 'zh' ? '切换项目失败：' : 'Failed to switch project: ') + (error?.message || error));
  }
};

// ── 会话列表分页加载（项目切片）────────────────────────────────────
// 服务端按 projectDir 过滤返回切片（B 方案：列表传输按需分页）。此处
// 负责两个动作：phLoadProjectSessions —— 项目切换/打开后替换首屏；
// window.phLoadMoreSessions —— 列表尾部“加载更多”，追加下一段（merge
// 按 sessionOffset>0 走追加语义，不做 membership 清理）。
// 滚动自动加载：window.phSetupLoadMoreAutoScroll 用 IntersectionObserver
// 观察加载哨兵（load-more wrapper），进入视口即触发下一段；workspace
// surface 每次 innerHTML 全量替换后由 app-ui.js 重挂。按钮保留为显式
// fallback（IntersectionObserver 不可用时仍可点击）。

async function phFetchSessionsPage(agentId, { projectDir = '', offset = 0, limit = 60 } = {}) {
  const params = new URLSearchParams({
    agentId,
    offset: String(offset),
    limit: String(limit),
  });
  if (projectDir) params.set('projectDir', projectDir);
  const response = await fetch('/protoclaw/prebuilt_sessions?' + params.toString());
  if (!response.ok) throw new Error('session page request failed: ' + response.status);
  return await response.json();
}

async function phLoadProjectSessions(projectDir) {
  const agent = getCurrentAgentRecord();
  if (!agent || typeof isPhStyleWorkspaceAgent !== 'function' || !isPhStyleWorkspaceAgent(agent)) return false;
  try {
    const fresh = await phFetchSessionsPage(agent.id, { projectDir, offset: 0, limit: 60 });
    if (fresh && fresh.unchanged !== true) {
      // 项目切换 = membership 全量替换：不保留旧项目的乐观条目与已加载段
      updateAgentRecord(agent.id, {
        workspace_sessions: fresh,
        active_workspace_session_id: fresh?.activeSessionId || null,
      });
    }
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
    return true;
  } catch (error) {
    console.error('Failed to load project sessions:', error);
    return false;
  }
}

let _phLoadingMoreSessions = false;

window.phLoadMoreSessions = async () => {
  if (_phLoadingMoreSessions) return;
  const agent = getCurrentAgentRecord();
  if (!agent || typeof isPhStyleWorkspaceAgent !== 'function' || !isPhStyleWorkspaceAgent(agent)) return;
  const ws = agent.workspace_sessions;
  const loadedCount = Array.isArray(ws?.sessions) ? ws.sessions.length : 0;
  const total = Number(ws?.sessionTotal);
  if (Number.isFinite(total) && loadedCount >= total) return;
  _phLoadingMoreSessions = true;
  const loadBtns = document.querySelectorAll('.ph-load-more-btn');
  const isZh = currentLanguage === 'zh';
  loadBtns.forEach((btn) => {
    btn.disabled = true;
    btn.textContent = isZh ? '加载中…' : 'Loading…';
  });
  try {
    const fresh = await phFetchSessionsPage(agent.id, { offset: loadedCount, limit: 60 });
    if (fresh && fresh.unchanged !== true) {
      const merged = typeof mergeWorkspaceSessionSnapshots === 'function'
        ? mergeWorkspaceSessionSnapshots(ws, fresh, agent.id)
        : { ...ws, ...fresh, sessions: [...(ws?.sessions || []), ...(fresh.sessions || [])] };
      updateAgentRecord(agent.id, { workspace_sessions: merged });
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
    }
  } catch (error) {
    console.error('Failed to load more sessions:', error);
  } finally {
    _phLoadingMoreSessions = false;
  }
};

let _phLoadMoreObserver = null;

window.phSetupLoadMoreAutoScroll = () => {
  if (typeof IntersectionObserver === 'undefined') return;
  if (_phLoadMoreObserver) {
    _phLoadMoreObserver.disconnect();
    _phLoadMoreObserver = null;
  }
  const sentinels = document.querySelectorAll('.ph-load-more-wrap');
  if (sentinels.length === 0) return;
  _phLoadMoreObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      window.phLoadMoreSessions();
      break;
    }
  }, { rootMargin: '160px 0px' });
  sentinels.forEach((el) => _phLoadMoreObserver.observe(el));
};

window.phToggleProjectDropdown = (event) => {
  event.stopPropagation();
  const dropdown = document.querySelector('.ph-project-dropdown');
  if (!dropdown) return;
  dropdown.classList.toggle('open');
};

// Close dropdown on outside click
document.addEventListener('click', (e) => {
  const dropdown = document.querySelector('.ph-project-dropdown');
  if (dropdown && !dropdown.contains(e.target)) {
    dropdown.classList.remove('open');
  }
});

window.phOpenInExplorer = async (dirPath) => {
  if (!dirPath) return;
  try {
    await fetch('/protoclaw/ph_project/open_in_explorer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dirPath }),
    });
  } catch (e) {
    console.error('Failed to open in explorer:', e);
  }
};

/**
 * 切换主代理的主模型和备选模型
 * 点击操作条上的模型名称时触发
 */
window.phToggleModelSlot = async () => {
  const currentAgent = getCurrentAgentRecord();
  if (!currentAgent || !isPhStyleWorkspaceAgent(currentAgent)) {
    return;
  }
  
  const modelPresets = currentAgent.modelPresets || {};
  const defaultPreset = modelPresets.default || {};
  const primaryModel = typeof defaultPreset === 'string' ? defaultPreset : (defaultPreset.primary || '');
  const secondaryModel = typeof defaultPreset === 'string' ? '' : (defaultPreset.secondary || '');
  
  // 如果没有备选模型，打开配置面板
  if (!secondaryModel) {
    window.phOpenModelConfig();
    return;
  }
  
  const isZh = currentLanguage === 'zh';
  const toastId = 'model-switch';
  
  // 显示切换中提示
  ClawToast.show({
    id: toastId,
    title: isZh ? '正在切换模型...' : 'Switching model...',
    status: 'loading',
    closable: false,
  });
  
  // 切换主模型和备选模型
  const newDefaultPreset = {
    primary: secondaryModel || null,
    secondary: primaryModel || null,
  };
  
  const newModelPresets = {
    ...modelPresets,
    default: newDefaultPreset,
  };
  
  try {
    const resp = await fetch('/protoclaw/agent_model_presets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: currentAgent.id,
        modelPresets: newModelPresets
      }),
    });
    const result = await resp.json();
    if (result.ok) {
      currentAgent.modelPresets = newModelPresets;
      // 刷新UI
      renderCurrentMainView();
      
      // 显示切换成功提示
      ClawToast.update(toastId, {
        status: 'success',
        title: isZh ? '模型已切换' : 'Model switched',
        description: secondaryModel,
        autoDismiss: 3000,
      });
    } else {
      throw new Error(result.error || 'Unknown error');
    }
  } catch (e) {
    console.error('Failed to toggle model slot:', e);
    ClawToast.update(toastId, {
      status: 'error',
      title: isZh ? '切换失败' : 'Switch failed',
      description: e?.message || String(e),
    });
  }
};

/**
 * 设置进程模式（共享 / 独立）
 * 从项目设置面板的进程模式页调用
 */
window.phSetProcessMode = async (processMode) => {
  const agent = getCurrentAgentRecord();
  if (!agent || !isPhStyleWorkspaceAgent(agent)) return;
  try {
    const response = await fetch('/protoclaw/agent_process_mode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: getLogicalAgentId(agent), processMode }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.error || 'Failed to save process mode');
    }
    agent.processMode = result.processMode;
    const presets = window.ClawFW?._modelPresets || [];
    renderPhModelConfigOverlay(agent, presets);
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to save process mode:', error);
    window.alert((currentLanguage === 'zh' ? '保存进程模式失败：' : 'Failed to save process mode: ') + (error?.message || error));
  }
};
