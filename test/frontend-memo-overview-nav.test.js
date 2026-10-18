/**
 * Tests for the memo tabless home navigation (overview entries + subpage heads).
 *
 * 导航反转契约：分页栏已移除，总览分节标题（memo-overview-entry）即子页面
 * 入口（show_workspace_tab）；笔记/提醒子页面顶栏带「← 总览」返回
 * （show_home）。tab 显隐机制不变（blocks visibility + currentWorkspaceTab），
 * 只是驱动源从分页栏换成入口标题与返回链接。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function harness(overrides = {}) {
  const ctx = createFrontendSandbox({
    currentLanguage: 'zh',
    ...overrides,
  });
  ctx.loadSource('public/src/modules/memo-notes-ui.js');
  ctx.loadSource('public/src/modules/memo-reminders-ui.js');
  ctx.loadSource('public/src/modules/memo-overview-ui.js');
  return ctx;
}

function decodeAction(encoded) {
  return JSON.parse(encoded.replace(/&quot;/g, '"'));
}

test('MemoOverviewUI.render: section titles are the navigation entries', () => {
  const ctx = harness();
  const html = ctx.run('window.MemoOverviewUI.render()');
  assert.match(html, /workspace-section memo-overview-panel/);
  // 双栏契约：提醒与便签各占一栏（memo-overview-col），提醒在左
  assert.match(html, /memo-overview-cols/);
  assert.equal((html.match(/class="memo-overview-col"/g) || []).length, 2);
  assert.ok(html.indexOf('提醒事项') < html.indexOf('最近便签'));
  // 分节标题整行可点（memo-overview-entry），不再有「查看全部」并列链接
  const entries = [...html.matchAll(/<button class="memo-overview-entry"[^>]*data-workspace-action="([^"]*)"[^>]*>\s*<span class="memo-overview-entry-title">([^<]+)<\/span>/g)];
  assert.deepEqual(entries.map((m) => m[2]), ['提醒事项', '最近便签']);
  assert.deepEqual(entries.map((m) => decodeAction(m[1])), [
    { type: 'show_workspace_tab', tab: 'reminders' },
    { type: 'show_workspace_tab', tab: 'notes' },
  ]);
  assert.doesNotMatch(html, /memo-overview-link/);
  assert.equal((html.match(/chat-loading-spinner/g) || []).length, 2);
});

test('MemoOverviewUI.openNote: switches to the notes tab, then opens the reader', () => {
  const calls = [];
  const ctx = harness({ runWorkspaceAction: (action) => calls.push(['action', action]) });
  // stub 经宿主闭包挂到 windowStub（vm 内求值拿不到宿主作用域的 calls）
  ctx.window.MemoNotesUI = { openNote: (f) => calls.push(['open', f]) };
  ctx.run('window.MemoOverviewUI.openNote("plan.md")');
  // vm 跨 realm 对象不能 deepEqual（原型引用不等），按 JSON 结构比较
  assert.equal(JSON.stringify(calls), JSON.stringify([
    ['action', { type: 'show_workspace_tab', tab: 'notes' }],
    ['open', 'plan.md'],
  ]));
});

test('MemoNotesUI.render: subpage head carries a back-to-overview action', () => {
  const ctx = harness();
  const html = ctx.run('window.MemoNotesUI.render()');
  assert.match(html, /workspace-section memo-notes-wall/);
  assert.match(html, /memo-subpage-head/);
  assert.match(html, /memo-subpage-title">便签/);
  assert.match(html, /← 总览</);
  const back = [...html.matchAll(/<button class="memo-back-link"[^>]*data-workspace-action="([^"]*)"/g)];
  assert.equal(back.length, 1);
  assert.deepEqual(decodeAction(back[0][1]), { type: 'show_home' });
});

test('MemoRemindersUI.render: unbounded panel + subpage head with back action', () => {
  const ctx = harness();
  const html = ctx.run('window.MemoRemindersUI.render()');
  // 无界：面板类保留（CSS 去壳），标题行换成子页面顶栏
  assert.match(html, /workspace-section memo-reminders-panel/);
  assert.match(html, /memo-subpage-head/);
  assert.match(html, /memo-subpage-title">提醒事项/);
  const back = [...html.matchAll(/<button class="memo-back-link"[^>]*data-workspace-action="([^"]*)"/g)];
  assert.equal(back.length, 1);
  assert.deepEqual(decodeAction(back[0][1]), { type: 'show_home' });
});
