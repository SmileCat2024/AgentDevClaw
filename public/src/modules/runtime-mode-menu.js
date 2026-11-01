/**
 * 编程小助手「新建对话」入口的运行模式长按菜单。
 *
 * 交互契约（与 sidebar-layout 的长按手势同纪律）：
 * - 短按 = 既有创建路径，不携带 runtimeMode（服务端维持现状默认）。
 * - 长按 350ms 弹出锚定菜单（普通模式 / 容器模式）；移动超过 8px、
 *   pointercancel、失焦或 Esc 取消；长按触发后抑制按钮的合成 click，
 *   下一次真实按压立即解除抑制。
 * - 选中菜单项时把 runtimeMode 注入按钮自带的 data-workspace-action
 *   后走统一 runWorkspaceAction；创建语义与其余字段全部复用原动作。
 * - 菜单外点击 / Esc 关闭；菜单打开期间的第一次按压被吞掉（不点穿）。
 */
(function () {
  'use strict';

  const LONG_PRESS_MS = 350;
  const MOVE_CANCEL_PX = 8;
  const MENU_CLASS = 'ph-runtime-mode-menu';
  const ENTRY_SELECTOR = '[data-runtime-mode-entry]';

  let press = null;
  let menu = null;
  let suppressClickUntil = 0;

  function zh() { return window.currentLanguage === 'zh'; }

  function closeMenu() {
    if (menu) { menu.remove(); menu = null; }
    document.removeEventListener('pointerdown', onOutsideDown, true);
    document.removeEventListener('keydown', onMenuKeydown, true);
    window.removeEventListener('blur', cancelPress);
  }

  function positionMenu(button) {
    const rect = button.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    // 按钮下方右对齐；右侧/底部越界时回钳视口（fixed 定位，不依赖祖先链）。
    let left = rect.right - menuRect.width;
    if (left < 12) left = 12;
    if (left + menuRect.width > window.innerWidth - 12) left = Math.max(12, window.innerWidth - 12 - menuRect.width);
    let top = rect.bottom + 6;
    if (top + menuRect.height > window.innerHeight - 12) top = Math.max(12, rect.top - menuRect.height - 6);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  function openMenu(button) {
    closeMenu();
    const isZh = zh();
    menu = document.createElement('div');
    menu.className = MENU_CLASS;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', isZh ? '选择运行模式' : 'Choose runtime mode');
    const items = [
      {
        mode: 'standard',
        title: isZh ? '普通模式' : 'Standard',
        desc: isZh ? '直接在当前主机运行' : 'Run directly on this host',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
      },
      {
        mode: 'container',
        title: isZh ? '容器模式' : 'Container',
        desc: isZh ? '在隔离容器中运行；环境不可用时创建失败，不回退' : 'Run in an isolated container; fails without fallback if unavailable',
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
        + '<span class="ph-runtime-mode-item-title">' + window.escapeHtml(item.title) + '</span>'
        + '<span class="ph-runtime-mode-item-desc">' + window.escapeHtml(item.desc) + '</span>'
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
    document.body.appendChild(menu);
    positionMenu(button);
    document.addEventListener('pointerdown', onOutsideDown, true);
    document.addEventListener('keydown', onMenuKeydown, true);
    window.addEventListener('blur', cancelPress);
  }

  function onOutsideDown(event) {
    if (menu && event.target.closest && event.target.closest('.' + MENU_CLASS)) return;
    // 吞掉这次按压，避免关闭菜单的同时触发底层按钮。
    event.preventDefault();
    event.stopImmediatePropagation();
    closeMenu();
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
    if (!raw || typeof window.runWorkspaceAction !== 'function') return;
    let action;
    try { action = JSON.parse(raw); } catch { return; }
    action.runtimeMode = mode;
    window.runWorkspaceAction(JSON.stringify(action), button);
  }

  function cancelPress() {
    if (press) {
      clearTimeout(press.timer);
      press = null;
    }
  }

  document.addEventListener('pointerdown', (event) => {
    suppressClickUntil = 0;
    if (event.button !== 0 || event.isPrimary === false) return;
    const button = event.target.closest ? event.target.closest(ENTRY_SELECTOR) : null;
    if (!button || button.disabled) return;
    cancelPress();
    press = { button, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    press.timer = setTimeout(() => {
      if (!press) return;
      const heldButton = press.button;
      press = null;
      suppressClickUntil = Date.now() + 400;
      openMenu(heldButton);
    }, LONG_PRESS_MS);
  }, true);

  document.addEventListener('pointermove', (event) => {
    if (!press || press.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_CANCEL_PX) cancelPress();
  });

  document.addEventListener('pointerup', (event) => {
    if (press && press.pointerId === event.pointerId) cancelPress();
  });

  document.addEventListener('pointercancel', cancelPress);

  // 长按触发后抑制按钮的合成 click（capture 阶段拦截，下一次真实按压解除）。
  document.addEventListener('click', (event) => {
    if (Date.now() < suppressClickUntil
      && event.target.closest && event.target.closest(ENTRY_SELECTOR)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  // 长按期间（按压中或菜单打开）阻止入口按钮的系统右键/长按菜单与拖选。
  document.addEventListener('contextmenu', (event) => {
    if ((press || menu) && event.target.closest && event.target.closest(ENTRY_SELECTOR)) {
      event.preventDefault();
    }
  }, true);
})();
