/**
 * format-utils.js — 展示格式化函数族（P4 T1：从 app-core 抽出的第三族末件）。
 *
 * 六个纯格式化函数，原住在 app-core 顶层、被各渲染域裸标识符调用。迁入模块后：
 *
 *   - 具名导出给已迁消费方（trim-page / session-dialogs / debug-* /
 *     input-model-switcher / usage-info-overlay / workspace-blocks / …）；
 *   - `localizeWorkspaceValue` 仍有 window 访问面：已迁的 app-ui 显式读
 *     `window.localizeWorkspaceValue`（工作区 tab / 项目标题，本轮 app-ui 属禁区），
 *     悬置域 im-ui 走 classic 裸标识符。因此保留 KernelState 桥键（domain
 *     `format-utils`）；其余五个零 window 消费面，收敛为具名导出，不上桥；
 *   - 语言依赖改走 i18n 域的真实 owner（`getCurrentLanguage()` / `t`），不再读
 *     classic 词法绑定的 `currentLanguage`。
 *
 * 注销条件：app-ui 改为具名 import，且 im-ui 随 qqbot 线程化重做消亡后，删除
 * `localizeWorkspaceValue` 桥键。
 */
import { escapeHtml } from './markdown-utils.js';
import { t } from '../i18n.js';
import { getCurrentLanguage } from './i18n-environment-state.js';

/**
 * preset 名 → 用户可见显示名。
 * `__default__` 是 resolver 层的合成名（全局默认模型不在 presets.json 里），
 * 协议合成名不进 UI；模型切换按钮、toast、用量列表等显示点统一过此函数。
 */
export function formatPresetDisplayName(name) {
  if (name === '__default__') return getCurrentLanguage() === 'zh' ? '全局默认' : 'Default';
  return name;
}

export function localizeWorkspaceValue(value, fallback = '') {
  if (value == null) return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object') {
    const language = getCurrentLanguage();
    return String(value[language] || value.zh || value.en || fallback);
  }
  return fallback;
}

/** 比例小数（0–1）→ 百分数文本（trim / 分支对话框的 preamble 占比等共用口径）。 */
export function fmtPct(frac) {
  return (frac * 100).toFixed(1) + '%';
}

export function getFeatureStatus(feature) {
  return feature && feature.status ? feature.status : (feature && feature.enabled ? 'enabled' : 'partial');
}

export function getFeatureStatusLabel(status) {
  if (status === 'removed') return t('feature_removed');
  if (status === 'disabled') return t('feature_disabled');
  if (status === 'partial') return t('feature_partial');
  return t('feature_enabled');
}

export function getStatusBadgeClass(status) {
  return 'feature-badge status-' + escapeHtml(status || 'enabled');
}

// ── classic 兼容桥 ──────────────────────────────────────────────────────
// 悬置域 im-ui（qqbot 重做前保持 classic）仍裸读 localizeWorkspaceValue。
const bridgeState = { localizeWorkspaceValue };
window.KernelState.defineKey('format-utils', 'localizeWorkspaceValue', bridgeState.localizeWorkspaceValue);
window.KernelState.claim('format-utils', {
  get: (key) => bridgeState[key],
  set: (key, value) => { bridgeState[key] = value; },
});
