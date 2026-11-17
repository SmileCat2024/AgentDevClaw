/**
 * 装配预检面板（工作项 D 前端红灯）
 *
 * 消费 POST /protoclaw/preflight（server/routes/preflight.js → agentdev preflightAssembly）：
 * - 四查结果（issues）：error 红 / warning 黄，每条含修复建议
 * - dry-run 清单（assembly）：拓扑序 / 工具归属 / 钩子声明
 *
 * P2 ESM（debug 批次）：转义经 markdown-utils 的命名导出；预检状态
 * （PREFLIGHT_STATE / CHECK_LABELS）与渲染 helper 收敛为模块私有，不再占全局台账。
 * 仍为 classic 的 window 可达函数按晚绑定调用（调用时点取）：
 *   - renderFeaturePanel ← debug-panel-host.js（面板重绘）。
 *
 * 首屏不触达（R4）：本模块顶层只有动作注册与兼容桥注册，不发起请求；取数只
 * 发生在面板渲染路径（空态首渲染 / 重新检查动作）。预检面板在注册表里既无
 * icon 也无 order，rail 不生成按钮，也没有程序化打开方——模块求值前不存在
 * 可达入口。
 *
 * loadPreflight 是零消费实现：classic 侧唯一读点是本模块自己的渲染路径，
 * app-ui 既不发布也不转调它，因此不上桥（模块私有 + 命名导出供测试与后续
 * 消费方 import）。跨文件消费面与兼容桥见文件尾。
 */
import { escapeHtml } from './markdown-utils.js';

// ═══════════════════════════════════════════════════════════════
// 装配预检面板
// ═══════════════════════════════════════════════════════════════

const PREFLIGHT_STATE = {
  loading: false,
  data: null,
  error: '',
  lastFetchedAt: 0,
};

const CHECK_LABELS = {
  'inject-graph': '依赖完整性',
  'policy-uniqueness': 'policy 唯一性',
  'tool-name-conflict': '工具重名',
  'manifest': 'manifest',
};

export function renderPreflightPanel() {
  const state = PREFLIGHT_STATE;

  const toolbar = [
    '<section class="log-panel">',
    '<div class="log-filter-row">',
    '<button type="button" class="log-chip" data-action="debugPreflight.reload">重新检查</button>',
    state.loading
      ? '<span class="preflight-status">检查中…</span>'
      : renderPreflightStatusPill(state.data),
    state.lastFetchedAt > 0
      ? '<span class="preflight-status">' + new Date(state.lastFetchedAt).toLocaleTimeString() + '</span>'
      : '',
    '</div>',
    '</section>',
  ].join('');

  if (state.error) {
    return toolbar + '<div class="feature-panel-empty"><div>' + escapeHtml(state.error) + '</div></div>';
  }
  if (!state.data) {
    if (!state.loading) {
      loadPreflight();
    }
    return toolbar + '<div class="feature-panel-empty"><div>' + (state.loading ? '检查中…' : '点击"重新检查"开始装配预检') + '</div></div>';
  }

  const { issues = [], assembly, ok } = state.data;
  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');

  const issueBlock = [
    '<div class="preflight-section">',
    '<div class="preflight-section-title">检查结果'
      + (errors.length > 0 ? ' <span class="preflight-badge error">' + errors.length + ' 项错误</span>' : '')
      + (warnings.length > 0 ? ' <span class="preflight-badge warn">' + warnings.length + ' 项警告</span>' : '')
      + (errors.length === 0 && warnings.length === 0 ? ' <span class="preflight-badge ok">全部通过</span>' : '')
      + '</div>',
    issues.length === 0
      ? '<div class="preflight-hint">四查（依赖完整性 / policy 唯一性 / 工具重名 / manifest）均未发现问题。</div>'
      : issues.map(issue => [
          '<div class="preflight-issue ' + (issue.severity === 'error' ? 'error' : 'warn') + '">',
          '<div class="preflight-issue-head">',
          '<span class="preflight-issue-severity">' + (issue.severity === 'error' ? '✕' : '!') + '</span>',
          '<span class="log-pill">' + escapeHtml(CHECK_LABELS[issue.check] || issue.check) + '</span>',
          (issue.features || []).map(f => '<span class="log-pill">' + escapeHtml(f) + '</span>').join(''),
          '</div>',
          '<div class="preflight-issue-message">' + escapeHtml(issue.message) + '</div>',
          '</div>',
        ].join('')).join(''),
    '</div>',
  ].join('');

  const assemblyBlock = assembly
    ? [
        '<div class="preflight-section">',
        '<div class="preflight-section-title">dry-run 装配清单</div>',
        '<div class="preflight-hint">装配序（依赖先于依赖方）：</div>',
        '<div class="preflight-chain">' + assembly.order.map(o => '<span class="log-pill">' + escapeHtml(o) + '</span>').join('<span class="preflight-arrow">→</span>') + '</div>',
        '<div class="preflight-hint">工具（' + assembly.tools.length + '）：</div>',
        '<div class="preflight-table">' + assembly.tools.map(tool =>
          '<div class="preflight-row"><span class="log-pill">tool:' + escapeHtml(tool.name) + '</span><span class="preflight-dim">' + escapeHtml(tool.feature) + '</span></div>'
        ).join('') + '</div>',
        '<div class="preflight-hint">钩子声明（' + assembly.hooks.length + '）：</div>',
        '<div class="preflight-table">' + assembly.hooks.map(h =>
          '<div class="preflight-row"><span class="log-pill">hook:' + escapeHtml(h.lifecycle) + '</span><span class="preflight-dim">' + escapeHtml(h.feature + '.' + h.methodName) + '</span><span class="log-pill">' + escapeHtml(h.kind + (h.role ? ':' + h.role : '')) + '</span></div>'
        ).join('') + '</div>',
        '</div>',
      ].join('')
    : '<div class="preflight-section"><div class="preflight-hint">存在 error 级问题，装配不成立，无 dry-run 清单。修复上方问题后重新检查。</div></div>';

  return toolbar + issueBlock + assemblyBlock;
}

function renderPreflightStatusPill(data) {
  if (!data) return '';
  if (data.ok && (data.issues || []).length === 0) {
    return '<span class="preflight-badge ok">装配健康</span>';
  }
  if (!data.ok) {
    return '<span class="preflight-badge error">装配有错误</span>';
  }
  return '<span class="preflight-badge warn">装配有警告</span>';
}

export async function loadPreflight(forceRender = false) {
  const state = PREFLIGHT_STATE;
  state.loading = true;
  state.error = '';
  if (forceRender && typeof window.renderFeaturePanel === 'function') window.renderFeaturePanel();
  try {
    const res = await fetch('/protoclaw/preflight', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error('preflight 请求失败: HTTP ' + res.status);
    state.data = await res.json();
    state.lastFetchedAt = Date.now();
  } catch (e) {
    state.error = e.message || String(e);
  } finally {
    state.loading = false;
    if (typeof window.renderFeaturePanel === 'function') window.renderFeaturePanel();
  }
}

// ── 事件接线（data-action="debugPreflight.*"）────────────────────

window.ClawFW.actions.registerMany({
  'debugPreflight.reload': () => loadPreflight(true),
});

// ── 兼容桥（仍有 classic 消费方的入口）────────────────────────────
// renderPreflightPanel ← app-ui.js registerFeaturePanel('preflight').render 闭包
// （只在函数体内引用，且该面板无 icon/order、无程序化打开方，首屏不可达）。
// loadPreflight 零跨文件消费方（渲染路径内部直接调用），不上桥——不为测试
// 保留生产桥。注销条件：app-ui 面板注册迁移后改 import。
const bridged = { renderPreflightPanel };
window.KernelState.defineKey('debug-preflight', 'renderPreflightPanel', renderPreflightPanel);
window.KernelState.claim('debug-preflight', {
  get: (key) => bridged[key],
  set: (key, value) => { bridged[key] = value; },
});
