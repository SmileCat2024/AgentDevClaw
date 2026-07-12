/**
 * wg-state.js — 群聊 UI 共享状态层
 *
 * 所有子文件通过 WgState.xxx 读写共享状态。
 * 共享常量通过全局 const 声明，以 WG_ 前缀避免命名冲突。
 * 各域私有常量声明在对应域文件中，不在此重复。
 */

// ── 模式定义（core + settings 共享） ──────────────────────────

// 响应模式：控制 Agent 何时介入
const WG_INITIATIVE_MODES = [
  { value: 'assist', label: '被动响应', short: '被动', desc: '仅被 @提及时才响应' },
  { value: 'plan', label: '交互确认', short: '交互', desc: '自动响应，执行前需确认' },
  { value: 'execute', label: '自主执行', short: '自主', desc: '自动接收并执行任务' },
];

// 执行策略：控制 Agent 的自主裁决空间
const WG_AUTONOMY_MODES = [
  { value: 'auto', label: '放手执行', short: '放手', desc: '拿到任务就做，自行判断' },
  { value: 'cautious', label: '遇疑暂停', short: '审慎', desc: '正常推进，不确定时询问' },
  { value: 'confirm', label: '先方案后执行', short: '先方案', desc: '先出方案，确认后再执行' },
];

// hover popover 延迟（ms）— core refreshAdminBarOnly + popover onContainerMouseOver 共用
const WG_HOVER_DELAY = 120;

// ── 共享状态对象 ──────────────────────────────────────────────

window.WgState = {
  // 核心数据
  chatSummaries: [],
  activeChat: null,
  activeChatId: null,
  identities: [],
  viewMode: 'chat',
  searchKeyword: '',
  pollTimer: null,
  isLoading: false,

  // 输入状态
  pendingLinks: [],
  pendingAttachments: [],
  openDropdown: null,
  _mentionTarget: null,

  // 按群聊隔离的输入缓存: chatId → { editorHtml, pendingLinks, pendingAttachments }
  _chatInputCache: {},

  // 按群聊隔离的 session 选择状态: chatId → { identityRef → { mode, sessionId, sessionTitle } }
  _chatSessionSelection: {},

  // 当前打开的 session dropdown 对应的 identityRef
  _openSessionDropdown: null,

  // GROUP.md
  groupMdContent: '',
  groupMdLoading: false,
  groupMdChatId: null,

  // 管理员模型预设状态
  adminModelState: { loading: false, loaded: false, presets: [], current: '', error: null },

  // 批注: messageId → { text, timestamp }
  _annotations: {},

  // 管理员会话状态
  _adminStatus: null,
  _adminRestarting: false,

  // UI 折叠状态
  _archivedCollapsed: true,
  _settingsAdminCollapsed: true,
  _sidebarCollapsed: false,

  // Popover / hover
  _hoverIdentity: null,
  _hoverTimer: null,
  _popoverEl: null,
  _popoverHideTimer: null,
  _dropdownHideTimer: null,

  // 引入会话搜索弹窗
  _importModalEl: null,
  _importSearchTimer: null,

  // 添加成员弹窗
  _addMemberModalEl: null,
  _addMemberSearchTimer: null,

  // 拒绝派发特殊输入状态
  _rejectDispatchId: null,
  _rejectPrefillText: '',

  // 语音输入状态
  _voiceRecording: false,
  _voiceTranscribing: false,
  _voiceMediaRecorder: null,
  _voiceAudioChunks: [],
  _voiceTargetBtn: null,
  _voiceCancelled: false,
  _voicePendingSend: false,
  _voiceChatId: null,

  // session 数据缓存: identityRef → { pool, external, activeSessionId, sessionModel }
  _sessionDataCache: {},

  // 运行时状态缓存: sessionId → { status, viewerAgentId, identityRef, displayName, workspaceId }
  _runtimeStatusCache: {},

  // 滚动位置保持
  _savedMsgScrollTop: 0,
  _shouldScrollToBottom: false,
  _userScrolling: false,
  _userScrollingTimer: null,
  _suppressScrollEvent: false,

  // 长消息折叠：已展开的消息 ID 集合
  _expandedMsgIds: new Set(),

  // 右键上下文菜单 DOM
  _contextMenuEl: null,

  // GROUP.md 自动保存计时器
  _mdAutoSaveTimer: null,
  _mdAutoSaveChatId: null,
};
