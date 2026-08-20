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
  window.phModelConfigAgentId = agent.id;
  renderPhModelConfigOverlay(agent, presets);
};

window.phCloseModelConfig = () => {
  const host = document.getElementById('ph-model-config-host');
  if (host) host.innerHTML = '';
};

window.phAutoSaveModelConfig = async () => {
  const agentId = window.phModelConfigAgentId;
  if (!agentId) return;
  const selects = document.querySelectorAll('#ph-model-config-host .ph-mc-select');
  const modelPresets = { default: null, exploration: null, sub: null, system: null };
  
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
      // 刷新覆层以更新 info 文本
      const presets = window.ClawFW?._modelPresets || [];
      if (agent) renderPhModelConfigOverlay(agent, presets);
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
      renderCurrentMainView();
    }
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

    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
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

    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to switch project:', error);
    window.alert((currentLanguage === 'zh' ? '切换项目失败：' : 'Failed to switch project: ') + (error?.message || error));
  }
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
      body: JSON.stringify({ agentId: agent.id, processMode }),
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
