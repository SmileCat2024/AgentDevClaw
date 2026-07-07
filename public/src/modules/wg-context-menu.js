/**
 * wg-context-menu.js — 右键上下文菜单域
 *
 * 依赖：WgState, wgEsc (wg-core.js)
 */

'use strict';

function _showContextMenu(x, y, items) {
  _hideContextMenu();
  WgState._contextMenuEl = document.createElement('div');
  WgState._contextMenuEl.className = 'wg-context-menu';
  WgState._contextMenuEl.style.left = x + 'px';
  WgState._contextMenuEl.style.top = y + 'px';
  WgState._contextMenuEl.innerHTML = items.map((item, i) => {
    return [
      `<div class="wg-context-menu-item" data-wg-ctx-idx="${i}">`,
      `  <span class="wg-context-menu-label">${wgEsc(item.label)}</span>`,
      item.hint ? `  <span class="wg-context-menu-hint">${wgEsc(item.hint)}</span>` : '',
      '</div>',
    ].join('');
  }).join('');

  document.body.appendChild(WgState._contextMenuEl);

  // 定位调整：防止超出视口
  const rect = WgState._contextMenuEl.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    WgState._contextMenuEl.style.left = (window.innerWidth - rect.width - 4) + 'px';
  }
  if (rect.bottom > window.innerHeight) {
    WgState._contextMenuEl.style.top = (window.innerHeight - rect.height - 4) + 'px';
  }

  WgState._contextMenuEl.querySelectorAll('[data-wg-ctx-idx]').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.wgCtxIdx);
      items[idx].action();
      _hideContextMenu();
    });
  });

  // 点击外部关闭
  setTimeout(() => {
    document.addEventListener('click', _hideContextMenu, { once: true });
  }, 0);
}

function _hideContextMenu() {
  if (WgState._contextMenuEl) {
    WgState._contextMenuEl.remove();
    WgState._contextMenuEl = null;
  }
}
