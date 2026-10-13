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
 * 依赖（全局）：SlashMenu (slash-menu.js)、currentLanguage、getRuntimeId、
 * getLogicalAgentId、getRuntimeWorkspaceSessionId (app-core.js)、
 * getCurrentRuntimeRecord、getCurrentAgentRecord (app-main.js)、
 * getActiveWorkspaceSessionId (app-core.js)、runWorkspaceAction (workspace-actions.js)
 */

function _resolveSessionContext() {
  // 输入框属于当前 runtime 视图：agent record 从 runtime 反查（焦点派生的
  // getCurrentAgentRecord 仅兜底），sessionId 用 viewer 绑定（用户正在查看
  // 的会话），server 派生的 active 值仅在无绑定时兜底——与 slash-menu.js
  // _currentTarget 同一不变量：命令作用于输入框所属的那个会话。
  // 纯解析（无副作用）：applies 谓词每次击键都会调用，失败提示由
  // _currentSessionContext 包装层负责。
  const runtimeId = getRuntimeId(currentRuntimeAgentId)
    || (typeof currentRuntimeAgentId === 'string' ? currentRuntimeAgentId : '');
  const record = (typeof getCurrentRuntimeRecord === 'function' && getCurrentRuntimeRecord())
    || (typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null);
  let agentId = record ? (getLogicalAgentId(record) || record.id || '') : '';
  let sessionId = (runtimeId && getRuntimeWorkspaceSessionId(runtimeId))
    || (record ? getActiveWorkspaceSessionId(record) : null);
  // 远程会话（R2-02，ADR-0012）：远程条目不在 allAgents，record 链落空。
  // 身份从远程目录解析：sessionId 用目录条目值（命名空间化），agentId 收敛
  // 宿主级命名空间 id（数据层身份纪律，ADR-0012）。目录未含条目时返回
  // remote-unavailable 语义（区别于无会话）。
  if ((!agentId || !sessionId)
    && typeof isRemoteNamespaceAgentId === 'function'
    && (isRemoteNamespaceAgentId(runtimeId)
      || (typeof focusedAgentId === 'string' && isRemoteNamespaceAgentId(focusedAgentId)))) {
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
  // 目录未含条目（连接断开/条目消失）：显式失败，不猜测宿主。
  if (ctx.reason === 'remote_unavailable') {
    window.ClawToast?.show?.({
      id: 'slash-no-session',
      status: 'error',
      title: currentLanguage === 'zh' ? '远程连接不可用，无法操作该会话' : 'Remote connection is unavailable for this session',
      autoDismiss: 5000,
    });
    return null;
  }
  window.ClawToast?.show?.({
    id: 'slash-no-session',
    status: 'error',
    title: currentLanguage === 'zh' ? '当前没有可操作的会话' : 'No active session to operate on',
    autoDismiss: 5000,
  });
  return null;
}

// 线程宿主会话（coder / memo 等，线程事实驱动判定）不提供手动精简/摘要：
// 连续性由线程接力持有（自动触发 + 接续事务），手动入口与 APP 对话模型
// 矛盾（ADR-0024 决策 4「不出现手动 trim / compact 等通用会话操作」）。
// 线程索引未就绪时保守放行（显示），执行侧守卫兜底。
function _isThreadCarriedSession(ctx) {
  return !!(ctx && ctx.agentId && ctx.sessionId
    && typeof window.isThreadHostAgentId === 'function'
    && window.isThreadHostAgentId(ctx.agentId, ctx.sessionId));
}

function _manualSessionOpsApplicable() {
  return !_isThreadCarriedSession(_resolveSessionContext());
}

function _manualSessionOpsContext() {
  const ctx = _currentSessionContext();
  if (!ctx) return null;
  if (_isThreadCarriedSession(ctx)) {
    window.ClawToast?.show?.({
      id: 'slash-session-ops-unavailable',
      status: 'info',
      title: currentLanguage === 'zh'
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
  runWorkspaceAction({
    type: 'compact_session_menu',
    compactType: 'summary',
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
  });
}

async function _handleTrim() {
  const ctx = _manualSessionOpsContext();
  if (!ctx) return;
  const isZh = currentLanguage === 'zh';

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
  const confirmMsg = isZh
    ? `将精简当前会话全部轮次并创建新会话继续？${statsSuffix ? '\n' + statsSuffix : ''}\n（不生成摘要；需要逐轮选择请用会话右键“仅精简”）`
    : `Trim all rounds of this session and continue in a new one?${statsSuffix ? '\n' + statsSuffix : ''}\n(No summary; use right-click "Trim" for per-round selection)`;
  if (!window.confirm(confirmMsg)) return;

  runWorkspaceAction({
    type: 'compact_session_menu',
    compactType: 'trim_all',
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
    trimCutRounds: trimCount,
  });
}

// P0 静态注册（P1 起由 GET /protoclaw/commands 动态清单合并取代）。
// applies：线程宿主会话不显示（裁剪声明住命令注册方，菜单机制通用）。
SlashMenu.registerCommands([
  {
    name: 'trim',
    description: currentLanguage === 'zh' ? '全量精简当前会话（不生成摘要）' : 'Trim all rounds of current session (no summary)',
    destination: 'host',
    applies: _manualSessionOpsApplicable,
    handler: _handleTrim,
  },
  {
    name: 'summary',
    description: currentLanguage === 'zh' ? '总结当前会话并创建新会话' : 'Summarize current session into a new session',
    destination: 'host',
    applies: _manualSessionOpsApplicable,
    handler: _handleSummary,
  },
]);
