/**
 * 编程小助手「新建对话」入口的运行模式悬停菜单。
 *
 * 交互契约：
 * - 悬停入口约 220ms 展开锚定菜单（普通模式 / 容器模式）；点击入口仍是
 *   既有创建路径，不携带 runtimeMode（服务端维持现状默认）。
 * - 鼠标离开「入口 + 菜单」联合区域约 250ms 后收起（容忍入口→菜单的
 *   移动间隙）；Esc 立即收起；菜单展开期间点击页面其他位置自然收起。
 * - 选中菜单项时把 runtimeMode 注入按钮自带的 data-workspace-action
 *   后走统一 runWorkspaceAction；创建语义与其余字段全部复用原动作。
 *
 * 语言判断说明：currentLanguage 已由 i18n-environment-state 接管（P1），
 * 这里直接 import getCurrentLanguage()。不要改回 window.currentLanguage
 * 裸读——那是桥接面，消费方应走模块导出。
 *
 * 本模块无跨文件导出键：行为全部是 document/window 级委托监听，模块顶层
 * 执行时注册（ESM 首次执行时相 = 首个 import 它的模块执行时，仍早于
 * DOMContentLoaded 与一切 boot/交互入口）。
 */

import { escapeHtml } from './markdown-utils.js';
import { getCurrentLanguage } from './i18n-environment-state.js';

const OPEN_DELAY_MS = 220;
const CLOSE_DELAY_MS = 250;
const MENU_CLASS = 'ph-runtime-mode-menu';
const ENTRY_SELECTOR = '[data-runtime-mode-entry]';

let menu = null;          // 当前菜单元素
let anchorButton = null;  // 菜单锚定的入口按钮
let openTimer = 0;
let closeTimer = 0;

function onViewportChange() {
  if (menu && anchorButton) positionMenu(anchorButton);
}

function isZh() {
  const language = getCurrentLanguage();
  return language === undefined || language === 'zh';
}

function clearTimers() {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
}

function closeMenu() {
  clearTimers();
  if (menu) { menu.remove(); menu = null; }
  anchorButton = null;
  document.removeEventListener('keydown', onMenuKeydown, true);
  document.removeEventListener('scroll', onViewportChange, true);
  window.removeEventListener('resize', onViewportChange);
}

function positionMenu(button) {
  if (!menu || !button) return;
  const rect = button.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  // 菜单挂在 body 下，以文档坐标定位；滚动时重新测量锚点，
  // 让它像普通下拉框一样随滚动容器移动，而不是停在首次打开的位置。
  let left = rect.right - menuRect.width;
  if (left < 12) left = 12;
  if (left + menuRect.width > window.innerWidth - 12) left = Math.max(12, window.innerWidth - 12 - menuRect.width);
  let top = rect.bottom + 6;
  if (top + menuRect.height > window.innerHeight - 12) top = rect.top - menuRect.height - 6;
  if (top < 12) top = Math.min(12, window.innerHeight - menuRect.height - 12);
  menu.style.left = (left + window.scrollX) + 'px';
  menu.style.top = (top + window.scrollY) + 'px';
}

function openMenu(button) {
  closeMenu();
  anchorButton = button;
  const zh = isZh();
  menu = document.createElement('div');
  menu.className = MENU_CLASS;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', zh ? '选择运行模式' : 'Choose runtime mode');
  const items = [
    {
      mode: 'standard',
      title: zh ? '普通模式' : 'Standard',
      desc: zh ? '直接在当前主机运行' : 'Run directly on this host',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    },
    {
      mode: 'container',
      title: zh ? '容器模式' : 'Container',
      desc: zh ? '在隔离容器中运行' : 'Run in an isolated container',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8v8a2 2 0 0 1-1 1.73l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.73l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8z"/><path d="M3.3 7 12 12l8.7-5M12 22V12"/></svg>',
    },
  ];
  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'ph-runtime-mode-item';
    el.setAttribute('role', 'menuitem');
    el.tabIndex = 0;
    el.dataset.runtimeMode = item.mode;
    el.innerHTML = '<span class="ph-runtime-mode-item-icon">' + item.icon + '</span>'
      + '<span class="ph-runtime-mode-item-body">'
      + '<span class="ph-runtime-mode-item-title">' + escapeHtml(item.title) + '</span>'
      + '<span class="ph-runtime-mode-item-desc">' + escapeHtml(item.desc) + '</span>'
      + '</span>';
    el.addEventListener('click', () => choose(button, item.mode));
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        choose(button, item.mode);
      }
    });
    menu.appendChild(el);
  }
  // 菜单本体也参与联合 hover：进入取消收起，离开重新计时。
  menu.addEventListener('pointerenter', () => { clearTimeout(closeTimer); });
  menu.addEventListener('pointerleave', scheduleClose);
  document.body.appendChild(menu);
  positionMenu(button);
  document.addEventListener('keydown', onMenuKeydown, true);
  // 捕获所有滚动容器的 scroll：菜单在 body 下，必须主动重测锚点，
  // 否则主内容区滚动时浮窗会残留在原视口坐标。
  document.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);
}

function scheduleOpen(button) {
  clearTimeout(closeTimer);
  if (menu && anchorButton === button) return;
  clearTimeout(openTimer);
  openTimer = setTimeout(() => { openTimer = 0; openMenu(button); }, OPEN_DELAY_MS);
}

function scheduleClose() {
  // 鼠标快速划过入口时也要取消尚未触发的展开，避免离开后菜单仍闪现。
  clearTimeout(openTimer);
  openTimer = 0;
  if (!menu) return;
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => { closeTimer = 0; closeMenu(); }, CLOSE_DELAY_MS);
}

function onMenuKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu();
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const items = menu ? [...menu.querySelectorAll('.ph-runtime-mode-item')] : [];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown'
      ? items[(index + 1 + items.length) % items.length]
      : items[(index - 1 + items.length) % items.length];
    next.focus();
  }
}

function choose(button, mode) {
  closeMenu();
  const raw = button.dataset.workspaceAction;
  // 桥接期：runWorkspaceAction 定义于 workspace-actions.js（window 属性），
  // 编排/操作域收敛后改为 import。
  if (!raw || typeof window.runWorkspaceAction !== 'function') return;
  let action;
  try { action = JSON.parse(raw); } catch { return; }
  action.runtimeMode = mode;
  window.runWorkspaceAction(JSON.stringify(action), button);
}

// 悬停入口展开。delegation 在 document 上（入口按钮随会话列表重渲染）。
document.addEventListener('pointerover', (event) => {
  const button = event.target.closest ? event.target.closest(ENTRY_SELECTOR) : null;
  if (!button || button.disabled) return;
  scheduleOpen(button);
});
document.addEventListener('pointerout', (event) => {
  const button = event.target.closest ? event.target.closest(ENTRY_SELECTOR) : null;
  if (!button) return;
  // 离开的方向仍停在按钮内（子元素间移动）不触发收起计时。
  if (event.relatedTarget && event.relatedTarget.closest && event.relatedTarget.closest(ENTRY_SELECTOR) === button) return;
  scheduleClose();
});
// 点击页面其他位置（含其他控件）时自然收起，不吞事件。
document.addEventListener('pointerdown', (event) => {
  if (!menu) return;
  if (event.target.closest && event.target.closest('.' + MENU_CLASS)) return;
  closeMenu();
}, true);
window.addEventListener('blur', closeMenu);
