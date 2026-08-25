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
 * 依赖（全局）：SlashMenu (slash-menu.js)、currentLanguage (app-core.js)、
 * getCurrentAgentRecord (app-main.js)、getActiveWorkspaceSessionId (app-core.js)、
 * runWorkspaceAction (workspace-actions.js)
 */

function _currentSessionContext() {
  const agent = getCurrentAgentRecord();
  const sessionId = agent ? getActiveWorkspaceSessionId(agent) : null;
  if (!agent?.id || !sessionId) {
    window.ClawToast?.show?.({
      id: 'slash-no-session',
      status: 'error',
      title: currentLanguage === 'zh' ? '当前没有可操作的会话' : 'No active session to operate on',
      autoDismiss: 5000,
    });
    return null;
  }
  return { agentId: agent.id, sessionId };
}

async function _handleSummary() {
  const ctx = _currentSessionContext();
  if (!ctx) return;
  runWorkspaceAction({
    type: 'compact_session_menu',
    compactType: 'summary',
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
  });
}

async function _handleTrim() {
  const ctx = _currentSessionContext();
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

// P0 静态注册（P1 起由 GET /protoclaw/commands 动态清单合并取代）
SlashMenu.registerCommands([
  {
    name: 'trim',
    description: currentLanguage === 'zh' ? '全量精简当前会话（不生成摘要）' : 'Trim all rounds of current session (no summary)',
    destination: 'host',
    handler: _handleTrim,
  },
  {
    name: 'summary',
    description: currentLanguage === 'zh' ? '总结当前会话并创建新会话' : 'Summarize current session into a new session',
    destination: 'host',
    handler: _handleSummary,
  },
]);
