// 侧栏 coder 线程条目右键菜单（ADR-0025 收尾）：线程语义菜单恢复——
// 与线程视图行动作同源（中断 / 归档 / 删除 / 复制 Thread ID），生命周期
// 动作按 lifeState 置灰；非线程条目（threadId 缺席）不受影响。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const source = fs.readFileSync(new URL('../public/src/modules/ctx-menu-items.js', import.meta.url), 'utf8');

function loadModule({ threads = {}, language = 'zh' } = {}) {
  const ctx = createFrontendSandbox({
    currentLanguage: language,
    allAgents: [],
    getWorkspaceSessionById: () => null,
    isAssemblySession: () => false,
    isRemoteNamespaceAgentId: () => false,
  });
  ctx.window.getThreadById = (threadId) => threads[threadId] || null;
  ctx.run(source);
  return ctx;
}

test('线程叶子：返回线程语义菜单，executing 时中断可用、归档置灰', () => {
  const ctx = loadModule({ threads: {
    'wt-1': { threadId: 'wt-1', agentId: 'coder', lifeState: 'executing', headViewerAgentId: 'viewer-1' },
  } });
  const items = ctx.run(`getCtxMenuItems('runtime', 'coder', 'child', 'rt-1', 'sess-1', 'wt-1')`);
  const byAction = Object.fromEntries(items.filter((i) => i.action).map((i) => [i.action, i]));
  assert.deepEqual(Object.keys(byAction).sort(), ['copy-thread-id', 'thread-archive', 'thread-delete', 'thread-interrupt']);
  assert.ok(!byAction['thread-interrupt'].disabled, 'executing：中断可用');
  assert.ok(byAction['thread-archive'].disabled, 'executing：归档置灰（thread_busy）');
  assert.equal(byAction['thread-delete'].danger, true, '删除是危险区动作');
});

test('idle 线程：归档可用、中断置灰（无事可断）', () => {
  const ctx = loadModule({ threads: {
    'wt-2': { threadId: 'wt-2', agentId: 'coder', lifeState: 'idle', headViewerAgentId: 'viewer-1' },
  } });
  const items = ctx.run(`getCtxMenuItems('runtime', 'coder', 'child', 'rt-1', 'sess-1', 'wt-2')`);
  const byAction = Object.fromEntries(items.filter((i) => i.action).map((i) => [i.action, i]));
  assert.ok(byAction['thread-interrupt'].disabled, 'idle：中断置灰（无事可断）');
  assert.ok(!byAction['thread-archive'].disabled, 'idle：归档可用（正常关闭）');
});

test('threadId 缺席或线程事实不可得：回退既有菜单体系（coder 不在会话操作集 → 空表）', () => {
  const ctx = loadModule({ threads: {} });
  assert.equal(ctx.run(`getCtxMenuItems('runtime', 'coder', 'child', 'rt-1', 'sess-1', '')`).length, 0);
  // threadId 有值但 ClawThreads 索引无此线程（数据未就绪）：不硬造菜单
  assert.equal(ctx.run(`getCtxMenuItems('runtime', 'coder', 'child', 'rt-1', 'sess-1', 'wt-unknown')`).length, 0);
});
