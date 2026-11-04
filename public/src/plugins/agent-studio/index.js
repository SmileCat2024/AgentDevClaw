/**
 * agent-studio 前端插件 — Agent Studio 工作空间的首页视图。
 *
 * 形态：ES 模块插件（public/src/plugins/agent-studio/）。两个 block
 * （studio-features / studio-repository）从 workspace-blocks.js 分离而来：
 * 那个文件同时承载 hero / form / status-grid 等宿主通用组件，Studio 专属
 * 视图混在其中无法单独装载与卸载。
 *
 * 宿主能力经 mount(host) 注入：
 *   host.env.{language, escapeHtml, formatDate, openFeatureView, closeFeatureView}
 *   host.workspace.{currentAgent?, featureRepository, sessions}
 * 模块作用域看不到 classic script 的顶层变量，一律经注入取用。
 */

let pluginHost = null;

const escapeHtml = (v) => (pluginHost ? pluginHost.env.escapeHtml(v) : String(v ?? ''));
const formatWorkspaceDate = (v) => (pluginHost ? pluginHost.env.formatDate(v) : '');
const getAgentWorkspaceState = (agent) => pluginHost?.workspace?.workspaceState?.(agent) || null;
const getWorkspaceSessions = (agent) => pluginHost?.workspace?.sessions?.(agent) || [];
const getFeatureRepositoryData = (agent, block) => pluginHost?.workspace?.featureRepository?.(agent, block) || null;

// 双语取词：语言来自注入面（classic script 的 currentLanguage 是顶层 let，
// 插件不裸引用，宿主换实现时只改 claw-host.js）
const localeText = (zh, en) => (pluginHost?.env?.language === 'zh' ? zh : en);

function getStudioViewState() {
  try { return JSON.parse(localStorage.getItem('agent-studio-view') || '{}'); }
  catch { return {}; }
}

function setStudioViewState(next) {
  localStorage.setItem('agent-studio-view', JSON.stringify(next));
}

function openStudioFeature(featureId) {
  setStudioViewState({ ...getStudioViewState(), featureId });
  pluginHost?.workspace?.setUnitMode?.('home');
  pluginHost?.workspace?.rerender?.();
}

function closeStudioFeature() {
  const state = getStudioViewState();
  if (!state.featureId) return;
  const next = { ...state };
  delete next.featureId;
  setStudioViewState(next);
  pluginHost?.workspace?.rerender?.();
}

// Esc 关闭详情：委托句柄在 mount 时挂、unmount 时摘（document 级监听不随 DOM 消失）
let studioKeyHandler = null;

// Studio 空态：复用挂载管理页 .ph-mount-empty-cta 视觉配方（虚线卡片 + 图标 + 标题 + 描述）
function renderStudioEmptyCta(title, desc) {
  return '<div class="ph-mount-empty-cta">'
    + '<div class="ph-mount-empty-icon" aria-hidden="true">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">'
    + '<rect x="3" y="3" width="18" height="18" rx="2"></rect>'
    + '<path d="M12 8v8"></path>'
    + '<path d="M8 12h8"></path>'
    + '</svg></div>'
    + '<div class="ph-mount-empty-title">' + escapeHtml(title) + '</div>'
    + '<div class="ph-mount-empty-desc">' + escapeHtml(desc) + '</div>'
    + '</div>';
}

// Studio 视图分页栏：banner 下方的 surface 内元素，只在 Feature/仓库两个
// Studio 视图间切换（show_home / show_workspace_tab 均为既有通用动作），
// 不使用全局 workspace-tabs-bar（那会插手工作空间模式状态）。
function renderStudioTabBar(active) {
  const tabs = [
    { id: 'home', label: 'Feature', action: { type: 'show_home' } },
    { id: 'repository', label: pluginHost.env.language === 'zh' ? 'Feature 仓库' : 'Feature Repository', action: { type: 'show_workspace_tab', tab: 'repository' } },
  ];
  return '<div class="ph-session-tab-bar studio-view-tab-bar"><div class="ph-session-tabs-row">'
    + tabs.map((tab) => '<button class="ph-session-tab studio-view-tab' + (tab.id === active ? ' active' : '') + '" type="button" data-workspace-action="' + escapeHtml(JSON.stringify(tab.action)) + '" data-action="agent-studio.workspaceAction">' + escapeHtml(tab.label) + '</button>').join('')
    + '</div></div>';
}

// 状态徽标文案（feature 状态机：implemented → mounted → verified → snapshotted）
function studioFeatureStatusLabel(status, isZh) {
  const labels = {
    implemented: isZh ? '已实现' : 'implemented',
    mounted: isZh ? '已挂载' : 'mounted',
    verified: isZh ? '已验证' : 'verified',
    snapshotted: isZh ? '已快照' : 'snapshotted',
  };
  return labels[status] || labels.implemented;
}

// 会话 ↔ feature 绑定（ADR-0022）：light record 顶层或 metadata 内的 id 数组
function getSessionFeatureIds(session) {
  const ids = Array.isArray(session?.studioFeatureIds)
    ? session.studioFeatureIds
    : (Array.isArray(session?.metadata?.studioFeatureIds) ? session.metadata.studioFeatureIds : []);
  return ids.map((id) => String(id || '').trim()).filter(Boolean);
}

function renderStudioFeaturesBlock(agent, block) {
  const workspaceState = getAgentWorkspaceState(agent);
  const features = Array.isArray(workspaceState?.studioFeatures) ? workspaceState.studioFeatures : [];
  const isZh = pluginHost.env.language === 'zh';
  const cards = features.map((feature) => {
    const id = String(feature.id || '');
    if (!id) return '';
    const openAction = escapeHtml(JSON.stringify({ type: 'open_studio_feature', featureId: id }));
    const statusLabel = studioFeatureStatusLabel(feature.status, isZh);
    const detailParts = [
      feature.updatedAt ? formatWorkspaceDate(feature.updatedAt) : '',
    ].filter(Boolean);
    return '<div class="feature-card" style="cursor:pointer;" title="' + escapeHtml(feature.description || id) + '"'
      + ' data-workspace-action="' + openAction + '" data-action="agent-studio.workspaceAction">'
      + '<div class="feature-card-top"><div class="feature-card-main"><span class="feature-card-dot"></span>'
      + '<div style="min-width:0;"><div class="feature-card-name">' + escapeHtml(id) + '</div>'
      + (feature.description ? '<div class="feature-card-file">' + escapeHtml(feature.description) + '</div>' : '')
      + '</div></div>'
      + '<div class="workspace-history-meta">' + escapeHtml(statusLabel) + '</div></div>'
      + '<div class="feature-card-detail"><span>'
      + (feature.directoryExists === false
        ? escapeHtml(isZh ? '目录缺失：' : 'Directory missing: ') + escapeHtml(feature.directory || '')
        : escapeHtml(feature.directory || ''))
      + '</span>'
      + (detailParts.length > 0 ? '<span>' + detailParts.map(escapeHtml).join('</span><span>') + '</span>' : '')
      + '</div>'
      + '</div>';
  }).join('');
  // 「最近的对话」：尚未绑定任何 feature 的会话（新建对话在 feature 诞生前也在这里）
  const unbound = getWorkspaceSessions(agent)
    .filter((session) => getSessionFeatureIds(session).length === 0)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, 5);
  const recentHtml = unbound.length
    ? '<div class="workspace-section-header"><div><div class="workspace-section-title">' + escapeHtml(isZh ? '最近的对话' : 'Recent conversations') + '</div></div></div>'
      + '<div class="workspace-history-list">' + unbound.map((session) => {
        const openAction = escapeHtml(JSON.stringify({ type: 'open_session', sessionId: session.id }));
        return '<div class="workspace-history-item"><div class="workspace-history-main"><div class="workspace-history-title">' + escapeHtml(session.title || session.id) + '</div>'
          + '<div class="workspace-history-meta">' + escapeHtml(formatWorkspaceDate(session.updatedAt)) + '</div></div>'
          + '<div class="workspace-history-side"><button class="workspace-action secondary" type="button" data-workspace-action="' + openAction + '" data-action="agent-studio.workspaceAction">' + escapeHtml(isZh ? '打开会话' : 'Open session') + '</button></div></div>';
      }).join('') + '</div>'
    : '';
  const bodyHtml = cards
    ? '<div class="feature-grid">' + cards + '</div>' + recentHtml
    : (recentHtml
      ? recentHtml
      : renderStudioEmptyCta(
        isZh ? '还没有 Feature' : 'No features yet',
        isZh ? '点击右上角「新建对话」选择工作目录，在对话里开发第一个 Feature。' : 'Click "New conversation" to pick a working directory and develop your first feature.',
      ));
  return '<section class="workspace-section">'
    + renderStudioTabBar('home')
    + bodyHtml
    + '</section>'
    + (getStudioViewState().featureId ? renderStudioFeatureDetailBlock(agent) : '');
}

function renderStudioFeatureDetailBlock(agent) {
  const features = getAgentWorkspaceState(agent)?.studioFeatures || [];
  const state = getStudioViewState();
  const feature = features.find((entry) => String(entry.id) === String(state.featureId)) || null;
  const isZh = pluginHost.env.language === 'zh';
  if (!feature) {
    return '';
  }
  const directory = String(feature.directory || '');
  const directoryMissing = feature.directoryExists === false;
  const snapshotVersion = feature.snapshot?.version ? 'v' + String(feature.snapshot.version) : '—';
  // 会话按最近活动倒序：弹窗里最近的开发对话应最先被看到
  const sessions = getWorkspaceSessions(agent)
    .filter((session) => getSessionFeatureIds(session).includes(String(feature.id)))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const sessionsHtml = sessions.length
    ? '<div class="workspace-history-list">' + sessions.map((session) => {
        const openAction = escapeHtml(JSON.stringify({ type: 'open_session', sessionId: session.id }));
        return '<div class="workspace-history-item"><div class="workspace-history-main"><div class="workspace-history-title">' + escapeHtml(session.title || session.id) + '</div>'
          + '<div class="workspace-history-meta">' + escapeHtml(formatWorkspaceDate(session.updatedAt)) + '</div></div>'
          + '<div class="workspace-history-side"><button class="workspace-action secondary" type="button" data-workspace-action="' + openAction + '" data-action="agent-studio.closeThenAction">' + escapeHtml(isZh ? '打开' : 'Open') + '</button></div></div>';
      }).join('') + '</div>'
    : renderStudioEmptyCta(isZh ? '还没有开发会话' : 'No development sessions yet', isZh ? '新建对话，继续开发这个 Feature。' : 'Start a conversation to keep working on this feature.');
  // 目录预填：从卡片进入的「新建对话」不弹目录选择器（workspace-actions 的
  // resolveStudioSessionDirectory 仅在缺目录时弹窗）
  const createAction = escapeHtml(JSON.stringify({ type: 'create_session', studioFeatureIds: [feature.id], openDirectory: directory }));
  // 弹窗布局对齐设置弹窗范式（model-settings.js）：定高窗口 overflow:hidden，
  // 头部/统计/目录固定，会话列表独占 settings-tab-content 滚动区，
  // 新建对话放 settings-footer 固定底栏——列表再长，动作始终可达。
  return '<div class="feature-detail-overlay" role="presentation" data-action="agent-studio.overlayClose">'
    + '<div class="feature-detail-window" role="dialog" aria-modal="true" style="height:min(100%,660px);overflow:hidden;">'
    + '<div style="flex-shrink:0;display:flex;flex-direction:column;gap:16px;">'
    + '<div class="feature-detail-head">'
    + '<div>'
    + '<div class="feature-detail-title">' + escapeHtml(feature.id)
    + '<span class="gateway-detail-type-badge">' + escapeHtml(studioFeatureStatusLabel(feature.status, isZh)) + '</span>'
    + '</div>'
    + '<div class="feature-detail-subtitle">' + escapeHtml(feature.description || feature.name || feature.id) + '</div>'
    + '</div>'
    + '<button class="feature-detail-close" type="button" title="' + escapeHtml(isZh ? '关闭' : 'Close') + '" data-action="agent-studio.closeFeature">×</button>'
    + '</div>'
    + '<div class="feature-detail-stats">'
    + '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(isZh ? '快照版本' : 'Snapshot') + '</div><div class="feature-detail-stat-value">' + escapeHtml(snapshotVersion) + '</div></div>'
    + '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(isZh ? '开发对话' : 'Sessions') + '</div><div class="feature-detail-stat-value">' + sessions.length + '</div></div>'
    + '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(isZh ? '最近活动' : 'Updated') + '</div><div class="feature-detail-stat-value">' + escapeHtml(feature.updatedAt ? formatWorkspaceDate(feature.updatedAt) : '—') + '</div></div>'
    + '</div>'
    + '<div>'
    + '<div class="feature-detail-source">' + escapeHtml(directory || '—') + '</div>'
    + (directoryMissing
      ? '<div class="workspace-repo-warning">' + escapeHtml(isZh ? '目录已不存在，Feature 记录保留。恢复目录后可继续开发。' : 'The directory no longer exists; the feature record is kept. Restore it to continue development.') + '</div>'
      : '')
    + '</div>'
    + '</div>'
    + '<div class="settings-tab-content">'
    + '<div class="settings-section">'
    + '<div class="settings-section-title">' + escapeHtml(isZh ? '开发对话' : 'Conversations') + '</div>'
    + sessionsHtml
    + '</div>'
    + '</div>'
    + '<div class="settings-footer"><div class="settings-actions">'
    + '<button class="settings-btn settings-btn-primary" type="button" data-workspace-action="' + createAction + '" data-action="agent-studio.closeThenAction"' + (directoryMissing ? ' disabled title="' + escapeHtml(isZh ? '目录缺失，无法新建对话' : 'Directory missing; cannot start a conversation') + '"' : '') + '>' + escapeHtml(isZh ? '新建对话' : 'New conversation') + '</button>'
    + '</div></div>'
    + '</div>'
    + '</div>';
}

function renderStudioRepositoryBlock(agent, block) {
  const isZh = pluginHost.env.language === 'zh';
  const repository = getFeatureRepositoryData(agent, block);
  const packages = Array.isArray(repository?.packages) ? repository.packages : [];
  let bodyHtml;
  if (!repository || repository.error) {
    bodyHtml = renderStudioEmptyCta(
      isZh ? '仓库数据暂不可用' : 'Repository data is unavailable',
      String(repository?.error || ''),
    );
  } else if (packages.length === 0) {
    bodyHtml = renderStudioEmptyCta(
      isZh ? '仓库还是空的' : 'The repository is empty',
      isZh ? '对话中创建快照或导入 tgz 包后，会收录到这里。' : 'Snapshots created in conversations and imported tgz packages will be collected here.',
    );
  } else {
    bodyHtml = '<div class="feature-grid">' + packages.map((item) => {
      const versions = Array.isArray(item.versions) ? item.versions : [];
      const warnings = Array.isArray(item.warnings) ? item.warnings : [];
      const detailParts = [
        item.packageName && item.packageName !== item.name ? item.packageName : '',
        (item.archiveCount || versions.length) > 1
          ? localeText(`${item.archiveCount || versions.length} 个版本`, `${item.archiveCount || versions.length} versions`)
          : '',
        item.updatedAt ? formatWorkspaceDate(item.updatedAt) : '',
      ].filter(Boolean);
      return '<div class="feature-card" style="cursor:default;" title="' + escapeHtml(String(item.name || item.id || '')) + '">'
        + '<div class="feature-card-top"><div class="feature-card-main"><span class="feature-card-dot"></span>'
        + '<div style="min-width:0;"><div class="feature-card-name">' + escapeHtml(String(item.name || item.id || '')) + '</div>'
        + (item.description ? '<div class="feature-card-file">' + escapeHtml(String(item.description)) + '</div>' : '')
        + '</div></div>'
        + '<div class="feature-card-badges">'
        + '<span class="workspace-repo-badge ready">v' + escapeHtml(String(item.latestVersion || '-')) + '</span>'
        + (warnings.length > 0
          ? '<span class="workspace-repo-badge warn" title="' + escapeHtml(warnings.join('\n')) + '">' + escapeHtml(localeText('元数据不完整', 'Incomplete metadata')) + '</span>'
          : '')
        + '</div></div>'
        + (detailParts.length > 0 ? '<div class="feature-card-detail"><span>' + detailParts.map(escapeHtml).join('</span><span>') + '</span></div>' : '')
        + '</div>';
    }).join('') + '</div>';
  }

  return [
    '<section class="workspace-section">',
    renderStudioTabBar('repository'),
    bodyHtml,
    '</section>',
  ].join('');
}


// ── 插件协议 ────────────────────────────────────────────────────

export default {
  id: 'agent-studio',

  blocks: {
    'studio-features': (agent, block) => renderStudioFeaturesBlock(agent, block),
    'studio-repository': (agent, block) => renderStudioRepositoryBlock(agent, block),
  },

  actions: {
    'agent-studio.workspaceAction': (el) => (
      pluginHost.workspace.runAction(el.dataset.workspaceAction, el)
    ),
    // 详情页里的动作：先关详情，再让宿主执行工作空间动作（原内联写的两条语句）
    'agent-studio.closeThenAction': (el) => {
      closeStudioFeature();
      pluginHost.workspace.runAction(el.dataset.workspaceAction, el);
    },
    'agent-studio.openFeature': (el) => openStudioFeature(el.dataset.featureId || ''),
    // 宿主转交入口（action.type = open_studio_feature，featureId 作为尾参传入）
    'agent-studio.openFeatureById': (_el, _event, featureId) => openStudioFeature(featureId || ''),
    'agent-studio.closeFeature': () => closeStudioFeature(),
    // 点遮罩空白处关闭；点内容区不关（原内联判断 event.target === this）
    'agent-studio.overlayClose': (el, event) => {
      if (event?.target === el) closeStudioFeature();
    },
  },

  mount(h) {
    pluginHost = h;
    if (!studioKeyHandler) {
      studioKeyHandler = (event) => {
        if (event.key === 'Escape' && getStudioViewState().featureId) closeStudioFeature();
      };
      document.addEventListener('keydown', studioKeyHandler);
    }
  },

  unmount() {
    if (studioKeyHandler) document.removeEventListener('keydown', studioKeyHandler);
    studioKeyHandler = null;
    pluginHost = null;
  },
};
