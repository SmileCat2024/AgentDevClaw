/**
 * 装配预检面板（工作项 D 前端红灯）
 *
 * 消费 POST /protoclaw/preflight（server/routes/preflight.js → agentdev preflightAssembly）：
 * - 四查结果（issues）：error 红 / warning 黄，每条含修复建议
 * - dry-run 清单（assembly）：拓扑序 / 工具归属 / 钩子声明
 *
 * 依赖（全局函数）：escapeHtml, t (app-core.js)
 * 依赖（全局状态，本模块私有）：window.__preflightState
 */

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

function renderPreflightPanel() {
  const state = PREFLIGHT_STATE;

  const toolbar = [
    '<section class="log-panel">',
    '<div class="log-filter-row">',
    '<button type="button" class="log-chip" onclick="window.loadPreflight(true)">重新检查</button>',
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
      window.loadPreflight();
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

async function loadPreflight(forceRender = false) {
  const state = PREFLIGHT_STATE;
  state.loading = true;
  state.error = '';
  if (forceRender && typeof renderFeaturePanel === 'function') renderFeaturePanel();
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
    if (typeof renderFeaturePanel === 'function') renderFeaturePanel();
  }
}
