/**
 * SessionView ownership tests for runtime notification and tool progress.
 *
 * 加载路线（P2 跨批测试迁移）：
 *   - classic 相：kernel-state（frontend-vm 自动装载）→ action-dispatcher →
 *     app-core → session-view-state → runtime-status → persistent-input，
 *     全部为真实 classic 源（它们仍是 classic 唯一实现）。
 *   - ESM 相：`c.load('…/tool-progress.js')` 真实 import；其静态依赖
 *     （session-view-storage / markdown-utils）在图内真实执行并 claim 自己的
 *     桥域，`currentMessages` 等状态由 ESM owner 持有，测试不再拼装全局副本。
 *   - runtime-status（classic）经 KernelState 桥键调用 tool-progress 的四个
 *     函数（调用时点晚绑定），与浏览器里的桥语义一致。
 *   - app-main 提供的少数函数（renderAgentList / isRuntimeCalling 等）在
 *     classic 相由沙箱 globals 提供——本测试不加载 app-main（顶层 DOM 依赖过重），
 *     与其原用例的注入面一致。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const TOOL_PROGRESS = 'public/src/modules/tool-progress.js';
const CALL_INTERRUPT_HOST = 'public/src/modules/call-interrupt-host.js';
const RECAP_STATE = 'public/src/modules/p2-w2-3a-recap-state.js';
const ORCHESTRATION_STATE = 'public/src/modules/orchestration-state.js';

/**
 * 通知状态元素桩：runtime-status 会写 style / className / textContent /
 * innerHTML，persistent-input 的 _renderLastCallElapsed 走
 * `_interactiveSurfaceOccupiesInput()` 读 surface.children.length。
 */
function createDocumentStub() {
  const elements = new Map();
  const makeElement = () => ({
    innerHTML: '',
    textContent: '',
    value: '',
    className: '',
    style: {},
    dataset: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    disabled: false,
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    insertBefore() {},
    remove() {},
    replaceWith() {},
    focus() {},
    blur() {},
    click() {},
    select() {},
    setSelectionRange() {},
    scrollIntoView() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; },
    closest() { return null; },
    matches() { return false; },
    contains() { return false; },
    insertAdjacentHTML() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getAttribute() { return null; },
    setAttribute() {},
    removeAttribute() {},
    hasAttribute() { return false; },
  });
  return {
    elements,
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
      },
      createElement: () => makeElement(),
      createTextNode: (text) => ({ textContent: text }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
      body: makeElement(),
      head: makeElement(),
      documentElement: makeElement(),
      readyState: 'complete',
    },
  };
}

/** app-main 提供的环境函数（本测试不加载 app-main，按既有注入面提供）。 */
const appMainGlobals = () => ({
  t: (key) => key,
  getCurrentHostAgentRecord: () => ({ id: 'agent-1' }),
  getEmptyOverviewSnapshot: () => ({}),
  getEmptyTodoPlan: () => ({}),
  notifyInputSurfaceChanged() {},
  getCurrentAgentRecord: () => ({ id: 'agent-1' }),
  getRuntimeRecord: () => null,
  getLogicalAgentId: (record) => record?.id,
  getActiveSessionId: (record) => record?.sessionId,
  normalizeAgentIdentity: (value) => String(value || '').trim(),
  isChatSurfaceActive: () => true,
  renderAgentList() {},
  _markAgentCallStartedForNotify() {},
  _syncPersistentActionButton() {},
  _syncPersistentInputUi() {},
  _syncQueueFromBackend() {},
  _tryNotifyAgentFinished() {},
  _maybeFetchRecap() {},
  ensureChatRuntimeIndicator() {},
  runWithSuppressedChatViewportObservers(fn) { fn(); },
});

/**
 * 用例级控制台噪音捕获：production 的 `host.warn` / `promise.catch` 会把失败降级
 * 成 warn 输出，测试若不看输出就可能带着 ReferenceError 变绿。case 内接管
 * console.warn / console.error，用例结束断言为空（本文件不允许任何输出）——不吞错。
 */
function captureConsoleNoise() {
  const entries = [];
  const original = { warn: console.warn, error: console.error };
  const record = (level) => (...args) => {
    entries.push(`${level}: ${args.map((value) => (value instanceof Error ? value.message : String(value))).join(' ')}`);
  };
  console.warn = record('warn');
  console.error = record('error');
  return {
    entries,
    restore() {
      console.warn = original.warn;
      console.error = original.error;
    },
    assertClean(label) {
      assert.deepEqual(entries, [], `${label} 不得出现 warn/error 输出：\n${entries.join('\n')}`);
    },
  };
}

/** 在「非预期 warn/error 必须为空」的守卫下跑一个 case（失败也要还原 console）。 */
async function withNoiseClean(label, fn) {
  const noise = captureConsoleNoise();
  try {
    const result = await fn();
    noise.assertClean(label);
    return result;
  } finally {
    noise.restore();
  }
}

/**
 * 建立一个「真实 SessionView + 真实 runtime-status + 真实 tool-progress」的
 * 用例上下文；每个用例独占一份 window 与一张 ESM 图（withP2EsmCase 语义）。
 */
async function withRuntimeState(fn) {
  const { document } = createDocumentStub();
  return withP2EsmCase({
    classic: (sandbox) => {
      // 真实生产加载顺序：分发器先于 persistent-input 顶层动作注册
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      sandbox.loadSource('public/src/app-core.js');
      sandbox.loadSource('public/src/modules/session-view-state.js');
      sandbox.loadSource('public/src/modules/runtime-status.js');
      // persistent-input 已迁 ESM（P4 输入面批次）：用例体里 c.load，胶囊计时器与
      // resetCallElapsedForSwitch 桥键随其模块相注册。
    },
    globals: {
      document,
      ...appMainGlobals(),
      // 输入面静态图（input-actions → poll-coordinator-host）装载期要求该 seam
      // 可解析；本父链不含 app-main（轮询宿主工厂的 owner），用例不驱动轮询。
      createPollCoordinatorHost: () => ({}),
    },
  }, async (c) => withNoiseClean('SessionView 运行时状态用例', async () => {
    // 焦点 runtime 的 ESM owner：生产由切换链写入，测试按真实 setter 设置
    const orchestration = await c.load(ORCHESTRATION_STATE);
    orchestration.setCurrentRuntimeAgentId('runtime-1');
    // 中断抑制策略的真实 ESM owner（classic runtime-status 经桥键调用）
    const callInterrupt = await c.load(CALL_INTERRUPT_HOST);
    // recap 的「等忙完再触发」状态 owner（runtime-status classic 经桥键读写）
    await c.load(RECAP_STATE);
    // 输入面实现（P4 输入面批次）：runtime-status 的 call.finish 归一链路经桥键
    // 调用 resetCallElapsedForSwitch / _renderLastCallElapsed。
    const persistentInput = await c.load('public/src/modules/persistent-input.js');
    const toolProgress = await c.load(TOOL_PROGRESS);
    assert.equal(typeof callInterrupt.getNotificationCallStartedAt, 'function');
    c.read(`applySessionViewPatch({ identity: { agentId: 'agent-1', sessionId: 'session-a' } })`);
    return fn({ c, toolProgress, persistentInput });
  }));
}

describe('SessionView runtime status ownership', () => {
  it('does not commit a notification captured for the previous session on the same runtime', async () => {
    await withRuntimeState(({ c, toolProgress }) => {
      // 进度台账是 tool-progress 的模块私有状态：经真实导出观察，不读全局副本
      assert.equal(typeof toolProgress.resolveToolProgressForCall, 'function');
      c.read('globalThis.token = captureSessionViewToken("runtime-1")');
      c.read(`applySessionViewPatch({ identity: { agentId: 'agent-1', sessionId: 'session-b' } })`);
      c.read(`updateNotificationStatus({ callActive: true, runtime: { callActive: true, stage: 'llm_thinking' }, state: { type: 'tool.progress', data: { callId: 'stale-call', toolName: 'bash' } } }, 'runtime-1', token)`);
      assert.equal(c.read('_agentCallActive.has("runtime-1")'), false);
      assert.equal(c.read('lastNotificationStatusPayload'), null);
      assert.equal(c.read('resolveToolProgressForCall({ id: "stale-call" })'), null);
      assert.equal(toolProgress.resolveToolProgressForCall({ id: 'stale-call' }), null);
    });
  });

  it('keeps tool progress bound to the SessionView where its notification was accepted', async () => {
    await withRuntimeState(({ c, toolProgress }) => {
      c.read(`updateNotificationStatus({ state: { type: 'tool.progress', data: { callId: 'call-a', toolName: 'bash', startedAt: Date.now(), outputTail: 'session a' } } })`);
      assert.equal(c.read('resolveToolProgressForCall({ id: "call-a" })?.outputTail'), 'session a');
      assert.equal(toolProgress.resolveToolProgressForCall({ id: 'call-a' })?.outputTail, 'session a');
      c.read(`applySessionViewPatch({ identity: { agentId: 'agent-1', sessionId: 'session-b' } })`);
      assert.equal(c.read('resolveToolProgressForCall({ id: "call-a" })'), null);
      c.read(`updateNotificationStatus({ state: { type: 'tool.progress', data: { callId: 'call-b', toolName: 'bash', startedAt: Date.now(), outputTail: 'session b' } } })`);
      assert.equal(c.read('resolveToolProgressForCall({ id: "call-a" })'), null);
      assert.equal(c.read('resolveToolProgressForCall({ id: "call-b" })?.outputTail'), 'session b');
    });
  });

  it('clears elapsed state at the switch boundary, before a new snapshot or timer tick', async () => {
    await withRuntimeState(({ c, persistentInput }) => {
      // 胶囊起始时间两键是 persistent-input 的模块私有状态（零跨文件生产消费方，
      // 不上桥）：经模块的显式测试缝读写，不依赖全局词法作用域。
      const seedCapsule = () => {
        c.read('_lastCallFinishTime = 1234');
        persistentInput.__testInputState.runCapsuleStartAt = 5678;
        persistentInput.__testInputState.runCapsuleStartConfirmed = true;
      };
      seedCapsule();
      c.read('resetRuntimeStatusForSwitch()');
      assert.equal(c.read('_lastCallFinishTime'), 0);
      assert.equal(persistentInput.__testInputState.runCapsuleStartAt, 0);
      assert.equal(persistentInput.__testInputState.runCapsuleStartConfirmed, false);
      seedCapsule();
      c.read('updateNotificationStatus(null)');
      assert.equal(c.read('_lastCallFinishTime'), 0);
      assert.equal(persistentInput.__testInputState.runCapsuleStartAt, 0);
      assert.equal(persistentInput.__testInputState.runCapsuleStartConfirmed, false);
    });
  });

  it('preserves call-finish suspension semantics and clears the matching tool progress', async () => {
    await withRuntimeState(({ c }) => {
      c.read(`updateNotificationStatus({ callActive: true, runtime: { callActive: true, stage: 'tool_executing' }, state: { type: 'tool.progress', data: { callId: 'call-a', toolName: 'bash' } } })`);
      c.read(`updateNotificationStatus({ callActive: false, runtime: { callActive: false, lastOutcome: { status: 'continued', reason: 'suspended' } }, state: { type: 'call.finish', data: { status: 'continued', reason: 'suspended' } } })`);
      assert.equal(c.read('_agentSuspended.get("runtime-1")'), true);
      assert.equal(c.read('resolveToolProgressForCall({ id: "call-a" })'), null);
      c.read('globalThis.sessionAfterFinish = readCurrentSessionViewState().identity.sessionId');
      assert.equal(c.read('sessionAfterFinish'), 'session-a');
    });
  });
});
