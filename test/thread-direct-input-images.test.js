import assert from 'node:assert/strict';
import test from 'node:test';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

// 线程直投路径（window.submitThreadInput）发送成功后，图片桶必须与 viewer
// 直投路径同语义清空（clearPendingInputImages），否则附件缩略图滞留输入框。
// 回归背景：PH 线程宿主会话图片发出后缩略图卡在输入框（2026-10-28）。
//
// ADR-0035 后普通发言只有 submitQueuedInput 一条入口，线程直投分支在其内部；
// 历史事故的另一份拷贝（input-helpers.js 的 slot 入口）已随 /input 文本编排
// 一并退役，本文件只锁定剩下的唯一入口。
//
// 装载路线（P2 测试迁移）：persistent-input.js 仍是 classic（同步首屏边界），
// 这里直接装载**整份真实源码**（test/helpers/p2-esm-case.js 的每用例隔离 case），
// 不再按标记切函数块——队列同步入口迁走后旧的结束标记已经不存在。图片就绪
// 解析也走真实 `_resolvePendingImagesForTarget`：上传/转存由用例的网络夹具驱动，
// 测试里不再有它的同形替身。

/**
 * 用例的浏览器面：只有 persistent 输入框是真实节点，其余 id 给稳定空元素
 * （动作按钮显式缺席——本文件不渲染发送按钮）。
 */
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
      if (id === 'persistent-action-btn') return null;
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

/** 捕获 console warn / error（沙箱里的 console 就是宿主 console 对象）。 */
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

/**
 * 一个用例 = 一份 window + 真实 persistent-input.js。
 *
 * 夹具语义（生产来源注释；本文件不测渲染副作用，按签名供桩）：
 * - `currentRuntimeAgentId`：编排 owner 的桥键，classic 提交链按会话归属读它；
 * - `SessionReference` / `ClawSlash` / `ClawToast`：产品协作面（引用 pill、
 *   slash 激活、错误提示）；
 * - `autoResize`（input-actions）/ `updateQueueIndicator`
 *   （p2-w2-3a-queue-projection）/ `_clearRecapForNewMessage`（recap-hint）/
 *   `clearInterruptSuppression`（runtime-status）/ `_markAgentCallStartedForNotify`
 *   （desktop-notify）/ `renderAgentList`（sidebar-render）等首屏后段能力：
 *   用例只关心图片桶与提交载荷，不驱动它们的界面副作用。
 *
 * `setFetch` 让用例体按场景替换网络面；默认拒答任何请求，避免意外联网。
 */
async function withPersistentInputCase(fn) {
  const textarea = { value: '看看这张图', dataset: { sessionKey: 'key-1' }, style: {}, scrollHeight: 40 };
  let attachmentKey = 'runtime-1::session-old';
  const submitCalls = [];
  let fetchImpl = async () => { throw new Error('unexpected fetch'); };
  const logs = captureConsoleLogs();
  try {
    const result = await withP2EsmCase({
      label: 'thread-direct-input-images',
      globals: {
        document: createDocumentStub({ 'input-persistent': textarea }),
        currentRuntimeAgentId: 'runtime-1',
        currentMessages: [],
        currentInputRequests: [],
        getActiveThreadInputTarget: () => ({ threadId: 'th-1' }),
        submitThreadInput: async (threadId, payload) => {
          submitCalls.push({ threadId, payload });
          return { ok: true, deliveryAttempt: { delivered: 1 } };
        },
        SessionReference: {
          activeKey: () => attachmentKey,
          peek: () => [],
          consume: () => [],
        },
        ClawSlash: { consumeActivations: () => [] },
        ClawToast: { show() {} },
        ClawFW: { actions: { registerMany() {} }, requestImmediatePoll() {} },
        _requestNotifyPermission() {},
        // 会话视图 token：真实判定（session-view-commit）按 token 字段比较——
        // 空身份 token 以 runtimeId 为准，与当前 runtime 一致即「视图仍归本会话」。
        captureSessionViewToken: () => ({ runtimeId: 'runtime-1', identity: null, switchEpoch: 0, generation: undefined }),
        _getSessionInputCacheKey: () => 'key-1',
        _sessionInputCache: {},
        autoResize() {},
        updateQueueIndicator() {},
        clearInterruptSuppression() {},
        _markAgentCallStartedForNotify() {},
        _agentCallActive: new Map(),
        // 输入面静态图的 classic 宿主工厂（生产由 app-core / app-main 提供）：
        // 本用例只跑提交与图片桶语义，不触达这些 seam。
        // 会话提交策略的宿主面（生产由 classic session-view-state 提供）：本基座
        // 不装 app-core 链，按策略实际读取的字段给形状（identity 空 = 无身份 token）。
        createSessionViewCommitHost: () => ({
          identity: () => null,
          read: () => ({}),
          apply: () => {},
          normalizeModel: () => ({}),
        }),
        createP2BootstrapCallActivityHost: () => ({ _agentCallActive: new Map() }),
        createP2BootstrapDomHost: () => ({}),
        createPollCoordinatorHost: () => ({}),
        _clearRecapForNewMessage() {},
        isRuntimeCalling: () => false,
        isInterruptSuppressed: () => false,
        renderAgentList() {},
        beginFollowLatestEntryWindow() {},
        requestFollowLatest() {},
        fetch: (...args) => fetchImpl(...args),
      },
      classic: (sandbox) => {
        sandbox.loadSource('public/src/modules/kernel-state.js');
        // 桥接期真初值（生产由 app-core 在 classic 相注册，ESM owner 认领时吸收）
        sandbox.KernelState.defineKey('i18n-environment', 'currentLanguage', 'zh');
        sandbox.KernelState.defineKey('orchestration', 'currentRuntimeAgentId', 'runtime-1');
        sandbox.KernelState.defineKey('orchestration', '_switchEpoch', 0);
      },
    }, async (c) => {
      // 焦点 runtime：生产由切换链写入 orchestration owner（本用例按真实 setter 设置）
      const orchestration = await c.load('public/src/modules/orchestration-state.js');
      orchestration.setCurrentRuntimeAgentId('runtime-1');
      // 会话视图快照（提交路径读 currentMessages 计乐观回显起点）
      const storage = await c.load('public/src/modules/session-view-storage.js');
      storage.setCurrentMessages([]);
      storage.setCurrentInputRequests([]);
      // 输入面实现（P4 输入面批次起是 ESM）：真实 import，桥键随模块注册。
      const persistent = await c.load('public/src/modules/persistent-input.js');
      // toast-notify 在模块求值期把自己挂上 window.ClawToast（夹具桩会被覆盖）：
      // 本用例只断言提交/图片语义，提示面按签名桩落位。
      c.window.ClawToast = { show() {}, update() {} };
      return fn({
        c,
        persistent,
        textarea,
        submitCalls,
        setFetch: (impl) => { fetchImpl = impl; },
        setAttachmentKey: (key) => { attachmentKey = key; },
      });
    });
    return { result, logs: logs.entries };
  } finally {
    logs.restore();
  }
}

test('unsent images move with the conversation when its thread advances to a successor', async () => {
  const { logs } = await withPersistentInputCase(async ({ c, persistent, setAttachmentKey }) => {
    // 待发送桶是模块私有状态（零跨文件生产消费方）：经模块的测试缝播种/观察。
    const seam = persistent.__testInputState;
    seam.imageBucket.push({ path: '/uploads/attach.png', mediaType: 'image/png', source: 'paste' });
    setAttachmentKey('runtime-2::session-new');

    // 公开入口：接续时由 thread-store 调用，只迁移同一条 Thread 的未发送附件。
    // 桥键形态不变（classic 消费方经 window 调用同一实现）。
    c.read('window.migratePendingInputImages("runtime-1::session-old", "runtime-2::session-new")');

    assert.equal(seam.imageBucket.length, 1, 'the successor composer must still show the unsent image');
    assert.equal(seam.imageBucket[0].source, 'paste', 'the original image entry is preserved');
    assert.equal(seam.pendingImageBuckets.has('runtime-1::session-old'), false,
      'the attachment is no longer stranded under the retired session identity');
  });

  assert.deepEqual(logs, [], `unexpected console output: ${describeLogs(logs)}`);
});

test('thread direct-delivery submit clears pending images on success', async () => {
  const { logs } = await withPersistentInputCase(async ({ persistent, textarea, submitCalls, setFetch }) => {
    // 已在本机宿主机上传完成的待发附件：目标宿主一致 → 真实就绪解析不再转存。
    setFetch(async () => { throw new Error('unexpected fetch'); });
    persistent.__testInputState.imageBucket.push({ path: '/uploads/attach.png', mediaType: 'image/png', source: 'paste', _hostKey: 'local' });

    await persistent.submitQueuedInput();

    assert.equal(submitCalls.length, 1, 'thread input should be submitted exactly once');
    assert.equal(submitCalls[0].threadId, 'th-1');
    assert.ok(Array.isArray(submitCalls[0].payload.images) && submitCalls[0].payload.images.length === 1,
      'image payload should reach the thread input submit call');
    assert.equal(submitCalls[0].payload.images[0].path, '/uploads/attach.png');
    assert.equal(submitCalls[0].payload.images[0].mediaType, 'image/png');
    assert.equal(persistent.__testInputState.imageBucket.length, 0,
      'pending image bucket must be cleared after successful thread submit');
    assert.equal(textarea.value, '', 'the sent draft is cleared with its attachments');
  });

  assert.deepEqual(logs, [], `unexpected console output: ${describeLogs(logs)}`);
});

test('failed thread image upload aborts the submit and keeps the attachments', async () => {
  // 线程直投的唯一入口失败语义：任一附件上传失败都必须显式中止，输入文本与
  // 图片桶原样保留供重试——绝不静默丢弃附件，也不把半张图发进线程。
  //
  // 场景：附件挂在远程宿主机（`remote:conn-1`），发送目标是本机会话，真实
  // 就绪解析必须转存；转存请求失败 → failedCount > 0 → 提交中止。
  const { logs } = await withPersistentInputCase(async ({ persistent, textarea, submitCalls, setFetch }) => {
    setFetch(async () => { throw new Error('upload unavailable'); });
    persistent.__testInputState.imageBucket.push({ path: '/uploads/attach.png', mediaType: 'image/png', source: 'paste', _hostKey: 'remote:conn-1' });

    await persistent.submitQueuedInput();

    assert.equal(submitCalls.length, 0, 'a failed attachment must abort the thread submit');
    assert.equal(persistent.__testInputState.imageBucket.length, 1, 'the pending image stays available for retry');
    assert.equal(textarea.value, '看看这张图', 'the typed draft is preserved');
  });

  // 两条日志都是真实实现的既定路径：转存失败 + 提交中止（不是用例注入的替身）。
  assert.deepEqual(logs.map((entry) => [entry.kind, String(entry.args[0])]), [
    ['error', '[Image Attach] upload for target failed:'],
    ['error', '排队输入提交失败:'],
  ], `unexpected console output: ${describeLogs(logs)}`);
  assert.equal(logs[0].args[1] instanceof Error, true);
  assert.equal(logs[0].args[1].message, 'upload unavailable');
  assert.equal(logs[1].args[1] instanceof Error, true);
  assert.match(logs[1].args[1].message, /部分图片上传失败/);
});
