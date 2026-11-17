// 侧栏 coder 线程条目右键菜单（ADR-0025 收尾）：线程语义菜单——与线程视图
// 行动作同源（中断 / 归档 / 删除 / 复制 Thread ID）。中断按 lifeState 置灰
// （无事可断时）；归档任何状态都可用——生产 lifecycle（thread-lifecycle.js）
// 归档即打断收纳（seal 取消 pending + 收敛接续挡板 + 停全链 runtime），
// thread_busy 拒绝只是 thread-routes.js 测试兜底 lifecycle 的行为，前端
// 不得据此置灰（历史 bug：接续中的线程无法归档）。
//
// 装载路线（P2 真实 import）：ctx-menu-items 已迁 ESM（含 session-menu-decls
// 声明面与 session-mutation 等静态依赖）→ withP2EsmCase 每 case 一张真实图；
// classic 侧只跑真实壳层 bootstrap。线程事实经生产通道 window.getThreadById
// （classic thread-store 提供）注入。
import assert from 'node:assert/strict';
import test from 'node:test';
import { marked } from 'marked';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

/** 真实壳层 bootstrap（桥初值、宿主工厂与首屏同步面来源）。 */
const CLASSIC_STACK = [
  'public/src/modules/action-dispatcher.js',
  'public/src/modules/claw-host.js',
  'public/src/modules/right-panel-registry.js',
  'public/src/modules/markdown-bootstrap.js',
  'public/src/app-core.js',
  'public/src/modules/session-view-state.js',
  'public/src/modules/runtime-status.js',
  'public/src/modules/sidebar-render.js',
  'public/src/app-ui.js',
  'public/src/app-main.js',
];

/**
 * 一个用例 = 一份真实模块图。
 * @param {{ threads?: object, language?: string }} options
 */
async function withMenuCase({ threads = {}, language = 'zh' } = {}, fn) {
  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      sandbox.marked = marked;
      sandbox.currentLanguage = 'zh';
      sandbox.run(`
        window.__clawAuthReady = new Promise(() => {});
        applyLanguage = () => {};
        applyTheme = () => {};
      `);
      for (const file of CLASSIC_STACK) sandbox.loadSource(file);
      // 夹具镜像 metadata 声明（ADR-0049）：PH 声明 sessionOps（统一对话菜单）；
      // coder 不声明（线程语义菜单）。
      sandbox.allAgents = [{ id: 'programming-helper', sessionOps: true }];
      sandbox.getCurrentAgentRecord = () => null;
      sandbox.getWorkspaceSessionById = () => null;
      sandbox.isRemoteNamespaceAgentId = () => false;
      sandbox.getThreadById = (threadId) => threads[threadId] || null;
      sandbox.alert = () => {};
      sandbox.setTimeout = () => 0;
      sandbox.clearTimeout = () => {};
      sandbox.fetch = async () => ({ ok: false, status: 0, json: async () => ({}) });
    },
  }, async (c) => {
    // 远程连接域已迁 ESM（P4 T3）：真实 import 代替原 classic 标签位。
    await c.load('public/src/modules/remote-connections.js');
    const i18n = await c.load('public/src/modules/i18n-environment-state.js');
    await c.load('public/src/modules/agent-data-loader.js');
    const menu = await c.load('public/src/modules/ctx-menu-items.js');
    i18n.setCurrentLanguage(language);
    return fn({ menu, sandbox: c.sandbox });
  });
}

test('线程叶子：返回线程语义菜单，executing 时中断与归档都可用', async () => {
  await withMenuCase({ threads: {
    'wt-1': { threadId: 'wt-1', agentId: 'coder', lifeState: 'executing', headViewerAgentId: 'viewer-1' },
  } }, ({ menu }) => {
    const items = menu.getCtxMenuItems('runtime', 'coder', 'child', 'rt-1', 'sess-1', 'wt-1');
    const byAction = Object.fromEntries(items.filter((i) => i.action).map((i) => [i.action, i]));
    assert.deepEqual(Object.keys(byAction).sort(), ['copy-thread-id', 'thread-archive', 'thread-delete', 'thread-interrupt']);
    assert.ok(!byAction['thread-interrupt'].disabled, 'executing：中断可用');
    assert.ok(!byAction['thread-archive'].disabled, 'executing：归档可用（归档即打断收纳，任何状态不得置灰）');
    assert.equal(byAction['thread-delete'].danger, true, '删除是危险区动作');
  });
});

test('pending-commands（含接续中）线程：归档同样可用', async () => {
  await withMenuCase({ threads: {
    'wt-3': { threadId: 'wt-3', agentId: 'coder', lifeState: 'pending-commands', status: 'rotating', headViewerAgentId: 'viewer-1' },
  } }, ({ menu }) => {
    const items = menu.getCtxMenuItems('runtime', 'coder', 'child', 'rt-1', 'sess-1', 'wt-3');
    const byAction = Object.fromEntries(items.filter((i) => i.action).map((i) => [i.action, i]));
    assert.ok(!byAction['thread-archive'].disabled, 'pending-commands / rotating：归档可用');
    assert.ok(!byAction['thread-interrupt'].disabled, 'pending-commands：中断可用');
  });
});

test('idle 线程：归档可用、中断置灰（无事可断）', async () => {
  await withMenuCase({ threads: {
    'wt-2': { threadId: 'wt-2', agentId: 'coder', lifeState: 'idle', headViewerAgentId: 'viewer-1' },
  } }, ({ menu }) => {
    const items = menu.getCtxMenuItems('runtime', 'coder', 'child', 'rt-1', 'sess-1', 'wt-2');
    const byAction = Object.fromEntries(items.filter((i) => i.action).map((i) => [i.action, i]));
    assert.ok(byAction['thread-interrupt'].disabled, 'idle：中断置灰（无事可断）');
    assert.ok(!byAction['thread-archive'].disabled, 'idle：归档可用（正常关闭）');
  });
});

test('threadId 缺席或线程事实不可得：回退既有菜单体系（coder 未声明 sessionOps → 空表）', async () => {
  await withMenuCase({ threads: {} }, ({ menu }) => {
    assert.equal(menu.getCtxMenuItems('runtime', 'coder', 'child', 'rt-1', 'sess-1', '').length, 0);
    // threadId 有值但 ClawThreads 索引无此线程（数据未就绪）：不硬造菜单
    assert.equal(menu.getCtxMenuItems('runtime', 'coder', 'child', 'rt-1', 'sess-1', 'wt-unknown').length, 0);
  });
});

// 手动接续 APP（ADR-0032，编程小助手）：统一对话菜单——线程项不再作为
// 工程身份并列追加，而是语义合并进「对话」语言：归档走线程端点（归档即
// 整链收纳）、执行中呈现「停止」（thread-interrupt）、复制 ID 合并为单个
// copy-id、变换直达（无「并归档原会话」子项）。删除会话在 head 上即整
// 线程删除（服务端重定向），不另设删除线程。
test('PH 线程会话：统一菜单走线程语义，无重复删除项', async () => {
  await withMenuCase({ threads: {
    'wt-ph': { threadId: 'wt-ph', agentId: 'programming-helper', lifeState: 'idle', headViewerAgentId: 'viewer-1' },
  } }, ({ menu }) => {
    const items = menu.getCtxMenuItems('runtime', 'programming-helper', 'child', 'rt-1', 'sess-ph', 'wt-ph');
    const collect = (list) => list.flatMap((i) => [...(i.action ? [i.action] : []), ...(i.submenu ? collect(i.submenu) : [])]);
    const actions = collect(items);
    // 会话操作面保留（变换直达 + 复制 ID + 待办 + 运行组 + 删除）
    for (const action of ['rename', 'generate-title', 'summary', 'trim', 'branch', 'copy-id', 'todo-session', 'restart', 'stop', 'delete-session-runtime']) {
      assert.ok(actions.includes(action), `会话操作项必须保留：${action}`);
    }
    // 归档动作走线程端点（线程归档 = 归档整条对话）
    assert.ok(actions.includes('thread-archive'), '线程会话的归档必须走线程归档');
    assert.ok(!actions.includes('archive-and-stop'), '归档入口唯一，不得并列会话归档');
    // 归档子项是线程化前残留，不再出现
    for (const action of ['summary-and-archive', 'trim-and-archive', 'branch-and-archive']) {
      assert.ok(!actions.includes(action), `归档子项必须移除：${action}`);
    }
    // 工程身份项合并后不再出现
    for (const action of ['copy-session-id', 'copy-thread-id']) {
      assert.ok(!actions.includes(action), `复制 ID 已合并为 copy-id：${action}`);
    }
    // idle 线程无事可断：菜单不呈现「停止」（非置灰——没有对象就不是选项）
    assert.ok(!actions.includes('thread-interrupt'), 'idle：不呈现停止项');
    // 不重复设删除线程（删除会话在 head 上即整线程删除）
    assert.ok(!actions.includes('thread-delete'), '不得与删除会话重复设删除线程项');
  });
});

test('PH 线程会话 executing：呈现「停止」且可用', async () => {
  await withMenuCase({ threads: {
    'wt-ph2': { threadId: 'wt-ph2', agentId: 'programming-helper', lifeState: 'executing', headViewerAgentId: 'viewer-1' },
  } }, ({ menu }) => {
    const items = menu.getCtxMenuItems('runtime', 'programming-helper', 'child', 'rt-1', 'sess-ph', 'wt-ph2');
    const flattened = (function flatten(list) {
      return list.flatMap((i) => [...(i.action ? [i] : []), ...(i.submenu ? flatten(i.submenu) : [])]);
    })(items);
    const byAction = Object.fromEntries(flattened.map((i) => [i.action, i]));
    assert.ok(byAction['thread-interrupt'], 'executing：停止项必须在场');
    assert.ok(!byAction['thread-interrupt'].disabled, 'executing：停止可用');
    assert.equal(byAction['thread-interrupt'].label, '停止');
  });
});

test('PH 无线程会话（存量未迁移）：菜单不含线程项（回归保护）', async () => {
  await withMenuCase({ threads: {} }, ({ menu }) => {
    const items = menu.getCtxMenuItems('runtime', 'programming-helper', 'child', 'rt-1', 'sess-old', '');
    const actions = items.filter((i) => i.action).map((i) => i.action);
    for (const action of ['copy-thread-id', 'thread-interrupt', 'thread-archive', 'thread-delete']) {
      assert.ok(!actions.includes(action), `存量会话不应出现线程项：${action}`);
    }
    assert.ok(actions.includes('rename'), '存量会话操作面不变');
  });
});
