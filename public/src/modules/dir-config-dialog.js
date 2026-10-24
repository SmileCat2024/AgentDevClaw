/**
 * dir-config-dialog.js — Feature 配置弹窗（项目层 / 默认项目层 / 全局层）
 *
 * 三个入口，均为弹窗形式，内嵌共享配置编辑器（feature-config-editor.js）：
 *   - 项目层（project:<prj_id>）：归属菜单项目行的设置齿轮；
 *   - 默认项目层（dir:<path>）：归属菜单默认项目行的设置齿轮——目录桶的
 *     会话配置层，用户面统一呈现为「项目设置」（目录是内部 scope 概念，
 *     不再作为设置命名出现在界面上）；
 *   - 全局层：左下角设置 flyout 菜单"全局 Feature 设置"（scopeId='global'）。
 *
 * 配置队列位置：出厂默认 → 全局层 → agent 层 → 目录层（默认项目层）。
 *
 * 外部依赖（通过全局作用域）：
 *   - escapeHtml (app-ui.js)
 *   - currentLanguage (app-core.js)
 *   - createFeatureConfigEditor (feature-setup-core / editor)
 *
 * 入口：归属菜单行内齿轮（session-list-render.js 渲染按钮 + ph-project-actions.js
 * 捕获阶段委托调用）；window.phOpenGlobalFeatureConfig
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

// ── 默认项目层配置入口（dir:<path> scope）────────────────────────
// 归属菜单「默认项目」行的设置齿轮。目录桶的会话配置层在用户面统一呈现为
// 项目设置（「项目设置 · 默认项目」）——目录是内部 scope 概念，不进界面命名。
window.phOpenDirConfig = function (dir) {
  dir = (typeof dir === 'string' && dir.trim()) ? dir.trim() : _dirConfigCurrentDir();
  if (!dir) return;
  if (typeof createFeatureConfigEditor !== 'function') return;
  if (_dirConfigEditor) {
    _dirConfigEditor.close();
    _dirConfigEditor = null;
  }
  const isZh = currentLanguage === 'zh';
  _dirConfigHost().innerHTML = _featureConfigDialogShell(
    'ph-dir-config-mount',
    escapeHtml(isZh ? '项目设置 · 默认项目' : 'Project Settings · Default Project'),
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

// ── 项目层配置入口（ticket 045，project:<prj_id> scope）────────────
// 归属菜单项目行的设置齿轮（捕获阶段委托调用）：编辑项目层（project:<id>），
// 标题呈现项目名与真实工作目录（managed/外部指定）。编辑器复用共享三态
// 配置编辑器；保存走 PUT feature_config/layer（layerId=project:<id>，043
// 服务端已支持）。
window.phOpenProjectConfig = function (projectId) {
  projectId = String(projectId || '').trim();
  if (!projectId.startsWith('prj_')) return;
  if (typeof createFeatureConfigEditor !== 'function') return;
  const entity = ((window.ClawFW?.phProjectEntities?.projects) || [])
    .find((p) => p.id === projectId) || null;
  if (!entity) {
    // 元数据未就绪：补拉后重开（不退回默认项目设置）
    if (typeof ensurePhProjectEntitiesLoaded === 'function') {
      ensurePhProjectEntitiesLoaded(true).then(() => window.phOpenProjectConfig(projectId));
    }
    return;
  }
  if (_dirConfigEditor) {
    _dirConfigEditor.close();
    _dirConfigEditor = null;
  }
  const isZh = currentLanguage === 'zh';
  _dirConfigHost().innerHTML = _featureConfigDialogShell(
    'ph-dir-config-mount',
    escapeHtml(isZh ? '项目设置 · ' : 'Project Settings · ') + escapeHtml(entity.name),
    escapeHtml(entity.openDirectory || (isZh ? '托管目录' : 'Managed directory')),
    'phCloseDirConfig'
  );
  _dirConfigEditor = createFeatureConfigEditor({
    host: document.getElementById('ph-dir-config-mount'),
    scopeId: 'project:' + projectId,
  });
  _dirConfigEditor.open();
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
