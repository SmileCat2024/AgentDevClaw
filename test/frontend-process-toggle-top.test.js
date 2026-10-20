/**
 * 显示/隐藏过程切换的滚动锚定契约（lazy-tool-content.js +
 * input-helpers.js 真实代码路径）：
 *   - 顶部切换：锚定首条 user 行（系统行揭示后落在其上方）
 *   - 中途切换：保持当前阅读行相对位置
 *   - 锚定只移动 scrollTop，不吞行：滚回 0 时系统行可达
 *     （「显示过程后顶部看不到系统消息」类报告的对照基线——
 *     锚定行为本身不构成内容缺失）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function createView() {
  const rows = [];
  const listeners = new Map();
  const container = {
    scrollTop: 0, clientHeight: 600,
    querySelectorAll(selector) {
      if (selector === '.message-row') return rows;
      if (selector.includes('.message-row.system')) return rows.filter(row => row.role === 'system');
      return [];
    },
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
  };
  for (const role of ['system', 'system', 'user', 'assistant']) {
    const classes = new Set(['message-row', role]);
    const row = {
      role,
      classList: {
        contains: name => classes.has(name),
        add: name => classes.add(name),
        remove: name => classes.delete(name),
        toggle(name, force) {
          const enabled = force ?? !classes.has(name);
          if (enabled) classes.add(name); else classes.delete(name);
        },
      },
      get offsetHeight() { return classes.has('process-hidden') ? 0 : 200; },
      get offsetTop() {
        return rows.slice(0, rows.indexOf(row)).reduce((sum, item) => sum + item.offsetHeight, 0);
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    rows.push(row);
  }
  const ctx = createFrontendSandbox({
    container,
    showChatProcess: false,
    currentMessages: rows.map(row => ({ role: row.role, content: row.role })),
    followLatestEnabled: false,
    CHAT_PROCESS_VISIBILITY_KEY: 'test-process',
    chatProcessToggle: null,
    syncCollapseStates() {},
    syncRowCollapseState() {},
    isChatSurfaceActive: () => true,
    notifyChatViewportMutation() {},
  });
  ctx.loadSource('public/src/modules/lazy-tool-content.js');
  ctx.loadSource('public/src/modules/input-helpers.js');
  ctx.run('setProcessWindowingDisabled(true); applyConversationProcessState(container)');
  return { ctx, rows, container };
}

test('control: toggle anchor leaves existing system rows reachable by scrolling to zero', () => {
  const { ctx, rows, container } = createView();
  assert.equal(container.scrollTop, 0);
  assert.equal(rows[0].offsetHeight, 0);
  ctx.window.toggleChatProcessVisibility();
  assert.equal(rows[0].classList.contains('process-hidden'), false);
  assert.equal(container.scrollTop, rows[2].offsetTop, 'toggle preserves the user row anchor');
  container.scrollTop = 0;
  assert.equal(rows[0].offsetTop, 0);
  assert.equal(rows[0].offsetHeight, 200, 'anchoring alone cannot explain missing system messages at absolute top');
});

test('showing process away from the top preserves the reading anchor', () => {
  const { ctx, rows, container } = createView();
  container.scrollTop = 80;
  ctx.window.toggleChatProcessVisibility();
  assert.equal(container.scrollTop - rows[2].offsetTop, 80);
});
