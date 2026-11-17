/**
 * sidebar-render.js
 *
 * Sidebar agent list rendering and data loading.
 *
 * Extracted from app-main.js.
 *
 * Exported global functions:
 *   renderSidebarChildItems, getAgentIconHtml, renderAgentGroup,
 *   waitForPrebuiltRuntimeSession, waitForTargetRuntimeSession,
 *   loadAgents, refreshAgentCallStates,
 *   getAgentListRenderSignature, renderAgentList
 *
 * Dependencies (global state from app-core.js):
 *   allAgents, focusedAgentId, currentRuntimeAgentId, currentLanguage,
 *   suppressSidebarRerender, _navigationGuardEpoch, ...
 */

// Tracks collapsed state of project groups in the sidebar.
// Keys are stable project identities so state persists across re-renders.
const _collapsedProjectGroups = new Set();

// 全角开括号/引号开头的标题：标点墨迹内缩约半字宽，命中时加悬挂补偿类负
// 缩进，使墨迹起点与普通汉字视觉对齐（补偿量见 layout.css .hanging-punct）。
const SIDEBAR_HANGING_PUNCT_RE = /^[\uFF02\uFF07\uFF08\uFF3B\uFF5B\u2018\u201C\u3008\u300A\u300C\u300E\u3010\u3014]/;

// 邻近渐显：斜 pin 与 ⋯ 按钮的透明度由光标在条目内的水平位置驱动——
// 靠近左缘渐显 pin，靠近右缘渐显 ⋯；端点阈值内全不透明，向外线性衰减到
// 透明，避免划过/点击条目时两个图标突现突消的视觉干扰。
// pin 是弱提示，阈值小于 ⋯（全显 40px，40→100px 渐隐）；⋯ 全显 70px，
// 70→160px 渐隐。
function sidebarProximityFade(distance, solid, range) {
  if (distance <= solid) return 1;
  if (distance >= solid + range) return 0;
  return (solid + range - distance) / range;
}

window.onSidebarItemPointerMove = function(event, el) {
  const x = event.clientX - el.getBoundingClientRect().left;
  const fromRight = el.clientWidth - x;
  el.style.setProperty('--pin-hover-op', sidebarProximityFade(x, 40, 60).toFixed(3));
  el.style.setProperty('--more-hover-op', sidebarProximityFade(fromRight, 70, 90).toFixed(3));
  el.style.setProperty('--more-vis', fromRight <= 160 ? 'visible' : 'hidden');
};

window.onSidebarItemPointerLeave = function(el) {
  el.style.setProperty('--pin-hover-op', '0');
  el.style.setProperty('--more-hover-op', '0');
  el.style.setProperty('--more-vis', 'hidden');
};

/**
 * 侧栏运行中会话的拖拽源（→ 输入框会话引用 / 跨会话左栏 → 左栏）：
 * dragstart 把会话身份写入专用 MIME，投放判定与状态管理都在
 * session-reference-picker 模块。agentId 取模板写入的 data-ctx-ns（本地
 * 条目 = 宿主 agentId，与 session_record 寻址同源）；不查 allAgents——
 * 其字面量字段对 child 会话并不可靠，且远程条目不在其中（远程禁拖，
 * 见 renderItem 的 draggable 条件）。
 */
window.onSidebarSessionDragStart = function(event, el) {
  const ref = window.SessionReference;
  if (!ref || !event.dataTransfer) return;
  const sessionId = el?.dataset?.ctxSessionId || '';
  const agentId = String(el?.dataset?.ctxNs || '').trim();
  if (!sessionId || !agentId) { event.preventDefault(); return; }
  // 条目名可能带过渡标签（"正在关闭"等），只取首文本节点作为标题
  const nameEl = el?.querySelector('.agent-name');
  const titleNode = nameEl?.childNodes?.[0];
  const payload = {
    agentId,
    sessionId,
    title: (titleNode?.textContent || '').trim(),
  };
  event.dataTransfer.setData(ref.MIME, JSON.stringify(payload));
  // 登记拖拽源身份：dragover 据此禁止「拖到自己身上」（跨会话投放不受
  // 影响）。dragend 由 session-reference-picker 自动清除。
  if (ref.setDragSource) ref.setDragSource(payload);
  event.dataTransfer.effectAllowed = 'copy';
};

/**
 * 侧栏运行中会话条目的 ⋯ 按钮：打开与右键相同的 ctx 菜单（可视引导入口）。
 * 身份从条目的 data-ctx-* 读取，与 agentList 的 contextmenu 委托共用
 * getCtxMenuItems；stopPropagation 阻止点击冒泡成切换会话。
 */
window.onSidebarSessionCtxMenu = function(event, button) {
  if (event) event.stopPropagation();
  const ctxEl = button?.closest('[data-ctx-role]');
  if (!ctxEl) return;
  const role = ctxEl.dataset.ctxRole;
  const ns = ctxEl.dataset.ctxNs;
  const id = ctxEl.dataset.ctxId;
  const variant = ctxEl.dataset.ctxVariant || 'default';
  const sessionId = ctxEl.dataset.ctxSessionId || '';
  const threadId = ctxEl.dataset.ctxThreadId || '';
  const items = getCtxMenuItems(role, ns, variant, id, sessionId, threadId);
  if (items.length === 0) return;
  const rect = button.getBoundingClientRect();
  window.closeCtxMenu();
  closeAgentContextMenu();
  closeCompactMenu();
  closeProjectContextMenu();
  window.showCtxMenu(rect.right, rect.bottom, items, { role, ns, id, variant, sessionId, threadId });
};

// 工作空间条目 ⋯ 按钮（ADR-0050）的打开入口：与上面共享 onSidebarSessionCtxMenu，
// 但不经内联 onclick——内联处理器 ratchet 只许降不许升。捕获阶段容器委托在
// agentList 的冒泡 click（分组切换 / 条目点击）之前截断传播，stopPropagation
// 语义与内联形态等价（document 层的 action-dispatcher 做不到中间层截断，
// 属其头注明示不收编的场景）。
agentList.addEventListener('click', (event) => {
  const button = event.target.closest?.('[data-workspace-more]');
  if (!button) return;
  event.stopPropagation();
  window.onSidebarSessionCtxMenu(event, button);
}, true);

/**
 * 侧栏会话 pin 图标（正立图钉）。斜态（未待办）由 CSS rotate 呈现。
 */
const SIDEBAR_PIN_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1"/></svg>';

/**
 * 侧栏会话 pin 的点击：切换待办（与右键菜单「设为/取消待办」同一条
 * dispatchCtxAction('todo-session') 链路，含乐观更新与失败回滚）。
 * 斜 pin（未待办）点击 → 设为待办；已待办 pin 的 tap 分支由
 * sidebar-pin-color 状态机转调到这里。乐观更新只改会话内容不进
 * 侧栏渲染签名，需清签名强制立即重渲。
 */
window.onSidebarSessionPinClick = function(event, el) {
  if (event) event.stopPropagation();
  const ctxEl = el?.closest('[data-ctx-role]');
  if (!ctxEl) return;
  const ns = ctxEl.dataset.ctxNs;
  const sessionId = ctxEl.dataset.ctxSessionId || ctxEl.dataset.ctxId;
  if (!ns || !sessionId) return;
  dispatchCtxAction('todo-session', {
    role: ctxEl.dataset.ctxRole,
    ns,
    id: sessionId,
    sessionId,
    variant: ctxEl.dataset.ctxVariant || 'default',
  });
  lastAgentListRenderSignature = '';
  renderAgentList();
};

function renderSidebarChildItems(entries, ownerAgentId) {
  const visibleEntries = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const remoteEntries = typeof getRemoteSidebarProjection === 'function'
    ? getRemoteSidebarProjection(ownerAgentId)
    : [];
  const projectedEntries = [...visibleEntries, ...remoteEntries];
  if (projectedEntries.length === 0) return '';

  // Local and remote runtimes share this projection. Their origin remains in
  // entry metadata, while the default sidebar only renders workspace → project
  // → running session.


  const renderItem = (entry) => {
    const active = isRuntimeItemActive(entry.runtimeId, entry);
    const disconnected = isSidebarRuntimeDisconnected(entry);
    const remoteDisabled = entry.source === 'remote' && disconnected;
    const calling = !disconnected && isRuntimeCalling(entry.runtimeId);
    const restarting = restartingRuntimeIds.has(entry.runtimeId);
    // ADR-0019：挂起等待（idle + 上次 outcome 为 suspended），显示静止绿灯；
    // calling / restarting 优先于挂起显示
    const suspended = !calling && !disconnected && !restarting && isRuntimeSuspended(entry.runtimeId);
    const retiring = !!entry.replacementMutation || entry.sidebarOperation?.type === 'archive-close';
    const replacementPending = entry.pendingReplacement === true;
    const operationPending = entry.pendingOperation === true;
    const deleting = entry.deleting === true;
    const operationDegraded = entry.sidebarOperation?.phase === 'degraded';
    const targetStartDegraded = operationDegraded && entry.sidebarOperation?.errorCode === 'target_runtime_stopped';
    // 挂起优先于"刚刚完成"：挂起是持续等待态，不是终态收尾
    const justFinished = !calling && !suspended && !disconnected && !restarting && _recentlyFinishedRuntimes.has(entry.runtimeId);
    // 线程宿主会话（coder）的 replacement 是线程内上下文接力（archive-close
    // / delete 仍是真实关闭）；isThreadRelay 用于区分失败文案与关闭过程文案。
    const isThreadRelay = retiring
      && !deleting
      && !!entry.replacementMutation
      && typeof window.isThreadHostAgentId === 'function'
      && window.isThreadHostAgentId(ownerAgentId, entry.sessionId);
    const zh = currentLanguage === 'zh';
    // 接续过程提示统一由顶栏「上下文接力中…」承载：线程宿主的 replacement
    // 不再叠加条目内文字标签（占位条目的断连视觉已足够）；失败场景的异常
    // 反馈不属于过程提示，保留。
    const retiringLabel = targetStartDegraded
      ? (isThreadRelay ? (zh ? '接力会话启动未完成' : 'Relay session start incomplete') : (zh ? '新会话启动未完成' : 'New session start incomplete'))
      : operationDegraded
        ? (isThreadRelay ? (zh ? '交接收尾未完成' : 'Relay close incomplete') : (zh ? '关闭未完成' : 'Close incomplete'))
        : (isThreadRelay ? '' : (zh ? '正在关闭' : 'Closing'));
    const itemClass = [
      'agent-item',
      'agent-runtime-item',
      active ? 'active' : '',
      disconnected ? 'disconnected' : '',
      remoteDisabled ? 'remote-entry-disabled' : '',
      calling ? 'calling' : '',
      suspended ? 'suspended' : '',
      restarting ? 'restarting' : '',
      retiring ? 'retiring' : '',
      replacementPending ? 'replacement-pending' : '',
      operationPending ? 'operation-pending' : '',
      deleting ? 'retiring' : '',
      justFinished ? 'just-finished' : '',
    ].filter(Boolean).join(' ');
    return `
      <div
        class="${itemClass}"
        data-agent-id="${escapeHtml(entry.runtimeId)}"
        ${entry.threadId ? `data-thread-id="${escapeHtml(entry.threadId)}"` : ''}
        data-agent-disabled="${replacementPending || operationPending || deleting || remoteDisabled ? 'true' : 'false'}"
        data-agent-prebuilt="false"
        data-agent-context-menu="${entry.contextMenuEnabled ? 'true' : 'false'}"
        data-ctx-role="runtime" data-ctx-ns="${escapeHtml(entry.hostNamespaceId || entry.ownerId || '')}" data-ctx-id="${escapeHtml(entry.runtimeId)}" data-ctx-variant="${escapeHtml(entry.source || '')}" data-ctx-session-id="${escapeHtml(entry.sessionId || '')}" ${entry.threadId ? `data-ctx-thread-id="${escapeHtml(entry.threadId)}"` : ''}
        ${entry.source === 'remote' ? '' : 'draggable="true" ondragstart="onSidebarSessionDragStart(event, this)"'}
        onpointermove="onSidebarItemPointerMove(event, this)" onpointerleave="onSidebarItemPointerLeave(this)"
      >
        ${entry.source !== 'remote' ? `<span class="agent-session-pin-slot">${calling
          ? '<span class="agent-session-pin-spinner" title="' + escapeHtml(zh ? '会话运行中' : 'Session is running') + '"></span>'
          : (suspended
            ? '<span class="agent-session-pin-suspended" title="' + escapeHtml(zh ? '挂起中：等待后台任务唤醒' : 'Suspended: waiting for background tasks') + '"></span>'
            : (justFinished
              ? '<span class="agent-session-pin-finished" title="' + escapeHtml(zh ? '刚刚完成' : 'Just finished') + '"></span>'
              : (entry.todo === true
                ? `<button class="agent-session-pin is-set pin-color-${escapeHtml(entry.todoColor || 'white')}" type="button" data-todo-color="${escapeHtml(entry.todoColor || 'white')}" title="${escapeHtml(zh ? '点击取消待办，长按上拖换色' : 'Click to remove TODO, drag up for color')}" onpointerdown="onSidebarPinPointerDown(event, this)">${SIDEBAR_PIN_SVG}</button>`
                : `<button class="agent-session-pin is-slanted" type="button" title="${escapeHtml(zh ? '点击设为待办，长按上拖选色' : 'Click to set TODO, drag up for color')}" onpointerdown="onSidebarPinPointerDown(event, this)">${SIDEBAR_PIN_SVG}</button>`)))}</span>`
        : ''}
        <div class="agent-line">
          <div class="agent-name${SIDEBAR_HANGING_PUNCT_RE.test(entry.name || entry.runtimeId) ? ' hanging-punct' : ''}">${escapeHtml(entry.name || entry.runtimeId)}${retiring ? `<span class="agent-runtime-transition-label">${escapeHtml(retiringLabel)}</span>` : deleting ? `<span class="agent-runtime-transition-label">${escapeHtml(operationDegraded ? (currentLanguage === 'zh' ? '删除未完成' : 'Delete incomplete') : (currentLanguage === 'zh' ? '正在删除' : 'Deleting'))}</span>` : ''}</div>
          ${entry.contextMenuEnabled ? `<button class="agent-runtime-more" type="button" title="${escapeHtml(zh ? '更多操作' : 'More actions')}" onclick="onSidebarSessionCtxMenu(event, this)"><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><circle cx="3" cy="7" r="1.3"/><circle cx="7" cy="7" r="1.3"/><circle cx="11" cy="7" r="1.3"/></svg></button>` : ''}
        </div>
      </div>
    `;
  };

  // Group entries by project identity when present.
  // Entries are already sorted by createdAt desc; group order follows
  // the first entry encountered, so the most recently active project appears first.
  const hasProjects = projectedEntries.some((e) => e.projectName || e.projectDir || e.projectKey);
  const directEntries = projectedEntries.filter((entry) =>
    !entry.projectName && !entry.projectDir && !entry.projectKey
  );
  const projectEntries = projectedEntries.filter((entry) =>
    entry.projectName || entry.projectDir || entry.projectKey
  );

  if (!hasProjects) {
    return `<div class="agent-runtime-list">${directEntries.map(renderItem).join('')}</div>`;
  }

  const groups = [];
  const groupIndex = new Map();
  for (const entry of projectEntries) {
    // projectKey is the stable identity; projectName is presentation only.
    // This keeps same-named local and remote directories separate while
    // allowing the renderer to remain unaware of their origin.
    const key = entry.projectKey || entry.projectDir || entry.projectName || '';
    if (!groupIndex.has(key)) {
      groupIndex.set(key, groups.length);
      groups.push({ projectKey: key, projectName: entry.projectName || '', projectDir: entry.projectDir || '', projectId: entry.projectId || '', items: [] });
    }
    groups[groupIndex.get(key)].items.push(entry);
  }

  // Sort groups alphabetically by display label; items within each
  // group keep their existing (time-desc) order.
  groups.sort((a, b) => {
    const la = a.projectName || '';
    const lb = b.projectName || '';
    return la.localeCompare(lb, undefined, { sensitivity: 'base', numeric: true });
  });

  return `<div class="agent-runtime-list">${directEntries.map(renderItem).join('')}${groups.map((group) => {
    const label = group.projectName || (currentLanguage === 'zh' ? '未分组' : 'Ungrouped');
    const projectKey = group.projectKey || group.projectDir || group.projectName || label;
    const collapsed = _collapsedProjectGroups.has(projectKey);
    const enterLabel = currentLanguage === 'zh' ? '进入' : 'Enter';
    const isWorkGroup = ownerAgentId === 'work-group';
    // ph 组一律可进入（ADR-0012 决策 1）：远程目录组进入后以 remoteOnly
    // 视图呈现其历史会话（见 phSwitchProject）；work-group 仍按本地会话判定。
    // 项目组按稳定 projectId 进入；目录组按绑定目录进入，不能把二者身份混用。
    const canEnter = isWorkGroup
      ? group.items.some((entry) => entry.source !== 'remote')
      : (ownerAgentId === 'programming-helper'
        ? (group.projectId ? group.items.length > 0 : !!group.projectDir && group.items.length > 0)
        : (!!group.projectDir && group.items.length > 0));
    // For work-group: enter navigates to the group chat by chatId.
    // For programming-helper: enter navigates to the workspace surface and
    // scrolls to / expands the corresponding project card.
    const enterType = isWorkGroup ? 'wg' : (group.projectId ? 'ph-project' : 'ph');
    const enterTarget = isWorkGroup ? projectKey : (group.projectId || group.projectDir || label);
    return `<div class="agent-runtime-project-group${collapsed ? ' collapsed' : ''}" data-project-key="${escapeHtml(projectKey)}">` +
      `<div class="agent-runtime-project-header" title="${escapeHtml(group.projectDir || label)}">` +
        `<span class="project-collapse-arrow"></span>` +
        `<span class="project-collapse-label">${escapeHtml(label)}</span>` +
        (canEnter ? `<button class="project-enter-btn" data-enter-type="${enterType}" data-enter-target="${escapeHtml(enterTarget)}" title="${escapeHtml(enterLabel)}">${escapeHtml(enterLabel)}</button>` : '') +
      `</div>` +
      `<div class="agent-runtime-project-items">${group.items.map(renderItem).join('')}</div>` +
    `</div>`;
  }).join('')}</div>`;
}

const AGENT_ICONS = {
  'home': 'home.svg',
  'claw-guide': 'claw-guide.svg',
  'flow-workspace': 'flow-workspace.svg',
  'feature-repository': 'feature-repository.svg',
  'feature-creator': 'feature-creator.svg',
  'agent-studio': 'programming-helper.svg',
  'qqbot': 'qqbot.svg',
  'dispatch-console': 'dispatch-console.svg',
  'programming-helper': 'programming-helper.svg',
  'coder': 'programming-helper.svg',
  'work-group': 'work-group.svg',
  'memo': 'memo.svg',
};

function getAgentIconHtml(agentId) {
  const iconFile = AGENT_ICONS[agentId];
  if (!iconFile) return '';
  return `<img class="agent-icon" src="images/agent-icons/${iconFile}" alt="" draggable="false" />`;
}

function renderAgentGroup(listElement, groupElement, countElement, agents, options = {}) {
  groupElement.style.display = agents.length ? '' : 'none';
  countElement.textContent = String(agents.length);
  listElement.innerHTML = renderAgentItems(agents, options);
}

function renderAgentItems(agents, { prebuilt = false } = {}) {
  return agents.map((agent) => {
    const active = isAgentActive(agent);
    const connected = agent.connected !== false;
    const pending = pendingPrebuiltAgentIds.has(agent.id);
    const runtimeId = getAgentRuntimeId(agent);
    const idle = prebuilt && !pending && !runtimeId;
    const calling = !prebuilt
      && connected
      && !pending
      && !idle
      && (isRuntimeCalling(runtimeId) || agent.callActive === true);
    const justFinished = !prebuilt && !calling && connected && !idle && _recentlyFinishedRuntimes.has(runtimeId);
    const itemClass = [
      'agent-item',
      active ? 'active' : '',
      connected || prebuilt ? '' : 'disconnected',
      pending ? 'pending' : '',
      idle ? 'idle' : '',
      calling ? 'calling' : '',
      justFinished ? 'just-finished' : '',
    ].filter(Boolean).join(' ');
    const hasRuntime = !!runtimeId;
    // 工作空间条目操作面门控（ADR-0050）：prebuilt 分支 = workspace 菜单
    // 非空（右键与 ⋯ 按钮同一条件，事实驱动）；旧「非 workspace 形态且有
    // runtime」门控对 prebuilt 分支退役。非 prebuilt（orphan / external）
    // 分支不动，仍走静态 agent-context-menu。
    const workspaceMenuEnabled = prebuilt
      ? getCtxMenuItems('workspace', agent.id, agent.source || 'prebuilt', agent.id).length > 0
      : false;
    const contextMenuEnabled = prebuilt ? workspaceMenuEnabled : !!runtimeId;
    const childEntries = prebuilt ? collectRuntimeEntriesForPrebuilt(agent, allAgents) : [];
    // 侧栏会话区呈现策略（ADR-0050，服务端合流字段）：生效值 hidden 时该
    // APP 条目下不渲染会话子树——本地条目与远程投影同属该 APP 的会话呈现，
    // 一并隐藏。hasActiveRuntime 同步钳制，避免高亮 class 残留在无子树的条目上。
    const sessionsHidden = prebuilt && agent.sidebarSessionsPolicy === 'hidden';
    const hasActiveRuntime = prebuilt && !sessionsHidden && childEntries.some((entry) => isRuntimeItemActive(entry.runtimeId, entry));
    if (prebuilt) {
      const childrenHtml = sessionsHidden ? '' : renderSidebarChildItems(childEntries, agent.id);
      const entryClass = ['agent-entry', hasActiveRuntime ? 'has-active-runtime' : ''].filter(Boolean).join(' ');
      return `
        <div class="${entryClass}">
          <div
            class="${itemClass}"
            data-agent-id="${escapeHtml(agent.id)}"
            data-agent-prebuilt="true"
            data-agent-context-menu="${contextMenuEnabled ? 'true' : 'false'}"
            data-ctx-role="workspace" data-ctx-ns="${escapeHtml(agent.id)}" data-ctx-id="${escapeHtml(agent.id)}" data-ctx-variant="${escapeHtml(agent.source || 'prebuilt')}"
          >
            <div class="agent-line">
              ${getAgentIconHtml(agent.id)}
              <div class="agent-name">${escapeHtml(agent.name || agent.id)}</div>
              ${contextMenuEnabled ? `<button class="agent-runtime-more" type="button" data-workspace-more="1" title="${escapeHtml(currentLanguage === 'zh' ? '更多操作' : 'More actions')}"><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><circle cx="3" cy="7" r="1.3"/><circle cx="7" cy="7" r="1.3"/><circle cx="11" cy="7" r="1.3"/></svg></button>` : ''}
            </div>
          </div>
          ${childrenHtml}
        </div>
      `;
    }
    return `
      <div
        class="${itemClass}"
        data-agent-id="${escapeHtml(agent.id)}"
        data-agent-prebuilt="false"
        data-agent-context-menu="${contextMenuEnabled ? 'true' : 'false'}"
      >
        <div class="agent-line">
          <div class="agent-name">${escapeHtml(agent.name || agent.id)}</div>
        </div>
      </div>
    `;
  }).join('');
}

async function waitForPrebuiltRuntimeSession(agentId, attempts = 20, options = {}) {
  const expectedRuntimeId = normalizeAgentIdentity(options.previousRuntimeId);
  const expectedSessionId = String(options.expectedSessionId || '').trim();
  // 归属透传：本探测只用来确认新 runtime 是否注册，但服务端会顺带投影
  // workspace_sessions；不带归属时它会按目录语义回切片，合并进 allAgents
  // 后把项目列表换掉。
  const ownershipPayload = typeof getPhSessionOwnershipParams === 'function'
    ? getPhSessionOwnershipParams(
      (Array.isArray(allAgents) ? allAgents : []).find((agent) => agent.id === agentId) || null,
    )
    : {};
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const agents = await invoke('get_connected_agents', ownershipPayload);
    const findConnectedChild = (list) => list.find((agent) => {
      if (agent.source !== 'child' || getParentAgentId(agent) !== agentId) return false;
      const runtimeId = normalizeAgentIdentity(getAgentRuntimeId(agent));
      if (!runtimeId) return false;
      if (expectedRuntimeId && runtimeId === expectedRuntimeId) return false;
      // When we know the target session ID, require the child to either
      // match it or have no session set yet (still initializing).
      if (expectedSessionId) {
        const childSessionId = String(getActiveSessionId(agent) || '').trim();
        if (childSessionId && childSessionId !== expectedSessionId) return false;
      }
      return agent.connected === true;
    });
    const matched = findConnectedChild(agents);
    if (matched) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const verify = await invoke('get_connected_agents', ownershipPayload);
      const still = findConnectedChild(verify);
      if (still) {
        // Merge verify into allAgents without clobbering workspace data.
        // get_connected_agents returns empty workspace_state, workspace_data,
        // and workspace_sessions.sessions for prebuilt agents, so we must
        // preserve the rich data loaded by loadAgentDetail.
        const prevById = new Map(allAgents.map(a => [a.id, a]));
        allAgents = verify.map(agent => {
          const prev = prevById.get(agent.id);
          if (!prev) return agent;
          return {
            ...agent,
            workspace_state: prev.workspace_state || agent.workspace_state,
            workspace_data: prev.workspace_data || agent.workspace_data,
            workspace_sessions: prev.workspace_sessions || agent.workspace_sessions,
          };
        });
        return still;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for runtime session: ${agentId}`);
}

async function waitForTargetRuntimeSession(agentId, sessionId, attempts = 50, options = {}) {
  // ADR-0014 Phase 1：就绪探测实现收敛到 navigation-core（轻量 runtime_status
  // 端点轮询）。此处保留签名兼容既有调用方（session-mutation、
  // sidebar-operations 的 waitForSidebarTargetRuntime）。
  if (typeof window.NavigationCore?.waitForRuntimeReady !== 'function') {
    throw new Error('NavigationCore runtime readiness helper is unavailable');
  }
  return window.NavigationCore.waitForRuntimeReady({
    agentId,
    sessionId,
    attempts,
    operationId: String(options.operationId || '').trim(),
  });
}

function resolveFocusedAgentAfterRefresh(agents = allAgents) {
  const list = Array.isArray(agents) ? agents : [];
  const isConnected = (agent) => agent.connected !== false;
  const hasPendingInput = (agent) =>
    (agent.pending_input_count ?? agent.pendingInputCount ?? 0) > 0;
  const pendingAgent = list.find((agent) => isConnected(agent) && hasPendingInput(agent));
  // 工作空间首页（如 coder APP）停留在入口首页时按条目记忆恢复；
  // 进入过会话浏览则该键已被清除，回落到 runtime 记忆（既有行为）。
  let rememberedEntryId = null;
  try { rememberedEntryId = localStorage.getItem('claw:lastFocusedEntryId'); } catch { /* ignore */ }
  if (rememberedEntryId) {
    const rememberedEntry = list.find((agent) => isConnected(agent) && agent.id === rememberedEntryId);
    if (rememberedEntry) return rememberedEntry;
  }
  let rememberedId = null;
  try { rememberedId = localStorage.getItem('claw:lastFocusedRuntimeId'); } catch { /* ignore */ }
  const rememberedAgent = rememberedId
    ? list.find((agent) => (
      isConnected(agent)
      && (
        agent.id === rememberedId
        || getAgentRuntimeId(agent) === rememberedId
        || normalizeAgentIdentity(getRuntimeId(agent)) === normalizeAgentIdentity(rememberedId)
      )
    ))
    : null;
  return pendingAgent || rememberedAgent || list.find(isConnected) || null;
}

// Synchronous rendering stays classic. Async snapshots are owned by ESM; these
// adapters resolve not-yet-migrated helpers at call time, not during module load.
function createAgentSnapshotLoaderHost() {
  return {
    state: {
      get agents() { return allAgents; }, set agents(value) { allAgents = value; },
      get inFlight() { return loadAgentsInFlight; }, set inFlight(value) { loadAgentsInFlight = value; },
      get focused() { return focusedAgentId; }, set focused(value) { focusedAgentId = value; },
      get suppressRender() { return suppressSidebarRerender; },
      get activePanel() { return typeof activeFeaturePanel === 'undefined' ? undefined : activeFeaturePanel; },
    },
    get detailIds() { return loadedAgentDetailIds; },
    now: () => performance.now(),
    captureToken: () => typeof captureSidebarSnapshotToken === 'function' ? captureSidebarSnapshotToken() : null,
    isTokenCurrent: (token) => typeof isSidebarSnapshotTokenCurrent !== 'function' || isSidebarSnapshotTokenCurrent(token),
    ownership: (agent) => typeof getPhSessionOwnershipParams === 'function' ? getPhSessionOwnershipParams(agent) : {},
    connected: (ownership) => invoke('get_connected_agents', ownership),
    viewer: () => fetch('/api/agents'),
    loadLayout: () => window.ClawSidebarLayout?.load(),
    loadProjects: () => typeof ensurePhProjectEntitiesLoaded === 'function' ? ensurePhProjectEntitiesLoaded() : undefined,
    schedule: (callback, delay) => window.setTimeout(callback, delay),
    diagnostic: (event) => { if (typeof queueSidebarDiagnosticEvent === 'function') queueSidebarDiagnosticEvent(event); },
    runtimeId: (agent) => getRuntimeId(agent),
    agentRuntimeId: (agent) => getAgentRuntimeId(agent),
    logicalId: (agent) => getLogicalAgentId(agent),
    mergeSessions: (previous, incoming, id) => typeof mergeWorkspaceSessionSnapshots === 'function'
      ? mergeWorkspaceSessionSnapshots(previous, incoming, id) : previous,
    reconcileStops: (agents) => { if (typeof reconcilePendingRuntimeStops === 'function') reconcilePendingRuntimeStops(agents); },
    pruneCallStates: (agents) => {
      const active = new Set(collectActiveCallRuntimeIds(agents));
      for (const key of _agentCallActive.keys()) if (!active.has(key)) _agentCallActive.delete(key);
      for (const key of Array.from(_recentlyFinishedRuntimes)) if (!active.has(key)) _recentlyFinishedRuntimes.delete(key);
    },
    renderList: () => renderAgentList(),
    renderPanel: () => renderFeaturePanel(),
    refreshCalls: (agents) => refreshAgentCallStates(agents),
    isRemote: (id) => isRemoteNamespaceAgentId(id),
    fallback: () => resolveWorkspaceFallbackAgentId(),
    loadDetail: (id) => window.loadAgentDetail(id),
    selectSurface: (id, options) => selectWorkspaceSurface(id, options),
    preferHome: (agent) => setPreferredUnitMode('home', agent),
    resolveFocus: (agents) => resolveFocusedAgentAfterRefresh(agents),
    clickPrebuilt: (id) => window.handlePrebuiltAgentClick(id),
    loadData: (id) => loadAgentData(id),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    log: (...args) => console.log(...args),
  };
}

// Desktop notification -> modules/desktop-notify.js

// call 状态链路的 runtime 全集：本地已连接 runtime + 在线远程条目（仅在线，
// 断开条目不参与轮询，其残留键由清理循环回收）。轮询与清理共用同一集合——
// 远程 key 不入集会被每轮 poll 当孤儿清掉，与聚焦会话的 chat 轮询写键形成
// 拉锯（远程会话发送按钮横跳、侧栏缺转圈动画的根因）。
// Shared lexical containers retain their classic initialization and const
// identity. Reconciliation and request coalescing live in the classic sync
// owner composed in app-main; the ESM host is a late-bound thin adapter.
function createAgentCallStatesHost() {
  return {
    calling: _agentCallActive,
    suspended: _agentSuspended,
    interrupting: _interruptSuppression,
    finished: _recentlyFinishedRuntimes,
    agents: () => allAgents,
    currentRuntimeId: () => currentRuntimeAgentId,
    runtimeId: (agent) => getAgentRuntimeId(agent),
    remoteEntries: () => typeof getVisibleRemoteEntries === 'function' ? getVisibleRemoteEntries() : [],
    normalize: (value) => normalizeAgentIdentity(value),
    resolveCalling: (payload) => resolveNotificationCallingState(payload),
    isSuspended: (payload) => isSuspendedNotificationPayload(payload),
    markStarted: (id) => _markAgentCallStartedForNotify(id),
    syncActionButton: () => { if (typeof _syncPersistentActionButton === 'function') _syncPersistentActionButton(); },
    isSseActive: () => typeof isSseActive === 'function' && isSseActive(),
    isRemote: (id) => typeof isRemoteNamespaceAgentId === 'function' && isRemoteNamespaceAgentId(id),
    fetch: (...args) => fetch(...args),
    now: () => Date.now(),
    lastRefresh: () => lastCallStateRefreshAt,
    setLastRefresh: (value) => { lastCallStateRefreshAt = value; },
    render: () => renderAgentList(),
  };
}

let lastAgentListRenderSignature = '';

// 右键 / ⋯ 菜单打开期间抑制全量重建（对齐布局拖拽 isInteracting 与重命名
// .editing 守卫）：菜单锚定的条目被 innerHTML 替换会撤走锚点、丢 hover 内联
// 状态，表现为菜单使用中的视觉闪动。抑制不是丢弃——置位 pending 标志，菜
// 单关闭后的下一次 renderAgentList 调用（轮询 tick / SSE 事件，≤3s）立即
// 补上被延迟的重建（签名机制会判定是否真的需要重建）。
const CONTEXT_MENU_ELEMENT_IDS = [
  'ctx-menu', 'agent-context-menu',
  'compact-context-menu', 'project-context-menu', 'feature-repo-context-menu',
];
let _sidebarRenderSuppressedByMenu = false;

function anyContextMenuOpen() {
  for (const id of CONTEXT_MENU_ELEMENT_IDS) {
    if (document.getElementById(id)?.classList?.contains('open')) return true;
  }
  return false;
}

function getAgentListRenderSignature() {
  // 等待表面高亮事实：无 runtime 态的条目高亮与宿主让位按等待会话身份
  // 判定（isRuntimeItemActive / isAgentActive 的等待分支，依赖
  // getActiveThreadInputTarget）。等待目标出现 / 切换会话 / 消失必须改变
  // 签名——enterThreadAwaitSurface 在 switchAgent 渲染之后才落
  // activeConversation，靠这里放行其后的重渲，否则选中态停在宿主节点。
  const awaitTarget = typeof window.getActiveThreadInputTarget === 'function'
    ? window.getActiveThreadInputTarget()
    : null;
  const awaitHighlight = awaitTarget
    ? {
      agentId: normalizeAgentIdentity(awaitTarget.agentId),
      sessionId: String(awaitTarget.sessionId || '').trim(),
    }
    : null;
  return JSON.stringify({
    awaitHighlight,
    sidebarLayout: window.ClawSidebarLayout?.signature(),
    phProjectNames: (window.ClawFW?.phProjectEntities?.projects || [])
      .map((project) => ({ id: project.id, name: project.name })),
    language: currentLanguage,
    focusedAgentId: normalizeAgentIdentity(focusedAgentId),
    currentRuntimeAgentId: normalizeAgentIdentity(currentRuntimeAgentId),
    pending: Array.from(pendingPrebuiltAgentIds || []).sort(),
    restarting: Array.from(restartingRuntimeIds || []).sort(),
    recentlyFinished: Array.from(_recentlyFinishedRuntimes).sort(),
    sidebarOperationVersion: typeof getSidebarOperationVersion === 'function' ? getSidebarOperationVersion() : 0,
    threadHeads: allAgents.flatMap(agent => agent.sidebar_threads || []).map((thread) => ({
      threadId: thread.threadId,
      headSessionId: thread.headSessionId,
      title: thread.title,
      headSessionTitle: thread.headSessionTitle,
      headProjectId: thread.headProjectId,
      headProjectDir: thread.headProjectDir,
      status: thread.status,
      archivedAt: thread.archivedAt,
      deleting: thread.deleting,
      sessionIds: thread.sessionIds,
      handoffStartedAt: Number(thread.handoffStartedAt) || 0,
    })),
    remoteSidebarProjectionVersion: typeof getRemoteSidebarProjectionVersion === 'function'
      ? getRemoteSidebarProjectionVersion()
      : 0,
    sessionReplacements: typeof listSidebarOperations === 'function'
      ? listSidebarOperations().map((item) => ({ ...item }))
      : [],
    // 远程条目不在 allAgents，本地 agents 字段覆盖不到；calling 变化必须
    // 独立进签名，否则 renderAgentList 因签名不变提前返回，远程会话的
    // 转圈动画不会出现。
    remoteCalling: (typeof getVisibleRemoteEntries === 'function'
      ? getVisibleRemoteEntries()
      : []
    ).map((entry) => ({
      runtimeId: entry.runtimeId,
      calling: _agentCallActive.get(entry.runtimeId) === true,
      suspended: typeof isRuntimeSuspended === 'function' && isRuntimeSuspended(entry.runtimeId) === true,
    })),
    agents: (Array.isArray(allAgents) ? allAgents : []).map((agent) => {
      const rid = normalizeAgentIdentity(getAgentRuntimeId(agent));
      return {
        id: normalizeAgentIdentity(agent?.id),
        runtimeId: rid,
        source: agent?.source || '',
        parentId: normalizeAgentIdentity(getParentAgentId(agent)),
        connected: agent?.connected !== false,
        status: agent?.status || '',
        // on-demand APP 的存在性（服务端合流事实）：工作空间设置覆盖或线程
        // 生灭翻转时必须触发重渲，否则条目出现/消失滞后到下一次状态变化。
        sidebarVisible: agent?.visibility === 'on-demand' ? agent?.sidebarVisible === true : undefined,
        // 侧栏会话区呈现策略（ADR-0050，服务端合流事实）：用户经 ⋯/右键切换
        // 可见性时生效值翻转必须触发重渲，否则会话子树出现/消失滞后。
        sidebarSessionsPolicy: agent?.sidebarSessionsPolicy || '',
        callActive: agent?.callActive === true,
        calling: rid !== '' && _agentCallActive.get(rid) === true,
        suspended: rid !== '' && isRuntimeSuspended(rid) === true,
        activeSessionId: normalizeAgentIdentity(getActiveSessionId(agent)),
        // Project and directory ownership determine the child runtime's sidebar
        // group. Include both in the render signature so a same-runtime metadata
        // refresh cannot be hidden by the render dedupe.
        projectId: String(agent?.project_id || agent?.projectId || '').trim(),
        sourceSessionId: String(agent?.source_session_id || '').trim(),
        openDirectory: String(agent?.open_directory || agent?.openDirectory || '').trim(),
        // 宿主合成 runtime 与 child 使用不同 wire 字段，同样参与归属投影。
        activeSessionProjectId: String(agent?.active_workspace_session_project_id || '').trim(),
        activeSessionDirectory: String(agent?.active_workspace_session_dir || '').trim(),
        workspaceRevision: Number(agent?.workspace_sessions?.revision) || 0,
        sessions: (agent?.workspace_sessions?.sessions || []).map((session) => ({
          id: session.id, title: session.title, formId: session.formId, agentName: session.agentName,
        })),
        displayName: agent?.active_workspace_display_name || '',
        sessionTitle: agent?.active_workspace_session_title || '',
      };
    }),
  });
}

function renderAgentList() {
  if (window.ClawSidebarLayout?.isInteracting()
    || document.querySelector('.agent-runtime-item.editing')) return;
  if (anyContextMenuOpen()) {
    _sidebarRenderSuppressedByMenu = true;
    return;
  }
  _sidebarRenderSuppressedByMenu = false;
  const nextSignature = getAgentListRenderSignature();
  if (nextSignature === lastAgentListRenderSignature) {
    updateCurrentAgentChrome();
    return;
  }
  lastAgentListRenderSignature = nextSignature;
  const groups = groupConnectedAgents(allAgents);
  window.ClawSidebarLayout.render(groups);
  renderAgentGroup(externalAgentList, externalGroup, externalCount, groups.external);

  updateCurrentAgentChrome();
}

agentList.addEventListener('click', async (event) => {
  // Handle category group collapse/expand toggle (系统空间, 工作群, etc.).
  const categoryHeader = event.target.closest('.agent-group-header');
  if (categoryHeader) {
    const groupEl = categoryHeader.closest('.agent-group');
    if (groupEl?.id) window.ClawSidebarLayout.toggle(groupEl.id);
    return;
  }

  // Handle "enter" button click on project group headers.
  const enterBtn = event.target.closest('.project-enter-btn');
  if (enterBtn) {
    const enterType = enterBtn.dataset.enterType;
    const enterTarget = enterBtn.dataset.enterTarget;
    if (enterType === 'wg') {
      await window.handlePrebuiltAgentClick('work-group');
      if (window.WorkGroupUI && typeof window.WorkGroupUI.selectChat === 'function') {
        window.WorkGroupUI.selectChat(enterTarget);
      }
    } else if (enterType === 'ph' || enterType === 'ph-project') {
      // Navigate to programming-helper workspace, then switch the selected directory/project.
      const target = enterTarget || '';
      await window.handlePrebuiltAgentClick('programming-helper');
      if (target && typeof window.phSwitchProject === 'function') {
        const targetId = enterType === 'ph-project'
          ? target
          : 'dir:' + target.replace(/\\/g, '/').toLowerCase();
        await window.phSwitchProject(targetId);
      }
    }
    return;
  }

  // Only the project chevron and name toggle the group; the rest of the
  // header row is intentionally inert so it does not act like a full-width tab.
  const projectToggle = event.target.closest('.project-collapse-arrow, .project-collapse-label');
  if (projectToggle) {
    const projectHeader = projectToggle.closest('.agent-runtime-project-header');
    const groupEl = projectHeader?.closest('.agent-runtime-project-group');
    if (groupEl) {
      const key = groupEl.dataset.projectKey;
      if (key) {
        if (_collapsedProjectGroups.has(key)) {
          _collapsedProjectGroups.delete(key);
          groupEl.classList.remove('collapsed');
        } else {
          _collapsedProjectGroups.add(key);
          groupEl.classList.add('collapsed');
        }
      }
    }
    return;
  }

  const item = event.target.closest('.agent-item');
  if (!item) return;
  if (item.classList.contains('editing')) return;

  const agentId = item.dataset.agentId;
  if (!agentId) return;
  if (item.dataset.agentDisabled === 'true') return;

  if (item.dataset.agentPrebuilt === 'true') {
    await window.handlePrebuiltAgentClick(agentId);
    // Re-entering the programming-helper workspace must load the persisted
    // browsing slice explicitly. Its cached workspace_sessions may still hold
    // another ownership's slice (default directory vs. the project the user
    // left on), while the browsing target lives in local UI state and is not
    // part of handlePrebuiltAgentClick's workspace navigation.
    if (agentId === 'programming-helper'
      && typeof ensurePhProjectEntitiesLoaded === 'function'
      && typeof getPhSessionOwnershipParams === 'function'
      && typeof phLoadProjectSessions === 'function') {
      await ensurePhProjectEntitiesLoaded();
      const host = (Array.isArray(allAgents) ? allAgents : [])
        .find((agent) => agent.id === 'programming-helper');
      const ownership = getPhSessionOwnershipParams(host);
      if (ownership.projectId) {
        await phLoadProjectSessions({ projectId: ownership.projectId });
      } else {
        const openDirectory = ownership.projectDir
          || String(getAgentWorkspaceState(host)?.openDirectory || '').trim();
        if (openDirectory) await phLoadProjectSessions({ projectDir: openDirectory });
      }
    }
    return;
  }

  const threadId = String(item.dataset.threadId || '').trim();
  if (threadId && typeof window.openConversationTarget === 'function') {
    const entry = (Array.isArray(allAgents) ? allAgents : []).find((agent) => (
      String(agent?.runtime_session_id || agent?.runtimeSessionId || agent?.id || '') === agentId
    ));
    await window.openConversationTarget({
      agentId: entry?.parent_id || entry?.agentId,
      threadId,
      sessionId: entry?.active_workspace_session_id,
    });
    return;
  }
  await window.switchAgent(agentId);
});

agentList.addEventListener('contextmenu', (event) => {
  const item = event.target.closest('.agent-item');
  if (!item) return;
  if (item.classList.contains('editing')) return;
  if (item.dataset.agentContextMenu !== 'true') return;

  // ── Generic ctx-menu: check for data-ctx-* on runtime items ──
  const ctxEl = item.closest('[data-ctx-role]');
  if (ctxEl) {
    const role = ctxEl.dataset.ctxRole;
    const ns = ctxEl.dataset.ctxNs;
    const id = ctxEl.dataset.ctxId;
    const variant = ctxEl.dataset.ctxVariant || 'default';
    const sessionId = ctxEl.dataset.ctxSessionId || '';
    const threadId = ctxEl.dataset.ctxThreadId || '';
    const items = getCtxMenuItems(role, ns, variant, id, sessionId, threadId);
    if (items.length > 0) {
      event.preventDefault();
      window.closeCtxMenu();
      closeAgentContextMenu();
      closeCompactMenu();
      closeProjectContextMenu();
      window.showCtxMenu(event.clientX, event.clientY, items, { role, ns, id, variant, sessionId, threadId });
      return;
    }
  }

  const agentId = item.dataset.agentId;
  if (!agentId) return;

  event.preventDefault();
  window.openAgentActions(event, agentId);
});

// ── P2 bootstrap 消费接口（本文件的 classic 词法状态）───────────────────────
// 侧栏渲染签名是跨文件的 let：pin 点击 / 会话变更 / 侧栏操作在乐观更新后把它
// 清空以强制下次重建，renderAgentList 用它去重。ESM 消费方经
// modules/p2-bootstrap-sidebar.js 的 sidebarRender 适配对象读写。owner 仍是
// 本文件的顶部声明（渲染去重语义不变）；消费方（sidebar-pin-color /
// session-mutation / sidebar-operations / thread-store）全部迁移后随 P3 撤除。
function createP2BootstrapSidebarRenderHost() {
  return Object.freeze({
    get lastAgentListRenderSignature() { return lastAgentListRenderSignature; },
    set lastAgentListRenderSignature(value) { lastAgentListRenderSignature = value; },
  });
}
