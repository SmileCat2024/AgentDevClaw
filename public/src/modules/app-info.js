/**
 * app-info.js — 左上角品牌版本标签 + 悬停名片
 * 从 /protoclaw/app_info 拉取版本与仓库信息：
 *   - 标题右侧版本 chip（数据就绪后才显示）
 *   - 悬停 sidebar-header 展开名片（版本 / 框架 / GitHub 仓库）
 *
 * 依赖全局状态（定义在 app-core.js）:
 *   currentLanguage
 * 依赖全局函数:
 *   escapeHtml (app-core.js)
 * 导出全局函数:
 *   renderBrandCard（applyLanguage 语言切换时重填文案）
 * DOM 引用:
 *   #brand-version-chip / #brand-card 及其子节点（index.html sidebar-header）
 */

let _appInfo = null;

function _githubIconSvg() {
  return '<svg class="brand-card-repo-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"></path></svg>';
}

function _externalLinkSvg() {
  return '<svg class="brand-card-repo-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10"></path></svg>';
}

function renderBrandCard() {
  if (!_appInfo) return;
  const isZh = currentLanguage === 'zh';

  const chip = document.getElementById('brand-version-chip');
  if (chip) chip.textContent = 'v' + (_appInfo.version || '—');

  const desc = document.getElementById('brand-card-desc');
  if (desc) desc.textContent = isZh
    ? '可视化、可扩展的 AI Agent 工作台'
    : 'A visual, extensible AI agent workspace';

  const versionLabel = document.getElementById('brand-card-version-label');
  if (versionLabel) versionLabel.textContent = isZh ? '版本' : 'Version';
  const versionValue = document.getElementById('brand-card-version');
  if (versionValue) versionValue.textContent = 'v' + (_appInfo.version || '—');

  const frameworkLabel = document.getElementById('brand-card-framework-label');
  if (frameworkLabel) frameworkLabel.textContent = isZh ? '框架' : 'Framework';
  const frameworkValue = document.getElementById('brand-card-framework');
  if (frameworkValue) frameworkValue.textContent = 'AgentDev ' + (_appInfo.framework?.version || '—');

  const links = document.getElementById('brand-card-links');
  if (links) {
    const entries = [
      { key: 'app', name: 'AgentDevClaw', url: _appInfo.repos?.app },
      { key: 'framework', name: 'AgentDev', url: _appInfo.repos?.framework },
    ];
    links.innerHTML = entries
      .filter((entry) => entry.url)
      .map((entry) =>
        '<a class="brand-card-repo" href="' + escapeHtml(entry.url) + '" target="_blank" rel="noopener noreferrer">'
        + _githubIconSvg()
        + '<span>' + escapeHtml(entry.name) + '</span>'
        + _externalLinkSvg()
        + '</a>'
      ).join('');
  }
}

async function _initAppInfo() {
  try {
    const response = await fetch('/protoclaw/app_info');
    const payload = await response.json();
    if (!payload?.ok || !payload.version) return;
    _appInfo = payload;
    renderBrandCard();
    const chip = document.getElementById('brand-version-chip');
    if (chip) chip.hidden = false;
    const card = document.getElementById('brand-card');
    if (card) card.hidden = false;
  } catch {
    // 接口不可用时保持 chip 与名片隐藏，不影响其余 UI
  }
}

_initAppInfo();
