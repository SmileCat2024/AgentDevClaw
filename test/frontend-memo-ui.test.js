import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * memo 三面板「取数不挂渲染」的沙箱测试（frontend-vm 先例同 desktop-notify）。
 * 验证决策 2 定稿语义：render 纯投影 + 冷启动幂等兜底（在途去重），
 * 常规刷新由导航事件（app-ui refreshVisibleWorkspacePanelData）与聚焦触发。
 */

/** 可控 fetch：请求计数，响应经 deferred 手动放行（不 sleep，全微任务/宏任务 flush）。 */
function createMemoSandbox(moduleFile) {
  const fetchCalls = [];
  const deferreds = [];
  const ctx = createFrontendSandbox({
    fetch: (...args) => {
      fetchCalls.push(args);
      let settle;
      const response = new Promise((resolve) => { settle = resolve; });
      deferreds.push({ settle, response });
      return response;
    },
    // markdown-utils 桩（notes 阅读态 repaint 用，行为不在本测试范围）
    splitMarkdownBlocks: (src) => String(src || '').split(/\n{2,}/).map((raw) => ({ raw })),
    isEditableMarkdownBlock: () => true,
    replaceMarkdownBlock: (src, i, next) => String(src).split(/\n{2,}/).map((b, k) => (k === i ? next : b)).join('\n\n'),
    renderMarkdown: (raw) => '<p>' + String(raw || '') + '</p>',
  });
  ctx.loadSource(`public/src/modules/${moduleFile}`);
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    ctx,
    fetchCalls,
    /** 放行最早一批未决响应（每次 fetch 调用一个 deferred）。 */
    respondNext: async (value) => {
      const d = deferreds.shift();
      assert.ok(d, 'respondNext called with no pending fetch');
      d.settle({ ok: true, json: () => Promise.resolve(value) });
      await flush();
      await flush();
    },
    flush,
  };
}

describe('memo-overview-ui fetch discipline', () => {
  const load = () => createMemoSandbox('memo-overview-ui.js');

  it('cold double render fetches once (in-flight dedup across two sources)', async () => {
    const { ctx, fetchCalls } = load();
    ctx.run('window.MemoOverviewUI.render()');
    ctx.run('window.MemoOverviewUI.render()'); // 主视图双渲染路径
    assert.equal(fetchCalls.length, 2, '两源各一次，双渲染不翻倍');
  });

  it('refresh while in-flight is dropped, not queued', async () => {
    const { ctx, fetchCalls } = load();
    ctx.run('window.MemoOverviewUI.render()');
    ctx.run('window.MemoOverviewUI.refresh()');
    assert.equal(fetchCalls.length, 2, '导航重取与渲染兜底并发只发一次');
  });

  it('warm render is pure projection; refresh revalidates', async () => {
    const { ctx, fetchCalls, respondNext } = load();
    ctx.run('window.MemoOverviewUI.render()');
    await respondNext({ reminders: [] });
    await respondNext({ notes: [] });
    assert.equal(fetchCalls.length, 2);
    fetchCalls.length = 0;
    ctx.run('window.MemoOverviewUI.render()');
    assert.equal(fetchCalls.length, 0, '缓存已就绪后 render 不发请求');
    ctx.run('window.MemoOverviewUI.refresh()');
    assert.equal(fetchCalls.length, 2, '导航刷新照常重取两源');
  });
});

describe('memo-reminders-ui fetch discipline', () => {
  const load = () => createMemoSandbox('memo-reminders-ui.js');

  it('cold double render fetches once', async () => {
    const { ctx, fetchCalls } = load();
    ctx.run('window.MemoRemindersUI.render()');
    ctx.run('window.MemoRemindersUI.render()');
    assert.equal(fetchCalls.length, 1, '双渲染不翻倍');
  });

  it('warm render fetches nothing; refresh revalidates once', async () => {
    const { ctx, fetchCalls, respondNext } = load();
    ctx.run('window.MemoRemindersUI.render()');
    await respondNext({ reminders: [] });
    fetchCalls.length = 0;
    ctx.run('window.MemoRemindersUI.render()');
    assert.equal(fetchCalls.length, 0, '缓存就绪后 render 纯投影');
    ctx.run('window.MemoRemindersUI.refresh()');
    assert.equal(fetchCalls.length, 1);
  });
});

describe('memo-notes-ui fetch discipline', () => {
  const load = () => createMemoSandbox('memo-notes-ui.js');

  it('cold double render (wall) fetches once', async () => {
    const { ctx, fetchCalls } = load();
    ctx.run('window.MemoNotesUI.render()');
    ctx.run('window.MemoNotesUI.render()');
    assert.equal(fetchCalls.length, 1, '双渲染不翻倍');
  });

  it('warm wall render fetches nothing', async () => {
    const { ctx, fetchCalls, respondNext } = load();
    ctx.run('window.MemoNotesUI.render()');
    await respondNext({ notes: [] });
    fetchCalls.length = 0;
    ctx.run('window.MemoNotesUI.render()');
    assert.equal(fetchCalls.length, 0, '缓存就绪后 render 纯投影');
  });

  it('reading state: render fetches nothing; refresh revalidates the open note', async () => {
    const { ctx, fetchCalls, respondNext } = load();
    ctx.run('window.MemoNotesUI.render()');
    await respondNext({ notes: [] });
    fetchCalls.length = 0;
    ctx.run(`window.MemoNotesUI.openNote(${JSON.stringify('todo.md')})`);
    assert.equal(fetchCalls.length, 1, 'openNote 交互回调取正文');
    await respondNext({ note: { filename: 'todo.md', title: 't', content: '# hi', updatedAt: 1 } });
    fetchCalls.length = 0;
    ctx.run('window.MemoNotesUI.render()');
    assert.equal(fetchCalls.length, 0, '阅读态 render 不发请求');
    ctx.run('window.MemoNotesUI.refresh()');
    assert.equal(fetchCalls.length, 1, '导航刷新重取当前篇');
    assert.match(String(fetchCalls[0][0]), /filename=/, '重取的是阅读中的便签');
  });
});
