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
 *   phSearchQuery, _phSearchTimer (app-core.js)
 * window 函数:
 *   phOpenModelConfig, phCloseModelConfig, phAutoSaveModelConfig,
 *   phOpenProject, phOpenProjectDirectory, phSwitchProject, phToggleProjectDropdown,
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
  let presets = getClawModelPresets();
  window.phModelConfigAgentId = typeof getLogicalAgentId === 'function' ? getLogicalAgentId(agent) : agent.id;
  // 先渲染（已有缓存或空态），模型预置属补数据——点击到弹窗出现不等网络
  renderPhModelConfigOverlay(agent, presets);
  const stillOpen = () => Boolean(document.getElementById('ph-model-config-host')?.querySelector('.feature-detail-overlay'));
  if (!presets.length) {
    try {
      const resp = await fetch('/protoclaw/model_config');
      const data = await resp.json();
      presets = setClawModelPresets(Array.isArray(data?.presets) ? data.presets : []);
    } catch (e) {
      console.error('Failed to load presets:', e);
    }
    if (presets.length && stillOpen()) renderPhModelConfigOverlay(agent, presets);
  }
  // coder APP 的模型配置存 agent-configs/coder.json（agentId=coder 寻址），
  // 与主 APP 分开拉取；面板渲染与保存共用这份缓存。
  if (window.phModelConfigAgentId === 'programming-helper'
    && !(window.ClawFW && window.ClawFW._coderModelPresets)) {
    try {
      const resp = await fetch('/protoclaw/agent_model_presets?agentId=coder');
      const data = await resp.ok ? await resp.json() : null;
      if (window.ClawFW) {
        window.ClawFW._coderModelPresets = (data && data.modelPresets) || {};
      }
      if (stillOpen()) renderPhModelConfigOverlay(agent, presets);
    } catch (e) {
      console.error('Failed to load coder presets:', e);
    }
  }
};

window.phCloseModelConfig = () => {
  // Feature 设置二级页持有共享配置编辑器实例，关闭弹窗时一并释放；
  // 身份落点与页内细节态全部重置——只记忆一级分页（模型配置/进程模式/Feature 设置）
  if (typeof _closePhFeatureEditor === 'function') _closePhFeatureEditor();
  if (typeof window._phResetFeaturePageState === 'function') window._phResetFeaturePageState();
  const host = document.getElementById('ph-model-config-host');
  if (host) host.innerHTML = '';
};

window.phModelSlotChanged = (select) => {
  if (!select) return;
  const effortSelect = document.querySelector('#ph-model-config-host .ph-mc-effort[data-preset-role="' + select.dataset.presetRole + '"][data-slot="' + select.dataset.slot + '"]');
  if (effortSelect) {
    const preset = getClawModelPresets().find(function(item) { return item.name === select.value; });
    const options = preset && window.ClawFW?.getThinkingEffortOptions?.(preset.provider || preset.protocol) || [];
    const selectedEffort = preset?.thinkingEffort || '';
    effortSelect.innerHTML = '<option value="">' + (currentLanguage === 'zh' ? '默认' : 'Default') + '</option>'
      + options.map(function(effort) {
        return '<option value="' + escapeHtml(effort) + '"' + (effort === selectedEffort ? ' selected' : '') + '>' + escapeHtml(effort) + '</option>';
      }).join('');
    effortSelect.value = selectedEffort;
    effortSelect.disabled = !preset || options.length === 0;
    if (window.ClawSelect) window.ClawSelect.enhance(effortSelect);
  }
  window.phAutoSaveModelConfig();
};

window.phAutoSaveModelConfig = async () => {
  const agentId = window.phModelConfigAgentId;
  if (!agentId) return;
  const selects = document.querySelectorAll('#ph-model-config-host .ph-mc-select');
  const effortSelects = document.querySelectorAll('#ph-model-config-host .ph-mc-effort');
  const modelPresets = { default: null, system: null };

  // 收集所有模型和思考强度槽位值。
  const collected = {};
  selects.forEach(function(sel) {
    const role = sel.dataset.presetRole;
    const slot = sel.dataset.slot;
    if (!role) return;
    if (!collected[role]) collected[role] = {};
    collected[role][slot || 'primary'] = sel.value || null;
  });
  effortSelects.forEach(function(sel) {
    const role = sel.dataset.presetRole;
    const slot = sel.dataset.slot;
    if (!role || !slot) return;
    if (!collected[role]) collected[role] = {};
    if (!collected[role].thinkingEffort) collected[role].thinkingEffort = {};
    collected[role].thinkingEffort[slot] = sel.value || null;
  });

  // 每个角色保存模型槽位及其独立思考强度。
  for (const role of Object.keys(modelPresets)) {
    const data = collected[role] || {};
    const primary = data.primary || null;
    const secondary = data.secondary || null;
    const thinkingEffort = data.thinkingEffort || {};
    if (role === 'default') {
      modelPresets[role] = primary || secondary || thinkingEffort.primary || thinkingEffort.secondary
        ? { primary, secondary, thinkingEffort }
        : null;
    } else {
      modelPresets[role] = primary || thinkingEffort.primary
        ? { primary, thinkingEffort: { primary: thinkingEffort.primary || null } }
        : null;
    }
  }

  // coder 行单独保存到 agent-configs/coder.json 的 default 角色（coder APP
  // 运行时按 agentId=coder 读取该文件）；面板无 coder 行时跳过
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
      const coderConfig = coderPreset || collected.coder.thinkingEffort?.primary
        ? { primary: coderPreset, thinkingEffort: { primary: collected.coder.thinkingEffort?.primary || null } }
        : null;
      const coderResp = await fetch('/protoclaw/agent_model_presets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'coder', modelPresets: { default: coderConfig } }),
      });
      const coderResult = await coderResp.json();
      if (coderResult.ok && window.ClawFW) {
        window.ClawFW._coderModelPresets = { default: coderConfig };
      }
    }
    // 刷新覆层以更新 info 文本
    const presets = getClawModelPresets();
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
    await window.phOpenProjectDirectory(chosenPath);
  } catch (error) {
    console.error('Failed to open project:', error);
    window.alert((currentLanguage === 'zh' ? '打开目录失败：' : 'Failed to open directory: ') + (error?.message || error));
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
  }
};

// 以给定目录打开（加入目录列表并设为当前目录，ph_project/open 一次完成），
// 随后按目录切片拉取会话首屏。目录来源由调用方决定：工具栏「打开目录」按钮
// 先弹目录选择器；桌面右键「在编程小助手中打开」由壳直接给定
// （modules/desktop-open.js）。
window.phOpenProjectDirectory = async (chosenPath) => {
  const currentAgent = getCurrentAgentRecord();
  if (!currentAgent || !isPhStyleWorkspaceAgent(currentAgent) || !chosenPath) {
    return;
  }

  try {
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
    // 「打开目录」是显式目录选择：回到目录默认集合（清除可能的项目目标）
    setPhBrowsingTarget(currentAgent.id, {
      type: 'dir',
      id: 'dir:' + String(chosenPath).replace(/\\/g, '/').toLowerCase(),
    });
    // 多选状态随导航作废（状态不跨目录/归属泄漏）
    if (typeof window.phSessionMoveReset === 'function') window.phSessionMoveReset();

    // 目录会话列表首屏（按目录切片拉取）
    const loaded = await phLoadProjectSessions(chosenPath);
    if (!loaded) {
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
    }
  } catch (error) {
    console.error('Failed to open project:', error);
    window.alert((currentLanguage === 'zh' ? '打开目录失败：' : 'Failed to open directory: ') + (error?.message || error));
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
  }
};

window.phSwitchProject = async (projectId) => {
  const currentAgent = getCurrentAgentRecord();
  if (!currentAgent || !isPhStyleWorkspaceAgent(currentAgent)) {
    return;
  }

  // 选中即收起菜单与子菜单：切换是异步的（fetch + 重渲染），不能依赖
  // 悬停超时/点击兜底——浮动面板在重渲染窗口内可见会闪现（见
  // _phCloseDirectorySubmenus 的顺序说明）。
  document.querySelectorAll('.ph-project-dropdown.open').forEach((item) => item.classList.remove('open'));
  _phCloseDirectorySubmenus();

  // 项目目标（ticket 045，prj_* 稳定身份）：纯前端浏览目标切换 + 按项目
  // 过滤拉取会话切片。不调用 ph_project/switch（那是目录身份的 workspace
  // 目录切换），也不改变 workspace_state.openDirectory——项目选择不被
  // 目录轮询覆盖，靠 typed target 持久化保证。
  if (String(projectId || '').startsWith('prj_')) {
    const entity = (window.ClawFW.phProjectEntities?.projects || [])
      .find((p) => p.id === projectId) || null;
    // 元数据未加载完：不退回另一个目标（契约），先补拉实体再继续
    if (!entity) {
      await ensurePhProjectEntitiesLoaded();
    }
    const resolved = (window.ClawFW.phProjectEntities?.projects || [])
      .find((p) => p.id === projectId) || null;
    if (!resolved) {
      window.alert((currentLanguage === 'zh' ? '项目不存在：' : 'Project not found: ') + projectId);
      return;
    }
    // 目录决定位置：跨目录项目（左侧目录树二级进入）先把工作区目录切到
    // 项目绑定目录——仅当该目录已在目录注册表（workspace phProjects）里；
    // 项目绑定目录（含托管）不写目录注册表，位置随项目目标视图寻址。
    const wsStateNow = (typeof getAgentWorkspaceState === 'function')
      ? (getAgentWorkspaceState(currentAgent) || {}) : {};
    const normDir = (dir) => String(dir || '').replace(/\\/g, '/').toLowerCase();
    const entityDirNorm = normDir(resolved.openDirectory);
    const wsDirNorm = normDir(wsStateNow.openDirectory);
    const registryDirs = (Array.isArray(wsStateNow.phProjects) ? wsStateNow.phProjects : [])
      .map((p) => normDir(p?.openDirectory)).filter(Boolean);
    if (entityDirNorm && entityDirNorm !== wsDirNorm && registryDirs.includes(entityDirNorm)) {
      try {
        const dirSwitchRes = await fetch('/protoclaw/ph_project/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: currentAgent.id, projectId: 'dir:' + entityDirNorm }),
        });
        if (!dirSwitchRes.ok) {
          throw new Error(await dirSwitchRes.text().catch(() => 'Failed to switch directory'));
        }
        const dirSwitchResult = await dirSwitchRes.json();
        const freshDirState = dirSwitchResult.state
          || await (await fetch('/protoclaw/workspace_state?agentId=' + encodeURIComponent(currentAgent.id))).json();
        updateAgentWorkspaceState(currentAgent.id, freshDirState);
      } catch (error) {
        console.error('Failed to switch directory for project:', error);
        window.alert((currentLanguage === 'zh' ? '切换目录失败：' : 'Failed to switch directory: ') + (error?.message || error));
        return;
      }
    }
    setPhBrowsingTarget(currentAgent.id, { type: 'project', id: projectId });
    if (window.ClawFW) window.ClawFW.phSurfaceViewProjectId = null;
    // 多选状态随归属切换作废（状态不跨目录/归属泄漏）
    if (typeof window.phSessionMoveReset === 'function') window.phSessionMoveReset();
    phSearchQuery = '';
    if (_phSearchTimer) { clearTimeout(_phSearchTimer); _phSearchTimer = null; }
    if (typeof window.phSearchResetState === 'function') window.phSearchResetState();
    const loaded = await phLoadProjectSessions({ projectId });
    if (!loaded) {
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
    }
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
    if (_phSearchTimer) { clearTimeout(_phSearchTimer); _phSearchTimer = null; }
    // 搜索结果/范围/分页等模块状态一并作废（身份已随项目切换漂移）
    if (typeof window.phSearchResetState === 'function') window.phSearchResetState();
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
    return;
  }
  if (window.ClawFW) window.ClawFW.phSurfaceViewProjectId = null;

  // 项目绑定目录（含托管，不在目录注册表）：纯视图导航——目录清单收录项目
  // 绑定目录，但选择它不写 workspace_state、不进目录注册表、不触发
  // ph_project/switch（switch 会把目录 upsert 进旧目录 state / docset 同步）。
  // 目录会话仍按 projectDir 切片正常呈现。
  if (!targetProject) {
    const normDirId = (dir) => 'dir:' + String(dir || '').replace(/\\/g, '/').toLowerCase();
    const boundEntity = (window.ClawFW.phProjectEntities?.projects || [])
      .find((p) => !p.archived && p.openDirectory && normDirId(p.openDirectory) === projectId);
    if (boundEntity) {
      setPhBrowsingTarget(currentAgent.id, { type: 'dir', id: projectId });
      phSearchQuery = '';
      if (_phSearchTimer) { clearTimeout(_phSearchTimer); _phSearchTimer = null; }
      if (typeof window.phSearchResetState === 'function') window.phSearchResetState();
      if (typeof window.phSessionMoveReset === 'function') window.phSessionMoveReset();
      const loaded = await phLoadProjectSessions({ projectDir: boundEntity.openDirectory });
      if (!loaded) {
        lastRenderedWorkspaceHtml = '';
        renderCurrentMainView();
      }
      return;
    }
    // 未知目录 id（既非注册目录桶也非项目绑定目录）：落入下方旧路径，
    // 服务端显式拒绝（alert），不静默 fallback。
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
    // 目录切换也是显式选择：记录 typed target（ticket 045），轮询的
    // workspace_state 更新不再反向改写浏览目标。
    setPhBrowsingTarget(currentAgent.id, { type: 'dir', id: projectId });

    // Close dropdown（双选择器并存：收起全部打开的下拉）
      document.querySelectorAll('.ph-project-dropdown.open').forEach((item) => item.classList.remove('open'));
      _phCloseDirectorySubmenus();

      // Clear search state on project switch
    phSearchQuery = '';
    if (_phSearchTimer) { clearTimeout(_phSearchTimer); _phSearchTimer = null; }
    // 搜索结果/范围/分页等模块状态一并作废（身份已随项目切换漂移）
    if (typeof window.phSearchResetState === 'function') window.phSearchResetState();
    // 多选状态随目录切换作废（状态不跨目录/归属泄漏）
    if (typeof window.phSessionMoveReset === 'function') window.phSessionMoveReset();

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

async function phFetchSessionsPage(agentId, { projectDir = '', projectId = '', offset = 0, limit = 60 } = {}) {
  const params = new URLSearchParams({
    agentId,
    offset: String(offset),
    limit: String(limit),
  });
  // 归属过滤二选一（服务端互斥校验，ticket 044）：项目目标按 projectId，
  // 目录目标按 projectDir；两者都缺 = 全量（不应出现在 PH surface 路径）。
  if (projectId) params.set('projectId', projectId);
  else if (projectDir) params.set('projectDir', projectDir);
  const response = await fetch('/protoclaw/prebuilt_sessions?' + params.toString());
  if (!response.ok) throw new Error('session page request failed: ' + response.status);
  return await response.json();
}

/** 当前浏览目标的归属过滤参数（typed target → 请求参数）。 */
function _phBrowsingOwnershipParams(agent) {
  const target = typeof getPhBrowsingTarget === 'function' ? getPhBrowsingTarget(agent) : null;
  if (!target) return {};
  if (target.type === 'project') return { projectId: target.id };
  return { projectDir: target.openDirectory || '' };
}

async function phLoadProjectSessions(target) {
  const agent = getCurrentAgentRecord();
  if (!agent || typeof isPhStyleWorkspaceAgent !== 'function' || !isPhStyleWorkspaceAgent(agent)) return false;
  // 兼容旧签名（目录字符串）；对象形态携带 projectId 或 projectDir
  const ownership = typeof target === 'string'
    ? { projectDir: target }
    : { projectId: String(target?.projectId || '').trim(), projectDir: String(target?.projectDir || '').trim() };
  try {
    const fresh = await phFetchSessionsPage(agent.id, { ...ownership, offset: 0, limit: 60 });
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

// ── 加载更多的原地落地：只同步会话列表区，不重建 workspace surface ──
// surface 的 innerHTML 全量替换会连带销毁重建 banner 里的目录切换下拉
// （open 状态丢失）、目录子菜单浮窗锚点与搜索输入框——用户悬停目录行
// 滚动列表触发自动加载时，浮窗先收起、hover 事件向新 DOM 重放后再被
// 重新定位打开，表现为"收起重放、大小跳变"。加载更多是纯列表增量，
// 只同步 tab 计数徽标与列表面板；面板 HTML 经 renderWorkspaceSurface
// 重新生成后抽取（与全量渲染同一函数产出，逐字节一致），并把签名缓存
// 同步为该 HTML——否则下一轮轮询签名不匹配会再次全量替换，浮窗仍跳变。
// 结构不匹配（视图已切走 / 焦点漂移）时返回 false，调用方回退全量渲染。
function _phSyncSessionPanelsInPlace() {
  const liveTabsList = document.querySelectorAll('.ph-session-tabs[data-tab-group]');
  if (liveTabsList.length === 0) return false;
  if (typeof renderWorkspaceSurface !== 'function') return false;
  let newHtml;
  try {
    newHtml = renderWorkspaceSurface(getCurrentAgentRecord());
  } catch {
    return false;
  }
  const tpl = document.createElement('template');
  tpl.innerHTML = newHtml;
  const freshTabsList = Array.from(tpl.content.querySelectorAll('.ph-session-tabs[data-tab-group]'));
  let synced = 0;
  for (const liveTabs of liveTabsList) {
    const freshTabs = freshTabsList.find((el) => el.dataset.tabGroup === liveTabs.dataset.tabGroup);
    if (!freshTabs) continue;
    // 计数徽标在按钮内部；active 态在按钮元素自身，不被 innerHTML 替换触碰
    for (const liveTab of liveTabs.querySelectorAll('.ph-session-tab')) {
      const freshTab = Array.from(freshTabs.querySelectorAll('.ph-session-tab'))
        .find((el) => el.dataset.phTab === liveTab.dataset.phTab);
      if (freshTab) liveTab.innerHTML = freshTab.innerHTML;
    }
    // 两个列表面板整体替换：条目 / 时间组头 / 加载更多哨兵 / 空态切换
    // 全部由同一渲染函数产出；面板元素的 active class 保留用户当前 tab
    const livePanels = liveTabs.querySelector('.ph-session-tab-panels');
    const freshPanels = freshTabs.querySelector('.ph-session-tab-panels');
    if (livePanels && freshPanels) {
      livePanels.innerHTML = freshPanels.innerHTML;
      synced += 1;
    }
  }
  if (synced === 0) return false;
  lastRenderedWorkspaceHtml = newHtml;
  // 哨兵节点随面板替换重建：重挂滚动自动加载观察器（与全量渲染路径一致）
  if (typeof window.phSetupLoadMoreAutoScroll === 'function') {
    window.phSetupLoadMoreAutoScroll();
  }
  return true;
}

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
    // 加载更多沿用当前浏览目标的归属过滤（项目切片 / 目录切片，045）
    const fresh = await phFetchSessionsPage(agent.id, {
      ..._phBrowsingOwnershipParams(agent),
      offset: loadedCount,
      limit: 60,
    });
    if (fresh && fresh.unchanged !== true) {
      const merged = typeof mergeWorkspaceSessionSnapshots === 'function'
        ? mergeWorkspaceSessionSnapshots(ws, fresh, agent.id)
        : { ...ws, ...fresh, sessions: [...(ws?.sessions || []), ...(fresh.sessions || [])] };
      updateAgentRecord(agent.id, { workspace_sessions: merged });
      // 原地同步列表区：surface 骨架（目录切换下拉 / 子菜单浮窗 / 搜索
      // 输入态）不重建；同步失败回退既有全量渲染路径。
      if (!_phSyncSessionPanelsInPlace()) {
        lastRenderedWorkspaceHtml = '';
        renderCurrentMainView();
      }
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
  const sentinels = document.querySelectorAll('.ph-session-tab-panel .ph-load-more-wrap');
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

// 触发器 aria-expanded 同步（open class → 属性），toggle/外点/Escape 后调用。
// 触发器形态不统一（目录大字块 / 归属胶囊 / + 按钮），统一以
// button[aria-haspopup] 定位。
function _phSyncDropdownAria() {
  document.querySelectorAll('.ph-project-dropdown').forEach((dropdown) => {
    const trigger = dropdown.querySelector('button[aria-haspopup]');
    if (trigger && typeof trigger.setAttribute === 'function') {
      trigger.setAttribute('aria-expanded', dropdown.classList.contains('open') ? 'true' : 'false');
    }
  });
}

// 双选择器并存（左目录 / 右归属）：点一个 trigger 收起另一个下拉，避免两个
// 菜单同开。旧单下拉行为按 closest 兼容。触发器为 button（键盘可达）。
window.phToggleProjectDropdown = (event) => {
  event.stopPropagation();
  event.preventDefault();
  const target = event.target || event.currentTarget;
  const dropdown = (target && typeof target.closest === 'function')
    ? target.closest('.ph-project-dropdown')
    : document.querySelector('.ph-project-dropdown');
  if (!dropdown) return;
  _phCloseDirectorySubmenus();
  document.querySelectorAll('.ph-project-dropdown.open').forEach((item) => {
    if (item !== dropdown) item.classList.remove('open');
  });
  dropdown.classList.toggle('open');
  _phSyncDropdownAria();
};

// Close dropdown on outside click（多下拉：任一 open 且不含点击目标即收起）
document.addEventListener('click', (e) => {
  let changed = false;
  document.querySelectorAll('.ph-project-dropdown.open').forEach((dropdown) => {
    if (!dropdown.contains(e.target)) {
      dropdown.classList.remove('open');
      changed = true;
    }
  });
  if (changed) _phSyncDropdownAria();
  _phCloseDirectorySubmenus();
});

// Escape 关闭打开的下拉（键盘操作沿既有弹窗的 Escape 语义；子菜单的
// Escape 由专属 keydown 先行处理并 stopPropagation）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  let changed = false;
  document.querySelectorAll('.ph-project-dropdown.open').forEach((dropdown) => {
    dropdown.classList.remove('open');
    changed = true;
  });
  if (changed) _phSyncDropdownAria();
  _phCloseDirectorySubmenus();
});

// 目录树子菜单：同一时刻只展开一个目录；点击菜单外关闭，Escape 关闭并归焦触发器。
function _phCloseDirectorySubmenus() {
  // 先隐藏再复位：顺序颠倒会让仍带 .open 的面板在样式清空的瞬间以
  // 无定位状态在 (0,0) 闪现一帧（关闭闪烁的历史 bug）。
  document.querySelectorAll('.ph-dir-subprojects.open').forEach((menu) => menu.classList.remove('open'));
  document.querySelectorAll('.ph-dir-subprojects[data-floating="true"]').forEach((menu) => {
    menu.removeAttribute('data-floating');
    menu.style.removeProperty('position');
    menu.style.removeProperty('left');
    menu.style.removeProperty('top');
    menu.style.removeProperty('width');
    menu.style.removeProperty('max-width');
    menu.style.removeProperty('max-height');
    menu.style.removeProperty('border-radius');
    const dirId = menu.getAttribute('data-subprojects-for') || '';
    const safeId = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(dirId) : dirId;
    const group = document.querySelector('.ph-dir-nav-group .ph-dir-item[data-dir-id="' + safeId + '"]')?.closest('.ph-dir-nav-group');
    if (group) {
      group.appendChild(menu);
    } else {
      // 锚点目录行已随重渲染消失：浮动副本是孤儿，直接删除
      // （新渲染的菜单内自带新的子菜单节点，旧节点无保留价值）。
      menu.remove();
    }
  });
}

let _phSubmenuCloseTimer = null;
window.phOpenDirectorySubmenu = (group) => {
  if (!group) return;
  // 不变量：子菜单只依附在「打开状态」的宿主菜单上。重渲染后浏览器会向
  // 光标下的新元素重放 mouseenter/focusin，此时宿主可能已关闭（矩形全零，
  // 兜底坐标会算出屏幕左上角）——历史 bug：切换项目后面板在 (0,0) 闪现。
  const hostMenu = document.querySelector('.ph-dir-selector.ph-project-dropdown.open .ph-project-dropdown-menu');
  if (!hostMenu) return;
  if (_phSubmenuCloseTimer) clearTimeout(_phSubmenuCloseTimer);
  const dirItem = group.querySelector('.ph-dir-item');
  const dirId = dirItem?.getAttribute('data-dir-id') || '';
  const safeId = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(dirId) : dirId;
  const sub = document.querySelector('.ph-dir-subprojects[data-subprojects-for="' + safeId + '"]');
  if (!sub) return;
  document.querySelectorAll('.ph-dir-subprojects.open').forEach((item) => {
    if (item !== sub) item.classList.remove('open');
  });
  const rect = group.getBoundingClientRect();
  const menuRect = hostMenu.getBoundingClientRect();
  const desktop = window.matchMedia('(min-width: 641px)').matches;
  sub.dataset.floating = 'true';
  if (sub.parentElement !== document.body) document.body.appendChild(sub);
  sub.style.position = 'fixed';
  const panelWidth = desktop
    ? Math.min(280, window.innerWidth - menuRect.right - 12)
    : Math.min(280, window.innerWidth - 24);
  sub.style.width = panelWidth + 'px';
  sub.style.maxWidth = (window.innerWidth - 24) + 'px';
  sub.style.maxHeight = Math.min(420, window.innerHeight - 24) + 'px';
  // 桌面：面板与宿主菜单右缘无缝衔接（右贴）；窄屏：挂在菜单正下方、
  // 左对齐——不覆盖菜单行（悬停回菜单收起面板的交互依赖菜单可命中）。
  sub.style.left = (desktop
    ? Math.min(menuRect.right - 1, Math.max(8, window.innerWidth - panelWidth - 8))
    : Math.max(8, menuRect.x)) + 'px';
  sub.style.top = Math.max(12, Math.min(desktop ? rect.top : (menuRect.bottom + 4), window.innerHeight - Math.min(sub.offsetHeight || 420, window.innerHeight - 24))) + 'px';
  sub.style.borderRadius = desktop ? '0 8px 8px 0' : '8px';
  sub.classList.add('open');
  dirItem?.setAttribute('aria-expanded', 'true');
}

window.phScheduleDirectorySubmenuClose = () => {
  if (_phSubmenuCloseTimer) clearTimeout(_phSubmenuCloseTimer);
  _phSubmenuCloseTimer = setTimeout(() => {
    const hovered = document.querySelector('.ph-dir-nav-group:hover, .ph-dir-subprojects:hover');
    const focused = document.activeElement?.closest?.('.ph-dir-nav-group, .ph-dir-subprojects');
    if (!hovered && !focused) _phCloseDirectorySubmenus();
  }, 120);
}

document.addEventListener('pointerover', (e) => {
  if (e.target?.closest?.('.ph-dir-subprojects')) {
    if (_phSubmenuCloseTimer) clearTimeout(_phSubmenuCloseTimer);
    return;
  }
  const group = e.target?.closest?.('.ph-dir-nav-group');
  if (group) {
    window.phOpenDirectorySubmenu(group);
    return;
  }
  // 悬停进入目录菜单的非目录行区域（如「打开目录…」入口、留白）：
  // 当前面板失去指向，按既有关闭节奏收起。
  if (e.target?.closest?.('.ph-dir-selector .ph-project-dropdown-menu')) {
    window.phScheduleDirectorySubmenuClose();
  }
});
document.addEventListener('focusin', (e) => {
  // 子菜单面板渲染在菜单外（浮动化后独立数组），不在组内——
  // 不能用 group.querySelector 探测，phOpenDirectorySubmenu 自会按
  // data-subprojects-for 解析，找不到时安全返回。
  const group = e.target?.closest?.('.ph-dir-nav-group');
  if (group) window.phOpenDirectorySubmenu(group);
});document.addEventListener('pointerout', (e) => {
  if (e.target?.closest?.('.ph-dir-nav-group, .ph-dir-subprojects')) window.phScheduleDirectorySubmenuClose();
});

document.addEventListener('click', (e) => {
  if (e.target?.closest?.('.ph-dir-nav-group, .ph-dir-subprojects')) return;
  _phCloseDirectorySubmenus();
});

window.addEventListener('resize', () => _phCloseDirectorySubmenus());

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!document.querySelector('.ph-dir-subprojects.open')) return;
  e.stopPropagation();
  e.preventDefault();
  _phCloseDirectorySubmenus();
  document.querySelector('.ph-dir-selector > .ph-project-dropdown-trigger')?.focus?.();
}, true);

// Open-in-folder 按钮经事件委托接线（目录在 data-open-dir 属性上）。
// 必须用捕获阶段：按钮嵌在下拉项内部，下拉项的内联 onclick 负责切换项目，
// 只有捕获阶段先执行 stopPropagation，才能避免点"打开"时误触发项目切换。
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.ph-dropdown-open-folder');
  if (!btn) return;
  e.stopPropagation();
  window.phOpenInExplorer(btn.getAttribute('data-open-dir') || '');
}, true);

window.phOpenInExplorer = async (dirPath) => {
  if (!dirPath) return;
  try {
    const res = await fetch('/protoclaw/ph_project/open_in_explorer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dirPath }),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      console.error('Open in explorer failed:', payload?.error || ('HTTP ' + res.status), dirPath);
    }
  } catch (e) {
    console.error('Failed to open in explorer:', e);
  }
};

/**
 * 切换主代理的主模型和备选模型
 * 点击操作条上的模型名称时触发
 */
// ── 新建项目（ticket 045）──────────────────────────────────────────
// 名称必填 + 可选目录（缺省由服务端分配托管目录）。创建项目本身不创建
// 会话；成功后进入该项目视图（空项目可见）。取消/关闭无副作用。
window.phOpenNewProjectDialog = () => {
  const currentAgent = getCurrentAgentRecord();
  if (!currentAgent || !isPhStyleWorkspaceAgent(currentAgent)) return;
  const isZh = currentLanguage === 'zh';

  // 当前目录（目录决定位置）：新建项目默认落在当前目录；无当前目录时不
  // 预选任何路径——托管或浏览必须显式选择，不无声指定其他路径。
  const currentDirContext = (typeof getPhCurrentDirectoryContext === 'function')
    ? getPhCurrentDirectoryContext(currentAgent) : null;

  let host = document.getElementById('ph-new-project-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ph-new-project-host';
    document.body.appendChild(host);
  }
  host.innerHTML = '';

  const overlay = document.createElement('div');
  overlay.className = 'feature-detail-overlay';
  overlay.innerHTML = [
    '<form class="feature-detail-window ph-new-project-window" role="dialog" aria-modal="true" novalidate>',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? '新建项目' : 'New Project') + '</div>',
    '<div class="feature-detail-subtitle">' + (isZh ? '项目按目录组织，创建后可改绑目录；不会自动创建对话。' : 'Projects organize by directory; rebind later. No conversation is created automatically.') + '</div>',
    '</div>',
    '<button type="button" class="feature-detail-close ph-new-project-cancel">&times;</button>',
    '</div>',
    '<div class="settings-section">',
    '<div class="settings-field">',
    '<label for="ph-new-project-name">' + (isZh ? '名称' : 'Name') + '</label>',
    '<input type="text" id="ph-new-project-name" class="settings-input" autocomplete="off" maxlength="80" placeholder="' + (isZh ? '项目名称' : 'Project name') + '" />',
    '</div>',
    '<div class="settings-field">',
    '<label>' + (isZh ? '目录' : 'Directory') + '</label>',
    // 目录显式三选：默认当前目录（无当前目录时不预选——不无声指定其他
    // 路径）；其他目录经浏览显式选择；托管目录由服务端分配。
    '<div class="ph-new-project-dir-options" id="ph-new-project-dir-options">',
    (currentDirContext ? (
      '<label class="ph-dir-option">' +
      '<input type="radio" name="ph-new-project-dir-mode" value="current" checked>' +
      '<span class="ph-dir-option-label">' + (isZh ? '当前目录' : 'Current directory') + '</span>' +
      '<span class="ph-dir-option-path">' + escapeHtml(currentDirContext.openDirectory) + '</span>' +
      '</label>'
    ) : ''),
    '<label class="ph-dir-option">' +
    '<input type="radio" name="ph-new-project-dir-mode" value="browse">' +
    '<span class="ph-dir-option-label">' + (isZh ? '其他目录' : 'Other directory') + '</span>' +
    '<button type="button" class="settings-btn settings-btn-secondary ph-new-project-browse">' + (isZh ? '浏览…' : 'Browse…') + '</button>' +
    '<span class="ph-dir-option-path ph-new-project-browse-path"></span>' +
    '</label>',
    '<label class="ph-dir-option">' +
    '<input type="radio" name="ph-new-project-dir-mode" value="managed">' +
    '<span class="ph-dir-option-label">' + (isZh ? '托管目录' : 'Managed directory') + '</span>' +
    '<span class="ph-dir-option-path">' + (isZh ? '服务端分配，稍后可改绑' : 'Assigned by server; rebind later') + '</span>' +
    '</label>',
    '</div>',
    '</div>',
    '<div class="ph-new-project-error" hidden></div>',
    '</div>',
    '<div class="settings-actions">',
    '<button type="button" class="settings-btn settings-btn-secondary ph-new-project-cancel">' + (isZh ? '取消' : 'Cancel') + '</button>',
    '<button type="submit" class="settings-btn settings-btn-primary">' + (isZh ? '创建' : 'Create') + '</button>',
    '</div>',
    '</form>',
  ].join('');
  host.appendChild(overlay);

  const nameInput = overlay.querySelector('#ph-new-project-name');
  const browsePathEl = overlay.querySelector('.ph-new-project-browse-path');
  const errorEl = overlay.querySelector('.ph-new-project-error');
  const submitBtn = overlay.querySelector('button[type="submit"]');
  const previousFocus = document.activeElement;
  let browseDir = '';

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
    if (previousFocus && previousFocus.isConnected) previousFocus.focus();
  };
  const onKeydown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  };
  document.addEventListener('keydown', onKeydown);
  overlay.querySelectorAll('.ph-new-project-cancel').forEach((btn) => btn.addEventListener('click', close));
  overlay.querySelector('.ph-new-project-browse').addEventListener('click', async () => {
    try {
      const result = await invoke('select_directory');
      const chosen = Array.isArray(result?.paths) ? String(result.paths[0] || '').trim() : (typeof result?.path === 'string' ? result.path.trim() : '');
      if (chosen) {
        browseDir = chosen;
        if (browsePathEl) browsePathEl.textContent = chosen;
        const browseRadio = overlay.querySelector('input[name="ph-new-project-dir-mode"][value="browse"]');
        if (browseRadio) browseRadio.checked = true;
      }
    } catch { /* 用户取消选择器：无副作用 */ }
  });
  nameInput.focus();

  overlay.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = String(nameInput.value || '').trim();
    errorEl.hidden = true;
    if (!name) {
      errorEl.textContent = isZh ? '请填写项目名称' : 'Project name is required';
      errorEl.hidden = false;
      nameInput.focus();
      return;
    }
    // 目录三选：当前目录 / 其他目录（浏览）/ 托管目录。未显式选择且无当前
    // 目录时拒绝提交——不无声指定其他路径。
    const modeRadio = overlay.querySelector('input[name="ph-new-project-dir-mode"]:checked');
    const mode = modeRadio ? String(modeRadio.value || '') : '';
    let workDirectory = '';
    if (mode === 'current') {
      workDirectory = currentDirContext?.openDirectory || '';
    } else if (mode === 'browse') {
      workDirectory = browseDir;
      if (!workDirectory) {
        errorEl.textContent = isZh ? '请先浏览选择目录' : 'Browse and pick a directory first';
        errorEl.hidden = false;
        return;
      }
    } else if (mode !== 'managed') {
      errorEl.textContent = isZh ? '请选择项目目录（其他目录 / 托管目录）' : 'Choose a directory (other / managed)';
      errorEl.hidden = false;
      return;
    }
    submitBtn.disabled = true;
    try {
      const response = await fetch('/protoclaw/ph_project/project_create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: currentAgent.id,
          name,
          ...(workDirectory ? { workDirectory } : {}),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || ('HTTP ' + response.status));
      }
      // 创建即显式进入该项目：刷新实体缓存 → typed target → 项目会话切片。
      // 目标项目隐含其绑定目录，两个选择器随之同步。
      await ensurePhProjectEntitiesLoaded(true);
      setPhBrowsingTarget(currentAgent.id, { type: 'project', id: payload.project.id });
      if (typeof window.phSessionMoveReset === 'function') window.phSessionMoveReset();
      close();
      const loaded = await phLoadProjectSessions({ projectId: payload.project.id });
      if (!loaded) {
        lastRenderedWorkspaceHtml = '';
        renderCurrentMainView();
      }
    } catch (error) {
      submitBtn.disabled = false;
      errorEl.textContent = (isZh ? '创建失败：' : 'Failed to create: ') + (error?.message || error);
      errorEl.hidden = false;
    }
  });
};

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
  
  // 主备模型互换后，两个槽位都加载新模型预设的思考强度。
  const presets = getClawModelPresets();
  const presetEffort = (name) => presets.find(function(preset) { return preset.name === name; })?.thinkingEffort || null;
  const newDefaultPreset = {
    primary: secondaryModel || null,
    secondary: primaryModel || null,
    thinkingEffort: {
      primary: presetEffort(secondaryModel),
      secondary: presetEffort(primaryModel),
    },
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
    const presets = getClawModelPresets();
    renderPhModelConfigOverlay(agent, presets);
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to save process mode:', error);
    window.alert((currentLanguage === 'zh' ? '保存进程模式失败：' : 'Failed to save process mode: ') + (error?.message || error));
  }
};

// ── 项目管理：改绑 / 归档 / 删除（ticket 046）──────────────────────────
// 管理弹窗复用 feature-detail 弹窗壳与 settings 表单配方（同新建项目弹窗），
// 不自造控件。三个动作对应当前浏览目标的三种后续：
// - 改绑：目标身份不变（prj_*），当前恰在浏览该项目时重拉会话切片；
// - 归档：目标不再是有效项目（getPhBrowsingTarget 已拒归档实体）→ 清除
//   目标回退目录模式；恢复后由用户重新选择；
// - 删除：同归档的目标回退，另有影响预览 + 二次明确确认（输入项目名）。

async function _phManageRefreshViews(affectedProjectId, { browsingInvalidated = false } = {}) {
  await ensurePhProjectEntitiesLoaded(true);
  const agent = getCurrentAgentRecord();
  if (!agent) {
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
    return;
  }
  if (browsingInvalidated) {
    clearPhBrowsingTarget(agent.id);
    const target = typeof getPhBrowsingTarget === 'function' ? getPhBrowsingTarget(agent) : null;
    const loaded = await phLoadProjectSessions(target?.type === 'project'
      ? { projectId: target.id }
      : { projectDir: target?.openDirectory || '' });
    if (!loaded) {
      lastRenderedWorkspaceHtml = '';
      renderCurrentMainView();
    }
    return;
  }
  if (affectedProjectId) {
    const target = typeof getPhBrowsingTarget === 'function' ? getPhBrowsingTarget(agent) : null;
    if (target?.type === 'project' && target.id === affectedProjectId) {
      // 当前正浏览该项目：会话切片刷新（改绑后实例已安全失效，列表按新目录事实重拉）
      const loaded = await phLoadProjectSessions({ projectId: affectedProjectId });
      if (!loaded) {
        lastRenderedWorkspaceHtml = '';
        renderCurrentMainView();
      }
      return;
    }
  }
  lastRenderedWorkspaceHtml = '';
  renderCurrentMainView();
}

function _phCurrentBrowsingProjectId() {
  const agent = getCurrentAgentRecord();
  const target = agent && typeof getPhBrowsingTarget === 'function' ? getPhBrowsingTarget(agent) : null;
  return target?.type === 'project' ? target.id : '';
}

window.phOpenManageProjectsDialog = async () => {
  const currentAgent = getCurrentAgentRecord();
  if (!currentAgent || !isPhStyleWorkspaceAgent(currentAgent)) return;
  const isZh = currentLanguage === 'zh';

  let host = document.getElementById('ph-manage-projects-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ph-manage-projects-host';
    document.body.appendChild(host);
  }
  host.innerHTML = '';

  const overlay = document.createElement('div');
  overlay.className = 'feature-detail-overlay';
  overlay.innerHTML = [
    '<div class="feature-detail-window ph-manage-projects-window" role="dialog" aria-modal="true">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? '管理项目' : 'Manage Projects') + '</div>',
    '<div class="feature-detail-subtitle">' + (isZh ? '改绑目录、归档或永久删除；归档可恢复，删除不可撤销。' : 'Rebind directory, archive, or permanently delete; archives are restorable, deletion is not.') + '</div>',
    '</div>',
    '<button type="button" class="feature-detail-close ph-manage-projects-cancel">&times;</button>',
    '</div>',
    '<div class="settings-section ph-manage-projects-body"><div class="ph-manage-projects-loading">' + (isZh ? '加载中…' : 'Loading…') + '</div></div>',
    '</div>',
  ].join('');
  host.appendChild(overlay);

  const bodyEl = overlay.querySelector('.ph-manage-projects-body');
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
  overlay.querySelectorAll('.ph-manage-projects-cancel').forEach((btn) => btn.addEventListener('click', close));

  // 归档确认：行内二段式（第一次点击变成「确认归档？」，再次点击执行；
  // 3s 不点第二次自动复位），不使用原生 confirm。
  const renderRows = () => {
    const projects = (window.ClawFW.phProjectEntities?.projects || []);
    const active = projects.filter((p) => !p.archived);
    const archived = projects.filter((p) => p.archived);
    const rowHtml = (p) => {
      const dirLabel = p.openDirectory || (isZh ? '（托管目录）' : '(managed)');
      const actions = p.archived
        ? [
          '<button type="button" class="settings-btn settings-btn-secondary" data-action="restore" data-id="' + escapeHtml(p.id) + '">' + (isZh ? '恢复' : 'Restore') + '</button>',
          '<button type="button" class="settings-btn settings-btn-secondary" data-action="delete" data-id="' + escapeHtml(p.id) + '">' + (isZh ? '删除' : 'Delete') + '</button>',
        ].join('')
        : [
          '<button type="button" class="settings-btn settings-btn-secondary" data-action="rebind" data-id="' + escapeHtml(p.id) + '">' + (isZh ? '改绑目录' : 'Rebind') + '</button>',
          '<button type="button" class="settings-btn settings-btn-secondary" data-action="archive" data-id="' + escapeHtml(p.id) + '" data-armed="no">' + (isZh ? '归档' : 'Archive') + '</button>',
          '<button type="button" class="settings-btn settings-btn-secondary" data-action="delete" data-id="' + escapeHtml(p.id) + '">' + (isZh ? '删除' : 'Delete') + '</button>',
        ].join('');
      return [
        '<div class="ph-manage-project-row">',
        '<div class="ph-manage-project-info">',
        '<div class="ph-manage-project-name">' + escapeHtml(p.name) + (p.archived ? (' <span class="ph-manage-project-flag">' + (isZh ? '已归档' : 'Archived') + '</span>') : '') + '</div>',
        '<div class="ph-manage-project-dir">' + escapeHtml(dirLabel) + '</div>',
        '</div>',
        '<div class="ph-manage-project-actions">' + actions + '</div>',
        '</div>',
      ].join('');
    };
    const groups = [];
    if (active.length > 0) {
      groups.push('<div class="ph-manage-group-label">' + (isZh ? '进行中的项目' : 'Active projects') + '</div>' + active.map(rowHtml).join(''));
    }
    if (archived.length > 0) {
      groups.push('<div class="ph-manage-group-label">' + (isZh ? '已归档（可恢复）' : 'Archived (restorable)') + '</div>' + archived.map(rowHtml).join(''));
    }
    bodyEl.innerHTML = groups.length > 0
      ? groups.join('')
      : ('<div class="ph-manage-projects-loading">' + (isZh ? '还没有项目。' : 'No projects yet.') + '</div>');
  };

  bodyEl.addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn) return;
    const projectId = btn.getAttribute('data-id');
    const action = btn.getAttribute('data-action');
    if (action === 'rebind') {
      window.phRebindProject(projectId, close);
      return;
    }
    if (action === 'delete') {
      window.phDeleteProject(projectId, close);
      return;
    }
    if (action === 'archive') {
      // 行内二段式确认
      if (btn.getAttribute('data-armed') !== 'yes') {
        btn.setAttribute('data-armed', 'yes');
        btn.textContent = isZh ? '确认归档？' : 'Confirm archive?';
        setTimeout(() => {
          if (btn.isConnected && btn.getAttribute('data-armed') === 'yes') {
            btn.setAttribute('data-armed', 'no');
            btn.textContent = isZh ? '归档' : 'Archive';
          }
        }, 3000);
        return;
      }
      btn.disabled = true;
      try {
        const response = await fetch('/protoclaw/ph_project/project_archive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: currentAgent.id, projectId, archived: true }),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) throw new Error(payload?.error || ('HTTP ' + response.status));
        const browsingInvalidated = _phCurrentBrowsingProjectId() === projectId;
        await _phManageRefreshViews(projectId, { browsingInvalidated });
        renderRows();
        if (typeof ClawToast !== 'undefined') {
          ClawToast.show({ title: isZh ? '项目已归档（可恢复）' : 'Project archived (restorable)', status: 'success', autoDismiss: 3000 });
        }
      } catch (error) {
        btn.disabled = false;
        window.alert((isZh ? '归档失败：' : 'Failed to archive: ') + (error?.message || error));
      }
      return;
    }
    if (action === 'restore') {
      btn.disabled = true;
      try {
        const response = await fetch('/protoclaw/ph_project/project_archive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: currentAgent.id, projectId, archived: false }),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) throw new Error(payload?.error || ('HTTP ' + response.status));
        await _phManageRefreshViews(projectId);
        renderRows();
        if (typeof ClawToast !== 'undefined') {
          ClawToast.show({ title: isZh ? '项目已恢复' : 'Project restored', status: 'success', autoDismiss: 3000 });
        }
      } catch (error) {
        btn.disabled = false;
        window.alert((isZh ? '恢复失败：' : 'Failed to restore: ') + (error?.message || error));
      }
    }
  });

  await ensurePhProjectEntitiesLoaded(true);
  renderRows();
};

// 改绑子弹窗（ticket 046）：显式新目录（存在性由服务端校验）或留空重新
// 分配托管目录。提交前明示影响：空闲实例安全失效并在下次使用时按新目录
// 启动；执行中的项目会话会被拒绝（409），此时不发生任何状态变化。
window.phRebindProject = (projectId, onCloseManage) => {
  const currentAgent = getCurrentAgentRecord();
  const entity = (window.ClawFW.phProjectEntities?.projects || []).find((p) => p.id === projectId) || null;
  if (!currentAgent || !entity) return;
  const isZh = currentLanguage === 'zh';

  let host = document.getElementById('ph-rebind-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ph-rebind-host';
    document.body.appendChild(host);
  }
  host.innerHTML = '';
  const overlay = document.createElement('div');
  overlay.className = 'feature-detail-overlay';
  overlay.innerHTML = [
    '<form class="feature-detail-window ph-rebind-window" role="dialog" aria-modal="true" novalidate>',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? '改绑目录 — ' : 'Rebind directory — ') + escapeHtml(entity.name) + '</div>',
    '<div class="feature-detail-subtitle">' + (isZh ? '当前：' : 'Current: ') + escapeHtml(entity.openDirectory || (isZh ? '托管目录' : 'managed directory')) + '</div>',
    '</div>',
    '<button type="button" class="feature-detail-close ph-rebind-cancel">&times;</button>',
    '</div>',
    '<div class="settings-section">',
    '<div class="settings-field">',
    '<label for="ph-rebind-dir">' + (isZh ? '新目录（留空 = 重新分配托管目录）' : 'New directory (empty = fresh managed directory)') + '</label>',
    '<div class="ph-new-project-dir-row">',
    '<input type="text" id="ph-rebind-dir" class="settings-input" autocomplete="off" placeholder="' + (isZh ? '留空 = 服务端托管目录' : 'Empty = server-managed directory') + '" />',
    '<button type="button" class="settings-btn settings-btn-secondary ph-rebind-browse">' + (isZh ? '浏览' : 'Browse') + '</button>',
    '</div>',
    '</div>',
    '<div class="ph-rebind-note">' + (isZh
      ? '项目的空闲会话将安全保存并停止，下次打开时在新目录启动；有执行中轮次时改绑会被拒绝，且不改变任何状态。'
      : 'Idle sessions are safely saved and stopped, then restarted in the new directory; a busy session rejects the rebind with no state change.') + '</div>',
    '<div class="ph-new-project-error" hidden></div>',
    '</div>',
    '<div class="settings-actions">',
    '<button type="button" class="settings-btn settings-btn-secondary ph-rebind-cancel">' + (isZh ? '取消' : 'Cancel') + '</button>',
    '<button type="submit" class="settings-btn settings-btn-primary">' + (isZh ? '确认改绑' : 'Rebind') + '</button>',
    '</div>',
    '</form>',
  ].join('');
  host.appendChild(overlay);

  const dirInput = overlay.querySelector('#ph-rebind-dir');
  const errorEl = overlay.querySelector('.ph-new-project-error');
  const submitBtn = overlay.querySelector('button[type="submit"]');
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
    dirInput.focus?.();
  };
  const onKeydown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  };
  document.addEventListener('keydown', onKeydown);
  overlay.querySelectorAll('.ph-rebind-cancel').forEach((btn) => btn.addEventListener('click', close));
  overlay.querySelector('.ph-rebind-browse').addEventListener('click', async () => {
    try {
      const result = await invoke('select_directory');
      const chosen = Array.isArray(result?.paths) ? String(result.paths[0] || '').trim() : (typeof result?.path === 'string' ? result.path.trim() : '');
      if (chosen) dirInput.value = chosen;
    } catch { /* 用户取消选择器：无副作用 */ }
  });
  dirInput.focus();

  overlay.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const workDirectory = String(dirInput.value || '').trim();
    errorEl.hidden = true;
    submitBtn.disabled = true;
    try {
      const response = await fetch('/protoclaw/ph_project/project_rebind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: currentAgent.id,
          projectId,
          ...(workDirectory ? { workDirectory } : {}),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || ('HTTP ' + response.status));
      }
      close();
      if (typeof onCloseManage === 'function') onCloseManage();
      await _phManageRefreshViews(projectId);
      if (typeof ClawToast !== 'undefined') {
        ClawToast.show({
          title: isZh ? '已改绑到新目录' : 'Rebound to new directory',
          description: payload.project?.workDirectory || '',
          status: 'success',
          autoDismiss: 3000,
        });
      }
    } catch (error) {
      submitBtn.disabled = false;
      const message = String(error?.message || error);
      const friendly = /busy/i.test(message)
        ? (isZh ? '项目有执行中的会话，已拒绝改绑（未做任何改动）。请等该轮结束后重试。' : 'The project has a busy session; rebind was rejected with no changes. Retry after that turn completes.')
        : message;
      errorEl.textContent = (isZh ? '改绑失败：' : 'Failed to rebind: ') + friendly;
      errorEl.hidden = false;
    }
  });
};

// 删除子弹窗（ticket 046）：第一步影响预览（会话 / 配置 / 托管目录可删性
// 与保留原因；托管目录删除必须是用户显式选择，默认不删）；第二步输入
// 项目名二次确认后才提交。
window.phDeleteProject = (projectId, onCloseManage) => {
  const currentAgent = getCurrentAgentRecord();
  const entity = (window.ClawFW.phProjectEntities?.projects || []).find((p) => p.id === projectId) || null;
  if (!currentAgent || !entity) return;
  const isZh = currentLanguage === 'zh';

  let host = document.getElementById('ph-delete-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ph-delete-host';
    document.body.appendChild(host);
  }
  host.innerHTML = '';
  const overlay = document.createElement('div');
  overlay.className = 'feature-detail-overlay';
  overlay.innerHTML = [
    '<div class="feature-detail-window ph-delete-window" role="dialog" aria-modal="true">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? '删除项目 — ' : 'Delete project — ') + escapeHtml(entity.name) + '</div>',
    '<div class="feature-detail-subtitle">' + (isZh ? '永久删除不可撤销；先确认影响面。' : 'Permanent deletion cannot be undone; review the impact first.') + '</div>',
    '</div>',
    '<button type="button" class="feature-detail-close ph-delete-cancel">&times;</button>',
    '</div>',
    '<div class="settings-section ph-delete-body"><div class="ph-manage-projects-loading">' + (isZh ? '正在获取影响预览…' : 'Loading impact preview…') + '</div></div>',
    '<div class="settings-actions">',
    '<button type="button" class="settings-btn settings-btn-secondary ph-delete-cancel">' + (isZh ? '取消' : 'Cancel') + '</button>',
    '<button type="button" class="settings-btn settings-btn-primary ph-delete-next" disabled>' + (isZh ? '下一步' : 'Next') + '</button>',
    '</div>',
    '</div>',
  ].join('');
  host.appendChild(overlay);

  const bodyEl = overlay.querySelector('.ph-delete-body');
  const nextBtn = overlay.querySelector('.ph-delete-next');
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
  };
  const onKeydown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  };
  document.addEventListener('keydown', onKeydown);
  overlay.querySelectorAll('.ph-delete-cancel').forEach((btn) => btn.addEventListener('click', close));

  let deleteManagedDirectory = false;
  (async () => {
    let preview;
    try {
      const response = await fetch('/protoclaw/ph_project/project_delete_preview?agentId=' + encodeURIComponent(currentAgent.id) + '&projectId=' + encodeURIComponent(projectId));
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || ('HTTP ' + response.status));
      preview = payload;
    } catch (error) {
      bodyEl.innerHTML = '<div class="ph-new-project-error">' + escapeHtml((isZh ? '获取影响预览失败：' : 'Failed to load preview: ') + (error?.message || error)) + '</div>';
      return;
    }

    const sessions = Array.isArray(preview.sessions) ? preview.sessions : [];
    const managed = preview.managedDirectory || {};
    const reasonText = (reason) => {
      if (reason?.kind === 'external_directory') return isZh ? '外部目录，绝不删除' : 'External directory, never deleted';
      if (reason?.kind === 'outside_managed_root') return isZh ? '路径不在托管区内，不删除' : 'Outside the managed area, not deleted';
      if (reason?.kind === 'project') return (isZh ? '被项目引用：' : 'Referenced by project: ') + (reason.name || reason.id);
      if (reason?.kind === 'session') return (isZh ? '被目录会话引用：' : 'Referenced by a directory session: ') + (reason.title || reason.id);
      if (reason?.kind === 'workspace_open_directory') return isZh ? '是当前工作区目录（默认项目在用）' : 'It is the current workspace directory (in use by the default project)';
      return reason?.kind || '';
    };

    bodyEl.innerHTML = [
      '<div class="ph-delete-impact">',
      '<div class="ph-manage-group-label">' + (isZh ? '将被删除（不可恢复）' : 'Will be deleted (irreversible)') + '</div>',
      '<div class="ph-delete-impact-row">• ' + (isZh ? '项目「' : 'Project "') + escapeHtml(entity.name) + (isZh ? '」及其身份记录' : '" and its identity record') + '</div>',
      '<div class="ph-delete-impact-row">• ' + (isZh ? '项目会话 ' : 'Project sessions: ') + sessions.length + (sessions.length > 0 ? '：' + sessions.slice(0, 5).map((s) => escapeHtml(s.title || s.id)).join('、') + (sessions.length > 5 ? '…' : '') : '') + '</div>',
      (preview.featureConfig?.exists
        ? '<div class="ph-delete-impact-row">• ' + (isZh ? '项目层配置文件' : 'Project-layer config file') + '</div>'
        : ''),
      '<div class="ph-manage-group-label">' + (isZh ? '工作目录' : 'Working directory') + '</div>',
      '<div class="ph-delete-impact-row">' + escapeHtml(managed.path || '') + '</div>',
      managed.deletable
        ? [
          '<label class="ph-delete-dir-option">',
          '<input type="checkbox" class="ph-delete-dir-checkbox" />',
          '<span>' + (isZh ? '同时删除托管目录内容（其他项目/目录会话均未引用时才可勾选）' : 'Also delete the managed directory contents (only selectable when nothing else references it)') + '</span>',
          '</label>',
        ].join('')
        : '<div class="ph-delete-impact-note">' + (isZh ? '目录将保留：' : 'Directory will be kept: ') + escapeHtml((managed.reasons || []).map(reasonText).join('；')) + '</div>',
      '</div>',
    ].join('');

    const checkbox = bodyEl.querySelector('.ph-delete-dir-checkbox');
    if (checkbox) {
      checkbox.addEventListener('change', () => { deleteManagedDirectory = checkbox.checked; });
    }
    nextBtn.disabled = false;
    // 单监听器 + 状态机：第一步「下一步」→ 第二步输入项目名 →「永久删除」。
    // （分步逻辑若各自 addEventListener 会叠加监听，第二步点击会重放第一步。）
    let deleteStep = 'confirm-input';
    nextBtn.addEventListener('click', async () => {
      if (deleteStep === 'confirm-input') {
        deleteStep = 'execute';
        nextBtn.disabled = true;
        bodyEl.innerHTML = [
          '<div class="ph-delete-confirm">',
          '<div class="ph-delete-impact-row">' + (isZh ? '输入项目名「' : 'Type the project name "') + escapeHtml(entity.name) + (isZh ? '」以确认永久删除。' : '" to confirm permanent deletion.') + '</div>',
          '<div class="settings-field">',
          '<input type="text" class="settings-input ph-delete-confirm-input" autocomplete="off" />',
          '</div>',
          (deleteManagedDirectory ? '<div class="ph-delete-impact-note">' + (isZh ? '已选择：同时删除托管目录内容。' : 'Selected: managed directory contents will also be deleted.') + '</div>' : ''),
          '<div class="ph-new-project-error" hidden></div>',
          '</div>',
        ].join('');
        const confirmInput = bodyEl.querySelector('.ph-delete-confirm-input');
        const errorEl = bodyEl.querySelector('.ph-new-project-error');
        nextBtn.textContent = isZh ? '永久删除' : 'Delete permanently';
        confirmInput.focus();
        confirmInput.addEventListener('input', () => {
          nextBtn.disabled = String(confirmInput.value || '').trim() !== entity.name;
        });
        nextBtn.__errorEl = errorEl;
        return;
      }
      if (deleteStep !== 'execute') return;
      nextBtn.disabled = true;
      const errorEl = nextBtn.__errorEl;
      try {
        const response = await fetch('/protoclaw/ph_project/project_delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: currentAgent.id,
            projectId,
            deleteManagedDirectory,
          }),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) throw new Error(payload?.error || ('HTTP ' + response.status));
        close();
        if (typeof onCloseManage === 'function') onCloseManage();
        const browsingInvalidated = _phCurrentBrowsingProjectId() === projectId;
        await _phManageRefreshViews(projectId, { browsingInvalidated });
        if (typeof ClawToast !== 'undefined') {
          ClawToast.show({
            title: isZh ? '项目已删除' : 'Project deleted',
            description: (payload.managedDirectory?.deleted
              ? (isZh ? '托管目录已一并删除' : 'Managed directory removed')
              : (isZh ? '工作目录已保留' : 'Working directory kept')),
            status: 'success',
            autoDismiss: 3000,
          });
        }
      } catch (error) {
        nextBtn.disabled = false;
        errorEl.hidden = false;
        errorEl.textContent = (isZh ? '删除失败：' : 'Failed to delete: ') + (error?.message || error);
      }
    });
  })();
};
