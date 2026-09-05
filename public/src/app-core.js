// Feature 模板映射（从 API 动态加载）
let FEATURE_TEMPLATE_MAP = {};

// 加载 Feature 模板映射
// 模板映射按 runtime agent 区分（多 projectRoot 场景下同名模板指向不同文件），
// 服务端要求显式 agentId；尚无焦点 runtime 时跳过，待焦点确立后由
// agent-data-loader.js / 轮询重试触发。
async function loadFeatureTemplateMap() {
  if (!currentRuntimeAgentId) {
    return false;
  }
  try {
    const response = await fetch('/api/templates/feature?agentId=' + encodeURIComponent(currentRuntimeAgentId));
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
// Host 载荷缓存：远程会话不在 allAgents，agent_detail 载荷在此按 agentId 留档，
// 供后续工单的富元数据消费方读取。
const _agentDetailPayloadCache = new Map();
function getAgentDetailPayload(agentId) {
  const key = String(agentId || '').trim();
  return _agentDetailPayloadCache.get(key) || null;
}
function extractSessionMetaFromDetail(detail) {
  const sessions = detail?.workspace_sessions;
  const activeSessionId = String(sessions?.activeSessionId || '').trim();
  const list = Array.isArray(sessions?.sessions) ? sessions.sessions : [];
  const activeSession = list.find((item) => String(item?.id || '').trim() === activeSessionId);
  if (!activeSession) return null;
  return {
    sessionId: activeSessionId,
    sessionType: String(activeSession.sessionType || 'main').trim() || 'main',
    createdAt: String(activeSession.createdAt || '').trim(),
    updatedAt: String(activeSession.updatedAt || '').trim(),
    openDirectory: String(
      activeSession.openDirectory || detail?.workspace_state?.openDirectory || '',
    ).trim(),
    messageCount: Number.isFinite(activeSession.messageCount) ? activeSession.messageCount : 0,
  };
}
async function loadAgentDetail(agentId) {
  if (!agentId || loadedAgentDetailIds.has(agentId)) return;
  loadedAgentDetailIds.add(agentId);
  const sidebarSnapshotToken = typeof captureSidebarSnapshotToken === 'function'
    ? captureSidebarSnapshotToken()
    : null;
  const sessionViewToken = typeof captureSessionViewToken === 'function'
    ? captureSessionViewToken()
    : null;
  let loaded = false;
  try {
    const res = await fetch('/protoclaw/agent_detail?agentId=' + encodeURIComponent(agentId));
    if (!res.ok) return;
    const detail = await res.json();
    // 载荷无论本地远程都留档；失败路径（!res.ok / 抛错）不触碰缓存。
    _agentDetailPayloadCache.set(String(agentId).trim(), detail);
    const agent = allAgents.find((a) => a.id === agentId);
    if (agent) {
      const { workspace_sessions: freshSessions, ...otherDetail } = detail || {};
      Object.assign(agent, otherDetail);
      if (freshSessions) {
        agent.workspace_sessions = typeof mergeWorkspaceSessionSnapshots === 'function'
          ? mergeWorkspaceSessionSnapshots(agent.workspace_sessions || {}, freshSessions, agentId)
          : freshSessions;
      }
      if (sidebarSnapshotToken
        && typeof isSidebarSnapshotTokenCurrent === 'function'
        && !isSidebarSnapshotTokenCurrent(sidebarSnapshotToken)) {
        console.info('[SIDEBAR_OPERATION]', { operation: 'agent_detail', phase: 'stale_snapshot_merged', agentId });
      }
    }
    // 选中会话的富元数据收敛到 session-view-state：仅当载荷属于当前焦点 agent
    // 且正处于会话浏览态时提交；无活跃会话记录时保留现有 slot 值。
    const isFocusedAgent = String(agentId || '').trim() === String(focusedAgentId || '').trim();
    const sessionMeta = isFocusedAgent && currentRuntimeAgentId
      ? extractSessionMetaFromDetail(detail)
      : null;
    if (sessionMeta
      && sessionViewToken
      && typeof commitSessionViewPatch === 'function') {
      commitSessionViewPatch(sessionViewToken, { sessionMeta });
    }
    loaded = true;
  } catch (e) {
    console.warn('[Viewer] Failed to load agent detail:', agentId, e);
  } finally {
    if (!loaded) loadedAgentDetailIds.delete(agentId);
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
// Browser deployments always use the product server's same-origin Viewer proxy.
// This remains correct when a gateway exposes the app on another port or under
// a path prefix such as /agentdev/. Non-HTTP desktop shells keep the direct
// ViewerWorker fallback.
const USE_SAME_ORIGIN_VIEWER_PROXY = window.location.protocol === 'http:' || window.location.protocol === 'https:';

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

// ── Web-based file/directory picker (fallback for non-Windows) ──

window._showWebPicker = function (mode) {
  return new Promise((resolve) => {
    const isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
    const titleMap = {
      directory: isZh ? '选择目录' : 'Select Directory',
      empty_directory: isZh ? '选择空目录' : 'Select Empty Directory',
      files: isZh ? '选择文件' : 'Select Files',
    };
    const title = titleMap[mode] || titleMap.directory;
    const isFileMode = mode === 'files';

    const overlay = document.createElement('div');
    overlay.className = 'fs-dir-picker-overlay';
    overlay.innerHTML = `
      <div class="fs-dir-picker">
        <div class="fs-dir-picker-header">
          <span>${title}</span>
          <button class="fs-dir-picker-close">&times;</button>
        </div>
        <div class="fs-dir-picker-toolbar">
          <button class="fs-dir-picker-up" title="${isZh ? '上一级' : 'Parent'}">&#8593;</button>
          <input type="text" class="fs-dir-picker-path" value="" />
        </div>
        <div class="fs-dir-picker-drives"></div>
        <div class="fs-dir-picker-body"><div class="fs-dir-picker-spinner"></div></div>
        <div class="fs-dir-picker-footer">
          <span class="fs-dir-picker-hint" style="flex:1;font-size:12px;color:var(--text-muted);${isFileMode ? '' : 'display:none'}"></span>
          <button class="fs-dir-picker-cancel">${isZh ? '取消' : 'Cancel'}</button>
          <button class="fs-dir-picker-select">${isZh ? '选择此目录' : 'Select'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    let currentPath = '';
    const selectedFiles = new Set();

    function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

    async function loadDir(targetPath) {
      const body = overlay.querySelector('.fs-dir-picker-body');
      const pathInput = overlay.querySelector('.fs-dir-picker-path');
      const upBtn = overlay.querySelector('.fs-dir-picker-up');
      const drivesEl = overlay.querySelector('.fs-dir-picker-drives');
      body.innerHTML = '<div class="fs-dir-picker-spinner"></div>';

      try {
        const url = `/protoclaw/browse_dirs?path=${encodeURIComponent(targetPath)}${isFileMode ? '&includeFiles=true' : ''}`;
        const res = await fetch(url);
        if (!res.ok) {
          body.innerHTML = `<div class="fs-dir-picker-error">${isZh ? '无法读取此目录' : 'Cannot read this directory'}</div>`;
          return;
        }
        const data = await res.json();
        currentPath = data.currentPath;
        pathInput.value = currentPath;
        upBtn.disabled = !data.parent;
        upBtn.onclick = () => { if (data.parent) loadDir(data.parent); };

        if (data.drives && data.drives.length > 1) {
          drivesEl.innerHTML = data.drives.map(d =>
            `<button class="fs-dir-picker-drive ${d.path === currentPath ? 'active' : ''}" data-path="${escHtml(d.path)}">${escHtml(d.label)}</button>`
          ).join('');
          drivesEl.querySelectorAll('.fs-dir-picker-drive').forEach(b => {
            b.onclick = () => loadDir(b.getAttribute('data-path'));
          });
          drivesEl.style.display = '';
        } else {
          drivesEl.style.display = 'none';
        }

        if (data.entries.length === 0) {
          body.innerHTML = `<div class="fs-dir-picker-empty">${isZh ? '(空目录)' : '(empty)'}</div>`;
        } else {
          body.innerHTML = data.entries.map(e => {
            const icon = e.isDirectory ? '&#128193;' : '&#128196;';
            const cls = e.isDirectory ? 'fs-dir-entry' : 'fs-dir-entry fs-dir-entry-file';
            const sel = selectedFiles.has(e.path) ? ' selected' : '';
            return `<div class="${cls}${sel}" data-path="${escHtml(e.path)}" data-is-dir="${e.isDirectory}">${icon} ${escHtml(e.name)}</div>`;
          }).join('');
          body.querySelectorAll('.fs-dir-entry').forEach(el => {
            const isDir = el.getAttribute('data-is-dir') === 'true';
            if (isDir) {
              el.ondblclick = () => loadDir(el.getAttribute('data-path'));
            }
            el.onclick = () => {
              if (!isDir && isFileMode) {
                if (el.classList.contains('selected')) {
                  el.classList.remove('selected');
                  selectedFiles.delete(el.getAttribute('data-path'));
                } else {
                  el.classList.add('selected');
                  selectedFiles.add(el.getAttribute('data-path'));
                }
                updateHint();
              }
            };
          });
        }
      } catch {
        body.innerHTML = `<div class="fs-dir-picker-error">${isZh ? '加载失败' : 'Failed to load'}</div>`;
      }
    }

    function updateHint() {
      const hint = overlay.querySelector('.fs-dir-picker-hint');
      if (hint) {
        hint.textContent = isZh ? `已选择 ${selectedFiles.size} 个文件` : `${selectedFiles.size} file(s) selected`;
      }
    }

    overlay.querySelector('.fs-dir-picker-path').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); loadDir(e.target.value); }
    });

    overlay.querySelector('.fs-dir-picker-select').onclick = () => {
      if (isFileMode) {
        resolve({ paths: Array.from(selectedFiles), cancelled: selectedFiles.size === 0 });
      } else {
        if (currentPath) resolve({ path: currentPath, cancelled: false });
      }
      overlay.remove();
    };

    const close = () => {
      if (isFileMode) resolve({ paths: [], cancelled: true });
      else resolve({ path: '', cancelled: true });
      overlay.remove();
    };
    overlay.querySelector('.fs-dir-picker-cancel').onclick = close;
    overlay.querySelector('.fs-dir-picker-close').onclick = close;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    loadDir('');
  });
};

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
      const data = await res.json();
      if (data.useWebPicker) return await window._showWebPicker(data.mode || 'empty_directory');
      return data;
    }
    if (command === 'select_files') {
      const res = await fetch('/protoclaw/select_files', {
        method: 'POST',
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = await res.json();
      if (data.useWebPicker) return await window._showWebPicker(data.mode || 'files');
      return data;
    }
    if (command === 'select_directory') {
      const res = await fetch('/protoclaw/select_directory', {
        method: 'POST',
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = await res.json();
      if (data.useWebPicker) return await window._showWebPicker(data.mode || 'directory');
      return data;
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
const workGroupAgentList = document.getElementById('work-group-agent-list');
const prebuiltGroup = document.getElementById('prebuilt-group');
const toolGroup = document.getElementById('tool-group');
const externalGroup = document.getElementById('external-group');
const workGroupGroup = document.getElementById('work-group-group');
const prebuiltCount = document.getElementById('prebuilt-count');
const toolCount = document.getElementById('tool-count');
const externalCount = document.getElementById('external-count');
const workGroupCount = document.getElementById('work-group-count');
const currentAgentTitle = document.getElementById('current-agent-name');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarResizer = document.getElementById('sidebar-resizer');
const sidebarCollapseHint = document.getElementById('sidebar-collapse-hint');
const featurePanel = document.getElementById('feature-panel');
const featurePanelTitle = document.getElementById('feature-panel-title');
const featurePanelBody = document.getElementById('feature-panel-body');
const featurePanelResizer = document.getElementById('feature-panel-resizer');
const featurePanelCollapseHint = document.getElementById('feature-panel-collapse-hint');
const agentContextMenu = document.getElementById('agent-context-menu');
const restartAgentAction = document.getElementById('restart-agent-action');
const stopAgentAction = document.getElementById('stop-agent-action');
const deleteAgentAction = document.getElementById('delete-agent-action');
const sessionContextMenu = document.getElementById('session-context-menu');
const openSessionAction = document.getElementById('open-session-action');
const compactedResumeSessionAction = document.getElementById('compacted-resume-session-action');
const archiveSessionAction = document.getElementById('archive-session-action');
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

let focusedAgentId = null;
let currentRuntimeAgentId = null;
let readOnlyMode = false;
let loadAgentsInFlight = null;
const workspaceSurfaceModePreferences = {};
let allAgents = [];
// 追踪每个 agent 的 call 运行状态（实时更新，比 3s 轮询更快）
const _agentCallActive = new Map();
// 中断中的 runtime：用户点击打断后，abort 生效与 call.finish 之间天然存在异步间隔。
// 这里记录的是一个粘性生命周期状态，而不是定时“抑制窗口”。只有同一 call 的终态
// （callActive:false / call.finish）、明确的请求失败，或一个更新的 callStartedAt 才能清除它。
const _interruptSuppression = new Map();

// ── Polling intervals ──────────────────────────────────────────
const POLL_INTERVAL_MS   = 1000; // 正常态轮询间隔
const POLL_FAST_INTERVAL_MS = 300; // 忙碌态/会话切换加速轮询间隔
function getNotificationCallStartedAt(payload) {
  const value = payload?.runtime?.callStartedAt ?? payload?.callStartedAt;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function markInterruptPending(runtimeId, callStartedAt = 0) {
  if (!runtimeId) return;
  const normalizedCallStartedAt = Number(callStartedAt);
  _interruptSuppression.set(runtimeId, {
    requestedAt: Date.now(),
    callStartedAt: Number.isFinite(normalizedCallStartedAt) && normalizedCallStartedAt > 0
      ? normalizedCallStartedAt
      : 0,
  });
}

function isInterruptSuppressed(runtimeId, observedCallStartedAt = 0) {
  if (!runtimeId) return false;
  const pending = _interruptSuppression.get(runtimeId);
  if (!pending) return false;

  // A newer call identity is the only `callActive:true` observation allowed to
  // leave interrupting state. If either side lacks an identity, stay sticky and
  // wait for the authoritative terminal event instead of guessing by timeout.
  const interruptedCallStartedAt = Number(pending?.callStartedAt);
  const observed = Number(observedCallStartedAt);
  if (Number.isFinite(interruptedCallStartedAt) && interruptedCallStartedAt > 0
    && Number.isFinite(observed) && observed > interruptedCallStartedAt) {
    _interruptSuppression.delete(runtimeId);
    return false;
  }
  return true;
}
function clearInterruptSuppression(runtimeId) {
  if (runtimeId) _interruptSuppression.delete(runtimeId);
}
// 追踪刚完成调用的 runtimeId，用于在侧边栏显示"已完成"指示灯
const _recentlyFinishedRuntimes = new Set();
// 全局 choice 请求提醒：跟踪已弹 toast 的 requestId，避免重复提醒
const _seenChoiceAlertIds = new Set();
let _lastChoiceAlertCheckAt = 0;
let currentMessages = [];
let currentInputRequests = [];
let choiceInputState = {};
let toolRenderConfigs = {};
let TOOL_NAMES = {};
const _autoTitleTriggered = new Set();
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
let _workGroupEventsWired = false;
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
/**
 * preset 名 → 用户可见显示名。
 * `__default__` 是 resolver 层的合成名（全局默认模型不在 presets.json 里），
 * 协议合成名不进 UI；模型切换按钮、toast、用量列表等显示点统一过此函数。
 */
function formatPresetDisplayName(name) {
  if (name === '__default__') return currentLanguage === 'zh' ? '全局默认' : 'Default';
  return name;
}
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
let currentTodoPlan = {
  feature: 'todo',
  updatedAt: 0,
  counter: 0,
  tasks: [],
  summary: { total: 0, pending: 0, inProgress: 0, completed: 0, cancelled: 0, blocked: 0 },
};
let currentTodoPlanSignature = '';
let _interruptTargetCache = new Map(); // key: runtimeContextKey, value: taskId|null
let _lastInterruptUserActionAt = 0; // timestamp of last user click on interrupt control
function getInterruptTargetId() {
  const key = getRuntimeContextKey();
  if (!key) return null;
  return _interruptTargetCache.get(key) || null;
}
function setInterruptTargetId(taskId) {
  const key = getRuntimeContextKey();
  if (!key) return;
  if (taskId) {
    _interruptTargetCache.set(key, taskId);
  } else {
    _interruptTargetCache.delete(key);
  }
}
let _todoForceContinueCache = new Map(); // key: runtimeContextKey, value: boolean
let _lastTodoForceContinueUserActionAt = 0; // timestamp of last user click on force-continue toggle
function getTodoForceContinue() {
  const key = getRuntimeContextKey();
  if (!key) return false;
  return _todoForceContinueCache.get(key) === true;
}
function setTodoForceContinue(enabled) {
  const key = getRuntimeContextKey();
  if (!key) return;
  if (enabled) {
    _todoForceContinueCache.set(key, true);
  } else {
    _todoForceContinueCache.delete(key);
  }
}
let currentLogs = [];
let currentLogsSignature = '';
let currentLogsTruncation = null;
let currentMcpInfo = null;
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
  call: 'all',
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
let pendingSwitchTarget = null;   // { runtimeId, serial, source, navEpoch }
let pendingSwitchSerial = 0;      // monotonically increasing
// 工单 037：lastRenderedInputSignature / lastRenderedInputMode 已内化到
// input-render.js（渲染器私有去重状态），手动 reset 协议退役。
let unitModePreferences = {};
let lastRenderedWorkspaceHtml = '';
let lastRenderedWorkspaceScrollKey = '';
const workspaceSurfaceScrollCache = new Map();
let workspaceSurfaceScrollSaveRaf = 0;
let _lastRenderedChatSig = '';
let _restoredScrollTop = null;    // set by restoreRuntimeFromCache, consumed by switchAgent
let _chatLoadingSession = false;  // true while waiting for a just-opened session's messages to arrive
let _chatLoadingTimeout = null;   // safety timeout to clear _chatLoadingSession
let _switchEpoch = 0;             // monotonically increasing; used to guard stale async work from rapid switches

// A committed session can be the user's navigation target before its runtime
// exists. Keep that intent separate from currentRuntimeAgentId so the tabless
// workspace can show the chat loading surface without inventing a sidebar leaf.
let _pendingSessionNavigation = null;

function beginPendingSessionNavigation(agentId, sessionId = '', phase = 'committing') {
  const normalizedAgentId = String(agentId || '').trim();
  if (!normalizedAgentId) return null;
  _pendingSessionNavigation = {
    agentId: normalizedAgentId,
    sessionId: String(sessionId || '').trim(),
    phase: String(phase || 'committing'),
    navigationEpoch: _navigationGuardEpoch,
  };
  return _pendingSessionNavigation;
}

function updatePendingSessionNavigation(sessionId, phase = 'starting-runtime') {
  if (!_pendingSessionNavigation) return null;
  _pendingSessionNavigation = {
    ..._pendingSessionNavigation,
    sessionId: String(sessionId || _pendingSessionNavigation.sessionId || '').trim(),
    phase: String(phase || _pendingSessionNavigation.phase || 'committing'),
  };
  return _pendingSessionNavigation;
}

function clearPendingSessionNavigation() {
  _pendingSessionNavigation = null;
}

function hasPendingSessionNavigation(agent = null) {
  if (!_pendingSessionNavigation || _pendingSessionNavigation.navigationEpoch !== _navigationGuardEpoch) {
    return false;
  }
  if (!agent) return true;
  return String(agent.id || '').trim() === _pendingSessionNavigation.agentId;
}

// ── Navigation Guard ──────────────────────────────────────────────────────
// Every user-initiated navigation (workspace switch, session switch, opening
// a new session, etc.) bumps this epoch.  Async operations that will
// eventually auto-navigate (e.g. runSessionOpen → requestSwitch) capture the
// epoch at start and check it before executing the deferred navigation.
// If the user navigated away in the meantime, the stale operation aborts
// silently instead of yanking the user back.
let _navigationGuardEpoch = 0;

function bumpNavigationGuard() {
  _navigationGuardEpoch++;
  if (_pendingSessionNavigation) {
    _pendingSessionNavigation = null;
  }
}
let phSessionSortMode = 'updatedAt'; // 'updatedAt' | 'createdAt' — programming-helper session list sort preference
let phSearchQuery = '';              // current search query for session list
let phSearchResults = null;          // search results array or null (not searching)
let phSearchLoading = false;         // search in progress
let phSearchTab = 'main';            // which tab filter to apply during search: 'main' | 'archived'
let _phSearchTimer = null;           // debounce timer for search input

// ── User expand/collapse preferences (survive full re-render) ──────────────
// Keyed by message index within the active runtime context. These override
// syncCollapseStates auto-rules.
let _userExpandedReasoning = new Set();  // reasoning blocks the user expanded
let _userCollapsedMsgs = new Set();       // messages the user explicitly collapsed
let _userExpandedMsgs = new Set();        // messages the user explicitly expanded (un-collapsed)

// ── Per-session runtime data cache (P0: optimistic render on switch) ────────
// Caches messages, toolRenderConfigs, TOOL_NAMES, hookInspector + signature,
// overviewSnapshot + signature, and connection status per runtime context.
const _agentRuntimeCache = new Map();
const _userCollapseStateByContext = new Map();

function getUserCollapseStateContextKey(runtimeId = currentRuntimeAgentId) {
  const runtimeKey = typeof getRuntimeContextKey === 'function' ? getRuntimeContextKey(runtimeId) : null;
  if (runtimeKey) return runtimeKey;
  const agentKey = String(focusedAgentId || '').trim();
  return agentKey ? `agent:${agentKey}` : 'global';
}

function getUserCollapseStateForContext(contextKey = getUserCollapseStateContextKey()) {
  const key = contextKey || 'global';
  let state = _userCollapseStateByContext.get(key);
  if (!state) {
    state = {
      expandedReasoning: new Set(),
      collapsedMsgs: new Set(),
      expandedMsgs: new Set(),
    };
    _userCollapseStateByContext.set(key, state);
  }
  return state;
}

function activateUserCollapseStateForContext(contextKey = getUserCollapseStateContextKey()) {
  const state = getUserCollapseStateForContext(contextKey);
  _userExpandedReasoning = state.expandedReasoning;
  _userCollapsedMsgs = state.collapsedMsgs;
  _userExpandedMsgs = state.expandedMsgs;
}

function resetUserCollapseStateForContext(contextKey = getUserCollapseStateContextKey()) {
  const key = contextKey || 'global';
  _userCollapseStateByContext.delete(key);
  activateUserCollapseStateForContext(key);
}

// Local resource identity contract.
// agentId is the stable logical Agent / workspace owner; sessionId is a
// persisted conversation identity; runtimeId is one ViewerWorker instance;
// parentId is only the child-runtime -> host relationship; focusedAgentId is
// page display state and is not read here. A stopped runtime resolves to null;
// no identity is guessed from focus, name, PID, list position, or parentId.
function normalizeResourceIdentity(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function hasIdentityAlias(record, aliases) {
  return !!(record && typeof record === 'object' && !Array.isArray(record)
    && aliases.some((key) => record[key] !== undefined && record[key] !== null));
}

function resolveIdentityAliases(record, aliases) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const values = aliases
    .map((key) => normalizeResourceIdentity(record[key]))
    .filter(Boolean);
  if (new Set(values).size > 1) return null;
  return values[0] || null;
}

function getParentAgentId(record) {
  return resolveIdentityAliases(record, ['parentId', 'parent_id']);
}

function getLogicalAgentId(record) {
  if (typeof record === 'string' || typeof record === 'number') {
    return normalizeResourceIdentity(record) || null;
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const explicitAgentId = resolveIdentityAliases(record, ['agentId', 'logicalAgentId']);
  if (hasIdentityAlias(record, ['agentId', 'logicalAgentId'])) {
    return explicitAgentId;
  }
  const parentId = getParentAgentId(record);
  if (parentId) return parentId;
  // A host record owns its own logical identity. A child without parentId is
  // intentionally unresolved rather than guessed from its display fields.
  if (record.source === 'prebuilt' || record.source === 'host' || record.source === 'workspace') {
    return normalizeResourceIdentity(record.id) || null;
  }
  if (!record.source && !hasIdentityAlias(record, ['runtimeId', 'runtime_session_id', 'runtimeSessionId'])) {
    return normalizeResourceIdentity(record.id) || null;
  }
  return null;
}

function getRuntimeId(record) {
  if (typeof record === 'string' || typeof record === 'number') {
    return normalizeResourceIdentity(record) || null;
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const explicitRuntimeId = resolveIdentityAliases(record, ['runtimeId', 'runtime_session_id', 'runtimeSessionId']);
  if (hasIdentityAlias(record, ['runtimeId', 'runtime_session_id', 'runtimeSessionId'])) {
    return explicitRuntimeId;
  }
  // Child/external records use their own record id as the runtime identity.
  // A host record with no live runtime has no runtimeId; parentId is never a
  // substitute for a missing runtime.
  if (record.source === 'child' || record.source === 'external' || getParentAgentId(record)) {
    return normalizeResourceIdentity(record.id) || null;
  }
  return null;
}

/**
 * 控制类请求（tool_state / swap 系）的宿主身份收敛点。本地会话取 allAgents
 * 记录的逻辑 id；远程会话不在 allAgents（ADR-0010 统一投影），宿主身份取自
 * 远程目录条目，避免请求体缺 agentId 被服务端 400 拒绝。
 */
function getCurrentControlAgentId() {
  const record = typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null;
  const logical = getLogicalAgentId(record);
  if (logical) return logical;
  if (typeof window !== 'undefined' && window.RemoteConnections?.getEntryHostAgentId) {
    const runtimeRef = typeof currentRuntimeAgentId !== 'undefined' ? currentRuntimeAgentId : '';
    if (runtimeRef) return window.RemoteConnections.getEntryHostAgentId(runtimeRef);
  }
  return null;
}

function getActiveSessionId(record = typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null) {
  // workspace_sessions.activeSessionId is the current canonical nested field;
  // the top-level fields are legacy/API aliases and are only consulted when
  // the canonical field is absent. This makes stale legacy data deterministic.
  const hasNestedSession = hasIdentityAlias(record?.workspace_sessions, ['sessionId', 'activeSessionId']);
  const nestedSessionId = resolveIdentityAliases(record?.workspace_sessions, ['sessionId', 'activeSessionId']);
  if (hasNestedSession) return nestedSessionId;
  if (hasIdentityAlias(record, ['sessionId', 'active_workspace_session_id'])) {
    return resolveIdentityAliases(record, ['sessionId', 'active_workspace_session_id']);
  }
  return null;
}

function getAgentRuntimeId(agent) {
  return getRuntimeId(agent) || '';
}

function buildLocalResourceRef(input) {
  const record = input && typeof input === 'object' ? input : {};
  return {
    scope: 'local',
    agentId: getLogicalAgentId(record),
    parentId: getParentAgentId(record),
    sessionId: getActiveSessionId(record),
    runtimeId: getRuntimeId(record),
  };
}

function getActiveWorkspaceSessionId(agent = typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null) {
  return getActiveSessionId(agent) || '';
}

// ── Viewer-local session binding ────────────────────────────────────────────
// 会话身份的 viewer 侧真相：用户主动切换时冻结的 runtimeId → sessionId 绑定。
// Server 端 host 级 activeSessionId 会被外部入口（IM 转接 / CLI / 调度 /
// 其他标签页的 create+activate）改写；若 getRuntimeContextKey 被动跟随
// allAgents 里的该值派生，正在查看的会话的草稿 key / 录音归属 / 输入签名
// 会在用户毫无操作时整体漂移（输入面重建、录音被取消、草稿写错槽）。
// 绑定只在用户主动切换（switchAgent / 会话打开与创建）时写入。
var _viewerSessionBindings = new Map();

function setViewerSessionBinding(runtimeId, sessionId) {
  const normalizedRuntimeId = String(runtimeId || '').trim();
  if (!normalizedRuntimeId) return;
  const normalizedSessionId = String(sessionId || '').trim();
  if (normalizedSessionId) {
    _viewerSessionBindings.set(normalizedRuntimeId, normalizedSessionId);
  } else {
    _viewerSessionBindings.delete(normalizedRuntimeId);
  }
}

function getViewerSessionBinding(runtimeId) {
  const normalizedRuntimeId = String(runtimeId || '').trim();
  if (!normalizedRuntimeId) return '';
  return String(_viewerSessionBindings.get(normalizedRuntimeId) || '').trim();
}

// 从 allAgents 派生 runtime 当前关联的会话（server 侧视角，可被外部入口改写）。
function _deriveRuntimeSessionIdFromAgents(runtimeId) {
  const normalizedRuntimeId = String(runtimeId || '').trim();
  if (!normalizedRuntimeId || !Array.isArray(allAgents)) return '';
  const runtimeRecord = allAgents.find((item) => {
    const itemId = String(item?.id || '').trim();
    const itemRuntimeId = String(item?.runtime_session_id || item?.runtimeSessionId || '').trim();
    return itemId === normalizedRuntimeId || itemRuntimeId === normalizedRuntimeId;
  });
  return String(runtimeRecord?.active_workspace_session_id || '').trim();
}

function getRuntimeWorkspaceSessionId(runtimeId) {
  // Viewer 绑定优先：它代表用户正在查看的会话。仅在尚未建立绑定
  // （初始恢复、未经 switchAgent 的路径）时回退到 server 派生值。
  const viewerSessionId = getViewerSessionBinding(runtimeId);
  if (viewerSessionId) return viewerSessionId;
  return _deriveRuntimeSessionIdFromAgents(runtimeId);
}

function getRuntimeContextKey(runtimeId = currentRuntimeAgentId, agent = typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null) {
  const normalizedRuntimeId = String(runtimeId || '').trim();
  if (!normalizedRuntimeId) return null;
  const hostId = String(agent?.parent_id || agent?.id || focusedAgentId || '').trim();
  const sessionId = getRuntimeWorkspaceSessionId(normalizedRuntimeId) || getActiveWorkspaceSessionId(agent);
  if (hostId && sessionId) {
    return `host:${hostId}|session:${sessionId}`;
  }
  return `runtime:${normalizedRuntimeId}`;
}

function getRuntimeCacheTodoPlanFallback() {
  return {
    feature: 'todo',
    updatedAt: 0,
    counter: 0,
    tasks: [],
    summary: { total: 0, pending: 0, inProgress: 0, completed: 0, cancelled: 0, blocked: 0 },
  };
}

function getRuntimeCacheTodoPlanSignature(plan) {
  if (typeof getTodoPlanSignature === 'function') {
    return getTodoPlanSignature(plan);
  }
  return JSON.stringify(plan || getRuntimeCacheTodoPlanFallback());
}

function saveCurrentRuntimeToCache(agentId, contextKey = getRuntimeContextKey(agentId)) {
  if (!agentId || !contextKey) return;
  const viewState = readCurrentSessionViewState();
  const cachedTodoPlan = viewState.todoPlan
    ? viewState.todoPlan
    : getRuntimeCacheTodoPlanFallback();
  _agentRuntimeCache.set(contextKey, {
    runtimeId: agentId,
    messages: viewState.messages,
    inputRequests: viewState.inputRequests,
    toolRenderConfigs: viewState.toolRenderConfigs,
    TOOL_NAMES: viewState.toolNames,
    hookInspector: viewState.hookInspector,
    hookInspectorSignature: currentHookInspectorSignature,
    overviewSnapshot: viewState.overview,
    overviewSignature: currentOverviewSignature,
    todoPlan: cachedTodoPlan,
    todoPlanSignature: typeof currentTodoPlanSignature !== 'undefined'
      ? currentTodoPlanSignature
      : getRuntimeCacheTodoPlanSignature(cachedTodoPlan),
    sessionMeta: viewState.sessionMeta,
    connected: viewState.connected,
    followLatest: followLatestEnabled,
    scrollTop: container ? container.scrollTop : 0,
  });
}

function restoreRuntimeFromCache(agentId, contextKey = getRuntimeContextKey(agentId)) {
  if (!agentId || !contextKey) return false;
  const cached = _agentRuntimeCache.get(contextKey);
  if (!cached) return false;
  // Guard against cache key collision: when a new session is created for the same
  // host agent, the old runtime's saveCurrentRuntimeToCache may write under the
  // new session's context key (because allAgents was already updated). Verify
  // that the cached entry actually belongs to the requesting runtime.
  if (cached.runtimeId && String(cached.runtimeId).trim() !== String(agentId).trim()) {
    _agentRuntimeCache.delete(contextKey);
    return false;
  }
  activateUserCollapseStateForContext(contextKey);
  // followLatestEnabled 先于 patch 写入：applySessionViewPatch 写入
  // inputRequests 即声明输入面渲染（工单 037），视口通知须读取恢复后的值。
  followLatestEnabled = cached.followLatest !== undefined ? cached.followLatest : true;
  applySessionViewPatch({
    messages: cached.messages,
    inputRequests: cached.inputRequests,
    toolRenderConfigs: cached.toolRenderConfigs,
    toolNames: cached.TOOL_NAMES,
    hookInspector: cached.hookInspector,
    overview: cached.overviewSnapshot,
    todoPlan: cached.todoPlan || (
      typeof getEmptyTodoPlan === 'function'
        ? getEmptyTodoPlan()
        : getRuntimeCacheTodoPlanFallback()
    ),
    sessionMeta: cached.sessionMeta,
    connected: cached.connected,
  });
  _restoredScrollTop = typeof cached.scrollTop === 'number' ? cached.scrollTop : null;
  if (typeof updatePlanBadge === 'function') updatePlanBadge();
  return true;
}

function clearAgentRuntimeCache(agentId) {
  if (agentId) {
    for (const [key, cached] of _agentRuntimeCache.entries()) {
      if (cached?.runtimeId === agentId || key === `runtime:${agentId}`) {
        _agentRuntimeCache.delete(key);
      }
    }
  } else {
    _agentRuntimeCache.clear();
  }
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
  if (_chatLoadingSession) {
    return '<div class="empty-state chat-loading"><span class="chat-loading-spinner"></span><span>'
      + escapeHtml(currentLanguage === 'zh' ? '正在加载对话…' : 'Loading conversation…')
      + '</span></div>';
  }
  let _isZh = currentLanguage === 'zh';
  let _displayName = '';
  try {
    let _agent = getCurrentAgentRecord();
    _displayName = String(_agent && _agent.name || '').trim();
  } catch (_) { /* agent not loaded yet */ }
  let _title = _displayName
    ? (_isZh ? '欢迎使用' : 'Welcome to')
    : (_isZh ? '新对话' : 'New Conversation');
  let _hint = _isZh ? '输入消息开始对话' : 'Type a message to begin';
  if (_displayName) {
    return '<div class="empty-state empty-welcome">'
      + '<div class="empty-welcome-glow"></div>'
      + '<div class="empty-welcome-title">' + escapeHtml((_isZh ? '欢迎使用 ' : 'Welcome to ') + _displayName) + '</div>'
      + '<div class="empty-welcome-deco"></div>'
      + '<div class="empty-welcome-hint">' + escapeHtml(_hint) + '</div>'
      + '</div>';
  }
  return '<div class="empty-state empty-welcome">'
    + '<div class="empty-welcome-glow"></div>'
    + '<div class="empty-welcome-title">' + escapeHtml(_title) + '</div>'
    + '<div class="empty-welcome-deco"></div>'
    + '<div class="empty-welcome-hint">' + escapeHtml(_hint) + '</div>'
    + '</div>';
}

function beginChatLoadingSession() {
  _chatLoadingSession = true;
  if (_chatLoadingTimeout) clearTimeout(_chatLoadingTimeout);
  _chatLoadingTimeout = setTimeout(() => {
    _chatLoadingSession = false;
    _chatLoadingTimeout = null;
    // Force re-render so the spinner is replaced by the welcome page.
    // Without this, the poll loop sees messages.length === currentMessages.length (0===0)
    // and skips rendering entirely, leaving the spinner stuck in the DOM forever.
    if (typeof renderCurrentMainView === 'function') {
      renderCurrentMainView();
    }
  }, 10000);
}

function clearChatLoadingSession() {
  if (!_chatLoadingSession && !_chatLoadingTimeout) return;
  _chatLoadingSession = false;
  if (_chatLoadingTimeout) {
    clearTimeout(_chatLoadingTimeout);
    _chatLoadingTimeout = null;
  }
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

/**
 * Returns a time-of-day qualifier for the given hour.
 * 凌晨(0-5) / 上午(6-11) / 中午(12-13) / 下午(14-17) / 晚上(18-23)
 */
function getTimeOfDayLabel(hour, isZh) {
  if (isZh) {
    if (hour < 6) return '凌晨';
    if (hour < 12) return '上午';
    if (hour < 14) return '中午';
    if (hour < 18) return '下午';
    return '晚上';
  }
  if (hour < 12) return 'AM';
  return 'PM';
}

/**
 * Human-readable relative time formatter.
 * Returns friendly labels like "刚刚", "5分钟前", "今天上午9点", "昨天上午9点",
 * "前天下午3点", "星期二 下午3点", "3月15日", "2024年3月15日".
 */
function formatRelativeTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  const isZh = currentLanguage === 'zh';
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  // ── Very recent: under 1 minute ──
  if (diffMin < 1) return isZh ? '刚刚' : 'just now';

  // ── Under 1 hour ──
  if (diffMin < 60) return isZh ? diffMin + '分钟前' : diffMin + 'm ago';

  // Same calendar day helpers — use time-of-day + hour (no minutes)
  let hour = date.getHours();
  let hour12 = String(hour % 12 || 12);
  let todZh = getTimeOfDayLabel(hour, true);
  let todEn = getTimeOfDayLabel(hour, false);

  let today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let date0 = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  let calendarDiff = Math.round((today0.getTime() - date0.getTime()) / 86400000);

  // ── Today ──
  if (calendarDiff === 0) {
    return isZh ? ('今天' + todZh + hour12 + '点') : ('Today ' + hour12 + todEn);
  }

  // ── Yesterday ──
  if (calendarDiff === 1) {
    return isZh ? ('昨天' + todZh + hour12 + '点') : ('Yesterday ' + hour12 + todEn);
  }

  // ── Day before yesterday ──
  if (calendarDiff === 2) {
    return isZh ? ('前天' + todZh + hour12 + '点') : ('2 days ago ' + hour12 + todEn);
  }

  // ── This week (3-6 days ago): use full weekday ──
  if (calendarDiff >= 3 && calendarDiff <= 6) {
    if (isZh) {
      let weekdayZh = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
      return weekdayZh[date.getDay()] + ' ' + todZh + hour12 + '点';
    }
    let weekdayEn = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return weekdayEn[date.getDay()] + ' ' + hour12 + todEn;
  }

  // ── This year ──
  if (date.getFullYear() === now.getFullYear()) {
    if (isZh) return (date.getMonth() + 1) + '月' + date.getDate() + '日';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ── Older ──
  if (isZh) return date.getFullYear() + '年' + (date.getMonth() + 1) + '月' + date.getDate() + '日';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Returns a coarse time-group label for session list section headers.
 * Categories: '今天' / '昨天' / '本周' / '更早'.
 */
function getTimeGroupLabel(isoString) {
  if (!isoString) return '';
  let date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  let isZh = currentLanguage === 'zh';
  let now = new Date();
  let today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let date0 = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  let calendarDiff = Math.round((today0.getTime() - date0.getTime()) / 86400000);

  if (calendarDiff <= 0) return isZh ? '今天' : 'Today';
  if (calendarDiff === 1) return isZh ? '昨天' : 'Yesterday';
  if (calendarDiff === 2) return isZh ? '前天' : 'Day Before';
  if (calendarDiff <= 6) return isZh ? '本周' : 'This Week';
  return isZh ? '更早' : 'Earlier';
}

/**
 * Returns a CSS class suffix indicating how recent a timestamp is,
 * used to apply differentiated color treatment to session time labels.
 * Returns one of: 'just-now' | 'today' | 'yesterday' | 'this-week' | 'older'.
 */
function getSessionRecencyClass(isoString) {
  if (!isoString) return 'older';
  let date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return 'older';
  let now = new Date();
  let diffMin = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (diffMin < 60) return 'just-now';

  let today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let date0 = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  let calendarDiff = Math.round((today0.getTime() - date0.getTime()) / 86400000);

  if (calendarDiff <= 0) return 'today';
  if (calendarDiff === 1) return 'yesterday';
  if (calendarDiff === 2) return 'day-before';
  if (calendarDiff <= 6) return 'this-week';
  return 'older';
}

/**
 * Ultra-short time label for the session list title-row indicator.
 * Returns compact labels like '刚刚', '5分钟', '上午9点', '昨天上午', '前天下午', '周二晚上'.
 * Returns '' for sessions older than one week (no indicator shown).
 */
function getSessionShortTime(isoString) {
  if (!isoString) return '';
  let date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  let isZh = currentLanguage === 'zh';
  let now = new Date();
  let diffMin = Math.floor((now.getTime() - date.getTime()) / 60000);

  if (diffMin < 1) return isZh ? '刚刚' : 'now';
  if (diffMin < 60) return isZh ? diffMin + '分钟' : diffMin + 'm';

  let today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let date0 = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  let calendarDiff = Math.round((today0.getTime() - date0.getTime()) / 86400000);

  let hour = date.getHours();
  let hour12 = String(hour % 12 || 12);
  let todZh = getTimeOfDayLabel(hour, true);
  let todEn = getTimeOfDayLabel(hour, false);

  if (calendarDiff <= 0) {
    // Today: 上午9点 / 下午3点
    return isZh ? (todZh + hour12 + '点') : (hour12 + todEn);
  }
  if (calendarDiff === 1) {
    // Yesterday: 昨天上午 / 昨天下午
    return isZh ? ('昨天' + todZh) : ('Yest ' + todEn);
  }
  if (calendarDiff === 2) {
    // Day before yesterday: 前天上午 / 前天下午
    return isZh ? ('前天' + todZh) : ('2d ' + todEn);
  }
  if (calendarDiff <= 6) {
    // This week: 周二下午 / 周三晚上
    if (isZh) return '周' + '日一二三四五六'[date.getDay()] + todZh;
    return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][date.getDay()] + ' ' + todEn;
  }
  return '';
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

const WORKSPACE_HOST_UNIT_IDS = new Set(['agent-creator', 'feature-creator', 'agent-studio', 'qqbot', 'programming-helper', 'flow-workspace', 'work-group']);

function isWorkspaceHostUnit(agent) {
  if (!agent || agent.source !== 'prebuilt') return false;
  // 投影条目（identities[].sidebarEntry 展开的独立入口，id 形如
  // 'programming-helper:coder'）按其宿主 agentId 归入 host 语义。
  if (agent.agentId) return WORKSPACE_HOST_UNIT_IDS.has(agent.agentId);
  return WORKSPACE_HOST_UNIT_IDS.has(agent.id);
}

function isTablessHostSurface(agent) {
  return isWorkspaceHostUnit(agent);
}

// PH 风格工作区（项目列表 / 会话列表首页）：编程小助手本体。
// 投影身份（coder）不在此列——其首页是线程视图（coder-threads-ui.js）。
const PH_STYLE_WORKSPACE_AGENT_IDS = new Set(['programming-helper']);

function isPhStyleWorkspaceAgent(agent = getCurrentAgentRecord()) {
  return !!(agent && agent.source === 'prebuilt' && PH_STYLE_WORKSPACE_AGENT_IDS.has(agent.id));
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
  if (focusedAgentId && allAgents.some((item) => item.id === focusedAgentId)) {
    return focusedAgentId;
  }
  const parentId = String(agent?.parent_id || '').trim();
  if (parentId && allAgents.some((item) => item.id === parentId)) {
    return parentId;
  }
  if (allAgents.some((item) => item.id === 'agent-creator')) return 'agent-creator';
  if (allAgents.some((item) => item.id === 'home')) return 'home';
  return allAgents[0]?.id || null;
}
