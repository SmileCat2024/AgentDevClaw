/**
 * wg-popover.js — 成员浮窗域
 *
 * 包含：popover 渲染和管理、mouse over/out 事件代理、awareness dots 原地更新。
 *
 * 依赖加载顺序：必须在 wg-state.js 之后加载。
 */

// ── 本域提取的命名常量 ──────────────────────────────────────────
const WG_POPOVER_HIDE_DELAY = 80;
const WG_DROPDOWN_HIDE_DELAY = 200;
const WG_POPOVER_EXT_SESSIONS_MAX = 10;

// ── awareness dots 原地更新 ───────────────────────────────────

function _updateAwarenessDotsInPlace(awareness) {
  // 更新成员 chip 状态
  const chips = awareness.querySelectorAll('.wg-member-chip[data-wg-member-identity]');
  chips.forEach((chip) => {
    const identityRef = chip.dataset.wgMemberIdentity;
    if (identityRef === 'work-group:admin') return; // admin 单独处理
    const dotClass = getMemberAggregateStatus(identityRef);
    const dotTitle = dotClass === 'running' ? '运行中'
      : dotClass === 'idle' ? '在线 · 空闲' : '离线';
    chip.classList.remove('running', 'idle', 'offline');
    chip.classList.add(dotClass);
    const dot = chip.querySelector('.wg-member-dot');
    if (dot) {
      dot.classList.remove('running', 'idle', 'offline');
      dot.classList.add(dotClass);
      dot.title = dotTitle;
    }
    // 更新线程数 badge
    const threadCount = (typeof window._wgGetThreadCount === 'function')
      ? window._wgGetThreadCount(identityRef)
      : 0;
    const existingBadge = chip.querySelector('.wg-thread-badge');
    if (threadCount > 1) {
      if (existingBadge) {
        existingBadge.textContent = threadCount;
      } else {
        const badge = document.createElement('span');
        badge.className = 'wg-thread-badge';
        badge.textContent = threadCount;
        chip.appendChild(badge);
      }
    } else if (existingBadge) {
      existingBadge.remove();
    }
  });

  // 更新 admin chip（替换 admin 区域的 HTML）
  const adminDiv = awareness.querySelector('.wg-awareness-admin');
  if (adminDiv) {
    const newAdminHtml = renderAdminChip();
    if (newAdminHtml) {
      adminDiv.innerHTML = newAdminHtml;
    }
  }
}

/** 如果 popover 正打开，刷新其会话列表内容（不重建 popover 容器） */
function _refreshPopoverIfOpen() {
  if (!WgState._popoverEl || !WgState._hoverIdentity) return;
  const data = WgState._sessionDataCache[WgState._hoverIdentity];
  if (!data) return;

  if (WgState._hoverIdentity === 'work-group:admin') {
    // 管理员：刷新历史列表（活跃按钮不变）
    const adminResult = _renderAdminSessionList(data);
    const listContainer = WgState._popoverEl.querySelector('.wg-pop-list');
    if (listContainer) {
      listContainer.innerHTML = adminResult.historyHtml;
    }
  } else {
    const threadContainer = WgState._popoverEl.querySelector('[data-wg-thread-content]');
    if (!threadContainer) return;
    threadContainer.outerHTML = _renderPopoverSessionList(WgState._hoverIdentity, data);
  }
}

// ── popover 会话列表渲染 ──────────────────────────────────────

/**
 * 渲染 popover 中的成员会话区（线程摘要视图）。
 * 只承担快速感知与导航，不在此处混入派发和中断操作。
 */
function _renderPopoverSessionList(identityRef, data) {
  const summary = (typeof window._wgGetThreadSummary === 'function')
    ? window._wgGetThreadSummary(identityRef)
    : null;

  if (summary && summary.count > 0) {
    return `<div class="wg-pop-thread-content" data-wg-thread-content>${_renderPopoverThreadSummary(identityRef, summary)}</div>`;
  }

  const dataState = typeof window._wgGetThreadDataState === 'function'
    ? window._wgGetThreadDataState()
    : { loaded: false };
  const content = (dataState.loaded
    ? '<div class="wg-pop-empty">暂无可继续的工作线程</div>'
    : '<div class="wg-pop-thread-loading">正在整理工作线程…</div>')
    + _renderOpenThreadsLink();
  return `<div class="wg-pop-thread-content" data-wg-thread-content>${content}</div>`;
}

/**
 * 线程摘要视图：线程数 + 工作状态分布 + head 导航。
 */
function _renderPopoverThreadSummary(identityRef, summary) {
  const statusLabels = [
    summary.statusCounts.active > 0 ? `${summary.statusCounts.active} 进行中` : '',
    summary.statusCounts.completed > 0 ? `${summary.statusCounts.completed} 已完成` : '',
  ].filter(Boolean).join(' · ');

  const parts = [
    '<div class="wg-pop-thread-summary">',
    `  <div class="wg-pop-thread-count">${summary.count} 条工作线程</div>`,
    statusLabels ? `  <div class="wg-pop-thread-phases">${wgEsc(statusLabels)}</div>` : '',
    '</div>',
  ];

  // 活跃头部列表（最多 4 条），只保留会话导航。
  const heads = summary.activeHeads.slice(0, 4);
  if (heads.length > 0) {
    parts.push('<div class="wg-pop-list wg-pop-thread-heads">');
    heads.forEach(function (h) {
      const rt = WgState._runtimeStatusCache[h.sessionId];
      const rtStatus = rt?.status || 'offline';
      const dotClass = rtStatus === 'running' ? 'running' : rtStatus === 'idle' ? 'idle' : 'offline';

      parts.push(
        `<div class="wg-pop-session" data-wg-session-nav="${wgEsc(h.workspaceId)}:${wgEsc(h.sessionId)}" title="点击查看会话">`,
        `  <span class="wg-pop-dot ${dotClass}"></span>`,
        '  <span class="wg-pop-thread-copy">',
        `    <span class="wg-pop-title">${wgEsc(h.title)}</span>`,
        `    <span class="wg-pop-thread-state">${wgEsc(h.stateLabel || '')}</span>`,
        '  </span>',
        '  <span class="wg-pop-thread-chevron">›</span>',
        '</div>'
      );
    });
    parts.push('</div>');
  }

  parts.push(_renderOpenThreadsLink());

  return parts.join('');
}

function _renderOpenThreadsLink() {
  return [
    '<div class="wg-pop-open-threads" data-wg-open-threads>',
    '  <span>查看全部工作线程</span>',
    '  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>',
    '</div>',
  ].join('');
}

/**
 * 降级视图：扁平会话池列表（与原实现一致）。
 */
function _renderPopoverFlatSessions(identityRef, data, workspaceId, isMentioned, sel) {
  return (data.inChatSessions || []).map((s) => {
    const rt = WgState._runtimeStatusCache[s.id];
    const rtStatus = rt?.status || 'offline';
    const dotClass = rtStatus === 'running' ? 'running'
      : rtStatus === 'idle' ? 'idle'
      : 'offline';
    const dotTitle = rtStatus === 'running' ? '运行中'
      : rtStatus === 'idle' ? '在线 · 空闲'
      : '离线';

    const activeMark = s.isActive ? ' <span class="wg-pop-active">当前</span>' : '';
    const navAttr = `data-wg-session-nav="${wgEsc(workspaceId)}:${wgEsc(s.id)}"`;

    const isSelected = sel.mode === 'specific' && sel.sessionId === s.id;
    const dispatchBtn = (isMentioned && !isSelected)
      ? `<button class="wg-pop-dispatch-to" data-wg-dispatch="specific" data-wg-dispatch-id="${wgEsc(identityRef)}" data-wg-dispatch-sid="${wgEsc(s.id)}" data-wg-dispatch-title="${wgEsc(s.title)}">派发至此</button>`
      : (isSelected ? '<span class="wg-pop-dispatch-cur">已选</span>' : '');

    const interruptBtn = rtStatus === 'running'
      ? `<button class="wg-pop-interrupt-btn" data-wg-action="interrupt-session" data-wg-identity="${wgEsc(identityRef)}" data-wg-session-id="${wgEsc(s.id)}" data-wg-workspace-id="${wgEsc(workspaceId)}" title="中断此会话">中断</button>`
      : '';

    return [
      `<div class="wg-pop-session" ${navAttr} title="${s.isActive ? '点击查看会话' : '点击查看会话记录（只读）'}">`,
      `  <span class="wg-pop-dot ${dotClass}" title="${wgEsc(dotTitle)}"></span>`,
      `  <span class="wg-pop-title">${wgEsc(s.title)}${activeMark}</span>`,
      dispatchBtn,
      interruptBtn,
      '</div>',
    ].join('');
  }).join('');
}

/**
 * 格式化会话创建时间为 "MM-DD HH:MM"
 */
function _formatSessionTime(isoStr) {
  if (!isoStr) return '未知时间';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return '未知时间';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

/**
 * 渲染管理员 popover 内容（活跃会话跳转 + 历史会话记录）。
 * 活跃会话在顶部显示一个跳转按钮，不在历史列表中重复出现。
 * 历史会话以只读方式打开，名称使用创建时间。
 * 返回 { activeHtml, historyHtml, historyCount }
 */
function _renderAdminSessionList(data) {
  const workspaceId = 'work-group';
  const sessions = data.inChatSessions || [];
  const active = sessions.find((s) => s.isActive);
  const history = sessions.filter((s) => !s.isActive);

  // 活跃会话跳转按钮（accent 色风格）
  let activeHtml = '';
  if (active) {
    activeHtml = [
      `<div class="wg-pop-admin-active">`,
      `  <button class="wg-pop-admin-jump" data-wg-session-nav="${wgEsc(workspaceId)}:${wgEsc(active.id)}">`,
      `    <span>跳转到当前会话</span>`,
      `  </button>`,
      `</div>`,
    ].join('');
  }

  // 历史会话记录（只读，用创建时间命名）
  const historyHtml = history.map((s) => {
    return [
      `<div class="wg-pop-session" data-wg-session-record="${wgEsc(workspaceId)}:${wgEsc(s.id)}" title="点击查看会话记录（只读）">`,
      `  <span class="wg-pop-dot offline"></span>`,
      `  <span class="wg-pop-title">${wgEsc(_formatSessionTime(s.createdAt))}</span>`,
      '</div>',
    ].join('');
  }).join('');

  return { activeHtml, historyHtml, historyCount: history.length };
}

// ── popover 显示/隐藏 ─────────────────────────────────────────

async function showMemberPopover(identityRef, anchorEl) {
  if (!anchorEl) return;
  clearTimeout(WgState._popoverHideTimer);

  // 每次重新拉取会话数据（不依赖缓存），确保新建会话立即可见
  await fetchSessionData(identityRef);

  hideMemberPopover(true);

  const data = WgState._sessionDataCache[identityRef];
  if (!data) return;

  const displayName = getIdentityName(identityRef);
  const modelLabel = data.sessionModel === 'persistent' ? '持久' : '一次性';

  // 检查该成员是否已被 @mention（决定是否显示派发选项）
  const isMentioned = getMentionedIdentities().some((m) => m.identityRef === identityRef);
  const sel = WgState.activeChatId ? getSessionSelection(WgState.activeChatId, identityRef) : { mode: 'default' };

  // 派发设置区（仅 mentioned 时显示）
  let dispatchSection = '';
  if (isMentioned) {
    const isDefault = sel.mode === 'default';
    const isNew = sel.mode === 'new';
    dispatchSection = [
      '<div class="wg-pop-dispatch">',
      '  <div class="wg-pop-dispatch-label">派发设置</div>',
      '  <div class="wg-pop-dispatch-opts">',
      `    <button class="wg-pop-dispatch-opt${isDefault ? ' selected' : ''}" data-wg-dispatch="default" data-wg-dispatch-id="${wgEsc(identityRef)}">接续最近</button>`,
      `    <button class="wg-pop-dispatch-opt${isNew ? ' selected' : ''}" data-wg-dispatch="new" data-wg-dispatch-id="${wgEsc(identityRef)}">新建</button>`,
      '  </div>',
      '</div>',
    ].join('');
  }

  // 群内会话 — 管理员显示活跃会话跳转 + 只读历史会话，成员显示运行时状态 + 导航 + 派发选项
  const isAdmin = identityRef === 'work-group:admin';
  let sessionSectionHtml = '';
  if (isAdmin) {
    const adminResult = _renderAdminSessionList(data);
    const parts = [];
    if (adminResult.activeHtml) parts.push(adminResult.activeHtml);
    if (adminResult.historyHtml) {
      parts.push(`<div class="wg-pop-section-label">历史会话记录 (${adminResult.historyCount})</div><div class="wg-pop-list">${adminResult.historyHtml}</div>`);
    }
    sessionSectionHtml = parts.length > 0
      ? parts.join('')
      : '<div class="wg-pop-empty">暂无历史会话</div>';
  } else {
    const sessionHtml = _renderPopoverSessionList(identityRef, data);
    sessionSectionHtml = sessionHtml
      ? sessionHtml
      : '<div class="wg-pop-empty">暂无活跃会话</div>';
  }

  const el = document.createElement('div');
  // 管理员：在 header 追加在线状态
  let statusBadge = '';
  if (identityRef === 'work-group:admin') {
    const st = WgState._adminStatus;
    const restarting = WgState._adminRestarting;
    let label = '离线';
    let cls = 'offline';
    if (restarting) { label = '创建中'; cls = 'switching'; }
    else if (st?.online) { label = '在线'; cls = 'online'; }
    statusBadge = `<span class="wg-pop-status ${cls}">${wgEsc(label)}</span>`;
  }

  // 引入外部会话区（非管理员）— 右侧子面板
  let importToggle = '';
  let importPanel = '';
  if (identityRef !== 'work-group:admin') {
    const extCount = (data.externalSessions || []).length;
    importToggle = [
      '<div class="wg-pop-import-toggle" data-wg-pop-import-toggle>',
      `  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
      `  <span>引入外部会话</span>`,
      extCount > 0 ? `  <span class="wg-pop-import-count">${extCount}</span>` : '',
      '</div>',
    ].join('');

    const wsId = identityRef.split(':')[0];
    const ext = (data.externalSessions || []).slice(0, WG_POPOVER_EXT_SESSIONS_MAX);
    const extItems = ext.length === 0
      ? '<div class="wg-pop-empty">无可引入的会话</div>'
      : ext.map((s) => [
          `<div class="wg-pop-side-item" data-wg-pop-import-do data-workspace-id="${wgEsc(wsId)}" data-session-id="${wgEsc(s.id)}" title="${wgEsc(s.title)}">`,
          `  <span class="wg-pop-side-dot"></span>`,
          `  <span class="wg-pop-side-title">${wgEsc(s.title)}</span>`,
          '</div>',
        ].join('')).join('');

    importPanel = [
      '<div class="wg-pop-side" data-wg-pop-side style="display:none">',
      '  <div class="wg-pop-side-header">引入会话</div>',
      `  <div class="wg-pop-side-list">${extItems}</div>`,
      '</div>',
    ].join('');
  }

  el.className = 'wg-member-popover';
  el.innerHTML = [
    '<div class="wg-pop-main">',
    `<div class="wg-pop-header">`,
    `  <span class="wg-pop-name">${wgEsc(displayName)}</span>`,
    statusBadge ? `  ${statusBadge}` : `  <span class="wg-pop-model">${wgEsc(modelLabel)}</span>`,
    '</div>',
    dispatchSection,
    sessionSectionHtml,
    importToggle,
    '</div>',
    importPanel,
  ].join('');
  document.body.appendChild(el);
  WgState._popoverEl = el;

  // 定位 — anchor 可能在 await 期间被 DOM 重建移除，需检查有效性
  let anchor = anchorEl;
  if (!anchor.isConnected) {
    // 尝试在新 DOM 中重新查找
    anchor = document.querySelector(
      `[data-wg-member-identity="${CSS.escape(identityRef)}"]`
    );
    if (!anchor) {
      // anchor 已失效且无法找回，放弃显示
      hideMemberPopover(true);
      return;
    }
  }
  const rect = anchor.getBoundingClientRect();
  const popoverWidth = Math.min(360, Math.max(280, window.innerWidth - 24));
  el.style.width = `${popoverWidth}px`;
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - popoverWidth - 12));
  el.style.left = `${left}px`;
  const measuredHeight = Math.min(el.scrollHeight, Math.max(220, window.innerHeight - 24));
  const belowTop = rect.bottom + 4;
  const top = belowTop + measuredHeight <= window.innerHeight - 12
    ? belowTop
    : Math.max(12, rect.top - measuredHeight - 4);
  el.style.top = `${top}px`;

  // hover popover 自身不触发隐藏
  el.addEventListener('mouseenter', () => clearTimeout(WgState._popoverHideTimer));
  el.addEventListener('mouseleave', () => {
    WgState._popoverHideTimer = setTimeout(() => hideMemberPopover(), WG_POPOVER_HIDE_DELAY);
  });
  // popover 内的会话导航和派发选择
  el.addEventListener('click', async (ev) => {
    // 派发选项按钮
    const dispatchBtn = ev.target.closest('[data-wg-dispatch]');
    if (dispatchBtn) {
      ev.stopPropagation();
      const mode = dispatchBtn.dataset.wgDispatch;
      const identityRef = dispatchBtn.dataset.wgDispatchId;
      if (mode === 'default') {
        handleSessionOption(identityRef, 'default');
      } else if (mode === 'new') {
        handleSessionOption(identityRef, 'new');
      } else if (mode === 'specific') {
        handleSessionOption(identityRef, 'specific', dispatchBtn.dataset.wgDispatchSid, dispatchBtn.dataset.wgDispatchTitle);
      }
      // 刷新 popover 以更新选中状态
      if (WgState._hoverIdentity) {
        const chip = document.querySelector(`[data-wg-member-identity="${CSS.escape(identityRef)}"]`);
        if (chip) showMemberPopover(identityRef, chip);
      }
      return;
    }

    // 中断按钮
    const interruptBtn = ev.target.closest('[data-wg-action="interrupt-session"]');
    if (interruptBtn) {
      ev.stopPropagation();
      interruptBtn.disabled = true;
      interruptBtn.textContent = '...';
      handleInterruptSession(
        interruptBtn.dataset.wgIdentity,
        interruptBtn.dataset.wgSessionId,
        interruptBtn.dataset.wgWorkspaceId
      ).finally(() => {
        // 刷新 popover 内容（中断后状态会变化）
        _refreshPopoverIfOpen();
      });
      return;
    }

    const navItem = ev.target.closest('[data-wg-session-nav]');
    if (navItem) {
      navigateToSession(navItem.dataset.wgSessionNav);
      hideMemberPopover(true);
      return;
    }
    const recordItem = ev.target.closest('[data-wg-session-record]');
    if (recordItem) {
      const [workspaceId, sessionId] = recordItem.dataset.wgSessionRecord.split(':');
      navigateToSessionRecord(workspaceId, sessionId);
      hideMemberPopover(true);
    }

    // 打开工作面板
    const openThreadsBtn = ev.target.closest('[data-wg-open-threads]');
    if (openThreadsBtn) {
      ev.stopPropagation();
      hideMemberPopover(true);
      if (typeof toggleFeaturePanel === 'function') {
        toggleFeaturePanel('threads');
      }
      return;
    }

    // 引入外部会话 toggle — 展开/收起右侧子面板
    const importToggleBtn = ev.target.closest('[data-wg-pop-import-toggle]');
    if (importToggleBtn) {
      ev.stopPropagation();
      const sideEl = el.querySelector('[data-wg-pop-side]');
      if (sideEl) {
        const isOpen = sideEl.style.display !== 'none';
        if (isOpen) {
          sideEl.style.display = 'none';
          importToggleBtn.classList.remove('open');
        } else {
          sideEl.style.display = 'flex';
          importToggleBtn.classList.add('open');
        }
      }
      return;
    }

    // 引入操作 — 直接选中导入
    const importDo = ev.target.closest('[data-wg-pop-import-do]');
    if (importDo) {
      ev.stopPropagation();
      const { workspaceId, sessionId } = importDo.dataset;
      importDo.classList.add('imported');
      try {
        await doImportSession(workspaceId, sessionId);
        // 刷新缓存 + 关闭 popover
        delete WgState._sessionDataCache[identityRef];
        hideMemberPopover(true);
        refreshAdminBarOnly();
      } catch {
        importDo.classList.remove('imported');
      }
      
    }
  });
}

function hideMemberPopover(immediate) {
  if (immediate) {
    if (WgState._popoverEl) { WgState._popoverEl.remove(); WgState._popoverEl = null; }
    return;
  }
  WgState._popoverHideTimer = setTimeout(() => {
    if (WgState._popoverEl) { WgState._popoverEl.remove(); WgState._popoverEl = null; }
  }, WG_POPOVER_HIDE_DELAY);
}

// ── mouse over / out 事件代理 ─────────────────────────────────

function onContainerMouseOver(e) {
  // 模式选择器：hover 自动展开（直接操作 DOM，不触发 refresh）
  const modeDropdown = e.target.closest('.wg-mode-dropdown');
  if (modeDropdown) {
    clearTimeout(WgState._dropdownHideTimer);
    const type = modeDropdown.dataset.wgDropdown;
    if (type && WgState.openDropdown !== type) {
      // 关闭其他已打开的 dropdown
      document.querySelectorAll('.wg-mode-dropdown.open').forEach((el) => {
        if (el !== modeDropdown) el.classList.remove('open');
      });
      modeDropdown.classList.add('open');
      WgState.openDropdown = type;
    }
    return;
  }

  // dropdown 打开时，屏蔽 chip hover（菜单可能覆盖 chip 区域）
  if (WgState.openDropdown) return;

  const chip = e.target.closest('[data-wg-member-identity]');
  if (chip) {
    const identityRef = chip.dataset.wgMemberIdentity;
    clearTimeout(WgState._popoverHideTimer);
    if (WgState._hoverIdentity !== identityRef) {
      WgState._hoverIdentity = identityRef;
      clearTimeout(WgState._hoverTimer);
      WgState._hoverTimer = setTimeout(() => showMemberPopover(identityRef, chip), WG_HOVER_DELAY);
    }
  }
}

function onContainerMouseOut(e) {
  // 模式选择器：离开时延迟关闭（处理 trigger 与 menu 之间的视觉间隙）
  const modeDropdown = e.target.closest('.wg-mode-dropdown');
  if (modeDropdown) {
    const related = e.relatedTarget;
    if (!related || !related.closest('.wg-mode-dropdown')) {
      WgState._dropdownHideTimer = setTimeout(() => {
        document.querySelectorAll('.wg-mode-dropdown.open').forEach((el) => {
          el.classList.remove('open');
        });
        WgState.openDropdown = null;
      }, WG_DROPDOWN_HIDE_DELAY);
    }
    return;
  }

  // dropdown 打开时，屏蔽 chip 事件
  if (WgState.openDropdown) return;

  const chip = e.target.closest('[data-wg-member-identity]');
  if (chip) {
    const related = e.relatedTarget;
    // 如果移到了 popover 自身或另一个 member chip，不隐藏
    if (related && (related.closest('.wg-member-popover') || related.closest('[data-wg-member-identity]'))) {
      return;
    }
    clearTimeout(WgState._hoverTimer);
    WgState._hoverIdentity = null;
    hideMemberPopover();
  }
}
