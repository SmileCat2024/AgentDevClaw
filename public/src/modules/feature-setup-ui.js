/**
 * Feature Setup UI 模块 — Runtime 配置 workspace 壳
 *
 * 只负责一件事：标题头 + 把共享配置编辑器（feature-config-editor.js）
 * 挂到 feature-setup workspace 的主区域，绑定全局层（scopeId='global'）。
 *
 * 共享编辑器同样被另外两个容器复用：
 *   - 工作空间设置弹窗子页面（ph-model-config.js，scopeId='agent'）
 *   - 目录会话配置弹窗（dir-config-dialog.js，scopeId='dir:<path>'）
 *
 * 导出: isSystemFeatureConfigBlock, renderSystemFeatureConfigBlock
 */

// ── Block detection ──────────────────────────────────────────

function isSystemFeatureConfigBlock(block) {
  return getCurrentAgentRecord()?.id === 'feature-setup' && block?.type === 'system-feature-config';
}

// ── Main render ──────────────────────────────────────────────

/** 当前 workspace 内活跃的编辑器实例与挂载 token（block 重渲染时先关旧的）。 */
let _fsEditor = null;
let _fsToken = 0;

function renderSystemFeatureConfigBlock(_block) {
  const isZh = (typeof currentLanguage !== 'undefined' && currentLanguage === 'zh');
  const token = ++_fsToken;
  // block 渲染返回 HTML 字符串，挂载点入 DOM 在下一帧；用 token 丢弃过期回调
  requestAnimationFrame(() => {
    if (token !== _fsToken) return;
    if (_fsEditor) {
      _fsEditor.close();
      _fsEditor = null;
    }
    const host = document.getElementById('fs-editor-mount');
    if (!host) return;
    _fsEditor = createFeatureConfigEditor({ host, scopeId: 'global' });
    _fsEditor.open();
  });
  return `
    <div class="fs-workspace-wrap">
      <div class="fs-workspace-head">
        <div class="fs-workspace-title">${isZh ? 'Runtime 配置' : 'Runtime Config'}</div>
        <div class="fs-workspace-subtitle">${isZh ? '全局 Feature 配置，对所有工作空间生效' : 'Global feature config applied to all workspaces'}</div>
      </div>
      <div id="fs-editor-mount" class="fs-editor-mount"></div>
    </div>
  `;
}
