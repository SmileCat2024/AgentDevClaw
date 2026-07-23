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
 * 依赖（全局变量，声明于 app-core.js）：
 *   - currentLanguage, repoSearchQuery, repoSourceFilter
 *   - shouldAnimateWorkspaceSurface
 *
 * 依赖（全局函数）：
 *   - escapeHtml, renderMarkdown, enhanceMathInElement (markdown-utils.js / app-core.js)
 *   - t (app-core.js)
 *   - ClawToast (toast-notify.js)
 *   - loadAgents (app-main.js)
 *   - renderCurrentMainView, getRepoLocaleText (app-ui.js)
 */

// ═══════════════════════════════════════════════════════════════
// 模块级状态变量
// ═══════════════════════════════════════════════════════════════

let summaryPopupData = null;

// Guard token: prevents stale openSummaryPopup callbacks from updating the toast
// when a newer call for the same session has superseded them.
const _summaryGenGuard = new Map();

let featureUploadFile = null;

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
    const msg = generating ? t('workspace_summary_generating') : t('workspace_summary_loading');
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
  const timeStr = createdAt ? createdAt.toLocaleString(currentLanguage === 'zh' ? 'zh-CN' : 'en-US') : '';
  if (title || timeStr) {
    bodyContent += '<div class="summary-header">';
    if (title) bodyContent += '<div class="summary-title">' + escapeHtml(title) + '</div>';
    if (timeStr) bodyContent += '<div class="summary-time">' + escapeHtml(timeStr) + '</div>';
    bodyContent += '</div>';
  }

  // Summary body — rendered as markdown
  const summaryText = summaryData.summaryText || t('workspace_no_summary_content');
  bodyContent += '<div class="summary-body markdown-body">' + renderMarkdown(summaryText) + '</div>';

  // Important files — no icons, clean mono list
  if (summaryData.importantFiles && summaryData.importantFiles.length > 0) {
    bodyContent += '<div class="summary-section">';
    bodyContent += '<div class="summary-section-title">' + escapeHtml(t('workspace_important_files')) + '</div>';
    bodyContent += '<div class="summary-file-list">' + summaryData.importantFiles.map(f =>
      '<div class="summary-file-item">' + escapeHtml(f) + '</div>'
    ).join('') + '</div>';
    bodyContent += '</div>';
  }

  // Important skills
  if (summaryData.importantSkills && summaryData.importantSkills.length > 0) {
    bodyContent += '<div class="summary-section">';
    bodyContent += '<div class="summary-section-title">' + escapeHtml(t('workspace_important_skills')) + '</div>';
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
    '<div><div class="feature-detail-title">' + escapeHtml(t('workspace_summary_title')) + '</div></div>' +
    '<button class="feature-detail-close" type="button" onclick="window.closeSummaryPopup()">×</button>' +
    '</div>' +
    '<div class="summary-popup-body">' +
    renderSummaryBodyContent(data) +
    '</div>' +
    (hasData ? '<div class="summary-popup-footer"><button class="summary-regenerate-btn" type="button" onclick="window.regenerateSummary()">' + escapeHtml(t('workspace_regenerate_summary')) + '</button></div>' : '') +
    '</div>';
  // Post-render: enhance math in summary markdown
  if (hasData) {
    requestAnimationFrame(() => {
      const md = overlay.querySelector('.summary-body.markdown-body');
      if (md) enhanceMathInElement(md);
    });
  }
}

function openSummaryPopup(agentId, sessionId) {
  const _isZh = currentLanguage === 'zh';
  const _toastId = 'summary-' + sessionId;
  const _token = {};
  _summaryGenGuard.set(sessionId, _token);
  summaryPopupData = { agentId, sessionId, loading: true, generating: false, data: null, error: null };
  updateSummaryOverlayDOM(summaryPopupData);
  fetch('/protoclaw/session_summary?agentId=' + encodeURIComponent(agentId) + '&sessionId=' + encodeURIComponent(sessionId))
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
        return fetch('/protoclaw/session_generate_summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId, sessionId }),
        }).then(r2 => {
          if (!r2.ok) throw new Error('Generation failed');
          return r2.json();
        }).then(() => {
          return fetch('/protoclaw/session_summary?agentId=' + encodeURIComponent(agentId) + '&sessionId=' + encodeURIComponent(sessionId));
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

window.openSummaryPopup = openSummaryPopup;
window.closeSummaryPopup = closeSummaryPopup;

function regenerateSummary() {
  if (!summaryPopupData) return;
  const { agentId, sessionId } = summaryPopupData;
  const _isZh = currentLanguage === 'zh';
  const _toastId = 'summary-regen-' + sessionId;
  summaryPopupData = { agentId, sessionId, loading: true, generating: true, data: null, error: null };
  updateSummaryOverlayDOM(summaryPopupData);
  ClawToast.show({
    id: _toastId,
    title: _isZh ? '正在重新生成摘要...' : 'Regenerating summary...',
    status: 'loading',
  });
  fetch('/protoclaw/session_generate_summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, sessionId, force: true }),
  })
    .then(r => { if (!r.ok) throw new Error('Generation failed'); return r.json(); })
    .then(() => fetch('/protoclaw/session_summary?agentId=' + encodeURIComponent(agentId) + '&sessionId=' + encodeURIComponent(sessionId)))
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

window.regenerateSummary = regenerateSummary;

// ═══════════════════════════════════════════════════════════════
// Repo 搜索/过滤
// ═══════════════════════════════════════════════════════════════

function setRepoSearchQuery(value) {
  repoSearchQuery = String(value || '').trim().toLowerCase();
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
}

function setRepoSourceFilter(value) {
  repoSourceFilter = String(value || 'all');
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
}

window.setRepoSearchQuery = setRepoSearchQuery;
window.setRepoSourceFilter = setRepoSourceFilter;

// ═══════════════════════════════════════════════════════════════
// Feature Upload
// ═══════════════════════════════════════════════════════════════

function openFeatureUploadDialog() {
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
    status.textContent = getRepoLocaleText('请选择 .tgz 格式的文件', 'Please select a .tgz file');
    status.className = 'feature-upload-status error';
    status.style.display = 'block';
    submitBtn.disabled = true;
    featureUploadFile = null;
    return;
  }

  featureUploadFile = file;
  status.textContent = getRepoLocaleText(`已选择: ${file.name}`, `Selected: ${file.name}`);
  status.className = 'feature-upload-status success';
  status.style.display = 'block';
  submitBtn.disabled = false;
}

async function submitFeatureUpload() {
  if (!featureUploadFile) return;

  const status = document.getElementById('feature-upload-status');
  const submitBtn = document.getElementById('feature-upload-submit');
  
  submitBtn.disabled = true;
  status.textContent = getRepoLocaleText('上传中...', 'Uploading...');
  status.className = 'feature-upload-status';
  status.style.display = 'block';

  try {
    const formData = new FormData();
    formData.append('file', featureUploadFile);

    const response = await fetch('/protoclaw/feature_repository/upload', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'upload failed'));
    }

    status.textContent = getRepoLocaleText('上传成功!', 'Upload successful!');
    status.className = 'feature-upload-status success';
    
    setTimeout(() => {
      closeFeatureUploadDialog();
      renderCurrentMainView();
    }, 1000);
  } catch (e) {
    status.textContent = getRepoLocaleText('上传失败: ', 'Upload failed: ') + (e && e.message ? e.message : e);
    status.className = 'feature-upload-status error';
    submitBtn.disabled = false;
  }
}

window.openFeatureUploadDialog = openFeatureUploadDialog;
window.closeFeatureUploadDialog = closeFeatureUploadDialog;
window.submitFeatureUpload = submitFeatureUpload;
