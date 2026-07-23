/**
 * assembly-actions.js — Workspace 表单草稿操作 + Assembly 全生命周期操作（从 app-main.js 域 P + Q 提取）
 * 拆出日期：2026-07-04 (Phase C)
 *
 * 包含：
 *   域 P — Workspace Form Draft 操作：
 *     - updateWorkspaceFormDraft: 草稿字段更新（触发 re-render）
 *     - toggleWorkspaceSelection: 切换列表型字段（features / toolkits）
 *     - applyWorkspaceBundle: 批量勾选预设包
 *
 *   域 Q — Assembly 全生命周期操作：
 *     - createAssemblyEnvironment: 创建用户环境目录
 *     - launchAssemblyInstance: 启动 Agent 实例（含环境配置 + runtime start）
 *     - getSavedAssemblyConfigs / canonicalizeAssemblyFeatureSelection: 纯读取辅助
 *     - saveCurrentAssemblyConfig: 保存当前草稿为 config
 *     - resetAssemblyDraft: 重置 assembly 草稿
 *     - switchAssemblyEditingTarget: 切换编辑目标
 *     - toggleAssemblyControlPanel: 控制面板开关
 *     - jumpAssemblyStage: 跳转 assembly 阶段
 *     - loadSavedAssemblyConfig: 加载已保存的 config 到草稿
 *     - launchAssemblyConfig: 加载 config 并启动实例
 *     - deleteSavedAssemblyConfig: 删除已保存的 config
 *     - launchSavedAssemblyRun: 恢复已保存的实例运行
 *     - fwLaunchConfig / fwResumeRun: flow-workspace 按钮包装
 *     - deleteAssemblySessionRecord: 删除实例记录
 *     - loadAssemblySessionIntoDraft: 从历史实例恢复草稿
 *     - stopAssemblySessionRuntime: 停止实例 runtime
 *     - chooseWorkspaceDirectory: 选择工作目录
 *     - saveWorkspaceForm: 保存 workspace 表单（feature-creator / agent-creator / assembly）
 *     - resetWorkspaceForm: 重置 workspace 表单
 *
 * 依赖：
 *   - app-core.js: 全局变量 + 公共函数 (currentLanguage, shouldAnimateWorkspaceSurface, etc.)
 *   - assembly-data.js: normalizeAssemblyDraft, syncAssemblyEnvironmentDraft, 等
 *   - app-ui.js: renderCurrentMainView, scheduleAssemblyWorkbenchRender, maybeWarnAssemblySessionDrift
 *   - app-main.js (域 U/M/O): requestSwitch, loadAgents, runWorkspaceAction, selectWorkspaceSurface
 *   - workspace-blocks.js: renderAgentList
 *   - project-data.js: applyManagedPrebuiltAgent
 *   - context-menu.js: openCompactMenu
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════
// 域 P — Workspace Form Draft 操作
// ═══════════════════════════════════════════════════════════════════

window.updateWorkspaceFormDraft = (formId, fieldName, value) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  draft[formId] = draft[formId] || {};
  draft[formId][fieldName] = value;
  const isAssemblyDraft = (agent.id === 'agent-creator' || agent.id === 'flow-workspace') && formId === 'assembly-form';
  if ((agent.id === 'feature-creator' || agent.id === 'agent-creator') && formId === 'startup-form') {
    if (fieldName === 'install_mode' && value === 'custom') {
      draft[formId].target_dir = '';
    }
    draft[formId] = normalizeWorkspaceStartupDraft(agent, draft[formId]);
  }
  saveWorkspaceFormDraft(agent.id, draft);
  if ((agent.id === 'feature-creator' || agent.id === 'agent-creator') && formId === 'startup-form') {
    const directoryDisplay = document.querySelector('[data-workspace-form-display="startup-form:target_dir"]');
    if (directoryDisplay) {
      directoryDisplay.value = draft[formId].target_dir || t('workspace_directory_not_selected');
    }
    const outputNote = document.querySelector('[data-workspace-output-note="startup-form"]');
    if (outputNote) {
      const nextOutputDir = agent.id === 'feature-creator'
        ? getFeatureCreatorOutputDirectory(agent, draft[formId])
        : getAgentCreatorOutputDirectory(agent, draft[formId]);
      outputNote.textContent = nextOutputDir ? `${t('feature_creator_output_dir')}: ${nextOutputDir}` : '';
    }
    if (fieldName === 'install_mode') {
      shouldAnimateWorkspaceSurface = false;
      renderCurrentMainView();
    }
    return;
  }
  if (isAssemblyDraft && !['assembly_stage', 'preset', 'advanced_prompt_open'].includes(fieldName)) {
    scheduleAssemblyWorkbenchRender();
    return;
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.toggleWorkspaceSelection = async (formId, fieldName, value) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const token = String(value || '').trim();
  if (!token) return;
  const draft = getWorkspaceFormDraft(agent);
  draft[formId] = draft[formId] || {};
  const next = parseWorkspaceListField(draft[formId][fieldName]);
  const values = new Set(next);
  if (values.has(token)) {
    values.delete(token);
  } else {
    values.add(token);
  }
  const normalizedValues = fieldName === 'selected_features'
    ? canonicalizeAssemblyFeatureSelection(agent, Array.from(values))
    : Array.from(values);
  draft[formId][fieldName] = serializeWorkspaceListField(normalizedValues);
  saveWorkspaceFormDraft(agent.id, draft);
  try {
    await persistWorkspaceState(agent, draft);
  } catch (error) {
    console.error('Failed to persist workspace selection:', error);
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.applyWorkspaceBundle = async (formId, bundle) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  draft[formId] = draft[formId] || {};
  const featureValues = new Set(parseWorkspaceListField(draft[formId].selected_features));
  const toolkitValues = new Set(parseWorkspaceListField(draft[formId].recommended_toolkits));
  (Array.isArray(bundle?.features) ? bundle.features : []).forEach((item) => {
    const text = String(item || '').trim();
    if (text) featureValues.add(text);
  });
  (Array.isArray(bundle?.toolkits) ? bundle.toolkits : []).forEach((item) => {
    const text = String(item || '').trim();
    if (text) toolkitValues.add(text);
  });
  draft[formId].selected_features = serializeWorkspaceListField(canonicalizeAssemblyFeatureSelection(agent, Array.from(featureValues)));
  draft[formId].recommended_toolkits = serializeWorkspaceListField(Array.from(toolkitValues));
  saveWorkspaceFormDraft(agent.id, draft);
  try {
    await persistWorkspaceState(agent, draft);
  } catch (error) {
    console.error('Failed to persist workspace bundle:', error);
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

// ═══════════════════════════════════════════════════════════════════
// 域 Q — Assembly 环境创建 / 实例启动
// ═══════════════════════════════════════════════════════════════════

window.createAssemblyEnvironment = async () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  const form = normalizeAssemblyDraft(draft['assembly-form'] || {});
  const name = String(form.assembly_name || '').trim();
  const selectedFeatures = parseWorkspaceListField(form.selected_features);
  if (!name) {
    window.alert(currentLanguage === 'zh' ? '请先填写 Agent 名称' : 'Please provide an agent name first');
    return;
  }
  const conflicts = findAssemblyConfigConflict(agent, form);
  if (conflicts.conflictingName) {
    window.alert(currentLanguage === 'zh'
      ? `Agent 项目 "${name}" 已存在，请先加载它再配置环境。`
      : `An Agent project named "${name}" already exists. Load it before configuring the environment.`);
    return;
  }
  if (conflicts.conflictingDirectory) {
    window.alert(currentLanguage === 'zh'
      ? `当前环境目录已经被项目 "${conflicts.conflictingDirectory.name || conflicts.conflictingDirectory.id}" 占用，请先加载那个项目，或重置当前草稿。`
      : `This environment directory already belongs to "${conflicts.conflictingDirectory.name || conflicts.conflictingDirectory.id}". Load that project or reset the current draft first.`);
    return;
  }
  try {
    await syncAssemblyEnvironmentDraft(agent, draft, {
      env_status: 'creating',
      env_status_message: currentLanguage === 'zh'
        ? '正在准备用户环境目录...'
        : 'Preparing the user environment directory...',
    });
    let result;
    try {
      result = await requestAssemblyEnvironmentCreate(name, { selectedFeatures });
    } catch (error) {
      if (error?.code === 'ASSEMBLY_ENV_EXISTS') {
        const confirmed = window.confirm(currentLanguage === 'zh'
          ? `目录已存在：\n${error.directory}\n\n是否继续按当前配置重新准备这个环境？`
          : `The environment directory already exists:\n${error.directory}\n\nDo you want to reconfigure this environment with the current setup?`);
        if (!confirmed) {
          await syncAssemblyEnvironmentDraft(agent, draft, {
            env_status: 'stale',
            env_status_message: currentLanguage === 'zh'
              ? '检测到同名目录，已取消重新配置。'
              : 'An existing directory was detected, and reconfiguration was cancelled.',
          });
          return;
        }
        result = await requestAssemblyEnvironmentCreate(name, { force: true, selectedFeatures });
      } else {
        throw error;
      }
    }
    await syncAssemblyEnvironmentDraft(agent, draft, {
      env_created: '1',
      env_dir: result.directory || '',
      env_configured_name: name,
      env_configured_features: serializeWorkspaceListField(selectedFeatures),
      env_status: 'ready',
      env_status_message: result.existed
        ? (currentLanguage === 'zh' ? '已复用并确认现有环境目录。' : 'Reused and confirmed the existing environment directory.')
        : (currentLanguage === 'zh' ? '环境目录已创建完成。' : 'Environment directory created.'),
    }, {
      persist: true,
      openDirectory: result.directory || '',
    });
  } catch (error) {
    console.error('Failed to create assembly environment:', error);
    await syncAssemblyEnvironmentDraft(agent, draft, {
      env_status: 'error',
      env_status_message: (currentLanguage === 'zh' ? '环境创建失败：' : 'Environment creation failed: ') + (error?.message || error),
    }).catch(e => console.warn(e));
    window.alert('Failed to create environment: ' + (error?.message || error));
  }
};

window.launchAssemblyInstance = async () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  assemblyLaunchInProgress = true;
  const _t0 = performance.now();
  console.log(`[PERF-CLIENT] launchAssemblyInstance BEGIN assembly=${(getWorkspaceFormDraft(agent)['assembly-form'] || {}).assembly_name}`);
  const draft = getWorkspaceFormDraft(agent);
  const form = normalizeAssemblyDraft(draft['assembly-form'] || {});
  if (!isValidAgentCreatorName(form.assembly_name)) {
    assemblyLaunchInProgress = false;
    window.alert('Assembly name must use lowercase letters, numbers, and hyphens only.');
    return;
  }
  const conflicts = findAssemblyConfigConflict(agent, form);
  if (conflicts.conflictingName) {
    assemblyLaunchInProgress = false;
    window.alert(currentLanguage === 'zh'
      ? `Agent 项目 "${form.assembly_name}" 已存在，请先加载对应项目再启动。`
      : `An Agent project named "${form.assembly_name}" already exists. Load that project before launching.`);
    return;
  }
  if (conflicts.conflictingDirectory) {
    assemblyLaunchInProgress = false;
    window.alert(currentLanguage === 'zh'
      ? `当前环境目录已经被项目 "${conflicts.conflictingDirectory.name || conflicts.conflictingDirectory.id}" 占用，请先切换到那个项目。`
      : `This environment directory already belongs to "${conflicts.conflictingDirectory.name || conflicts.conflictingDirectory.id}". Switch to that project first.`);
    return;
  }
  draft['assembly-form'] = form;
  saveWorkspaceFormDraft(agent.id, draft);
  try {
    await persistWorkspaceState(agent, draft);
    console.log(`[PERF-CLIENT] launchAssemblyInstance persist #1 done (${(performance.now() - _t0).toFixed(0)}ms)`);
    const assemblyName = form.assembly_name;
    const envState = getAssemblyEnvironmentState(form);
    const shouldConfigureEnvironment = envState.needsConfiguration || !envState.configuredDir;
    const selectedFeatures = parseWorkspaceListField(form.selected_features);
    if (assemblyName) {
      if (shouldConfigureEnvironment) {
        console.log(`[PERF-CLIENT] launchAssemblyInstance env needs config, calling requestAssemblyEnvironmentCreate`);
        await syncAssemblyEnvironmentDraft(agent, draft, {
          env_status: 'installing',
          env_status_message: currentLanguage === 'zh'
            ? `正在配置环境并安装依赖${selectedFeatures.length ? `（${selectedFeatures.length} 个 Feature）` : ''}...`
            : `Preparing environment and installing dependencies${selectedFeatures.length ? ` (${selectedFeatures.length} feature(s))` : ''}...`,
        });
        try {
          const envResult = await requestAssemblyEnvironmentCreate(assemblyName, { selectedFeatures });
          console.log(`[PERF-CLIENT] launchAssemblyInstance envCreate done (${(performance.now() - _t0).toFixed(0)}ms)`);
          await syncAssemblyEnvironmentDraft(agent, draft, {
            env_created: '1',
            env_dir: envResult.directory || '',
            env_configured_name: assemblyName,
            env_configured_features: serializeWorkspaceListField(selectedFeatures),
            env_status: 'ready',
            env_status_message: envResult.existed
              ? (currentLanguage === 'zh' ? '已复用环境目录并刷新依赖。' : 'Reused the environment directory and refreshed dependencies.')
              : (currentLanguage === 'zh' ? '环境目录与依赖已准备完成。' : 'Environment directory and dependencies are ready.'),
          }, {
            persist: true,
            openDirectory: envResult.directory || '',
          });
        } catch (error) {
          if (error?.code === 'ASSEMBLY_ENV_EXISTS') {
            const envResult = await requestAssemblyEnvironmentCreate(assemblyName, { force: true, selectedFeatures });
            await syncAssemblyEnvironmentDraft(agent, draft, {
              env_created: '1',
              env_dir: envResult.directory || '',
              env_configured_name: assemblyName,
              env_configured_features: serializeWorkspaceListField(selectedFeatures),
              env_status: 'ready',
              env_status_message: currentLanguage === 'zh'
                ? '已复用环境目录并刷新依赖。'
                : 'Reused the environment directory and refreshed dependencies.',
            }, {
              persist: true,
              openDirectory: envResult.directory || '',
            });
          } else {
            throw error;
          }
        }
      } else {
        console.log(`[PERF-CLIENT] launchAssemblyInstance env already ready, skipping create (${(performance.now() - _t0).toFixed(0)}ms)`);
        await syncAssemblyEnvironmentDraft(agent, draft, {
          env_status: 'ready',
          env_status_message: currentLanguage === 'zh'
            ? '已使用当前已配置环境，直接启动实例。'
            : 'Using the existing configured environment for launch.',
        });
      }
    }
    await syncAssemblyEnvironmentDraft(agent, draft, {
      env_status: 'starting',
      env_status_message: currentLanguage === 'zh'
        ? '正在启动 Agent 测试实例...'
        : 'Starting the chatbot instance...',
    });
    console.log(`[PERF-CLIENT] launchAssemblyInstance calling /assembly_runtime/start (${(performance.now() - _t0).toFixed(0)}ms)`);
    const response = await fetch('/protoclaw/assembly_runtime/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: agent.id,
        agentName: getAssemblyDisplayName(form) || form.assembly_name,
        openDirectory: form.env_dir || envState.configuredDir || '',
        targetDir: form.target_dir || '',
      }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'Assembly runtime failed'));
    }
    await response.json();
    console.log(`[PERF-CLIENT] launchAssemblyInstance /assembly_runtime/start response received (${(performance.now() - _t0).toFixed(0)}ms)`);
    await syncAssemblyEnvironmentDraft(agent, draft, {
      env_status: 'running',
      env_status_message: currentLanguage === 'zh'
        ? 'Chatbot 已启动，运行环境位于用户目录；宿主工作目录仍保持在 Claw。'
        : 'Chatbot is running in the user environment directory while the host workdir remains in Claw.',
    }, {
      persist: true,
    });
    console.log(`[PERF-CLIENT] launchAssemblyInstance persist running done (${(performance.now() - _t0).toFixed(0)}ms)`);
    assemblyLaunchInProgress = false;
    await loadAgents();
    console.log(`[PERF-CLIENT] launchAssemblyInstance loadAgents done (${(performance.now() - _t0).toFixed(0)}ms)`);
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
    console.log(`[PERF-CLIENT] launchAssemblyInstance COMPLETE (${(performance.now() - _t0).toFixed(0)}ms total)`);
  } catch (error) {
    console.error('Failed to launch assembly runtime:', error);
    assemblyLaunchInProgress = false;
    await syncAssemblyEnvironmentDraft(agent, draft, {
      env_status: 'error',
      env_status_message: (currentLanguage === 'zh' ? '启动失败：' : 'Launch failed: ') + (error && error.message ? error.message : error),
    }, {
      persist: true,
    }).catch(e => console.warn(e));
    window.alert('Assembly runtime failed: ' + (error && error.message ? error.message : error));
  }
};

// ═══════════════════════════════════════════════════════════════════
// 域 Q — 纯读取辅助函数
// ═══════════════════════════════════════════════════════════════════

function getSavedAssemblyConfigs(agent = getCurrentAgentRecord()) {
  const configs = Array.isArray(getAgentWorkspaceState(agent)?.assemblyConfigs)
    ? getAgentWorkspaceState(agent).assemblyConfigs
    : [];
  return configs
    .map((item) => ({
      id: String(item?.id || '').trim(),
      name: String(item?.name || '').trim(),
      displayName: String(item?.displayName || '').trim(),
      preset: String(item?.preset || '').trim(),
      goal: String(item?.goal || '').trim(),
      targetUser: String(item?.targetUser || '').trim(),
      features: Array.isArray(item?.features) ? item.features.map((value) => String(value || '').trim()).filter(Boolean) : [],
      toolkits: Array.isArray(item?.toolkits) ? item.toolkits.map((value) => String(value || '').trim()).filter(Boolean) : [],
      constraints: String(item?.constraints || '').trim(),
      customSystemPrompt: String(item?.customSystemPrompt || '').trim(),
      envDir: String(item?.envDir || '').trim(),
      envConfiguredName: String(item?.envConfiguredName || '').trim(),
      envConfiguredFeatures: Array.isArray(item?.envConfiguredFeatures) ? item.envConfiguredFeatures.map((value) => String(value || '').trim()).filter(Boolean) : [],
      envStatus: String(item?.envStatus || '').trim(),
      envStatusMessage: String(item?.envStatusMessage || '').trim(),
      modelPreset: String(item?.modelPreset || '').trim(),
      workdir: String(item?.workdir || '').trim(),
      featureConfigs: normalizeFeatureConfigMap(item?.featureConfigs),
      updatedAt: String(item?.updatedAt || '').trim(),
    }))
    .filter((item) => item.id)
    .reduce((acc, item) => {
      if (!acc.some((existing) => existing.id === item.id)) {
        acc.push(item);
      }
      return acc;
    }, [])
    .sort((left, right) => String(right?.updatedAt || '').localeCompare(String(left?.updatedAt || '')));
}

function canonicalizeAssemblyFeatureSelection(agent, values) {
  const packages = Array.isArray(agent?.workspace_data?.['assembly-workbench']?.packages)
    ? agent.workspace_data['assembly-workbench'].packages
    : [];
  const aliasMap = new Map();
  packages.forEach((item) => {
    const packageName = String(item?.packageName || '').trim();
    const id = String(item?.id || '').trim();
    const canonical = packageName || id;
    if (!canonical) return;
    [packageName, id].filter(Boolean).forEach((key) => {
      const normalized = key.toLowerCase();
      if (!aliasMap.has(normalized)) {
        aliasMap.set(normalized, canonical);
      }
    });
  });
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .map((value) => aliasMap.get(value.toLowerCase()) || value)));
}

// ═══════════════════════════════════════════════════════════════════
// 域 Q — Config 保存 / 重置 / 切换
// ═══════════════════════════════════════════════════════════════════

window.saveCurrentAssemblyConfig = async () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  const form = normalizeAssemblyDraft(draft['assembly-form'] || {});
  const name = String(form.assembly_name || '').trim();
  const editingId = String(form.editing_config_id || '').trim();
  if (!isValidAgentCreatorName(name)) {
    window.alert('Assembly name must use lowercase letters, numbers, and hyphens only.');
    return;
  }
  const currentState = getAgentWorkspaceState(agent);
  const allConfigs = getSavedAssemblyConfigs(agent);
  const conflicts = findAssemblyConfigConflict(agent, form);
  if (conflicts.conflictingName) {
    window.alert(currentLanguage === 'zh'
      ? `Agent 项目 "${name}" 已存在，请换一个名字，或先加载它再编辑。`
      : `An Agent project named "${name}" already exists. Choose another name or load it before editing.`);
    return;
  }
  if (conflicts.conflictingDirectory) {
    window.alert(currentLanguage === 'zh'
      ? `当前环境目录已经被项目 "${conflicts.conflictingDirectory.name || conflicts.conflictingDirectory.id}" 占用，请先切换到那个项目，或重新配置当前项目的环境。`
      : `This environment directory already belongs to "${conflicts.conflictingDirectory.name || conflicts.conflictingDirectory.id}". Load that project or reconfigure the current environment first.`);
    return;
  }
  if (window.ClawFlowEditor && typeof window.ClawFlowEditor.save === 'function') {
    try {
      await window.ClawFlowEditor.save();
    } catch (error) {
      console.error('Failed to save flow graph before saving assembly config:', error);
    }
  }
  const existing = allConfigs.filter((item) => item.id !== name && item.id !== editingId);
  const hasEnvTrace = !!(String(form.env_dir || '').trim() || form.env_created === '1' || String(form.env_configured_name || '').trim());
  const normalizedFeatures = canonicalizeAssemblyFeatureSelection(agent, parseWorkspaceListField(form.selected_features));
  const normalizedToolkits = parseWorkspaceListField(form.recommended_toolkits);
  const normalizedConfiguredFeatures = canonicalizeAssemblyFeatureSelection(agent, parseWorkspaceListField(form.env_configured_features));
  const projectFeatureConfigs = collectAssemblyProjectFeatureConfigs(agent, form, currentState?.forms?.['feature-configs'] || {});
  const nextConfigs = [
    {
      id: name,
      name,
      preset: String(form.preset || '').trim(),
      goal: String(form.goal || '').trim(),
      targetUser: String(form.target_user || '').trim(),
      features: normalizedFeatures,
      toolkits: normalizedToolkits,
      constraints: String(form.constraints || '').trim(),
      customSystemPrompt: String(form.custom_system_prompt || '').trim(),
      envDir: String(form.env_dir || '').trim(),
      envConfiguredName: hasEnvTrace ? (String(form.env_configured_name || '').trim() || name) : '',
      envConfiguredFeatures: normalizedConfiguredFeatures,
      envStatus: String(form.env_status || '').trim(),
      envStatusMessage: String(form.env_status_message || '').trim(),
      featureConfigs: projectFeatureConfigs,
      updatedAt: new Date().toISOString(),
    },
    ...existing,
  ];
  draft['assembly-form'] = normalizeAssemblyDraft({
    ...form,
    editing_config_id: name,
    selected_features: serializeWorkspaceListField(normalizedFeatures),
    recommended_toolkits: serializeWorkspaceListField(normalizedToolkits),
    env_configured_features: serializeWorkspaceListField(normalizedConfiguredFeatures),
    env_configured_name: hasEnvTrace ? (String(form.env_configured_name || '').trim() || name) : '',
  });
  const payload = {
    forms: draft,
    openDirectory: currentState?.openDirectory || '',
    assemblyConfigs: nextConfigs,
  };
  const response = await fetch('/protoclaw/workspace_state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: agent.id, state: payload }),
  });
  if (!response.ok) {
    window.alert('Failed to save assembly config.');
    return;
  }
  const nextState = await response.json();
  updateAgentWorkspaceState(agent.id, nextState);
  saveWorkspaceFormDraft(agent.id, nextState.forms || {});
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.resetAssemblyDraft = async () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  draft['assembly-form'] = normalizeAssemblyDraft({
    assembly_stage: 'goal',
    preset: 'general-chatbot',
    editing_config_id: '',
    display_name: '',
    env_created: '0',
    env_status: '',
    env_status_message: '',
    env_dir: '',
    env_configured_name: '',
  });
  draft['feature-configs'] = {};
  saveWorkspaceFormDraft(agent.id, draft);
  await persistWorkspaceState(agent, draft, { openDirectory: '' }).catch((error) => {
    console.error('Failed to reset assembly draft:', error);
  });
  setPreferredUnitMode('assembly', agent);
  if (agent?.id === 'flow-workspace' && window.ClawFW?.mode === 'detail') {
    currentWorkspaceTab = 'workspace';
  } else {
    currentWorkspaceTab = 'assembly';
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.switchAssemblyEditingTarget = async (target) => {
  const normalized = String(target || '').trim();
  if (!normalized || normalized === '__new__') {
    await window.resetAssemblyDraft();
    return;
  }
  await window.loadSavedAssemblyConfig(normalized);
};

window.toggleAssemblyControlPanel = () => {
  assemblyControlPanelOpen = !assemblyControlPanelOpen;
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.jumpAssemblyStage = (stageKey) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  window.updateWorkspaceFormDraft('assembly-form', 'assembly_stage', stageKey);
};

// ═══════════════════════════════════════════════════════════════════
// 域 Q — Config 加载 / 启动 / 删除
// ═══════════════════════════════════════════════════════════════════

window.loadSavedAssemblyConfig = async (configId) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const config = getSavedAssemblyConfigs(agent).find((item) => item.id === String(configId || '').trim());
  if (!config) return;
  const draft = getWorkspaceFormDraft(agent);
  const previousForm = normalizeAssemblyDraft(draft['assembly-form'] || {});
  const previousMatchesConfig = String(previousForm.assembly_name || '').trim() === String(config.id || '').trim();
  const knownEnvDir = String(config.envDir || (previousMatchesConfig ? previousForm.env_dir : '') || '').trim();
  const knownConfiguredFeatures = Array.isArray(config.envConfiguredFeatures) && config.envConfiguredFeatures.length
    ? config.envConfiguredFeatures
    : (previousMatchesConfig && parseWorkspaceListField(previousForm.env_configured_features).length
      ? parseWorkspaceListField(previousForm.env_configured_features)
      : (knownEnvDir ? config.features : []));
  draft['assembly-form'] = normalizeAssemblyDraft({
    assembly_name: config.id,
    display_name: String(config.displayName || '').trim(),
    editing_config_id: config.id,
    preset: config.preset,
    target_user: config.targetUser,
    goal: config.goal,
    selected_features: serializeWorkspaceListField(config.features),
    recommended_toolkits: serializeWorkspaceListField(config.toolkits),
    constraints: config.constraints,
    custom_system_prompt: config.customSystemPrompt,
    assembly_stage: 'review',
    env_created: knownEnvDir ? '1' : '0',
    env_dir: knownEnvDir,
    env_configured_name: config.envConfiguredName || (previousMatchesConfig ? previousForm.env_configured_name : '') || (knownEnvDir ? config.id : ''),
    env_configured_features: serializeWorkspaceListField(knownConfiguredFeatures),
    env_status: config.envStatus || (previousMatchesConfig ? previousForm.env_status : '') || (knownEnvDir ? 'ready' : ''),
    env_status_message: knownEnvDir
      ? (currentLanguage === 'zh'
        ? (config.envStatus === 'stale' ? '已载入配置；环境需要按当前能力重新配置。' : '已载入配置，可继续修改或重新启动实例。')
        : (config.envStatus === 'stale' ? 'Setup loaded. Reconfigure the environment for the current capabilities.' : 'Setup loaded. You can keep editing or launch a new instance.'))
      : (currentLanguage === 'zh'
        ? '已载入配置；如果这是首次启动，请先配置环境目录。'
        : 'Setup loaded. Configure the environment directory before the first launch.'),
    model_preset: config.modelPreset || '',
    workdir: config.workdir || '',
  });
  draft['feature-configs'] = normalizeFeatureConfigMap(config.featureConfigs);
  saveWorkspaceFormDraft(agent.id, draft);
  try {
    await persistWorkspaceState(agent, draft, { openDirectory: knownEnvDir });
  } catch (error) {
    console.error('Failed to load assembly config:', error);
  }
  setPreferredUnitMode('assembly', agent);
  if (agent?.id === 'flow-workspace' && window.ClawFW?.mode === 'detail') {
    currentWorkspaceTab = 'workspace';
  } else {
    currentWorkspaceTab = 'assembly';
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.launchAssemblyConfig = async (configId) => {
  const _t0 = performance.now();
  console.log(`[PERF-CLIENT] launchAssemblyConfig BEGIN configId=${configId}`);
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const config = getSavedAssemblyConfigs(agent).find((item) => item.id === String(configId || '').trim());
  if (!config) return;
  const envDir = String(config.envDir || '').trim();
  const draft = getWorkspaceFormDraft(agent);
  draft['assembly-form'] = {
    assembly_name: config.id,
    display_name: String(config.displayName || '').trim(),
    editing_config_id: config.id,
    preset: config.preset,
    target_user: config.targetUser,
    goal: config.goal,
    selected_features: serializeWorkspaceListField(config.features),
    recommended_toolkits: serializeWorkspaceListField(config.toolkits),
    constraints: config.constraints,
    custom_system_prompt: config.customSystemPrompt,
    assembly_stage: 'review',
    env_created: envDir ? '1' : '0',
    env_dir: envDir,
    env_configured_name: config.envConfiguredName || (envDir ? config.id : ''),
    env_configured_features: serializeWorkspaceListField(config.envConfiguredFeatures || []),
    env_status: config.envStatus || (envDir ? 'ready' : ''),
    env_status_message: '',
  };
  draft['feature-configs'] = normalizeFeatureConfigMap(config.featureConfigs);
  saveWorkspaceFormDraft(agent.id, draft);
  try {
    await persistWorkspaceState(agent, draft, { openDirectory: envDir });
    console.log(`[PERF-CLIENT] launchAssemblyConfig persist done (${(performance.now() - _t0).toFixed(0)}ms)`);
  } catch (error) {
    console.error('Failed to stage assembly config for launch:', error);
  }
  console.log(`[PERF-CLIENT] launchAssemblyConfig calling launchAssemblyInstance (${(performance.now() - _t0).toFixed(0)}ms)`);
  await window.launchAssemblyInstance();
};

window.deleteSavedAssemblyConfig = async (configId) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const normalizedId = String(configId || '').trim();
  const keep = getSavedAssemblyConfigs(agent).filter((item) => item.id !== normalizedId);
  const currentState = getAgentWorkspaceState(agent);
  const draft = getWorkspaceFormDraft(agent);
  const currentForm = normalizeAssemblyDraft(draft['assembly-form'] || {});
  if (String(currentForm.editing_config_id || '').trim() === normalizedId || String(currentForm.assembly_name || '').trim() === normalizedId) {
    draft['assembly-form'] = normalizeAssemblyDraft({
      assembly_stage: 'goal',
      preset: 'general-chatbot',
      editing_config_id: '',
      env_created: '0',
      env_status: '',
      env_status_message: '',
      env_dir: '',
      env_configured_name: '',
      env_configured_features: '',
    });
    draft['feature-configs'] = {};
  }
  const response = await fetch('/protoclaw/workspace_state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: agent.id,
      state: {
        forms: draft,
        openDirectory: currentState?.openDirectory || '',
        assemblyConfigs: keep,
      },
    }),
  });
  if (!response.ok) {
    window.alert('Failed to delete assembly config.');
    return;
  }
  const nextState = await response.json();
  updateAgentWorkspaceState(agent.id, nextState);
  saveWorkspaceFormDraft(agent.id, nextState.forms || {});
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

// ═══════════════════════════════════════════════════════════════════
// 域 Q — Session 运行恢复 / 按钮包装
// ═══════════════════════════════════════════════════════════════════

window.launchSavedAssemblyRun = async (sessionId) => {
  const _t0 = performance.now();
  console.log(`[PERF-CLIENT] launchSavedAssemblyRun BEGIN sessionId=${sessionId}`);
  try {
    const currentAgent = getCurrentAgentRecord();
    const session = getWorkspaceSessionById(currentAgent, sessionId);
    if (session && isAssemblySessionRunning(currentAgent, session)) {
      const liveRuntime = allAgents.find((item) => (
        item?.source === 'prebuilt'
        && String(item?.active_workspace_session_form_id || '') === 'assembly-form'
        && String(item?.active_workspace_session_id || item?.workspace_sessions?.activeSessionId || '').trim() === String(sessionId).trim()
        && (item.runtime_session_id || item.runtimeSessionId || item.id)
      )) || null;
      const liveRuntimeId = liveRuntime?.runtime_session_id || liveRuntime?.runtimeSessionId || liveRuntime?.id || currentAgent?.runtime_session_id || currentAgent?.runtimeSessionId || null;
      if (liveRuntimeId) {
        console.log(`[PERF-CLIENT] launchSavedAssemblyRun already running, switching (${(performance.now() - _t0).toFixed(0)}ms)`);
        await requestSwitch(liveRuntimeId, 'assembly-resume');
        return;
      }
    }
    const launchRuntime = async () => {
      console.log(`[PERF-CLIENT] launchSavedAssemblyRun calling /assembly_runtime/start (${(performance.now() - _t0).toFixed(0)}ms)`);
      const response = await fetch('/protoclaw/assembly_runtime/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: currentAgent?.id || 'agent-creator', sessionId }),
      });
      if (!response.ok) {
        throw new Error(await response.text().catch(() => 'Assembly runtime failed'));
      }
      const payload = await response.json();
      console.log(`[PERF-CLIENT] launchSavedAssemblyRun /assembly_runtime/start response (${(performance.now() - _t0).toFixed(0)}ms)`);
      await loadAgents();
      console.log(`[PERF-CLIENT] launchSavedAssemblyRun loadAgents done (${(performance.now() - _t0).toFixed(0)}ms)`);
      const nextRuntimeId = payload?.runtime?.id || payload?.runtime?.viewerAgentId || null;
      if (nextRuntimeId) {
        await requestSwitch(nextRuntimeId, 'assembly-launch');
        console.log(`[PERF-CLIENT] launchSavedAssemblyRun switchAgent done (${(performance.now() - _t0).toFixed(0)}ms)`);
        return;
      }
      selectWorkspaceSurface('agent-creator', { skipFeaturePanel: true });
      shouldAnimateWorkspaceSurface = false;
      renderCurrentMainView();
    };
    await maybeWarnAssemblySessionDrift(currentAgent, sessionId, launchRuntime);
  } catch (error) {
    console.error('Failed to relaunch assembly runtime:', error);
    window.alert('Assembly runtime failed: ' + (error && error.message ? error.message : error));
  }
};

window.fwLaunchConfig = async (configId, btn) => {
  if (btn) { btn.classList.add('fw-btn-busy'); btn.disabled = true; btn.textContent = currentLanguage === 'zh' ? '启动中...' : 'Launching...'; }
  assemblyLaunchInProgress = true;
  const _t0 = performance.now();
  console.log(`[PERF-CLIENT] fwLaunchConfig BEGIN configId=${configId}`);
  try {
    await window.launchAssemblyConfig(configId);
    console.log(`[PERF-CLIENT] fwLaunchConfig COMPLETE (${(performance.now() - _t0).toFixed(0)}ms)`);
  } catch (e) {
    console.error(`[PERF-CLIENT] fwLaunchConfig FAILED (${(performance.now() - _t0).toFixed(0)}ms)`, e);
    if (btn) { btn.classList.remove('fw-btn-busy'); btn.disabled = false; btn.textContent = currentLanguage === 'zh' ? '启动' : 'Launch'; }
  } finally {
    assemblyLaunchInProgress = false;
  }
};

window.fwResumeRun = async (sessionId, btn) => {
  if (btn) { btn.classList.add('fw-btn-busy'); btn.disabled = true; btn.textContent = currentLanguage === 'zh' ? '启动中...' : 'Launching...'; }
  assemblyLaunchInProgress = true;
  const _t0 = performance.now();
  console.log(`[PERF-CLIENT] fwResumeRun BEGIN sessionId=${sessionId}`);
  try {
    await window.launchSavedAssemblyRun(sessionId);
    console.log(`[PERF-CLIENT] fwResumeRun COMPLETE (${(performance.now() - _t0).toFixed(0)}ms)`);
  } catch (e) {
    console.error(`[PERF-CLIENT] fwResumeRun FAILED (${(performance.now() - _t0).toFixed(0)}ms)`, e);
    if (btn) { btn.classList.remove('fw-btn-busy'); btn.disabled = false; btn.textContent = currentLanguage === 'zh' ? '继续' : 'Continue'; }
  } finally {
    assemblyLaunchInProgress = false;
  }
};

// ═══════════════════════════════════════════════════════════════════
// 域 Q — Session 记录管理
// ═══════════════════════════════════════════════════════════════════

window.deleteAssemblySessionRecord = async (sessionId) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const session = getWorkspaceSessionById(agent, sessionId);
  const confirmed = window.confirm(currentLanguage === 'zh'
    ? `确认删除这个实例记录？\n${session?.agentName || sessionId}`
    : `Delete this instance record?\n${session?.agentName || sessionId}`);
  if (!confirmed) return;

  try {
    const affectedRuntimeId = agent?.runtime_session_id || agent?.runtimeSessionId || null;
    const deletedWasActive = sessionId === (agent?.active_workspace_session_id || agent?.workspace_sessions?.activeSessionId || null);
    const response = await fetch('/protoclaw/prebuilt_sessions/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: agent.id,
        sessionId,
        responseMode: 'delta',
      }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'delete session failed'));
    }
    const result = await response.json();
    if (typeof applySessionMutationDelta === 'function') {
      applySessionMutationDelta(agent.id, result);
    }
    if (result?.assemblyRuntime?.status === 'stopped' || result?.assemblyRuntime?.status === 'stopping') {
      await loadAgents();
      if (currentRuntimeAgentId) {
        selectWorkspaceSurface(agent.id, { skipFeaturePanel: true });
      }
    }
    if (result?.deleted?.sessions) {
      updateAgentRecord(agent.id, {
        workspace_sessions: result.deleted.sessions,
        active_workspace_session_id: result.deleted.activeSessionId || null,
      });
    }
    if (result?.agent) {
      applyManagedPrebuiltAgent(agent.id, result.agent);
    } else if (deletedWasActive) {
      applyManagedPrebuiltAgent(agent.id, null);
    }
    renderAgentList();
    renderCurrentMainView();

    const nextRuntimeId = result?.agent?.runtime_session_id || result?.agent?.runtimeSessionId || null;
    if (nextRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
      await requestSwitch(nextRuntimeId, 'session-delete');
    } else if (affectedRuntimeId && currentRuntimeAgentId === affectedRuntimeId) {
      selectWorkspaceSurface(agent.id, { skipFeaturePanel: true });
    }
  } catch (error) {
    console.error('Failed to delete assembly session record:', error);
    window.alert((currentLanguage === 'zh' ? '删除实例记录失败：' : 'Failed to delete instance record: ') + (error?.message || error));
  }
};

window.loadAssemblySessionIntoDraft = async (sessionId) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const session = getWorkspaceSessionById(agent, sessionId);
  if (!session) return;
  const savedConfig = getSavedAssemblyConfigs(agent).find((item) => item.id === String(session.agentName || '').trim()) || null;
  const currentDraft = getWorkspaceFormDraft(agent);

  if (savedConfig) {
    await window.loadSavedAssemblyConfig(savedConfig.id);
  } else {
    currentDraft['assembly-form'] = normalizeAssemblyDraft({
      ...(currentDraft['assembly-form'] || {}),
      assembly_name: String(session.agentName || '').trim(),
      editing_config_id: '',
      assembly_stage: 'review',
      env_created: session.openDirectory ? '1' : '0',
      env_dir: String(session.openDirectory || '').trim(),
      env_configured_name: String(session.agentName || '').trim(),
      env_status: isAssemblySessionRunning(agent, session) ? 'running' : 'ready',
      env_status_message: isAssemblySessionRunning(agent, session)
        ? (currentLanguage === 'zh' ? '这个实例当前正在运行。' : 'This chatbot instance is currently running.')
        : (currentLanguage === 'zh' ? '已从历史实例恢复基础信息。' : 'Restored base information from the previous instance.'),
    });
    saveWorkspaceFormDraft(agent.id, currentDraft);
    await persistWorkspaceState(agent, currentDraft, {
      openDirectory: String(session.openDirectory || '').trim(),
    });
  }

  setPreferredUnitMode('assembly', agent);
  if (agent?.id === 'flow-workspace' && window.ClawFW?.mode === 'detail') {
    currentWorkspaceTab = 'workspace';
  } else {
    currentWorkspaceTab = 'assembly';
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

window.stopAssemblySessionRuntime = async (sessionId) => {
  try {
    const response = await fetch('/protoclaw/assembly_runtime/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'stop assembly runtime failed'));
    }
    await response.json();
    const currentAgent = getCurrentAgentRecord();
    if (currentAgent?.id === 'agent-creator') {
      const draft = getWorkspaceFormDraft(currentAgent);
      const form = normalizeAssemblyDraft(draft['assembly-form'] || {});
      const session = getWorkspaceSessionById(currentAgent, sessionId);
      if (session && String(form.assembly_name || '').trim() === String(session.agentName || '').trim()) {
        await syncAssemblyEnvironmentDraft(currentAgent, draft, {
          env_status: 'ready',
          env_status_message: currentLanguage === 'zh'
            ? '实例已关闭，配置仍可继续编辑或重新启动。'
            : 'Instance stopped. The setup remains available for editing or relaunching.',
        }, {
          persist: true,
        }).catch(e => console.warn(e));
      }
    }
    await loadAgents();
    if (currentRuntimeAgentId && !allAgents.some((item) => item.id === currentRuntimeAgentId)) {
      selectWorkspaceSurface('agent-creator', { skipFeaturePanel: true });
    }
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to stop assembly runtime:', error);
    window.alert((currentLanguage === 'zh' ? '关闭实例失败：' : 'Failed to stop instance: ') + (error?.message || error));
  }
};

// ═══════════════════════════════════════════════════════════════════
// 域 Q — 通用 Workspace 表单操作
// ═══════════════════════════════════════════════════════════════════

window.chooseWorkspaceDirectory = async (formId, fieldName) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  try {
    const useExistingDirectory = agent.id === 'programming-helper';
    const selected = await invoke(useExistingDirectory ? 'select_directory' : 'select_empty_directory');
    if (selected?.cancelled || !selected?.path) {
      return;
    }
    const draft = getWorkspaceFormDraft(agent);
    draft[formId] = draft[formId] || {};
    draft[formId][fieldName] = selected?.path || '';
    saveWorkspaceFormDraft(agent.id, draft);
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
    persistWorkspaceState(agent, draft).catch((error) => {
      console.error('Failed to persist directory selection:', error);
    });
  } catch (error) {
    window.alert(t('workspace_pick_directory_failed') + (error && error.message ? error.message : error));
  }
};

window.saveWorkspaceForm = async (formId, rawAction) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  let openDirectoryOverride = null;
  if (agent.id === 'feature-creator' && formId === 'startup-form') {
    const startupDraft = normalizeWorkspaceStartupDraft(agent, draft[formId] || {});
    draft[formId] = startupDraft;
    if (!isValidFeatureCreatorName(startupDraft.feature_name)) {
      window.alert(t('feature_creator_invalid_name'));
      return;
    }
    if (startupDraft.install_mode === 'custom' && !startupDraft.target_dir) {
      window.alert(t('workspace_pick_directory_hint'));
      return;
    }
    if (rawAction) {
      try {
        const response = await fetch('/protoclaw/feature_creator/initialize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            featureName: startupDraft.feature_name,
            parentDir: startupDraft.target_dir,
          }),
        });
        if (!response.ok) {
          throw new Error(await response.text().catch(() => 'Feature initialization failed'));
        }
        const result = await response.json();
        openDirectoryOverride = result?.outputDir || getFeatureCreatorOutputDirectory(agent, startupDraft);
      } catch (error) {
        window.alert(t('feature_creator_init_failed') + (error && error.message ? error.message : error));
        return;
      }
    }
  } else if (agent.id === 'agent-creator' && formId === 'startup-form') {
    const startupDraft = normalizeWorkspaceStartupDraft(agent, draft[formId] || {});
    draft[formId] = startupDraft;
    if (!isValidAgentCreatorName(startupDraft.agent_name)) {
      window.alert('Agent name must use lowercase letters, numbers, and hyphens only.');
      return;
    }
    if (startupDraft.install_mode === 'custom' && !startupDraft.target_dir) {
      window.alert(t('workspace_pick_directory_hint'));
      return;
    }
    if (rawAction) {
      try {
        const response = await fetch('/protoclaw/agent_creator/initialize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentName: startupDraft.agent_name,
            parentDir: startupDraft.target_dir,
            goal: startupDraft.goal || '',
          }),
        });
        if (!response.ok) {
          throw new Error(await response.text().catch(() => 'Agent initialization failed'));
        }
        const result = await response.json();
        openDirectoryOverride = result?.outputDir || getAgentCreatorOutputDirectory(agent, startupDraft);
      } catch (error) {
        window.alert('Agent initialization failed: ' + (error && error.message ? error.message : error));
        return;
      }
    }
  } else if (agent.id === 'agent-creator' && formId === 'assembly-form') {
    const assemblyDraft = { ...(draft[formId] || {}) };
    if (!isValidAgentCreatorName(assemblyDraft.assembly_name)) {
      window.alert('Assembly name must use lowercase letters, numbers, and hyphens only.');
      return;
    }
    draft[formId] = assemblyDraft;
  }
  saveWorkspaceFormDraft(agent.id, draft);
  try {
    await persistWorkspaceState(agent, draft, { openDirectory: openDirectoryOverride });
  } catch (error) {
    console.error('Failed to persist workspace form:', error);
    window.alert(`Workspace save failed: ${error && error.message ? error.message : error}`);
    return;
  }
  if (rawAction) {
    await window.runWorkspaceAction(rawAction);
    return;
  }
  renderCurrentMainView();
};

window.resetWorkspaceForm = async (formId) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  if (formId) {
    delete draft[formId];
    saveWorkspaceFormDraft(agent.id, draft);
  } else {
    resetWorkspaceFormDraft(agent.id);
  }
  try {
    await persistWorkspaceState(agent, formId ? draft : {});
  } catch (error) {
    console.error('Failed to reset workspace form state:', error);
  }
  renderCurrentMainView();
};
