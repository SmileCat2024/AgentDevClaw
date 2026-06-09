// Feature 模板映射（从 API 动态加载）
let FEATURE_TEMPLATE_MAP = {};

// 加载 Feature 模板映射
async function loadFeatureTemplateMap() {
  try {
    const response = await fetch('/api/templates/feature');
    if (!response.ok) {
      return false;
    }
    const data = await response.json().catch(() => ({}));
    if (Object.keys(data).length > 0) {
      FEATURE_TEMPLATE_MAP = data;
      return true;
    }
    return false;
  } catch (e) {
    console.warn('[Viewer] Failed to load feature templates:', e);
    return false;
  }
}

// 加载单个 agent 的详情数据（workspace_data / sessions / state）
const loadedAgentDetailIds = new Set();
async function loadAgentDetail(agentId) {
  if (!agentId || loadedAgentDetailIds.has(agentId)) return;
  loadedAgentDetailIds.add(agentId);
  try {
    const res = await fetch('/protoclaw/agent_detail?agentId=' + encodeURIComponent(agentId));
    if (!res.ok) return;
    const detail = await res.json();
    const agent = allAgents.find((a) => a.id === agentId);
    if (agent) {
      Object.assign(agent, detail);
    }
  } catch (e) {
    console.warn('[Viewer] Failed to load agent detail:', agentId, e);
  }
}

// 重新加载 Feature 模板映射
async function reloadFeatureTemplateMap() {
  console.log('[Viewer] Reloading feature templates...');
  const success = await loadFeatureTemplateMap();
  if (success) {
    // 重新加载当前页面的工具配置
    if (currentRuntimeAgentId) {
      await loadAgentTools(currentRuntimeAgentId);
      // 重新渲染当前消息
      if (currentMessages.length > 0) {
        renderCurrentMainView();
      }
    }
  }
}

const VIEWER_BASE_URL = 'http://127.0.0.1:2026';
const PREBUILT_AGENTS = [];
const pendingPrebuiltAgentIds = new Set();
let suppressSidebarRerender = false;
const restartingRuntimeIds = new Set();
const nativeFetch = window.fetch.bind(window);
const USE_SAME_ORIGIN_VIEWER_PROXY = window.location.protocol === 'http:' && window.location.port === '1420';

window.fetch = function(input, init) {
  if (USE_SAME_ORIGIN_VIEWER_PROXY) {
    return nativeFetch(input, init);
  }
  if (typeof input === 'string' && input.startsWith('/api/')) {
    return nativeFetch(VIEWER_BASE_URL + input, init);
  }
  if (input instanceof Request && input.url.startsWith('/api/')) {
    return nativeFetch(VIEWER_BASE_URL + input.url, init);
  }
  return nativeFetch(input, init);
};

async function waitForViewerReady(timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await nativeFetch(
        USE_SAME_ORIGIN_VIEWER_PROXY ? '/api/agents' : (VIEWER_BASE_URL + '/api/agents'),
        { cache: 'no-store' }
      );
      if (response.ok) {
        return true;
      }
    } catch (error) {
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

async function invoke(command, payload = {}) {
  if (window.__PROTOCLAW_TAURI_BRIDGE__ && typeof window.__PROTOCLAW_TAURI_BRIDGE__.invoke === 'function') {
    try {
      return await window.__PROTOCLAW_TAURI_BRIDGE__.invoke(command, payload);
    } catch (error) {
      if (!(window.location.protocol === 'http:' && window.location.port === '1420')) {
        throw error;
      }
    }
  }
  if (window.location.protocol === 'http:' && window.location.port === '1420') {
    if (command === 'get_connected_agents') {
      const res = await fetch('/protoclaw/get_connected_agents');
      return res.ok ? res.json() : [];
    }
    if (command === 'get_prebuilt_agents') {
      const res = await fetch('/protoclaw/get_prebuilt_agents');
      return res.ok ? res.json() : [];
    }
    if (command === 'get_agents_status') {
      const res = await fetch('/protoclaw/get_agents_status');
      return res.ok ? res.json() : [];
    }
    if (command === 'start_agent') {
      const res = await fetch('/protoclaw/start_agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return res.json();
    }
    if (command === 'stop_agent') {
      const res = await fetch('/protoclaw/stop_agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return res.json();
    }
    if (command === 'restart_agent') {
      const res = await fetch('/protoclaw/restart_agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return res.json();
    }
    if (command === 'select_empty_directory') {
      const res = await fetch('/protoclaw/select_empty_directory', {
        method: 'POST',
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return res.json();
    }
    if (command === 'select_files') {
      const res = await fetch('/protoclaw/select_files', {
        method: 'POST',
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return res.json();
    }
    if (command === 'select_directory') {
      const res = await fetch('/protoclaw/select_directory', {
        method: 'POST',
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return res.json();
    }
  }

  throw new Error('Web invoke bridge is not available');
}

const container = document.getElementById('chat-container');
const statusBadge = document.getElementById('connection-status');
const agentList = document.getElementById('agent-list');
const prebuiltAgentList = document.getElementById('prebuilt-agent-list');
const toolAgentList = document.getElementById('tool-agent-list');
const externalAgentList = document.getElementById('external-agent-list');
const prebuiltGroup = document.getElementById('prebuilt-group');
const toolGroup = document.getElementById('tool-group');
const externalGroup = document.getElementById('external-group');
const prebuiltCount = document.getElementById('prebuilt-count');
const toolCount = document.getElementById('tool-count');
const externalCount = document.getElementById('external-count');
const currentAgentTitle = document.getElementById('current-agent-name');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const featurePanel = document.getElementById('feature-panel');
const featurePanelTitle = document.getElementById('feature-panel-title');
const featurePanelBody = document.getElementById('feature-panel-body');
const featurePanelResizer = document.getElementById('feature-panel-resizer');
const agentContextMenu = document.getElementById('agent-context-menu');
const restartAgentAction = document.getElementById('restart-agent-action');
const stopAgentAction = document.getElementById('stop-agent-action');
const deleteAgentAction = document.getElementById('delete-agent-action');
const sessionContextMenu = document.getElementById('session-context-menu');
const openSessionAction = document.getElementById('open-session-action');
const compactedResumeSessionAction = document.getElementById('compacted-resume-session-action');
const deleteSessionAction = document.getElementById('delete-session-action');
const compactContextMenu = document.getElementById('compact-context-menu');
const compactSummaryAction = document.getElementById('compact-summary-action');
const compactTrimAction = document.getElementById('compact-trim-action');
const compactBranchAction = document.getElementById('compact-branch-action');
const projectContextMenu = document.getElementById('project-context-menu');
const deleteProjectAction = document.getElementById('delete-project-action');
const featureRepoContextMenu = document.getElementById('feature-repo-context-menu');
const deleteFeatureAction = document.getElementById('delete-feature-action');
const ctxMenu = document.getElementById('ctx-menu');
const followLatestButton = document.getElementById('follow-latest-btn');
const workspaceTabsBar = document.getElementById('workspace-tabs-bar');
const projectDocsetToggle = document.getElementById('project-docset-toggle');
const chatProcessToggle = document.getElementById('chat-process-toggle');
const projectDocsetOverlay = document.getElementById('project-docset-overlay');
const projectDocsetSheet = document.getElementById('project-docset-sheet');
const railButtons = Array.from(document.querySelectorAll('.rail-button'));
const languageToggle = document.getElementById('language-toggle');
const themeToggle = document.getElementById('theme-toggle');
const settingsToggle = document.getElementById('settings-toggle');
if (projectDocsetToggle) {
  projectDocsetToggle.addEventListener('click', () => window.toggleProjectDocsetOverlay());
}
if (chatProcessToggle) {
  chatProcessToggle.addEventListener('click', () => window.toggleChatProcessVisibility());
}
if (projectDocsetOverlay) {
  projectDocsetOverlay.addEventListener('click', (event) => {
    if (event.target === projectDocsetOverlay) {
      window.toggleProjectDocsetOverlay(false);
    }
  });
}

let currentAgentId = null;
let currentRuntimeAgentId = null;
let readOnlyMode = false;
let loadAgentsInFlight = null;
const workspaceSurfaceModePreferences = {};
let allAgents = [];
// 追踪每个 agent 的 call 运行状态（实时更新，比 3s 轮询更快）
const _agentCallActive = new Map();
let currentMessages = [];
let currentInputRequests = [];
let choiceInputState = {};
let toolRenderConfigs = {};
let TOOL_NAMES = {};
let contextMenuAgentId = null;
let contextMenuAgentMode = null;
let contextMenuSessionAgentId = null;
let contextMenuSessionId = null;
let contextMenuSessionMode = null;
let contextMenuCompactAction = null;
let contextMenuProjectAgentId = null;
let contextMenuProjectId = null;
let contextMenuFeatureRepoPackageId = null;
let activeFeaturePanel = null;
let currentWorkspaceTab = null;
let shouldAnimateWorkspaceSurface = true;
let assemblyDraftRenderTimer = null;
let expandedProjectIds = new Set();
let savedPhTabState = {};
let assemblyLaunchInProgress = false;
let assemblyControlPanelOpen = false;
let assemblySideRailRevealTimer = null;
let currentWorkspaceArtifactDetail = null;
let currentWorkspaceDocsetDetail = null;
let currentProjectDocsetOpen = false;
let currentProjectRequirementEdit = null;
let currentProjectDocsetPage = 'requirement';
let featurePanelWidth = 500;
let currentTheme = localStorage.getItem('agentdev-theme') || 'dark';
let currentLanguage = localStorage.getItem('agentdev-language') || 'zh';
const CHAT_PROCESS_VISIBILITY_KEY = 'agentdev-chat-show-process';
function loadChatProcessVisibility() {
  try {
    return localStorage.getItem(CHAT_PROCESS_VISIBILITY_KEY) === 'true';
  } catch (error) {
    console.warn('Failed to load chat process visibility:', error);
    return false;
  }
}
let showChatProcess = loadChatProcessVisibility();
let currentHookInspector = { lifecycleOrder: [], features: [], hooks: [] };
let currentHookInspectorSignature = '';
let currentOverviewSnapshot = {
  updatedAt: 0,
  context: {
    messageCount: 0,
    charCount: 0,
    toolCallCount: 0,
    turnCount: 0,
  },
  usageStats: {
    totalUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    calls: [],
    totalRequests: 0,
    totalCacheHitRequests: 0,
  },
};
let currentOverviewSignature = '';
let currentLogs = [];
let currentLogsSignature = '';
let currentMcpInfo = null;
let logPanelScope = 'current';
let lastFeatureTemplateReloadAt = 0;
let lastAgentListRefreshAt = 0;
let lastCallStateRefreshAt = 0;
let templateWarmupToken = 0;
let qqbotConfigState = {
  data: null,
  draft: null,
  loading: false,
  saving: false,
  error: '',
  sourcePath: '',
  savedAt: null,
};
let qqbotConfigRequest = null;
let imWorkspaceState = {
  data: null,
  draft: null,
  loading: false,
  saving: false,
  binding: false,
  polling: false,
  error: '',
  savedAt: null,
  weixinQrDialogOpen: false,
};
let imWorkspaceRequest = null;
let imWorkspaceAutoSaveTimer = null;
let logFilters = {
  search: '',
  level: 'all',
  feature: 'all',
  lifecycle: 'all',
};
let selectedOverviewLifecycle = 'StepFinish';
let selectedFeatureName = null;
let selectedRepositoryPackageId = null;
let repoSearchQuery = '';
let repoSourceFilter = 'all';
let followLatestEnabled = true;
let suppressFollowScrollEvent = false;
let lastManualScrollIntentAt = 0;
let _progScrollCooldownUntil = 0;
let followLatestEntryUntil = 0;
let chatViewportObserversReady = false;
let chatViewportObserverSuppressDepth = 0;
let chatViewportObserverQuietUntil = 0;
let chatViewportMutationObserver = null;
let chatViewportResizeObserver = null;
let chatViewportSettlementToken = 0;
let chatViewportSettlementRaf = 0;
let chatViewportSettlementTimer = null;
let chatViewportSettlementContext = null;
let chatViewportFollowRaf = 0;
let chatViewportFollowToken = 0;
let chatViewportFollowTransition = 'locked';
let prebuiltSessionSwitchInFlight = false;
let pendingSwitchTarget = null;   // { runtimeId, serial, source }
let pendingSwitchSerial = 0;      // monotonically increasing
let lastRenderedInputSignature = '';
let lastRenderedInputMode = null;
let unitModePreferences = {};
let lastRenderedWorkspaceHtml = '';

const I18N = {
  zh: {
    page_title: 'Agent 调试器',
    sidebar_toggle: '切换侧栏',
    resize_panel: '调整面板宽度',
    chars: '字符',
    status_connected: '已连接',
    status_disconnected: '已断开',
    status_no_agent: '无 Agent',
    status_starting: '启动中',
    status_start_failed: '启动失败',
    empty_waiting: '等待消息中...',
    workspace_tab_welcome: '首页',
    workspace_tab_chat: '对话',
    workspace_tab_history: '历史',
    workspace_tab_form: '表单',
    workspace_tab_live: '状态',
    workspace_kicker: 'Agent Workspace',
    workspace_chat_empty: '这个 agent 还没有消息，可以先查看首页、历史或配置表单。',
    workspace_history_empty: '当前还没有对话记录。',
    workspace_history_current: '当前对话',
    workspace_history_updated: '最后更新时间',
    workspace_history_messages: '当前消息数',
    workspace_history_path: '会话文件',
    workspace_form_save: '保存表单',
    workspace_form_reset: '重置表单',
    workspace_form_saved: '已保存到本地浏览器草稿',
    workspace_form_empty: '当前 agent 没有声明预置表单。',
    workspace_pick_directory: '选择文件夹',
    workspace_pick_directory_hint: '仅当安装到指定路径时可选，请选择要创建 Feature 的父目录。',
    workspace_pick_directory_failed: '选择文件夹失败: ',
    workspace_install_mode_system: '放入系统工作区',
    workspace_install_mode_custom: '创建到指定路径',
    workspace_directory_not_selected: '尚未选择目录',
    feature_creator_invalid_name: 'Feature 名称不合法，只允许小写字母、数字和短横杠。',
    feature_creator_init_failed: '初始化 Feature 失败: ',
    feature_creator_output_dir: '将创建到',
    workspace_live_runtime: '运行时会话',
    workspace_live_status: '连接状态',
    workspace_live_pending: '待处理交互',
    workspace_live_session: '当前对话',
    workspace_live_config: '配置状态',
    workspace_open_chat: '进入对话',
    workspace_new_chat: '新对话',
    workspace_light_resume: '轻量继续',
    workspace_compacted_badge: '压缩继续',
    workspace_compacted_resume_confirm: '基于这条历史对话生成交接摘要，并在一个新会话里继续当前任务？',
    workspace_compacted_resume_failed: '轻量继续失败: ',
    workspace_compacted_resume_started: '已创建新的轻量继续会话。',
    workspace_new_project: '新建项目',
    workspace_select_directory_new_project: '选择目录并新建项目',
    workspace_compact_session: '编辑',
    workspace_compact_summary: '总结历史（摘要）',
    workspace_compact_trim: '精简历史（Trim）',
    workspace_compact_summary_confirm: '确定要总结历史并继续会话吗？',
    workspace_compact_trim_confirm: '确定要精简历史并继续会话吗？',
    workspace_compact_failed: '压缩会话失败：',
    workspace_session_delete: '删除',
    workspace_session_delete_confirm: '确定要删除会话「{{id}}」吗？此操作不可撤销。',
    qqbot_config_title: 'QQ 网关配置',
    qqbot_config_desc: '直接编辑当前项目里的 QQBot 配置文件。保存后会写入当前项目 .agentdev 目录。',
    qqbot_config_hint: '配置 QQ 机器人账号信息以启用消息接收',
    qqbot_config_ready: '已配置',
    qqbot_config_incomplete: '待完善',
    qqbot_config_loading: '正在加载配置...',
    qqbot_config_saving: '正在保存配置...',
    qqbot_config_reload: '重新加载',
    qqbot_config_save: '保存配置',
    qqbot_config_saved_at: '最近保存',
    qqbot_config_source: '配置文件',
    qqbot_config_apply_hint: '保存后会写入当前项目配置文件。若 QQ 网关已经在运行，重启后生效。',
    im_workspace_title: '门户代理身份配置',
    im_workspace_desc: '先给门户代理身份选择上下文，再决定它当前走哪条渠道。',
    im_workspace_loading: '正在加载 IM 配置...',
    im_workspace_saving: '正在保存 IM 配置...',
    im_workspace_binding: '正在生成微信二维码...',
    im_workspace_polling: '正在刷新微信绑定状态...',
    im_workspace_save: '保存配置',
    im_workspace_reload: '重新加载',
    im_workspace_start_weixin_bind: '生成微信二维码',
    im_workspace_view_qrcode: '查看二维码',
    im_workspace_refresh_weixin_bind: '刷新微信状态',
    im_workspace_logout_weixin: '解绑微信',
    im_workspace_selected_channel: '门户代理当前渠道',
    im_workspace_receptionist_session: '门户代理上下文',
    im_workspace_identity_title: '门户代理',
    im_workspace_channel_label: '线路名称',
    im_workspace_channel_role: '职责',
    im_workspace_channel_note: '备注',
    im_workspace_qq_section: 'QQ',
    im_workspace_weixin_section: '微信',
    im_workspace_weixin_hint: '扫描二维码或手动配置微信账号绑定',
    im_workspace_not_bound: '未绑定',
    im_workspace_bound: '已绑定',
    im_workspace_pending: '等待扫码',
    im_workspace_expired: '二维码已过期',
    im_workspace_start_hint: '当前只配置门户代理身份，运行时只会启动它选中的那条渠道。',
    im_workspace_source_workspace: '工作空间配置',
    im_workspace_source_qq: 'QQ 配置',
    im_workspace_source_weixin: '微信 配置',
    im_workspace_weixin_qrcode_hint: '用手机微信扫描二维码完成绑定，然后点击刷新微信状态。',
    im_workspace_weixin_qrcode_dialog_title: '微信扫码绑定',
    im_workspace_weixin_qrcode_dialog_desc: '请使用微信扫描下方二维码完成绑定。',
    im_workspace_no_session: '请先在下方对话记录里准备一条门户代理会话。',
    im_workspace_select_placeholder: '请选择',
    im_workspace_saved_at: '最近保存',
    im_workspace_new_chat: '新对话',
    im_workspace_auto_saved: '已自动保存',
    im_workspace_receptionist_hint: '点击任一对话后，会按当前身份配置启动门户代理。',
    panel_hint: '选择右侧功能按钮以展开面板。',
    panel_structure: '结构',
    panel_monitor: '监视',
    panel_features: '功能特性',
    panel_reverse_hooks: '反向钩子',
    panel_logs: '日志',
    panel_mcp: 'MCP',
    panel_loop_flow: '工作流',
    panel_runtime: '运行概览',
    panel_current_turn: '本轮',
    panel_session_total: '累计',
    panel_context: '上下文',
    panel_features_summary: '功能概览',
    panel_select_lifecycle: '选择一个生命周期阶段',
    panel_inspector: '检查器',
    panel_connection: '连接状态',
    panel_messages: '消息数',
    panel_usage: '用量',
    panel_features_label: '功能特性',
    panel_status_summary: '状态分布',
    panel_enabled: '已启用',
    panel_partial: '部分启用',
    panel_disabled: '已关闭',
    panel_removed: '已移除',
    panel_total: '总数',
    panel_all_features: '全部功能特性',
    panel_registered: '已注册',
    panel_no_features: '没有 Feature',
    panel_no_feature_data: '当前 Agent 尚未上报 feature 信息。',
    panel_feature_details: 'Feature 详情',
    panel_loaded_tools: '已加载工具',
    panel_no_tools: '当前没有已注册工具。',
    panel_close: '关闭',
    panel_no_hook_data: '没有 Hook 数据',
    panel_no_hook_data_desc: '当前 Agent 尚未上报 feature / hook 监视信息。',
    panel_all_lifecycle_slots: '完整 8 个生命周期槽位',
    panel_attached: '已挂载',
    panel_no_handlers: '当前没有挂载任何处理函数。',
    stat_active_agent: '当前 Agent',
    stat_context_length: '上下文长度',
    stat_turn_tokens: '本轮 Tokens',
    stat_total_tokens: '累计 Tokens',
    stat_cache_hit_rate: '缓存命中率',
    stat_turn_requests: '本轮请求数',
    metric_messages: '消息数',
    metric_chars: '字符数',
    metric_turns: '轮次',
    metric_tool_calls: '工具调用',
    metric_input_tokens: '输入',
    metric_output_tokens: '输出',
    metric_requests: 'LLM 请求',
    metric_cache_hit_requests: '命中请求',
    metric_cache_miss_requests: '未命中请求',
    metric_avg_per_request: '每次平均',
    metric_cache_read: '缓存读取',
    metric_cache_write: '缓存写入',
    metric_cache_hit_rate: '命中率',
    metric_input_share: '输入占比',
    metric_output_share: '输出占比',
    metric_latest_turn: '最近一轮',
    metric_session_total: '整个会话',
    metric_no_calls: '还没有 LLM 请求',
    metric_unavailable: '暂无',
    feature_source_missing: '暂无源码信息',
    feature_enabled: 'enabled',
    feature_partial: 'partial',
    feature_disabled: 'disabled',
    feature_removed: 'removed',
    feature_hooks: 'hooks',
    feature_tools: 'tools',
    feature_messages: '条消息',
    feature_registered_label: '已注册',
    feature_active_tools: '启用工具',
    feature_tool_enabled: 'enabled',
    feature_tool_disabled: 'disabled',
    feature_tool_removed: 'removed',
    feature_tool_render: 'render',
    feature_open_details: '查看详情',
    feature_status_label: '状态',
    mcp_section_kicker: 'MCP 服务器',
    mcp_hero_title: 'Debugger Hub MCP 服务',
    structure_kicker: 'ReAct 循环拓扑',
    structure_hero_title: 'Feature Hooks 映射',
    structure_subtitle: '查看当前 agent 的 hook 映射、循环阶段说明，以及用于阅读会话链路的开发者视角解释。',
    overview_kicker: '运行监视',
    overview_hero_title: 'LLM 调用监视',
    mcp_item_tool: '工具',
    mcp_item_resource: '资源',
    mcp_item_prompt: '提示模板',
    active_none: '无',
    delete_agent: '删除 Agent',
    close_agent_runtime: '关闭 Agent',
    restart_agent_runtime: '重启 Agent',
    delete_session: '删除对话',
    delete_confirm: '删除这个已断开的 Agent？这只会从当前调试界面移除它的记录。',
    close_prebuilt_confirm: '关闭这个预制代理的运行实例？',
    restart_prebuilt_confirm: '重启这个预制代理？会中断当前运行中的会话。',
    delete_session_confirm: '删除这条历史对话？此操作不可撤销。',
    delete_failed: '删除 Agent 失败: ',
    close_failed: '关闭 Agent 失败: ',
    restart_failed: '重启 Agent 失败: ',
    delete_session_failed: '删除对话失败: ',
    delete_project: '删除项目',
    delete_project_confirm: '删除这个项目及其所有对话记录？此操作不可撤销。',
    delete_project_failed: '删除项目失败: ',
    workspace_enter_development: '进入开发',
    workspace_conversation_count: '对话数',
    workspace_conversation_group: '对话记录',
    workspace_main_conversations: '我的对话',
    workspace_sub_conversations: '子代理对话',
    workspace_exploration_conversations: '探索记录',
    workspace_expand_records: '展开记录',
    workspace_collapse_records: '收起记录',
    workspace_feature_no_sessions: '还没有对话记录，但这个 Feature 项目仍然可以继续开发。',
    workspace_view_record: '查看记录',
    workspace_resume_sub: '继续',
    workspace_summary_generated: '已生成',
    workspace_summary_not_generated: '未生成',
    workspace_view_summary: '查看摘要',
    workspace_generate_summary: '生成摘要',
    workspace_summary_loading: '加载中...',
    workspace_summary_generating: '生成中...',
    workspace_summary_title: '探索摘要',
    workspace_regenerate_summary: '重新生成摘要',
    workspace_readonly_mode: '当前对话处于只读状态',
    workspace_no_summary_content: '暂无摘要内容',
    workspace_important_files: '重要文件',
    workspace_important_skills: '重要技能',
    theme_toggle_light: '切换到浅色模式',
    theme_toggle_dark: '切换到深色模式',
    language_toggle: '切换到英文',
    language_toggle_short: 'EN',
    structure_tooltip: '结构',
    monitor_tooltip: '监视',
    features_tooltip: '功能特性',
    reverse_hooks_tooltip: '反向钩子',
    logs_tooltip: '日志',
    mcp_tooltip: 'MCP',
    mcp_subtitle: '调试器内置的只读 MCP 服务器，可供外部客户端和 agent 自观察使用。',
    mcp_enabled: '已启用',
    mcp_disabled: '已禁用',
    mcp_endpoint: '端点',
    mcp_transport: '传输',
    mcp_tools: '工具',
    mcp_resources: '资源',
    mcp_prompts: '提示模板',
    mcp_client_config: '客户端配置',
    mcp_claude_desktop: 'Claude Desktop 配置',
    mcp_codex: 'Codex 配置',
    mcp_manual: '手动初始化示例',
    mcp_tool_list: '工具一览',
    mcp_resource_list: '资源一览',
    mcp_prompt_list: '提示模板一览',
    mcp_loading: '正在加载 MCP 信息...',
    logs_scope: '范围',
    logs_scope_current: '只看当前 Agent',
    logs_scope_all: '全部',
    logs_search: '搜索',
    logs_search_placeholder: '按消息、namespace、feature、hook 检索',
    logs_level: '级别',
    logs_level_all: '全部级别',
    logs_level_debug: 'Debug 及以上',
    logs_level_info: 'Info 及以上',
    logs_level_warn: 'Warn 及以上',
    logs_level_error: '仅 Error',
    logs_feature: 'Feature',
    logs_feature_all: '全部 Feature',
    logs_lifecycle: 'Lifecycle',
    logs_lifecycle_all: '全部生命周期',
    logs_empty: '当前筛选条件下没有日志。',
    logs_total: '日志',
    logs_details: '查看结构化数据',
    phase_thinking: '思考中',
    phase_content: '生成内容',
    phase_tool_calling: '工具调用',
    phase_tool_executing: '执行工具',
    phase_processing: '处理中',
    phase_completed: '已完成',
    phase_retry_waiting: '等待重试',
    phase_retry_requesting: '重新请求',
    phase_failed: '已失败',
    runtime_metric_thinking: '思考',
    runtime_metric_output: '输出',
    runtime_metric_tools: '工具',
    runtime_metric_elapsed: '耗时',
    runtime_metric_stage: '本阶段',
    runtime_metric_wait: '等待',
    runtime_metric_update: '更新',
    runtime_metric_retry: '重试',
    runtime_unit_chars: '字符',
    runtime_status_building_tools: '正在组织工具参数',
    runtime_status_executing_tools: '正在执行工具调用',
    runtime_status_waiting_model: '等待中',
    runtime_status_waiting_tool_results: '工具调用已发出，等待执行结果',
    runtime_status_thinking_active: '模型正在思考',
    runtime_status_streaming_active: '模型正在输出回复',
    runtime_status_processing: '等待框架继续处理',
    runtime_status_retry_waiting: '等待下一次重试',
    runtime_status_retry_requesting: '正在重新发起模型请求',
    runtime_status_disconnected: '与运行时连接中断',
    runtime_status_stale: '暂无新的运行更新',
    runtime_status_completed: '本轮调用刚刚完成',
    runtime_status_failed: '本轮调用失败',
    runtime_status_tool_count: '工具数',
    runtime_status_active_tool: '当前工具',
    input_placeholder: '正在与 Agent 对话',
    follow_latest_on: '跟随最新',
    follow_latest_off: '回到底部',
    expand: '展开',
    collapse: '收起',
    show_process: '显示过程',
    hide_process: '隐藏过程',
    thinking_process: '思考过程',
    hook_kind: 'hook',
    subagent: '子代理',
    subagent_done: '已完成',
    subagent_view_messages: '查看消息 >',
    delete_failed_generic: '删除失败',
    overview_subtitle: '查看上下文、Token 消耗和缓存命中等信息',
  },
  en: {
    page_title: 'Agent Debugger',
    sidebar_toggle: 'Toggle Sidebar',
    resize_panel: 'Resize panel',
    chars: 'chars',
    status_connected: 'Connected',
    status_disconnected: 'Disconnected',
    status_no_agent: 'No agent',
    status_starting: 'Starting',
    status_start_failed: 'Start failed',
    empty_waiting: 'Waiting for messages...',
    workspace_tab_welcome: 'Home',
    workspace_tab_chat: 'Chat',
    workspace_tab_history: 'History',
    workspace_tab_form: 'Form',
    workspace_tab_live: 'Live',
    workspace_kicker: 'Agent Workspace',
    workspace_chat_empty: 'This agent has no messages yet. You can start from the home view, history, or setup form.',
    workspace_history_empty: 'No saved conversations yet.',
    workspace_history_current: 'Current Conversation',
    workspace_history_updated: 'Last Updated',
    workspace_history_messages: 'Current Messages',
    workspace_history_path: 'Session File',
    workspace_form_save: 'Save Form',
    workspace_form_reset: 'Reset Form',
    workspace_form_saved: 'Saved to local browser draft',
    workspace_form_empty: 'This agent does not declare a preset form.',
    workspace_pick_directory: 'Choose Folder',
    workspace_pick_directory_hint: 'Only needed for custom installs. Choose the parent directory where the Feature folder will be created.',
    workspace_pick_directory_failed: 'Failed to choose folder: ',
    workspace_install_mode_system: 'Place in System Workspace',
    workspace_install_mode_custom: 'Create in Custom Path',
    workspace_directory_not_selected: 'No folder selected',
    feature_creator_invalid_name: 'Invalid feature name. Use lowercase letters, numbers, and hyphens only.',
    feature_creator_init_failed: 'Failed to initialize Feature: ',
    feature_creator_output_dir: 'Will create in',
    workspace_live_runtime: 'Runtime Session',
    workspace_live_status: 'Connection',
    workspace_live_pending: 'Pending Inputs',
    workspace_live_session: 'Current Conversation',
    workspace_live_config: 'Config',
    workspace_open_chat: 'Open Chat',
    workspace_new_chat: 'New Chat',
    workspace_light_resume: 'Light Resume',
    workspace_compacted_badge: 'Compacted',
    workspace_compacted_resume_confirm: 'Create a handoff summary from this conversation and continue the task in a new session?',
    workspace_compacted_resume_failed: 'Light resume failed: ',
    workspace_compacted_resume_started: 'Created a new compacted-resume session.',
    workspace_new_project: 'New Project',
    workspace_select_directory_new_project: 'Select Directory & New Project',
    workspace_compact_session: 'Edit',
    workspace_compact_summary: 'Summarize (Summary)',
    workspace_compact_trim: 'Trim History',
    workspace_compact_summary_confirm: 'Summarize the history and continue?',
    workspace_compact_trim_confirm: 'Trim the history and continue?',
    workspace_compact_failed: 'Failed to compact session: ',
    workspace_session_delete: 'Delete',
    workspace_session_delete_confirm: 'Are you sure you want to delete session "{{id}}"? This action cannot be undone.',
    qqbot_config_title: 'QQ Gateway Config',
    qqbot_config_desc: 'Edit the QQBot config inside this project. Saving writes to the local .agentdev directory.',
    qqbot_config_hint: 'Configure QQ bot account to enable message receiving',
    qqbot_config_ready: 'Configured',
    qqbot_config_incomplete: 'Incomplete',
    qqbot_config_loading: 'Loading config...',
    qqbot_config_saving: 'Saving config...',
    qqbot_config_reload: 'Reload',
    qqbot_config_save: 'Save Config',
    qqbot_config_saved_at: 'Last Saved',
    qqbot_config_source: 'Config File',
    qqbot_config_apply_hint: 'Saving writes to the current project config. Restart the running gateway to apply changes.',
    im_workspace_title: 'Portal Agent Identity Config',
    im_workspace_desc: 'Assign context to the portal agent identity, then choose which channel it should use.',
    im_workspace_loading: 'Loading IM config...',
    im_workspace_saving: 'Saving IM config...',
    im_workspace_binding: 'Generating Weixin QR code...',
    im_workspace_polling: 'Refreshing Weixin status...',
    im_workspace_save: 'Save Config',
    im_workspace_reload: 'Reload',
    im_workspace_start_weixin_bind: 'Generate Weixin QR',
    im_workspace_view_qrcode: 'View QR Code',
    im_workspace_refresh_weixin_bind: 'Refresh Weixin Status',
    im_workspace_logout_weixin: 'Unbind Weixin',
    im_workspace_selected_channel: 'Portal Agent Channel',
    im_workspace_receptionist_session: 'Portal Agent Context',
    im_workspace_identity_title: 'Portal Agent',
    im_workspace_channel_label: 'Line Name',
    im_workspace_channel_role: 'Role',
    im_workspace_channel_note: 'Note',
    im_workspace_qq_section: 'QQ',
    im_workspace_weixin_section: 'Weixin',
    im_workspace_weixin_hint: 'Scan QR code or manually configure Weixin account binding',
    im_workspace_not_bound: 'Not Bound',
    im_workspace_bound: 'Bound',
    im_workspace_pending: 'Waiting for Scan',
    im_workspace_expired: 'QR Expired',
    im_workspace_start_hint: 'Only the portal agent identity is configured for now, and only its selected channel will start.',
    im_workspace_source_workspace: 'Workspace Config',
    im_workspace_source_qq: 'QQ Config',
    im_workspace_source_weixin: 'Weixin Config',
    im_workspace_weixin_qrcode_hint: 'Scan the QR code in Weixin, then refresh the binding status.',
    im_workspace_weixin_qrcode_dialog_title: 'Weixin QR Binding',
    im_workspace_weixin_qrcode_dialog_desc: 'Scan the QR code below with Weixin to complete binding.',
    im_workspace_no_session: 'Create or pick a conversation below as the portal agent context first.',
    im_workspace_select_placeholder: 'Select',
    im_workspace_saved_at: 'Last Saved',
    im_workspace_new_chat: 'New Chat',
    im_workspace_auto_saved: 'Auto-saved',
    im_workspace_receptionist_hint: 'Click any conversation to start the portal agent with the current identity config.',
    panel_hint: 'Select a tool on the right rail to open the panel.',
    panel_structure: 'Structure',
    panel_monitor: 'Monitor',
    panel_features: 'Features',
    panel_reverse_hooks: 'Reverse Hooks',
    panel_logs: 'Logs',
    panel_mcp: 'MCP',
    panel_loop_flow: 'Workflow',
    panel_runtime: 'Runtime Overview',
    panel_current_turn: 'Current Turn',
    panel_session_total: 'Session Total',
    panel_context: 'Context',
    panel_features_summary: 'Feature Summary',
    panel_select_lifecycle: 'Select a lifecycle stage',
    panel_inspector: 'Inspector',
    panel_connection: 'Connection',
    panel_messages: 'Messages',
    panel_usage: 'Usage',
    panel_features_label: 'Features',
    panel_status_summary: 'Status Mix',
    panel_enabled: 'enabled',
    panel_partial: 'partial',
    panel_disabled: 'disabled',
    panel_removed: 'removed',
    panel_total: 'total',
    panel_all_features: 'All Features',
    panel_registered: 'registered',
    panel_no_features: 'No Features',
    panel_no_feature_data: 'The current agent has not reported feature metadata yet.',
    panel_feature_details: 'Feature Details',
    panel_loaded_tools: 'Loaded Tools',
    panel_no_tools: 'No tools are currently registered for this feature.',
    panel_close: 'Close',
    panel_no_hook_data: 'No Hook Data',
    panel_no_hook_data_desc: 'The current agent has not reported any feature / hook inspector data yet.',
    panel_all_lifecycle_slots: 'All 8 lifecycle slots',
    panel_attached: 'attached',
    panel_no_handlers: 'No attached handlers.',
    stat_active_agent: 'Active Agent',
    stat_context_length: 'Context Length',
    stat_turn_tokens: 'Turn Tokens',
    stat_total_tokens: 'Total Tokens',
    stat_cache_hit_rate: 'Cache Hit Rate',
    stat_turn_requests: 'Turn Requests',
    metric_messages: 'Messages',
    metric_chars: 'Characters',
    metric_turns: 'Turns',
    metric_tool_calls: 'Tool Calls',
    metric_input_tokens: 'Input',
    metric_output_tokens: 'Output',
    metric_requests: 'LLM Requests',
    metric_cache_hit_requests: 'Hit Requests',
    metric_cache_miss_requests: 'Miss Requests',
    metric_avg_per_request: 'Avg / Request',
    metric_cache_read: 'Cache Read',
    metric_cache_write: 'Cache Write',
    metric_cache_hit_rate: 'Hit Rate',
    metric_input_share: 'Input Share',
    metric_output_share: 'Output Share',
    metric_latest_turn: 'Latest Turn',
    metric_session_total: 'Whole Session',
    metric_no_calls: 'No LLM requests yet',
    metric_unavailable: 'N/A',
    feature_source_missing: 'No source metadata',
    feature_enabled: 'enabled',
    feature_partial: 'partial',
    feature_disabled: 'disabled',
    feature_removed: 'removed',
    feature_hooks: 'hooks',
    feature_tools: 'tools',
    feature_messages: 'messages',
    feature_registered_label: 'registered',
    feature_active_tools: 'Active Tools',
    feature_tool_enabled: 'enabled',
    feature_tool_disabled: 'disabled',
    feature_tool_removed: 'removed',
    feature_tool_render: 'render',
    feature_open_details: 'Open details',
    feature_status_label: 'Status',
    mcp_section_kicker: 'Model Context Protocol',
    mcp_hero_title: 'Debugger MCP Server',
    structure_kicker: 'ReAct Loop Topology',
    structure_hero_title: 'Feature Hooks Map',
    structure_subtitle: 'Inspect the current agent hook map, loop timing guide, and developer-facing explanations for reading the session flow.',
    overview_kicker: 'Runtime Monitor',
    overview_hero_title: 'Current turn, totals, and cache at a glance',
    mcp_item_tool: 'tool',
    mcp_item_resource: 'resource',
    mcp_item_prompt: 'prompt',
    active_none: 'None',
    delete_agent: 'Delete Agent',
    close_agent_runtime: 'Close Agent',
    restart_agent_runtime: 'Restart Agent',
    delete_session: 'Delete Session',
    delete_confirm: 'Delete this disconnected agent? This only removes it from the current debugger view.',
    close_prebuilt_confirm: 'Close this prebuilt agent runtime?',
    restart_prebuilt_confirm: 'Restart this prebuilt agent? The current running session will be interrupted.',
    delete_session_confirm: 'Delete this saved conversation? This cannot be undone.',
    delete_failed: 'Failed to delete agent: ',
    close_failed: 'Failed to close agent: ',
    restart_failed: 'Failed to restart agent: ',
    delete_session_failed: 'Failed to delete session: ',
    delete_project: 'Delete Project',
    delete_project_confirm: 'Delete this project and all its conversations? This cannot be undone.',
    delete_project_failed: 'Failed to delete project: ',
    workspace_enter_development: 'Enter Development',
    workspace_conversation_count: 'Conversations',
    workspace_conversation_group: 'Conversations',
    workspace_main_conversations: 'My Chats',
    workspace_sub_conversations: 'Sub-agents',
    workspace_exploration_conversations: 'Explorations',
    workspace_expand_records: 'Show Records',
    workspace_collapse_records: 'Hide Records',
    workspace_feature_no_sessions: 'No conversations yet, but this Feature project is still ready to continue development.',
    workspace_view_record: 'View Record',
    workspace_resume_sub: 'Resume',
    workspace_summary_generated: 'Generated',
    workspace_summary_not_generated: 'Not Generated',
    workspace_view_summary: 'View Summary',
    workspace_generate_summary: 'Generate Summary',
    workspace_summary_loading: 'Loading...',
    workspace_summary_generating: 'Generating...',
    workspace_summary_title: 'Exploration Summary',
    workspace_regenerate_summary: 'Regenerate Summary',
    workspace_readonly_mode: 'This conversation is in read-only mode',
    workspace_no_summary_content: 'No summary content available',
    workspace_important_files: 'Important Files',
    workspace_important_skills: 'Important Skills',
    theme_toggle_light: 'Switch to light mode',
    theme_toggle_dark: 'Switch to dark mode',
    language_toggle: 'Switch to Chinese',
    language_toggle_short: '中',
    structure_tooltip: 'Structure',
    monitor_tooltip: 'Monitor',
    features_tooltip: 'Features',
    reverse_hooks_tooltip: 'Reverse Hooks',
    logs_tooltip: 'Logs',
    mcp_tooltip: 'MCP',
    mcp_subtitle: 'Built-in read-only MCP server for external clients and agent self-observation.',
    mcp_enabled: 'Enabled',
    mcp_disabled: 'Disabled',
    mcp_endpoint: 'Endpoint',
    mcp_transport: 'Transport',
    mcp_tools: 'Tools',
    mcp_resources: 'Resources',
    mcp_prompts: 'Prompts',
    mcp_client_config: 'Client Config',
    mcp_claude_desktop: 'Claude Desktop config',
    mcp_codex: 'Codex config',
    mcp_manual: 'Manual initialize example',
    mcp_tool_list: 'Tool Catalog',
    mcp_resource_list: 'Resource Catalog',
    mcp_prompt_list: 'Prompt Catalog',
    mcp_loading: 'Loading MCP info...',
    logs_scope: 'Scope',
    logs_scope_current: 'Current agent',
    logs_scope_all: 'All agents',
    logs_search: 'Search',
    logs_search_placeholder: 'Search message, namespace, feature, hook',
    logs_level: 'Level',
    logs_level_all: 'All levels',
    logs_level_debug: 'Debug and up',
    logs_level_info: 'Info and up',
    logs_level_warn: 'Warn and up',
    logs_level_error: 'Error only',
    logs_feature: 'Feature',
    logs_feature_all: 'All features',
    logs_lifecycle: 'Lifecycle',
    logs_lifecycle_all: 'All lifecycles',
    logs_empty: 'No logs match the current filters.',
    logs_total: 'logs',
    logs_details: 'Structured payload',
    phase_thinking: 'Thinking',
    phase_content: 'Streaming',
    phase_tool_calling: 'Tool Calling',
    phase_tool_executing: 'Executing Tools',
    phase_processing: 'Processing',
    phase_completed: 'Completed',
    phase_retry_waiting: 'Retry Waiting',
    phase_retry_requesting: 'Retrying',
    phase_failed: 'Failed',
    runtime_metric_thinking: 'Thinking',
    runtime_metric_output: 'Output',
    runtime_metric_tools: 'Tools',
    runtime_metric_elapsed: 'Elapsed',
    runtime_metric_stage: 'Stage',
    runtime_metric_wait: 'Wait',
    runtime_metric_update: 'Updated',
    runtime_metric_retry: 'Retry',
    runtime_unit_chars: 'chars',
    runtime_status_building_tools: 'Preparing tool arguments',
    runtime_status_executing_tools: 'Running tool calls',
    runtime_status_waiting_model: 'Waiting',
    runtime_status_waiting_tool_results: 'Tool calls were issued, waiting for results',
    runtime_status_thinking_active: 'The model is reasoning',
    runtime_status_streaming_active: 'The model is streaming a reply',
    runtime_status_processing: 'Waiting for the runtime to continue',
    runtime_status_retry_waiting: 'Waiting before the next retry',
    runtime_status_retry_requesting: 'Requesting the model again',
    runtime_status_disconnected: 'Runtime connection lost',
    runtime_status_stale: 'No new runtime updates yet',
    runtime_status_completed: 'This call just finished',
    runtime_status_failed: 'This call failed',
    runtime_status_tool_count: 'Tool count',
    runtime_status_active_tool: 'Active tool',
    input_placeholder: 'Chatting with the agent',
    follow_latest_on: 'Following Latest',
    follow_latest_off: 'Jump to Latest',
    expand: 'Expand',
    collapse: 'Collapse',
    show_process: 'Show Process',
    hide_process: 'Hide Process',
    thinking_process: 'Thinking Process',
    hook_kind: 'hook',
    subagent: 'SubAgent',
    subagent_done: 'Completed',
    subagent_view_messages: 'View messages >',
    delete_failed_generic: 'Delete failed',
    overview_subtitle: 'Separate current context, current-turn usage, session totals, and request-level cache hits so each metric means exactly one thing.',
  },
};

function t(key) {
  const table = I18N[currentLanguage] || I18N.zh;
  return table[key] || key;
}

function getFeatureStatus(feature) {
  return feature && feature.status ? feature.status : (feature && feature.enabled ? 'enabled' : 'partial');
}

function getFeatureStatusLabel(status) {
  if (status === 'removed') return t('feature_removed');
  if (status === 'disabled') return t('feature_disabled');
  if (status === 'partial') return t('feature_partial');
  return t('feature_enabled');
}

function getStatusBadgeClass(status) {
  return 'feature-badge status-' + escapeHtml(status || 'enabled');
}

function getEmptyStateHtml() {
  return '<div class="empty-state">' + escapeHtml(t('empty_waiting')) + '</div>';
}

function getFeaturePanelEmptyHtml() {
  return '<div class="feature-panel-empty"><div>' + escapeHtml(t('panel_hint')) + '</div></div>';
}

function localizeWorkspaceValue(value, fallback = '') {
  if (value == null) return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object') {
    return String(value[currentLanguage] || value.zh || value.en || fallback);
  }
  return fallback;
}

function formatWorkspaceDate(isoString) {
  if (!isoString) return '-';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  return date.toLocaleString(currentLanguage === 'zh' ? 'zh-CN' : 'en-US');
}

function convertLegacyWorkspaceToUi(workspace) {
  if (!workspace || typeof workspace !== 'object') return null;

  const blocks = [];
  if (workspace.welcome) {
    blocks.push({
      id: 'hero',
      type: 'hero',
      title: workspace.welcome.title,
      body: workspace.welcome.body,
    });
  }

  const legacyActions = Array.isArray(workspace.welcome?.actions) ? workspace.welcome.actions : [];
  if (legacyActions.length > 0) {
    blocks.push({
      id: 'entry-actions',
      type: 'action-group',
      actions: legacyActions.map((action) => ({
        label: getLegacyActionLabel(action),
        action: { type: action === 'chat' ? 'show_chat' : 'show_block', target: getLegacyActionTarget(action) },
      })),
    });
  }

  if (workspace.history) {
    blocks.push({ id: 'history', type: 'session-list', visibility: 'focus', ...workspace.history });
  }
  if (workspace.form) {
    blocks.push({ id: 'form', type: 'form', visibility: 'focus', submitAction: { type: 'show_chat' }, ...workspace.form });
  }
  if (workspace.live) {
    blocks.push({ id: 'status', type: 'status-grid', ...workspace.live });
  }

  return { entry: workspace.entryView === 'chat' ? 'chat' : 'home', home: { blocks } };
}

function getLegacyActionLabel(action) {
  if (action === 'history') return { zh: '继续会话', en: 'Continue Session' };
  if (action === 'form') return { zh: '新对话', en: 'New Chat' };
  if (action === 'live') return { zh: '查看状态', en: 'View Status' };
  return { zh: '进入对话', en: 'Open Chat' };
}

function getLegacyActionTarget(action) {
  if (action === 'history') return 'history';
  if (action === 'form') return 'form';
  if (action === 'live') return 'status';
  return null;
}

function getCurrentUnitUi(agent = getCurrentAgentRecord()) {
  if (!agent) return null;
  if (agent.ui && typeof agent.ui === 'object') return agent.ui;
  if (agent.workspace && typeof agent.workspace === 'object') return convertLegacyWorkspaceToUi(agent.workspace);
  return null;
}

function isUiOnlyUnit(agent) {
  return !!(agent && agent.source === 'prebuilt' && agent.launchMode === 'ui-only');
}

function isWorkspaceHostUnit(agent) {
  return !!(agent && agent.source === 'prebuilt' && (agent.id === 'agent-creator' || agent.id === 'feature-creator' || agent.id === 'qqbot' || agent.id === 'programming-helper' || agent.id === 'flow-workspace'));
}

function isWorkspaceSurfaceUnit(agent) {
  return isUiOnlyUnit(agent) || isWorkspaceHostUnit(agent);
}

function isUiOnlyAgentId(agentId) {
  const directAgent = allAgents.find((item) => item.id === agentId);
  if (directAgent) {
    return isWorkspaceSurfaceUnit(directAgent);
  }
  const runtimeAgent = allAgents.find((item) => !isWorkspaceSurfaceUnit(item) && getAgentRuntimeId(item) === agentId);
  return isWorkspaceSurfaceUnit(runtimeAgent);
}

function getRuntimeRecord(agentId = currentRuntimeAgentId) {
  if (!agentId) return null;
  return allAgents.find((item) => !isWorkspaceSurfaceUnit(item) && getAgentRuntimeId(item) === agentId) || null;
}

function findAgentByIdentity(agentId) {
  if (!agentId) return null;
  return allAgents.find((item) =>
    item.id === agentId
    || item.runtime_session_id === agentId
    || item.runtimeSessionId === agentId
    || (!isWorkspaceSurfaceUnit(item) && getAgentRuntimeId(item) === agentId)
  ) || null;
}

function resolveWorkspaceFallbackAgentId(agent = getCurrentAgentRecord()) {
  if (currentAgentId && allAgents.some((item) => item.id === currentAgentId)) {
    return currentAgentId;
  }
  const parentId = String(agent?.parent_id || '').trim();
  if (parentId && allAgents.some((item) => item.id === parentId)) {
    return parentId;
  }
  if (allAgents.some((item) => item.id === 'agent-creator')) return 'agent-creator';
  if (allAgents.some((item) => item.id === 'home')) return 'home';
  return allAgents[0]?.id || null;
}
