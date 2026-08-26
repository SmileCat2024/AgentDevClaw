import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

// thread-store.js 在模块加载时注册 2s 启动刷新 + 20s 周期刷新（未 unref），
// 若沿用 Node 全局定时器会让测试进程挂在事件循环上。注入 unref 版定时器，
// 使断言结束后进程可正常退出（后续 call 由桩 refreshThreads 短路）。
function unrefTimer(handle) { if (handle && typeof handle.unref === 'function') handle.unref(); return handle; }

function loadThreadStore({ refreshThreadsImpl = async () => null } = {}) {
  const ctx = createFrontendSandbox({
    currentLanguage: 'zh',
    getCurrentHostAgentRecord: () => null,
    setTimeout: (fn, ms) => unrefTimer(globalThis.setTimeout(fn, ms)),
    setInterval: (fn, ms) => unrefTimer(globalThis.setInterval(fn, ms)),
  });
  ctx.loadSource('public/src/modules/thread-store.js');
  // 模块在加载时自注册 window.refreshThreads / updateThreadHeaderIndicator；
  // 加载完成后用桩覆盖，隔离网络与 DOM 渲染（断言只针对状态机逻辑）。
  ctx.window.refreshThreads = refreshThreadsImpl;
  ctx.window.updateThreadHeaderIndicator = () => {};
  return ctx;
}

describe('T006 thread-store: Session→Thread 目标登记与只读事实', () => {
  it('历史成员 activate（browseOnly:true + target 为 thread）置位只读事实', () => {
    const ctx = loadThreadStore();
    ctx.run(`window.registerSessionActivateTarget({
      browseOnly: true,
      target: { type: 'thread', threadId: 'wt-9', headSessionId: 's-2' },
    })`);
    assert.equal(ctx.run(`window.ClawThreads.browseOnly`), true);
    assert.equal(ctx.run(`window.ClawThreads.browseOnlyThreadId`), 'wt-9');
  });

  it('打开/创建 head（browseOnly 缺失）清除历史残留只读事实', () => {
    const ctx = loadThreadStore();
    ctx.run(`window.ClawThreads.browseOnly = true; window.ClawThreads.browseOnlyThreadId = 'wt-9';`);
    ctx.run(`window.registerSessionActivateTarget({ target: { type: 'thread', threadId: 'wt-9', headSessionId: 's-3' } })`);
    assert.equal(ctx.run(`window.ClawThreads.browseOnly`), false);
    assert.equal(ctx.run(`window.ClawThreads.browseOnlyThreadId`), '');
  });

  it('Session 入口返回 Thread 时刷新 Thread（而非只刷 Session）', () => {
    let refreshes = 0;
    const ctx = loadThreadStore({ refreshThreadsImpl: async () => { refreshes += 1; return null; } });
    ctx.run(`window.registerSessionActivateTarget({ target: { type: 'thread', threadId: 'wt-1', headSessionId: 's-2' } })`);
    // refreshThreads 是异步触发；同步返回后此处已调用
    assert.equal(refreshes, 1);
  });

  it('非 Thread 的普通 Session activate 不触发线程刷新', () => {
    let refreshes = 0;
    const ctx = loadThreadStore({ refreshThreadsImpl: async () => { refreshes += 1; return null; } });
    ctx.run(`window.registerSessionActivateTarget({ session: { id: 's-1' } })`);
    assert.equal(refreshes, 0);
  });
});
