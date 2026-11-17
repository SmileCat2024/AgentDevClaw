/**
 * i18n-environment-state.js — 语言 / 主题域（状态 owner + 应用逻辑）。
 *
 * P1 起本文件持有 `currentTheme` / `currentLanguage` 两个状态键（claim
 * `i18n-environment` 域，初值由 app-core 在 classic 相按原声明位置注册，认领时
 * 吸收）。P4 T1 把 classic 的 theme-lang.js 整体并入本文件：
 *
 *   applyTheme / applyLanguage / renderThemeToggle / setThemeStylesheet /
 *   showAgentStartError，以及两个静态按钮的 click 监听（原在 app-ui 顶层）。
 *
 * 迁移要点：
 *   - 对外接口不变：`window.applyTheme` / `window.applyLanguage` /
 *     `window.showAgentStartError` 仍是桥键（app-ui 之外只剩测试与诊断面消费）；
 *     boot.js 改为直接 import，不再经 window 转调。
 *   - 首屏触发时点不变：仍由 boot.js 在模块相调用 `applyTheme → applyLanguage`。
 *   - 按钮监听随函数一起搬到模块相。语义变化（P4 已裁决）：解析完成到模块求值
 *     之间点这两个静态按钮不再有任何效果（监听未注册）；此前该窗口内会调用
 *     classic 实现。此后再点与迁移前完全一致。
 *   - DOM 引用在本模块求值期查询（DOM 已解析完毕，等价重建）；dom-refs 域落地
 *     后改为从那里 import，不再各自查询。
 *   - 其余跨文件调用（renderAgentList / renderFeaturePanel / renderCurrentMainView /
 *     renderBrandCard / updateNotificationStatus / syncRailButtons /
 *     updateCurrentAgentChrome）仍是 classic 唯一实现，经 window 显式晚绑定，
 *     收敛批次见各自文件头注。
 */
import { t } from '../i18n.js';

const state = {
  currentTheme: undefined,
  currentLanguage: undefined,
};

export function getCurrentTheme() {
  return state.currentTheme;
}

export function setCurrentTheme(value) {
  state.currentTheme = value;
}

export function getCurrentLanguage() {
  return state.currentLanguage;
}

export function setCurrentLanguage(value) {
  state.currentLanguage = value;
}

/**
 * DOM 引用按调用时查询：这些元素是 index.html 的静态标记，查询结果与
 * classic 相一次性捕获等价；不在模块求值期查询，是因为本模块被大量 ESM 模块
 * import，求值期不应依赖"页面里恰好有这些元素"（测试宿主与嵌入场景）。
 * dom-refs 域落地后改为从那里 import。
 */
const el = (id) => document.getElementById(id);

// ── 主题 / 语言应用（原 theme-lang.js）──

export function showAgentStartError(error) {
  const message = error && error.message ? error.message : String(error || '');
  window.alert(`${t('status_start_failed')}: ${message}`);
}

export function renderThemeToggle() {
  const isLight = state.currentTheme === 'light';
  const themeToggle = el('theme-toggle');
  themeToggle.title = isLight ? t('theme_toggle_dark') : t('theme_toggle_light');
  themeToggle.innerHTML = isLight
    ? '<svg id="theme-toggle-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2.2M12 19.8V22M4.93 4.93l1.56 1.56M17.51 17.51l1.56 1.56M2 12h2.2M19.8 12H22M4.93 19.07l1.56-1.56M17.51 6.49l1.56-1.56"></path></svg>'
    : '<svg id="theme-toggle-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"></path></svg>';
}

export function applyLanguage() {
  const language = state.currentLanguage;
  localStorage.setItem('agentdev-language', language);
  document.title = t('page_title');

  const sidebarToggleEl = document.getElementById('sidebar-toggle');
  if (sidebarToggleEl) sidebarToggleEl.title = t('sidebar_toggle');
  // rail 面板按钮 title 从注册元数据 label 派生（ADR-0044 P2b）；
  // 此前是这里逐按钮 getElementById 的平行翻译清单。
  if (typeof window.syncRailButtons === 'function') window.syncRailButtons();
  const settingsConfigItem = document.getElementById('settings-flyout-config');
  const settingsAuthItem = document.getElementById('settings-flyout-auth');
  const settingsRemoteItem = document.getElementById('settings-flyout-remote');
  const settingsRemoteServersItem = document.getElementById('settings-flyout-remote-servers');
  const settingsUsageItem = document.getElementById('settings-flyout-usage');
  const settingsExitItem = document.getElementById('settings-flyout-exit');
  if (settingsConfigItem) settingsConfigItem.textContent = language === 'zh' ? '模型配置' : 'Model settings';
  if (settingsAuthItem) settingsAuthItem.textContent = language === 'zh' ? '访问保护' : 'Access protection';
  if (settingsRemoteItem) settingsRemoteItem.textContent = language === 'zh' ? '远程连接' : 'Remote connection';
  if (settingsRemoteServersItem) settingsRemoteServersItem.textContent = t('rcon_flyout_servers');
  if (settingsUsageItem) settingsUsageItem.textContent = language === 'zh' ? '用量信息' : 'Usage';
  if (settingsExitItem) settingsExitItem.textContent = language === 'zh' ? '退出程序' : 'Quit';

  if (typeof window.updateNotificationStatus === 'function'
    && typeof window.lastNotificationStatusPayload !== 'undefined'
    && window.lastNotificationStatusPayload) {
    window.updateNotificationStatus(window.lastNotificationStatusPayload);
  }

  if (typeof window.renderBrandCard === 'function') {
    window.renderBrandCard();
  }

  const languageToggle = el('language-toggle');
  languageToggle.title = t('language_toggle');
  languageToggle.textContent = t('language_toggle_short');
  el('restart-agent-action').textContent = t('restart_agent_runtime');
  el('stop-agent-action').textContent = t('close_agent_runtime');
  el('delete-agent-action').textContent = t('delete_agent');
  el('delete-project-action').textContent = t('delete_project');

  renderThemeToggle();
  window.renderAgentList();
  window.renderFeaturePanel();

  const currentAgentTitle = document.getElementById('current-agent-name');
  if (typeof window.updateCurrentAgentChrome === 'function') {
    window.updateCurrentAgentChrome();
  } else if (!window.focusedAgentId) {
    currentAgentTitle.textContent = t('page_title');
  }

  window.renderCurrentMainView();
}

export function applyTheme(theme) {
  state.currentTheme = theme === 'light' ? 'light' : 'dark';
  document.body.dataset.theme = state.currentTheme;
  localStorage.setItem('agentdev-theme', state.currentTheme);
  // 代码高亮 token 配色与 markdown 基础样式随主题切换（/vendor 本地依赖，同包同版本）
  // 注意：亮色主题文件名是 github.min.css / github-markdown-light.css（包内无 -light hljs 变体）
  setThemeStylesheet('hljs-theme-css', state.currentTheme === 'light'
    ? './vendor/hljs/styles/github.min.css'
    : './vendor/hljs/styles/github-dark.min.css');
  setThemeStylesheet('github-markdown-css', state.currentTheme === 'light'
    ? './vendor/github-markdown-css/github-markdown-light.css'
    : './vendor/github-markdown-css/github-markdown-dark.css');
  renderThemeToggle();
}

export function setThemeStylesheet(id, href) {
  const link = document.getElementById(id);
  if (link && link.getAttribute('href') !== href) {
    link.setAttribute('href', href);
  }
}

/**
 * 绑定主题 / 语言两个静态按钮的 click。由 boot.js 在首屏渲染完成后调用。
 *
 * 为什么不在这里的模块求值期直接绑：本模块由大量 ESM 模块 import，求值期不应
 * 依赖"页面里恰好有这两个按钮"；更重要的是首屏渲染链此刻尚未跑完
 * （applyLanguage → renderAgentList 需要 p4-entry 里 sidebar-layout 的桥键），
 * 此时点击会走进半就绪的链。绑定推迟到 boot 之后，早期窗口就是"无监听、点击
 * 无效果"（P4 裁决的早期事件语义），不产生半生效或抛错。
 * 幂等：重复调用不会重复绑定。
 */
let staticTogglesBound = false;
export function bindStaticToggleButtons() {
  if (staticTogglesBound) return;
  staticTogglesBound = true;
  el('theme-toggle').addEventListener('click', () => {
    applyTheme(state.currentTheme === 'light' ? 'dark' : 'light');
  });
  el('language-toggle').addEventListener('click', () => {
    state.currentLanguage = state.currentLanguage === 'zh' ? 'en' : 'zh';
    applyLanguage();
  });
}

// 桥接期：仍未迁移的 classic 消费方（app-main 的 showStartError 宿主等）经
// window 取用。收敛条件：消费面 grep 归零后注销。
//
// 域状态键（currentTheme / currentLanguage）与函数桥键同域，因此只有一个 impl：
// 认领时把哑存储里的两个状态键吸收进 `state`，函数键走 `bridgeKeys`。
const bridgeKeys = { applyTheme, applyLanguage, showAgentStartError };
window.KernelState.defineKey('i18n-environment', 'applyTheme', bridgeKeys.applyTheme);
window.KernelState.defineKey('i18n-environment', 'applyLanguage', bridgeKeys.applyLanguage);
window.KernelState.defineKey('i18n-environment', 'showAgentStartError', bridgeKeys.showAgentStartError);
window.KernelState.claim('i18n-environment', {
  get: (key) => (key in bridgeKeys ? bridgeKeys[key] : state[key]),
  set: (key, value) => {
    if (key in bridgeKeys) bridgeKeys[key] = value;
    else state[key] = value;
  },
});
