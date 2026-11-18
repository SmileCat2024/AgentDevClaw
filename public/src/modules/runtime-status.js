/**
 * runtime-status.js — 运行时状态 / 通知系统（P4 T2 收尾批次：classic → ESM）
 *
 * 包含：
 * - 运行时快照构建与状态推导（domain AA helpers）
 * - 通知状态更新主逻辑 updateNotificationStatus（domain Z）
 * - 通知计时器刷新与对话区运行指示块
 *
 * 迁移归属（P4 T2 收尾批次，与 sidebar-render / agent-call-states-engine 同批）：
 * 本文件原为 classic，因 B4（`_agentSuspended` 只经 `createAgentCallStatesHost()`
 * 交给 classic 引擎）无法单独转换。本批把 call 状态引擎迁出 app-main 顶层 IIFE
 * 之后，本文件与 sidebar-render 一起进模块相，`_agentSuspended` 改具名导出供
 * sidebar-render 的 `createAgentCallStatesHost()` 直接 import（同一 Map 引用，
 * 无双存储）。
 *
 * 状态归属：
 *   - `currentRuntimeConnected` / `lastNotificationStatusPayload` /
 *     `lastRenderedNotificationRuntime` 的 owner 仍是 p2-w2-2-runtime-status-owner
 *     （P2 W2-2），本文件 import 活绑定并按需经 setter 写；
 *   - `_agentSuspended` 由本文件持有并导出（B4）；`_runtimeStatusMemory` /
 *     `_threadSidebarEntries` / `_notificationClockTimer` / `_contextGuardToastKey` /
 *     `_contextGuardPageLoadedAt` 收敛为模块私有；
 *   - 函数键分两类：生产仍 classic 的消费方（app-main / app-ui / 各 classic 宿主
 *     工厂）经 `runtime-status-api` 域桥键取用；仅测试消费的 helper 只作命名导出
 *     （不上桥，见文件末尾清单）。
 *
 * 求值面决策（为什么不 import chat-viewport / persistent-input / sidebar-operations
 * 等已迁模块的具名导出）：本模块由 kernel-entry 早期装载（agent-snapshot-loader-host
 * → sidebar-render → 本模块），把它们拉进静态图会把 chat / input / 侧栏操作域的
 * 模块相求值整体提前。这些键都已上桥（`chat-viewport` / `persistent-input-api` /
 * `input-queue` / `recap-hint` / `tool-progress` / `sidebar-operations` 域），
 * 本文件按桥接期语义用 `window.X` 晚绑定，收敛（改具名 import + 注销桥键）留给
 * T5 清零批次。
 */

// ─── ESM 依赖（状态 owner / 纯函数域 / 经典宿主适配面）───
import { t } from '../i18n.js';
import { escapeHtml } from './markdown-utils.js';
import { getCurrentLanguage } from './i18n-environment-state.js';
import { currentRuntimeAgentId } from './orchestration-state.js';
import { currentMessages } from './session-view-storage.js';
import { callActivity } from './p2-bootstrap-call-activity.js';
import {
  currentRuntimeConnected,
  lastNotificationStatusPayload,
  setLastNotificationStatusPayload,
  lastRenderedNotificationRuntime,
  setLastRenderedNotificationRuntime,
} from './p2-w2-2-runtime-status-owner.js';
import {
  getNotificationCallStartedAt,
  isInterruptSuppressed,
  clearInterruptSuppression,
} from './call-interrupt-host.js';
import { setPendingQueuedCount } from './p2-w2-3a-input-queue-state.js';
import { setLastCallFinishTime } from './p2-w2-3a-call-elapsed-state.js';
import { recapPendingTrigger, setRecapPendingTrigger } from './p2-w2-3a-recap-state.js';

// ─── 运行时状态变量 ───

// 三个跨文件状态键的 owner 在 p2-w2-2-runtime-status-owner（上面 import 的活绑定）。
// 注册行留在原位：桥键值域与初值（true / null / null）与撤桥前一致；owner 先
// claim、这里再 defineKey 时，KernelState 会把初值经 impl.set 送入域模块（同值，
// 无双存储）。初值语义见 kernel-state.js 头注释。
window.KernelState.defineKey('runtime-status', 'currentRuntimeConnected', true);
window.KernelState.defineKey('runtime-status', 'lastNotificationStatusPayload', null);
const _runtimeStatusMemory = new Map();
// 线程条目的页面内形状缓存（createdAt / 项目归属锚）。仅测试消费其重置语义，
// 故作命名导出、不上桥（生产读写全部在本文件内）。
export const _threadSidebarEntries = new Map();
window.KernelState.defineKey('runtime-status', '_lastRenderedNotificationRuntime', null);
let _notificationClockTimer = null;
let _contextGuardToastKey = '';
const _contextGuardPageLoadedAt = Date.now();

/**
 * 消费 /protoclaw/context_guard_status（session IPC）的返回体。保险丝的
 * 拦截动作（打断 + 退回排队消息）发生在 runtime 内；前端唯一的职责是在
 * trip 发生时给出一次 toast 提醒。输入框不禁用——过界后继续发送的开销
 * 由用户自负。
 */
function applyContextGuardStatus(payload, runtimeId = currentRuntimeAgentId) {
  const normalizedRuntimeId = window.normalizeAgentIdentity(runtimeId);
  if (!normalizedRuntimeId || normalizedRuntimeId !== window.normalizeAgentIdentity(currentRuntimeAgentId)) return;
  // 状态缓存转发：上边栏 badge（ContextGuardToggle）从此处获得 armed/阈值/
  // trip 数据（poll 主循环拉取的唯一收口）；toast 逻辑继续走下方 trip 分支。
  window.ContextGuardToggle?.applyStatus?.(payload, normalizedRuntimeId);
  const trip = payload && typeof payload === 'object' && payload.status && typeof payload.status === 'object'
    ? payload.status.trip : null;
  if (!trip || typeof trip !== 'object') return;
  // rotate 触发的 trip 由线程接力承载（前端有「上下文接力中…」既有提示），
  // 打断 toast 只属于 interrupt 态；mode 缺席（远程旧版）按 interrupt 提示。
  if (trip.mode === 'rotate') return;
  // 只提醒页面加载之后发生的 trip：刷新页面或切回已触发过的会话不再打扰。
  const tripAt = Number(trip.at);
  if (Number.isFinite(tripAt) && tripAt > 0 && tripAt < _contextGuardPageLoadedAt) return;
  const toastKey = `${normalizedRuntimeId}:${Number.isFinite(tripAt) && tripAt > 0 ? Math.round(tripAt) : 'trip'}`;
  if (_contextGuardToastKey === toastKey) return;
  _contextGuardToastKey = toastKey;

  const inputTokens = Number(trip.inputTokens);
  const thresholdTokens = Number(trip.thresholdTokens);
  const zh = getCurrentLanguage() === 'zh';
  const usage = Number.isFinite(inputTokens) && inputTokens > 0 && Number.isFinite(thresholdTokens) && thresholdTokens > 0
    ? `${inputTokens.toLocaleString()} / ${thresholdTokens.toLocaleString()} tokens`
    : '';
  window.ClawToast?.show?.({
    id: `context-guard-${normalizedRuntimeId}`,
    status: 'warning',
    title: zh ? '上下文已超过阈值，本轮已打断' : 'Context threshold exceeded — turn interrupted',
    description: zh
      ? `用量 ${usage}。机器唤醒已拦截，直到你发送下一条消息；建议通过精简 / 摘要 / 分支降低上下文，直接发送即视为批准继续（本次越界期间不再拦截，开销自负）。`
      : `Usage ${usage}. Machine wakeups are held until your next message; consider trimming, summarizing, or branching — sending anyway approves continuing for this overage (at your own cost).`,
    autoDismiss: 8000,
  });
}

// ─── 运行时快照构建 ───

export function buildSyntheticRuntimeEntry(prebuiltAgent) {
  const runtimeId = prebuiltAgent.runtime_session_id || prebuiltAgent.runtimeSessionId || '';
  if (!runtimeId) return null;
  if (prebuiltAgent.connected === false) return null;
  return {
    id: runtimeId,
    ownerId: prebuiltAgent.id,
    runtimeId,
    sessionId: prebuiltAgent.active_workspace_session_id || '',
    name: prebuiltAgent.active_workspace_display_name
      || prebuiltAgent.active_workspace_session_title
      || `${prebuiltAgent.name || prebuiltAgent.id} Runtime`,
    metaLabel: prebuiltAgent.active_workspace_session_title || '常驻运行时',
    status: prebuiltAgent.connected === false ? 'disconnected' : 'connected',
    source: 'managed-runtime',
    contextMenuEnabled: true,
    openDirectory: String(prebuiltAgent.active_workspace_session_dir || '').trim(),
    projectId: String(prebuiltAgent.active_workspace_session_project_id || '').trim(),
    createdAt: prebuiltAgent.created_at || null,
  };
}

function buildChildRuntimeEntry(runtimeAgent) {
  const runtimeId = runtimeAgent.runtime_session_id || runtimeAgent.runtimeSessionId || runtimeAgent.id || '';
  const ownerId = String(runtimeAgent.parent_id || '').trim();
  if (!runtimeId || !ownerId) return null;
  const mutation = typeof window.getSessionReplacementMutation === 'function'
    ? window.getSessionReplacementMutation(ownerId, runtimeAgent.active_workspace_session_id || '')
    : null;
  return {
    id: runtimeAgent.id || runtimeId,
    ownerId,
    runtimeId,
    sessionId: runtimeAgent.active_workspace_session_id || '',
    // 呈现归属 = 所属 APP（wire 的 sidebar_entry_id；缺席时即父 APP）。
    sidebarEntryId: String(runtimeAgent.sidebar_entry_id || '').trim() || ownerId,
    name: runtimeAgent.active_workspace_display_name
      || runtimeAgent.active_workspace_agent_name
      || runtimeAgent.active_workspace_session_title
      || runtimeAgent.name
      || runtimeId,
    metaLabel: runtimeAgent.active_workspace_session_title || runtimeAgent.name || '显式运行时',
    status: runtimeAgent.connected === false ? 'disconnected' : 'connected',
    source: runtimeAgent.source || 'external',
    contextMenuEnabled: true,
    createdAt: runtimeAgent.created_at || null,
    replacementMutation: mutation,
    // 会话绑定的项目目录（server 从 session index 附带），参与目录分组。
    openDirectory: String(runtimeAgent.open_directory || '').trim(),
    // 归属身份（ticket 044）：项目会话带非空 projectId，分组走项目身份
    // （resolveSidebarChildProjectGroup），openDirectory 不再参与其分组。
    projectId: String(runtimeAgent.project_id || runtimeAgent.projectId || '').trim(),
    sourceSessionId: String(runtimeAgent.source_session_id || '').trim(),
  };
}

function getSidebarOperationPendingName(operation) {
  // 线程宿主（coder）的 trim / summary 是线程内上下文接力，接续过程提示
  // 由顶栏「上下文接力中…」统一承载（用户要求：接续 UI 只留这一个），
  // 侧栏操作文案回归通用形态，不再特化。
  if (operation?.kind === 'branch') {
    return getCurrentLanguage() === 'zh' ? '正在创建分支…' : 'Creating branch…';
  }
  if (operation?.kind === 'trim') {
    return getCurrentLanguage() === 'zh' ? '正在生成精简会话…' : 'Creating trimmed session…';
  }
  if (operation?.kind === 'summary') {
    return getCurrentLanguage() === 'zh' ? '正在生成摘要会话…' : 'Creating summarized session…';
  }
  return getCurrentLanguage() === 'zh' ? '正在启动新会话…' : 'Starting new session…';
}

function getSidebarOperationFailureName(operation) {
  // A degraded target operation is reached only after the session mutation has
  // committed. Its failure describes the runtime startup, never session creation.
  if (operation?.kind === 'branch') {
    return getCurrentLanguage() === 'zh' ? '分支会话启动失败' : 'Branch session failed to start';
  }
  if (operation?.kind === 'trim') {
    return getCurrentLanguage() === 'zh' ? '精简会话启动失败' : 'Trimmed session failed to start';
  }
  if (operation?.kind === 'summary') {
    return getCurrentLanguage() === 'zh' ? '摘要会话启动失败' : 'Summarized session failed to start';
  }
  return getCurrentLanguage() === 'zh' ? '新会话启动失败' : 'New session failed to start';
}

export function collectRuntimeEntriesForPrebuilt(prebuiltAgent, agents) {
  const entries = [];
  const seenRuntimeIds = new Set();

  // Build sessionId → openDirectory map for project grouping (programming-helper).
  // Each runtime entry carries a sessionId; we resolve it to the session's
  // openDirectory so the sidebar can group runtimes by project.
  // We also cross-reference phProjects to pick up the correct-cased directory
  // path (sessions may store a lowercased path on Windows).
  const sessionDirMap = new Map();
  const hostAgentId = String(prebuiltAgent?.id || '').trim();

  // 待办标记：运行中会话条目按 sessionId 关联宿主会话索引的 todo 字段，
  // 侧栏据此渲染 pin。
  const sessionTodoMap = new Map();
  const sessionById = new Map();
  for (const session of Array.isArray(prebuiltAgent?.workspace_sessions?.sessions)
    ? prebuiltAgent.workspace_sessions.sessions : []) {
    if (session?.id) sessionById.set(String(session.id), session);
    if (session?.todo === true) {
      const todoSid = String(session?.id || '').trim();
      if (todoSid) sessionTodoMap.set(todoSid, window.SIDEBAR_TODO_COLORS.has(session.todoColor) ? session.todoColor : 'white');
    }
  }

  if (hostAgentId === 'programming-helper') {
    // PH 宿主：项目卡片目录大小写校正（sessions 可能存小写路径）。
    const phProjects = Array.isArray(prebuiltAgent?.workspace_state?.phProjects)
      ? prebuiltAgent.workspace_state.phProjects
      : [];
    const projectIdToDir = new Map();
    for (const project of phProjects) {
      const pid = String(project?.id || '').trim();
      const pdir = String(project?.openDirectory || '').trim();
      if (pid && pdir) projectIdToDir.set(pid, pdir);
    }
    const sessions = Array.isArray(prebuiltAgent?.workspace_sessions?.sessions)
      ? prebuiltAgent.workspace_sessions.sessions
      : [];
    for (const session of sessions) {
      const sid = String(session?.id || '').trim();
      const rawDir = String(session?.openDirectory || '').trim();
      if (!sid || !rawDir) continue;
      const projectId = 'dir:' + rawDir.replace(/\\/g, '/').toLowerCase();
      sessionDirMap.set(sid, projectIdToDir.get(projectId) || rawDir);
    }
  }

  const isWorkGroup = String(prebuiltAgent?.id || '').trim() === 'work-group';

  // Work-group: build sessionId → {chatId, chatName} map from workspace_state.gcChats.
  // Each group chat stores its admin's sessionId; we reverse-map so that when
  // we encounter a child runtime with that sessionId, we can group it under
  // the correct group chat.
  const wgSessionToChat = new Map();
  if (isWorkGroup) {
    const gcChats = Array.isArray(prebuiltAgent?.workspace_state?.gcChats)
      ? prebuiltAgent.workspace_state.gcChats
      : [];
    for (const chat of gcChats) {
      const sid = String(chat?.adminSessionId || '').trim();
      if (sid) {
        wgSessionToChat.set(sid, { chatId: chat.id, chatName: chat.name || chat.id });
      }
    }
  }

  const addEntry = (entry) => {
    if (!entry) return;
    if (!entry?.runtimeId) return;
    if (seenRuntimeIds.has(entry.runtimeId)) return;
    seenRuntimeIds.add(entry.runtimeId);
    const thread = threadBySessionId.get(String(entry.sessionId || '').trim());
    if (thread && (thread.archivedAt || thread.status === 'closed')) return;
    // 乐观退场：归档已提交、stop_agent 进行中的源 runtime 不再作为侧栏叶子
    // （operation 合成条目是操作反馈本身，不在此列）。
    if (typeof window.isRuntimeStopPending === 'function'
      && !String(entry.source || '').startsWith('operation-')
      && window.isRuntimeStopPending(entry.ownerId || hostAgentId, entry.sessionId, entry.runtimeId)) {
      return;
    }
    // Session-owned display fields come from the revisioned index, shared by
    // mutation receipts and list refreshes. Runtime/thread summaries only fill
    // an unloaded session; operation labels remain owned by the operation.
    const session = sessionById.get(String(entry.sessionId || '').trim());
    if (session && !String(entry.source || '').startsWith('operation-')) {
      const title = session.formId === 'assembly-form'
        ? (session.agentName || session.title)
        : session.title;
      if (title) entry.name = title;
      if (session.title) entry.metaLabel = session.title;
    }
    const entryTodoColor = sessionTodoMap.get(String(entry.sessionId || '').trim());
    entry.todo = entryTodoColor !== undefined;
    entry.todoColor = entryTodoColor || '';
    if (!entry.projectDir && !entry.projectKey) {
      // 分组身份统一经 resolveSidebarChildProjectGroup（project-data.js，
      // ticket 044）：项目会话（projectId）走独立项目身份组，目录会话按
      // sessionDirMap 校正后的目录分组——项目会话的 openDirectory 只是
      // 创建时记录，不参与分组。
      const identity = typeof window.resolveSidebarChildProjectGroup === 'function'
        ? window.resolveSidebarChildProjectGroup(entry, sessionDirMap)
        : null;
      if (identity) {
        if (identity.projectKey) entry.projectKey = identity.projectKey;
        if (identity.projectDir) entry.projectDir = identity.projectDir;
        if (identity.projectName) entry.projectName = identity.projectName;
      } else if (entry.openDirectory) {
        entry.projectDir = entry.openDirectory;
        entry.projectName = window.getPathLeaf(entry.openDirectory);
      }
    }
    if (typeof window.findSidebarOperation === 'function') {
      const operation = window.findSidebarOperation((item) => (
        item.agentId === hostAgentId
        && !['settled', 'failed'].includes(item.phase)
        && ((item.targetRuntimeId && item.targetRuntimeId === entry.runtimeId)
          || (item.targetSessionId && item.targetSessionId === entry.sessionId)
          || (['replacement', 'delete', 'archive-close'].includes(item.type)
            && ((item.sourceRuntimeId && item.sourceRuntimeId === entry.runtimeId)
              || (item.sourceSessionId && item.sourceSessionId === entry.sessionId))))
      ));
      if (operation) {
        entry.sidebarOperation = operation;
        if (!entry.projectDir && operation.projectDir) {
          entry.projectDir = operation.projectDir;
          entry.projectName = operation.projectName || window.getPathLeaf(operation.projectDir);
        }
      }
    }
    // Work-group: group by group chat via sessionId → chat mapping.
    if (isWorkGroup && !entry.projectName && entry.sessionId) {
      const chat = wgSessionToChat.get(entry.sessionId);
      if (chat) {
        entry.projectName = chat.chatName;
        entry.projectDir = chat.chatId;
      }
    }
    entries.push(entry);
  };

  // Add child entries first — they carry accurate createdAt from the viewer.
  // The synthetic entry is added last so that when it shares a runtimeId with
  // a child entry (which happens when pickPrimaryAgentRuntime selects the same
  // runtime as the prebuilt's primary), the child entry wins and its createdAt
  // is preserved instead of being shadowed by the synthetic's null createdAt.
  const childRuntimeIds = new Set();
  // Same-response thread projection for every host. Independent thread-board
  // polling is not an input to sidebar identity or presence.
  const hostThreadsById = new Map((prebuiltAgent.sidebar_threads || [])
    .filter((thread) => thread?.agentId === hostAgentId)
    .map((thread) => [thread.threadId, thread]));
  const isThreadHostApp = hostThreadsById.size > 0;
  const threadBySessionId = new Map();
  for (const thread of hostThreadsById.values()) {
    for (const sessionId of thread.sessionIds || []) {
      threadBySessionId.set(String(sessionId), thread);
    }
    if (thread.headSessionId) threadBySessionId.set(String(thread.headSessionId), thread);
  }
  // Live target sessions replace their operation placeholders in place.
  const childCoveredSessionIds = new Set();
  const expectedSidebarEntryId = String(prebuiltAgent?.id || '').trim();
  const childAgents = agents.filter((agent) => {
    if (agent.source === 'prebuilt') return false;
    if (String(agent.parent_id || '').trim() !== hostAgentId) return false;
    // sidebar_entry_id is the explicit presentation owner.
    const sidebarEntryId = String(agent.sidebar_entry_id || '').trim();
    if (sidebarEntryId && sidebarEntryId !== expectedSidebarEntryId) return false;
    return true;
  });
  // 线程条目按 threadId 键控（ADR-0024：稳定条目不随 successor 闪烁）：
  // 一条线程只呈现一个侧栏叶子，且只由当前 head 会话的 runtime 呈现。
  // 换代窗口内新旧 runtime 并存（旧 head 退役滞留 + successor 已上线）时，
  // 非 head 成员不渲染——否则同线程双条目并列，点击旧条目被解析到新
  // head，成为用户看到的生硬跳转。
  const renderedThreadIds = new Set();
  childAgents.forEach((agent) => {
    const runtimeId = String(agent.runtime_session_id || agent.runtimeSessionId || agent.id || '').trim();
    if (runtimeId) childRuntimeIds.add(runtimeId);
  });
  const runtimeEntries = childAgents.map(buildChildRuntimeEntry);
  const syntheticEntry = buildSyntheticRuntimeEntry(prebuiltAgent);
  if (syntheticEntry && !childRuntimeIds.has(syntheticEntry.runtimeId)) runtimeEntries.push(syntheticEntry);
  runtimeEntries.forEach((childEntry) => {
    if (!childEntry) return;
    const runtimeId = String(childEntry.runtimeId || '').trim();
    const coveredSessionId = String(childEntry.sessionId || '').trim();
    if (coveredSessionId) childCoveredSessionIds.add(coveredSessionId);
    if (isThreadHostApp && childEntry && coveredSessionId) {
      let thread = threadBySessionId.get(coveredSessionId);
      if (!thread) {
        // A successor may register before advanceHead commits its membership.
        // Match its persisted source session, never an arbitrary rotating thread:
        // an unrelated new conversation can start in the same workspace then.
        const sourceSessionId = String(childEntry.sourceSessionId || '').trim();
        thread = [...hostThreadsById.values()].find((candidate) => (
          candidate
          && sourceSessionId
          && String(candidate.headSessionId || '') === sourceSessionId
          && !candidate.archivedAt
          && candidate.status === 'rotating'
          && !candidate.deleting
          && Number(candidate.handoffStartedAt) > 0
        )) || null;
      }
      if (thread && (thread.archivedAt || thread.status === 'closed')) return;
      const threadAlive = !!thread;
      if (threadAlive && String(thread.headSessionId || '') !== coveredSessionId) {
        // 非 head 成员 runtime（head 已推进、本体待退役，或换代 successor
        // 尚未 commit）：不是侧栏叶子。
        return;
      }
      if (threadAlive) {
        childEntry.threadId = thread.threadId;
        // 条目名跟随 head 会话。ADR-0041：标题只认当前 head Session 的索引
        // 标题；线程记录自带的 title 是历史实现残留，不回退（否则换代后会
        // 停在创建时的标题，形成双真相）。
        const headTitle = String(thread.headSessionTitle || '').trim();
        childEntry.name = headTitle || String(childEntry.name || '').trim();
        childEntry.metaLabel = headTitle || String(childEntry.metaLabel || '').trim();
        // 保持线程排序锚，但存活 head 的归属必须按本次快照重新投影。
        // 分组缓存仅供下方接续空窗占位；回灌到 live child 会锁住首次误分组，
        // 连补齐 projectId、重启 runtime 或移动对话都无法纠正，直到刷新页面。
        const cached = _threadSidebarEntries.get(thread.threadId);
        if (cached?.entry) {
          childEntry.createdAt = cached.entry.createdAt ?? childEntry.createdAt;
        }
        _threadSidebarEntries.set(thread.threadId, { runtimeId, entry: childEntry });
        renderedThreadIds.add(thread.threadId);
      }
    }
    addEntry(childEntry);
  });
  if (isThreadHostApp) {
    // 以线程为锚（而非页面内存缓存）：缓存只提供条目形状记忆（createdAt /
    // 项目归属的稳定锚），缓存缺席（接续中途刷新页面）时占位由线程 wire
    // 事实合成——侧栏连续性不依赖页面存活时间。
    for (const [threadId, thread] of hostThreadsById) {
      if (thread.archivedAt || thread.status === 'closed') {
        _threadSidebarEntries.delete(threadId);
        continue;
      }
      // head runtime 已在上面渲染为本线程条目，无需补位。
      if (renderedThreadIds.has(threadId)) continue;
      const cached = _threadSidebarEntries.get(threadId);
      if (cached && seenRuntimeIds.has(cached.runtimeId)) continue;
      const handoffInProgress = thread.status === 'rotating' && Number(thread.handoffStartedAt) > 0 && !thread.deleting;
      const replacementPending = typeof window.findSidebarOperation === 'function'
        && Boolean(window.findSidebarOperation((operation) => operation?.agentId === hostAgentId
          && operation?.type === 'create'
          && operation?.phase !== 'settled'
          && ((cached?.entry && operation?.sourceSessionId === cached.entry.sessionId)
            || operation?.targetSessionId === thread.headSessionId)));
      // Only an explicit handoff/start operation owns a placeholder. Thread board
      // state and headRuntimeRunning come from an independent polling snapshot:
      // neither can recreate a runtime absent from the connected-agents snapshot.
      if (!handoffInProgress && !replacementPending) {
        _threadSidebarEntries.delete(threadId);
        continue;
      }
      // 交接占位：head runtime 尚未上线（退役窗口 / successor 启动中），
      // 线程条目保持原位呈现为断连过渡态，不闪失、不重复。
      addEntry(cached?.entry
        ? {
          ...cached.entry,
          status: 'disconnected',
          transitionPending: true,
        }
        : {
          id: `thread:${threadId}`,
          ownerId: hostAgentId,
          runtimeId: `thread:${threadId}`,
          sessionId: String(thread.headSessionId || ''),
          name: String(thread.headSessionTitle || '').trim()
            || (getCurrentLanguage() === 'zh' ? '新对话' : 'New conversation'),
          status: 'disconnected',
          source: 'thread-relay',
          contextMenuEnabled: false,
          projectId: String(thread.headProjectId || '').trim(),
          openDirectory: String(thread.headProjectDir || '').trim(),
          threadId,
          transitionPending: true,
        });
    }
  }

  // operation 按 agentId 归属（APP 级）——无并列身份后无需二次分流。
  const operations = typeof window.listSidebarOperations === 'function'
    ? window.listSidebarOperations((operation) => operation.agentId === hostAgentId)
    : [];
  for (const operation of operations) {
    if (['settled', 'failed'].includes(operation.phase)) continue;
    const sourceEntry = entries.find((entry) => (
      (operation.sourceRuntimeId && entry.runtimeId === operation.sourceRuntimeId)
      || (operation.sourceSessionId && entry.sessionId === operation.sourceSessionId)
    ));
    if (operation.type === 'delete') {
      // 删除进行中：源条目一律不再投影。ctx-menu 的乐观移除已表达退场，
      // 这里再标记/合成（sourceEntry.deleting / operation-tombstone）会在
      // 下个轮询周期把已消失的条目以「正在删除」形态重新投回（幽灵重现）；
      // 与服务端 list_sessions 的 in-flight 删除过滤同一语义。失败反馈由
      // 操作失败路径承担（alert + 轮询回填恢复条目）。
      if (sourceEntry) {
        const index = entries.indexOf(sourceEntry);
        if (index >= 0) entries.splice(index, 1);
      }
      continue;
    }
    if (operation.type === 'archive-close') {
      if (sourceEntry) {
        sourceEntry.sidebarOperation = operation;
        sourceEntry.contextMenuEnabled = false;
        if (!sourceEntry.projectDir && operation.projectDir) {
          sourceEntry.projectDir = operation.projectDir;
          sourceEntry.projectName = operation.projectName || window.getPathLeaf(operation.projectDir);
        }
      } else if (operation.sourceRuntimeId && !['degraded'].includes(operation.phase)) {
        addEntry({
          id: `operation:${operation.operationId}`,
          ownerId: hostAgentId,
          runtimeId: operation.sourceRuntimeId,
          sessionId: operation.sourceSessionId,
          name: operation.title || operation.sourceSessionId,
          status: 'pending',
          source: 'operation-tombstone',
          contextMenuEnabled: false,
          sidebarOperation: operation,
          projectId: operation.projectId,
          projectDir: operation.projectDir,
          projectName: operation.projectName,
          createdAt: new Date(operation.startedAt).toISOString(),
        });
      }
      continue;
    }

    // Only operations that can create or start a target runtime get a synthetic
    // sidebar item. Archive, unarchive, and history-only delete operations mutate
    // existing records; rendering them as pending runtimes creates phantom sessions.
    const createsTargetRuntime = operation.type === 'replacement' || operation.type === 'create' || operation.type === 'activate';
    if (!createsTargetRuntime) continue;
    // Programming-helper groups every runtime by project. Its operation creator
    // must provide this identity explicitly; never infer it from a current or
    // historical session, because either can belong to another project.
    // 项目会话的操作带 projectId（ticket 044），与 projectDir 同为合法身份。
    if (hostAgentId === 'programming-helper' && !operation.projectDir && !operation.projectId) continue;

    // A thread succession replaces the current conversation head in place.
    // Do not project its trim/summary operation as a second pending session row;
    // the thread entry remains the sole sidebar identity throughout the handoff.
    const isThreadSuccession = hostAgentId === 'programming-helper'
      && operation.phase !== 'degraded'
      && ['trim', 'summary'].includes(operation.kind)
      && [...hostThreadsById.values()].some((thread) => (
        thread.headSessionId === operation.sourceSessionId
      ));
    if (isThreadSuccession) continue;

    if (operation.phase === 'degraded' && (!sourceEntry || operation.type !== 'replacement')) {
      addEntry({
        id: `operation:${operation.operationId}`,
        ownerId: hostAgentId,
        runtimeId: `operation:${operation.operationId}`,
        sessionId: operation.targetSessionId || operation.sourceSessionId,
        name: getSidebarOperationFailureName(operation),
        status: 'disconnected',
        source: 'operation-degraded',
        contextMenuEnabled: false,
        pendingOperation: true,
        sidebarOperation: operation,
        projectId: operation.projectId,
        projectDir: operation.projectDir,
        projectName: operation.projectName,
        createdAt: new Date(operation.startedAt).toISOString(),
      });
      continue;
    }

    const pendingPhase = ['requested', 'committing', 'generating', 'target-starting'].includes(operation.phase);
    if (!pendingPhase) continue;
    // In-place handover: a live child runtime already presenting the target
    // session replaces the placeholder. Without this check the echo frame
    // renders both entries; with an early settle it renders neither.
    const coveredTargetSessionId = String(operation.targetSessionId || '').trim();
    if (coveredTargetSessionId && childCoveredSessionIds.has(coveredTargetSessionId)) continue;
    const isReplacement = operation.type === 'replacement';
    const pendingName = getSidebarOperationPendingName(operation);
    addEntry({
      id: `operation:${operation.operationId}`,
      ownerId: hostAgentId,
      runtimeId: `operation:${operation.operationId}`,
      sessionId: operation.targetSessionId || operation.sourceSessionId,
      name: pendingName,
      status: 'pending',
      source: 'operation-pending',
      contextMenuEnabled: false,
      pendingReplacement: isReplacement,
      pendingOperation: true,
      sidebarOperation: operation,
      projectId: operation.projectId,
      projectDir: operation.projectDir,
      projectName: operation.projectName,
      createdAt: new Date(operation.startedAt).toISOString(),
    });
  }

  entries.sort((a, b) => window.toEpochMs(b.createdAt) - window.toEpochMs(a.createdAt));

  return entries;
}

export function isRuntimeCalling(runtimeId) {
  return window.normalizeAgentIdentity(runtimeId) !== '' && callActivity._agentCallActive.get(runtimeId) === true;
}

// ADR-0019：回合挂起（等待后台任务唤醒）聚合，与 _agentCallActive 同构
// （poll 聚合 + 聚焦 runtime notification 即时维护），供侧栏指示灯消费。
// 挂起事实源是 server runtime.lastOutcome（挂起 outcome 跨 poll 持久），
// 下一个 call 开始后 calling 优先覆盖显示。
// B4：call 状态引擎（modules/agent-call-states-engine.js）经 sidebar-render 的
// createAgentCallStatesHost() 按引用取用本 Map —— 同一容器，不复制。
export const _agentSuspended = new Map();

export function isSuspendedNotificationPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const stateType = String(payload.state?.type || '').trim();
  if (stateType === 'call.finish' && isSuspendedCallOutcome(payload.state?.data)) return true;
  if (stateType === 'call.start') return false;
  return isSuspendedCallOutcome(payload.runtime?.lastOutcome);
}

export function isRuntimeSuspended(runtimeId) {
  return window.normalizeAgentIdentity(runtimeId) !== '' && _agentSuspended.get(runtimeId) === true;
}

export function isSidebarRuntimeDisconnected(entry) {
  // A degraded sidebar operation can describe cleanup of a different runtime
  // (for example, the archived source of a ready replacement). Transport state
  // must come from the entry itself, not from the attached operation.
  return entry?.status === 'disconnected';
}

export function resolveNotificationCallingState(notifData) {
  if (notifData?.runtime && notifData.runtime.callActive !== undefined) {
    return notifData.runtime.callActive === true;
  }
  const stateType = String(notifData?.state?.type || '').trim();
  if (stateType === 'call.start') {
    return true;
  }
  if (stateType === 'call.finish') {
    return false;
  }
  if (notifData?.callActive !== undefined) {
    return notifData.callActive === true;
  }
  if (stateType === 'llm.complete') {
    return false;
  }
  return notifData?.callActive === true;
}

export function normalizeNotificationRuntimeSnapshot(runtime) {
  return {
    stage: typeof runtime?.stage === 'string' ? runtime.stage : 'idle',
    callActive: runtime?.callActive === true,
    charCount: typeof runtime?.charCount === 'number' ? runtime.charCount : 0,
    thinkingChars: typeof runtime?.thinkingChars === 'number' ? runtime.thinkingChars : 0,
    contentChars: typeof runtime?.contentChars === 'number' ? runtime.contentChars : 0,
    toolCallCount: typeof runtime?.toolCallCount === 'number' ? runtime.toolCallCount : 0,
    activeToolNames: Array.isArray(runtime?.activeToolNames) ? runtime.activeToolNames.map((item) => String(item || '')).filter(Boolean) : [],
    activeToolCount: typeof runtime?.activeToolCount === 'number' ? runtime.activeToolCount : 0,
    streamToolNames: Array.isArray(runtime?.streamToolNames) ? runtime.streamToolNames.map((item) => String(item || '')).filter(Boolean) : [],
    callStartedAt: typeof runtime?.callStartedAt === 'number' ? runtime.callStartedAt : 0,
    stageStartedAt: typeof runtime?.stageStartedAt === 'number' ? runtime.stageStartedAt : 0,
    retryAttempt: typeof runtime?.retryAttempt === 'number' ? runtime.retryAttempt : undefined,
    maxRetries: typeof runtime?.maxRetries === 'number' ? runtime.maxRetries : undefined,
    nextRetryDelayMs: typeof runtime?.nextRetryDelayMs === 'number' ? runtime.nextRetryDelayMs : undefined,
    updatedAt: typeof runtime?.updatedAt === 'number' ? runtime.updatedAt : 0,
    lastErrorType: typeof runtime?.lastErrorType === 'string' ? runtime.lastErrorType : null,
    lastErrorMessage: typeof runtime?.lastErrorMessage === 'string' ? runtime.lastErrorMessage : null,
    lastOutcome: runtime?.lastOutcome && typeof runtime.lastOutcome === 'object' ? runtime.lastOutcome : null,
  };
}

export function getRuntimeStageLabel(runtime) {
  // ADR-0019：挂起的 stage 归一化为 completed，按 suspended 标志区分文案
  if (runtime.suspended && runtime.stage === 'completed') {
    return getCurrentLanguage() === 'zh' ? '等待后台任务' : 'Waiting for Background Tasks';
  }
  switch (runtime.stage) {
    case 'llm_thinking':
      return t('phase_thinking');
    case 'llm_content':
      return t('phase_content');
    case 'llm_tool_call_building':
      return t('phase_tool_calling');
    case 'tool_executing':
      return t('phase_tool_executing');
    case 'retry_waiting':
      return t('phase_retry_waiting');
    case 'retry_requesting':
      return t('phase_retry_requesting');
    case 'awaiting_runtime':
      return t('phase_processing');
    case 'completed':
      return t('phase_completed');
    case 'failed':
      return t('phase_failed');
    case 'cancelled':
      return t('phase_cancelled');
    default:
      return runtime.callActive ? t('phase_processing') : '';
  }
}

export function getCompactRuntimeLabel(runtime, isConnected = true) {
  if (!isConnected) {
    return t('runtime_status_disconnected');
  }
  if (runtime.stage === 'llm_thinking') {
    return runtime.thinkingChars > 0
      ? `${getCurrentLanguage() === 'zh' ? '思考' : 'Thinking'} ${formatRuntimeCompactNumber(runtime.thinkingChars)} ${t('runtime_unit_chars')}`
      : (getCurrentLanguage() === 'zh' ? '思考中' : 'Thinking');
  }
  if (runtime.stage === 'llm_content') {
    const outputCount = runtime.contentChars || runtime.charCount;
    return outputCount > 0
      ? `${getCurrentLanguage() === 'zh' ? '生成' : 'Generating'} ${formatRuntimeCompactNumber(outputCount)} ${t('runtime_unit_chars')}`
      : (getCurrentLanguage() === 'zh' ? '生成中' : 'Generating');
  }
  if (runtime.stage === 'llm_tool_call_building') {
    const toolSummary = summarizeRuntimeToolNames(runtime.streamToolNames || []);
    if (toolSummary) {
      return `${getCurrentLanguage() === 'zh' ? '准备工具' : 'Preparing Tools'} · ${toolSummary}`;
    }
    return getCurrentLanguage() === 'zh' ? '准备工具' : 'Preparing Tools';
  }
  if (runtime.stage === 'tool_executing') {
    const toolSummary = summarizeRuntimeToolNames(runtime.activeToolNames);
    return toolSummary
      ? `${getCurrentLanguage() === 'zh' ? '执行工具' : 'Running Tools'} · ${toolSummary}`
      : (getCurrentLanguage() === 'zh' ? '执行工具' : 'Running Tools');
  }
  if (runtime.stage === 'retry_waiting') {
    return formatRetryStatusLabel(runtime) || (getCurrentLanguage() === 'zh' ? '重试等待' : 'Retry Waiting');
  }
  if (runtime.stage === 'retry_requesting') {
    return formatRetryStatusLabel(runtime) || (getCurrentLanguage() === 'zh' ? '重新请求' : 'Retrying');
  }
  if (runtime.stage === 'failed') {
    return getCurrentLanguage() === 'zh' ? '请求失败' : 'Failed';
  }
  if (runtime.stage === 'cancelled') {
    return getCurrentLanguage() === 'zh' ? '已停止' : 'Stopped';
  }
  if (runtime.suspended && runtime.stage === 'completed') {
    return getCurrentLanguage() === 'zh' ? '等待后台任务' : 'Waiting for Background Tasks';
  }
  if (runtime.stage === 'completed') {
    return getCurrentLanguage() === 'zh' ? '已完成' : 'Done';
  }
  if (runtime.callActive) {
    // 判定与对话区指示器（buildRuntimeIndicatorContent）保持同一数据源：
    // 只有消息视角确有未完成的 tool call 才显示"等待工具结果"。
    // toolCallCount 是整个 call 期间的累计值（工具全部完成后也不清零），
    // 用它判定会把"等下一轮模型响应"误显示为"等待工具结果"。
    if (runtime.activeToolCount > 0) {
      const toolSummary = summarizeRuntimeToolNames(runtime.activeToolNames);
      return toolSummary
        ? `${getCurrentLanguage() === 'zh' ? '执行工具' : 'Running Tools'} · ${toolSummary}`
        : (getCurrentLanguage() === 'zh' ? '执行工具' : 'Running Tools');
    }
    if (getPendingToolCallsFromMessages().length > 0) {
      return getCurrentLanguage() === 'zh' ? '等待工具结果' : 'Waiting for Tools';
    }
    return t('runtime_status_waiting_model');
  }
  return '';
}

export function formatRuntimeCompactNumber(value) {
  if (!Number.isFinite(value)) return '0';
  return Number(value).toLocaleString();
}

// 重试期间状态文案：等待响应 · 第 n/m 次重试中（llm.retry 通知经 overview
// 镜像到 runtime snapshot，normalize 层已保留 retryAttempt/maxRetries）。
// attempt 数据缺失（旧 runtime 未推送）返回空串，由调用方回退既有文案。
function formatRetryStatusLabel(runtime) {
  const attempt = typeof runtime?.retryAttempt === 'number' ? runtime.retryAttempt : undefined;
  if (attempt === undefined) return '';
  const max = typeof runtime?.maxRetries === 'number' ? runtime.maxRetries : undefined;
  const attemptPart = max !== undefined
    ? `${attempt}/${max}`
    : String(attempt);
  return getCurrentLanguage() === 'zh'
    ? `等待响应 · 第 ${attemptPart} 次重试中`
    : `Waiting · Retry ${attemptPart}`;
}

export function formatRuntimeDuration(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  const totalSeconds = Math.floor(safeMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `${hours}h ${restMinutes}m`;
}

// 中文语境下的口语化时长（"12 秒" / "1 分 5 秒" / "1 小时 5 分"）
function formatRuntimeDurationZh(ms) {
  const totalSeconds = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${minutes} 分 ${seconds} 秒`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

/**
 * 当前步骤的用时（基于 stageStartedAt，与顶栏计时同口径）。
 * 主行文案已包含阶段描述（思考/生成/执行…），这里只返回时长本身，避免重复。
 */
function getRuntimeStepElapsedLabel(runtime) {
  if (!runtime || runtime.stageStartedAt <= 0) return '';
  const elapsedMs = Date.now() - runtime.stageStartedAt;
  return getCurrentLanguage() === 'zh'
    ? formatRuntimeDurationZh(elapsedMs)
    : formatRuntimeDuration(elapsedMs);
}

export function summarizeRuntimeToolNames(toolNames) {
  const normalized = Array.isArray(toolNames)
    ? toolNames.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (normalized.length <= 2) {
    return normalized.join(', ');
  }
  const visible = normalized.slice(0, 2).join(', ');
  const remaining = normalized.length - 2;
  return getCurrentLanguage() === 'zh'
    ? `${visible} +${remaining}个`
    : `${visible} +${remaining}`;
}

export function getPendingToolCallsFromMessages(messages = currentMessages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }
  const completedToolCallIds = new Set(
    messages
      .filter((msg) => msg?.role === 'tool' && msg?.toolCallId)
      .map((msg) => String(msg.toolCallId))
  );

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const msg = messages[index];
    if (!Array.isArray(msg?.toolCalls) || msg.toolCalls.length === 0) {
      continue;
    }
    const pendingCalls = msg.toolCalls.filter((call) => !completedToolCallIds.has(String(call?.id || '')));
    if (pendingCalls.length > 0) {
      return pendingCalls;
    }
  }
  return [];
}

function isSuspendedCallOutcome(data) {
  return !!(data && typeof data === 'object'
    && String(data.status || '').trim() === 'continued'
    && String(data.reason || '').trim() === 'suspended');
}

export function getDerivedStageFromState(stateType = '', stateData = null, currentStage = 'idle') {
  if (stateType === 'call.start') return 'awaiting_runtime';
  if (stateType === 'call.finish') {
    // 结构化终态：failed / cancelled / completed（continued 由续接机制继续跑）
    const status = String(stateData?.status || '').trim();
    if (status === 'failed') return 'failed';
    if (status === 'cancelled') return 'cancelled';
    return 'completed';
  }
  if (stateType === 'tool.start') return 'tool_executing';
  if (stateType === 'tool.complete') return currentStage === 'tool_executing' ? 'awaiting_runtime' : currentStage;
  if (stateType === 'llm.char_count') {
    const phase = String(stateData?.phase || '').trim();
    if (phase === 'thinking') return 'llm_thinking';
    if (phase === 'content') return 'llm_content';
    if (phase === 'tool_calling') return 'llm_tool_call_building';
  }
  if (stateType === 'llm.complete') {
    return currentStage === 'tool_executing' ? 'tool_executing' : 'awaiting_runtime';
  }
  return currentStage;
}

export function getNotificationActionSource(notifData) {
  const state = notifData?.state && typeof notifData.state === 'object' ? notifData.state : null;
  const event = notifData?.event && typeof notifData.event === 'object' ? notifData.event : null;
  if (event && (!state || (Number(event.timestamp) || 0) >= (Number(state.timestamp) || 0))) {
    return event;
  }
  return state;
}

function getEffectiveRuntimeSnapshot(notifData, options = {}) {
  const suppressCalling = options?.suppressCalling === true;
  const runtime = normalizeNotificationRuntimeSnapshot(notifData?.runtime);
  const nextCalling = suppressCalling ? false : resolveNotificationCallingState(notifData);
  const runtimeId = window.normalizeAgentIdentity(currentRuntimeAgentId) || 'none';
  const identity = typeof window.getCurrentSessionViewIdentity === 'function' ? window.getCurrentSessionViewIdentity() : null;
  const runtimeStatusKey = JSON.stringify([runtimeId, identity?.agentId || '', identity?.sessionId || '']);
  const actionSource = getNotificationActionSource(notifData);
  const stateType = String(actionSource?.type || '').trim();
  const stateData = actionSource?.data && typeof actionSource.data === 'object'
    ? actionSource.data
    : null;
  const remembered = _runtimeStatusMemory.get(runtimeStatusKey) || null;

  if (suppressCalling) {
    runtime.callActive = false;
  }

  if (nextCalling) {
    runtime.callActive = true;
  }

  if (stateType === 'llm.char_count' && stateData) {
    if (typeof stateData.charCount === 'number') {
      runtime.charCount = stateData.charCount;
    }
    if (typeof stateData.toolCallCount === 'number') {
      runtime.toolCallCount = stateData.toolCallCount;
    }
    const phase = String(stateData.phase || '').trim();
    if (phase === 'thinking' && typeof stateData.charCount === 'number') {
      runtime.thinkingChars = stateData.charCount;
    }
    if (phase === 'content' && typeof stateData.charCount === 'number') {
      runtime.contentChars = stateData.charCount;
    }
    if (Array.isArray(stateData.streamToolNames)) {
      runtime.streamToolNames = stateData.streamToolNames.map((n) => String(n || '')).filter(Boolean);
    }
  }

  const derivedStage = getDerivedStageFromState(stateType, stateData, runtime.stage);
  // ADR-0019：status=continued + reason=suspended = 回合挂起（等待后台任务唤醒），
  // 与 checkpoint 段切分的 continued 区分。call.finish 载荷（data 即 CallOutcome）
  // 与 runtime.lastOutcome 任一命中即置位；展示 stage 统一映射为 completed，
  // 由 label 层据此显示"等待后台任务"而非"已完成"。calling 中强制非挂起：
  // lastOutcome 跨 call 持久（worker 在 call.start 不清理），唤醒轮运行全程
  // 快照里仍是旧挂起值，不豁免的话收尾窗口（stage=completed + callActive）
  // 会误报挂起。
  runtime.suspended = !runtime.callActive
    && ((stateType === 'call.finish' && isSuspendedCallOutcome(stateData))
      || isSuspendedCallOutcome(runtime.lastOutcome));
  const runtimeAlreadyExpressive = runtime.stage !== 'idle'
    && runtime.stage !== 'completed'
    && runtime.stage !== 'failed'
    && runtime.stage !== 'cancelled';
  const shouldUseDerivedStage = !runtimeAlreadyExpressive
    || runtime.stage === 'awaiting_runtime'
    || runtime.updatedAt <= 0;
  if (shouldUseDerivedStage && derivedStage && derivedStage !== 'idle') {
    runtime.stage = derivedStage;
  }

  if (runtime.callActive && (runtime.stage === 'idle' || runtime.stage === 'completed' || runtime.stage === 'failed' || runtime.stage === 'cancelled')) {
    runtime.stage = 'awaiting_runtime';
  }

  const pendingToolCalls = getPendingToolCallsFromMessages();
  if (runtime.callActive && pendingToolCalls.length > 0) {
    runtime.toolCallCount = Math.max(runtime.toolCallCount || 0, pendingToolCalls.length);
    if (!Array.isArray(runtime.activeToolNames) || runtime.activeToolNames.length === 0) {
      runtime.activeToolNames = pendingToolCalls
        .map((call) => String(call?.name || '').trim())
        .filter(Boolean);
      runtime.activeToolCount = runtime.activeToolNames.length;
    }
    if (runtime.stage === 'awaiting_runtime' || runtime.stage === 'idle') {
      runtime.stage = runtime.activeToolCount > 0 ? 'tool_executing' : 'awaiting_runtime';
    }
  }

  // llm.complete 且无 pending tool calls：call 即将结束，不要显示 awaiting_runtime
  if (stateType === 'llm.complete' && pendingToolCalls.length === 0 && runtime.callActive) {
    runtime.stage = 'completed';
  }

  const rememberedHadToolPhase = remembered
    && (remembered.stage === 'tool_executing'
      || remembered.stage === 'llm_tool_call_building'
      || remembered.toolCallCount > 0);
  const currentHasToolSignals = runtime.toolCallCount > 0
    || runtime.activeToolCount > 0
    || runtime.stage === 'tool_executing'
    || runtime.stage === 'llm_tool_call_building';
  if (runtime.callActive
    && runtime.stage === 'awaiting_runtime'
    && (currentHasToolSignals || rememberedHadToolPhase)) {
    runtime.stage = runtime.activeToolCount > 0 ? 'tool_executing' : 'awaiting_runtime';
  }

  if (remembered && runtime.callStartedAt <= 0 && remembered.callStartedAt > 0) {
    runtime.callStartedAt = remembered.callStartedAt;
  }
  if (runtime.callActive && runtime.callStartedAt <= 0) {
    runtime.callStartedAt = remembered?.callStartedAt || runtime.updatedAt || Date.now();
  }

  if (remembered && runtime.stageStartedAt <= 0 && remembered.stage === runtime.stage && remembered.stageStartedAt > 0) {
    runtime.stageStartedAt = remembered.stageStartedAt;
  }
  if (runtime.stageStartedAt <= 0) {
    runtime.stageStartedAt = remembered?.stage === runtime.stage
      ? (remembered.stageStartedAt || runtime.updatedAt || Date.now())
      : (runtime.updatedAt || Date.now());
  }

  if (!runtime.callActive && stateType === 'call.finish') {
    // 结构化终态为权威事实：按 outcome.status 落定，而非默认 completed
    const status = String(stateData?.status || '').trim();
    runtime.stage = status === 'failed' || status === 'cancelled' ? status : 'completed';
  }
  // 静默轮询可能只有 lastOutcome，没有 call.finish 事件；worker 对 continued
  // 仍保留 cancelled stage。挂起是等待而非取消，统一映射为等待态的展示阶段。
  if (runtime.suspended) runtime.stage = 'completed';

  if (runtime.callActive) {
    _runtimeStatusMemory.set(runtimeStatusKey, {
      callStartedAt: runtime.callStartedAt,
      stage: runtime.stage,
      stageStartedAt: runtime.stageStartedAt,
      toolCallCount: runtime.toolCallCount,
    });
  } else if (runtime.stage === 'completed' || runtime.stage === 'failed' || runtime.stage === 'cancelled') {
    _runtimeStatusMemory.set(runtimeStatusKey, {
      callStartedAt: runtime.callStartedAt || remembered?.callStartedAt || Date.now(),
      stage: runtime.stage,
      stageStartedAt: runtime.stageStartedAt || remembered?.stageStartedAt || Date.now(),
      toolCallCount: runtime.toolCallCount,
    });
  } else {
    _runtimeStatusMemory.delete(runtimeStatusKey);
  }
  return runtime;
}

export function getRuntimeSummary(runtime, isConnected = true) {
  if (!isConnected) {
    return t('runtime_status_disconnected');
  }
  if (runtime.stage === 'llm_thinking') {
    return t('runtime_status_thinking_active');
  }
  if (runtime.stage === 'llm_content') {
    return t('runtime_status_streaming_active');
  }
  if (runtime.stage === 'llm_tool_call_building') {
    const toolSummary = summarizeRuntimeToolNames(runtime.streamToolNames || []);
    return toolSummary
      ? `${t('runtime_status_building_tools')} · ${toolSummary}`
      : t('runtime_status_building_tools');
  }
  if (runtime.stage === 'tool_executing') {
    const toolSummary = summarizeRuntimeToolNames(runtime.activeToolNames);
    return toolSummary
      ? `${t('runtime_status_executing_tools')} · ${toolSummary}`
      : t('runtime_status_executing_tools');
  }
  if (runtime.stage === 'retry_waiting') {
    return t('runtime_status_retry_waiting');
  }
  if (runtime.stage === 'retry_requesting') {
    return t('runtime_status_retry_requesting');
  }
  if (runtime.stage === 'failed') {
    return runtime.lastErrorMessage || t('runtime_status_failed');
  }
  if (runtime.stage === 'cancelled') {
    return t('runtime_status_cancelled');
  }
  if (runtime.suspended && runtime.stage === 'completed') {
    return getCurrentLanguage() === 'zh' ? '等待后台任务，任务完成后将继续' : 'Waiting for background tasks to continue';
  }
  if (runtime.stage === 'completed') {
    return t('runtime_status_completed');
  }
  if (runtime.callActive) {
    // 与 getCompactRuntimeLabel / buildRuntimeIndicatorContent 相同的判定源：
    // 消息视角确有未完成的 tool call 才算"等待工具结果"。
    if (runtime.activeToolCount === 0 && getPendingToolCallsFromMessages().length > 0) {
      return t('runtime_status_waiting_tool_results');
    }
    if (runtime.charCount === 0 && runtime.contentChars === 0 && runtime.thinkingChars === 0) {
      return t('runtime_status_waiting_model');
    }
    const freshnessMs = runtime.updatedAt > 0 ? Math.max(0, Date.now() - runtime.updatedAt) : 0;
    if (freshnessMs >= 8000) {
      return t('runtime_status_stale');
    }
    return t('runtime_status_processing');
  }
  return '';
}

export function getRuntimeTimerLabel(runtime) {
  const now = Date.now();
  if (runtime.stageStartedAt > 0) {
    return formatRuntimeDuration(now - runtime.stageStartedAt);
  }
  return '0s';
}

function renderRuntimeTimer(runtime, isConnected = true) {
  const toneClass = !isConnected || runtime.stage === 'failed' ? 'alert' : '';
  return `<span class="notification-metric ${toneClass}"><span class="notification-metric-value">${escapeHtml(getRuntimeTimerLabel(runtime))}</span></span>`;
}

function refreshNotificationTimerDisplay() {
  const statusEl = document.getElementById('notification-status');
  const metricsEl = document.getElementById('notification-metrics');
  if (!statusEl || !metricsEl) return;
  if (statusEl.style.display === 'none') return;
  if (!lastRenderedNotificationRuntime) return;
  metricsEl.innerHTML = renderRuntimeTimer(lastRenderedNotificationRuntime, currentRuntimeConnected);
}

export function ensureNotificationClockTimer() {
  if (_notificationClockTimer) return;
  _notificationClockTimer = window.setInterval(() => {
    refreshNotificationTimerDisplay();
    // 同步对话区域临时状态块（处理 early-return 路径和耗时刷新）
    if (typeof ensureChatRuntimeIndicator === 'function') ensureChatRuntimeIndicator();
    // 工具进度卡片走秒刷新（ticket 025）：startedAt 本地插值，两次 poll 之间平滑增长
    if (typeof window.syncToolProgressDom === 'function') window.syncToolProgressDom();
  }, 200);
}

export function getRuntimeStageClass(runtime) {
  return `stage-${String(runtime?.stage || 'idle').replace(/[^a-z0-9_-]/gi, '-')}`;
}

export function shouldShowRuntimeStatus(runtime, stateType = '') {
  if (runtime.suspended) return true;
  if (runtime.callActive && runtime.stage !== 'idle' && runtime.stage !== 'completed' && runtime.stage !== 'failed' && runtime.stage !== 'cancelled') {
    return true;
  }
  const settledRecently = runtime.updatedAt > 0
    && (Date.now() - runtime.updatedAt) < (runtime.stage === 'failed' || runtime.stage === 'cancelled' ? 8000 : 800);
  return ((runtime.stage === 'completed' || runtime.stage === 'failed' || runtime.stage === 'cancelled') && settledRecently)
    || stateType === 'llm.char_count';
}

export function shouldStatusUseQueueSync(runtime) {
  return runtime.stage === 'llm_thinking'
    || runtime.stage === 'llm_content'
    || runtime.stage === 'llm_tool_call_building';
}

// ─── 通知状态更新主逻辑 ───

/**
 * 会话 / 运行时切换时立即清空运行状态显示。
 *
 * 旧会话的快照（lastRenderedNotificationRuntime，p2-w2-2-runtime-status-owner
 * 的活绑定）与顶栏 DOM 在新会话的 notification 数据到达前仍然存活
 * （loadAgentData 需要等多个 fetch 完成），期间 chat-renderer 每次渲染都会用
 * 旧快照重建对话区指示块，导致新会话里残留上一会话的"模型正在思考…"文案，
 * 随后才被新数据替换/移除，并伴随指示块出现/消失带来的高度抖动。切换瞬间
 * 直接清空，等新数据到达后再渲染。
 *
 * 调用点全在运行期（thread-store 的接续 rebind、runtime-switch 的切换宿主面
 * 经 app-main 的 `resetStatus`），不一致于首屏同步链；经 `runtime-status-api`
 * 桥键供这些消费方取用。函数内的 `resetCallElapsedForSwitch` /
 * `clearToolProgressState` 由 `persistent-input-api` / `tool-progress` 域的桥键
 * 在同一 window 上提供，`typeof` 守卫语义不变。
 */
function resetRuntimeStatusForSwitch() {
  if (typeof window.resetCallElapsedForSwitch === 'function') window.resetCallElapsedForSwitch();
  setLastRenderedNotificationRuntime(null);
  setLastNotificationStatusPayload(null);
  const statusEl = document.getElementById('notification-status');
  if (statusEl) {
    statusEl.style.display = 'none';
    statusEl.className = 'notification-status';
    const phaseEl = document.getElementById('notification-phase');
    const summaryEl = document.getElementById('notification-summary');
    const metricsEl = document.getElementById('notification-metrics');
    if (phaseEl) phaseEl.textContent = '';
    if (summaryEl) summaryEl.textContent = '';
    if (metricsEl) metricsEl.innerHTML = '';
  }
  const chatContainer = document.getElementById('chat-container');
  const existing = chatContainer ? chatContainer.querySelector('#runtime-indicator-row') : null;
  if (existing) {
    window.runWithSuppressedChatViewportObservers(function() {
      existing.remove();
    });
  }
  // 工具进度卡片随会话/运行时切换整体复位（ticket 025）
  if (typeof window.clearToolProgressState === 'function') window.clearToolProgressState();
}

// 通知状态更新必须归属于触发它的 SessionView；同步 SSE / 重绘调用也经同一提交边界。
function updateNotificationStatus(notifData, runtimeId = currentRuntimeAgentId, viewToken = null) {
  const token = viewToken || (typeof window.captureSessionViewToken === 'function'
    ? window.captureSessionViewToken(runtimeId)
    : null);
  // session-view-commit 域桥键（注册行在 session-view-commit-host.js，kernel-entry 图）：
  // 本模块不静态 import 它，保持求值面窄（见头注），收敛在 T5 清零批次。
  if (!token || typeof window.commitSessionViewState !== 'function' || typeof window.isSessionViewTokenCurrent !== 'function') {
    if (typeof window.captureSessionViewToken !== 'function') return applyNotificationStatus(notifData, runtimeId);
    return false;
  }
  if (!window.isSessionViewTokenCurrent(token)) return false;
  return window.commitSessionViewState(token, () => applyNotificationStatus(notifData, runtimeId));
}

export function applyNotificationStatus(notifData, runtimeId) {
  if (window.normalizeAgentIdentity(runtimeId) !== window.normalizeAgentIdentity(currentRuntimeAgentId)) return;
  const payload = (notifData && typeof notifData === 'object') ? notifData : {};
  if (!notifData && typeof window.resetCallElapsedForSwitch === 'function') window.resetCallElapsedForSwitch();
  // 工具执行中进度（ticket 025）：tool.progress 入表 / 终态信号清除
  if (typeof window.applyToolProgressNotification === 'function') {
    window.applyToolProgressNotification(payload);
  }
  const statusEl = document.getElementById('notification-status');
  const phaseEl = document.getElementById('notification-phase');
  const summaryEl = document.getElementById('notification-summary');
  const metricsEl = document.getElementById('notification-metrics');
  setLastNotificationStatusPayload(payload);
  const runtimeIdForSuppression = window.normalizeAgentIdentity(currentRuntimeAgentId);
  const actionSource = getNotificationActionSource(payload);
  // call.finish is authoritative even if a coalesced runtime snapshot still
  // carries the previous callActive:true value.
  if (runtimeIdForSuppression && String(actionSource?.type || '').trim() === 'call.finish') {
    clearInterruptSuppression(runtimeIdForSuppression);
  }
  const payloadCalling = resolveNotificationCallingState(payload);
  const observedCallStartedAt = getNotificationCallStartedAt(payload);
  const suppressingInterrupt = runtimeIdForSuppression
    && payloadCalling
    && isInterruptSuppressed(runtimeIdForSuppression, observedCallStartedAt);
  const runtime = getEffectiveRuntimeSnapshot(payload, { suppressCalling: suppressingInterrupt });

  let callingStateChanged = false;
  // `callActive` is tracked independently from the transient `state` payload.
  // Some notification responses may only carry the call flag, so update it
  // before any early return based on `state`.
  if (payload.callActive !== undefined) {
    const runtimeId = currentRuntimeAgentId;
    if (runtimeId) {
      const prev = callActivity._agentCallActive.get(runtimeId);
      let nextCalling = resolveNotificationCallingState(payload);
      if (nextCalling) {
        // interrupting 期间同一 call 的 true 只是排空状态；只有更新的
        // callStartedAt 才代表真正的新 call，可以离开 interrupting。
        if (!isInterruptSuppressed(runtimeId, observedCallStartedAt)) {
          window._markAgentCallStartedForNotify(runtimeId);
          callActivity._agentCallActive.set(runtimeId, true);
          _agentSuspended.delete(runtimeId);
        } else {
          nextCalling = false;
        }
      } else {
        callActivity._agentCallActive.delete(runtimeId);
        // ADR-0019：call 结束时按 payload 落定挂起态（lastOutcome 持久事实）
        if (isSuspendedNotificationPayload(payload)) {
          _agentSuspended.set(runtimeId, true);
        } else {
          _agentSuspended.delete(runtimeId);
        }
        clearInterruptSuppression(runtimeId);
      }
      callingStateChanged = (prev === true) !== nextCalling;
      if (callingStateChanged) {
        window.renderAgentList();
      }
    }
  }

  // Capture last call finish time for elapsed display
  if (payload.state && typeof payload.state === 'object' && payload.state.type === 'call.finish') {
    setLastCallFinishTime(typeof payload.state.timestamp === 'number'
      ? payload.state.timestamp
      : (runtime.updatedAt || Date.now()));
    window._renderLastCallElapsed();
    // Trigger deferred recap if user was away while AI was generating
    if (recapPendingTrigger) {
      setRecapPendingTrigger(false);
      window._maybeFetchRecap();
    }
  }

  if (suppressingInterrupt) {
    statusEl.style.display = 'flex';
    statusEl.className = 'notification-status active is-interrupting';
    phaseEl.textContent = getCurrentLanguage() === 'zh' ? '正在停止…' : 'Stopping…';
    summaryEl.textContent = getCurrentLanguage() === 'zh'
      ? '等待当前步骤安全退出'
      : 'Waiting for the current step to exit safely';
    metricsEl.innerHTML = '';
    setLastRenderedNotificationRuntime(null);
    window._syncPersistentActionButton();
    // 快照已清空，对话区指示块需同 tick 移除，不等 200ms 时钟
    ensureChatRuntimeIndicator();
    return;
  }

  const stateType = String(actionSource?.type || '').trim();
  const shouldShowStatus = !currentRuntimeConnected
    || (!suppressingInterrupt && shouldShowRuntimeStatus(runtime, stateType));
  if (currentRuntimeAgentId && payload.callActive === undefined) {
    if (stateType === 'call.start') {
      if (!isRuntimeCalling(currentRuntimeAgentId)
        && !isInterruptSuppressed(currentRuntimeAgentId, observedCallStartedAt)) {
        window._markAgentCallStartedForNotify(currentRuntimeAgentId);
        callActivity._agentCallActive.set(currentRuntimeAgentId, true);
        _agentSuspended.delete(currentRuntimeAgentId);
        callingStateChanged = true;
        window.renderAgentList();
      }
    } else if (stateType === 'call.finish') {
      if (isRuntimeCalling(currentRuntimeAgentId)) {
        callActivity._agentCallActive.delete(currentRuntimeAgentId);
        // ADR-0019：聚焦 call.finish（state 形态）按 payload 落定挂起态
        if (isSuspendedNotificationPayload(payload)) {
          _agentSuspended.set(currentRuntimeAgentId, true);
        } else {
          _agentSuspended.delete(currentRuntimeAgentId);
        }
        callingStateChanged = true;
        window.renderAgentList();
      }
      clearInterruptSuppression(currentRuntimeAgentId);
    }
  }

  if (shouldShowStatus) {
    statusEl.style.display = 'flex';
    statusEl.className = `notification-status active ${getRuntimeStageClass(runtime)}${currentRuntimeConnected ? '' : ' is-disconnected'}`;
    phaseEl.textContent = getCompactRuntimeLabel(runtime, currentRuntimeConnected);
    setLastRenderedNotificationRuntime({ ...runtime });
    metricsEl.innerHTML = renderRuntimeTimer(runtime, currentRuntimeConnected);
    window._syncPersistentActionButton();
    if (shouldStatusUseQueueSync(runtime)) {
      window._syncQueueFromBackend();
    }
    if (!payload.state) {
      ensureChatRuntimeIndicator();
      return;
    }
  } else if (!payload.state) {
    statusEl.style.display = 'none';
    statusEl.className = 'notification-status';
    phaseEl.textContent = '';
    summaryEl.textContent = '';
    metricsEl.innerHTML = '';
    setLastRenderedNotificationRuntime(null);
    window._syncPersistentActionButton();
    ensureChatRuntimeIndicator();
    return;
  }

  const { type, data } = actionSource || {};

  if (!type) {
    ensureChatRuntimeIndicator();
    return;
  }

  if (type === 'call.start') {
    window._syncPersistentActionButton();
    // 唤醒轮开始：挂起等待指示块的残留数据源到此为止，等待文案不跨入运行轮。
    // 只清挂起残留——正常运行轮首轮的 awaiting_runtime 快照已在上方
    // shouldShowStatus 分支写入，无条件清空会让指示块在 call.start 到首个
    // 表达性帧之间消失，用户输入后的"等待响应…"不再立即显示。
    if (lastRenderedNotificationRuntime?.suspended) {
      setLastRenderedNotificationRuntime(null);
    }
    ensureChatRuntimeIndicator();
    return;
  }

  if (type === 'call.finish') {
    if (currentRuntimeAgentId) {
      callActivity._agentCallActive.delete(currentRuntimeAgentId);
      // ADR-0019：聚焦 call.finish（UI 收尾段）按 payload 落定挂起态
      if (isSuspendedNotificationPayload(payload)) {
        _agentSuspended.set(currentRuntimeAgentId, true);
      } else {
        _agentSuspended.delete(currentRuntimeAgentId);
      }
      clearInterruptSuppression(currentRuntimeAgentId);
      window.renderAgentList();
    }
    window._syncPersistentActionButton();
    window._syncPersistentInputUi();
    if (!shouldShowRuntimeStatus(runtime, type)) {
      statusEl.style.display = 'none';
      statusEl.className = 'notification-status';
      phaseEl.textContent = '';
      summaryEl.textContent = '';
      metricsEl.innerHTML = '';
      // 挂起等待保留对话区指示块的数据源：等待中与已等待时长持续显示
      if (!runtime.suspended) {
        setLastRenderedNotificationRuntime(null);
      }
    }
    ensureChatRuntimeIndicator();
    return;
  }

  if (!runtime.callActive && type === 'llm.char_count') {
    statusEl.style.display = 'flex';
    statusEl.className = 'notification-status active';

    const phaseNames = {
      'thinking': t('phase_thinking'),
      'content': t('phase_content'),
      'tool_calling': t('phase_tool_calling')
    };
    phaseEl.textContent = phaseNames[data.phase] || data.phase;
    summaryEl.textContent = '';
    setLastRenderedNotificationRuntime({ ...runtime });
    metricsEl.innerHTML = renderRuntimeTimer(runtime, currentRuntimeConnected);

    // 新语义下改为根据 runtime 调用状态同步按钮
    window._syncPersistentActionButton();
    // 新 step 开始，agent 已在上一步结束时 dequeue 了消息，同步气泡
    window._syncQueueFromBackend();
  } else if (!runtime.callActive && type === 'llm.complete') {
    statusEl.style.display = 'none';
    statusEl.className = 'notification-status';
    phaseEl.textContent = '';
    summaryEl.textContent = '';
    metricsEl.innerHTML = '';
    setLastRenderedNotificationRuntime(null);
    window._syncPersistentActionButton();
    // 不在这里清空 _queuedTexts — 后端队列可能仍有消息待消费
    // 队列显示由 _syncQueueFromBackend() 在每轮 step_start 时统一管理
    setPendingQueuedCount(0);
    window._syncPersistentInputUi();
  } else if (!runtime.callActive && !runtime.suspended) {
    statusEl.style.display = 'none';
    statusEl.className = 'notification-status';
    phaseEl.textContent = '';
    summaryEl.textContent = '';
    metricsEl.innerHTML = '';
    setLastRenderedNotificationRuntime(null);
  } else if (!shouldShowStatus) {
    // callActive 为 true 但 shouldShowStatus 为 false（如 llm.complete + 无 pending tools 的收尾窗口）
    statusEl.style.display = 'none';
    statusEl.className = 'notification-status';
    phaseEl.textContent = '';
    summaryEl.textContent = '';
    metricsEl.innerHTML = '';
    setLastRenderedNotificationRuntime(null);
    window._syncPersistentActionButton();
  }

  // calling 翻转不触发输入面渲染（工单 037）：calling 不进入显示模式矩阵
  // （§3 级 8 calling/idle 同为 persistent），三态按钮由 _syncPersistentActionButton
  // 同步；模式翻转由真正的状态写入方声明。

  // 同步对话区域临时状态块
  ensureChatRuntimeIndicator();
}

// ─── 对话区域临时运行状态块 ───

/**
 * 从 tool call arguments 中提取人类可读的摘要。
 * 不同工具展示不同关键参数。
 */
function summarizeToolCall(call) {
  if (!call || !call.name) return '';
  const name = String(call.name);
  const args = (call.arguments && typeof call.arguments === 'object') ? call.arguments : {};

  // 提取第一行 / 截断长文本
  function truncate(str, max) {
    const s = String(str || '').trim();
    if (s.length <= max) return s;
    return s.slice(0, max) + '…';
  }

  switch (name) {
    case 'bash':
    case 'powershell':
      return truncate(args.command, 80);
    case 'read':
      return truncate(args.filePath, 100);
    case 'edit':
      return truncate(args.filePath, 100);
    case 'write':
      return truncate(args.filePath, 100);
    case 'grep':
      return args.pattern ? `"${truncate(args.pattern, 40)}"` + (args.searchPath ? ` in ${truncate(args.searchPath, 50)}` : '') : '';
    case 'glob':
      return truncate(args.pattern, 80);
    case 'ls':
      return truncate(args.dirPath, 100);
    case 'web_fetch':
    case 'mcp_playwright_browser_navigate':
      return truncate(args.url, 100);
    case 'task_create':
    case 'task_update':
      return truncate(args.subject, 80);
    case 'mcp_playwright_browser_click':
    case 'mcp_playwright_browser_type':
      return truncate(args.element || args.text, 60);
    case 'mcp_playwright_browser_snapshot':
    case 'mcp_playwright_browser_take_screenshot':
      return '';
    default: {
      // 通用回退：尝试常见参数名
      const keys = ['filePath', 'path', 'command', 'query', 'url', 'pattern', 'name', 'subject', 'message'];
      for (const k of keys) {
        if (args[k]) return truncate(args[k], 80);
      }
      return '';
    }
  }
}

/**
 * 构建临时状态块的结构化内容。
 * 返回 { main: string, details: string[] } 或 null。
 */
export function buildRuntimeIndicatorContent(runtime) {
  const isZh = getCurrentLanguage() === 'zh';
  const stage = runtime.stage;
  let mainText = '';
  const details = [];

  // 主行：阶段标签 + 字符数
  if (stage === 'llm_thinking') {
    const chars = runtime.thinkingChars || runtime.charCount;
    mainText = isZh
      ? `模型正在思考${chars > 0 ? ' · ' + formatRuntimeCompactNumber(chars) + ' 字' : '…'}`
      : `Thinking${chars > 0 ? ' · ' + formatRuntimeCompactNumber(chars) + ' chars' : '…'}`;
  } else if (stage === 'llm_content') {
    const chars = runtime.contentChars || runtime.charCount;
    mainText = isZh
      ? `正在生成回复${chars > 0 ? ' · ' + formatRuntimeCompactNumber(chars) + ' 字' : '…'}`
      : `Generating${chars > 0 ? ' · ' + formatRuntimeCompactNumber(chars) + ' chars' : '…'}`;
  } else if (stage === 'llm_tool_call_building') {
    const toolNames = runtime.streamToolNames || [];
    if (toolNames.length > 0) {
      mainText = isZh ? `正在准备工具调用 · ${toolNames.join(', ')}` : `Preparing tools · ${toolNames.join(', ')}`;
    } else {
      mainText = isZh ? '正在准备工具调用…' : 'Preparing tools…';
    }
  } else if (stage === 'tool_executing') {
    const pending = getPendingToolCallsFromMessages();
    if (pending.length > 0) {
      mainText = isZh ? `正在执行 ${pending.length} 个工具` : `Running ${pending.length} tool${pending.length > 1 ? 's' : ''}`;
      pending.forEach(function(call) {
        const summary = summarizeToolCall(call);
        const display = window.getToolDisplayName(call.name) || call.name;
        details.push(summary ? `${display}: ${summary}` : display);
      });
    } else {
      const toolNames = runtime.activeToolNames || [];
      if (toolNames.length > 0) {
        mainText = isZh ? `正在执行工具 · ${toolNames.join(', ')}` : `Running tools · ${toolNames.join(', ')}`;
      } else {
        mainText = isZh ? '正在执行工具…' : 'Running tools…';
      }
    }
  } else if (stage === 'awaiting_runtime') {
    const pending = getPendingToolCallsFromMessages();
    if (pending.length > 0) {
      mainText = isZh ? `等待 ${pending.length} 个工具返回` : `Waiting for ${pending.length} tool${pending.length > 1 ? 's' : ''}`;
    } else {
      mainText = isZh ? '等待响应…' : 'Waiting…';
    }
  } else if (stage === 'retry_waiting') {
    mainText = isZh ? '等待重试…' : 'Waiting to retry…';
  } else if (stage === 'retry_requesting') {
    mainText = isZh ? '正在重新请求…' : 'Retrying…';
  } else if (runtime.suspended && stage === 'completed') {
    // ADR-0019 挂起等待：call 以 continue 结束、工具 step 等待后台任务唤醒，
    // 持续显示等待态与已等待时长（stageStartedAt ≈ 挂起时刻），唤醒轮开始
    // 后由 calling 阶段分支接管。
    const pending = getPendingToolCallsFromMessages();
    if (pending.length > 0) {
      mainText = isZh ? `等待 ${pending.length} 个后台任务` : `Waiting for ${pending.length} background task${pending.length > 1 ? 's' : ''}`;
      pending.forEach(function(call) {
        const summary = summarizeToolCall(call);
        const display = window.getToolDisplayName(call.name) || call.name;
        details.push(summary ? `${display}: ${summary}` : display);
      });
    } else {
      mainText = isZh ? '等待后台任务…' : 'Waiting for background tasks…';
    }
  } else if (stage === 'failed') {
    mainText = isZh ? '请求失败' : 'Failed';
  } else if (stage === 'cancelled') {
    mainText = isZh ? '已停止' : 'Stopped';
  } else {
    if (runtime.callActive) {
      mainText = isZh ? '处理中…' : 'Working…';
    }
  }

  if (!mainText) return null;

  // 耗时（当前步骤用时，与顶栏计时同口径；不再显示整轮总时长）
  const stepElapsed = getRuntimeStepElapsedLabel(runtime);
  if (stepElapsed) mainText += ' · ' + stepElapsed;

  return { main: mainText, details: details };
}

/**
 * 创建 / 更新 / 移除对话区域临时状态块。
 * Agent 活跃时显示，完成后消失（无论过程处于显示还是隐藏模式）。
 * 使用 DOM diff 更新文本，避免重建元素导致 CSS 动画重置。
 */
function ensureChatRuntimeIndicator() {
  const chatContainer = document.getElementById('chat-container');
  if (!chatContainer) return;

  const INDICATOR_ID = 'runtime-indicator-row';
  let existing = chatContainer.querySelector('#' + INDICATOR_ID);

  // 判断是否应该显示
  // 断连时上栏显示"已断开连接"，此处同步隐藏，避免继续展示过时的阶段文案
  // ADR-0019 挂起等待：call 已结束但工具 step 等待后台任务唤醒，指示块
  // 持续显示等待态，直到唤醒轮开始（callActive 分支接管）。
  const rt = lastRenderedNotificationRuntime;
  const shouldShow = currentRuntimeConnected
    && rt
    && (rt.suspended === true
      || (rt.callActive
        && rt.stage !== 'idle'
        && rt.stage !== 'completed'
        && rt.stage !== 'failed'));

  if (!shouldShow) {
    if (existing) {
      window.runWithSuppressedChatViewportObservers(function() {
        existing.remove();
      });
    }
    return;
  }

  // 构建内容
  const content = buildRuntimeIndicatorContent(lastRenderedNotificationRuntime);
  if (!content) {
    if (existing) {
      window.runWithSuppressedChatViewportObservers(function() {
        existing.remove();
      });
    }
    return;
  }

  if (!existing) {
    existing = document.createElement('div');
    existing.id = INDICATOR_ID;
    window.runWithSuppressedChatViewportObservers(function() {
      chatContainer.appendChild(existing);
    });
  }
  // 挂起等待用静止视觉（is-suspended 停用脉冲与 shimmer），区别于运行中的活动态
  existing.className = 'runtime-indicator-row' + (rt.suspended ? ' is-suspended' : '');

  // 更新主行（textContent 而非 innerHTML，保持 CSS 动画连续）
  // 所有子元素的创建和文本更新都包裹在 runWithSuppressedChatViewportObservers 中，
  // 避免触发 MutationObserver → notifyChatViewportMutation → lockChatViewportToBottomNow，
  // 后者会在 followLatestEnabled 时强制将视口锁定到最底部。
  window.runWithSuppressedChatViewportObservers(function() {
    let mainEl = existing.querySelector('.runtime-indicator-main');
    if (!mainEl) {
      mainEl = document.createElement('div');
      mainEl.className = 'runtime-indicator-main';
      existing.appendChild(mainEl);
    }
    // 确保 dot + text 子结构存在
    let dotEl = mainEl.querySelector('.runtime-indicator-dot');
    if (!dotEl) {
      dotEl = document.createElement('span');
      dotEl.className = 'runtime-indicator-dot';
      mainEl.appendChild(dotEl);
    }
    let textEl = mainEl.querySelector('.runtime-indicator-text');
    if (!textEl) {
      textEl = document.createElement('span');
      textEl.className = 'runtime-indicator-text';
      mainEl.appendChild(textEl);
    }
    if (textEl.textContent !== content.main) {
      textEl.textContent = content.main;
    }

    // 更新详情行：增删改，不重建已有元素（最多显示 5 行，避免悬挂区侵入过大）
    var MAX_DETAIL_ROWS = 5;
    var visibleDetails = content.details.slice(0, MAX_DETAIL_ROWS);
    let detailEls = existing.querySelectorAll('.runtime-indicator-detail');
    // 移除多余的
    for (let i = detailEls.length - 1; i >= visibleDetails.length; i--) {
      detailEls[i].remove();
    }
    // 更新或新增
    for (let i = 0; i < visibleDetails.length; i++) {
      detailEls = existing.querySelectorAll('.runtime-indicator-detail');
      let el = detailEls[i];
      if (!el) {
        el = document.createElement('div');
        el.className = 'runtime-indicator-detail';
        existing.appendChild(el);
      }
      if (el.textContent !== visibleDetails[i]) {
        el.textContent = visibleDetails[i];
      }
    }

    // 确保始终在容器最末尾
    if (chatContainer.lastElementChild !== existing) {
      chatContainer.appendChild(existing);
    }

    // 动态负 margin 补偿：抵消指示块对 scrollHeight 的贡献
    // （自身高度 + flex gap），使其随内容滚动但不影响滚动高度，
    // 彻底消除出现/消失/高度变化时的抖动。
    var flexGap = parseFloat(getComputedStyle(chatContainer).gap) || 24;
    var indicatorHeight = existing.offsetHeight;
    existing.style.marginBottom = (-indicatorHeight - flexGap) + 'px';
  });
}

// ─── 桥接期兼容面（domain `runtime-status-api`）───
// 函数键另立 api 域（先例 voice-input-api / input-composer-api）：状态域
// `runtime-status` 已被 p2-w2-2-runtime-status-owner claim，其 impl 对未声明键
// 直接抛错，函数键不能混进同一域。
//
// 逐键消费面（仍有经典相或经 window 晚绑定的消费方，注销条件同列）：
//   updateNotificationStatus        ← app-main / app-ui / agent-data-loader /
//                                     persistent-input / sse-client（window）
//   applyContextGuardStatus         ← agent-data-loader（window）
//   resetRuntimeStatusForSwitch     ← app-main 宿主 resetStatus / thread-store /
//                                     session-readonly-view / agent-data-loader
//   isRuntimeCalling                ← app-main / persistent-input / recap-hint /
//                                     rollback-dialog-runtime / auto-title /
//                                     p2-w2-3a-queue-projection（classic + window）
//   ensureChatRuntimeIndicator      ← chat-renderer / chat-process-visibility（window）
//   resolveNotificationCallingState ← app-main 的 classic 宿主工厂（isCalling）
// 注销条件：上列消费方全部改为具名 import 后删除对应 defineKey（注册行在本文件，
// 届时可直接删）并下调桥债基线。仅测试消费的 helper 只作命名导出、不上桥。
const bridgeApi = {
  updateNotificationStatus,
  applyContextGuardStatus,
  resetRuntimeStatusForSwitch,
  isRuntimeCalling,
  ensureChatRuntimeIndicator,
  resolveNotificationCallingState,
};
window.KernelState.defineKey('runtime-status-api', 'updateNotificationStatus', bridgeApi.updateNotificationStatus);
window.KernelState.defineKey('runtime-status-api', 'applyContextGuardStatus', bridgeApi.applyContextGuardStatus);
window.KernelState.defineKey('runtime-status-api', 'resetRuntimeStatusForSwitch', bridgeApi.resetRuntimeStatusForSwitch);
window.KernelState.defineKey('runtime-status-api', 'isRuntimeCalling', bridgeApi.isRuntimeCalling);
window.KernelState.defineKey('runtime-status-api', 'ensureChatRuntimeIndicator', bridgeApi.ensureChatRuntimeIndicator);
window.KernelState.defineKey('runtime-status-api', 'resolveNotificationCallingState', bridgeApi.resolveNotificationCallingState);
window.KernelState.claim('runtime-status-api', {
  get: (key) => bridgeApi[key],
  set: (key, value) => { bridgeApi[key] = value; },
});

// ─── 启动通知计时器 ───
// 模块相启动：与 classic 加载期启动同义（首屏由 boot.js 触发，晚于本模块求值；
// 计时器只刷新顶栏计时与对话区指示块，不参与首屏同步链）。
ensureNotificationClockTimer();
