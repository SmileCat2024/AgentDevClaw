/**
 * slash-menu.js — Slash 命令菜单（P0）
 *
 * 独立 UI 组件，与 user input 输入框解耦：
 * - 输入框只是触发源之一：内容以 / 开头时浮层出现（document 级 capture
 *   监听，只读 value，不修改 persistent-input.js 的任何行为；移除本模块
 *   系统照常工作）
 * - 键盘归属规则：菜单有可选项时 Enter/↑/↓/Tab/Esc 归菜单（capture 拦截，
 *   Enter = 执行 + 消费整条输入），空态或关闭时键盘归输入框 —— / 开头的
 *   文本此时作为普通消息正常发送，发送路径对 slash 零感知
 * - 命令执行是控制动作（调用 handler），绝不构造 user-turn 消息
 *
 * 命令条目结构：{ name, title?, description?, destination?: 'host'|'session', handler? }
 * （destination / 动态清单供 P1 使用；P0 仅 host 域 handler）
 *
 * 暴露：
 * - SlashMenu.isActive() — 菜单激活（可见且有可选项）
 * - SlashMenu.registerCommands(list) — 注册命令条目
 *
 * 依赖（全局，由 app-core.js / 既有模块提供）：
 * - t, escapeHtml, currentLanguage (app-core.js / i18n.js)
 * - autoResize (input-helpers.js)、_cacheSessionInput (voice-input.js)
 * - window.ClawToast (toast 组件)
 */

// ── 模块局部状态（app-core 全局状态纪律：状态放所属模块局部）──
let _commands = [];
let _filtered = [];
let _highlightIdx = 0;
let _visible = false;
let _menuEl = null;

// ── 浮层 DOM（懒创建，挂 body，不嵌入输入卡结构）────────────────

function _ensureMenuEl() {
  if (_menuEl) return _menuEl;
  _menuEl = document.createElement('div');
  _menuEl.className = 'slash-menu';
  _menuEl.style.display = 'none';
  _menuEl.setAttribute('role', 'listbox');
  document.body.appendChild(_menuEl);

  // mousedown + preventDefault 抢在 textarea blur 之前，点击项时焦点不丢
  _menuEl.addEventListener('mousedown', function (e) {
    const item = e.target.closest('.slash-menu-item');
    if (!item) return;
    e.preventDefault();
    const cmd = _filtered[parseInt(item.dataset.idx, 10)];
    void _execute(cmd, document.getElementById('input-persistent'));
  });
  return _menuEl;
}

function _render() {
  const menu = _ensureMenuEl();
  if (_filtered.length === 0) {
    menu.innerHTML = '<div class="slash-menu-empty">' + escapeHtml(t('slash_menu_empty')) + '</div>';
  } else {
    menu.innerHTML = _filtered.map(function (cmd, i) {
      const active = i === _highlightIdx ? ' is-active' : '';
      return '<div class="slash-menu-item' + active + '" data-idx="' + i + '" role="option">' +
        '<span class="slash-menu-item-name">/' + escapeHtml(cmd.name) + '</span>' +
        (cmd.description ? '<span class="slash-menu-item-desc">' + escapeHtml(cmd.description) + '</span>' : '') +
        '</div>';
    }).join('');
  }
  _position();
}

function _position() {
  const ta = document.getElementById('input-persistent');
  if (!ta) {
    _hide();
    return;
  }
  const rect = ta.getBoundingClientRect();
  _menuEl.style.left = Math.round(rect.left) + 'px';
  _menuEl.style.top = 'auto';
  _menuEl.style.bottom = Math.round(window.innerHeight - rect.top + 8) + 'px';
  _menuEl.style.minWidth = Math.min(380, Math.round(rect.width)) + 'px';
}

function _show() {
  _visible = true;
  const menu = _ensureMenuEl();
  menu.style.display = '';
  _render();
}

function _hide() {
  _visible = false;
  if (_menuEl) _menuEl.style.display = 'none';
}

// ── 过滤与执行 ────────────────────────────────────────────────

function _syncFromInput(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    if (_visible) _hide();
    return;
  }
  // 命令名 = 首个空白前的部分；/ 后直接空格视为浏览全部
  const query = value.slice(1).split(/\s+/)[0].toLowerCase();
  _filtered = _commands.filter(function (c) {
    return c.name.toLowerCase().startsWith(query);
  });
  _highlightIdx = 0;
  _show();
}

async function _execute(cmd, ta) {
  if (!cmd) return;
  // 消费语义：命令执行吃掉整条输入（含同步草稿缓存，防切换会话后复活）
  if (ta) {
    ta.value = '';
    autoResize(ta);
    _cacheSessionInput(ta);
  }
  _hide();
  try {
    if (typeof cmd.handler === 'function') await cmd.handler();
  } catch (e) {
    console.error('[SlashMenu] command failed:', cmd.name, e);
    window.ClawToast?.show?.({
      id: 'slash-command-failed',
      status: 'error',
      title: currentLanguage === 'zh' ? '命令执行失败' : 'Command failed',
      description: e instanceof Error ? e.message : String(e),
      autoDismiss: 6000,
    });
  }
}

function _completeCommand(ta) {
  const cmd = _filtered[_highlightIdx];
  if (!cmd || !ta) return;
  ta.value = '/' + cmd.name + ' ';
  autoResize(ta);
  _syncFromInput(ta.value);
}

// ── document 级 capture 监听（零侵入 persistent-input.js）────────

document.addEventListener('input', function (e) {
  if (!e.target || e.target.id !== 'input-persistent') return;
  _syncFromInput(e.target.value);
}, true);

document.addEventListener('keydown', function (e) {
  if (!_visible) return;
  if (!e.target || e.target.id !== 'input-persistent') return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    _hide();
    return;
  }
  // 空态时键盘归输入框：/ 开头文本回车即普通消息发送
  if (_filtered.length === 0) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();
    _highlightIdx = (_highlightIdx + 1) % _filtered.length;
    _render();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    _highlightIdx = (_highlightIdx - 1 + _filtered.length) % _filtered.length;
    _render();
  } else if (e.key === 'Tab') {
    e.preventDefault();
    e.stopPropagation();
    _completeCommand(e.target);
  } else if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    e.stopPropagation();
    void _execute(_filtered[_highlightIdx], e.target);
  }
}, true);

// 点击菜单外（非输入框）时关闭
document.addEventListener('mousedown', function (e) {
  if (!_visible) return;
  if (_menuEl && _menuEl.contains(e.target)) return;
  if (e.target && e.target.id === 'input-persistent') return;
  _hide();
}, true);

window.addEventListener('resize', function () {
  if (_visible) _position();
});

// ── window 导出 ────────────────────────────────────────────────

window.SlashMenu = {
  isActive: function () {
    return _visible && _filtered.length > 0;
  },
  registerCommands: function (list) {
    _commands = (Array.isArray(list) ? list : []).filter(function (c) {
      return c && typeof c.name === 'string' && c.name;
    });
    if (_visible) {
      const ta = document.getElementById('input-persistent');
      if (ta) _syncFromInput(ta.value);
      else _hide();
    }
  },
};
