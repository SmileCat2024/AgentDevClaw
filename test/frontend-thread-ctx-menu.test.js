// 侧栏 coder 线程条目右键菜单（ADR-0025 收尾）：线程语义菜单——与线程视图
// 行动作同源（中断 / 归档 / 删除 / 复制 Thread ID）。中断按 lifeState 置灰
// （无事可断时）；归档任何状态都可用——生产 lifecycle（thread-lifecycle.js）
// 归档即打断收纳（seal 取消 pending + 收敛接续挡板 + 停全链 runtime），
// thread_busy 拒绝只是 thread-routes.js 测试兜底 lifecycle 的行为，前端
// 不得据此置灰（历史 bug：接续中的线程无法归档）。
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

test('线程叶子：返回线程语义菜单，executing 时中断与归档都可用', () => {
  const ctx = loadModule({ threads: {
    'wt-1': { threadId: 'wt-1', agentId: 'coder', lifeState: 'executing', headViewerAgentId: 'viewer-1' },
  } });
  const items = ctx.run(`getCtxMenuItems('runtime', 'coder', 'child', 'rt-1', 'sess-1', 'wt-1')`);
  const byAction = Object.fromEntries(items.filter((i) => i.action).map((i) => [i.action, i]));
  assert.deepEqual(Object.keys(byAction).sort(), ['copy-thread-id', 'thread-archive', 'thread-delete', 'thread-interrupt']);
  assert.ok(!byAction['thread-interrupt'].disabled, 'executing：中断可用');
  assert.ok(!byAction['thread-archive'].disabled, 'executing：归档可用（归档即打断收纳，任何状态不得置灰）');
  assert.equal(byAction['thread-delete'].danger, true, '删除是危险区动作');
});

test('pending-commands（含接续中）线程：归档同样可用', () => {
  const ctx = loadModule({ threads: {
    'wt-3': { threadId: 'wt-3', agentId: 'coder', lifeState: 'pending-commands', status: 'rotating', headViewerAgentId: 'viewer-1' },
  } });
  const items = ctx.run(`getCtxMenuItems('runtime', 'coder', 'child', 'rt-1', 'sess-1', 'wt-3')`);
  const byAction = Object.fromEntries(items.filter((i) => i.action).map((i) => [i.action, i]));
  assert.ok(!byAction['thread-archive'].disabled, 'pending-commands / rotating：归档可用');
  assert.ok(!byAction['thread-interrupt'].disabled, 'pending-commands：中断可用');
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

// 手动接续 APP（ADR-0032，编程小助手）：线程化不替换会话操作菜单——
// 完整 Session 菜单保留，线程专属项（复制 Thread ID / 中断 / 归档线程）
// 追加；删除会话在 head 上即整线程删除（服务端重定向），不另设删除线程。
test('PH 线程会话：完整会话菜单保留 + 线程项追加，无重复删除项', () => {
  const ctx = loadModule({ threads: {
    'wt-ph': { threadId: 'wt-ph', agentId: 'programming-helper', lifeState: 'idle', headViewerAgentId: 'viewer-1' },
  } });
  const items = ctx.run(`getCtxMenuItems('runtime', 'programming-helper', 'child', 'rt-1', 'sess-ph', 'wt-ph')`);
  const collect = (list) => list.flatMap((i) => (i.submenu ? collect(i.submenu) : (i.action ? [i.action] : [])));
  const actions = collect(items);
  // 既有会话操作面（049 前 PH 菜单的全部动作，含 submenu 子项）逐一在场
  for (const action of ['rename', 'generate-title', 'summary', 'summary-and-archive', 'trim', 'trim-and-archive', 'branch', 'branch-and-archive', 'copy-session-id', 'todo-session', 'archive-and-stop', 'restart', 'stop', 'delete-session-runtime']) {
    assert.ok(actions.includes(action), `会话操作项必须保留：${action}`);
  }
  // 线程专属项追加
  for (const action of ['copy-thread-id', 'thread-interrupt', 'thread-archive']) {
    assert.ok(actions.includes(action), `线程项应追加：${action}`);
  }
  // 不重复设删除线程（删除会话在 head 上即整线程删除）
  assert.ok(!actions.includes('thread-delete'), '不得与删除会话重复设删除线程项');
  const byAction = Object.fromEntries(items.filter((i) => i.action).map((i) => [i.action, i]));
  assert.ok(byAction['thread-interrupt'].disabled, 'idle：中断置灰（无事可断）');
  assert.ok(!byAction['thread-archive'].disabled, '任何状态归档可用');
});

test('PH 线程会话 executing：中断线程可用', () => {
  const ctx = loadModule({ threads: {
    'wt-ph2': { threadId: 'wt-ph2', agentId: 'programming-helper', lifeState: 'executing', headViewerAgentId: 'viewer-1' },
  } });
  const items = ctx.run(`getCtxMenuItems('runtime', 'programming-helper', 'child', 'rt-1', 'sess-ph', 'wt-ph2')`);
  const byAction = Object.fromEntries(items.filter((i) => i.action).map((i) => [i.action, i]));
  assert.ok(!byAction['thread-interrupt'].disabled, 'executing：中断可用');
});

test('PH 无线程会话（存量未迁移）：菜单不含线程项（回归保护）', () => {
  const ctx = loadModule({ threads: {} });
  const items = ctx.run(`getCtxMenuItems('runtime', 'programming-helper', 'child', 'rt-1', 'sess-old', '')`);
  const actions = items.filter((i) => i.action).map((i) => i.action);
  for (const action of ['copy-thread-id', 'thread-interrupt', 'thread-archive', 'thread-delete']) {
    assert.ok(!actions.includes(action), `存量会话不应出现线程项：${action}`);
  }
  assert.ok(actions.includes('rename'), '存量会话操作面不变');
});
