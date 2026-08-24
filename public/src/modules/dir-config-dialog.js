/**
 * dir-config-dialog.js — Feature 配置弹窗（目录层 / 全局层）
 *
 * 两个入口，均为弹窗形式，内嵌共享配置编辑器（feature-config-editor.js）：
 *   - 目录层：编程小助手项目栏（ph-project-bar，sticky 悬浮）上的
 *     "目录设置"按钮，绑定当前项目目录（scopeId='dir:<path>'）；
 *   - 全局层：左下角设置 flyout 菜单"全局 Feature 设置"
 *     （scopeId='global'）。
 *
 * 配置队列位置：出厂默认 → 全局层 → agent 层 → 目录层。
 *
 * 外部依赖（通过全局作用域）：
 *   - escapeHtml (app-ui.js)
 *   - currentLanguage (app-core.js)
 *   - createFeatureConfigEditor / fsBaseName (feature-setup-core / editor)
 *
 * 入口：renderPhProjectBar (session-list-render.js) 调用
 * phDirConfigButtonHtml(agent)；window.phOpenDirConfig / phOpenGlobalFeatureConfig
 */

let _dirConfigEditor = null;
let _globalConfigEditor = null;

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
 * 编程小助手项目栏（ph-project-bar）上的"目录设置"按钮 HTML。
 * 仅编程小助手且传入了项目目录时返回按钮，否则返回空串。
 * 目录由渲染方显式传入（currentProject.openDirectory），不在此处
 * 二次查询 workspace_state——投影/焦点态下该查询不可靠。
 */
function phDirConfigButtonHtml(agent, dir) {
  if (agent?.id !== 'programming-helper') return '';
  dir = (typeof dir === 'string' && dir.trim()) ? dir.trim() : '';
  if (!dir) return '';
  const isZh = currentLanguage === 'zh';
  return '<button class="ph-banner-btn secondary" type="button"'
    + ' onclick="window.phOpenDirConfig(\'' + escapeHtml(dir) + '\')"'
    + ' title="' + escapeHtml(dir) + '">'
    + escapeHtml(isZh ? '目录设置' : 'Dir Config')
    + '</button>';
}

/** 通用 Feature 配置弹窗骨架（head + 编辑器挂载点）。 */
function _featureConfigDialogShell(hostId, titleHtml, subtitleHtml, closeFnName) {
  return [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window ph-settings-window">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + titleHtml + '</div>',
    '<div class="feature-detail-subtitle">' + subtitleHtml + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" onclick="window.' + closeFnName + '()">&times;</button>',
    '</div>',
    '<div class="ph-settings-feature-wrap" id="' + hostId + '"></div>',
    '</div>',
    '</div>',
  ].join('');
}

window.phOpenDirConfig = function (dir) {
  dir = (typeof dir === 'string' && dir.trim()) ? dir.trim() : _dirConfigCurrentDir();
  if (!dir) return;
  if (typeof createFeatureConfigEditor !== 'function') return;
  if (_dirConfigEditor) {
    _dirConfigEditor.close();
    _dirConfigEditor = null;
  }
  const isZh = currentLanguage === 'zh';
  const baseName = (typeof fsBaseName === 'function' ? fsBaseName(dir) : dir);
  _dirConfigHost().innerHTML = _featureConfigDialogShell(
    'ph-dir-config-mount',
    escapeHtml(isZh ? '目录设置 · ' : 'Directory Config · ') + escapeHtml(baseName),
    escapeHtml(dir),
    'phCloseDirConfig'
  );
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

// ── 全局 Feature 设置（设置 flyout 菜单入口，编辑全局层）──────

window.phOpenGlobalFeatureConfig = function () {
  if (typeof createFeatureConfigEditor !== 'function') return;
  if (_globalConfigEditor) {
    _globalConfigEditor.close();
    _globalConfigEditor = null;
  }
  const isZh = currentLanguage === 'zh';
  _dirConfigHost().innerHTML = _featureConfigDialogShell(
    'ph-global-config-mount',
    escapeHtml(isZh ? '全局 Feature 设置' : 'Global Feature Config'),
    escapeHtml(isZh ? '对所有工作空间生效的 Feature 配置' : 'Feature config applied to all workspaces'),
    'phCloseGlobalFeatureConfig'
  );
  _globalConfigEditor = createFeatureConfigEditor({
    host: document.getElementById('ph-global-config-mount'),
    scopeId: 'global',
  });
  _globalConfigEditor.open();
};

window.phCloseGlobalFeatureConfig = function () {
  if (_globalConfigEditor) {
    _globalConfigEditor.close();
    _globalConfigEditor = null;
  }
  const host = document.getElementById('ph-dir-config-host');
  if (host) host.innerHTML = '';
};
