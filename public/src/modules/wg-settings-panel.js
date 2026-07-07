/**
 * wg-settings-panel.js — 设置面板域
 *
 * 包含：管理员模型选项、成员管理、GROUP.md、管理员配置、设置面板渲染、
 *       添加成员弹窗、工作目录选择，以及对应 window._wg* 导出。
 *
 * 依赖加载顺序：必须在 wg-state.js 之后加载。
 */

// ── 本域提取的命名常量 ──────────────────────────────────────────
const WG_DEFAULT_ADMIN_MEMORY = { range: '3d', limitMode: 'tokens', tokenLimit: 100000, ratioLimit: 80 };
const WG_MEMORY_TOKEN_MIN = 1000;
const WG_MEMORY_TOKEN_MAX = 1000000;
const WG_MEMORY_RATIO_MIN = 1;
const WG_MEMORY_RATIO_MAX = 100;
const WG_MD_AUTOSAVE_DELAY = 800;
const WG_ADD_MEMBER_SEARCH_DEBOUNCE = 200;

// ── 管理员模型选项 ─────────────────────────────────────────────

function renderAdminModelOptions() {
  const s = WgState.adminModelState;
  if (s.loading && !s.loaded) {
    return '<option value="">加载中</option>';
  }
  if (s.error) {
    return '<option value="">加载失败</option>';
  }
  const current = s.current || '';
  const presetOptions = s.presets.map((p) => {
    const name = typeof p === 'string' ? p : (p.name || '');
    if (!name) return '';
    const sel = name === current ? ' selected' : '';
    return `<option value="${wgEsc(name)}"${sel}>${wgEsc(name)}</option>`;
  }).filter(Boolean).join('');
  return `<option value=""${current ? '' : ' selected'}>使用全局默认</option>` + presetOptions;
}

// ── 成员工具函数 ───────────────────────────────────────────────

function isManageableGroupIdentity(identityRef) {
  return identityRef && identityRef !== 'user' && identityRef !== 'work-group:admin';
}

function normalizeGroupMembers(members) {
  const result = [];
  const seen = new Set();
  const add = (member) => {
    const ref = member?.identityRef;
    if (!ref || seen.has(ref)) return;
    seen.add(ref);
    result.push(member);
  };
  add({ identityRef: 'user', role: 'human' });
  add({ identityRef: 'work-group:admin', role: 'admin' });
  (members || []).forEach((m) => {
    if (m.identityRef === 'user' || m.identityRef === 'work-group:admin') return;
    add({ identityRef: m.identityRef, role: m.role || 'agent' });
  });
  return result;
}

function getChatMemberRefs(chat = WgState.activeChat) {
  return new Set(normalizeGroupMembers(chat?.members || []).map((m) => m.identityRef));
}

function getAvailableMemberIdentities(chat = WgState.activeChat) {
  const memberRefs = getChatMemberRefs(chat);
  return WgState.identities.filter((id) =>
    isManageableGroupIdentity(id.identityRef) && !memberRefs.has(id.identityRef)
  );
}

// ── 成员头像网格 ───────────────────────────────────────────────

function renderGroupMemberRows(chat) {
  const members = normalizeGroupMembers(chat.members || []);
  if (!members.length) {
    return '<div class="wg-settings-empty-note">当前群聊还没有成员。</div>';
  }

  const cells = members.map((m) => {
    const identity = WgState.identities.find((id) => id.identityRef === m.identityRef);
    const name = m.identityRef === 'user' ? '我' : (identity?.displayName || getIdentityName(m.identityRef));
    const avatar = generateAvatar(name, m.identityRef);
    const canRemove = isManageableGroupIdentity(m.identityRef);
    const encodedRef = encodeURIComponent(m.identityRef);

    return [
      `<div class="wg-member-cell${canRemove ? ' removable' : ''}">`,
      '  <div class="wg-member-cell-avatar-wrap">',
      `    <div class="wg-avatar wg-avatar-md" style="--av-grad:${avatar.color}">${wgEsc(avatar.initials)}</div>`,
      canRemove
        ? `    <button class="wg-member-cell-remove" onclick="window._wgRemoveMember(decodeURIComponent('${encodedRef}'))" title="移出群聊">&times;</button>`
        : '',
      '  </div>',
      `  <span class="wg-member-cell-name" title="${wgEsc(name)}">${wgEsc(name)}</span>`,
      '</div>',
    ].join('');
  }).join('');

  // 网格末尾的「+ 添加」按钮
  const addCell = [
    '<div class="wg-member-cell wg-member-cell-add">',
    '  <button class="wg-member-cell-add-btn" onclick="window._wgOpenAddMemberModal()" title="添加成员">',
    '    <span class="wg-member-cell-add-icon">+</span>',
    '  </button>',
    '  <span class="wg-member-cell-name">添加</span>',
    '</div>',
  ].join('');

  return `<div class="wg-member-grid">${cells}${addCell}</div>`;
}

function renderAddMemberControl(_chat) {
  return '';
}

// ── GROUP.md 只读卡片 + 群资料库入口 ──────────────────────────

function renderFilesBridgeSection(chat) {
  const hasWorkDir = !!chat.workDir;
  const mdValue = (WgState.groupMdLoading || WgState.groupMdChatId !== chat.id) ? '' : WgState.groupMdContent;
  const mdSummary = wgExtractMdSummary(mdValue);

  const groupMdCard = (WgState.groupMdLoading && WgState.groupMdChatId === chat.id)
    ? '<div class="wg-group-md-summary wg-group-md-loading wg-group-md-clickable">加载中</div>'
    : mdSummary
      ? `<div class="wg-group-md-summary wg-group-md-clickable" onclick="window._wgEditGroupMd()">${wgEsc(mdSummary)}</div>`
      : '<div class="wg-group-md-summary wg-group-md-empty wg-group-md-clickable" onclick="window._wgEditGroupMd()">点击添加群聊背景、目标和约定。</div>';

  return [
    // GROUP.md 只读卡片
    '  <div class="wg-settings-section">',
    '    <div class="wg-settings-section-header">',
    '      <span class="wg-settings-section-title">GROUP.md</span>',
    '    </div>',
    groupMdCard,
    '  </div>',
    // 群资料库
    '  <div class="wg-settings-section">',
    '    <div class="wg-settings-section-header">',
    '      <span class="wg-settings-section-title">群资料库</span>',
    hasWorkDir
      ? '      <button class="wg-settings-section-action" onclick="window._wgOpenFilesPanel()">打开文件</button>'
      : '      <button class="wg-settings-section-action" onclick="window._wgChangeWorkDir()">选择目录</button>',
    '    </div>',
    hasWorkDir
      ? `    <div class="wg-resource-bridge-info"><code>${wgEsc(chat.workDir)}/.agentdev/resources</code></div>`
      : '    <div class="wg-settings-empty-note">未配置工作目录</div>',
    '  </div>',
  ].join('');
}

// ── 设置面板整体 ───────────────────────────────────────────────

function renderSettingsPanel(chat) {
  const members = normalizeGroupMembers(chat.members || []);
  const memberCount = members.length;
  const avatar = generateAvatar(chat.name, null, chat.createdAt);
  const createdDate = wgFormatCreateDate(chat.createdAt);
  const memberGrid = renderGroupMemberRows(chat);

  return [
    '<div class="wg-settings-panel">',

    // ── 群资料卡片头部 ──
    '  <div class="wg-settings-profile-card">',
    `    <div class="wg-avatar wg-avatar-lg" style="--av-grad:${avatar.color}">${wgEsc(avatar.initials)}</div>`,
    '    <div class="wg-settings-profile-info">',
    `      <input type="text" class="wg-settings-profile-name" value="${wgEsc(chat.name)}" onchange="window._wgSettingsChange('name', this.value)" />`,
    `      <div class="wg-settings-profile-meta">${memberCount} 名成员${createdDate ? ' · 创建于 ' + wgEsc(createdDate) : ''}</div>`,
    chat.workDir
      ? `      <div class="wg-settings-profile-workdir"><code title="${wgEsc(chat.workDir)}">${wgEsc(chat.workDir)}</code></div>`
      : '      <div class="wg-settings-profile-workdir"><span class="wg-settings-profile-no-workdir">未设置工作目录</span> <button class="wg-link-btn" onclick="window._wgChangeWorkDir()">设置</button></div>',
    '    </div>',
    '  </div>',

    // ── 成员头像网格 ──
    '  <div class="wg-settings-section">',
    '    <div class="wg-settings-section-header">',
    `      <span class="wg-settings-section-title">成员 (${memberCount})</span>`,
    '    </div>',
    memberGrid,
    '  </div>',

    // ── GROUP.md 只读卡片 + 群资料库 ──
    renderFilesBridgeSection(chat),

    // ── 管理员配置折叠区 ──
    '  <div class="wg-settings-collapse">',
    `    <button class="wg-settings-collapse-toggle${WgState._settingsAdminCollapsed ? '' : ' expanded'}" onclick="window._wgToggleAdminConfig()">`,
    '      <span class="wg-settings-collapse-label">管理员配置</span>',
    `      <span class="wg-collapse-arrow">${WgState._settingsAdminCollapsed ? '&#9654;' : '&#9660;'}</span>`,
    '    </button>',
    !WgState._settingsAdminCollapsed ? renderAdminConfigBody(chat) : '',
    '  </div>',

    // ── 危险区 ──
    '  <div class="wg-settings-section wg-settings-danger">',
    chat.archived
      ? '    <button class="wg-btn-secondary" onclick="window._wgUnarchive()">取消归档</button>'
      : '    <button class="wg-btn-secondary" onclick="window._wgArchive()">归档群聊</button>',
    `    <button class="wg-btn-danger" onclick="window._wgDissolve()">解散此群聊</button>`,
    '  </div>',

    '</div>',
  ].join('');
}

// ── 管理员配置折叠区内容 ───────────────────────────────────────

function renderAdminConfigBody(chat) {
  const initiative = chat.initiativeMode || 'assist';
  const autonomy = chat.autonomyMode || 'auto';
  const memRange = chat.adminMemory?.range || WG_DEFAULT_ADMIN_MEMORY.range;
  const memLimitMode = chat.adminMemory?.limitMode || WG_DEFAULT_ADMIN_MEMORY.limitMode;
  const memTokenLimit = chat.adminMemory?.tokenLimit ?? chat.adminMemory?.limitValue ?? WG_DEFAULT_ADMIN_MEMORY.tokenLimit;
  const memRatioLimit = chat.adminMemory?.ratioLimit ?? WG_DEFAULT_ADMIN_MEMORY.ratioLimit;

  const initiativeOptions = WG_INITIATIVE_MODES.map((m) =>
    `<option value="${m.value}"${m.value === initiative ? ' selected' : ''}>${wgEsc(m.label)} — ${wgEsc(m.desc)}</option>`
  ).join('');

  const autonomyOptions = WG_AUTONOMY_MODES.map((m) =>
    `<option value="${m.value}"${m.value === autonomy ? ' selected' : ''}>${wgEsc(m.label)} — ${wgEsc(m.desc)}</option>`
  ).join('');

  // 上下文限制：分段切换 + 对应值输入（两组值独立存储，切换不丢失）
  const isTokenMode = memLimitMode === 'tokens';
  const limitSuffix = isTokenMode ? 'tokens' : '%';
  const limitMin = isTokenMode ? String(WG_MEMORY_TOKEN_MIN) : String(WG_MEMORY_RATIO_MIN);
  const limitMax = isTokenMode ? String(WG_MEMORY_TOKEN_MAX) : String(WG_MEMORY_RATIO_MAX);
  const limitPlaceholder = isTokenMode ? String(WG_DEFAULT_ADMIN_MEMORY.tokenLimit) : String(WG_DEFAULT_ADMIN_MEMORY.ratioLimit);
  const currentLimitValue = isTokenMode ? memTokenLimit : memRatioLimit;
  const limitField = isTokenMode ? 'memoryTokenLimit' : 'memoryRatioLimit';

  return [
    '    <div class="wg-settings-collapse-body">',

    // 模式设置
    '      <div class="wg-settings-sub-section">',
    '        <div class="wg-settings-sub-title">模式设置</div>',
    `        <div class="wg-config-row"><span class="wg-config-label">响应模式</span><select class="wg-config-select" onchange="window._wgSettingsChange('initiativeMode', this.value)">${initiativeOptions}</select></div>`,
    `        <div class="wg-config-row"><span class="wg-config-label">执行策略</span><select class="wg-config-select" onchange="window._wgSettingsChange('autonomyMode', this.value)">${autonomyOptions}</select></div>`,
    '      </div>',

    // 管理员记忆
    '      <div class="wg-settings-sub-section">',
    '        <div class="wg-settings-sub-title">管理员记忆</div>',
    `        <div class="wg-config-row"><span class="wg-config-label">记忆范围</span><select class="wg-config-select" onchange="window._wgSettingsChange('memoryRange', this.value)">`,
    `          <option value="1d"${memRange === '1d' ? ' selected' : ''}>最近 1 天</option>`,
    `          <option value="3d"${memRange === '3d' ? ' selected' : ''}>最近 3 天</option>`,
    `          <option value="1w"${memRange === '1w' ? ' selected' : ''}>最近 1 周</option>`,
    `          <option value="all"${memRange === 'all' ? ' selected' : ''}>全部记录</option>`,
    '        </select></div>',
    // 上下文限制：标签 + 分段切换 + 值输入，全部在同一行
    `        <div class="wg-config-row"><span class="wg-config-label">上下文限制</span>`,
    `          <div class="wg-config-limit-controls">`,
    `            <div class="wg-segment-toggle">`,
    `              <button class="wg-segment-btn${isTokenMode ? ' active' : ''}" onclick="window._wgSettingsChange('memoryLimitMode','tokens')">按 Token</button>`,
    `              <button class="wg-segment-btn${!isTokenMode ? ' active' : ''}" onclick="window._wgSettingsChange('memoryLimitMode','ratio')">按比例</button>`,
    `            </div>`,
    `            <div class="wg-config-limit-input">`,
    `              <input type="number" value="${currentLimitValue}" min="${limitMin}" max="${limitMax}" class="wg-settings-input wg-config-limit-value" onchange="window._wgSettingsChange('${limitField}', this.value)" placeholder="${limitPlaceholder}" />`,
    `              <span class="wg-config-limit-suffix">${limitSuffix}</span>`,
    `            </div>`,
    `          </div>`,
    `        </div>`,
    '      </div>',

    // 管理员模型
    '      <div class="wg-settings-sub-section">',
    '        <div class="wg-settings-sub-title">管理员模型</div>',
    `        <div class="wg-config-row"><span class="wg-config-label">模型预设</span><select class="wg-config-select" onchange="window._wgSettingsChange('admin-model', this.value)" data-wg-role="admin-model-select">${renderAdminModelOptions()}</select></div>`,
    '      </div>',

    '    </div>',
  ].join('');
}

// ── 设置字段变更 ───────────────────────────────────────────────

async function handleSettingsFieldChange(field, value) {
  if (!WgState.activeChatId) return;
  try {
    const body = {};
    if (field === 'name') body.name = value;
    else if (field === 'initiativeMode') body.initiativeMode = value;
    else if (field === 'autonomyMode') body.autonomyMode = value;
    else if (field === 'memoryRange' || field === 'memoryLimitMode' || field === 'memoryTokenLimit' || field === 'memoryRatioLimit') {
      // 合并当前 adminMemory 设置后整体提交
      const cur = WgState.activeChat?.adminMemory || { ...WG_DEFAULT_ADMIN_MEMORY };
      const merged = { ...cur };
      if (field === 'memoryRange') merged.range = value;
      else if (field === 'memoryLimitMode') merged.limitMode = value;
      else if (field === 'memoryTokenLimit') merged.tokenLimit = parseInt(value) || WG_DEFAULT_ADMIN_MEMORY.tokenLimit;
      else if (field === 'memoryRatioLimit') merged.ratioLimit = parseInt(value) || WG_DEFAULT_ADMIN_MEMORY.ratioLimit;
      body.adminMemory = merged;
    }
    else if (field === 'admin-model') {
      await saveAdminModel(value);
      return;
    }

    if (Object.keys(body).length > 0) {
      WgState.activeChat = await wgApiPut(`/protoclaw/group_chats/${encodeURIComponent(WgState.activeChatId)}`, body);
      await loadChatSummaries();
      refreshChatList();
    }
  } catch (err) {
    console.error('[WorkGroup] settings save failed:', err);
  }
}

// ── GROUP.md 加载/保存 ────────────────────────────────────────

async function loadGroupMd() {
  const chatId = WgState.activeChatId;
  if (!chatId) return;
  WgState.groupMdLoading = true;
  WgState.groupMdChatId = chatId;
  WgState.groupMdContent = '';
  if (typeof window._wgSettingsRefresh === 'function') window._wgSettingsRefresh();
  try {
    const data = await wgApiGet(`/protoclaw/group_chats/${encodeURIComponent(chatId)}/group_md`);
    if (WgState.activeChatId !== chatId) return;
    WgState.groupMdContent = data.content || '';
  } catch (err) {
    if (WgState.activeChatId !== chatId) return;
    console.error('[WorkGroup] load GROUP.md failed:', err);
    WgState.groupMdContent = '';
  } finally {
    if (WgState.activeChatId === chatId) {
      WgState.groupMdLoading = false;
      if (typeof window._wgSettingsRefresh === 'function') window._wgSettingsRefresh();
    }
  }
}

async function saveGroupMd(chatId = WgState.activeChatId) {
  if (!chatId) return;
  const editor = document.querySelector('[data-wg-role="group-md-editor"]');
  if (!editor) return;
  const content = editor.value;
  try {
    await wgApiPut(`/protoclaw/group_chats/${encodeURIComponent(chatId)}/group_md`, { content });
    if (WgState.activeChatId === chatId) {
      WgState.groupMdContent = content;
      WgState.groupMdChatId = chatId;
    }
    _setMdSaveStatus('已保存');
  } catch (err) {
    console.error('[WorkGroup] save GROUP.md failed:', err);
    _setMdSaveStatus('保存失败');
  }
}

function _wgMdAutoSave() {
  _setMdSaveStatus('保存中…');
  if (WgState._mdAutoSaveTimer) clearTimeout(WgState._mdAutoSaveTimer);
  WgState._mdAutoSaveChatId = WgState.activeChatId;
  WgState._mdAutoSaveTimer = setTimeout(() => {
    WgState._mdAutoSaveTimer = null;
    saveGroupMd(WgState._mdAutoSaveChatId);
  }, WG_MD_AUTOSAVE_DELAY);
}

async function _flushGroupMdAutoSave() {
  if (!WgState._mdAutoSaveTimer) return;
  clearTimeout(WgState._mdAutoSaveTimer);
  WgState._mdAutoSaveTimer = null;
  await saveGroupMd(WgState._mdAutoSaveChatId || WgState.activeChatId);
}

function _setMdSaveStatus(text) {
  const el = document.querySelector('[data-wg-role="md-save-status"]');
  if (el) {
    el.textContent = text;
    el.classList.toggle('error', text === '保存失败');
    el.classList.toggle('saved', text === '已保存');
  }
}

// ── 工作目录 / 管理员模型 / 文件面板 ──────────────────────────

async function changeWorkDir() {
  if (!WgState.activeChatId) return;
  try {
    const result = await invoke('select_directory');
    if (!result || result.cancelled || !result.path) return;
    WgState.activeChat = await wgApiPut(`/protoclaw/group_chats/${encodeURIComponent(WgState.activeChatId)}`, {
      workDir: result.path,
    });
    await loadChatSummaries();
    refreshChatList();
    refreshMain();
    if (typeof window._wgSettingsRefresh === 'function') window._wgSettingsRefresh();
  } catch (err) {
    console.error('[WorkGroup] change workDir failed:', err);
  }
}

async function loadAdminModelOptions() {
  WgState.adminModelState = { ...WgState.adminModelState, loading: true, error: null };
  if (typeof window._wgSettingsRefresh === 'function') window._wgSettingsRefresh();
  try {
    const [configRes, presetRes] = await Promise.all([
      wgApiGet('/protoclaw/model_config'),
      wgApiGet('/protoclaw/agent_model_presets?agentId=work-group'),
    ]);
    const presets = Array.isArray(configRes.presets) ? configRes.presets : [];
    const current = presetRes.modelPresets?.default || '';
    WgState.adminModelState = {
      loading: false,
      loaded: true,
      presets,
      current,
      error: null,
    };
  } catch (err) {
    console.error('[WorkGroup] load admin model options failed:', err);
    WgState.adminModelState = {
      ...WgState.adminModelState,
      loading: false,
      loaded: true,
      error: err,
    };
  }
  if (typeof window._wgSettingsRefresh === 'function') window._wgSettingsRefresh();
}

async function saveAdminModel(presetName) {
  try {
    const res = await fetch('/protoclaw/agent_model_presets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'work-group', modelPresets: { default: presetName || null } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    WgState.adminModelState = { ...WgState.adminModelState, current: presetName || '', error: null };
  } catch (err) {
    console.error('[WorkGroup] save admin model failed:', err);
    WgState.adminModelState = { ...WgState.adminModelState, error: err };
  }
}

function openFilesPanel() {
  if (typeof activeFeaturePanel !== 'undefined') {
    activeFeaturePanel = 'resources';
    if (typeof renderFeaturePanel === 'function') renderFeaturePanel();
  }
  if (typeof loadResourcesPanelData === 'function') {
    loadResourcesPanelData();
  }
}

function toggleAdminConfig() {
  WgState._settingsAdminCollapsed = !WgState._settingsAdminCollapsed;
  if (typeof window._wgSettingsRefresh === 'function') window._wgSettingsRefresh();
}

function editGroupMd() {
  const chatId = WgState.activeChatId;
  if (!chatId) return;
  if (typeof window._viewerOpen === 'function') {
    window._viewerOpen('GROUP.md', chatId, true);
  }
}

// ── 成员管理 actions ──────────────────────────────────────────

async function updateGroupMembers(nextMembers) {
  if (!WgState.activeChatId) return;
  WgState.activeChat = await wgApiPut(`/protoclaw/group_chats/${encodeURIComponent(WgState.activeChatId)}`, {
    members: normalizeGroupMembers(nextMembers),
  });
  await loadChatSummaries();
  refreshChatList();
  refreshAdminBarOnly();
  if (typeof window._wgSettingsRefresh === 'function') window._wgSettingsRefresh();
}

async function addGroupMember(identityRef) {
  if (!WgState.activeChat || !isManageableGroupIdentity(identityRef)) return;
  const members = normalizeGroupMembers(WgState.activeChat.members || []);
  if (members.some((m) => m.identityRef === identityRef)) return;
  try {
    await updateGroupMembers([
      ...members,
      { identityRef, role: 'agent' },
    ]);
  } catch (err) {
    console.error('[WorkGroup] add member failed:', err);
  }
}

async function removeGroupMember(identityRef) {
  if (!WgState.activeChat || !isManageableGroupIdentity(identityRef)) return;
  const name = getIdentityName(identityRef);
  const confirmed = confirm(`将「${name}」移出此群聊？\n\n已有消息和会话记录会保留，但它不会再出现在本群成员和 @ 选择器中。`);
  if (!confirmed) return;
  const members = normalizeGroupMembers(WgState.activeChat.members || []).filter((m) => m.identityRef !== identityRef);
  try {
    await updateGroupMembers(members);
    delete WgState._sessionDataCache[identityRef];
    if (WgState._chatSessionSelection[WgState.activeChatId]) delete WgState._chatSessionSelection[WgState.activeChatId][identityRef];
  } catch (err) {
    console.error('[WorkGroup] remove member failed:', err);
  }
}

function addSelectedMember() {
  const select = document.querySelector('[data-wg-role="add-member-select"]');
  const ref = select?.value;
  if (ref) addGroupMember(ref);
}

// ── 添加成员弹窗 ───────────────────────────────────────────────

function renderAddMemberListItems(candidates, memberRefs, keyword) {
  if (!candidates.length) {
    return keyword
      ? '<div class="wg-settings-empty-note">没有匹配的身份。</div>'
      : '<div class="wg-settings-empty-note">当前没有可拉入群聊的 Agent 身份。</div>';
  }
  return candidates.map((id) => {
    const inGroup = memberRefs.has(id.identityRef);
    const name = id.displayName || id.identityRef;
    const avatar = generateAvatar(name, id.identityRef);
    return [
      `<div class="wg-add-member-item${inGroup ? ' disabled' : ''}" data-wg-identity="${wgEsc(id.identityRef)}">`,
      `  <div class="wg-avatar wg-avatar-sm" style="--av-grad:${avatar.color}">${wgEsc(avatar.initials)}</div>`,
      '  <div class="wg-add-member-item-info">',
      `    <span class="wg-add-member-item-name">${wgEsc(name)}</span>`,
      `    <span class="wg-add-member-item-desc">${wgEsc(id.description || '')}</span>`,
      '  </div>',
      inGroup
        ? '  <span class="wg-add-member-item-tag">已在群中</span>'
        : '  <span class="wg-add-member-item-check">&#10003;</span>',
      '</div>',
    ].join('');
  }).join('');
}

function closeAddMemberModal() {
  if (WgState._addMemberModalEl) {
    document.body.removeChild(WgState._addMemberModalEl);
    WgState._addMemberModalEl = null;
  }
  if (WgState._addMemberSearchTimer) {
    clearTimeout(WgState._addMemberSearchTimer);
    WgState._addMemberSearchTimer = null;
  }
}

async function openAddMemberModal() {
  if (WgState.identities.length === 0) await loadIdentities();

  const memberRefs = getChatMemberRefs(WgState.activeChat);
  const candidates = WgState.identities.filter((id) => isManageableGroupIdentity(id.identityRef));

  closeAddMemberModal();

  const modal = document.createElement('div');
  modal.className = 'wg-modal-overlay';
  modal.innerHTML = [
    '<div class="wg-modal wg-add-member-modal">',
    '  <div class="wg-modal-title">添加成员</div>',
    '  <input type="text" class="wg-modal-input" data-wg-role="add-member-search" placeholder="搜索身份..." />',
    '  <div class="wg-add-member-list" data-wg-role="add-member-list">',
    renderAddMemberListItems(candidates, memberRefs, ''),
    '  </div>',
    '  <div class="wg-modal-actions">',
    '    <button class="wg-modal-btn" data-wg-action="close-add-member">取消</button>',
    '    <button class="wg-modal-btn confirm" data-wg-action="confirm-add-member">确定</button>',
    '  </div>',
    '</div>',
  ].join('');
  document.body.appendChild(modal);
  WgState._addMemberModalEl = modal;

  // 搜索防抖
  const searchInput = modal.querySelector('[data-wg-role="add-member-search"]');
  searchInput.addEventListener('input', () => {
    clearTimeout(WgState._addMemberSearchTimer);
    const kw = searchInput.value.trim().toLowerCase();
    WgState._addMemberSearchTimer = setTimeout(() => {
      const filtered = kw
        ? candidates.filter((id) =>
          (id.displayName || '').toLowerCase().includes(kw) ||
          (id.description || '').toLowerCase().includes(kw) ||
          (id.identityRef || '').toLowerCase().includes(kw))
        : candidates;
      const listEl = modal.querySelector('[data-wg-role="add-member-list"]');
      if (listEl) listEl.innerHTML = renderAddMemberListItems(filtered, memberRefs, kw);
    }, WG_ADD_MEMBER_SEARCH_DEBOUNCE);
  });

  // 点击代理
  modal.addEventListener('click', (e) => {
    if (e.target === modal) { closeAddMemberModal(); return; }

    const closeBtn = e.target.closest('[data-wg-action="close-add-member"]');
    if (closeBtn) { closeAddMemberModal(); return; }

    const confirmBtn = e.target.closest('[data-wg-action="confirm-add-member"]');
    if (confirmBtn) {
      const selected = Array.from(modal.querySelectorAll('.wg-add-member-item.selected'))
        .map((el) => el.dataset.wgIdentity);
      closeAddMemberModal();
      (async () => {
        for (const ref of selected) {
          await addGroupMember(ref);
        }
      })();
      return;
    }

    // 切换选中状态
    const item = e.target.closest('.wg-add-member-item');
    if (item && !item.classList.contains('disabled')) {
      item.classList.toggle('selected');
    }
  });
}

// ── window._wg* 导出（Settings 面板） ─────────────────────────

window._wgGetSettingsHtml = function () {
  if (!WgState.activeChat) return '<div class="feature-panel-empty"><div>请先选择一个群聊。</div></div>';
  return renderSettingsPanel(WgState.activeChat);
};

window._wgSettingsInit = async function () {
  if (!WgState.activeChatId) return;
  const cid = WgState.activeChatId;
  WgState.groupMdLoading = true;
  WgState.groupMdChatId = cid;
  WgState.groupMdContent = '';
  if (typeof window._wgSettingsRefresh === 'function') window._wgSettingsRefresh();
  try {
    const [, mdData] = await Promise.all([
      loadAdminModelOptions(),
      wgApiGet(`/protoclaw/group_chats/${encodeURIComponent(cid)}/group_md`),
    ]);
    if (WgState.activeChatId !== cid) return;
    WgState.groupMdContent = mdData.content || '';
  } catch {
    if (WgState.activeChatId === cid) WgState.groupMdContent = '';
  } finally {
    if (WgState.activeChatId === cid) {
      WgState.groupMdLoading = false;
      if (typeof window._wgSettingsRefresh === 'function') window._wgSettingsRefresh();
    }
  }
};

window._wgSettingsRefresh = function () {
  if (typeof activeFeaturePanel !== 'undefined' && activeFeaturePanel === 'settings' && typeof renderFeaturePanel === 'function') {
    renderFeaturePanel();
  }
};

window._wgSettingsChange = async function (field, value) {
  await handleSettingsFieldChange(field, value);
  window._wgSettingsRefresh();
};

window._wgToggleAdminConfig = toggleAdminConfig;
window._wgEditGroupMd = editGroupMd;
window._wgOpenAddMemberModal = openAddMemberModal;

window._wgChangeWorkDir = changeWorkDir;
window._wgOpenFilesPanel = openFilesPanel;
window._wgAddSelectedMember = addSelectedMember;
window._wgRemoveMember = removeGroupMember;
window._wgDissolve = function () { handleDissolveChat(); };
window._wgArchive = async function () { await handleArchiveChat(); window._wgSettingsRefresh(); };
window._wgUnarchive = async function () { await handleUnarchiveChat(); window._wgSettingsRefresh(); };
