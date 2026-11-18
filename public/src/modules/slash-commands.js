/**
 * slash-commands.js — P0 静态命令清单（/trim、/summary）
 *
 * 左侧会话列表右键「仅精简 / 仅摘要」的 slash 镜像，作用于当前激活的
 * workspace 会话：
 * - /summary → compact_session_menu summary 分支（action 内含确认，原样复用）
 * - /trim    → compact_session_menu trim_all 分支：全量精简、不生成摘要、
 *   跳过逐轮选择对话框（需要精细选择时仍走右键「仅精简」对话框）
 *
 * 确认形态按入口分担：slash /trim 的确认在 handler 内（可展示轮数与释放
 * 占比，来自 session_trim_preview）；trim_all 分支本身不再弹确认。
 *
 * 命令注册到 SlashMenu（基础设施见 slash-menu.js）；执行是控制动作，
 * 不构造 user-turn 消息。
 *
 * 依赖：
 * - 已 ESM（直接 import，装载顺序由 import 图确定）：SlashMenu
 *   (slash-menu.js)、currentRuntimeAgentId (orchestration-state.js)、
 *   focusedAgentId (agent-store-state.js)、实时语言 (i18n-environment-state.js)、
 *   ClawToast (toast-notify.js)
 * - 仍是 classic（调用时点显式 window 晚绑定）：getRuntimeId / getLogicalAgentId /
 *   getRuntimeWorkspaceSessionId / getActiveWorkspaceSessionId (app-core.js)、
 *   getCurrentRuntimeRecord / getCurrentAgentRecord (app-main.js)、
 *   isRemoteNamespaceAgentId (remote-connections.js)、sessionOpsAllowed
 *   (session-menu-decls.js，ADR-0049 声明驱动事实)、isThreadHostAgentId
 *   (thread-store.js)、runWorkspaceAction (workspace-actions.js)
 */

import { SlashMenu } from './slash-menu.js';
import { currentRuntimeAgentId } from './orchestration-state.js';
import { focusedAgentId } from './agent-store-state.js';
import { getCurrentLanguage } from './i18n-environment-state.js';
import { sessionOpsAllowed } from './session-menu-decls.js';
import { ClawToast } from './toast-notify.js';
import { getActiveWorkspaceSessionId, getLogicalAgentId, getRuntimeId, getRuntimeWorkspaceSessionId } from './identity.js';

function _resolveSessionContext() {
  // 输入框属于当前 runtime 视图：agent record 从 runtime 反查（焦点派生的
  // getCurrentAgentRecord 仅兜底），sessionId 用 viewer 绑定（用户正在查看
  // 的会话），server 派生的 active 值仅在无绑定时兜底——与 slash-menu.js
  // _currentTarget 同一不变量：命令作用于输入框所属的那个会话。
  // 纯解析（无副作用）：applies 谓词每次击键都会调用，失败提示由
  // _currentSessionContext 包装层负责。
  // 桥接期晚绑定（首次使用处）：getRuntimeId / getLogicalAgentId /
  // getRuntimeWorkspaceSessionId / getActiveWorkspaceSessionId 来自 identity 域
  // （身份与会话解析域），getCurrentRuntimeRecord / getCurrentAgentRecord 定义于
  // app-main（编排域）；迁为 import 后删除各自的 window. 前缀。
  const runtimeId = getRuntimeId(currentRuntimeAgentId)
    || (typeof currentRuntimeAgentId === 'string' ? currentRuntimeAgentId : '');
  const record = (typeof window.getCurrentRuntimeRecord === 'function' && window.getCurrentRuntimeRecord())
    || (typeof window.getCurrentAgentRecord === 'function' ? window.getCurrentAgentRecord() : null);
  let agentId = record ? (getLogicalAgentId(record) || record.id || '') : '';
  let sessionId = (runtimeId && getRuntimeWorkspaceSessionId(runtimeId))
    || (record ? getActiveWorkspaceSessionId(record) : null);
  // 远程会话（R2-02，ADR-0012）：远程条目不在 allAgents，record 链落空。
  // 身份从远程目录解析：sessionId 用目录条目值（命名空间化），agentId 收敛
  // 宿主级命名空间 id（数据层身份纪律，ADR-0012）。目录未含条目时返回
  // remote-unavailable 语义（区别于无会话）。
  // 桥接期晚绑定（首次使用处）：isRemoteNamespaceAgentId 定义于
  // remote-connections（远程连接域）；RemoteConnections 是其 classic 命名空间对象。
  // 该文件迁为 import 后删除这里的 window. 前缀。
  if ((!agentId || !sessionId)
    && typeof window.isRemoteNamespaceAgentId === 'function'
    && (window.isRemoteNamespaceAgentId(runtimeId)
      || (typeof focusedAgentId === 'string' && window.isRemoteNamespaceAgentId(focusedAgentId)))) {
    const rc = typeof window !== 'undefined' ? window.RemoteConnections : null;
    const dirSessionId = (typeof rc?.getEntryRuntimeSessionId === 'function' && runtimeId)
      ? rc.getEntryRuntimeSessionId(runtimeId)
      : '';
    const hostNsId = (typeof rc?.getEntryHostNamespaceId === 'function' && runtimeId)
      ? rc.getEntryHostNamespaceId(runtimeId)
      : '';
    if (dirSessionId && hostNsId) {
      return { agentId: hostNsId, sessionId: dirSessionId };
    }
    return { agentId: '', sessionId: '', reason: 'remote_unavailable' };
  }
  if (!agentId || !sessionId) return { agentId: '', sessionId: '', reason: 'no_session' };
  return { agentId, sessionId };
}

function _currentSessionContext() {
  const ctx = _resolveSessionContext();
  if (ctx.agentId && ctx.sessionId) return ctx;
  const isZh = getCurrentLanguage() === 'zh';
  // 目录未含条目（连接断开/条目消失）：显式失败，不猜测宿主。
  if (ctx.reason === 'remote_unavailable') {
    ClawToast.show({
      id: 'slash-no-session',
      status: 'error',
      title: isZh ? '远程连接不可用，无法操作该会话' : 'Remote connection is unavailable for this session',
      autoDismiss: 5000,
    });
    return null;
  }
  ClawToast.show({
    id: 'slash-no-session',
    status: 'error',
    title: isZh ? '当前没有可操作的会话' : 'No active session to operate on',
    autoDismiss: 5000,
  });
  return null;
}

// 自动接续 APP（coder / memo 等，线程事实驱动判定）不提供手动精简/摘要：
// 连续性由线程接力持有（自动触发 + 接续事务），手动入口与 APP 对话模型
// 矛盾（ADR-0024 决策 4「不出现手动 trim / compact 等通用会话操作」）。
// 手动接续 APP（ADR-0032 决策 2，编程小助手）的线程会话保留入口：线程
// 承接的是接续事务（挡板 → 变换 → head 推进），变换由用户手动发起。
// 判定复用 session-menu-decls 的会话操作产品面事实 sessionOpsAllowed
// （ADR-0049：sessionOps 由 APP 的 metadata 声明），不新增平行清单：
// 声明 = 有手动精简产品面 = 手动接续 APP；coder / memo 不声明，行为不变。
// 线程索引未就绪时保守放行（显示），执行侧守卫兜底。
function _isThreadCarriedSession(ctx) {
  // 桥接期晚绑定（首次使用处）：isThreadHostAgentId 定义于 thread-store（线程域）、
  // sessionOpsAllowed 定义于 session-menu-decls（会话操作声明域）；两者迁为 import
  // 后删除 window. 前缀。
  if (!ctx || !ctx.agentId || !ctx.sessionId) return false;
  if (typeof window.isThreadHostAgentId !== 'function') return false;
  if (!window.isThreadHostAgentId(ctx.agentId, ctx.sessionId)) return false;
  return !sessionOpsAllowed(ctx.agentId);
}

// 命令可见性谓词（applies）：线程承接的会话不显示手动精简/摘要入口。
// 模块私有——测试经 SLASH_COMMANDS 条目的 applies 真实入口驱动，不额外导出。
function _manualSessionOpsApplicable() {
  return !_isThreadCarriedSession(_resolveSessionContext());
}

function _manualSessionOpsContext() {
  const ctx = _currentSessionContext();
  if (!ctx) return null;
  if (_isThreadCarriedSession(ctx)) {
    ClawToast.show({
      id: 'slash-session-ops-unavailable',
      status: 'info',
      title: getCurrentLanguage() === 'zh'
        ? '该会话的连续性由线程承接，不支持手动精简/摘要'
        : 'This session is carried by a thread; manual trim/summary is unavailable',
      autoDismiss: 4000,
    });
    return null;
  }
  return ctx;
}

async function _handleSummary() {
  const ctx = _manualSessionOpsContext();
  if (!ctx) return;
  // 桥接期晚绑定（首次使用处）：runWorkspaceAction 定义于 workspace-actions
  // （工作空间动作域），迁为 import 后删除 window. 前缀
  window.runWorkspaceAction({
    type: 'compact_session_menu',
    compactType: 'summary',
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
  });
}

async function _handleTrim() {
  const ctx = _manualSessionOpsContext();
  if (!ctx) return;
  const isZh = getCurrentLanguage() === 'zh';

  // preview 只为确认文案提供轮数/释放占比；提交策略固定全量精简。
  // 拉取失败不阻断，确认文案退化为不带轮数。
  let trimCount = 0;
  let freedPctText = '';
  try {
    const res = await fetch('/protoclaw/session_trim_preview?agentId=' + encodeURIComponent(ctx.agentId)
      + '&sessionId=' + encodeURIComponent(ctx.sessionId));
    if (res.ok) {
      const data = await res.json();
      const rounds = Array.isArray(data?.rounds) ? data.rounds : [];
      trimCount = rounds.length;
      const freed = rounds.reduce((sum, r) => sum + (r.charPercent || 0), 0);
      freedPctText = (freed * 100).toFixed(1) + '%';
    }
  } catch (e) {
    console.warn('[SlashCommands] trim preview failed:', e);
  }

  const statsSuffix = trimCount > 0
    ? (isZh ? `共 ${trimCount} 轮 · 释放约 ${freedPctText} 上下文` : `${trimCount} rounds · frees ~${freedPctText} context`)
    : '';
  // 线程会话（ADR-0032）：精简是同一对话内的上下文接力——不说「创建新
  // 会话」，历史自动存档。索引未就绪时保守回落 Session 语义文案。
  const _trimOnThread = typeof window.isThreadHostAgentId === 'function'
    && window.isThreadHostAgentId(ctx.agentId, ctx.sessionId);
  const confirmMsg = _trimOnThread
    ? (isZh
      ? `将精简当前对话全部轮次并继续本对话？${statsSuffix ? '\n' + statsSuffix : ''}\n（精简前的记录自动存档；需要逐轮选择请用会话右键“仅精简”）`
      : `Trim all rounds of this conversation and continue here?${statsSuffix ? '\n' + statsSuffix : ''}\n(Pre-trim history is archived automatically; use right-click "Trim" for per-round selection)`)
    : (isZh
      ? `将精简当前会话全部轮次并创建新会话继续？${statsSuffix ? '\n' + statsSuffix : ''}\n（不生成摘要；需要逐轮选择请用会话右键“仅精简”）`
      : `Trim all rounds of this session and continue in a new one?${statsSuffix ? '\n' + statsSuffix : ''}\n(No summary; use right-click "Trim" for per-round selection)`);
  if (!window.confirm(confirmMsg)) return;

  window.runWorkspaceAction({
    type: 'compact_session_menu',
    compactType: 'trim_all',
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
    trimCutRounds: trimCount,
  });
}

// P0 静态注册（P1 起由 GET /protoclaw/commands 动态清单合并取代）。
// applies：自动接续 APP 的线程会话不显示；手动接续 APP（PH）保留——
// 口径见上方 _isThreadCarriedSession 注释（ADR-0032 决策 2）。
// 描述文案在装载时按当时语言定稿（与迁移前的 classic 装载语义一致）。
export const SLASH_COMMANDS = [
  {
    name: 'trim',
    description: getCurrentLanguage() === 'zh' ? '全量精简当前会话（不生成摘要）' : 'Trim all rounds of current session (no summary)',
    destination: 'host',
    applies: _manualSessionOpsApplicable,
    handler: _handleTrim,
  },
  {
    name: 'summary',
    description: getCurrentLanguage() === 'zh' ? '总结当前会话并创建新会话' : 'Summarize current session into a new session',
    destination: 'host',
    applies: _manualSessionOpsApplicable,
    handler: _handleSummary,
  },
];

SlashMenu.registerCommands(SLASH_COMMANDS);
