/**
 * app-main.js — 编排域（P4 T3 收尾：classic → ESM，活跃域 classic 清零的最后一
 * 件大文件）。
 *
 * 本文件此前是 classic 脚本（index.html 的 `./src/app-main.js` 标签），顶层语句
 * 在**解析相**执行。迁 ESM 后它的顶层语句改在**模块相**执行，index.html 里以
 * 一条 `<script type="module">` 入口装载，位置**必须早于 kernel-entry.js**——原因
 * 见下一条。
 *
 * ## 装载相位（本文件最关键的一条约束）
 *
 * 本文件是「宿主工厂提供方」：`createRuntimeSwitchHost` / `createCompactResumeHost`
 * / `createPollCoordinatorHost` / `createMessageProbeHost` / `createMetadataCommitHost`
 * / `createPollMaintenanceHost` / `createRuntimePollHost` / `createPollCycleHost` /
 * `createRuntimeNotFoundHost` / `createWorkspaceEntryHost` /
 * `createWorkspaceSessionNavigationHost` / `createApplicationStartupHost` 这 12 个
 * 工厂由 kernel-entry 图里的宿主模块在**求值期**经 `window.createXHost()` 取用
 * （原语义：classic 解析相先于一切模块执行，所以"一定已就位"）。
 *
 * 迁入模块相后这条时序不再由语言保证，因此本文件作为**独立 module 入口**排在
 * kernel-entry 之前求值（与 i18n-environment / agent-store 等状态入口同一做法，
 * 理由同构：它们的键同样在 kernel-entry 各宿主的求值期被取用）。改动装载序就是
 * 改动时序（plan R4），新增/挪动入口须同步 test/frontend-script-tags-gate.test.js
 * 的 MODULE_ENTRIES 与 test/p2-production-boot-browser-check.mjs 的门控清单。
 *
 * 另一个直接后果：**本文件不能静态 import 任何会（传递地）求值到这 12 个宿主
 * 模块的域**——那会在本文件求值完成之前就触发 `window.createXHost`，取到
 * undefined。实测受限于此的是 app-ui / chat-renderer / workspace-surface-host /
 * auto-title / input-composer / persistent-input / sidebar-operations /
 * project-data / input-actions / sse-client / agent-loader-host 等（它们经
 * agent-data-loader / 输入面 / 派发链接回 poll-coordinator-host、runtime-switch-host
 * 等宿主模块）。这些域一律经 `window.<桥键>` 晚绑定，行尾注释标注定义域。
 *
 * ## 启动编排（实测结论：未 await 的 IIFE，不用 top-level await）
 *
 * 认证闸 `window.__clawAuthReady` 由 auth-client（P4 收尾迁 ESM，module 入口在
 * index.html 中排在本入口之前）在 DOMContentLoaded 之后的 `initialize()` 里兑现，
 * 因此本模块求值时它**必然仍未兑现**：注册 reaction 的时点从解析相挪到模块相不改变
 * 任何顺序（浏览器回归实测 authAt < connectedAt）。
 *
 * 保持未被 await 的调用体（而不是写成 top-level await）的理由是「不必要的行为面
 * 变化」：实测（2026-11-18 变异：把 IIFE 改成 TLA 后跑真实 Chromium 回归）TLA
 * 在本页**不会**死锁——DOMContentLoaded 照常触发、auth/status 照常发出、两轮回归
 * 全 PASS；差别只在于 TLA 会推迟页面的 load 事件（并让任何未来 import 本模块的
 * 图等它）。既有语义是 classic 相的 fire-and-forget，保持它既等价又不引入新的
 * 装载面耦合。
 *
 * ## 可见性对账（高风险点实测：注册相位从解析相挪到模块相）
 *
 * `visibilitychange` 监听器现在在模块相注册。偏移窗口 = 「本文件求值完成」到
 * 「kernel-entry 图求值完成之间可能插入的宏任务」，窗口内可达的状态只有：agents
 * 空列表、`currentRuntimeAgentId` 恒 null（orchestration-state 初值，启动事务尚未
 * 开始）——此时处理体两条链路都不产生请求（下详），因此漏掉该窗口里的一次
 * visibilitychange 不改变任何可观察状态；首次前台对账由随后启动的轮询与下一次
 * 真实 visibilitychange 承担。同型先例：thread-store.js（P4 T3）的刷新引擎同样
 * 在模块相注册该事件。
 *
 * ## 状态归属（不搬移、不双存储）
 *
 * - 选中 / 只读 / 列表 / 列表刷新时刻 → agent-store-state（具名 import + setter）
 * - 运行时身份、切换事务、导航代次、恢复滚动位 → orchestration-state
 * - 渲染槽位（工作空间 tab / 详情 / docset / 去重签名）→ render-entry-state
 * - 会话视图快照 → session-view-storage；提交边界 → session-view-state /
 *   session-view-commit-host
 * - 身份解析 → identity；DOM 引用 → dom-refs（经 p2-bootstrap-dom 的既有路径）
 * - 仍 classic 的 app-core 词法状态：call 活动容器 / 侧栏交互态 / 会话切换引导
 *   标志 / 聊天表面偏好 经 modules/p2-bootstrap-* 适配面取用（app-core 的
 *   createP2Bootstrap*Host 转发同一绑定）；轮询节奏与模板重载记账经本批新增的
 *   `createP2BootstrapPollHost()`（最小 seam，同一绑定，不另存状态）。
 * - 本文件自身的编排态（`_forceFullPollNextCycle`、`_lastWsSessionRefreshAt`）保持
 *   原位：前者零外部消费方、随本文件私有；后者原本就是 window 上的跨路径时间戳
 *   （轮询维护宿主写、测试夹具读），保持同一槽位不变量。
 *
 * ## 对外符号（桥接期）
 *
 * 文件末尾按逐键消费面清单发布 domain `app-main` 的桥键：classic 消费方
 * （app-core / claw-host / desktop-* / 悬置域 wg-* / im-*）与经 window 晚绑定的
 * ESM 域语义不变。终局（T5 编排域收敛、app-core 剩余 defineKey 的 owner 迁移）
 * 逐键改具名 import 后删除对应 defineKey 并下调桥债基线。
 */

import { t } from './i18n.js';
import { escapeHtml } from './modules/markdown-utils.js';
import { getCurrentLanguage, showAgentStartError } from './modules/i18n-environment-state.js';
import { invoke } from './modules/transport.js';
import { domRefs } from './modules/p2-bootstrap-dom.js';
import { callActivity } from './modules/p2-bootstrap-call-activity.js';
import { chatSurface } from './modules/p2-bootstrap-chat-surface.js';
import { sessionSwitch } from './modules/p2-bootstrap-session-switch.js';
import { sidebarUi } from './modules/p2-bootstrap-sidebar.js';
import {
  allAgents,
  focusedAgentId,
  readOnlyMode,
  lastAgentListRefreshAt,
  setFocusedAgentId,
  setReadOnlyMode,
  setLastAgentListRefreshAt,
} from './modules/agent-store-state.js';
import {
  currentRuntimeAgentId,
  pendingSwitchTarget,
  pendingSwitchSerial,
  _switchEpoch,
  _navigationGuardEpoch,
  _restoredScrollTop,
  setCurrentRuntimeAgentId,
  setPendingSwitchTarget,
  setPendingSwitchSerial,
  setSwitchEpoch,
  setRestoredScrollTop,
} from './modules/orchestration-state.js';
import {
  activeFeaturePanel,
  currentWorkspaceTab,
  lastRenderedWorkspaceHtml,
  _lastRenderedChatSig,
  currentWorkspaceArtifactDetail,
  currentWorkspaceDocsetDetail,
  currentProjectDocsetOpen,
  currentProjectRequirementEdit,
  currentProjectDocsetPage,
  setCurrentWorkspaceTab,
  setLastRenderedWorkspaceHtml,
  setLastRenderedChatSig,
  setCurrentWorkspaceArtifactDetail,
  setCurrentWorkspaceDocsetDetail,
  setCurrentProjectDocsetOpen,
  setCurrentProjectRequirementEdit,
  setCurrentProjectDocsetPage,
} from './modules/render-entry-state.js';
import {
  currentMessages,
  currentInputRequests,
  currentHookInspectorSignature,
  currentOverviewSignature,
  currentTodoPlanSignature,
} from './modules/session-view-storage.js';
import {
  normalizeAgentIdentity,
  getParentAgentId,
  getLogicalAgentId,
  getRuntimeId,
  getAgentRuntimeId,
  setViewerSessionBinding,
  _deriveRuntimeSessionIdFromAgents,
  getRuntimeWorkspaceSessionId,
  getRuntimeContextKey,
} from './modules/identity.js';
import {
  applySessionViewPatch,
  captureSessionViewToken,
  readCurrentSessionViewState,
} from './modules/session-view-state.js';
import {
  commitSessionViewState,
  commitSessionViewPatch,
  isSessionViewTokenCurrent,
  isSessionViewInputRequestsCurrent,
} from './modules/session-view-commit-host.js';
import { saveCurrentRuntimeToCache, restoreRuntimeFromCache } from './modules/runtime-view-cache-host.js';
import {
  partialCompactInFlight,
  partialCompactRuntimeId,
  clearPartialCompactState,
} from './modules/p2-w2-3b-rollback-domain.js';
import {
  getEmptyOverviewSnapshot,
  normalizeOverviewSnapshot,
  getOverviewSignature,
  normalizeHookInspector,
  getHookInspectorSignature,
  extractMessagesProbe,
} from './modules/overview-data.js';
import {
  getEmptyTodoPlan,
  normalizeTodoPlan,
  getTodoPlanSignature,
} from './modules/todo-plan.js';
import { attachMessagesTimestamps } from './modules/message-timeline.js';
import { closeAgentContextMenu, openCompactMenu } from './modules/context-menu.js';

/**
 * 仍 classic 的 app-core 词法状态（顶层 let/const 没有 window 可达形态）。
 * 本批新增的最小 seam：轮询间隔两个 const + 两处时间戳绑定（get/set 成对转发
 * 到原声明，同一份状态，不另存副本）。消费方就是本文件的四个轮询宿主工厂与
 * 主循环；`_lastChoiceAlertCheckAt` 原先只经本文件的 createPollCycleHost 转发，
 * 本文件进模块相后这里成为它唯一的 classic 读写入口。
 */
const pollHost = window.createP2BootstrapPollHost();

// ── 本文件私有的编排态 ──────────────────────────────────────────────────
// SSE 全量对账标记（§6.5 兜底闭环）：看门狗静默 30s、resync 帧、UDS 重连都经
// forceFullPollOnce 置位，下一轮 poll 消费一次。零外部消费方，随本文件私有。
let _forceFullPollNextCycle = false;

// ── 身份解析（顶栏 / 侧栏高亮 / 切换宿主的公共查询）──────────────────────

function getCurrentSessionHostAgentId() {
  return normalizeAgentIdentity(getCurrentHostAgentRecord()?.id || focusedAgentId);
}

function getCurrentHostAgentRecord() {
  const hostId = normalizeAgentIdentity(focusedAgentId);
  if (!hostId) return null;
  return allAgents.find((agent) => normalizeAgentIdentity(agent?.id) === hostId) || null;
}

function getCurrentRuntimeRecord() {
  const runtimeId = normalizeAgentIdentity(currentRuntimeAgentId);
  if (!runtimeId) return null;
  const runtimeRecord = allAgents.find((agent) => {
    const agentId = normalizeAgentIdentity(agent?.id);
    const resolvedRuntimeId = normalizeAgentIdentity(getAgentRuntimeId(agent));
    return agentId === runtimeId || resolvedRuntimeId === runtimeId;
  }) || null;
  if (runtimeRecord) {
    return runtimeRecord;
  }
  const hostRecord = getCurrentHostAgentRecord();
  const hostRuntimeId = normalizeAgentIdentity(getRuntimeId(hostRecord));
  if (hostRecord && hostRuntimeId && hostRuntimeId === runtimeId) {
    return hostRecord;
  }
  return null;
}

// 视图绑定会话自身的标题（会话列表事实，不随 runtime 生命周期漂移）：
// 顶栏标题兜底链优先于此，避免落到宿主 active（跨会话共享可变状态，
// 接续退役窗口会串成另一个会话的标题）。
function _titleForBoundSession() {
  try {
    const runtimeId = normalizeAgentIdentity(currentRuntimeAgentId);
    const hostRecord = getCurrentHostAgentRecord();
    // 绑定会话解析：viewer 绑定优先；接续退役窗口 runtime 态被清时回退
    // activeConversation（视图身份仍指向线程会话，这是「等待重绑」不是离开）。
    const fallbackSessionId = normalizeAgentIdentity(window.ClawThreads?.activeConversation?.sessionId);
    const sessionId = (runtimeId && typeof getRuntimeWorkspaceSessionId === 'function'
      ? String(getRuntimeWorkspaceSessionId(runtimeId) || '').trim() : '')
      || (hostRecord && fallbackSessionId && normalizeAgentIdentity(window.ClawThreads?.activeConversation?.agentId) === normalizeAgentIdentity(hostRecord.id)
        ? fallbackSessionId
        : '');
    if (!hostRecord || !sessionId) return '';
    const sessions = Array.isArray(hostRecord.workspace_sessions?.sessions)
      ? hostRecord.workspace_sessions.sessions : [];
    const record = sessions.find((s) => normalizeAgentIdentity(s?.id) === sessionId);
    if (record?.title) return String(record.title).trim();
    // 线程宿主 APP（coder）的会话可能不在轻量会话切片（如接续退役窗口
    // 内索引尚未更新）：线程事实兜底——head 会话标题（threads wire 字段），
    // 不落宿主名（历史症状：顶栏串成 'coder'）。
    const thread = typeof window.getThreadForSession === 'function'
      ? window.getThreadForSession(hostRecord.id, sessionId) : null;
    return String(thread?.headSessionTitle || '').trim();
  } catch {
    return '';
  }
}

function getCurrentVisualAgentTitle() {
  const runtimeRecord = getCurrentRuntimeRecord();
  const hostRecord = getCurrentHostAgentRecord();
  if (runtimeRecord && normalizeAgentIdentity(currentRuntimeAgentId)) {
    return runtimeRecord.active_workspace_display_name
      || runtimeRecord.active_workspace_agent_name
      || runtimeRecord.active_workspace_session_title
      || runtimeRecord.name
      || _titleForBoundSession()
      || hostRecord?.active_workspace_display_name
      || hostRecord?.active_workspace_session_title
      || hostRecord?.name
      || currentRuntimeAgentId;
  }
  // 远程回退（T21-E）：本地 record 链全部落空且焦点是远程命名空间身份时，
  // 标题取目录条目回退链（sessionTitle → name）。按运行时引用查询（R3 裁决）：
  // 目录条目身份挂在 entry.runtimeId / entry.id 上，运行时引用才是条目匹配键，
  // 与 title popup 的查询键保持同源。标题跟随由 catalog 4s 轮询
  // （refreshRemoteCatalog → renderAgentList → updateCurrentAgentChrome）
  // 自然带动，不新增轮询。
  const focusedId = normalizeAgentIdentity(focusedAgentId) || normalizeAgentIdentity(currentRuntimeAgentId);
  if (typeof window.isRemoteNamespaceAgentId === 'function' && window.isRemoteNamespaceAgentId(focusedId)) {
    const runtimeRef = normalizeAgentIdentity(currentRuntimeAgentId);
    const runtimeTitle = runtimeRef
      ? (window.RemoteConnections?.getEntrySessionTitle?.(runtimeRef) || '')
      : '';
    if (runtimeTitle) return runtimeTitle;
  }
  return _titleForBoundSession() || hostRecord?.name || t('page_title');
}

function updateCurrentAgentChrome() {
  if (!domRefs.currentAgentTitle) return;
  const hasSelection = normalizeAgentIdentity(focusedAgentId) || normalizeAgentIdentity(currentRuntimeAgentId);
  if (!hasSelection) {
    domRefs.currentAgentTitle.textContent = t('page_title');
    return;
  }
  domRefs.currentAgentTitle.textContent = getCurrentVisualAgentTitle();
}

function isAgentActive(agent) {
  const agentId = normalizeAgentIdentity(agent?.id);
  const runtimeId = normalizeAgentIdentity(currentRuntimeAgentId);
  const hostId = normalizeAgentIdentity(focusedAgentId);
  if (!agentId) return false;
  if (runtimeId) {
    if (agent?.source === 'prebuilt' && agentId === hostId) {
      return false;
    }
    return agentId === runtimeId && agentId === hostId;
  }
  // 接续等待表面：视图挂在具体等待会话（占位条目高亮），宿主 APP 节点
  // 让位——与 runtime 态下 prebuilt 宿主让位给会话条目同构。
  const awaitTarget = typeof window.getActiveThreadInputTarget === 'function'
    ? window.getActiveThreadInputTarget()
    : null;
  if (awaitTarget && agent?.source === 'prebuilt'
    && agentId === normalizeAgentIdentity(awaitTarget.agentId)) {
    return false;
  }
  return agentId === hostId;
}

function getCurrentAgentRecord() {
  return getCurrentHostAgentRecord();
}

/**
 * APP 侧栏可见性（ADR-0025）：服务端合流作者默认、用户覆盖与有无存活且
 * 绑定 Session 的 Runtime，wire 以
 * sidebarVisible 下发，前端纯消费。persistent 直显。本机不保留任何粘性
 * 记忆：入口消失后的找回路径是设置 → 工作空间的「始终显示」。
 */
function isPrebuiltAppVisible(agent) {
  if (agent.visibility !== 'on-demand') return true;
  return agent.sidebarVisible === true;
}

/**
 * host 相邻排序（ADR-0025）：声明 host 的 APP 紧随其宿主之后（如 Coder
 * 紧随智能编码空间），表达同域绑定。宿主缺席或自身已隐藏时保持原序。
 * hosted 先于宿主出现在列表时（如字母序 coder < programming-helper 的
 * wire 顺序）必须等宿主落位再挂，不得按输入顺序直出。
 */
function orderPrebuiltByHost(list) {
  const result = [];
  const taken = new Set();
  const idsInList = new Set(list.map((agent) => String(agent.id || '').trim()).filter(Boolean));
  for (const agent of list) {
    if (taken.has(agent.id)) continue;
    const hostId = String(agent.host || '').trim();
    // 宿主在本列表且尚未处理：让宿主先落位（本条随后由宿主的内层挂载）
    if (hostId && hostId !== String(agent.id || '').trim() && idsInList.has(hostId) && !taken.has(hostId)) continue;
    result.push(agent);
    taken.add(agent.id);
    for (const hosted of list) {
      if (taken.has(hosted.id)) continue;
      if (String(hosted.host || '').trim() !== String(agent.id || '').trim()) continue;
      result.push(hosted);
      taken.add(hosted.id);
    }
  }
  // 兜底回补：host 链成环（互为宿主）或宿主自身被隐藏时，跳过的条目按
  // 原序直出，绝不丢弃。
  for (const agent of list) {
    if (taken.has(agent.id)) continue;
    result.push(agent);
    taken.add(agent.id);
  }
  return result;
}

function groupConnectedAgents(agents) {
  // 左侧分类使用 sidebarGroup。
  const TOOL_AGENT_IDS = new Set(['programming-helper']);
  const WORK_GROUP_IDS = new Set(['work-group']);
  const prebuiltIds = new Set(
    agents
      .filter((agent) => agent.source === 'prebuilt')
      .map((agent) => String(agent.id || '').trim())
      .filter(Boolean)
  );
  const orphanRuntimeAgents = agents.filter((agent) => {
    if (agent.source === 'prebuilt') return false;
    const parentId = String(getParentAgentId(agent) || '').trim();
    return !parentId || !prebuiltIds.has(parentId);
  });
  const allPrebuilt = orderPrebuiltByHost(
    agents.filter((agent) => agent.source === 'prebuilt' && isPrebuiltAppVisible(agent))
  );
  const prebuiltById = new Map(allPrebuilt.map((agent) => [String(agent.id || '').trim(), agent]));
  // 分组解析：自身声明优先，hosted APP（ADR-0025）跟随宿主分组——「紧随
  // 宿主」的相邻排序必须落在同一分组内才有意义（如 coder 紧随智能编码
  // 空间，同在工具与效率组）；host 链沿 parent 追溯并防环。
  const groupKeyOf = (agent, seen = null) => {
    const group = String(agent.sidebarGroup || '').trim();
    if (group) return group;
    const idKey = String(agent.id || '').trim();
    if (TOOL_AGENT_IDS.has(idKey)) return 'tool';
    if (WORK_GROUP_IDS.has(idKey)) return 'work-group';
    const hostId = String(agent.host || '').trim();
    const host = hostId && prebuiltById.has(hostId) ? prebuiltById.get(hostId) : null;
    if (!host || host === agent) return '';
    const nextSeen = seen || new Set([idKey]);
    if (nextSeen.has(hostId)) return '';
    nextSeen.add(hostId);
    return groupKeyOf(host, nextSeen);
  };
  return {
    prebuilt: allPrebuilt.filter((agent) => {
      const group = groupKeyOf(agent);
      return group !== 'tool' && group !== 'work-group';
    }),
    workGroup: allPrebuilt.filter((agent) => groupKeyOf(agent) === 'work-group'),
    tool: allPrebuilt.filter((agent) => groupKeyOf(agent) === 'tool'),
    external: orphanRuntimeAgents,
  };
}

function isRuntimeItemActive(runtimeId, entry = null) {
  const normalizedRuntimeId = normalizeAgentIdentity(runtimeId);
  if (normalizedRuntimeId === '') return false;
  const normalizedCurrent = normalizeAgentIdentity(currentRuntimeAgentId);
  // 停在 workspace surface 时无选中运行时。此时不做兜底比较：本地条目
  // resolveRuntimeRef 未命中返回 undefined，归一化后的空串会与空
  // currentRuntimeAgentId 对称相等，导致所有运行中会话被误判为选中态。
  if (normalizedCurrent === '') {
    // 接续等待表面例外（视图身份挂在等待会话，无 runtime 态可比较）：
    // 点击接续占位条目 / 接续退役窗口 404 清空 runtime 态时，高亮按
    // 会话身份对齐——getActiveThreadInputTarget 的一致性校验（宿主匹配
    // + 视图仍挂在该会话）保证只有当前等待会话的条目命中，用户切走后
    // 立即失效，不残留。
    const awaitTarget = typeof window.getActiveThreadInputTarget === 'function'
      ? window.getActiveThreadInputTarget()
      : null;
    const awaitSessionId = String(awaitTarget?.sessionId || '').trim();
    const entrySessionId = String(entry?.sessionId || '').trim();
    // 归属对齐：等待会话的宿主必须就是条目的呈现宿主（ownerId /
    // sidebarEntryId），远程或旁路条目即使 sessionId 巧合相同也不高亮。
    const entryOwnedByAwaitHost = String(entry?.ownerId || '').trim() === String(awaitTarget?.agentId || '').trim()
      || String(entry?.sidebarEntryId || '').trim() === String(awaitTarget?.agentId || '').trim();
    return awaitSessionId !== '' && entryOwnedByAwaitHost && entrySessionId === awaitSessionId;
  }
  if (normalizedCurrent === normalizedRuntimeId) return true;
  // 远程分组条目以命名空间运行时引用渲染，而 currentRuntimeAgentId 持有同一
  // 引用的解析结果（switchAgent 解析后是裸运行时 id）。两者归一化后比较；
  // 反向解析（裸 id → 命名空间引用）不可靠，直接比较原始值即可覆盖。
  const resolved = window.RemoteConnections?.resolveRuntimeRef?.(normalizedRuntimeId);
  return !!resolved && normalizeAgentIdentity(resolved) === normalizedCurrent;
}

function toEpochMs(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return isNaN(parsed) ? 0 : parsed;
}

function getInputSurfaceMode(requests = readCurrentSessionViewState().inputRequests) {
  // 输入面模式由 chat/runtime/choice 等显示状态决定；普通文本 lease
  // 不参与 composer 形态判定。
  return window.resolveInputSurfaceMode(window.readInputSurfaceModeState(requests, window.isChatSurfaceActive()));
}

// ── Sidebar rendering & agent list → modules/sidebar-render.js ──


function createWorkspaceEntryHost() {
  return {
    bumpNavigationGuard: () => window.bumpNavigationGuard(),
    closeContextMenu: () => closeAgentContextMenu(),
    findWorkspace: (id) => allAgents.find((agent) => agent.id === id && agent.source === 'prebuilt'),
    isWorkspaceHost: (agent) => window.isWorkspaceHostUnit(agent),
    isWorkspaceSurface: (agent) => window.isWorkspaceSurfaceUnit(agent),
    preferHome: (agent) => window.setPreferredUnitMode('home', agent),
    focus: (id) => { setFocusedAgentId(id); },
    renderAgents: () => window.renderAgentList(),
    hasDetail: (id) => window.AgentLoaderHost.loadedAgentDetailIds.has(id),
    markDetailLoaded: (id) => window.AgentLoaderHost.loadedAgentDetailIds.add(id),
    showLoading: () => {
      domRefs.container.innerHTML = '<div class="workspace-surface" style="display:grid;place-items:center;color:var(--text-secondary);font-size:14px;">' + escapeHtml(getCurrentLanguage() === 'zh' ? '加载中...' : 'Loading...') + '</div>';
    },
    loadDetail: (id) => window.loadAgentDetail(id),
    persistEntry: (id) => { try { localStorage.setItem('claw:lastFocusedEntryId', id); } catch { /* ignore */ } },
    selectWorkspace: (id, options) => window.selectWorkspaceSurface(id, options),
    switchAgent: (id) => window.switchAgent(id),
    isPending: (id) => sidebarUi.pendingPrebuiltAgentIds.has(id),
    markPending: (id) => sidebarUi.pendingPrebuiltAgentIds.add(id),
    clearPending: (id) => sidebarUi.pendingPrebuiltAgentIds.delete(id),
    navigationEpoch: () => _navigationGuardEpoch,
    startAgent: (id) => invoke('start_agent', { agentId: id }),
    waitRuntime: (id) => window.waitForPrebuiltRuntimeSession(id),
    requestSwitch: (id, source) => window.requestSwitch(id, source),
    error: (...args) => console.error(...args),
    showStartError: (error) => showAgentStartError(error),
  };
}

function applyOptimisticWorkspaceSession(agentId, session) {
  if (!agentId || !session?.id) return null;
  const hostAgent = allAgents.find((agent) => agent.id === agentId) || null;
  const existingSessions = Array.isArray(hostAgent?.workspace_sessions?.sessions)
    ? hostAgent.workspace_sessions.sessions
    : [];
  const nextSessions = [session, ...existingSessions.filter((item) => item?.id !== session.id)];
  return window.updateAgentRecord(agentId, {
    workspace_sessions: {
      ...(hostAgent?.workspace_sessions || {}),
      activeSessionId: session.id,
      sessions: nextSessions,
    },
    active_workspace_session_id: session.id,
    active_workspace_session_form_id: session.formId || null,
    active_workspace_session_title: session.title || '',
    active_workspace_agent_name: session.agentName || '',
    active_workspace_display_name: session.formId === 'assembly-form'
      ? (session.agentName || session.title || '')
      : (hostAgent?.active_workspace_display_name || ''),
  });
}

// ── 幂等键（ADR-0011）：写类提交统一携带（本地忽略、远程强制）───────────
// **不上桥**（与 input-actions / ctx-menu-handlers 同制）：classic 相
// `wg-threads-panel.js` 的同名顶层声明已经把 `window.newIdempotencyKey` 建成
// non-configurable 数据属性（悬置域，先于模块相执行），对它 defineKey 会在
// 模块求值期抛 `Cannot redefine property` —— 那会中断整个编排域。因此本模块
// 保持私有副本自用；既有 window 消费方（claw-host 的插件 env 裸引用守卫、
// context-guard-toggle 的 `window.newIdempotencyKey()`）继续取到 wg 侧逐字
// 相同的实现，语义不变。全仓同名单例收敛留给 T5（悬置域封存）。
function newIdempotencyKey() {
  const cryptoObj = (typeof crypto !== 'undefined') ? crypto : null;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createCompactResumeHost() {
  return {
    isRemote: (id) => typeof window.isRemoteNamespaceAgentId === 'function' && window.isRemoteNamespaceAgentId(id),
    remote: () => window.RemoteConnections,
    createOperationId: (reason) => window.createSidebarOperationId(reason),
    now: () => window.sidebarDiagnosticNow(),
    observe: (id) => window.beginSidebarOperationMainThreadObservation(id),
    checkpoint: (...args) => window.recordSidebarOperationCheckpoint(...args),
    // 显式 window.fetch：宿主工厂交给 ESM 消费方的取数入口就是页面上那条
    // （auth-client 的 401 拦截补丁挂在这里），与 classic 裸标识符经全局对象
    // 解析到同一函数；写成裸 `fetch` 会绑定模块 realm 的全局，测试夹具替换
    // window.fetch 时两条通道分叉。
    fetch: (...args) => window.fetch(...args),
    idempotencyKey: () => newIdempotencyKey(),
    refreshThreads: () => { if (typeof window.refreshThreads === 'function') window.refreshThreads(true).catch(() => {}); },
  };
}


// PH session list helpers (switchPhSessionTab, phToggleSessionSort, _buildPhSearchPanelHtml,
// phOnSearchInput, phClearSearch, phShowSessionCtxMenu) moved to modules/ph-session-list.js
// runWorkspaceAction moved to modules/workspace-actions.js

/**
 * Unified cross-workspace session navigation.
 *
 * Combines workspace switch + session activation into a single smooth flow,
 * avoiding the intermediate workspace-surface render that handlePrebuiltAgentClick
 * + runWorkspaceAction would produce when called serially.
 *
 * Used by: group chat "jump to session", home dashboard "open session", etc.
 *
 * @param {string} agentId  Target workspace agent ID (e.g. 'programming-helper')
 * @param {string} sessionId  Session ID to activate (empty = just switch workspace)
 * @param {object} [options]
 * @param {object} [options.actionOverride]  Custom action object to pass to
 *   runWorkspaceAction instead of { type: 'open_session', sessionId }.
 *   Used by navigateToSessionRecord which needs { type: 'view_session_record', ... }.
 */
function createWorkspaceSessionNavigationHost() {
  return {
    bumpNavigationGuard: () => window.bumpNavigationGuard(),
    navigationEpoch: () => _navigationGuardEpoch,
    focusedAgentId: () => focusedAgentId,
    runtimeId: () => currentRuntimeAgentId,
    readOnlyMode: () => readOnlyMode,
    findWorkspace: (id) => allAgents.find((agent) => agent.id === id && agent.source === 'prebuilt'),
    saveWorkspaceScroll: () => { if (typeof window.saveCurrentWorkspaceSurfaceScroll === 'function') window.saveCurrentWorkspaceSurfaceScroll(); },
    saveCache: (id, key) => saveCurrentRuntimeToCache(id, key),
    contextKey: (id) => getRuntimeContextKey(id),
    selectLoading: (agentId) => {
      setFocusedAgentId(agentId);
      setCurrentRuntimeAgentId(null);
      applySessionViewPatch({ identity: { agentId, sessionId: '' } });
      setReadOnlyMode(false);
      setCurrentWorkspaceArtifactDetail(null);
      setCurrentWorkspaceDocsetDetail(null);
      setCurrentProjectDocsetOpen(false);
      setCurrentProjectRequirementEdit(null);
      setCurrentWorkspaceTab('chat');
      setLastRenderedChatSig('');
      window.resetRuntimeBackedSurfaceState();
      window.renderAgentList();
      domRefs.container.innerHTML = '<div class="workspace-surface" style="display:grid;place-items:center;color:var(--text-secondary);font-size:14px;">' + escapeHtml(getCurrentLanguage() === 'zh' ? '加载中...' : 'Loading...') + '</div>';
    },
    loadDetail: (id) => window.loadAgentDetail(id),
    runAction: (action) => window.runWorkspaceAction(action),
    preferHome: (agent) => window.setPreferredUnitMode('home', agent),
    render: () => window.renderCurrentMainView(),
  };
}

// ── Docset & material actions → modules/workspace-docset.js ──


// 桌面/模板级事件入口：迁移前是 `window.X =` 赋值。inline-events 迁移（data-
// workspace-action 捕获相委托）之后两者都**零仓内消费方**（public/ 与
// features/ 的生成模板逐字 grep 为空），因此按配方收敛为模块私有、不再上桥：
// 保留实现原样，随编排域收敛批次（T5）一并删除。新增消费方请直接用
// `data-workspace-action` 委托，不要恢复 window 面。
async function runWorkspaceActionFromEvent(event, rawAction) {
  const btn = event?.target instanceof Element ? event.target.closest('button[data-workspace-action]') : null;
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  await window.runWorkspaceAction(rawAction, btn || undefined);
}

document.addEventListener('click', (event) => {
  const actionButton = event.target instanceof Element
    ? event.target.closest('button[data-workspace-action]')
    : null;
  if (!actionButton) return;
  if (actionButton.classList.contains('compact-trigger')) return;
  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === 'function') {
    event.stopImmediatePropagation();
  }
  const rawAction = actionButton.dataset?.workspaceAction || '';
  window.runWorkspaceAction(rawAction, actionButton).catch((error) => {
    console.error('Failed to handle delegated workspace action:', error);
  });
}, true);

// ── assembly actions → modules/assembly-actions.js (Phase C, 2026-07-04) ──


// ── PH 项目操作 / Model Config → modules/ph-project-actions.js (Phase A-4, 2026-07-03) ──

// ── ctx-menu items / dispatcher → modules/ctx-menu-items.js (Phase B-2, 2026-07-04) ──

function showCompactMenu(event, buttonElement) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  const rawAction = buttonElement?.dataset?.workspaceAction;
  let action = {};
  try {
    action = typeof rawAction === 'string' ? JSON.parse(rawAction) : rawAction;
  } catch {
    return;
  }

  if (!action.sessionId) return;

  const rect = buttonElement.getBoundingClientRect();
  openCompactMenu(action, rect.left, rect.bottom + 4);
}


function markSessionLoading(agentId, sessionId) {
  const el = document.querySelector(
    `.workspace-history-item[data-prebuilt-session-agent-id="${CSS.escape(agentId)}"][data-prebuilt-session-id="${CSS.escape(sessionId)}"]`
  );
  if (el) el.classList.add('session-loading');
}

function markActionLoading(buttonEl) {
  if (buttonEl) buttonEl.classList.add('action-loading');
}

function clearSessionLoading(agentId) {
  document.querySelectorAll(`.workspace-history-item.session-loading[data-prebuilt-session-agent-id="${CSS.escape(agentId)}"]`)
    .forEach(el => el.classList.remove('session-loading'));
  document.querySelectorAll('.workspace-action.action-loading')
    .forEach(el => el.classList.remove('action-loading'));
}

 // ── assembly session operations → modules/assembly-actions.js (Phase C, 2026-07-04) ──


// Synchronous UI dependencies for the ESM runtime switching transaction.
function createRuntimeSwitchHost() {
  return {
    state: {
      get pendingSwitchTarget() { return pendingSwitchTarget; },
      set pendingSwitchTarget(value) { setPendingSwitchTarget(value); },
      get pendingSwitchSerial() { return pendingSwitchSerial; },
      set pendingSwitchSerial(value) { setPendingSwitchSerial(value); },
      get navigationEpoch() { return _navigationGuardEpoch; },
      get switchEpoch() { return _switchEpoch; },
      set switchEpoch(value) { setSwitchEpoch(value); },
      get focusedAgentId() { return focusedAgentId; },
      set focusedAgentId(value) { setFocusedAgentId(value); },
      get runtimeId() { return currentRuntimeAgentId; },
      set runtimeId(value) { setCurrentRuntimeAgentId(value); },
      get readOnlyMode() { return readOnlyMode; },
      set readOnlyMode(value) { setReadOnlyMode(value); },
      get lastRenderedWorkspaceHtml() { return lastRenderedWorkspaceHtml; },
      set lastRenderedWorkspaceHtml(value) { setLastRenderedWorkspaceHtml(value); },
      get followLatest() { return chatSurface.followLatestEnabled; },
      get restoredScrollTop() { return _restoredScrollTop; },
      set restoredScrollTop(value) { setRestoredScrollTop(value); },
    },
    switchAgent: (id) => window.switchAgent(id),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    hasPendingNavigation: (agent) => typeof window.hasPendingSessionNavigation === 'function' && window.hasPendingSessionNavigation(agent),
    bumpNavigationGuard: () => window.bumpNavigationGuard(),
    closeContextMenu: () => closeAgentContextMenu(),
    findAgent: (id) => window.findAgentByIdentity(id),
    isWorkspaceHost: (agent) => window.isWorkspaceHostUnit(agent),
    runtimeId: (agent) => getRuntimeId(agent),
    agentRuntimeId: (agent) => getAgentRuntimeId(agent),
    isRemote: (id) => window.isRemoteNamespaceAgentId(id),
    remote: () => window.RemoteConnections,
    closeReadOnlySession: () => {
      if (typeof window.getReadOnlySessionTarget === 'function' && window.getReadOnlySessionTarget()
        && typeof window.closeReadOnlySession === 'function') window.closeReadOnlySession();
    },
    isWorkspaceSurface: (agent) => window.isWorkspaceSurfaceUnit(agent),
    selectWorkspace: (id, options) => window.selectWorkspaceSurface(id, options),
    storeDraft: () => window._storeVisibleSessionInputDraft(),
    saveWorkspaceScroll: () => { if (typeof window.saveCurrentWorkspaceSurfaceScroll === 'function') window.saveCurrentWorkspaceSurfaceScroll(); },
    saveCache: (id) => saveCurrentRuntimeToCache(id),
    logicalId: (agent) => getLogicalAgentId(agent),
    normalize: (id) => normalizeAgentIdentity(id),
    clearFinished: (id) => callActivity._recentlyFinishedRuntimes.delete(id),
    deriveSession: (id) => _deriveRuntimeSessionIdFromAgents(id),
    bindSession: (id, session) => setViewerSessionBinding(id, session),
    updateThreadIndicators: () => {
      if (typeof window._syncActiveThreadSubscription === 'function') window._syncActiveThreadSubscription();
      if (typeof window.updateThreadHeaderIndicator === 'function') window.updateThreadHeaderIndicator();
      if (typeof window.updateQueueIndicator === 'function') window.updateQueueIndicator();
    },
    browseOnly: () => window.ClawThreads?.browseOnly === true,
    resetSurface: () => {
      setCurrentWorkspaceArtifactDetail(null);
      setCurrentWorkspaceDocsetDetail(null);
      setCurrentProjectDocsetOpen(false);
      setCurrentProjectRequirementEdit(null);
      setCurrentProjectDocsetPage('requirement');
      setCurrentWorkspaceTab('chat');
      setLastRenderedChatSig('');
    },
    resetScroll: () => {
      window.setPendingChatScrollRestore(null);
      if (typeof window.setPendingChatViewportAnchor === 'function') window.setPendingChatViewportAnchor(null);
      chatSurface.showChatProcess = false;
    },
    resetStatus: () => window.resetRuntimeStatusForSwitch(),
    activateCollapse: (key) => window.activateUserCollapseStateForContext(key),
    contextKey: (id) => getRuntimeContextKey(id),
    restoreCache: (id) => restoreRuntimeFromCache(id),
    setPendingScroll: (top) => window.setPendingChatScrollRestore(top),
    render: () => window.renderCurrentMainView(),
    renderPanel: () => window.renderFeaturePanel(),
    patch: (patch) => applySessionViewPatch(patch),
    emptyOverview: () => getEmptyOverviewSnapshot(),
    emptyTodo: () => getEmptyTodoPlan(),
    setFollowLatest: (value) => window.setFollowLatest(value),
    beginFollowWindows: () => { window.beginFollowLatestCooldown(); window.beginFollowLatestEntryWindow(); },
    renderAgents: () => window.renderAgentList(),
    // 显式 window.fetch：宿主工厂交给 ESM 消费方的取数入口就是页面上那条
    // （auth-client 的 401 拦截补丁挂在这里），与 classic 裸标识符经全局对象
    // 解析到同一函数；写成裸 `fetch` 会绑定模块 realm 的全局，测试夹具替换
    // window.fetch 时两条通道分叉。
    fetch: (...args) => window.fetch(...args),
    isCalling: (data) => window.resolveNotificationCallingState(data),
    applyCalling: (id, calling) => {
      if (calling) { window._markAgentCallStartedForNotify(id); callActivity._agentCallActive.set(id, true); }
      else callActivity._agentCallActive.delete(id);
    },
    syncActionButton: () => window._syncPersistentActionButton(),
    persistFocus: (id) => {
      try { localStorage.setItem('claw:lastFocusedRuntimeId', id); localStorage.removeItem('claw:lastFocusedEntryId'); }
      catch { /* localStorage may be unavailable. */ }
    },
    loadData: (id) => window.loadAgentData(id),
    loadAgents: () => window.loadAgents(),
    clearLoading: () => window.clearChatLoadingSession(),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    alert: (message) => window.alert(message),
  };
}

// ── Context menu action handlers → modules/ctx-menu-handlers.js ──


// ── Data loading → modules/debug-logs.js, debug-mcp.js, agent-data-loader.js ──

// ── Auto session title generation + Choice alerts → modules/auto-title.js (Phase A-3, 2026-07-03) ──

// ── Runtime poll coordinator ───────────────────────────────────────────────
// There must be exactly one owner of the self-scheduling poll loop. Input
// submission paths may request an immediate refresh, but they must not create
// another recursive timer chain.
function createPollCoordinatorHost() {
  return {
    run: () => window.runPollCycle(),
    fastInterval: () => pollHost.POLL_FAST_INTERVAL_MS,
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (id) => clearTimeout(id),
  };
}
// Message sequence baselines now belong to message-probe.js (poll/SSE shared).

// Workspace revision baselines and refresh logic live in poll-maintenance.js.

// schedulePoll is provided by poll-coordinator-host.js after static ESM init.

// 发送成功等交互关键路径请求立即取数：poll() 自带 in-flight 合并（周期
// 在飞时记 _pollImmediateRequested，结束后 schedulePoll(0) 兜底），直接调
// 用即可，不会产生第二条递归定时链。
window.ClawFW = window.ClawFW || {};
window.ClawFW.requestImmediatePoll = function () {
  window.poll();
};

// ── SSE 全量对账钩子（§6.5 兜底闭环）────────────────────────────────
// 看门狗静默 30s、resync 帧（服务端重启 eid 归零 / 缓冲超界）、UDS 重连
// （connection{reconnected:true}）都经此触发一轮完整轮询：poll 的 SSE 分支
// 不拉 notification 等状态端点，对账能力只在全量形态存在。
window.ClawFW.forceFullPollOnce = function () {
  _forceFullPollNextCycle = true;
  window.poll();
};

// ── dev 计量（ADR-0012，默认关闭）──────────────────────────────────────────
// URL 带 ?msg_metrics=1 时，每次消息刷新输出 actualBytes（本周期 /messages
// 数据序列化字节，未发请求为 0）/ fakeFullBytes（假想全量字节，随 probe 下发）/
// savedRatio / changeKind / downgraded。这份数据是将来评估 SSE 的依据。



// poll and its private scheduling state live in poll-coordinator.js.

// Exposed for feature panel toggle: after IPC tool-state change, trigger a
// delayed poll so inspector refreshes from the agent subprocess.
function _scheduleInspectorRefresh(delayMs) {
  window.schedulePoll(delayMs || 300);
}

// ── poll 与 SSE 事件共用的消费函数（§5.2：事件到达路径与 fetch 路径走同一实现）──

function createRuntimeNotFoundHost() {
  return {
    isCurrent: (token) => isSessionViewTokenCurrent(token),
    clearCompact: (id) => {
      if (partialCompactInFlight && normalizeAgentIdentity(id) === normalizeAgentIdentity(partialCompactRuntimeId)) clearPartialCompactState();
    },
    switching: () => sessionSwitch.prebuiltSessionSwitchInFlight || sidebarUi.suppressSidebarRerender,
    schedule: (delay) => window.schedulePoll(delay),
    fastInterval: () => pollHost.POLL_FAST_INTERVAL_MS,
    interval: () => pollHost.POLL_INTERVAL_MS,
    sessionId: (id) => typeof getRuntimeWorkspaceSessionId === 'function' ? getRuntimeWorkspaceSessionId(id) : '',
    hostRecord: () => getCurrentHostAgentRecord(),
    thread: (id, session) => typeof window.getThreadForSession === 'function' ? window.getThreadForSession(id, session) : null,
    canRefreshThreads: () => typeof window.refreshThreads === 'function',
    refreshThreads: (force) => window.refreshThreads(force),
    activeConversation: () => window.ClawThreads?.activeConversation || null,
    runtimeRecord: (id) => window.getRuntimeRecord(id),
    fallback: (record) => window.resolveWorkspaceFallbackAgentId(record),
    patch: (token, patch, effect) => commitSessionViewPatch(token, patch, effect),
    emptyTodo: () => getEmptyTodoPlan(),
    clearView: (id, failed, fallback) => {
      callActivity._agentCallActive.delete(id);
      window.clearInterruptSuppression(id);
      if (failed) { failed.callActive = false; failed.connected = false; }
      setCurrentRuntimeAgentId(null);
      if (fallback) window.selectWorkspaceSurface(fallback, { skipFeaturePanel: true });
      else { setFocusedAgentId(null); setCurrentWorkspaceTab(null); window.renderCurrentMainView(); }
    },
    loadAgents: () => window.loadAgents(),
  };
}

// Classic rendering dependencies for the shared ESM poll/SSE message probe.
function createMessageProbeHost(createRenderer, createMetrics, bytes) {
  return {
    messages: () => currentMessages,
    isCurrent: (token) => isSessionViewTokenCurrent(token),
    commit: (token, patch, effect) => commitSessionViewPatch(token, patch, effect),
    fetch: (url) => window.fetch(url),
    attachTimestamps: (messages, timestamps) => attachMessagesTimestamps(messages, timestamps),
    bytes,
    metrics: createMetrics({
      search: () => String((window.location && window.location.search) || ''),
      debug: (...args) => console.debug(...args),
    }),
    render: createRenderer(createCommittedViewRendererHost()).renderMessages,
  };
}

// Narrow UI adapter; selection and update policy live in the ESM renderer.
function createCommittedViewRendererHost() {
  return {
    clearLoading: () => window.clearChatLoadingSession(),
    // ADR-0041: this legacy title trigger is intentionally a no-op.
    markTitle: (previous, next) => window.markAutoTitleCandidate(previous, next),
    firstChanged: (next, previous) => window.findFirstChangedMessageIndex(next, previous),
    workspaceSurface: () => window.shouldRenderWorkspaceSurface(),
    render: (current) => window.renderCurrentMainView(current),
    append: (messages, offset) => window.appendNewMessages(messages, offset),
    updateLast: (message) => window.updateLastMessage(message),
    reconcile: (messages) => {
      if (typeof window.ClawFW?.reconcileOptimisticUserEchoes === 'function') window.ClawFW.reconcileOptimisticUserEchoes(messages);
    },
    panel: () => activeFeaturePanel,
    renderPanel: () => window.renderFeaturePanel(),
    updateContext: (current) => { if (typeof window.updateChatContextBar === 'function') window.updateChatContextBar(current); },
    updateModel: () => { if (typeof window.updateInputModelSwitcher === 'function') window.updateInputModelSwitcher(); },
    updateThinking: () => { if (typeof window.updateThinkingEffortSwitcher === 'function') window.updateThinkingEffortSwitcher(); },
    updatePlanBadge: () => window.updatePlanBadge(),
    clearCompletedCompact: (token, requests) => {
      if (partialCompactInFlight && normalizeAgentIdentity(token.runtimeId) === normalizeAgentIdentity(partialCompactRuntimeId)
        && requests && requests.length > 0) clearPartialCompactState();
    },
    updateRollback: () => window.updateRollbackActionVisibility(),
    chatSurface: () => window.isChatSurfaceActive(),
    syncInput: (id) => window._syncPersistentInputUi(id),
  };
}

// Remaining classic normalization and UI dependencies for ESM metadata commits.
function createMetadataCommitHost(createRenderer) {
  return {
    inputCurrent: (token) => isSessionViewInputRequestsCurrent(token),
    commit: (token, patch, effect) => commitSessionViewPatch(token, patch, effect),
    normalizeOverview: (value) => normalizeOverviewSnapshot(value),
    overviewSignature: (value) => getOverviewSignature(value),
    normalizeTodo: (value) => normalizeTodoPlan(value),
    todoSignature: (value) => getTodoPlanSignature(value),
    currentOverviewSignature: () => currentOverviewSignature,
    currentTodoSignature: () => currentTodoPlanSignature,
    inputRequests: () => currentInputRequests,
    interruptTarget: () => window.getInterruptTargetId(),
    setInterruptTarget: (value) => window.setInterruptTargetId(value),
    now: () => Date.now(),
    lastInterruptAction: () => callActivity._lastInterruptUserActionAt,
    render: createRenderer(createCommittedViewRendererHost()).renderMetadata,
  };
}

function createPollMaintenanceHost() {
  return {
    agents: () => allAgents,
    focused: () => focusedAgentId,
    now: () => Date.now(),
    isPh: (record) => typeof window.isPhStyleWorkspaceAgent === 'function' && window.isPhStyleWorkspaceAgent(record),
    browsingTarget: (record) => typeof window.getPhBrowsingTarget === 'function' ? window.getPhBrowsingTarget(record) : null,
    workspaceState: (record) => typeof window.getAgentWorkspaceState === 'function' ? window.getAgentWorkspaceState(record) : null,
    fetch: (url) => window.fetch(url),
    isWorkspace: (record) => window.isWorkspaceHostUnit(record),
    detailLoaded: (id) => window.AgentLoaderHost.loadedAgentDetailIds.has(id),
    lastWorkspaceRefresh: () => window._lastWsSessionRefreshAt || 0,
    setWorkspaceRefresh: (value) => { window._lastWsSessionRefreshAt = value; },
    lastAgentRefresh: () => lastAgentListRefreshAt,
    setAgentRefresh: (value) => { setLastAgentListRefreshAt(value); },
    sseActive: () => typeof window.isSseActive === 'function' && window.isSseActive(),
    loadAgents: () => window.loadAgents(),
    refreshCalls: (agents) => window.refreshAgentCallStates(agents),
    isCurrent: (token) => isSessionViewTokenCurrent(token),
    patch: (token, patch, effect) => commitSessionViewPatch(token, patch, effect),
    commit: (token, effect) => commitSessionViewState(token, effect),
    apply: (patch) => applySessionViewPatch(patch),
    notify: (value) => window.updateNotificationStatus(value),
    merge: (previous, fresh, id) => typeof window.mergeWorkspaceSessionSnapshots === 'function'
      ? window.mergeWorkspaceSessionSnapshots(previous, fresh, id) : fresh,
    renderWorkspace: (record, allowSoftRefresh) => {
      if (typeof window.shouldRenderWorkspaceSurface === 'function' && window.shouldRenderWorkspaceSurface(record)) {
        if (allowSoftRefresh && record.id === 'work-group' && window.WorkGroupUI?.softRefresh) window.WorkGroupUI.softRefresh();
        else window.renderCurrentMainView();
      } else if (typeof window.updateChatContextBar === 'function') window.updateChatContextBar();
    },
    updateComposer: () => {
      if (typeof window.updateChatContextBar === 'function') window.updateChatContextBar();
      if (typeof window.updateInputModelSwitcher === 'function') window.updateInputModelSwitcher();
      if (typeof window.updateThinkingEffortSwitcher === 'function') window.updateThinkingEffortSwitcher();
    },
    panel: () => activeFeaturePanel,
    loadLogs: () => window.loadLogs(),
    normalizeHooks: (value) => normalizeHookInspector(value),
    hookSignature: (value) => getHookInspectorSignature(value),
    currentHookSignature: () => currentHookInspectorSignature,
    renderPanel: () => window.renderFeaturePanel(),
    saveCache: (id) => saveCurrentRuntimeToCache(id),
    trackRecap: () => window._trackRecapSessionPresence(),
  };
}

function createRuntimePollHost() {
  return {
    capture: () => captureSessionViewToken(),
    consumeForceFull: () => { const force = _forceFullPollNextCycle; _forceFullPollNextCycle = false; return force; },
    sseActive: () => typeof window.isSseActive === 'function' && window.isSseActive(),
    guard: (id, token) => window.refreshContextGuardStatus(id, token),
    status: (id, token) => window.refreshCurrentRuntimeStatus(id, token),
    refreshCalls: (agents, options) => window.refreshAgentCallStates(agents, options),
    agents: () => allAgents,
    commit: (token, effect) => commitSessionViewState(token, effect),
    isCurrent: (token) => isSessionViewTokenCurrent(token),
    syncInput: (id) => { window._syncPersistentActionButton(); window._syncPersistentInputUi(id); },
    title: (id) => { if (!window.isRuntimeCalling(id)) window.tryAutoTitleGeneration(currentMessages); },
    tail: (token) => window._runPollTailLowFrequency(token),
    schedule: (delay) => window.schedulePoll(delay),
    fastInterval: () => pollHost.POLL_FAST_INTERVAL_MS,
    interval: () => pollHost.POLL_INTERVAL_MS,
    fetch: (url) => window.fetch(url),
    notFound: (token) => window.handleCoreResponsesNotFound(token),
    messages: (token, probe) => window.runMessagesProbeCycle(token, probe),
    probe: (overview) => extractMessagesProbe(overview),
    metadata: (token, parts) => window.commitMetadataUpdate(token, parts),
  };
}

function createPollCycleHost() {
  return {
    switching: () => sessionSwitch.prebuiltSessionSwitchInFlight,
    schedule: (delay) => window.schedulePoll(delay),
    fastInterval: () => pollHost.POLL_FAST_INTERVAL_MS,
    interval: () => pollHost.POLL_INTERVAL_MS,
    sseActive: () => typeof window.isSseActive === 'function' && window.isSseActive(),
    now: () => Date.now(),
    lastChoiceCheck: () => pollHost.lastChoiceAlertCheckAt,
    setChoiceCheck: (value) => { pollHost.lastChoiceAlertCheckAt = value; },
    checkChoices: () => window.checkGlobalChoiceAlerts(),
    refreshRemote: () => {
      if (typeof window.maybeRefreshRemoteCatalog === 'function') window.maybeRefreshRemoteCatalog();
      if (typeof window.maybeRefreshRemoteHistory === 'function') window.maybeRefreshRemoteHistory();
    },
    templates: () => window.FEATURE_TEMPLATE_MAP,
    lastTemplateReload: () => pollHost.lastFeatureTemplateReloadAt,
    setTemplateReload: (value) => { pollHost.lastFeatureTemplateReloadAt = value; },
    reloadTemplates: () => window.reloadFeatureTemplateMap(),
    runtimeId: () => currentRuntimeAgentId,
    noFocus: () => window.refreshUnfocusedPoll(),
    runtime: () => window.runRuntimePoll(),
    warn: (...args) => console.warn(...args),
  };
}
// ── Input request rendering → modules/input-render.js ──


// ── Persistent Input (常驻输入框/队列) → modules/persistent-input.js (Phase B-4, 2026-07-04) ──

// ── Choice Input 卡片交互 → modules/choice-input.js (Phase A-2, 2026-07-03) ──

// ── Input helpers (rollback/process/submit) → modules/input-helpers.js (Phase B-5, 2026-07-04) ──

// ── Partial Compact / Rollback Dialog → modules/rollback-dialog.js (Phase A-6, 2026-07-03) ──

// ── Chat Message Rendering → modules/chat-renderer.js (Phase D, 2026-07-05) ──

// ── Voice Input / ASR → modules/voice-input.js (Phase A-1, 2026-07-03) ──

// _getSessionInputCacheKey retained here — shared by many domains (poll, input-render, etc.)
// Use the same immutable runtime-context identity as rendering and optimistic data.
function _getSessionInputCacheKey() {
  // 一致性校验（getActiveThreadInputTarget）：线程键只在当前视图确属该
  // 线程时使用——残留指向不得把别的会话的草稿写进线程键（会话隔离）。
  const threadId = String(window.getActiveThreadInputTarget?.()?.threadId || '').trim();
  return threadId ? `thread:${threadId}` : getRuntimeContextKey();
}

// ── agent-call-states 同步引擎 → modules/agent-call-states-engine.js ──
// P4 T2 收尾批次：原顶层 IIFE `bootstrapAgentCallStates` 已逐字搬出为 ESM 模块
// （B1：它在 classic 解析相调用 sidebar-render 的宿主工厂并读 runtime-status 的
// `_agentSuspended`，两者本批进模块相）。引擎实例、`agent-call-states` 桥键与
// `window.ClawFW.CallStates` 协议面不变。
//
// 本文件仍在**模块相之前**可用（它是 kernel-entry 之前求值的独立入口），可见性
// 监听器里的两条链路因此保持 typeof / null 守卫：引擎桥键由 kernel-entry 图在
// 本文件之后求值时才注册，`refreshCurrentRuntimeStatus` 同批（runtime-status-loader）
// 才注册。

// 首屏同步渲染（applyTheme → applyLanguage → 侧栏 / 面板 / 主视图）已迁到 ESM
// 时序：public/src/modules/boot.js（P4 时序切换，index.html 最后一条 module 标签）。
// 不要在此恢复顶层调用——它会抢在模块求值前渲染，把首屏链重新钉回 classic 相。

// When the page returns to foreground after being in a background tab,
// browser timer throttling may have caused us to miss state transitions.
// Force a full refresh to catch up.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  // Re-sync all agent calling states immediately（回前台是全量对账路径：
  // SSE 激活时本地条目也参与本轮对账，§5.3 includeSseLocals）。
  // 引擎实例在 kernel-entry 图里求值（本文件之后）：图求值完成前触达时
  // typeof 守卫跳过——与下方 currentRuntimeAgentId 的 null 不变量同款；
  // 模块就绪后的轮询事件自会补齐这一跳。
  if (typeof window.refreshAgentCallStates === 'function') {
    window.refreshAgentCallStates(allAgents, { force: true, includeSseLocals: true });
  }
  // Re-sync current runtime's notification status (button, status bar)
  // 不变量：启动事务（startApplication）在本监听器可触达之前尚未开始，
  // currentRuntimeAgentId 恒为初值 null，因此仅存在于 kernel-entry 图的
  // refreshCurrentRuntimeStatus 不会被裸调；runtimes 出现后它一定已注册。
  // 新增写入面必须重评该不变量（frontend-foreground-sync-owner 钉住）。
  if (currentRuntimeAgentId && typeof window.refreshCurrentRuntimeStatus === 'function') {
    window.refreshCurrentRuntimeStatus(currentRuntimeAgentId);
  }
});

function createApplicationStartupHost() {
  return {
    loadTemplates: () => window.loadFeatureTemplateMap(),
    loadAgents: () => window.loadAgents(),
    consumeDesktopOpen: async () => { if (window.ClawDesktopOpen) await window.ClawDesktopOpen.consumeBootOpenRequest(); },
    reloadTemplates: () => window.reloadFeatureTemplateMap(),
    loadMcp: (force) => window.loadMcpInfo(force),
    poll: () => window.poll(),
    log: (...args) => console.log(...args),
  };
}

// ─── 桥接期兼容面（domain `app-main`）─────────────────────────────────────
// 逐键消费面（grep public/ 核过，classic 裸标识符与 ESM 的 window.* 晚绑定同列）：
//   getCurrentAgentRecord            ← app-core / flow-editor（classic 裸调）+
//                                      identity / claw-host / session-ui / …（window）
//   getCurrentHostAgentRecord        ← chat-context-bar / session-view-state /
//                                      thread-store / input-model-switcher
//   getCurrentRuntimeRecord          ← app-ui / agent-data-loader / slash-* / git 面板
//   updateCurrentAgentChrome         ← i18n-environment-state / sidebar-render
//   isAgentActive / isRuntimeItemActive ← sidebar-render（条目高亮谓词）
//   groupConnectedAgents             ← sidebar-render / sidebar-layout
//   toEpochMs                        ← runtime-status（通知时间排序）
//   getInputSurfaceMode              ← input-composer / input-render / input-queue
//   markSessionLoading / markActionLoading / clearSessionLoading ← session-dialogs /
//                                      trim-page / workspace-actions / im-actions
//   applyOptimisticWorkspaceSession  ← workspace-actions
//   _getSessionInputCacheKey         ← input-composer / input-render / persistent-input /
//                                      recap-hint / voice-input / rollback-runtime
//   _scheduleInspectorRefresh        ← context-guard-toggle / debug-features-hooks /
//                                      slash-menu / session-controls
//   12 个 createXHost                ← kernel-entry 图的宿主模块（求值期取用，本批
//                                      的装载相位约束就落在这 12 个键上）
// 注销条件：上列消费方全部改具名 import（或随 T5 编排域收敛删除）后，逐键删除
// defineKey 并下调 .kernel-bridge-baseline.json；domain 随之注销。
export const bridgeApi = {
  getCurrentHostAgentRecord,
  getCurrentRuntimeRecord,
  getCurrentAgentRecord,
  updateCurrentAgentChrome,
  isAgentActive,
  groupConnectedAgents,
  isRuntimeItemActive,
  toEpochMs,
  getInputSurfaceMode,
  markSessionLoading,
  markActionLoading,
  clearSessionLoading,
  applyOptimisticWorkspaceSession,
  _getSessionInputCacheKey,
  _scheduleInspectorRefresh,
  createWorkspaceEntryHost,
  createWorkspaceSessionNavigationHost,
  createCompactResumeHost,
  createRuntimeSwitchHost,
  createPollCoordinatorHost,
  createRuntimeNotFoundHost,
  createMessageProbeHost,
  createMetadataCommitHost,
  createPollMaintenanceHost,
  createRuntimePollHost,
  createPollCycleHost,
  createApplicationStartupHost,
};
for (const [key, value] of Object.entries(bridgeApi)) {
  window.KernelState.defineKey('app-main', key, value);
}
window.KernelState.claim('app-main', {
  get: (key) => bridgeApi[key],
  set: (key, value) => { bridgeApi[key] = value; },
});

// ── 启动编排（auth 放行之后）────────────────────────────────────────────
// 保持未 await 的调用体（不是 top-level await）：`__clawAuthReady` 由 auth-client
// 在 DOMContentLoaded 后兑现，本模块求值时它必然仍未兑现（auth-client 的 module
// 入口排在 index.html 更前面，见文件头注），因此认证放行 → startApplication 的
// 顺序由 promise 链本身保证；`startApplication`
// 的桥键由 kernel-entry 图的 application-startup-host 在本文件之后注册，兑现发生
// 在 DOMContentLoaded 之后，调用时点必然已就位。写成 TLA 也不会死锁（2026-11-18
// 变异实测），但会推迟页面 load 事件——既有语义是 fire-and-forget，没有理由换。
(async () => {
  await window.__clawAuthReady;
  await window.startApplication();
})();
