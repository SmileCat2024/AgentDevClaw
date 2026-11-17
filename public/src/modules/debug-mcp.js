/**
 * debug-mcp.js — MCP 面板渲染
 *
 * 从 debug-panels.js 拆出。包含：
 *   - setCurrentMcpInfo
 *   - renderMcpItems, renderMcpPanel
 *
 * P2 ESM（debug 批次）依赖：
 *   - MCP 信息 state 经 p2-bootstrap-debug-panel 的 debugPanel 成对读写
 *     （仍是 app-core 首屏边界的 classic let，同一引用、不持副本）；
 *   - escapeHtml（markdown-utils）、currentRuntimeAgentId（orchestration-state
 *     live binding）、activeFeaturePanel（render-entry-state live binding）直接 import；
 *   - 仍 classic 的 window 可达函数按晚绑定调用（调用时点取）：t (i18n.js)、
 *     renderFeaturePanel (debug-panel-host.js)、getRuntimeId (app-core.js)。
 *   - safePrettyJson：定义方 debug-logs.js 按 R4 整文件保留 classic（rail 早期
 *     入口），本模块经 window.safePrettyJson 取那份唯一实现——不 import、
 *     不复制第二份。边界：依赖 debug-logs 的 classic 标签先于本模块求值装载；
 *     classic 标签全部先于 deferred ESM 执行，故 render 时点恒可用。
 *
 * 首屏不触达（R4）：本模块顶层只有兼容桥注册（defineKey / claim），不发请求。
 * loadMcpInfo 只由面板 onOpen 与认证后启动链调用；renderMcpPanel 只由
 * renderFeaturePanel 在 activeFeaturePanel === 'mcp' 时调用。本面板在注册表里
 * 没有 order，rail-customize 会给它挂 rail-custom-hidden（!important）强制屏蔽，
 * 也没有任何程序化打开方——首屏不存在可点击的 MCP 入口，故转 ESM 不触线。
 * 跨文件消费面与兼容桥见文件尾。
 */
import { escapeHtml } from './markdown-utils.js';
import { currentRuntimeAgentId } from './orchestration-state.js';
import { activeFeaturePanel } from './render-entry-state.js';
import { debugPanel } from './p2-bootstrap-debug-panel.js';

// ═══════════════════════════════════════════════════════════════
// MCP 信息
// ═══════════════════════════════════════════════════════════════

function setCurrentMcpInfo(info) {
  debugPanel.currentMcpInfo = info || null;
}

// ═══════════════════════════════════════════════════════════════
// MCP 面板
// ═══════════════════════════════════════════════════════════════

function renderMcpItems(items, typeLabel) {
  if (!Array.isArray(items) || items.length === 0) {
    return '<div class="feature-panel-empty"><div>' + escapeHtml(window.t('active_none')) + '</div></div>';
  }

  return '<div class="mcp-list">' + items.map((item) => {
    const name = item.name || item.uri || '';
    return [
    '<article class="mcp-item">',
    '<div class="mcp-item-head">',
    '<div class="mcp-item-name">' + escapeHtml(name) + '</div>',
    '<div class="mcp-item-type">' + escapeHtml(typeLabel) + '</div>',
    '</div>',
      '<div class="mcp-item-desc">' + escapeHtml(item.description || '') + '</div>',
      '</article>',
    ].join('');
  }).join('') + '</div>';
}

export function renderMcpPanel() {
  const currentMcpInfo = debugPanel.currentMcpInfo;
  if (!currentMcpInfo) {
    return '<div class="feature-panel-empty"><div>' + escapeHtml(window.t('mcp_loading')) + '</div></div>';
  }

  const info = currentMcpInfo;
  return [
    '<div class="mcp-panel">',
    '<section class="mcp-hero">',
    '<div class="hooks-kicker">' + escapeHtml(window.t('mcp_section_kicker')) + '</div>',
    '<div class="hooks-hero-title">' + escapeHtml(window.t('mcp_hero_title')) + '</div>',
    '<div class="hooks-hero-subtitle">' + escapeHtml(window.t('mcp_subtitle')) + '</div>',
    '<div class="mcp-status-pill">' + escapeHtml(info.enabled ? window.t('mcp_enabled') : window.t('mcp_disabled')) + '</div>',
    '</section>',
    '<section class="feature-panel-section">',
    '<div class="feature-panel-section-title">' + escapeHtml(window.t('panel_inspector')) + '</div>',
    '<div class="mcp-grid">',
    '<div class="mcp-stat"><div class="mcp-stat-label">' + escapeHtml(window.t('mcp_endpoint')) + '</div><div class="mcp-stat-value">' + escapeHtml(info.endpoint || '') + '</div></div>',
    '<div class="mcp-stat"><div class="mcp-stat-label">' + escapeHtml(window.t('mcp_transport')) + '</div><div class="mcp-stat-value">' + escapeHtml(info.transport || '') + '</div></div>',
    '<div class="mcp-stat"><div class="mcp-stat-label">' + escapeHtml(window.t('mcp_tools')) + '</div><div class="mcp-stat-value">' + String((info.tools || []).length) + '</div></div>',
    '<div class="mcp-stat"><div class="mcp-stat-label">' + escapeHtml(window.t('mcp_resources')) + '</div><div class="mcp-stat-value">' + String((info.resources || []).length) + '</div></div>',
    '</div>',
    '</section>',
    '<section class="feature-panel-section">',
    '<div class="feature-panel-section-title">' + escapeHtml(window.t('mcp_client_config')) + '</div>',
    '<div class="mcp-item-desc" style="margin-bottom:8px;">' + escapeHtml(window.t('mcp_claude_desktop')) + '</div>',
    '<pre class="mcp-code">' + escapeHtml(window.safePrettyJson(info.commands?.claudeDesktop?.json || {})) + '</pre>',
    '<div class="mcp-item-desc" style="margin:12px 0 8px 0;">' + escapeHtml(window.t('mcp_codex')) + '</div>',
    '<pre class="mcp-code">' + escapeHtml(window.safePrettyJson(info.commands?.codex?.json || {})) + '</pre>',
    '<div class="mcp-item-desc" style="margin:12px 0 8px 0;">' + escapeHtml(window.t('mcp_manual')) + '</div>',
    '<pre class="mcp-code">' + escapeHtml(info.commands?.curlInitialize || '') + '</pre>',
    '</section>',
    '<section class="feature-panel-section">',
    '<div class="feature-panel-section-title">' + escapeHtml(window.t('mcp_tool_list')) + '</div>',
    renderMcpItems(info.tools || [], window.t('mcp_item_tool')),
    '</section>',
    '<section class="feature-panel-section">',
    '<div class="feature-panel-section-title">' + escapeHtml(window.t('mcp_resource_list')) + '</div>',
    renderMcpItems(info.resources || [], window.t('mcp_item_resource')),
    '</section>',
    '<section class="feature-panel-section">',
    '<div class="feature-panel-section-title">' + escapeHtml(window.t('mcp_prompt_list')) + '</div>',
    renderMcpItems(info.prompts || [], window.t('mcp_item_prompt')),
    '</section>',
    '</div>',
  ].join('');
}

// ── loadMcpInfo (from app-main.js) ──
export async function loadMcpInfo(forceRender = false) {
  try {
    // 带当前会话 agentId（远程会话为命名空间 id，经代理闸还原裸 id 后转发）。
    // viewer 端 mcp-info 是全局端点，本地身份也带此参数但被服务端忽略，行为不变。
    const params = new URLSearchParams();
    const runtimeId = window.getRuntimeId(currentRuntimeAgentId);
    if (runtimeId) {
      params.set('agentId', runtimeId);
    }
    const query = params.toString();
    const res = await fetch('/api/mcp-info' + (query ? `?${query}` : ''));
    if (!res.ok) {
      setCurrentMcpInfo(null);
      return;
    }
    const data = await res.json();
    setCurrentMcpInfo(data);
    if (forceRender && activeFeaturePanel === 'mcp') {
      window.renderFeaturePanel();
    }
  } catch (e) {
    console.error('Failed to load MCP info:', e);
    if (forceRender && activeFeaturePanel === 'mcp') {
      window.renderFeaturePanel();
    }
  }
}

// ── 兼容桥（仍有 classic 消费方的入口）────────────────────────────
// renderMcpPanel ← app-ui.js registerFeaturePanel('mcp').render 闭包；
// loadMcpInfo ← app-main.js 的 application-startup host 工厂（loadMcp）与
// app-ui.js 面板 onOpen。
// 注册相位在 ESM 相的依据（R4，非「classic 相无读取点」的推断）：两个消费点
// 都只在函数体内引用，classic 相关闭包不执行；而唯一能触发它们的事件入口
// （rail 上的 MCP 按钮）被 rail-customize 按「无 order」强制隐藏，面板也没有
// 程序化打开方，因此模块求值前不存在可达调用。注销条件：上述消费方转 ESM 后改 import。
// setCurrentMcpInfo / renderMcpItems 零跨文件消费方，保持模块私有。
const bridged = { renderMcpPanel, loadMcpInfo };
window.KernelState.defineKey('debug-mcp', 'renderMcpPanel', renderMcpPanel);
window.KernelState.defineKey('debug-mcp', 'loadMcpInfo', loadMcpInfo);
window.KernelState.claim('debug-mcp', {
  get: (key) => bridged[key],
  set: (key, value) => { bridged[key] = value; },
});
