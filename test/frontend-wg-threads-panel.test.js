import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function loadPanel() {
  const ctx = createFrontendSandbox({
    WgState: { _runtimeStatusCache: {}, activeChatId: 'chat-1', activeChat: {} },
    wgEsc: (value) => String(value ?? '').replace(/[&<>"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    })[char]),
  });
  ctx.loadSource('public/src/modules/wg-threads-panel.js');
  return ctx;
}

describe('work-thread panel semantics', () => {
  it('classifies ended threads independently from Task progress', () => {
    const ctx = loadPanel();
    const state = ctx.run(`_derivedState({
      lifecycle: 'available', workStatus: 'completed', lineageHeadId: 's1',
      taskSummary: { total: 4, completed: 1, cancelled: 1 }
    })`);
    assert.equal(state.key, 'completed');
  });

  it('treats cancelled Tasks as resolved in the progress text', () => {
    const ctx = loadPanel();
    const progress = ctx.run(`_taskProgress({ total: 4, completed: 2, cancelled: 1, resolved: 3 })`);
    assert.equal(progress.short, '3/4 已处理');
    assert.ok(progress.detail.includes('1 取消'));
  });

  it('always formats a relative latest-message time', () => {
    const ctx = loadPanel();
    assert.equal(ctx.run(`_formatRelativeTime(Date.now() - 10_000)`), '刚刚');
    assert.equal(ctx.run(`_formatRelativeTime(Date.now() - 5 * 60_000)`), '5 分钟前');
    assert.equal(ctx.run(`_formatRelativeTime(Date.now() - 3 * 86_400_000)`), '3 天前');
  });

  it('labels current usage and compression threshold on the full context bar', () => {
    const ctx = loadPanel();
    const html = ctx.run(`_renderRuntimeRow({
      lineageHeadId: 's1', lifecycle: 'available', runtimeStatus: 'idle',
      contextUsage: { usedTokens: 130000, contextLength: 1000000, compressRatio: 18, percent: 13 }
    })`);
    assert.ok(html.includes('<strong>13%</strong><em>/</em>18%'));
    assert.ok(html.includes('width:13%'));
    assert.ok(html.includes('left:18%'));
    assert.ok(html.includes('压缩阈值 180K tokens'));
  });

  it('renders terminal Task time and cancellation result', () => {
    const ctx = loadPanel();
    const html = ctx.run(`_renderTask({
      status: 'deleted', subject: '废弃旧方案', finishedAt: Date.now() - 60_000
    })`);
    assert.ok(html.includes('已取消'));
    assert.ok(html.includes('1 分钟前'));
  });

  it('offers archive and unarchive as direct thread actions', () => {
    const ctx = loadPanel();
    const activeHtml = ctx.run(`_renderCardActions({
      threadRef: 'agent:main::root', lifecycle: 'available', canDispatch: true,
      identityRef: 'agent:main', workspaceId: 'agent', lineageHeadId: 'head', threadTitle: '测试线程'
    })`);
    const archivedHtml = ctx.run(`_renderCardActions({
      threadRef: 'agent:main::root', lifecycle: 'archived', canDispatch: false,
      identityRef: 'agent:main', workspaceId: 'agent', lineageHeadId: 'head', threadTitle: '测试线程'
    })`);
    assert.ok(activeHtml.includes('归档线程'));
    assert.ok(activeHtml.includes('Shift+Delete'));
    assert.ok(archivedHtml.includes('取消归档'));
  });

  it('uses one mutually exclusive detail slot for Tasks and lineage', () => {
    const ctx = loadPanel();
    const result = ctx.run(`(() => {
      const thread = {
        threadRef: 'agent:main::root', identityRef: 'agent:main',
        lineageHeadId: 'head', lifecycle: 'available', workStatus: 'completed'
      };
      _selectThreadInspector(thread, 'tasks');
      const afterTasks = {
        tasks: _threadsState.expandedTasks.has('head'),
        lineage: _threadsState.expandedThreads.has('agent:main::root'),
      };
      _selectThreadInspector(thread, 'lineage');
      return {
        afterTasks,
        afterLineage: {
          tasks: _threadsState.expandedTasks.has('head'),
          lineage: _threadsState.expandedThreads.has('agent:main::root'),
        },
      };
    })()`);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
      afterTasks: { tasks: true, lineage: false },
      afterLineage: { tasks: false, lineage: true },
    });
  });

  it('collapses the selected detail when its tab is clicked again', () => {
    const ctx = loadPanel();
    const result = ctx.run(`(() => {
      const thread = {
        threadRef: 'agent:main::root', identityRef: 'agent:main',
        lineageHeadId: 'head', lifecycle: 'available', workStatus: 'completed'
      };
      _selectThreadInspector(thread, 'tasks');
      _selectThreadInspector(thread, 'tasks');
      return {
        tasks: _threadsState.expandedTasks.has('head'),
        lineage: _threadsState.expandedThreads.has('agent:main::root'),
      };
    })()`);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { tasks: false, lineage: false });
  });
});
