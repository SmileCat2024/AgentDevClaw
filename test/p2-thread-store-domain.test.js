/**
 * thread-store 交互域拆分契约（P2 · S2 形态：classic 引擎 + ESM 交互域）。
 *
 * 钉住三件事，都是「拆了但没有变成两套实现」的证据：
 *   1. 窄宿主 `createThreadStoreHost()` 暴露的是**唯一实时引用**——状态对象
 *      与 `window.ClawThreads` 同一身份，整对象被替换后仍然指向新对象；三个
 *      内部操作就是引擎里那几份函数本身（同引用比较）。
 *   2. 引擎不再留迁移期那批交互/查询函数的 window 值属性：只装 thread-store.js
 *      时它们必须缺席（否则就是双实现/残留）。
 *   3. 交互域声明式导出与桥键指向**同一函数对象**：classic 消费方经 window
 *      调用与 ESM 消费方 import 调用走同一个实现；状态写入也只落一份
 *      `ClawThreads`（无镜像、无 ready 队列）。
 *
 * 导出面已收敛到生产真实消费面（收尾批次）：`getActiveConversationTarget` /
 * `threadAdvanceHead` 复审确认全树零消费，已连同实现删除；导出面断言因此是
 * **精确集合**而不是"至少包含"。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareThreadClassicSandbox, withThreadCaseEnv } from './p2-thread-case.js';

const DOMAIN = 'public/src/modules/thread-store-domain.js';

const MOVED = [
  'getThreadPendingTexts',
  'enterThreadAwaitView',
  'openConversationTarget',
  'registerSessionActivateTarget',
  'submitThreadInput',
];
/** 迁移期随迁、收尾复审确认生产零消费而删除的两个导出（不得保留私有死代码）。 */
const RETIRED_MOVED = ['getActiveConversationTarget', 'threadAdvanceHead'];
const PRIVATE_MOVED = ['enterThreadAwaitSurface', '_loadAwaitSurfaceMessages'];

/** 只装 classic 引擎（不装交互域）的沙箱。 */
async function withEngineOnlyCase(fn) {
  return withThreadCaseEnv({
    label: 'p2-thread-store-domain:engine-only',
    classic: (sandbox) => {
      prepareThreadClassicSandbox(sandbox, {
        renderAgentList: () => {},
        renderCurrentMainView: () => {},
        updateQueueIndicator: () => {},
        updateThreadHeaderIndicator: () => {},
      });
    },
  }, async ({ c }) => fn(c));
}

test('引擎层不再持有交互域的 window 实现（无双实现、无残留别名）', async () => {
  await withEngineOnlyCase(async (c) => {
    for (const name of MOVED) {
      assert.equal(c.read(`typeof window.${name}`), 'undefined',
        `${name} 必须已离开 classic 引擎（否则与 ESM 交互域构成两套实现）`);
    }
    for (const name of PRIVATE_MOVED) {
      assert.equal(c.read(`typeof window.${name}`), 'undefined',
        `${name} 是交互域内部函数，不得在引擎里留下同名全局`);
    }
    // 引擎自身的公开面照旧（刷新、索引、指示器、宿主判定）——引擎迁 ESM 后经
    // thread-store-engine 桥键暴露同一份实现。
    for (const name of ['refreshThreads', 'getThreadById', 'getThreadForSession',
      'getActiveThreadInputTarget', 'isThreadHostAgentId', 'updateThreadHeaderIndicator']) {
      assert.equal(c.read(`typeof window.${name}`), 'function', `${name} 仍由引擎域提供（桥键）`);
    }
    // 接续换头跳转不是公开面：它只由顶栏指示器的 click 闭包内部调用，迁 ESM 后
    // 收敛为模块私有（不再有 window 键）。点击行为由 frontend-thread-badge-residency 覆盖。
    assert.equal(c.read('typeof window.jumpToThreadHead'), 'undefined',
      'jumpToThreadHead 是引擎内部入口，不得留在 window 面上');
  });
});

test('窄宿主：实时状态引用与引擎内部操作同引用（不复制、不镜像）', async () => {
  await withEngineOnlyCase(async (c) => {
    assert.equal(c.read('Object.isFrozen(window.createThreadStoreHost())'), true,
      '宿主契约对象不可被消费方改造');
    assert.equal(c.read('window.createThreadStoreHost().getState() === window.ClawThreads'), true,
      'getState() 必须返回唯一实时引用，而不是快照副本');

    // 整对象替换后仍然指向新对象（晚绑定，不是启动期缓存）
    c.sandbox.run('window.ClawThreads = { ...window.ClawThreads, threads: [{ threadId: "wt-x", agentId: "coder", sessionIds: [] }] };');
    assert.equal(c.read('window.createThreadStoreHost().getState() === window.ClawThreads'), true);
    assert.equal(c.read('window.createThreadStoreHost().getState().threads[0].threadId'), 'wt-x');

    // 内部操作与引擎函数同引用（引擎里是各自唯一那份实现）：引擎迁 ESM 后这些
    // 操作是命名导出，宿主成员必须与导出面同一引用（不是同形包装）。
    const engine = await c.load('public/src/modules/thread-store.js');
    const host = c.window.createThreadStoreHost();
    assert.equal(host.getCurrentActiveSession, engine._currentActiveSession,
      '宿主成员必须就是引擎里的那份实现');
    assert.equal(host.isHandoffActive, engine._handoffActive);
    assert.equal(host.syncActiveThreadSubscription, engine._syncActiveThreadSubscription);
    // 只暴露这四个成员：没有状态袋、没有内部状态副本、没有可写句柄
    // 跨 realm 数组不能直接 deepStrictEqual（原型不同），用字符串投影比较
    assert.equal(
      c.read('Object.keys(window.createThreadStoreHost()).join(",")'),
      'getState,getCurrentActiveSession,isHandoffActive,syncActiveThreadSubscription',
    );
  });
});

test('交互域导出与桥键是同一实现，状态写入只落唯一 ClawThreads', async () => {
  await withThreadCaseEnv({
    label: 'p2-thread-store-domain:domain',
    classic: (sandbox) => {
      prepareThreadClassicSandbox(sandbox, {
        getCurrentHostAgentRecord: () => ({ id: 'coder' }),
        renderAgentList: () => {},
        renderCurrentMainView: () => {},
        updateQueueIndicator: () => {},
        updateThreadHeaderIndicator: () => {},
      });
    },
  }, async ({ c }) => {
    const domain = await c.load(DOMAIN);

    // 命名导出面：交互入口 + 暂存文本查询（私有函数不导出，死导出不留）
    assert.deepEqual(Object.keys(domain).sort(), [...MOVED].sort(),
      '导出面必须精确等于生产消费面：无遗留导出、无私有死代码');
    for (const retired of RETIRED_MOVED) {
      assert.equal(domain[retired], undefined, `${retired} 已删除（生产零消费）`);
    }

    // 桥键 = 同一函数对象（classic 消费方与 ESM 消费方共用一份实现）
    for (const name of ['openConversationTarget', 'submitThreadInput']) {
      assert.equal(c.read(`typeof window.${name}`), 'function', `${name} 桥键服务 classic 消费方`);
      assert.equal(c.window[name], domain[name],
        `${name} 桥键必须指向交互域导出的同一个函数对象（不是包装器）`);
    }
    // 纯 ESM 消费项不保留 window 面：`getThreadPendingTexts` 的唯一消费方
    // （queue-projection）已改具名 import，classic 相零读者 → 桥键注销。
    assert.equal(c.read('typeof window.getThreadPendingTexts'), 'undefined',
      'getThreadPendingTexts 已注销桥键（不得留 window 访问器）');
    assert.equal(typeof domain.getThreadPendingTexts, 'function',
      '命名导出保留给 ESM 消费方');

    // 查询投影读的是唯一状态：经桥键写入 pendingTexts → 两个入口同时可见
    c.sandbox.run(`window.ClawThreads.threads = [{
      threadId: 'wt-p', agentId: 'coder', headSessionId: 'sess-p',
      sessionIds: ['sess-p'], pendingTexts: ['暂存一'],
    }];
    (function () {
      const s = window.ClawThreads;
      s.byId = { 'wt-p': s.threads[0] };
      s.sessionIndex = { 'coder::sess-p': s.threads[0] };
      s.activeConversation = { agentId: 'coder', threadId: 'wt-p', sessionId: 'sess-p', runtimeId: 'rt-p', wasHead: true };
    })();
    focusedAgentId = 'coder';
    currentRuntimeAgentId = 'rt-p';`);
    // 会话身份（P4 T1：identity 域 owner）：按生产 switchAgent 的入口播种绑定
    const identity = await c.load('public/src/modules/identity.js');
    identity.setViewerSessionBinding('rt-p', 'sess-p');

    // 跨 realm 数组用 JSON 投影比较（原型不同，deepStrictEqual 会判不等）
    assert.equal(JSON.stringify(domain.getThreadPendingTexts()), '["暂存一"]');
    // 桥键已注销后，读数只从 ESM 入口取（queue-projection 的具名 import 走这里）。
    assert.equal(c.read('typeof window.getThreadPendingTexts'), 'undefined');
    // 线程指向的公开事实就是状态本身（原先的 getActiveConversationTarget 已删除）：
    // 交互域与引擎读的是同一份 ClawThreads。
    assert.equal(c.read('window.createThreadStoreHost().getState().activeConversation.threadId'), 'wt-p');
    assert.equal(c.read('window.ClawThreads.activeConversation.threadId'), 'wt-p');
  });
});
