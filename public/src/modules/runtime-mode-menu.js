/**
 * 编程小助手「新建对话」入口的运行模式悬停菜单。
 *
 * 交互契约：
 * - 悬停入口约 120ms 展开锚定菜单（普通模式 / 容器模式）；点击入口仍是
 *   既有创建路径，不携带 runtimeMode（服务端维持现状默认）。
 * - 鼠标离开「入口 + 菜单」联合区域约 250ms 后收起（容忍入口→菜单的
 *   移动间隙）；Esc 立即收起；菜单展开期间点击页面其他位置自然收起。
 * - 选中菜单项时把 runtimeMode 注入按钮自带的 data-workspace-action
 *   后走统一 runWorkspaceAction；创建语义与其余字段全部复用原动作。
 *
 * 语言判断说明：currentLanguage 是 app-core.js 顶层 let 声明（不挂
 * window），模块间以裸引用共享——经 window.currentLanguage 读会得到
 * undefined 导致永远英文（实测踩过）。
 */
(function () {
  'use strict';

  const OPEN_DELAY_MS = 120;
  const CLOSE_DELAY_MS = 250;
  const MENU_CLASS = 'ph-runtime-mode-menu';
  const ENTRY_SELECTOR = '[data-runtime-mode-entry]';

  let menu = null;          // 当前菜单元素
  let anchorButton = null;  // 菜单锚定的入口按钮
  let openTimer = 0;
  let closeTimer = 0;

  function isZh() { return typeof currentLanguage === 'undefined' || currentLanguage === 'zh'; }

  function clearTimers() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
  }

  function closeMenu() {
    clearTimers();
    if (menu) { menu.remove(); menu = null; }
    anchorButton = null;
    document.removeEventListener('keydown', onMenuKeydown, true);
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
        desc: zh ? '在隔离容器中运行；有本地会话运行时需先停止' : 'Run in an isolated container; stop local chats first',
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
  }

  function scheduleOpen(button) {
    clearTimeout(closeTimer);
    if (menu && anchorButton === button) return;
    clearTimeout(openTimer);
    openTimer = setTimeout(() => { openTimer = 0; openMenu(button); }, OPEN_DELAY_MS);
  }

  function scheduleClose() {
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
    if (!raw || typeof runWorkspaceAction !== 'function') return;
    let action;
    try { action = JSON.parse(raw); } catch { return; }
    action.runtimeMode = mode;
    runWorkspaceAction(JSON.stringify(action), button);
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
})();
