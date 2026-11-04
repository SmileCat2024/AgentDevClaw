/**
 * memo 无分页栏首页的导航契约。
 *
 * 分页栏已移除：总览分节标题（memo-overview-entry）即子页面入口
 * （show_workspace_tab）；便签/提醒子页面顶栏带「← 总览」返回（show_home）。
 * tab 显隐机制不变（blocks visibility + currentWorkspaceTab），只是驱动源
 * 从分页栏换成入口标题与返回链接。
 *
 * 模块形态：public/src/plugins/memo/*.js 是 ES 模块插件，见
 * helpers/memo-plugin-loader.js。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMemoModule } from './helpers/memo-plugin-loader.js';

function decodeAction(encoded) {
  return JSON.parse(encoded.replace(/&quot;/g, '"'));
}

test('MemoOverviewUI.render: section titles are the navigation entries', async () => {
  const { api, cleanup } = await loadMemoModule('overview');
  try {
    const html = api.render();
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
  } finally { cleanup(); }
});

test('MemoOverviewUI.openNote: switches to the notes tab, then opens the reader', async () => {
  const calls = [];
  // 宿主动作：经注入的 workspace.runAction 记录（插件不直接摸窗口全局）
  const workspace = { runAction: (action) => calls.push(['action', action]) };
  const { api, cleanup } = await loadMemoModule('overview', { workspace });
  try {
    // 便签模块用同一 presenter 装载，让 overview 内部的跨模块调用落到真实实现上
    const notes = await import(new URL('../public/src/plugins/memo/notes.js', import.meta.url).href);
    notes.default.mount({
      getLanguage: () => 'zh',
      escapeHtml: (v) => String(v ?? ''),
      markdown: {
        renderMarkdown: (t) => String(t ?? ''),
        splitMarkdownBlocks: () => [],
        isEditableMarkdownBlock: () => false,
        replaceMarkdownBlock: (src) => src,
      },
      workspace,
    });
    // 观察点：openNote 会切到便签 tab，并把阅读目标交给便签模块
    api.openNote('plan.md');
    assert.equal(JSON.stringify(calls), JSON.stringify([
      ['action', { type: 'show_workspace_tab', tab: 'notes' }],
    ]), '先切到便签页');
    // openNote 内部会异步取正文；等它落定，避免测试结束后仍有未处理活动。
    await new Promise((resolve) => setImmediate(resolve));
  } finally { cleanup(); }
});

test('MemoNotesUI.render: subpage head carries a back-to-overview action', async () => {
  const { api, cleanup } = await loadMemoModule('notes');
  try {
    const html = api.render();
    assert.match(html, /workspace-section memo-notes-wall/);
    assert.match(html, /memo-subpage-head/);
    assert.match(html, /memo-subpage-title">便签/);
    assert.match(html, /← 总览</);
    const back = [...html.matchAll(/<button class="memo-back-link"[^>]*data-workspace-action="([^"]*)"/g)];
    assert.equal(back.length, 1);
    assert.deepEqual(decodeAction(back[0][1]), { type: 'show_home' });
  } finally { cleanup(); }
});

test('MemoRemindersUI.render: unbounded panel + subpage head with back action', async () => {
  const { api, cleanup } = await loadMemoModule('reminders');
  try {
    const html = api.render();
    // 无界：面板类保留（CSS 去壳），标题行换成子页面顶栏
    assert.match(html, /workspace-section memo-reminders-panel/);
    assert.match(html, /memo-subpage-head/);
    assert.match(html, /memo-subpage-title">提醒事项/);
    const back = [...html.matchAll(/<button class="memo-back-link"[^>]*data-workspace-action="([^"]*)"/g)];
    assert.equal(back.length, 1);
    assert.deepEqual(decodeAction(back[0][1]), { type: 'show_home' });
  } finally { cleanup(); }
});
