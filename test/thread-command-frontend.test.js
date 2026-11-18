import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import {
  prepareThreadClassicSandbox,
  threadCaseOptions,
  withThreadDomainCase,
} from './p2-thread-case.js';
import { consumePendingClassicPrep } from './p2-classic-hosts.js';

/**
 * 线程寻址输入的前端契约（真实 ESM 交互域 + 真实 classic 提交链）：
 * - submitThreadInput 的字段透传：合法 metadata / 激活进入序列化 body，非法形态不产生字段
 * - submitQueuedInput 线程分支失败：已 consume 的会话引用与激活归还（P1 回归锁）
 *
 * 装载路线（P2 测试迁移）：`submitThreadInput` 已迁 thread-store-domain（ESM 具名
 * 导出），classic 沙箱的源码切片 + 剥 `export ` 前缀不再成立——两个用例都在
 * **每用例一份 window + 一张真实 ESM 图**的 case 里真实 import 交互域
 * （test/helpers/p2-esm-case.js 的唯一 query 语义）。第二个用例的提交链直接装载
 * 真实 `persistent-input.js`（不再按标记切函数块），`window.submitThreadInput`
 * 是交互域注册的桥键、指向同一 ESM 实现，所以失败/成功两条路径都是生产 seam。
 */

/**
 * 捕获 console warn / error（沙箱里的 console 就是宿主 console 对象）：
 * 用例必须显式断言日志面——断言绿但链路在报错，等于没测。
 * 恢复放在 finally，不把 console 补丁漏给下一个用例。
 */
function captureConsoleLogs() {
  const entries = [];
  const original = { warn: console.warn, error: console.error };
  console.warn = (...args) => entries.push({ kind: 'warn', args });
  console.error = (...args) => entries.push({ kind: 'error', args });
  return {
    entries,
    restore() {
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}

function describeLogs(entries) {
  return entries.map((entry) => `${entry.kind}: ${String(entry.args[0])}`).join(' | ');
}

describe('submitThreadInput field passthrough (real ESM thread domain)', () => {
  it('serializes valid metadata and activations into the input route body', async () => {
    const bodies = [];
    const logs = captureConsoleLogs();
    try {
      await withThreadDomainCase({
        label: 'thread-command:passthrough',
        fetch: async (url, init) => {
          if (String(url).includes('/input')) bodies.push(JSON.parse(init.body));
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true, threadId: 'th-1', commandId: 'cmd-1', deliveryAttempt: { delivered: 1 },
            }),
          };
        },
      }, async ({ domain }) => {
        const metadata = { 'session-reference': [{ agentId: 'programming-helper', sessionId: 'session-1' }] };
        const result = await domain.submitThreadInput('th-1', {
          text: '带引用',
          images: [{ path: '/uploads/a.png', mediaType: 'image/png' }],
          source: 'chat-composer',
          capabilityActivations: ['skill.grill-me'],
          metadata,
        });

        assert.deepEqual(result.deliveryAttempt, { delivered: 1 });
        assert.equal(bodies.length, 1);
        assert.equal(bodies[0].text, '带引用');
        assert.deepEqual(bodies[0].images, [{ path: '/uploads/a.png', mediaType: 'image/png' }],
          'images must reach the thread input route (the commands route does not accept them)');
        assert.deepEqual(bodies[0].capabilityActivations, ['skill.grill-me']);
        assert.deepEqual(bodies[0].metadata, metadata);
      });
    } finally {
      logs.restore();
    }
    assert.deepEqual(logs.entries.map((entry) => entry.kind), [], `unexpected console output: ${describeLogs(logs.entries)}`);
  });

  it('omits the metadata field for non-object shapes', async () => {
    const bodies = [];
    const logs = captureConsoleLogs();
    try {
      await withThreadDomainCase({
        label: 'thread-command:metadata-shape',
        fetch: async (url, init) => {
          if (String(url).includes('/input')) bodies.push(JSON.parse(init.body));
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, threadId: 'th-1', commandId: 'cmd-2' }),
          };
        },
      }, async ({ domain }) => {
        await domain.submitThreadInput('th-1', { text: '纯文本', metadata: ['not', 'an', 'object'] });

        assert.equal(bodies.length, 1);
        assert.equal('metadata' in bodies[0], false);
      });
    } finally {
      logs.restore();
    }
    assert.deepEqual(logs.entries.map((entry) => entry.kind), [], `unexpected console output: ${describeLogs(logs.entries)}`);
  });
});

describe('thread direct delivery restores consumed pills on failure (classic submit chain)', () => {
  function createDocumentStub(elements) {
    const element = () => ({
      style: {},
      dataset: {},
      children: [],
      className: '',
      innerHTML: '',
      value: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      appendChild() {},
      insertBefore() {},
      remove() {},
      addEventListener() {},
      removeEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      setAttribute() {},
      removeAttribute() {},
      closest() { return null; },
    });
    return {
      getElementById(id) {
        if (id === 'persistent-action-btn') return null; // 用例不渲染动作按钮
        return elements[id] ?? element();
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      createElement: element,
      createTextNode: (text) => ({ textContent: text }),
      addEventListener() {},
      removeEventListener() {},
      body: element(),
      documentElement: element(),
      activeElement: null,
      hidden: false,
      readyState: 'complete',
    };
  }

  /**
   * 一个用例 = 真实 classic 先行脚本序 + 真实 persistent-input.js + 真实 ESM 交互域。
   *
   * 夹具语义（与 p2-thread-case 的分工一致）：
   * - 宿主能力桩（`updateQueueIndicator` / `_clearRecapForNewMessage` / 跟随与
   *   `renderAgentList` 等）生产由首屏后段 classic 与已迁 ESM 桥提供，本用例不测
   *   渲染副作用，按签名供桩；
   * - 观测面（toast / 会话引用 / slash 激活）在整图装载后经 `expose` 接管：
   *   交互域的静态依赖会把这些 window 协作面换成生产模块，夹具必须最后落位，
   *   否则断言看到的是别的实现的副作用。
   */
  async function submitQueuedInputInRealCase({ submitRejects }) {
    const restoredRefs = [];
    const restoredActivations = [];
    const toasts = [];
    const textarea = {
      value: '继续', dataset: { sessionKey: 'sk-1' }, isConnected: true, style: {}, scrollHeight: 40,
    };
    const logs = captureConsoleLogs();
    try {
      await withP2EsmCase(threadCaseOptions({
        label: submitRejects ? 'thread-command:fail' : 'thread-command:success',
        globals: {
          document: createDocumentStub({ 'input-persistent': textarea }),
          ClawFW: { requestImmediatePoll() {} },
          _requestNotifyPermission() {},
          _sessionInputCache: {},
          _clearRecapForNewMessage() {},
          updateQueueIndicator() {},
          clearInterruptSuppression() {},
          _markAgentCallStartedForNotify() {},
          _agentCallActive: new Map(),
          beginFollowLatestEntryWindow() {},
          requestFollowLatest() {},
        },
        fetch: async (url) => {
          if (String(url).includes('/input') && submitRejects) {
            throw new Error('thread input unavailable');
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, deliveryAttempt: { delivered: 1 } }),
          };
        },
      }), async (c) => {
        prepareThreadClassicSandbox(c.sandbox, {
          getActiveThreadInputTarget: () => ({ threadId: 'wt-9' }),
          renderAgentList: () => {},
        });
        // 本用例在 async 体里装配 classic 相（不是 classic 回调），pending prep 不会
        // 被 withP2EsmCase 自动消费：这里显式消费一次——编排域（app-main）必须最先
        // 求值，否则后续 import 的宿主模块在求值期取不到 createXHost 工厂。
        await consumePendingClassicPrep();
        // BOOT_NEUTRALIZER 关掉了首屏 rAF；本用例要跑真实 _nextPaint 的 paint 门槛。
        c.sandbox.run('requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);');
        // 真实提交链：与生产同一份 persistent-input.js（P4 输入面批次起是 ESM）。
        const persistent = await c.load('public/src/modules/persistent-input.js');
        // 刷新引擎（P4 T3 起是 ESM）：交互域在**装载期**取它的窄宿主
        // createThreadStoreHost，必须先于 thread-store-domain 进入同一张图。
        await c.load('public/src/modules/thread-store.js');
        // 线程寻址目标与侧栏绘制是本用例的夹具面：引擎桥键在模块相注册，故覆盖
        // 放在引擎装载之后（classic 相的夹具会被同一访问器替换）。
        c.window.getActiveThreadInputTarget = () => ({ threadId: 'wt-9' });
        c.window.renderAgentList = () => {};
        const domain = await c.load('public/src/modules/thread-store-domain.js');
        assert.equal(typeof domain.submitThreadInput, 'function');
        assert.equal(c.read('typeof window.submitThreadInput'), 'function',
          '提交链经交互域桥键可解析到同一 ESM 实现');

        c.expose('ClawToast', { show: (value) => toasts.push(value) });
        c.expose('SessionReference', {
          peek: () => [{ agentId: 'programming-helper', sessionId: 'session-7', title: '引用' }],
          consume: () => [{ agentId: 'programming-helper', sessionId: 'session-7', title: '引用' }],
          restore: (refs) => restoredRefs.push(refs),
        });
        c.expose('ClawSlash', {
          consumeActivations: () => ['skill.grill-me'],
          restoreActivations: (refs) => restoredActivations.push(refs),
        });
        // 编排 owner：焦点 runtime 与切换代次（token 判定的两个输入）
        const orchestration = await c.load('public/src/modules/orchestration-state.js');
        orchestration.setCurrentRuntimeAgentId('rt-1');
        orchestration.setSwitchEpoch(0);
        // 会话视图 token 与判定都是真实实现（classic captureSessionViewToken +
        // ESM session-view-commit 策略）：焦点 runtime 已在上一段写入 owner，
        // 捕获到的是「视图仍归本会话」的真实 token，无需注入同形替身。
        // 立即轮询与线程刷新都是 fire-and-forget 副作用（轮询域 / 引擎异步链会活过
        // 本 case）：按「已受理」的空实现拦截，避免用例结束后的续体落到已拆掉的
        // 沙箱全局上。提交链本身（端点、载荷、引用归还）保持真实。
        c.window.ClawFW.requestImmediatePoll = () => {};
        c.window.refreshThreads = () => Promise.resolve();

        await persistent.submitQueuedInput();
      });
    } finally {
      logs.restore();
    }
    return { restoredRefs, restoredActivations, toasts, textarea, logs: logs.entries };
  }

  it('restores session references and activations when the thread delivery fails', async () => {
    const env = await submitQueuedInputInRealCase({ submitRejects: true });

    // 失败路径：引用与激活归还（P1 回归锁），输入保留
    assert.equal(env.restoredRefs.length, 1);
    assert.equal(env.restoredRefs[0].length, 1);
    assert.equal(env.restoredActivations.length, 1);
    assert.equal(env.textarea.value, '继续');
    assert.ok(env.toasts.some((t) => t.status === 'error'));

    // 失败来自真实 ESM submitThreadInput（不是注入的同形桩）：日志面必须正好一条。
    assert.equal(env.logs.length, 1, `unexpected console output: ${describeLogs(env.logs)}`);
    const [entry] = env.logs;
    assert.equal(entry.kind, 'error');
    assert.equal(String(entry.args[0]), '排队输入提交失败:');
    assert.equal(entry.args[1] instanceof Error, true);
    assert.equal(entry.args[1].message, 'thread input unavailable');
  });

  it('keeps references consumed (no restore) when the thread delivery succeeds', async () => {
    const env = await submitQueuedInputInRealCase({ submitRejects: false });

    assert.equal(env.restoredRefs.length, 0);
    assert.equal(env.restoredActivations.length, 0);
    assert.equal(env.textarea.value, '');
    assert.deepEqual(env.logs, [], `unexpected console output: ${describeLogs(env.logs)}`);
  });
});
