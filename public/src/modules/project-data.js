/**
 * project-data.js — 域 F: Project/Creator 数据层
 *
 * 从 app-ui.js 拆出（Phase 2c-2）。
 * 提供 agent workspace state 管理、项目列表构建、显示名解析等纯数据函数。
 *
 * ESM 化：P2 W2-8（2026-11-17）。原位转换，数据语义与渲染输出零变化。
 *
 * 依赖（ESM，装载顺序由 import 图确定）:
 * - i18n-environment-state：实时语言
 * - session-ui：getWorkspaceSessions
 * - agent-store-state：allAgents（live binding）+ setAllAgents（updateAgentRecord 写入口）
 * - assembly-data：buildWorkspaceProjectKey（项目键归一化，权威实现）
 *
 * 仍 classic（调用时点显式 window 晚绑定，各域收敛时改 import）:
 * - app-main：getCurrentAgentRecord；app-core：isPhStyleWorkspaceAgent /
 *   isUiOnlyUnit / getCurrentUnitUi / hasPendingSessionNavigation
 * - remote-connections：getRemoteHistoryProjectBuckets
 *
 * 时序（R1/R2/R4，逐条审计见批次报告）：首屏 `applyTheme/applyLanguage →
 * renderCurrentMainView` 在 allAgents 为空时以 `getCurrentUnitUi(null) === null`
 * 早退，classic 相零触达本域函数（实测探针证据）；本模块顶层只做
 * `window.ClawFW` / `phProjectEntities` 初始化 + 兼容桥注册（`defineKey` /
 * `claim`，参数全是本地函数声明与先定义的 const），不做业务调用；classic 相
 * 唯一读取方（sidebar-render 渲染签名）以 `?.projects || []` 容忍缺席，且首屏
 * 两者同为空清单——执行相从加载期推迟到模块执行期等价（R4）。
 *
 * 求值闭包副作用（P2 项目/装配批新增直接边后扩大，测试夹具需具备对应 classic
 * 工厂）：`assembly-data → workspace-blocks → debug-overview` 把
 * `debug-overview` 与其 `p2-bootstrap-debug-panel`（顶层 `debugPanel =
 * window.createP2BootstrapDebugPanelHost()`）拉进本模块的求值闭包；生产里
 * app-core（classic）先于 module 入口执行，工厂必然就位。
 */

import { getCurrentLanguage } from './i18n-environment-state.js';
import { getWorkspaceSessions } from './session-ui.js';
import { allAgents, setAllAgents } from './agent-store-state.js';
import { buildWorkspaceProjectKey } from './assembly-data.js';

/**
 * Stable descending sort comparator for sessions and projects.
 * Primary key: updatedAt, secondary: createdAt, tertiary: id.
 * Prevents ordering jumps when updatedAt is equal or missing.
 */
function compareByRecency(a, b) {
  const aUpdated = String(a?.updatedAt || '');
  const bUpdated = String(b?.updatedAt || '');
  if (aUpdated !== bUpdated) return bUpdated.localeCompare(aUpdated);
  const aCreated = String(a?.createdAt || '');
  const bCreated = String(b?.createdAt || '');
  if (aCreated !== bCreated) return bCreated.localeCompare(aCreated);
  return String(b?.id || '').localeCompare(String(a?.id || ''));
}

export function getFeatureCreatorProjects(agent = window.getCurrentAgentRecord()) {
  if (agent?.id !== 'feature-creator') return [];

  const workspaceState = getAgentWorkspaceState(agent);
  const startupForm = workspaceState?.forms?.['startup-form'] || {};
  const sessions = getWorkspaceSessions(agent);
  const projects = new Map();

  const upsertProject = (rawProject = {}) => {
    const normalized = {
      id: String(rawProject.id || buildWorkspaceProjectKey(rawProject)).trim(),
      featureName: String(rawProject.featureName || '').trim(),
      installMode: rawProject.installMode === 'custom' ? 'custom' : 'system',
      targetDir: String(rawProject.targetDir || '').trim(),
      openDirectory: String(rawProject.openDirectory || '').trim(),
      goal: String(rawProject.goal || '').trim(),
      constraints: String(rawProject.constraints || '').trim(),
      createdAt: String(rawProject.createdAt || '').trim(),
      updatedAt: String(rawProject.updatedAt || '').trim(),
      sessions: [],
    };
    if (!normalized.id) return null;

    const existing = projects.get(normalized.id);
    const merged = existing ? {
      ...existing,
      ...normalized,
      featureName: existing.featureName || normalized.featureName,
      targetDir: existing.targetDir || normalized.targetDir,
      openDirectory: existing.openDirectory || normalized.openDirectory,
      goal: existing.goal || normalized.goal,
      constraints: existing.constraints || normalized.constraints,
      createdAt: existing.createdAt || normalized.createdAt,
      updatedAt: normalized.updatedAt || existing.updatedAt,
      sessions: existing.sessions || [],
    } : normalized;
    projects.set(merged.id, merged);
    return merged;
  };

  const stateProjects = Array.isArray(workspaceState?.featureProjects) ? workspaceState.featureProjects : [];
  stateProjects.forEach((project) => upsertProject(project));

  upsertProject({
    featureName: startupForm.feature_name,
    installMode: startupForm.install_mode,
    targetDir: startupForm.target_dir,
    goal: startupForm.goal,
    constraints: startupForm.constraints,
    openDirectory: workspaceState?.openDirectory,
    updatedAt: workspaceState?.updatedAt,
  });

  sessions.forEach((session) => {
    const project = upsertProject({
      featureName: session.featureName,
      targetDir: session.openDirectory ? session.openDirectory.split(/[\\/]+/).slice(0, -1).join('\\') : '',
      openDirectory: session.openDirectory,
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
    });
    if (project) {
      project.sessions.push(session);
    }
  });

  return Array.from(projects.values())
    .map((project) => {
      const sortedSessions = [...(project.sessions || [])].sort(compareByRecency);
      const latestSession = sortedSessions[0] || null;
      const updatedAt = latestSession?.updatedAt || project.updatedAt || project.createdAt || workspaceState?.updatedAt || '';
      return {
        ...project,
        sessions: sortedSessions,
        latestSession,
        latestSessionId: latestSession?.id || null,
        conversationCount: sortedSessions.length,
        updatedAt,
      };
    })
    .sort(compareByRecency);
}

export function getAgentCreatorProjects(agent = window.getCurrentAgentRecord()) {
  if (agent?.id !== 'agent-creator') return [];

  const workspaceState = getAgentWorkspaceState(agent);
  const startupForm = workspaceState?.forms?.['startup-form'] || {};
  const sessions = getWorkspaceSessions(agent);
  const projects = new Map();

  const upsertProject = (rawProject = {}) => {
    const normalized = {
      id: String(rawProject.id || buildWorkspaceProjectKey({
        openDirectory: rawProject.openDirectory,
        featureName: rawProject.agentName,
        targetDir: rawProject.targetDir,
      })).trim(),
      agentName: String(rawProject.agentName || '').trim(),
      installMode: rawProject.installMode === 'custom' ? 'custom' : 'system',
      targetDir: String(rawProject.targetDir || '').trim(),
      openDirectory: String(rawProject.openDirectory || '').trim(),
      goal: String(rawProject.goal || '').trim(),
      constraints: String(rawProject.constraints || '').trim(),
      targetUser: String(rawProject.targetUser || '').trim(),
      runtimeStyle: String(rawProject.runtimeStyle || '').trim(),
      plannedFeatures: String(rawProject.plannedFeatures || '').trim(),
      createdAt: String(rawProject.createdAt || '').trim(),
      updatedAt: String(rawProject.updatedAt || '').trim(),
      sessions: [],
    };
    if (!normalized.id) return null;

    const existing = projects.get(normalized.id);
    const merged = existing ? {
      ...existing,
      ...normalized,
      agentName: existing.agentName || normalized.agentName,
      targetDir: existing.targetDir || normalized.targetDir,
      openDirectory: existing.openDirectory || normalized.openDirectory,
      goal: existing.goal || normalized.goal,
      constraints: existing.constraints || normalized.constraints,
      targetUser: existing.targetUser || normalized.targetUser,
      runtimeStyle: existing.runtimeStyle || normalized.runtimeStyle,
      plannedFeatures: existing.plannedFeatures || normalized.plannedFeatures,
      createdAt: existing.createdAt || normalized.createdAt,
      updatedAt: normalized.updatedAt || existing.updatedAt,
      sessions: existing.sessions || [],
    } : normalized;
    projects.set(merged.id, merged);
    return merged;
  };

  const stateProjects = Array.isArray(workspaceState?.agentProjects) ? workspaceState.agentProjects : [];
  stateProjects.forEach((project) => upsertProject(project));

  upsertProject({
    agentName: startupForm.agent_name,
    installMode: startupForm.install_mode,
    targetDir: startupForm.target_dir,
    goal: startupForm.goal,
    constraints: startupForm.constraints,
    targetUser: startupForm.target_user,
    runtimeStyle: startupForm.runtime_style,
    plannedFeatures: startupForm.planned_features,
    openDirectory: workspaceState?.openDirectory,
    updatedAt: workspaceState?.updatedAt,
  });

  sessions
    .filter((session) => String(session?.formId || '') !== 'assembly-form')
    .forEach((session) => {
    const project = upsertProject({
      agentName: session.agentName,
      targetDir: session.openDirectory ? session.openDirectory.split(/[\\/]+/).slice(0, -1).join('\\') : '',
      openDirectory: session.openDirectory,
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
    });
    if (project) {
      project.sessions.push(session);
    }
  });

  return Array.from(projects.values())
    .map((project) => {
      const sortedSessions = [...(project.sessions || [])].sort(compareByRecency);
      const latestSession = sortedSessions[0] || null;
      const updatedAt = latestSession?.updatedAt || project.updatedAt || project.createdAt || workspaceState?.updatedAt || '';
      return {
        ...project,
        sessions: sortedSessions,
        latestSession,
        latestSessionId: latestSession?.id || null,
        conversationCount: sortedSessions.length,
        updatedAt,
      };
    })
    .sort(compareByRecency);
}

export function getPathLeaf(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const parts = text.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : text;
}

/**
 * 侧栏运行中会话（child runtime）条目的分组身份解析（ticket 044）。
 * 纯函数：输入是 wire child 条目（buildChildRuntimeEntry 归一后）+ 宿主
 * workspace_sessions 的 sessionId→目录映射（大小写校正），输出分组身份。
 *
 * 归属规则：projectId 非空 = 项目会话 → 独立项目身份组（projectKey
 * 'prj:<id>'，不带 projectDir——项目组不是目录操作入口）；否则按目录分组
 * （sessionDirMap 校正后的目录）。openDirectory 是文件环境：项目会话的
 * openDirectory 只是创建时记录，绝不能用来分组（否则 A/B 混进同路径
 * 目录 D 的组）。显示名不参与身份比较（契约：侧栏组键）。
 */
export function resolveSidebarChildProjectGroup(entry, sessionDirMap) {
  const projectId = String(entry?.projectId || '').trim();
  if (projectId) {
    const zh = getCurrentLanguage() === 'zh';
    const entity = (phProjectEntities.projects || [])
      .find((project) => project.id === projectId);
    return {
      projectKey: 'prj:' + projectId,
      projectName: entity?.name || (zh ? '项目名称不可用' : 'Project name unavailable'),
      projectDir: '',
      projectId,
    };
  }
  let dir = String(entry?.openDirectory || '').trim();
  if (sessionDirMap && sessionDirMap.size > 0 && entry?.sessionId) {
    dir = sessionDirMap.get(String(entry.sessionId)) || dir;
  }
  if (!dir) return null;
  return { projectKey: '', projectName: getPathLeaf(dir), projectDir: dir };
}

function toFeatureDisplayName(value) {
  const text = String(value || '').trim().replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9-]+$/g, '');
  if (!text) return '';
  return text
    .split('-')
    .filter(Boolean)
    .map((part, index) => {
      const lower = part.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
}

export function getFeatureSessionDisplayName(session, agent = window.getCurrentAgentRecord()) {
  const workspaceState = getAgentWorkspaceState(agent);
  const directoryName = getPathLeaf(session?.openDirectory) || getPathLeaf(workspaceState?.openDirectory);
  const derivedName = toFeatureDisplayName(directoryName);
  if (derivedName) return derivedName;
  const rawName = toFeatureDisplayName(session?.featureName);
  if (rawName) return rawName;
  return String(session?.id || '').trim();
}

export function getFeatureProjectDisplayName(project) {
  const directoryName = getPathLeaf(project?.openDirectory);
  const derivedName = toFeatureDisplayName(directoryName);
  if (derivedName) return derivedName;
  const rawName = toFeatureDisplayName(project?.featureName);
  if (rawName) return rawName;
  return 'UntitledFeature';
}

export function getAgentProjectDisplayName(project) {
  const directoryName = getPathLeaf(project?.openDirectory);
  const derivedName = toFeatureDisplayName(directoryName);
  if (derivedName) return derivedName;
  const rawName = toFeatureDisplayName(project?.agentName);
  if (rawName) return rawName;
  return 'UntitledAgent';
}

// ── PH 项目实体与带类型浏览目标（ticket 045）────────────────────────
// 目录对话与项目对话并存（共同契约 2026-10-22）：项目是稳定身份（prj_*），
// 目录是文件环境。surface 的"当前浏览目标"必须带类型持久化——用户显式
// 选择项目后，轮询刷新的 workspace_state.openDirectory（目录事实）不得
// 覆盖该选择；反之目录入口（打开目录 / 桌面 / 侧栏进入）不设置项目目标，
// 继续目录模式。持久化沿既有本地 UI 模式（localStorage，同 workspace-form
// 草稿的键风格），不进 app-core 全局状态区。
window.ClawFW = window.ClawFW || {};

function _phBrowsingTargetStorageKey(agentId) {
  return `protoclaw:ph-browsing-target:${agentId}`;
}

/** 项目实体缓存（/protoclaw/ph_project/projects 的前端镜像）。 */
window.ClawFW.phProjectEntities = window.ClawFW.phProjectEntities || {
  loaded: false,
  loading: null,
  projects: [],
};

/**
 * 项目实体缓存的 ESM 命名面：求值时点与 classic 消费方（sidebar-render 的
 * phProjectNames）读的 window 键**取自同一对象**，不是镜像副本；此后两侧都只
 * 变异该对象的字段（loaded / loading / projects），不做整体重赋值——生产代码
 * 没有替换该对象的路径，因此两侧读到的是同一份数据。
 *
 * 契约边界：本命名导出**不支持**运行期把 `window.ClawFW.phProjectEntities`
 * 整体换成另一个对象（ESM 读方持的是求值时点那份）。需要整体替换时，先改这里
 * 与全部 ESM 读方（统一走 getter），并同步 classic sidebar-render。
 */
export const phProjectEntities = window.ClawFW.phProjectEntities;

function normalizePhProjectEntity(raw) {
  const id = String(raw?.id || '').trim();
  if (!id.startsWith('prj_')) return null;
  return {
    id,
    type: 'project',
    name: String(raw?.name || '').trim() || id,
    openDirectory: String(raw?.workDirectory || '').trim(),
    directorySource: raw?.directorySource === 'managed' ? 'managed' : 'external',
    archived: raw?.archived === true,
    createdAt: String(raw?.createdAt || '').trim(),
    updatedAt: String(raw?.updatedAt || '').trim(),
    lastActivityAt: String(raw?.lastActivityAt || '').trim(),
  };
}

/**
 * 拉取项目实体清单（ensure*Loaded 模式：在飞合并、幂等）。返回后调用方
 * 自行重渲染；不主动触发渲染（数据层无渲染职责）。
 */
export function ensurePhProjectEntitiesLoaded(force = false) {
  const store = phProjectEntities;
  if (!force && (store.loaded || store.loading)) return store.loading || Promise.resolve();
  store.loading = (async () => {
    try {
      const response = await fetch('/protoclaw/ph_project/projects?agentId=programming-helper');
      if (!response.ok) throw new Error('Failed to load projects: HTTP ' + response.status);
      const data = await response.json();
      store.projects = (Array.isArray(data?.projects) ? data.projects : [])
        .map(normalizePhProjectEntity)
        .filter(Boolean);
      store.loaded = true;
    } catch {
      // 加载失败保留旧清单；loaded 不置位，下次 surface 渲染重试
    } finally {
      store.loading = null;
    }
  })();
  return store.loading;
}

/**
 * 当前浏览目标（typed）。解析优先级：
 *   1. 显式持久化目标（用户上次显式选择）——目标仍存在才采信：
 *      项目须在实体缓存中；目录须在目录桶列表中；
 *   2. 目录模式回退：workspace_state.openDirectory 的目录桶；无目录时
 *      首个目录桶（旧版行为）。
 * 没有显式项目目标的桌面/目录入口自然落入目录模式。
 */
export function getPhBrowsingTarget(agent = window.getCurrentAgentRecord()) {
  const workspaceState = getAgentWorkspaceState(agent);
  const openDirectory = String(workspaceState?.openDirectory || '').trim();
  const normDirId = (dir) => `dir:${String(dir).replace(/\\/g, '/').toLowerCase()}`;
  const dirProjects = (Array.isArray(workspaceState?.phProjects) ? workspaceState.phProjects : [])
    .map((p) => String(p?.openDirectory || '').trim())
    .filter(Boolean);

  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(_phBrowsingTargetStorageKey(agent?.id || '')) || 'null');
  } catch { stored = null; }
  if (stored && stored.type === 'project' && String(stored.id || '').startsWith('prj_')) {
    const entity = (phProjectEntities.projects || [])
      .find((p) => p.id === stored.id);
    // 已归档项目不再是有效浏览目标（ticket 046：从正常选择器隐藏）——与
    // 被删除同款处理：清掉过期目标，走目录回退。恢复归档后用户重新选择。
    if (entity && !entity.archived) return { type: 'project', id: entity.id, project: entity };
    // 元数据未加载完（loaded=false）：不退回另一个目标（契约），保持项目
    // 待定态——id 保留，project 为空，渲染层呈现加载中而非目录回退。
    if (!phProjectEntities.loaded) {
      return { type: 'project', id: stored.id, project: null };
    }
    // 已加载但项目不在列（被删除）：清掉过期目标，走目录回退
    try { localStorage.removeItem(_phBrowsingTargetStorageKey(agent?.id || '')); } catch { /* ignore */ }
  }
  if (stored && stored.type === 'dir' && String(stored.id || '').startsWith('dir:')) {
    const match = dirProjects.find((dir) => normDirId(dir) === stored.id);
    if (match) return { type: 'dir', id: stored.id, openDirectory: match };
    // 项目绑定目录（含托管）也是合法目录目标：目录清单收录项目绑定目录，
    // 但这类目录不写 workspace_state / 目录注册表——目标凭项目实体解析。
    const boundEntity = (phProjectEntities.projects || [])
      .find((p) => !p.archived && p.openDirectory && normDirId(p.openDirectory) === stored.id);
    if (boundEntity) return { type: 'dir', id: stored.id, openDirectory: boundEntity.openDirectory };
    // 远程目录桶（ADR-0012）：既有远程目录能力与寻址保持——目标凭远程历史
    // 桶解析，不因本地无此目录而静默回退（回退会把远程导航污染成本地目录）。
    if (typeof window.getRemoteHistoryProjectBuckets === 'function') {
      const remoteBucket = window.getRemoteHistoryProjectBuckets()
        .find((bucket) => bucket?.openDirectory && normDirId(bucket.openDirectory) === stored.id);
      if (remoteBucket) return { type: 'dir', id: stored.id, openDirectory: remoteBucket.openDirectory, remote: true };
    }
  }
  // 目录回退：当前工作区目录 → 首个目录桶（旧版行为）
  if (openDirectory) return { type: 'dir', id: normDirId(openDirectory), openDirectory };
  if (dirProjects.length > 0) return { type: 'dir', id: normDirId(dirProjects[0]), openDirectory: dirProjects[0] };
  return null;
}

/**
 * ── 顶部双选择器数据（目录决定位置，项目决定组织）────────────────────
 */
function phDirIdOf(directory) {
  return 'dir:' + String(directory || '').replace(/\\/g, '/').toLowerCase();
}

/**
 * 左侧目录选择器导航清单：目录桶（workspace phProjects 注册目录 + 远程目录桶）
 * + 项目绑定目录（含托管，kind: 'projectBound'）。项目绑定目录只作导航清单
 * 条目——不写 workspace_state、不进目录注册表、不混入目录会话桶；远程目录
 * 不派生项目（不伪造远程项目）。每个条目携带其下非归档项目（二级展开）。
 */
// 项目最近活动时间戳（ms）：服务端按会话索引算的 lastActivityAt 优先，
// 实体 updatedAt（创建/改名时间）兜底。
function _phProjectActivityAt(entity, signals = null) {
  const projected = signals?.projects?.[String(entity?.id || '')];
  return Math.max(
    Date.parse(String(entity?.lastActivityAt || '')) || 0,
    Date.parse(String(entity?.updatedAt || '')) || 0,
    Date.parse(String(projected || '')) || 0,
  );
}

// PH 活动信号（服务端 phActivity 投影，随 workspace_sessions 轮询下发）：
// 目录/项目 → 最近活动 ISO 时间。归属切片导致非当前目录桶内会话恒空，
// 目录排序依赖这个全量聚合信号；缺字段（旧服务端/降级）回退桶内推断。
function _phActivitySignals(agent) {
  const activity = agent?.workspace_sessions?.phActivity;
  return activity && typeof activity === 'object' ? activity : null;
}

// 活动键归一化与服务端 aggregateSessionActivity 对齐（含尾斜杠修剪），
// 比 phDirIdOf 严：两处语义不同，不合并。
function _phActivityDirKey(dir) {
  return 'dir:' + String(dir || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** 同目录项目按最近访问排序：当前项目置顶（正在访问），其余活动时间倒序，名称稳定垫底。 */
function _phSortProjectsByRecency(list, agent, signals = null) {
  // 调用方可能没有当前 agent（如脱离主壳的渲染场景）：此时只做活动时间排序，
  // 不解析浏览目标——避免依赖主壳全局 getCurrentAgentRecord。
  const resolvedAgent = agent ?? (typeof window.getCurrentAgentRecord === 'function' ? window.getCurrentAgentRecord() : null);
  const resolvedSignals = signals ?? _phActivitySignals(resolvedAgent);
  const target = resolvedAgent && typeof getPhBrowsingTarget === 'function' ? getPhBrowsingTarget(resolvedAgent) : null;
  const currentId = target?.type === 'project' ? String(target.id || '') : '';
  return [...list].sort((a, b) => {
    if (a.id === currentId) return -1;
    if (b.id === currentId) return 1;
    const diff = _phProjectActivityAt(b, resolvedSignals) - _phProjectActivityAt(a, resolvedSignals);
    return diff !== 0 ? diff : String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
  });
}

export function getPhDirectoryNavigationList(agent = window.getCurrentAgentRecord()) {
  if (typeof window.isPhStyleWorkspaceAgent !== 'function' || !window.isPhStyleWorkspaceAgent(agent)) return [];
  const projects = typeof getProgrammingHelperProjects === 'function'
    ? getProgrammingHelperProjects(agent) : [];
  const activitySignals = _phActivitySignals(agent);
  const entries = [];
  const byId = new Map();
  for (const bucket of projects) {
    // 远程独有目录不再进入目录菜单（用户决策 2026-10-23：远程目录从目录
    // 导航退场；远程历史会话仍在会话列表按 ADR-0012 呈现，互不影响）。
    if (bucket.type === 'project' || !bucket.openDirectory || bucket.remoteOnly) continue;
    const entry = {
      id: phDirIdOf(bucket.openDirectory),
      openDirectory: bucket.openDirectory,
      name: getPathLeaf(bucket.openDirectory),
      kind: 'registry',
      sessions: bucket.sessions || [],
      projects: [],
    };
    entries.push(entry);
    byId.set(entry.id, entry);
  }
  for (const entity of (phProjectEntities.projects || [])) {
    if (entity.archived || !entity.openDirectory) continue;
    const id = phDirIdOf(entity.openDirectory);
    let entry = byId.get(id);
    if (!entry) {
      entry = {
        id,
        openDirectory: entity.openDirectory,
        name: getPathLeaf(entity.openDirectory),
        kind: 'projectBound',
        sessions: [],
        projects: [],
      };
      entries.push(entry);
      byId.set(id, entry);
    }
    entry.projects.push(entity);
  }
  // 目录按最近访问排序：当前目录置顶（正在访问），其余按服务端全量活动
  // 信号、桶内会话与目录内项目的最近活动时间倒序，无活动目录按路径稳定
  // 垫底（空间记忆稳定，顺序不随项目切换跳位——跳位只发生在真实访问顺
  // 序变化时）。服务端信号覆盖全部目录；桶内会话仅当前目录非空（归属
  // 切片），二者取最大即"切片目录用本地值、其余目录用信号"。
  const dirActivityAt = (entry) => {
    let t = Date.parse(String(activitySignals?.directories?.[_phActivityDirKey(entry.openDirectory)] || '')) || 0;
    for (const session of entry.sessions) {
      const at = Date.parse(String(session?.updatedAt || '')) || 0;
      if (at > t) t = at;
    }
    for (const project of entry.projects) {
      const at = _phProjectActivityAt(project, activitySignals);
      if (at > t) t = at;
    }
    return t;
  };
  const currentDirId = (typeof getPhCurrentDirectoryContext === 'function'
    ? getPhCurrentDirectoryContext(agent)?.dirId : '') || '';
  entries.sort((a, b) => {
    if (a.id === currentDirId) return -1;
    if (b.id === currentDirId) return 1;
    const diff = dirActivityAt(b) - dirActivityAt(a);
    return diff !== 0 ? diff : String(a.openDirectory).localeCompare(String(b.openDirectory), undefined, { sensitivity: 'base' });
  });
  for (const entry of entries) entry.projects = _phSortProjectsByRecency(entry.projects, agent, activitySignals);
  return entries;
}

/**
 * 当前选中目录上下文（两个选择器的同步锚点）：项目目标 → 项目绑定目录；
 * 目录目标 → 目标目录；无有效目标 → null（无当前目录，新建项目不得无声
 * 指定其他路径）。
 */
export function getPhCurrentDirectoryContext(agent = window.getCurrentAgentRecord()) {
  const target = typeof getPhBrowsingTarget === 'function' ? getPhBrowsingTarget(agent) : null;
  if (target?.type === 'project' && target.project) {
    return {
      dirId: phDirIdOf(target.project.openDirectory),
      openDirectory: target.project.openDirectory,
      org: 'project',
      projectId: target.project.id,
    };
  }
  if (target?.type === 'dir' && target.openDirectory) {
    return { dirId: target.id, openDirectory: target.openDirectory, org: 'directory', projectId: '' };
  }
  return null;
}

/** 同目录项目（右侧归属选择器候选）：非归档实体按归一化 workDirectory 匹配，最近访问排序。 */
export function getPhProjectsInDirectory(openDirectory) {
  const norm = String(openDirectory || '').replace(/\\/g, '/').toLowerCase();
  if (!norm) return [];
  const matched = (phProjectEntities.projects || [])
    .filter((p) => !p.archived && p.openDirectory
      && String(p.openDirectory).replace(/\\/g, '/').toLowerCase() === norm);
  return _phSortProjectsByRecency(matched);
}

/**
 * 项目绑定目录的呈现桶（渲染层用）：目录目标指向项目绑定目录（非注册目录桶）
 * 时合成 directory 桶，仅驱动 surface 呈现与目录切片——不进目录注册表。
 */
export function getPhProjectBoundDirectoryBucket(agent = window.getCurrentAgentRecord()) {
  const target = typeof getPhBrowsingTarget === 'function' ? getPhBrowsingTarget(agent) : null;
  if (target?.type !== 'dir') return null;
  const boundEntity = (phProjectEntities.projects || [])
    .find((p) => !p.archived && p.openDirectory && phDirIdOf(p.openDirectory) === target.id);
  if (!boundEntity) return null;
  return {
    id: target.id,
    type: 'directory',
    openDirectory: boundEntity.openDirectory,
    name: getPathLeaf(boundEntity.openDirectory),
    projectBound: true,
  };
}

/** 显式设置浏览目标（selector 选择 / 新建项目后进入）。 */
export function setPhBrowsingTarget(agentId, target) {
  if (!agentId || !target?.type) return;
  try {
    localStorage.setItem(_phBrowsingTargetStorageKey(agentId), JSON.stringify({
      type: target.type,
      id: String(target.id || ''),
    }));
  } catch { /* localStorage 不可用时仅内存态（下次渲染回退目录模式） */ }
}

export function clearPhBrowsingTarget(agentId) {
  try { localStorage.removeItem(_phBrowsingTargetStorageKey(agentId)); } catch { /* ignore */ }
}

/**
 * 会话列表请求的归属参数（唯一出口）。
 *
 * 会话列表的归属由浏览目标（typed target）决定：项目目标按 projectId，
 * 目录目标按 projectDir。服务端的切片接口（prebuilt_sessions /
 * get_connected_agents / agent_detail）都接受这两个互斥参数，缺省时服务端
 * 自行回退 workspace_state.openDirectory——那是「工作区当前打开的目录」，
 * 与用户正在浏览的项目不是同一件事。
 *
 * 任何写 workspace_sessions 的读取都必须经本函数取归属，否则项目切片会被
 * 目录切片覆盖：目录集合按契约排除项目会话，覆盖后项目列表归零。
 *
 * @returns {{projectId: string}|{projectDir: string}|{}}
 */
export function getPhSessionOwnershipParams(agent = window.getCurrentAgentRecord()) {
  if (typeof window.isPhStyleWorkspaceAgent === 'function' && !window.isPhStyleWorkspaceAgent(agent)) return {};
  const target = typeof getPhBrowsingTarget === 'function' ? getPhBrowsingTarget(agent) : null;
  if (target?.type === 'project' && target.id) return { projectId: target.id };
  if (target?.openDirectory) return { projectDir: target.openDirectory };
  return {};
}

/**
 * 当前浏览目标下的一次会话列表请求（带归属，不覆盖 workspace_sessions）。
 * 供「只想刷新元数据/计数、不改变列表身份」的调用方使用：结果仍交给
 * mergeWorkspaceSessionSnapshots 合并，保留已加载的深层分页段。
 */
export async function phFetchSessionsWithOwnership(agent, extra = {}) {
  if (!agent?.id) return null;
  const params = new URLSearchParams({ agentId: agent.id });
  const ownership = getPhSessionOwnershipParams(agent);
  if (ownership.projectId) params.set('projectId', ownership.projectId);
  else if (ownership.projectDir) params.set('projectDir', ownership.projectDir);
  for (const [key, value] of Object.entries(extra || {})) {
    if (value !== undefined && value !== null && String(value) !== '') {
      params.set(key, String(value));
    }
  }
  const response = await fetch('/protoclaw/prebuilt_sessions?' + params.toString());
  if (!response.ok) return null;
  return await response.json();
}

export function getProgrammingHelperProjects(agent = window.getCurrentAgentRecord()) {
  if (!window.isPhStyleWorkspaceAgent(agent)) return [];

  const workspaceState = getAgentWorkspaceState(agent);
  const sessions = getWorkspaceSessions(agent);
  const projects = new Map();

  const upsertProject = (rawProject = {}) => {
    const openDirectory = String(rawProject.openDirectory || '').trim();
    if (!openDirectory) return null;

    const id = `dir:${openDirectory.replace(/\\/g, '/').toLowerCase()}`;
    const projectName = getPathLeaf(openDirectory);

    const existing = projects.get(id);
    const merged = existing ? {
      ...existing,
      updatedAt: existing.updatedAt || rawProject.updatedAt,
      sessions: existing.sessions || [],
    } : {
      id,
      type: 'directory',
      openDirectory,
      name: projectName,
      sessions: [],
      createdAt: rawProject.createdAt,
      updatedAt: rawProject.updatedAt,
    };
    projects.set(id, merged);
    return merged;
  };

  const stateProjects = Array.isArray(workspaceState?.phProjects) ? workspaceState.phProjects : [];
  stateProjects.forEach((project) => upsertProject(project));

  sessions
    .forEach((session) => {
      const project = upsertProject({
        openDirectory: session.openDirectory,
        updatedAt: session.updatedAt,
        createdAt: session.createdAt,
      });
      if (project) {
        project.sessions.push(session);
      }
    });

  // 远程历史会话混入（R2-01，ADR-0012 决策 1）：与本地会话在同一项目桶内
  // 混合排序，无来源分区、无远程徽标。目录本地不存在时创建 remoteOnly 桶：
  // 仅用于 surface 视图呈现，不参与本地工作区切换语义（phSwitchProject）。
  // 标记是「该桶无本地目录」的数据事实（保留，不做 UI 门控）：消费端经
  // getProjectLocalHostAgentId 解析本地宿主身份后查询能力矩阵
  // （window.RemoteConnections.capabilityFor）做门控判定。
  if (typeof window.getRemoteHistoryProjectBuckets === 'function') {
    for (const bucket of window.getRemoteHistoryProjectBuckets()) {
      const dirId = `dir:${String(bucket.openDirectory).replace(/\\/g, '/').toLowerCase()}`;
      const isRemoteOnly = !projects.has(dirId);
      const project = upsertProject({ openDirectory: bucket.openDirectory });
      if (!project) continue;
      if (isRemoteOnly) project.remoteOnly = true;
      for (const session of bucket.sessions) {
        if (project.sessions.some((item) => item.id === session.id)) continue;
        project.sessions.push(session);
      }
    }
  }

  // 项目实体（ticket 045）：与目录桶并存、互不继承。项目会话列表来自
  // workspace_sessions 的项目切片（服务端按 projectId 过滤返回，切片带
  // sessionProjectId 标记）；切片身份与项目一致时才计入——否则该项目
  // 处于未加载/空态（空项目可见，conversationCount 0）。
  const wsMeta = agent?.workspace_sessions || {};
  const sliceProjectId = String(wsMeta?.sessionProjectId || '').trim();
  for (const entity of (phProjectEntities.projects || [])) {
    // 归档项目不出现在选择器/项目组（ticket 046）：正常入口隐藏，管理弹窗
    // 单独经 ClawFW.phProjectEntities 呈现与恢复。项目会话仍留在索引里。
    if (entity.archived) continue;
    const projectSessions = sliceProjectId === entity.id
      ? sessions.filter((session) => String(session?.projectId || '').trim() === entity.id)
      : [];
    projects.set(entity.id, {
      id: entity.id,
      type: 'project',
      name: entity.name,
      openDirectory: entity.openDirectory,
      sessions: projectSessions,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  return Array.from(projects.values())
    .map((project) => ({
      ...project,
      sessions: project.sessions.sort(compareByRecency),
      conversationCount: project.sessions.length,
      latestSessionId: project.sessions[0]?.id || null,
      updatedAt: project.sessions[0]?.updatedAt || project.updatedAt || '',
    }))
    .sort(compareByRecency);
}

export function getProgrammingHelperProjectDisplayName(project) {
  // 项目实体有独立名称（ticket 045）；目录桶沿用目录叶名
  if (project?.type === 'project') return project.name || 'UntitledProject';
  const directoryName = getPathLeaf(project?.openDirectory);
  return directoryName || 'UntitledProject';
}

// 项目桶的本地宿主身份（能力门控寻址用，ADR-0012 决策 1）：本地目录桶归
// 本地工作区身份；remoteOnly 桶的目录仅存在于远程主机，没有本地宿主，返回
// 空串——本地工作区切换等真本地动作对该类桶不可用（这是真本地事实而非
// 能力位，不造伪能力位），由消费端按「动作不可用」路由到视图呈现。
export function getProjectLocalHostAgentId(project, localAgentId) {
  if (!project || project.remoteOnly) return '';
  return String(localAgentId || '');
}

export function hasWorkspaceSessions(agent = window.getCurrentAgentRecord()) {
  return getWorkspaceSessions(agent).length > 0;
}

export function canEnterWorkspaceChat(agent = window.getCurrentAgentRecord()) {
  const ui = window.getCurrentUnitUi(agent);
  if (!ui) return true;
  if (window.isUiOnlyUnit(agent)) return false;
  // A newly committed session is a valid chat target before its runtime is
  // connected. Allow the caller to keep the chat surface mounted while startup
  // finishes instead of falling back to the workspace home because the session
  // list has not been refreshed yet.
  if (typeof window.hasPendingSessionNavigation === 'function' && window.hasPendingSessionNavigation(agent)) return true;
  return hasWorkspaceSessions(agent);
}

export function getWorkspaceFormStorageKey(agentId) {
  return `protoclaw:workspace-form:${agentId}`;
}

export function getAgentWorkspaceState(agent) {
  return agent?.workspace_state && typeof agent.workspace_state === 'object'
    ? agent.workspace_state
    : { forms: {}, openDirectory: '', updatedAt: null };
}

export function updateAgentWorkspaceState(agentId, nextState) {
  for (const agent of allAgents) {
    if (agent.id === agentId) {
      agent.workspace_state = nextState;
    }
  }
}

export function updateAgentRecord(agentId, updates = {}) {
  let matched = null;
  setAllAgents(allAgents.map((agent) => {
    if (agent.id !== agentId) return agent;
    matched = { ...agent, ...updates };
    return matched;
  }));
  return matched;
}

export function applyManagedPrebuiltAgent(agentId, connectedAgent, options = {}) {
  if (!connectedAgent) {
    return updateAgentRecord(agentId, {
      runtime_session_id: null,
      runtimeSessionId: null,
      connected: false,
      status: 'stopped',
      message_count: 0,
      launchMode: options.uiOnlyWhenStopped ? 'ui-only' : null,
    });
  }

  return updateAgentRecord(agentId, {
    ...connectedAgent,
    status: connectedAgent.connected === false ? 'stopped' : 'running',
    message_count: connectedAgent.messageCount ?? connectedAgent.message_count ?? 0,
    launchMode: connectedAgent.launchMode || null,
  });
}

export function getWorkspaceBlockData(agent, blockId) {
  const workspaceData = agent?.workspace_data;
  if (!workspaceData || typeof workspaceData !== 'object') return null;
  return workspaceData[blockId] || null;
}

// —— 桥接期兼容面（kernel-state 访问器桥，domain: project-data）——
// 保留原因：仍有 classic 文件在调用时点以裸标识符取用这些数据查询（窗口键名
// 与访问器语义不变）。逐键剩余消费面（P2 项目/装配批 + workspace-actions 验收
// 后的现状；证据 = 全 public 的 AST + 裸标识符扫描）：
//   getPathLeaf                     ← classic runtime-status
//   resolveSidebarChildProjectGroup ← classic runtime-status
//   ensurePhProjectEntitiesLoaded   ← classic sidebar-render
//   getPhBrowsingTarget             ← classic app-main
//   getPhSessionOwnershipParams     ← classic sidebar-render
//   canEnterWorkspaceChat           ← classic app-ui
//   getAgentWorkspaceState          ← classic app-main / app-ui / claw-host / sidebar-render
//   updateAgentRecord               ← classic app-main
// 已注销的桥键（classic 消费方归零，消费方全部为 ESM 直接 import）：
//   getFeatureCreatorProjects / getAgentCreatorProjects / hasWorkspaceSessions /
//   applyManagedPrebuiltAgent（最后一个 classic 消费方 workspace-actions 已验收为
//   ESM 并在文件头具名 import）；phFetchSessionsWithOwnership（model-settings import）。
// 已改 direct import 的 ESM 消费方：feature-config / assembly-actions / assembly-data /
//   session-list-render / workspace-blocks / p2-w2-10-workspace-docset / session-dialogs /
//   trim-page / session-mutation / dir-config-dialog / ph-project-actions /
//   ph-project-session-move / ctx-menu-items / sidebar-operations / agent-loader-host /
//   workspace-actions（含早前批次注销的 getFeatureSessionDisplayName /
//   getPhDirectoryNavigationList / getWorkspaceFormStorageKey / getWorkspaceBlockData /
//   updateAgentWorkspaceState 等）。
// 无桥（唯一消费已改 import）：setPhBrowsingTarget / clearPhBrowsingTarget /
//   getProjectLocalHostAgentId；phDirIdOf / normalizePhProjectEntity / 比较与活动时间 helper
//   为模块私有。
// 注销条件：上列剩余 classic 消费方迁移后删除对应 defineKey 并下调桥债基线。
const bridgeApi = {
  getPathLeaf,
  resolveSidebarChildProjectGroup,
  ensurePhProjectEntitiesLoaded,
  getPhBrowsingTarget,
  getPhSessionOwnershipParams,
  canEnterWorkspaceChat,
  getAgentWorkspaceState,
  updateAgentRecord,
};
window.KernelState.defineKey('project-data', 'getPathLeaf', getPathLeaf);
window.KernelState.defineKey('project-data', 'resolveSidebarChildProjectGroup', resolveSidebarChildProjectGroup);
window.KernelState.defineKey('project-data', 'ensurePhProjectEntitiesLoaded', ensurePhProjectEntitiesLoaded);
window.KernelState.defineKey('project-data', 'getPhBrowsingTarget', getPhBrowsingTarget);
window.KernelState.defineKey('project-data', 'getPhSessionOwnershipParams', getPhSessionOwnershipParams);
window.KernelState.defineKey('project-data', 'canEnterWorkspaceChat', canEnterWorkspaceChat);
window.KernelState.defineKey('project-data', 'getAgentWorkspaceState', getAgentWorkspaceState);
window.KernelState.defineKey('project-data', 'updateAgentRecord', updateAgentRecord);
window.KernelState.claim('project-data', {
  get: (key) => bridgeApi[key],
  set: (key, value) => { bridgeApi[key] = value; },
});
