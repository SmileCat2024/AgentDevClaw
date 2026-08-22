/**
 * dir-config-dialog.js — 目录 Feature 配置弹窗（目录层）
 *
 * 编程小助手会话顶部的 workspace tabs bar 上提供"目录设置"按钮，
 * 点击打开弹窗，内嵌共享配置编辑器（feature-config-editor.js），
 * 绑定当前项目目录的目录层（scopeId='dir:<path>'）。
 *
 * 配置队列位置：出厂默认 → 全局层 → agent 层 → 目录层（本弹窗编辑最后一层）。
 *
 * 外部依赖（通过全局作用域）：
 *   - escapeHtml (app-ui.js)
 *   - currentLanguage (app-core.js)
 *   - createFeatureConfigEditor / fsBaseName (feature-setup-core / editor)
 *
 * 入口：renderWorkspaceTabs (app-ui.js) 调用 phDirConfigButtonHtml(agent)
 */

let _dirConfigEditor = null;

function _dirConfigHost() {
  let host = document.getElementById('ph-dir-config-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ph-dir-config-host';
    document.body.appendChild(host);
  }
  return host;
}

/** 当前项目目录（编程小助手 workspace_state；无目录返回空串）。 */
function _dirConfigCurrentDir() {
  const rec = (typeof getCurrentAgentRecord === 'function') ? getCurrentAgentRecord() : null;
  const dir = rec?.workspace_state?.openDirectory;
  return typeof dir === 'string' && dir.trim() ? dir.trim() : '';
}

/**
 * workspace tabs bar 上的"目录设置"按钮 HTML。
 * 仅编程小助手且当前绑定了项目目录时返回按钮，否则返回空串。
 */
function phDirConfigButtonHtml(agent) {
  if (agent?.id !== 'programming-helper') return '';
  const dir = _dirConfigCurrentDir();
  if (!dir) return '';
  const isZh = currentLanguage === 'zh';
  return '<button class="workspace-tab ph-dir-config-btn" type="button"'
    + ' onclick="window.phOpenDirConfig()"'
    + ' title="' + escapeHtml(dir) + '">'
    + escapeHtml(isZh ? '目录设置' : 'Dir Config')
    + '</button>';
}

window.phOpenDirConfig = function () {
  const dir = _dirConfigCurrentDir();
  if (!dir) return;
  if (typeof createFeatureConfigEditor !== 'function') return;
  if (_dirConfigEditor) {
    _dirConfigEditor.close();
    _dirConfigEditor = null;
  }
  const isZh = currentLanguage === 'zh';
  const baseName = (typeof fsBaseName === 'function' ? fsBaseName(dir) : dir);
  _dirConfigHost().innerHTML = [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window ph-settings-window">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(isZh ? '目录设置 · ' : 'Directory Config · ') + escapeHtml(baseName) + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(dir) + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" onclick="window.phCloseDirConfig()">&times;</button>',
    '</div>',
    '<div class="ph-settings-feature-wrap" id="ph-dir-config-mount"></div>',
    '</div>',
    '</div>',
  ].join('');
  _dirConfigEditor = createFeatureConfigEditor({
    host: document.getElementById('ph-dir-config-mount'),
    scopeId: 'dir:' + dir,
  });
  _dirConfigEditor.open();
};

window.phCloseDirConfig = function () {
  if (_dirConfigEditor) {
    _dirConfigEditor.close();
    _dirConfigEditor = null;
  }
  const host = document.getElementById('ph-dir-config-host');
  if (host) host.innerHTML = '';
};
