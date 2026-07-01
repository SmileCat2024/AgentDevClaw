/**
 * resources-viewer.js — 资料/文档面板模块 (Phase 2b-2)
 *
 * 从 app-ui.js 提取。UI 已简化为极简风格，保留全部数据链路与功能。
 * 依赖（通过全局作用域解析）：
 *   escapeHtml(), renderFeaturePanel(), activeFeaturePanel, featurePanelBody,
 *   window.WorkGroupUI.*
 */
(function () {
  'use strict';

  // ── 共享文档状态 ──
  let _viewerFile = null;
  let _viewerContent = '';
  let _viewerChatId = null;
  let _viewerIsGroupMd = false;
  let _viewerPreview = false;
  let _viewerAutoSaveTimer = null;
  let _viewerAutoSaving = false;

  // ── 资料面板状态 ──
  let _filesPanelResources = [];
  let _filesPanelLoading = false;
  let _filesPanelLoadedChatId = null;
  let _resourcesSwitcherChatId = null;

  // ════════════════════════════════════════════════════════════════
  // 资料面板 (resources)
  // ════════════════════════════════════════════════════════════════

  function _getResourcesChatId() {
    return _resourcesSwitcherChatId || window.WorkGroupUI?.getActiveChatId?.() || null;
  }

  async function loadResourcesPanelData() {
    const chatId = _getResourcesChatId();
    if (!chatId) {
      _filesPanelResources = [];
      _filesPanelLoadedChatId = null;
      return;
    }
    if (_viewerAutoSaveTimer) {
      clearTimeout(_viewerAutoSaveTimer);
      _viewerAutoSaveTimer = null;
      saveViewerFile();
    }
    if (_filesPanelLoadedChatId !== chatId) {
      _filesPanelResources = [];
    }
    _filesPanelLoading = true;
    renderFeaturePanel();
    try {
      const res = await fetch(`/protoclaw/group_chats/${encodeURIComponent(chatId)}/resources`);
      const data = await res.json();
      _filesPanelResources = data.resources || [];
      _filesPanelLoadedChatId = chatId;
    } catch (err) {
      _filesPanelResources = [];
    }
    _filesPanelLoading = false;
    renderFeaturePanel();
  }

  async function createResourceFile() {
    const chatId = _getResourcesChatId();
    if (!chatId) return;
    const btn = document.querySelector('.rv-new-btn');
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    try {
      const res = await fetch(`/protoclaw/group_chats/${encodeURIComponent(chatId)}/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '' }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        _showFilesPanelError(`创建失败: ${errData.error || 'HTTP ' + res.status}`);
        return;
      }
      const data = await res.json();
      await loadResourcesPanelData();
      if (data.name) {
        openViewer(data.name, chatId, false);
      }
    } catch (err) {
      _showFilesPanelError(`创建失败: ${err.message || err}`);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '+ 新建'; }
    }
  }

  async function deleteResourceFile(name) {
    const chatId = _getResourcesChatId();
    if (!chatId) return;
    try {
      await fetch(`/protoclaw/group_chats/${encodeURIComponent(chatId)}/resources/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      await loadResourcesPanelData();
    } catch (err) {
      console.error('[ResourcesPanel] delete failed:', err);
    }
  }

  async function renameResourceFile(name, newName) {
    const chatId = _getResourcesChatId();
    if (!chatId) return;
    try {
      const res = await fetch(`/protoclaw/group_chats/${encodeURIComponent(chatId)}/resources/${encodeURIComponent(name)}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        _showFilesPanelError(`重命名失败: ${errData.error || 'HTTP ' + res.status}`);
        return;
      }
      if (_viewerFile === name && _viewerChatId === chatId) {
        _viewerFile = newName;
      }
      await loadResourcesPanelData();
    } catch (err) {
      _showFilesPanelError(`重命名失败: ${err.message || err}`);
    }
  }

  function _showFilesPanelError(msg) {
    const body = document.getElementById('feature-panel-body');
    if (!body) return;
    const existing = body.querySelector('.files-panel-error');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.className = 'files-panel-error';
    div.textContent = msg;
    div.style.cssText = 'padding:8px 12px;background:#f44336;color:#fff;font-size:13px;border-radius:4px;margin:8px 12px;';
    body.prepend(div);
    setTimeout(() => div.remove(), 5000);
  }

  function renderResourcesPanel() {
    const chatId = _getResourcesChatId();

    if (!chatId) {
      return '<div class="feature-panel-empty"><div>请先选择一个群聊。</div></div>';
    }

    if (_filesPanelLoadedChatId !== chatId && !_filesPanelLoading) {
      loadResourcesPanelData();
      return '<div class="feature-panel-empty"><div>加载中...</div></div>';
    }

    if (_filesPanelLoading && _filesPanelResources.length === 0) {
      return '<div class="feature-panel-empty"><div>加载中...</div></div>';
    }

    const chatSummaries = window.WorkGroupUI?.getChatSummaries?.() || [];
    const activeChat = window.WorkGroupUI?.getActiveChat?.();

    const switcherChat = _resourcesSwitcherChatId
      ? chatSummaries.find(c => c.id === _resourcesSwitcherChatId)
      : activeChat;
    const hasWorkDir = !!(switcherChat?.workDir);
    const workDir = switcherChat?.workDir || '';

    const switcherOptions = chatSummaries.length > 0
      ? chatSummaries.map(c =>
          `<option value="${escapeHtml(c.id)}"${c.id === chatId ? ' selected' : ''}>${escapeHtml(c.name)}${c.workDir ? '' : ' (无目录)'}</option>`
        ).join('')
      : `<option value="${escapeHtml(chatId)}" selected>${escapeHtml(activeChat?.name || '当前群聊')}</option>`;

    const groupMdEntry = _filesPanelResources.find(r => r.isGroupMd);
    const fileEntries = _filesPanelResources.filter(r => !r.isGroupMd);

    // 极简文件列表
    function renderItem(r, isGroupMd) {
      const name = isGroupMd ? 'GROUP.md' : r.name;
      const jsName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
      const metaText = isGroupMd ? '群文档' : (r.size < 1024 ? `${r.size} B` : `${(r.size / 1024).toFixed(1)} KB`);
      const actions = isGroupMd ? '' : [
        `<button class="rv-file-btn" onclick="event.stopPropagation();window._filesRename('${jsName}')">改名</button>`,
        `<button class="rv-file-btn rv-file-del" onclick="event.stopPropagation();window._filesDelete('${jsName}')">&times;</button>`,
      ].join('');
      const dragAttr = isGroupMd ? '' : ` draggable="true" data-files-name="${escapeHtml(name)}"`;
      return `<div class="rv-file-item" onclick="window._viewerOpen('${jsName}','${escapeHtml(chatId)}',${isGroupMd})"${dragAttr}>` +
        `<span class="rv-file-name">${escapeHtml(name)}</span>` +
        `<span class="rv-file-meta">${escapeHtml(metaText)}</span>` +
        `<span class="rv-file-actions">${actions}</span>` +
        `</div>`;
    }

    let listHtml;
    if (!hasWorkDir) {
      listHtml = '<div class="rv-empty">未配置工作目录</div>';
    } else if (!groupMdEntry && fileEntries.length === 0) {
      listHtml = '<div class="rv-empty">暂无文件</div>';
    } else {
      const items = [];
      if (groupMdEntry) items.push(renderItem(groupMdEntry, true));
      fileEntries.forEach(r => items.push(renderItem(r, false)));
      listHtml = items.join('');
    }

    const totalCount = (groupMdEntry ? 1 : 0) + fileEntries.length;

    return [
      '<div class="rv-panel">',
      `  <select class="rv-switcher" onchange="window._resourcesSwitchChat(this.value)">${switcherOptions}</select>`,
      '  <div class="rv-header">',
      `    <span>文件 (${totalCount})</span>`,
      hasWorkDir ? '    <button class="rv-new-btn" onclick="window._filesCreate()">+ 新建</button>' : '',
      '  </div>',
      workDir ? `  <div class="rv-path" title="${escapeHtml(workDir)}">${escapeHtml(workDir)}</div>` : '',
      `  <div class="rv-list">${listHtml}</div>`,
      '</div>',
    ].join('');
  }

  // ════════════════════════════════════════════════════════════════
  // 文档面板 (viewer)
  // ════════════════════════════════════════════════════════════════

  function openViewer(file, chatId, isGroupMd) {
    if (_viewerAutoSaveTimer) {
      clearTimeout(_viewerAutoSaveTimer);
      _viewerAutoSaveTimer = null;
      saveViewerFile();
    }
    _viewerFile = file;
    _viewerChatId = chatId;
    _viewerIsGroupMd = !!isGroupMd;
    _viewerContent = '';
    const _isMd = !!isGroupMd || /\.md$/i.test(file);
    _viewerPreview = _isMd;
    if (typeof activeFeaturePanel !== 'undefined') {
      activeFeaturePanel = 'viewer';
    }
    renderFeaturePanel();
    loadViewerContent();
  }

  async function loadViewerContent() {
    if (!_viewerFile || !_viewerChatId) return;
    const cid = _viewerChatId;
    try {
      let content;
      if (_viewerIsGroupMd) {
        const res = await fetch(`/protoclaw/group_chats/${encodeURIComponent(cid)}/group_md`);
        const data = await res.json();
        content = data.content || '';
      } else {
        const res = await fetch(`/protoclaw/group_chats/${encodeURIComponent(cid)}/resources/${encodeURIComponent(_viewerFile)}`);
        const data = await res.json();
        content = data.content || '';
      }
      if (_viewerChatId !== cid) return;
      _viewerContent = content;
    } catch (err) {
      if (_viewerChatId !== cid) return;
      _viewerContent = '(加载失败)';
    }
    renderFeaturePanel();
    const ta = document.querySelector('[data-files-role="editor"]');
    if (ta) ta.focus();
  }

  function _setViewerSaveStatus(text) {
    const el = document.querySelector('[data-files-role="save-status"]');
    if (!el) return;
    el.textContent = text;
  }

  async function saveViewerFile() {
    if (!_viewerFile || !_viewerChatId) return;
    const cid = _viewerChatId;
    const ta = document.querySelector('[data-files-role="editor"]');
    const content = ta ? ta.value : _viewerContent;
    _viewerAutoSaving = true;
    _setViewerSaveStatus('保存中…');
    try {
      if (_viewerIsGroupMd) {
        await fetch(`/protoclaw/group_chats/${encodeURIComponent(cid)}/group_md`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
      } else {
        await fetch(`/protoclaw/group_chats/${encodeURIComponent(cid)}/resources/${encodeURIComponent(_viewerFile)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
      }
      if (_viewerChatId !== cid) return;
      _viewerContent = content;
      _setViewerSaveStatus('已保存');
    } catch (err) {
      console.error('[ViewerPanel] save failed:', err);
      _setViewerSaveStatus('保存失败');
    }
    _viewerAutoSaving = false;
  }

  function _viewerAutoSave() {
    if (_viewerAutoSaveTimer) clearTimeout(_viewerAutoSaveTimer);
    _viewerAutoSaveTimer = setTimeout(() => {
      _viewerAutoSaveTimer = null;
      saveViewerFile();
    }, 1000);
  }

  function renderViewerPanel() {
    if (!_viewerFile) {
      return '<div class="feature-panel-empty"><div>从「资料」面板选择一个文件开始编辑。</div></div>';
    }

    const isMd = /\.md$/i.test(_viewerFile) || _viewerIsGroupMd;
    const showPreview = isMd && _viewerPreview;
    const displayName = _viewerIsGroupMd ? 'GROUP.md · 群文档' : _viewerFile;
    const toggleBtn = isMd
      ? `<button class="rv-toggle-btn" onclick="window._viewerTogglePreview()">${_viewerPreview ? '编辑' : '预览'}</button>`
      : '';

    let contentAreaHtml;
    if (showPreview) {
      const mdHtml = typeof marked !== 'undefined'
        ? marked.parse(_viewerContent || '')
        : escapeHtml(_viewerContent || '');
      contentAreaHtml = `<div class="markdown-body" data-files-role="preview">${mdHtml}</div>`;
    } else {
      contentAreaHtml = `<textarea class="rv-editor" data-files-role="editor" oninput="window._viewerAutoSave()" placeholder="在此编辑文件内容...">${escapeHtml(_viewerContent)}</textarea>`;
    }

    return [
      '<div class="rv-viewer">',
      '  <div class="rv-viewer-header">',
      `    <span class="rv-viewer-title">${escapeHtml(displayName)}</span>`,
      '    <span class="rv-viewer-actions">',
      toggleBtn,
      '      <span class="rv-save-status" data-files-role="save-status"></span>',
      '    </span>',
      '  </div>',
      `  <div class="rv-viewer-body">${contentAreaHtml}</div>`,
      '  <div class="rv-viewer-footer">',
      '    <button class="rv-footer-btn" onclick="window._viewerInsertMessage()">插入消息</button>',
      '    <button class="rv-footer-btn" onclick="window._viewerCopyContent()">复制内容</button>',
      '  </div>',
      '</div>',
    ].join('');
  }

  // ════════════════════════════════════════════════════════════════
  // 状态重置（供 renderCurrentMainView 调用）
  // ════════════════════════════════════════════════════════════════

  function resetResourcesViewerState() {
    _filesPanelResources = [];
    _filesPanelLoadedChatId = null;
    _resourcesSwitcherChatId = null;
    _viewerFile = null;
    _viewerContent = '';
    _viewerChatId = null;
    _viewerIsGroupMd = false;
    _viewerPreview = false;
  }

  // ════════════════════════════════════════════════════════════════
  // 面板注册（注入 featurePanels）
  // ════════════════════════════════════════════════════════════════

  function registerResourcesViewerPanels() {
    if (typeof featurePanels !== 'undefined' && featurePanels) {
      featurePanels.resources = {
        title: () => '资料',
        render: () => renderResourcesPanel(),
      };
      featurePanels.viewer = {
        title: () => '文档',
        render: () => renderViewerPanel(),
      };
    }
  }

  // ════════════════════════════════════════════════════════════════
  // window 导出
  // ════════════════════════════════════════════════════════════════

  window._filesPanelGetResources = () => _filesPanelResources;
  window._filesDelete = (name) => {
    if (confirm(`确定删除「${name}」？`)) deleteResourceFile(name);
  };
  window._filesCreate = () => createResourceFile();
  window._filesRename = (name) => {
    const newName = prompt('重命名文件', name);
    if (newName && newName.trim() && newName.trim() !== name) {
      renameResourceFile(name, newName.trim());
    }
  };

  window._viewerOpen = (file, chatId, isGroupMd) => openViewer(file, chatId, isGroupMd);
  window._viewerAutoSave = _viewerAutoSave;
  window._viewerTogglePreview = () => {
    const ta = document.querySelector('[data-files-role="editor"]');
    if (ta) {
      _viewerContent = ta.value;
      if (_viewerAutoSaveTimer) {
        clearTimeout(_viewerAutoSaveTimer);
        _viewerAutoSaveTimer = null;
        saveViewerFile();
      }
    }
    _viewerPreview = !_viewerPreview;
    renderFeaturePanel();
  };
  window._viewerInsertMessage = () => {
    const ta = document.querySelector('[data-files-role="editor"]');
    const content = ta ? ta.value : _viewerContent;
    const name = _viewerFile || 'untitled';
    if (window.WorkGroupUI?.addAttachment) {
      window.WorkGroupUI.addAttachment(name, content);
    }
  };
  window._viewerCopyContent = () => {
    const ta = document.querySelector('[data-files-role="editor"]');
    const content = ta ? ta.value : _viewerContent;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(content).catch(() => {});
    }
  };

  window._resourcesSwitchChat = (chatId) => {
    _resourcesSwitcherChatId = chatId || null;
    loadResourcesPanelData();
  };

  // 全局暴露（供 app-ui.js 内部引用）
  window.resetResourcesViewerState = resetResourcesViewerState;
  window._rvRegisterPanels = registerResourcesViewerPanels;
  window._rvLoadData = loadResourcesPanelData;

  // ── dragstart 事件委托（文件条目可拖拽到输入区） ──
  document.addEventListener('DOMContentLoaded', () => {
    const fpBody = document.getElementById('feature-panel-body');
    if (!fpBody) return;
    fpBody.addEventListener('dragstart', (e) => {
      const item = e.target.closest('[data-files-name]');
      if (!item) return;
      const name = item.dataset.filesName;
      if (!name) return;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('application/x-claw-resource', name);
      item.classList.add('dragging');
      const onEnd = () => { item.classList.remove('dragging'); item.removeEventListener('dragend', onEnd); };
      item.addEventListener('dragend', onEnd);
    });
  });

  // 初始化面板注册
  registerResourcesViewerPanels();
})();
