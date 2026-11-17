/**
 * debug-summary-upload.js — Summary 弹窗 + Repo 过滤 + Feature Upload
 *
 * 从 debug-panels.js 拆出。三组独立弹窗逻辑，与面板 render 无交叉。
 *
 * 包含：
 *   - Summary 弹窗: getOrCreateSummaryOverlay, renderSummaryBodyContent,
 *     updateSummaryOverlayDOM, openSummaryPopup, closeSummaryPopup, regenerateSummary
 *   - Repo 过滤: setRepoSearchQuery, setRepoSourceFilter
 *   - Feature Upload: openFeatureUploadDialog, closeFeatureUploadDialog,
 *     handleFeatureUploadFile, submitFeatureUpload
 *
 * ESM 依赖（直接 import）：escapeHtml / renderMarkdown / enhanceMathInElement
 *   （markdown-utils.js）、getCurrentLanguage（i18n-environment-state.js）、
 *   setShouldAnimateWorkspaceSurface（render-entry-state.js，live binding）、
 *   focusedAgentId（agent-store-state.js）、ClawToast（toast-notify.js）、
 *   loadAgents（agent-snapshot-loader-host.js，与启动链同一实现）、
 *   loadAgentDetail（agent-loader-host.js，与启动链同一实现）、
 *   debugPanel（p2-bootstrap-debug-panel.js，repoSearchQuery /
 *   repoSourceFilter 的 classic owner 读写面）。
 *
 * 与 agent-loader-host 的静态环（agent-loader-host → project-data → session-ui
 * → agent-snapshot-loader-host → 本模块）：loadAgentDetail 只在上传成功后的
 * 延时回调里调用，模块顶层不解引用对端绑定，换谁先求值都不产生 TDZ。
 *
 * 仍为 classic 的跨域函数按既有 window 可达性晚绑定（调用时取）：
 *   t (i18n.js) / renderCurrentMainView (app-ui.js) /
 *   isRemoteNamespaceAgentId (remote-connections.js) /
 *   AgentLoaderHost (app-core.js) / RemoteConnections (remote-connections.js)。
 *
 * 语言文案复用裁决：双语文案走已 import 的 i18n 域 API `getCurrentLanguage()`
 * （本地 `repoLocaleText` 只是语言三目，不是仓库业务 helper）。不 import
 * workspace-blocks 的同名 helper：该模块反向 import 本文件的三个入口，直连会
 * 形成 workspace-blocks ↔ debug-summary-upload 环；把该 helper 上移 i18n 域属
 * 共享文件改动，交主助手裁定（本文件不再依赖任何 window.getRepoLocaleText）。
 *
 * 可达性：四个入口都只由 boot 之后的工作空间操作/面板动作触发，classic 相
 * （加载期顶层、首屏 rail 渲染与点击）无任何触达点：
 *   - openSummaryPopup ← workspace-actions.js 的具名 import（open_summary /
 *     generate_summary 工作空间动作；动作分发只在 boot 与列表数据到位后发生）；
 *   - setRepoSearchQuery / setRepoSourceFilter / openFeatureUploadDialog ←
 *     workspace-blocks.js 的 `wsBlocks.repoFilter` / `wsBlocks.repoSearch` /
 *     `wsBlocks.openFeatureUpload` data-action 处理器，只有 Feature 仓库 block
 *     渲染出来后才可能被点击；openFeatureUploadDialog 另由 workspace-actions
 *     的 open_feature_upload 动作具名 import 调用。
 * 因此不需要 classic 同步实现，也不存在首屏 ReferenceError 窗口。
 *
 * 跨文件消费面（全部 ESM 具名 import，无 window 兼容面）：
 *   - openSummaryPopup ← workspace-actions（具名 import）；
 *   - openFeatureUploadDialog ← workspace-actions + workspace-blocks（具名 import）；
 *   - setRepoSearchQuery / setRepoSourceFilter ← workspace-blocks（具名 import）；
 *   - closeFeatureUploadDialog / regenerateSummary / submitFeatureUpload 等
 *     helper 零跨文件消费方，保持模块私有。
 * 两个入口曾各有一条 classic 消费方的桥键，随 workspace-actions 迁 ESM 一并
 * 注销：本模块不再 defineKey / claim，window 上不留同名键。
 */
import { getCurrentLanguage } from './i18n-environment-state.js';
import { escapeHtml, renderMarkdown, enhanceMathInElement } from './markdown-utils.js';
import { setShouldAnimateWorkspaceSurface } from './render-entry-state.js';
import { focusedAgentId } from './agent-store-state.js';
import { ClawToast } from './toast-notify.js';
import { loadAgents } from './agent-snapshot-loader-host.js';
import { loadAgentDetail } from './agent-loader-host.js';
import { debugPanel } from './p2-bootstrap-debug-panel.js';

// ═══════════════════════════════════════════════════════════════
// 模块级状态变量
// ═══════════════════════════════════════════════════════════════

let summaryPopupData = null;

// Guard token: prevents stale openSummaryPopup callbacks from updating the toast
// when a newer call for the same session has superseded them.
const _summaryGenGuard = new Map();

let featureUploadFile = null;

// 仓库区双语文案：语言选择器（与 workspace-blocks 的同名 helper 同形，见头注
// 「语言文案复用裁决」）。
function repoLocaleText(zh, en) {
  return getCurrentLanguage() === 'zh' ? zh : en;
}

// ── 写提交幂等键（ADR-0011，R2-02）：远程强制、本地忽略 ──────────────────
function newIdempotencyKey() {
  const cryptoObj = (typeof crypto !== 'undefined') ? crypto : null;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// R2-02（ADR-0011）：远程命名空间 sessionId → 写请求身份收敛宿主级命名空间
// id（数据层身份，服务端命名空间分支剥壳转发）；本地身份原样返回。
function _summaryRequestAgentId(agentId, sessionId) {
  const isRemote = typeof window.isRemoteNamespaceAgentId === 'function'
    && (window.isRemoteNamespaceAgentId(sessionId) || window.isRemoteNamespaceAgentId(agentId));
  if (!isRemote) return agentId;
  return window.RemoteConnections?.getHostNamespaceIdForSession?.(sessionId, agentId) || agentId;
}

// ═══════════════════════════════════════════════════════════════
// Summary 弹窗
// ═══════════════════════════════════════════════════════════════

function getOrCreateSummaryOverlay() {
  let overlay = document.getElementById('summary-popup-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'summary-popup-overlay';
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
      mainContent.appendChild(overlay);
    } else {
      document.body.appendChild(overlay);
    }
  }
  return overlay;
}

function renderSummaryBodyContent(data) {
  const { loading, generating, data: summaryData, error } = data;
  if (loading) {
    const msg = generating ? window.t('workspace_summary_generating') : window.t('workspace_summary_loading');
    return '<div class="summary-loading-state">' +
      '<div class="summary-spinner"></div>' +
      '<span>' + escapeHtml(msg) + '</span>' +
      '</div>';
  }
  if (error) {
    return '<div class="summary-error-state">' + escapeHtml(error) + '</div>';
  }
  if (!summaryData) return '';
  let bodyContent = '';

  // Session title & meta header
  const title = summaryData.sessionTitle || '';
  const createdAt = summaryData.createdAt ? new Date(summaryData.createdAt) : null;
  const timeStr = createdAt ? createdAt.toLocaleString(getCurrentLanguage() === 'zh' ? 'zh-CN' : 'en-US') : '';
  if (title || timeStr) {
    bodyContent += '<div class="summary-header">';
    if (title) bodyContent += '<div class="summary-title">' + escapeHtml(title) + '</div>';
    if (timeStr) bodyContent += '<div class="summary-time">' + escapeHtml(timeStr) + '</div>';
    bodyContent += '</div>';
  }

  // Summary body — rendered as markdown
  const summaryText = summaryData.summaryText || window.t('workspace_no_summary_content');
  bodyContent += '<div class="summary-body markdown-body">' + renderMarkdown(summaryText) + '</div>';

  // Important files — no icons, clean mono list
  if (summaryData.importantFiles && summaryData.importantFiles.length > 0) {
    bodyContent += '<div class="summary-section">';
    bodyContent += '<div class="summary-section-title">' + escapeHtml(window.t('workspace_important_files')) + '</div>';
    bodyContent += '<div class="summary-file-list">' + summaryData.importantFiles.map(f =>
      '<div class="summary-file-item">' + escapeHtml(f) + '</div>'
    ).join('') + '</div>';
    bodyContent += '</div>';
  }

  // Important skills
  if (summaryData.importantSkills && summaryData.importantSkills.length > 0) {
    bodyContent += '<div class="summary-section">';
    bodyContent += '<div class="summary-section-title">' + escapeHtml(window.t('workspace_important_skills')) + '</div>';
    bodyContent += '<div class="summary-tag-list">' + summaryData.importantSkills.map(s => '<span class="summary-tag">' + escapeHtml(s) + '</span>').join('') + '</div>';
    bodyContent += '</div>';
  }

  return bodyContent;
}

function updateSummaryOverlayDOM(data) {
  const overlay = getOrCreateSummaryOverlay();
  overlay.className = 'feature-detail-overlay';
  const hasData = data && data.data && !data.loading && !data.error;
  overlay.innerHTML =
    '<div class="feature-detail-window summary-popup-window">' +
    '<div class="feature-detail-head">' +
    '<div><div class="feature-detail-title">' + escapeHtml(window.t('workspace_summary_title')) + '</div></div>' +
    '<button class="feature-detail-close" type="button" data-action="summaryPopup.close">×</button>' +
    '</div>' +
    '<div class="summary-popup-body">' +
    renderSummaryBodyContent(data) +
    '</div>' +
    (hasData ? '<div class="summary-popup-footer"><button class="summary-regenerate-btn" type="button" data-action="summaryPopup.regenerate">' + escapeHtml(window.t('workspace_regenerate_summary')) + '</button></div>' : '') +
    '</div>';
  // Post-render: enhance math in summary markdown
  if (hasData) {
    requestAnimationFrame(() => {
      const md = overlay.querySelector('.summary-body.markdown-body');
      if (md) enhanceMathInElement(md);
    });
  }
}

export function openSummaryPopup(agentId, sessionId) {
  const _isZh = getCurrentLanguage() === 'zh';
  const _toastId = 'summary-' + sessionId;
  const _requestAgentId = _summaryRequestAgentId(agentId, sessionId);
  const _token = {};
  _summaryGenGuard.set(sessionId, _token);
  summaryPopupData = { agentId, sessionId, loading: true, generating: false, data: null, error: null };
  updateSummaryOverlayDOM(summaryPopupData);
  window.fetch('/protoclaw/session_summary?agentId=' + encodeURIComponent(_requestAgentId) + '&sessionId=' + encodeURIComponent(sessionId))
    .then(r => {
      if (r.status === 404) {
        if (summaryPopupData && summaryPopupData.agentId === agentId && summaryPopupData.sessionId === sessionId) {
          summaryPopupData.generating = true;
          updateSummaryOverlayDOM(summaryPopupData);
        }
        ClawToast.show({
          id: _toastId,
          title: _isZh ? '正在生成会话摘要...' : 'Generating session summary...',
          status: 'loading',
        });
        return window.fetch('/protoclaw/session_generate_summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
          body: JSON.stringify({ agentId: _requestAgentId, sessionId }),
        }).then(r2 => {
          if (!r2.ok) throw new Error('Generation failed');
          return r2.json();
        }).then(() => {
          return window.fetch('/protoclaw/session_summary?agentId=' + encodeURIComponent(_requestAgentId) + '&sessionId=' + encodeURIComponent(sessionId));
        }).then(r3 => {
          if (!r3.ok) throw new Error('Summary not found after generation');
          return r3.json();
        });
      }
      if (!r.ok) throw new Error(r.status);
      return r.json();
    })
    .then(data => {
      // Stale check: a newer openSummaryPopup call for the same session has superseded this one.
      if (_summaryGenGuard.get(sessionId) !== _token) return;
      if (summaryPopupData && summaryPopupData.agentId === agentId && summaryPopupData.sessionId === sessionId) {
        summaryPopupData.loading = false;
        summaryPopupData.generating = false;
        summaryPopupData.data = data;
        updateSummaryOverlayDOM(summaryPopupData);
      }
      loadAgents().catch(e => console.warn(e));
      ClawToast.update(_toastId, {
        status: 'success',
        title: _isZh ? '摘要已生成' : 'Summary generated',
      });
    })
    .catch(err => {
      // Stale check: a newer openSummaryPopup call for the same session has superseded this one.
      if (_summaryGenGuard.get(sessionId) !== _token) return;
      if (summaryPopupData && summaryPopupData.agentId === agentId && summaryPopupData.sessionId === sessionId) {
        summaryPopupData.loading = false;
        summaryPopupData.generating = false;
        summaryPopupData.error = err.message;
        updateSummaryOverlayDOM(summaryPopupData);
      }
      ClawToast.update(_toastId, {
        status: 'error',
        title: _isZh ? '摘要生成失败' : 'Summary generation failed',
        description: err.message || String(err),
      });
    });
}

function closeSummaryPopup() {
  summaryPopupData = null;
  const overlay = document.getElementById('summary-popup-overlay');
  if (overlay) overlay.remove();
}

function regenerateSummary() {
  if (!summaryPopupData) return;
  const { agentId, sessionId } = summaryPopupData;
  const _isZh = getCurrentLanguage() === 'zh';
  const _toastId = 'summary-regen-' + sessionId;
  const _requestAgentId = _summaryRequestAgentId(agentId, sessionId);
  summaryPopupData = { agentId, sessionId, loading: true, generating: true, data: null, error: null };
  updateSummaryOverlayDOM(summaryPopupData);
  ClawToast.show({
    id: _toastId,
    title: _isZh ? '正在重新生成摘要...' : 'Regenerating summary...',
    status: 'loading',
  });
  window.fetch('/protoclaw/session_generate_summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
    body: JSON.stringify({ agentId: _requestAgentId, sessionId, force: true }),
  })
    .then(r => { if (!r.ok) throw new Error('Generation failed'); return r.json(); })
    .then(() => window.fetch('/protoclaw/session_summary?agentId=' + encodeURIComponent(_requestAgentId) + '&sessionId=' + encodeURIComponent(sessionId)))
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(data => {
      if (summaryPopupData && summaryPopupData.agentId === agentId && summaryPopupData.sessionId === sessionId) {
        summaryPopupData.loading = false;
        summaryPopupData.generating = false;
        summaryPopupData.data = data;
        updateSummaryOverlayDOM(summaryPopupData);
      }
      loadAgents().catch(e => console.warn(e));
      ClawToast.update(_toastId, {
        status: 'success',
        title: _isZh ? '摘要已重新生成' : 'Summary regenerated',
      });
    })
    .catch(err => {
      if (summaryPopupData && summaryPopupData.agentId === agentId && summaryPopupData.sessionId === sessionId) {
        summaryPopupData.loading = false;
        summaryPopupData.generating = false;
        summaryPopupData.error = err.message;
        updateSummaryOverlayDOM(summaryPopupData);
      }
      ClawToast.update(_toastId, {
        status: 'error',
        title: _isZh ? '摘要生成失败' : 'Summary generation failed',
        description: err.message || String(err),
      });
    });
}


// ═══════════════════════════════════════════════════════════════
// Repo 搜索/过滤
// ═══════════════════════════════════════════════════════════════

export function setRepoSearchQuery(value) {
  debugPanel.repoSearchQuery = String(value || '').trim().toLowerCase();
  setShouldAnimateWorkspaceSurface(false);
  window.renderCurrentMainView();
}

export function setRepoSourceFilter(value) {
  debugPanel.repoSourceFilter = String(value || 'all');
  setShouldAnimateWorkspaceSurface(false);
  window.renderCurrentMainView();
}

// ═══════════════════════════════════════════════════════════════
// Feature Upload
// ═══════════════════════════════════════════════════════════════

export function openFeatureUploadDialog() {
  const dialog = document.getElementById('feature-upload-dialog');
  const input = document.getElementById('feature-upload-input');
  const status = document.getElementById('feature-upload-status');
  const submitBtn = document.getElementById('feature-upload-submit');
  const dropzone = document.getElementById('feature-upload-dropzone');
  
  dialog.style.display = 'flex';
  input.value = '';
  status.style.display = 'none';
  status.className = 'feature-upload-status';
  submitBtn.disabled = true;
  featureUploadFile = null;

  // 点击上传区域选择文件
  dropzone.onclick = () => input.click();
  
  // 文件选择变化
  input.onchange = (e) => {
    const file = e.target.files?.[0];
    handleFeatureUploadFile(file);
  };

  // 拖拽上传
  dropzone.ondragover = (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  };

  dropzone.ondragleave = () => {
    dropzone.classList.remove('dragover');
  };

  dropzone.ondrop = (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    handleFeatureUploadFile(file);
  };
}

function closeFeatureUploadDialog() {
  const dialog = document.getElementById('feature-upload-dialog');
  dialog.style.display = 'none';
  featureUploadFile = null;
}

function handleFeatureUploadFile(file) {
  const status = document.getElementById('feature-upload-status');
  const submitBtn = document.getElementById('feature-upload-submit');
  
  if (!file) {
    status.style.display = 'none';
    submitBtn.disabled = true;
    featureUploadFile = null;
    return;
  }

  if (!file.name.toLowerCase().endsWith('.tgz')) {
    status.textContent = repoLocaleText('请选择 .tgz 格式的文件', 'Please select a .tgz file');
    status.className = 'feature-upload-status error';
    status.style.display = 'block';
    submitBtn.disabled = true;
    featureUploadFile = null;
    return;
  }

  featureUploadFile = file;
  status.textContent = repoLocaleText(`已选择: ${file.name}`, `Selected: ${file.name}`);
  status.className = 'feature-upload-status success';
  status.style.display = 'block';
  submitBtn.disabled = false;
}

async function submitFeatureUpload() {
  if (!featureUploadFile) return;

  const status = document.getElementById('feature-upload-status');
  const submitBtn = document.getElementById('feature-upload-submit');
  
  submitBtn.disabled = true;
  status.textContent = repoLocaleText('上传中...', 'Uploading...');
  status.className = 'feature-upload-status';
  status.style.display = 'block';

  try {
    const formData = new FormData();
    formData.append('file', featureUploadFile);

    const response = await window.fetch('/protoclaw/feature_repository/upload', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'upload failed'));
    }

    status.textContent = repoLocaleText('上传成功!', 'Upload successful!');
    status.className = 'feature-upload-status success';

    setTimeout(() => {
      closeFeatureUploadDialog();
      // 仓库列表数据经 agent_detail 一次性载入（loadedAgentDetailIds 去重），
      // 上传后失效当前焦点 agent 的 detail 缓存并重拉，列表才会出现新包
      const detailIds = window.AgentLoaderHost?.loadedAgentDetailIds;
      if (focusedAgentId && typeof detailIds !== 'undefined') {
        detailIds.delete(focusedAgentId);
        loadAgentDetail(focusedAgentId)
          .then(() => window.renderCurrentMainView())
          .catch(e => console.warn(e));
      } else {
        window.renderCurrentMainView();
      }
    }, 1000);
  } catch (e) {
    status.textContent = repoLocaleText('上传失败: ', 'Upload failed: ') + (e && e.message ? e.message : e);
    status.className = 'feature-upload-status error';
    submitBtn.disabled = false;
  }
}

window.ClawFW.actions.registerMany({
  'summaryPopup.close': () => closeSummaryPopup(),
  'summaryPopup.regenerate': () => regenerateSummary(),
  'featureUpload.close': () => closeFeatureUploadDialog(),
  'featureUpload.submit': () => submitFeatureUpload(),
});

// 无兼容桥：两个入口的消费方（workspace-actions / workspace-blocks）都是 ESM
// 具名 import，classic 消费面已归零（逐键证据见头注）。
