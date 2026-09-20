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
 * 侧栏运行中会话的拖拽源（→ 输入框会话引用）：dragstart 把会话身份写入
 * 专用 MIME，投放判定与状态管理都在 session-reference-picker 模块。
 * agentId 取模板写入的 data-ctx-ns（本地条目 = 宿主 agentId，与 session_record
 * 寻址同源）；不查 allAgents——其字面量字段对 child 会话并不可靠，且远程
 * 条目不在其中（远程禁拖，见 renderItem 的 draggable 条件）。
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
    sessionType: 'main',
    title: (titleNode?.textContent || '').trim(),
  };
  event.dataTransfer.setData(ref.MIME, JSON.stringify(payload));
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
  const items = getCtxMenuItems(role, ns, variant, id, sessionId);
  if (items.length === 0) return;
  const rect = button.getBoundingClientRect();
  window.closeCtxMenu();
  closeAgentContextMenu();
  closeSessionContextMenu();
  closeCompactMenu();
  closeProjectContextMenu();
  window.showCtxMenu(rect.right, rect.bottom, items, { role, ns, id, variant, sessionId });
};

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

// Tracks collapsed state of category groups in the sidebar (系统空间, 工作群, etc.).
// Keyed by the .agent-group element id so state persists across re-renders.
const _collapsedCategoryGroups = new Set();

function renderSidebarChildItems(entries, ownerAgentId, workspaceAgentId = ownerAgentId) {
  const visibleEntries = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const remoteEntries = typeof getRemoteSidebarProjection === 'function'
    ? getRemoteSidebarProjection(workspaceAgentId, ownerAgentId)
    : [];
  const projectedEntries = [...visibleEntries, ...remoteEntries];
  if (projectedEntries.length === 0) return '';

  // Local and remote runtimes share this projection. Their origin remains in
  // entry metadata, while the default sidebar only renders workspace → project
  // → running session.


  const renderItem = (entry) => {
    const active = isRuntimeItemActive(entry.runtimeId);
    const disconnected = isSidebarRuntimeDisconnected(entry);
    const remoteDisabled = entry.source === 'remote' && disconnected;
    const calling = !disconnected && isRuntimeCalling(entry.runtimeId);
    const restarting = restartingRuntimeIds.has(entry.runtimeId);
    const retiring = !!entry.replacementMutation || entry.sidebarOperation?.type === 'archive-close';
    const replacementPending = entry.pendingReplacement === true;
    const operationPending = entry.pendingOperation === true;
    const deleting = entry.deleting === true;
    const operationDegraded = entry.sidebarOperation?.phase === 'degraded';
    const targetStartDegraded = operationDegraded && entry.sidebarOperation?.errorCode === 'target_runtime_stopped';
    const justFinished = !calling && !disconnected && !restarting && _recentlyFinishedRuntimes.has(entry.runtimeId);
    // 线程宿主会话（coder）的 replacement：源会话不是「正在关闭」，而是
    // 「正在交接」给接力会话；archive-close / delete 仍是真实关闭，保持原文案。
    const isThreadRelay = retiring
      && !deleting
      && !!entry.replacementMutation
      && typeof window.isThreadHostAgentId === 'function'
      && window.isThreadHostAgentId(ownerAgentId, entry.sessionId);
    const zh = currentLanguage === 'zh';
    const retiringLabel = targetStartDegraded
      ? (isThreadRelay ? (zh ? '接力会话启动未完成' : 'Relay session start incomplete') : (zh ? '新会话启动未完成' : 'New session start incomplete'))
      : operationDegraded
        ? (isThreadRelay ? (zh ? '交接收尾未完成' : 'Relay close incomplete') : (zh ? '关闭未完成' : 'Close incomplete'))
        : (isThreadRelay ? (zh ? '正在交接' : 'Relaying') : (zh ? '正在关闭' : 'Closing'));
    const itemClass = [
      'agent-item',
      'agent-runtime-item',
      active ? 'active' : '',
      disconnected ? 'disconnected' : '',
      remoteDisabled ? 'remote-entry-disabled' : '',
      calling ? 'calling' : '',
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
        data-agent-disabled="${replacementPending || operationPending || deleting || remoteDisabled ? 'true' : 'false'}"
        data-agent-prebuilt="false"
        data-agent-context-menu="${entry.contextMenuEnabled ? 'true' : 'false'}"
        data-ctx-role="runtime" data-ctx-ns="${escapeHtml(entry.hostNamespaceId || entry.ownerId || '')}" data-ctx-id="${escapeHtml(entry.runtimeId)}" data-ctx-variant="${escapeHtml(entry.source || '')}" data-ctx-session-id="${escapeHtml(entry.sessionId || '')}"
        ${entry.source === 'remote' ? '' : 'draggable="true" ondragstart="onSidebarSessionDragStart(event, this)"'}
        onpointermove="onSidebarItemPointerMove(event, this)" onpointerleave="onSidebarItemPointerLeave(this)"
      >
        ${entry.source !== 'remote' ? `<span class="agent-session-pin-slot">${calling
          ? '<span class="agent-session-pin-spinner" title="' + escapeHtml(zh ? '会话运行中' : 'Session is running') + '"></span>'
          : (justFinished
            ? '<span class="agent-session-pin-finished" title="' + escapeHtml(zh ? '刚刚完成' : 'Just finished') + '"></span>'
            : (entry.todo === true
              ? `<button class="agent-session-pin is-set pin-color-${escapeHtml(entry.todoColor || 'white')}" type="button" data-todo-color="${escapeHtml(entry.todoColor || 'white')}" title="${escapeHtml(zh ? '点击取消待办，长按上拖换色' : 'Click to remove TODO, drag up for color')}" onpointerdown="onSidebarPinPointerDown(event, this)">${SIDEBAR_PIN_SVG}</button>`
              : `<button class="agent-session-pin is-slanted" type="button" title="${escapeHtml(zh ? '点击设为待办，长按上拖选色' : 'Click to set TODO, drag up for color')}" onpointerdown="onSidebarPinPointerDown(event, this)">${SIDEBAR_PIN_SVG}</button>`))}</span>`
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
      groups.push({ projectKey: key, projectName: entry.projectName || '', projectDir: entry.projectDir || '', items: [] });
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
    const canEnter = isWorkGroup
      ? group.items.some((entry) => entry.source !== 'remote')
      : group.items.length > 0;
    // For work-group: enter navigates to the group chat by chatId.
    // For programming-helper: enter navigates to the workspace surface and
    // scrolls to / expands the corresponding project card.
    const enterType = isWorkGroup ? 'wg' : 'ph';
    const enterTarget = isWorkGroup ? projectKey : (group.projectDir || label);
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
  'programming-helper:coder': 'programming-helper.svg',
  'work-group': 'work-group.svg',
};

function getAgentIconHtml(agentId) {
  const iconFile = AGENT_ICONS[agentId];
  if (!iconFile) return '';
  return `<img class="agent-icon" src="images/agent-icons/${iconFile}" alt="" draggable="false" />`;
}

function renderAgentGroup(listElement, groupElement, countElement, agents, options = {}) {
  const { prebuilt = false } = options;
  groupElement.style.display = agents.length ? '' : 'none';
  countElement.textContent = String(agents.length);
  listElement.innerHTML = agents.map((agent) => {
    const active = isAgentActive(agent);
    const connected = agent.connected !== false;
    const pending = pendingPrebuiltAgentIds.has(agent.id);
    const workspaceSurface = isWorkspaceSurfaceUnit(agent);
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
    const contextMenuEnabled = prebuilt
      ? (!workspaceSurface && hasRuntime)
      : !!runtimeId;
    const childEntries = prebuilt ? collectRuntimeEntriesForPrebuilt(agent, allAgents) : [];
    const workspaceAgentId = String(agent.agentId || agent.id || '').trim();
    const hasActiveRuntime = prebuilt && childEntries.some((entry) => isRuntimeItemActive(entry.runtimeId));
    if (prebuilt) {
      const childrenHtml = renderSidebarChildItems(childEntries, agent.id, workspaceAgentId);
      const entryClass = ['agent-entry', hasActiveRuntime ? 'has-active-runtime' : ''].filter(Boolean).join(' ');
      return `
        <div class="${entryClass}">
          <div
            class="${itemClass}"
            data-agent-id="${escapeHtml(agent.id)}"
            data-agent-prebuilt="true"
            data-agent-context-menu="${contextMenuEnabled ? 'true' : 'false'}"
          >
            <div class="agent-line">
              ${getAgentIconHtml(agent.id)}
              <div class="agent-name">${escapeHtml(agent.name || agent.id)}</div>
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
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const agents = await invoke('get_connected_agents');
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
      const verify = await invoke('get_connected_agents');
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
  // 投影入口（如 programming-helper:coder）停留在入口首页时按条目记忆恢复；
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

async function loadAgents() {
  if (loadAgentsInFlight) {
    return loadAgentsInFlight;
  }
  const _t0 = performance.now();
  const sidebarSnapshotToken = typeof captureSidebarSnapshotToken === 'function'
    ? captureSidebarSnapshotToken()
    : null;
  const task = (async () => {
  try {
    const [connectedAgents, res] = await Promise.all([
      invoke('get_connected_agents'),
      fetch('/api/agents'),
    ]);
    const data = res.ok ? await res.json().catch(() => ({ agents: [] })) : { agents: [] };
    if (sidebarSnapshotToken && typeof isSidebarSnapshotTokenCurrent === 'function' && !isSidebarSnapshotTokenCurrent(sidebarSnapshotToken)) {
      window.setTimeout(() => loadAgents().catch(e => console.warn(e)), 25);
      return { stale: true };
    }
    const runtimeAgents = data.agents || [];
    const runtimeById = new Map(runtimeAgents.map((agent) => [agent.id, agent]));
    const prevByAgentId = new Map(allAgents.map((a) => [a.id, a]));

    if (connectedAgents.length === 0) {
      const sourceDiagnostic = connectedAgents.__sidebarDiagnostic;
      // ── 空快照契约 ──────────────────────────────────────────────
      // 一次空的 connected 快照不代表"没有任何预制 Agent"：当前服务端正常
      // 路径会返回 prebuilt 宿主条目（即使全部 stopped），但空数组本身
      // 不足以证明身份已经消失（也可能是请求失败、初始化或发现过程中的
      // 短暂不确定状态）。空快照不得把已确认的预制身份降级成 external
      // （历史 bug：分类闪现"外部代理"、标题退化为工作空间名）。
      const diagnoseEmptySnapshot = (phase, prevCount) => {
        if (typeof queueSidebarDiagnosticEvent === 'function') {
          // Use the existing system-diagnostic contract. The queue is persisted
          // through sanitizeSidebarDiagnosticEvent(), which requires a stable
          // operation/phase pair and only accepts bounded count field names.
          queueSidebarDiagnosticEvent({
            kind: 'system',
            operation: 'sidebar_snapshot',
            phase: sourceDiagnostic?.phase || `empty-connected-${phase}`,
            errorCode: sourceDiagnostic?.errorCode || 'empty-connected-snapshot',
            result: 'degraded',
            agentCount: prevCount,
            runtimeCount: runtimeAgents.length,
          });
        }
        console.warn(`[sidebar] empty connected snapshot (${phase}): prev=${prevCount} viewerRuntime=${runtimeAgents.length}`);
      };
      const prevAgents = Array.isArray(allAgents) ? allAgents : [];
      const hasConfirmedPrebuiltIdentity = prevAgents.some((agent) => agent?.source === 'prebuilt');
      if (runtimeAgents.length === 0) {
        // S2 双源皆空：无任何新信息，整体保留上一轮——与网络层 throw
        // 的 catch 路径行为对齐（同样是"这轮没拿到数据"，结局一致）。
        diagnoseEmptySnapshot('both-sources-empty', prevAgents.length);
      } else if (hasConfirmedPrebuiltIdentity) {
        // S1 稳态空快照：保留上一轮完整侧栏投影，仅按 viewer runtime
        // 刷新存活状态（viewer 匹配不到的条目保留上一轮状态，下一轮
        // 正常快照会给出权威值）。
        allAgents = prevAgents.map((agent) => {
          const runtimeSessionId = getRuntimeId(agent);
          const runtimeAgent = runtimeSessionId ? runtimeById.get(runtimeSessionId) : runtimeById.get(agent.id);
          const resolvedConnected = runtimeAgent?.connected ?? agent.connected ?? false;
          return {
            ...agent,
            status: resolvedConnected ? 'running' : 'stopped',
            message_count: runtimeAgent?.messageCount ?? agent.message_count ?? 0,
            connected: resolvedConnected,
          };
        });
        diagnoseEmptySnapshot('preserved-identity', prevAgents.length);
      } else {
        // S3 首屏无历史：无可保留的已确认身份，维持既有 external 投影。
        allAgents = runtimeAgents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          description: agent.description || '',
          status: agent.connected ? 'running' : 'stopped',
          source: 'external',
          parent_id: agent.parentAgentId || null,
          connection_info: agent.connectionInfo || 'viewer://127.0.0.1:2026',
          pid: agent.pid || null,
          runtime_session_id: agent.id,
          message_count: agent.messageCount ?? 0,
          created_at: agent.createdAt || null,
          connected: agent.connected ?? false,
        }));
        diagnoseEmptySnapshot('external-fallback-no-history', prevAgents.length);
      }
    } else {
      allAgents = connectedAgents.map((agent) => {
        const runtimeSessionId = getRuntimeId(agent);
        const runtimeAgent = runtimeSessionId ? runtimeById.get(runtimeSessionId) : runtimeById.get(agent.id);
        const resolvedConnected = runtimeAgent?.connected ?? agent.connected ?? false;
        const prev = prevByAgentId.get(agent.id);
        return {
          ...agent,
          status: resolvedConnected ? 'running' : (agent.status || 'stopped'),
          message_count: runtimeAgent?.messageCount ?? agent.message_count ?? 0,
          connected: resolvedConnected,
          ...(prev && loadedAgentDetailIds.has(agent.id) ? {
            workspace_data: prev.workspace_data,
            workspace_state: {
              ...prev.workspace_state,
              // gcChats comes from getConnectedAgents (not agent_detail),
              // so always use the fresh value to avoid losing group chat mapping.
              ...(agent.workspace_state?.gcChats ? { gcChats: agent.workspace_state.gcChats } : {}),
            },
            // The light snapshot is authoritative for membership/status when
            // its revision is current; merge preserves rich fields by ID.
            workspace_sessions: typeof mergeWorkspaceSessionSnapshots === 'function'
              ? mergeWorkspaceSessionSnapshots(prev.workspace_sessions, agent.workspace_sessions, agent.id)
              : prev.workspace_sessions,
          } : {}),
          // 当新数据的 workspace_sessions.sessions 为空但旧数据有值时，保留旧 sessions 避免闪空
          ...(!loadedAgentDetailIds.has(agent.id) && prev?.workspace_sessions?.sessions?.length > 0
            && !(agent.workspace_sessions?.sessions?.length > 0) ? {
              workspace_sessions: prev.workspace_sessions,
            } : {}),
          // Preserve contextLength/compressRatio from prev when the light
          // getConnectedAgents snapshot doesn't include them. This prevents
          // the context bar from flashing defaults between data refreshes.
          // Only applies when loadAgentDetail hasn't run yet AND the new data
          // has sessions (if sessions are empty, the block above already
          // preserves the entire prev.workspace_sessions).
          ...(!loadedAgentDetailIds.has(agent.id)
            && agent.workspace_sessions?.sessions?.length > 0
            && prev?.workspace_sessions && (() => {
            const cur = agent.workspace_sessions;
            const curCl = cur?.contextLength;
            const curCr = cur?.compressRatio;
            const prevCl = prev.workspace_sessions.contextLength;
            const prevCr = prev.workspace_sessions.compressRatio;
            const needCl = !(Number.isFinite(curCl) && curCl > 0) && Number.isFinite(prevCl) && prevCl > 0;
            const needCr = !(Number.isFinite(curCr) && curCr > 0 && curCr <= 100) && Number.isFinite(prevCr) && prevCr > 0 && prevCr <= 100;
            if (!needCl && !needCr) return {};
            return {
              workspace_sessions: {
                ...cur,
                ...(needCl ? { contextLength: prevCl } : {}),
                ...(needCr ? { compressRatio: prevCr } : {}),
              },
            };
          })()),
        };
      });
    }

    // 清理已断开 agent 的 call 状态（含在线远程条目：remote: 命名空间 key
    // 必须视为存活，否则每轮 poll 被当孤儿清除，见 collectActiveCallRuntimeIds）
    const activeRuntimeIds = new Set(collectActiveCallRuntimeIds(allAgents));
    for (const key of _agentCallActive.keys()) {
      if (!activeRuntimeIds.has(key)) _agentCallActive.delete(key);
    }
    for (const key of Array.from(_recentlyFinishedRuntimes)) {
      if (!activeRuntimeIds.has(key)) _recentlyFinishedRuntimes.delete(key);
    }

    if (!suppressSidebarRerender) {
      renderAgentList();
      // resources/viewer/settings 面板数据独立管理，跳过以避免编辑器/输入框失焦
      if (typeof activeFeaturePanel === 'undefined' || (activeFeaturePanel !== 'resources' && activeFeaturePanel !== 'viewer' && activeFeaturePanel !== 'settings')) {
        renderFeaturePanel();
      }
    }

    await refreshAgentCallStates(allAgents);

    // remote: 命名空间的 agent 不在本机 allAgents 目录中（不参与本地目录
    // 心跳），不能被本地 fallback 抢走焦点；焦点恢复由 remote_catalog 侧维持。
    if (focusedAgentId && !isRemoteNamespaceAgentId(focusedAgentId)
      && !allAgents.some((agent) => agent.id === focusedAgentId || getAgentRuntimeId(agent) === focusedAgentId)) {
      const fallbackId = resolveWorkspaceFallbackAgentId();
      if (fallbackId) {
        await loadAgentDetail(fallbackId);
        selectWorkspaceSurface(fallbackId, { skipFeaturePanel: true });
        return;
      }
    }

    if (!focusedAgentId) {
      const homeAgent = allAgents.find((agent) => agent.id === 'home' && agent.source === 'prebuilt');
      if (homeAgent) {
        setPreferredUnitMode('home', homeAgent);
        await loadAgentDetail(homeAgent.id);
        selectWorkspaceSurface(homeAgent.id, { skipFeaturePanel: true });
        return;
      }
      if (!focusedAgentId) {
        // 焦点恢复（前端自持，服务端 current agent 语义已移除）：
        // 1. 有待处理输入请求的 agent 优先；2. localStorage 记忆的上次焦点；
        // 3. 兜底选中列表第一个已连接 agent。
        const restoreAgent = resolveFocusedAgentAfterRefresh(allAgents);
        if (restoreAgent) {
          // 投影入口条目走完整入口流程（宿主详情 + 条目 surface），
          // 不能按宿主逻辑 id 直落（那会恢复成宿主首页）。
          if (restoreAgent.agentId && restoreAgent.source === 'prebuilt') {
            void window.handlePrebuiltAgentClick(restoreAgent.id);
          } else {
            focusedAgentId = getLogicalAgentId(restoreAgent) || null;
            await loadAgentData(getAgentRuntimeId(restoreAgent));
          }

        }
      }
    }
  } catch (e) {
    console.error('Failed to load agents:', e);
  }
  })();
  loadAgentsInFlight = task;
  try {
    return await task;
  } finally {
    if (loadAgentsInFlight === task) {
      loadAgentsInFlight = null;
      console.log(`[PERF-CLIENT] loadAgents complete (${(performance.now() - _t0).toFixed(0)}ms)`);
    }
  }
}

// Desktop notification -> modules/desktop-notify.js

// call 状态链路的 runtime 全集：本地已连接 runtime + 在线远程条目（仅在线，
// 断开条目不参与轮询，其残留键由清理循环回收）。轮询与清理共用同一集合——
// 远程 key 不入集会被每轮 poll 当孤儿清掉，与聚焦会话的 chat 轮询写键形成
// 拉锯（远程会话发送按钮横跳、侧栏缺转圈动画的根因）。
function collectActiveCallRuntimeIds(agents) {
  const runtimeIds = (Array.isArray(agents) ? agents : [])
    .filter((agent) => agent?.connected)
    .map((agent) => getAgentRuntimeId(agent))
    .filter(Boolean);
  const remoteEntries = typeof getVisibleRemoteEntries === 'function'
    ? getVisibleRemoteEntries()
    : [];
  for (const entry of remoteEntries) {
    if (entry.status === 'connected' && entry.runtimeId) runtimeIds.push(entry.runtimeId);
  }
  return Array.from(new Set(runtimeIds));
}

let _callStatesRefreshInProgress = false;

/**
 * 单 runtime 的 call 状态应用（notification payload → 侧栏级状态）。
 * refreshAgentCallStates 的轮询路径与 sse-client 的事件路径（非焦点
 * notification 事件）共用：_agentCallActive 维护、interrupt 抑制解除、
 * true→false 完成转换（_recentlyFinishedRuntimes + 桌面通知）。
 * @returns {boolean} 该 runtime 的可视 call 状态是否发生变化
 */
function applyAgentCallStateFromNotification(runtimeId, notifData) {
  const payload = notifData && typeof notifData === 'object' ? notifData : null;
  const backendCalling = resolveNotificationCallingState(payload) === true;
  const prevCalling = _agentCallActive.get(runtimeId) === true;
  const effectiveCalling = backendCalling
    && !isInterruptSuppressed(runtimeId, getNotificationCallStartedAt(payload));
  if (effectiveCalling) {
    _markAgentCallStartedForNotify(runtimeId);
    _agentCallActive.set(runtimeId, true);
  } else {
    _agentCallActive.delete(runtimeId);
  }
  if (!backendCalling) {
    clearInterruptSuppression(runtimeId);
  }
  if (prevCalling && !effectiveCalling) {
    if (normalizeAgentIdentity(runtimeId) !== normalizeAgentIdentity(currentRuntimeAgentId)) {
      _recentlyFinishedRuntimes.add(runtimeId);
    }
    _tryNotifyAgentFinished(runtimeId, payload);
  }
  return prevCalling !== effectiveCalling;
}

/**
 * 将 call 状态写入 agent 记录的 callActive（侧栏转圈动画的数据源）。
 * 仅处理 runtime 匹配的记录；prebuilt 宿主行的清理由 refreshAgentCallStates
 * 无条件执行（不随 SSE 本地跳过而消失）。
 * @returns {boolean} 是否有记录被修改
 */
function applyCallStateToAgentRecords(runtimeId, calling) {
  let changed = false;
  for (const agent of Array.isArray(allAgents) ? allAgents : []) {
    if (agent?.source === 'prebuilt') continue;
    if (getAgentRuntimeId(agent) !== runtimeId) continue;
    const nextCalling = calling === true;
    if (agent.callActive !== nextCalling) {
      agent.callActive = nextCalling;
      changed = true;
    }
  }
  return changed;
}

/**
 * prebuilt 宿主行不承载 call 态（子会话自持）：无条件清理。SSE 本地跳过
 * 的提前返回分支同样要执行（事件路径不覆盖该特例）。
 * @returns {boolean} 是否有记录被修改
 */
function cleanPrebuiltHostRows(agents) {
  let changed = false;
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (agent?.source === 'prebuilt' && agent.callActive) {
      agent.callActive = false;
      changed = true;
    }
  }
  return changed;
}

async function refreshAgentCallStates(agents = allAgents, options = {}) {
  const { force = false, reuseNotification = null, includeSseLocals = false } = options;
  // 互斥锁：防止 Worker 心跳与常规 poll 并发执行导致重复触发通知
  if (_callStatesRefreshInProgress) return;
  const now = Date.now();
  if (!force && now - lastCallStateRefreshAt < 1000) {
    return;
  }
  _callStatesRefreshInProgress = true;
  lastCallStateRefreshAt = now;
  try {
    // 本地已连接 runtime 与在线远程条目合并后再判空：仅剩远程条目时同样
    // 走完整轮询，不会误入"全清"提前返回分支。
    const runtimeIds = collectActiveCallRuntimeIds(agents);
    // SSE 激活时本地条目由 notification 事件维护（§5.3 整函数语义切换）：
    // 不 fetch、不进覆写/孤儿清理。includeSseLocals（visibilitychange 强刷
    // 等全量对账路径）恢复本地条目的轮询参与。
    const sseSkipLocal = typeof isSseActive === 'function' && isSseActive() && !includeSseLocals;
    const polledIds = sseSkipLocal
      ? runtimeIds.filter((id) => typeof isRemoteNamespaceAgentId === 'function' && isRemoteNamespaceAgentId(id))
      : runtimeIds;
    if (polledIds.length === 0) {
      if (sseSkipLocal) {
        cleanPrebuiltHostRows(agents);
        return; // 本地条目归事件管，远程为空：无需动作
      }
      let changed = false;
      for (const key of Array.from(_agentCallActive.keys())) {
        _agentCallActive.delete(key);
        _interruptSuppression.delete(key);
        changed = true;
      }
      if (changed) {
        renderAgentList();
      }
      return;
    }

    const nextNotificationPayloads = new Map();
    await Promise.all(polledIds.map(async (runtimeId) => {
      try {
        // 同周期复用：poll 主循环的 statusTask 刚在本周期取过焦点 runtime 的
        // notification，命中时直接复用 payload，避免每轮对同一 runtime 发两次
        // 相同请求。payload 为空（请求失败/会话切换）时此处分支不命中，照常自取。
        // 其余入口（Worker 心跳 force、前台回归、初次加载）不传该参数，始终走网络。
        if (
          reuseNotification?.payload
          && normalizeAgentIdentity(reuseNotification.runtimeId) === normalizeAgentIdentity(runtimeId)
        ) {
          nextNotificationPayloads.set(runtimeId, reuseNotification.payload);
          return;
        }
        const res = await fetch(`/api/agents/${encodeURIComponent(runtimeId)}/notification`);
        if (!res.ok) return;
        const notifData = await res.json();
        nextNotificationPayloads.set(runtimeId, notifData);
      } catch (error) {
      }
    }));

    let changed = false;
    for (const runtimeId of polledIds) {
      changed = applyAgentCallStateFromNotification(runtimeId, nextNotificationPayloads.get(runtimeId) || null) || changed;
    }

    // 孤儿清理的存活集是全量 runtimeIds（含 SSE 事件维护的本地条目）：
    // 本地条目仍存活，只是本轮不轮询，不能被"缺席=空闲"语义清掉
    const activeRuntimeIds = new Set(runtimeIds);
    for (const key of Array.from(_agentCallActive.keys())) {
      if (!activeRuntimeIds.has(key)) {
        _agentCallActive.delete(key);
        _interruptSuppression.delete(key);
        _recentlyFinishedRuntimes.delete(key);
        changed = true;
      }
    }

    for (const runtimeId of polledIds) {
      const payload = nextNotificationPayloads.get(runtimeId) || null;
      const calling = resolveNotificationCallingState(payload) === true
        && !isInterruptSuppressed(runtimeId, getNotificationCallStartedAt(payload));
      changed = applyCallStateToAgentRecords(runtimeId, calling) || changed;
    }

    changed = cleanPrebuiltHostRows(agents) || changed;

    if (changed) {
      renderAgentList();
    }
  } finally {
    _callStatesRefreshInProgress = false;
  }
}

let lastAgentListRenderSignature = '';

function getAgentListRenderSignature() {
  return JSON.stringify({
    focusedAgentId: normalizeAgentIdentity(focusedAgentId),
    currentRuntimeAgentId: normalizeAgentIdentity(currentRuntimeAgentId),
    pending: Array.from(pendingPrebuiltAgentIds || []).sort(),
    restarting: Array.from(restartingRuntimeIds || []).sort(),
    recentlyFinished: Array.from(_recentlyFinishedRuntimes).sort(),
    sidebarOperationVersion: typeof getSidebarOperationVersion === 'function' ? getSidebarOperationVersion() : 0,
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
        callActive: agent?.callActive === true,
        calling: rid !== '' && _agentCallActive.get(rid) === true,
        activeSessionId: normalizeAgentIdentity(getActiveSessionId(agent)),
        workspaceRevision: Number(agent?.workspace_sessions?.revision) || 0,
        displayName: agent?.active_workspace_display_name || '',
        sessionTitle: agent?.active_workspace_session_title || '',
      };
    }),
  });
}

function renderAgentList() {
  const nextSignature = getAgentListRenderSignature();
  if (nextSignature === lastAgentListRenderSignature) {
    updateCurrentAgentChrome();
    return;
  }
  lastAgentListRenderSignature = nextSignature;
  const groups = groupConnectedAgents(allAgents);
  renderAgentGroup(prebuiltAgentList, prebuiltGroup, prebuiltCount, groups.prebuilt, { prebuilt: true });
  renderAgentGroup(workGroupAgentList, workGroupGroup, workGroupCount, groups.workGroup, { prebuilt: true });
  renderAgentGroup(toolAgentList, toolGroup, toolCount, groups.tool, { prebuilt: true });
  renderAgentGroup(externalAgentList, externalGroup, externalCount, groups.external);

  updateCurrentAgentChrome();
}

agentList.addEventListener('click', async (event) => {
  // Handle category group collapse/expand toggle (系统空间, 工作群, etc.).
  const categoryHeader = event.target.closest('.agent-group-header');
  if (categoryHeader) {
    const groupEl = categoryHeader.closest('.agent-group');
    if (groupEl && groupEl.id) {
      if (_collapsedCategoryGroups.has(groupEl.id)) {
        _collapsedCategoryGroups.delete(groupEl.id);
        groupEl.classList.remove('collapsed');
      } else {
        _collapsedCategoryGroups.add(groupEl.id);
        groupEl.classList.add('collapsed');
      }
    }
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
    } else if (enterType === 'ph') {
      // Navigate to programming-helper workspace, then switch active project.
      const projectDir = enterTarget || '';
      await window.handlePrebuiltAgentClick('programming-helper');
      if (projectDir && typeof window.phSwitchProject === 'function') {
        const projectId = 'dir:' + projectDir.replace(/\\/g, '/').toLowerCase();
        await window.phSwitchProject(projectId);
      }
    }
    return;
  }

  // Handle project group collapse/expand toggle (programming-helper).
  const projectHeader = event.target.closest('.agent-runtime-project-header');
  if (projectHeader) {
    const groupEl = projectHeader.closest('.agent-runtime-project-group');
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
    const items = getCtxMenuItems(role, ns, variant, id, sessionId);
    if (items.length > 0) {
      event.preventDefault();
      window.closeCtxMenu();
      closeAgentContextMenu();
      closeSessionContextMenu();
      closeCompactMenu();
      closeProjectContextMenu();
      window.showCtxMenu(event.clientX, event.clientY, items, { role, ns, id, variant, sessionId });
      return;
    }
  }

  const agentId = item.dataset.agentId;
  if (!agentId) return;

  event.preventDefault();
  window.openAgentActions(event, agentId);
});
