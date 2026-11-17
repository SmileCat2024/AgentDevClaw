/**
 * P2 第二波 3a「输入面状态所有者」——状态 owner 的兼容面与真实行为。
 *
 * 装载路线：test/helpers/p2-esm-case.js 的 `withP2EsmCase`（整图隔离真实
 * import + 真实 classic 沙箱）。classic 相按生产加载序跑真实文件（kernel-state →
 * classic 先行链），ESM 相跑本批 owner / 行为模块；两侧共享同一个 window，桥的
 * 两端语义因此是生产语义。
 *
 * P4 输入面批次之后（input-composer / persistent-input 迁 ESM），这些键的注册行
 * 随实现模块在**模块相**执行：模块 import 状态 owner（claim 在先），注册走
 * kernel-state 的「认领后补注册」路径，初值直接落进 owner 状态（无双存储）。
 * 用例因此改成：先 `c.load(persistent-input)` / `c.load(input-composer)`，再断言
 * owner 与 classic 裸标识符读写的是同一份状态。
 *
 * 钉住三件事：
 *   1. 模块相注册的初值落进 owner（不再有 classic 相哑存储中转）；
 *   2. 双向转发：owner 的活绑定/setter ↔ classic 裸标识符写读；
 *   3. 真实业务按新 owner 取值——草稿按会话隔离、语音保留判定、结束时间归零；
 *   4. 私有键不上桥（`_persistentUiSyncInFlight` 等零跨文件读者不挂在 window）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const LEAF_QUEUE = 'public/src/modules/p2-w2-3a-input-queue-state.js';
const LEAF_CALL_ELAPSED = 'public/src/modules/p2-w2-3a-call-elapsed-state.js';
const LEAF_VOICE = 'public/src/modules/p2-w2-3a-voice-state.js';
const LEAF_COMPOSER = 'public/src/modules/p2-w2-3a-composer-state.js';
const QUEUE_PROJECTION = 'public/src/modules/p2-w2-3a-queue-projection.js';
// 已迁 ESM 的语音实现（P4 L3）：classic 消费方的判定函数、录音状态桥键都由它提供。
const VOICE_INPUT = 'public/src/modules/voice-input.js';
// P4 输入面批次：两个实现模块（注册行随它们在模块相执行；import 关系为
// persistent-input ↔ input-composer 静态循环，只在函数体互相调用）。
const PERSISTENT_INPUT = 'public/src/modules/persistent-input.js';
const INPUT_COMPOSER = 'public/src/modules/input-composer.js';

function createElementStub(tag = '') {
  return {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    innerHTML: '',
    textContent: '',
    title: '',
    style: {},
    dataset: {},
    children: [],
    value: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(child) { this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
  };
}

// 图内 trim-page / session-dialogs（两批正在 ESM 化）在**装载期**按 id 取控件并注册
// 监听：生产由 index.html 的静态标记提供。本用例不渲染这两个界面，按同一批 id 预置
// 最小节点，避免「元素缺失」在装载期变成 TypeError。
const BOOTSTRAP_ELEMENT_IDS = [
  'agent-context-menu', 'agent-list', 'app-chat-input-slot', 'chat-container',
  'chat-process-toggle', 'compact-branch-action', 'compact-context-menu',
  'compact-summary-action', 'compact-trim-action', 'ctx-menu', 'current-agent-name',
  'delete-agent-action', 'delete-feature-action', 'delete-project-action',
  'external-agent-list', 'external-count', 'external-group', 'feature-panel',
  'feature-panel-body', 'feature-panel-collapse-hint', 'feature-panel-resizer',
  'feature-panel-title', 'feature-repo-context-menu', 'follow-latest-btn',
  'language-toggle', 'notification-metrics', 'notification-phase', 'notification-status',
  'notification-summary', 'persistent-action-btn', 'prebuilt-agent-list', 'prebuilt-count',
  'prebuilt-group', 'project-context-menu', 'project-docset-overlay', 'project-docset-sheet',
  'project-docset-toggle', 'restart-agent-action', 'settings-flyout-auth',
  'settings-flyout-config', 'settings-flyout-exit', 'settings-flyout-mcp-gateway',
  'settings-flyout-menu', 'settings-flyout-plugins', 'settings-flyout-proxy',
  'settings-flyout-remote', 'settings-flyout-remote-servers', 'settings-flyout-usage',
  'settings-flyout-workspace', 'settings-toggle', 'sidebar', 'sidebar-collapse-hint',
  'sidebar-resizer', 'sidebar-toggle', 'stop-agent-action', 'theme-toggle',
  'tool-agent-list', 'tool-count', 'tool-group', 'workspace-tabs-bar',
];

const LOAD_TIME_DOM_ELEMENT_IDS = [
  'trim-page', 'trim-page-title', 'trim-page-mode', 'trim-page-list', 'trim-page-readout',
  'trim-page-submit', 'trim-page-ratio-input', 'trim-page-ratio-slider', 'trim-page-ratio-config',
  'trim-page-manual-config', 'trim-page-archive-row', 'trim-page-archive-toggle',
  'trim-page-summary-toggle', 'trim-page-keep-skill-control', 'trim-page-keep-skill-toggle',
  'trim-page-keep-skill-value', 'trim-page-keep-skill-dec', 'trim-page-keep-skill-inc',
  'branch-dialog', 'branch-round-list', 'branch-submit', 'branch-footer-info',
];

function createDocumentStub() {
  const elements = new Map();
  for (const id of [...BOOTSTRAP_ELEMENT_IDS, ...LOAD_TIME_DOM_ELEMENT_IDS]) elements.set(id, createElementStub(id));
  return {
    elements,
    getElementById(id) { return elements.get(id) || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement: (tag) => createElementStub(tag),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {},
    removeEventListener() {},
    body: createElementStub('body'),
    documentElement: createElementStub('html'),
    activeElement: null,
    hidden: false,
    readyState: 'complete',
  };
}

/** classic 相装载（生产顺序）+ 最小宿主桩：只补这些 classic 函数的外部依赖。 */
function inputCaseOptions() {
  const documentStub = createDocumentStub();
  return {
    documentStub,
    options: {
      classic: (sandbox) => {
        // 真实先行脚本序（test/p2-classic-hosts.js）：宿主工厂都是生产实现，首屏
        // boot 与周期排程由基座关掉。基座之外补输入面与 classic 刷新引擎（真实实现）。
        prepareClassicSandbox(sandbox);
        // 刷新引擎（thread-store）同样是 ESM：交互域在装载期取它的窄宿主
        // createThreadStoreHost，用例体里先于 thread-store-domain 装入同一张图。
        // input-composer / persistent-input 已迁 ESM（P4 输入面批次）：用例体里经
        // c.load 装载，classic 相不再载入。
        // 窄行为观察面（真源之后覆盖）：本用例只验证排队投影状态 owner 的 claim /
        // 双向转发语义，不驱动输入面 DOM 与轮询/侧栏渲染。
        sandbox.autoResize = () => {};
        sandbox.isRuntimeCalling = () => false;
        sandbox.notifyInputSurfaceChanged = () => {};
        sandbox.runPollCycle = async () => {};
        sandbox.renderAgentList = () => {};
        sandbox.renderCurrentMainView = () => {};
        sandbox.captureSessionViewToken = (runtimeId) => ({
          runtimeId,
          identity: null,
          switchEpoch: 0,
          generation: undefined,
        });
      },
      globals: {
        document: documentStub,
        // action-dispatcher 的公开面（生产由 public/src/modules/action-dispatcher.js 提供）：
        // 图内 ESM 模块在装载期注册动作并绑定事件类型。
        ClawFW: { actions: { registerMany() {}, register() {}, bindEventType() {} } },
      },
    },
  };
}

test('排队投影状态：模块相注册初值落入 owner → 双向转发', async () => {
  const { options } = inputCaseOptions();
  await withP2EsmCase(options, async (c) => {
    // 注册行随实现模块在模块相执行（import owner 使 claim 在先，走认领后补注册）
    await c.load(PERSISTENT_INPUT);

    // classic 裸标识符读到的就是 owner 的初值
    assert.equal(c.read('typeof _pendingQueuedCount'), 'number');
    assert.equal(c.read('_pendingQueuedCount'), 0);
    assert.deepEqual(JSON.parse(c.read('JSON.stringify(_queuedTexts)')), []);
    assert.equal(c.read('_localQueuedInputPending'), false);
    assert.equal(c.read('_queuedProjectionRuntimeId'), null);

    // classic 写 → owner 状态（同一份，不经哑存储中转）
    c.read('_queuedTexts = ["first"]; _pendingQueuedCount = 1; _localQueuedInputPending = true;');

    const queueState = await c.load(LEAF_QUEUE);
    assert.deepEqual(JSON.parse(JSON.stringify(queueState.queuedTexts)), ['first'], 'classic 写入落在 owner 活绑定上');
    assert.equal(queueState.pendingQueuedCount, 1);
    assert.equal(queueState.localQueuedInputPending, true);

    // owner → classic 裸读（活绑定）
    queueState.setQueuedTexts(['second', 'third']);
    queueState.setPendingQueuedCount(2);
    assert.equal(c.read('_queuedTexts.join("|")'), 'second|third');
    assert.equal(c.read('_pendingQueuedCount'), 2);

    // classic 裸写 → owner 活绑定
    c.read('_localQueuedInputPending = false; _queuedProjectionRuntimeId = "rt-a";');
    assert.equal(queueState.localQueuedInputPending, false);
    assert.equal(queueState.queuedProjectionRuntimeId, 'rt-a');

    // 与顶层 let 一致的属性语义：不可枚举、可配置（终局撤桥需要）
    assert.equal(c.read('Object.prototype.propertyIsEnumerable.call(window, "_queuedTexts")'), false);
    assert.equal(c.read('Object.getOwnPropertyDescriptor(window, "_queuedTexts").configurable'), true);

    // 语义 clear：只清投影内容，不动归属身份
    queueState.clearQueuedInputProjection();
    assert.equal(c.read('_pendingQueuedCount'), 0);
    assert.equal(c.read('_queuedTexts.length'), 0);
    assert.equal(c.read('_localQueuedInputPending'), false);
    assert.equal(c.read('_lastQueueBubbleSignature'), '');
    assert.equal(queueState.queuedProjectionRuntimeId, 'rt-a', 'clear 不得改动投影归属');
  });
});

test('草稿缓存：按会话隔离读写 + 语义 clear（真实 composer 函数经 owner 取值）', async () => {
  const { options } = inputCaseOptions();
  await withP2EsmCase(options, async (c) => {
    const composer = await c.load(INPUT_COMPOSER);
    await c.load(PERSISTENT_INPUT);

    // 真实实现写草稿（textarea 形状取自真实调用点；经桥键调用 = classic 消费语义）
    c.read('_cacheSessionInput({ value: "draft-a", dataset: { sessionKey: "s:a" } })');
    c.read('_cacheSessionInput({ value: "draft-b", dataset: { sessionKey: "s:b" } })');

    const composerState = await c.load(LEAF_COMPOSER);
    assert.equal(composerState.sessionInputCache['s:a'], 'draft-a', '两个方向的读写落在同一份缓存上');
    assert.equal(composerState.sessionInputCache['s:b'], 'draft-b');

    // owner 侧写入 → 恢复路径读到同一份草稿
    composerState.sessionInputCache['s:c'] = 'draft-c';
    const taC = { value: '', dataset: { sessionKey: 's:c' }, style: {}, scrollHeight: 0 };
    assert.equal(composer._restoreSessionInputDraft(taC), true);
    assert.equal(taC.value, 'draft-c', 'restore 返回布尔，值落在 textarea 上');

    // 发送成功后的语义 clear 只影响该会话：其他会话草稿不受影响
    assert.equal(composerState.clearSessionInputDraft('s:a'), true);
    assert.equal(composer._restoreSessionInputDraft({ value: 'keep', dataset: { sessionKey: 's:a' }, style: {} }), false,
      '已清空的会话不再恢复草稿');
    assert.equal(composer._restoreSessionInputDraft({ value: 'keep', dataset: { sessionKey: 's:b' }, style: {} }), true);
    assert.equal(composerState.clearSessionInputDraft(''), false, '空键是 no-op');
    assert.equal(composerState.clearSessionInputDraft('s:missing'), false);
  });
});

test('语音状态：_shouldPreserveVoiceInputForRender 按 owner 状态 + 会话键判定', async () => {
  const { options } = inputCaseOptions();
  await withP2EsmCase(options, async (c) => {
    const voiceInput = await c.load(VOICE_INPUT);
    // _voiceCacheKey 仍是 voice-input 的模块私有键（零跨文件生产消费面），
    // ESM 用例经模块的显式写入口置位（原 classic 用例按全局词法作用域直写）。
    voiceInput.__testVoiceState.cacheKey = 'session-k1';
    // 生产路径：classic 的 input-render 经 window 访问器调用判定函数（桥键）。
    c.expose('_shouldPreserveVoiceInputForRender', voiceInput._shouldPreserveVoiceInputForRender);

    const voiceState = await c.load(LEAF_VOICE);
    assert.equal(voiceState.voiceRecording, false);

    // owner 置录音态 → classic 判定在交互面 + 同会话时保留录音
    voiceState.setVoiceRecording(true);
    assert.equal(c.read('_shouldPreserveVoiceInputForRender("persistent", "session-k1")'), true);
    assert.equal(c.read('_shouldPreserveVoiceInputForRender("choice", "session-k1")'), true);
    assert.equal(c.read('_shouldPreserveVoiceInputForRender("compacting", "session-k1")'), true);
    assert.equal(c.read('_shouldPreserveVoiceInputForRender("persistent", "session-k2")'), false,
      '会话已切换时不得保留录音');
    assert.equal(c.read('_shouldPreserveVoiceInputForRender("hidden", "session-k1")'), false,
      '离开输入面时不得保留录音');

    // 转写中同样算「本会话的语音操作」
    voiceState.setVoiceRecording(false);
    voiceState.setVoiceTranscribing(true);
    assert.equal(c.read('_shouldPreserveVoiceInputForRender("persistent", "session-k1")'), true);

    // classic 裸写 → owner（持久输入面把 _voicePendingSend 置位的真实路径）
    c.read('_voicePendingSend = true;');
    assert.equal(voiceState.voicePendingSend, true);

    // 零跨文件消费方的语音内部件不上桥：仍是 voice-input 的模块私有词法绑定，
    // 没有 window 属性（work-group 的 WgState 是同名自建状态，不是消费方）
    assert.equal(c.read('Object.prototype.hasOwnProperty.call(window, "_voiceMediaRecorder")'), false);
    assert.equal(c.read('Object.prototype.hasOwnProperty.call(window, "_voiceAudioChunks")'), false);
    assert.equal(c.read('Object.prototype.hasOwnProperty.call(window, "_voiceCancelled")'), false);
  });
});

test('结束时间状态：1s tick 读点与 resetCallElapsedForSwitch 经 owner 生效', async () => {
  const { options } = inputCaseOptions();
  await withP2EsmCase(options, async (c) => {
    // 注册行随实现模块在模块相执行；1s tick 起点同相
    await c.load(PERSISTENT_INPUT);
    assert.equal(c.read('_lastCallFinishTime'), 0);
    c.read('_lastCallFinishTime = 1700000000000;');

    const elapsedState = await c.load(LEAF_CALL_ELAPSED);
    assert.equal(elapsedState.lastCallFinishTime, 1700000000000);

    // runtime-status（classic）在 call.finish 帧的写入形状
    c.read('_lastCallFinishTime = 1700000001234;');
    assert.equal(elapsedState.lastCallFinishTime, 1700000001234);

    // 真实 classic reset（会话切换）经桥归零 owner
    c.read('resetCallElapsedForSwitch()');
    assert.equal(elapsedState.lastCallFinishTime, 0);
    assert.equal(c.read('_lastCallFinishTime'), 0);

    // 下一批（W2-2）直接 import 的 setter 接口
    elapsedState.setLastCallFinishTime(42);
    assert.equal(c.read('_lastCallFinishTime'), 42);
  });
});

test('队列同步的过期拒绝：写入路径只接受当前 runtime 的快照', async () => {
  const { options } = inputCaseOptions();
  await withP2EsmCase(options, async (c) => {
    const orchestration = await c.load('public/src/modules/orchestration-state.js');
    await c.load('public/src/modules/thread-store.js'); // 交互域的窄宿主来源
    await c.load(PERSISTENT_INPUT); // rebindQueueProjectionForRuntime 桥键（投影写入路径调用）
    const queueState = await c.load(LEAF_QUEUE);
    const projection = await c.load(QUEUE_PROJECTION);

    orchestration.setCurrentRuntimeAgentId('rt-a');
    // 当前会话：正常落地
    projection.applyQueuedInputsTexts('rt-a', ['queued-1'], 1);
    assert.deepEqual(JSON.parse(c.read('JSON.stringify(_queuedTexts)')), ['queued-1']);
    assert.equal(c.read('_pendingQueuedCount'), 1);
    assert.equal(queueState.queuedProjectionRuntimeId, 'rt-a');

    // 过期快照（用户已切走 / 事件乱序）：整条写入丢弃，不污染新会话输入面
    projection.applyQueuedInputsTexts('rt-b', ['stale'], 3);
    assert.deepEqual(JSON.parse(c.read('JSON.stringify(_queuedTexts)')), ['queued-1']);
    assert.equal(c.read('_pendingQueuedCount'), 1);
    assert.equal(queueState.queuedProjectionRuntimeId, 'rt-a', '过期快照不得改写投影归属');

    // 切到 rt-b 后，rt-a 的晚到快照同样被拒
    orchestration.setCurrentRuntimeAgentId('rt-b');
    projection.applyQueuedInputsTexts('rt-a', ['late'], 1);
    assert.deepEqual(JSON.parse(c.read('JSON.stringify(_queuedTexts)')), ['queued-1']);

    // 空快照 + 无调用中 → 清本地乐观态（isRuntimeCalling 缺席按未调用处理）
    projection.applyQueuedInputsTexts('rt-b', [], 0);
    assert.deepEqual(JSON.parse(c.read('JSON.stringify(_queuedTexts)')), []);
    assert.equal(c.read('_localQueuedInputPending'), false);
  });
});

test('桥面纪律：behavior 键与命名导出同址，模块私有键不上桥', async () => {
  const { options } = inputCaseOptions();
  await withP2EsmCase(options, async (c) => {
    await c.load('public/src/modules/thread-store.js'); // 交互域的窄宿主来源
    const projection = await c.load(QUEUE_PROJECTION);
    for (const key of ['_renderQueueBubbles', 'updateQueueIndicator', '_syncQueueFromBackend',
      '_syncPersistentInputUi']) {
      assert.equal(typeof projection[key], 'function', `缺少命名导出：${key}`);
      assert.equal(c.window[key], projection[key], `${key} 的桥键必须指向同一实现`);
      assert.equal(c.read(`Object.prototype.propertyIsEnumerable.call(window, "${key}")`), false,
        `${key} 不得进入枚举面`);
    }

    // 消费归零的键即时注销：sse-client 已改具名 import，本键零 window 消费方
    assert.equal(typeof projection.applyQueuedInputsTexts, 'function', '命名导出保留（ESM 消费方 import）');
    assert.equal(c.read('typeof window.applyQueuedInputsTexts'), 'undefined',
      'applyQueuedInputsTexts 的桥键已注销（无 classic 消费方）');

    // 零跨文件读者的并发守卫 / 渲染去重签名内部件不上桥
    assert.equal(c.read('typeof _persistentUiSyncInFlight'), 'undefined',
      '_persistentUiSyncInFlight 已收敛为 ESM 模块私有-state，不再有 window 面');

    // 输入面实现已迁 ESM：三个入口经 persistent-input-api 桥键供未迁移消费方
    // （input-render / queue-projection / runtime-status）调用，桥键与命名导出同源。
    const persistent = await c.load(PERSISTENT_INPUT);
    for (const key of ['rebindQueueProjectionForRuntime', '_interactiveSurfaceOccupiesInput',
      '_renderLastCallElapsed']) {
      assert.equal(c.read(`typeof ${key}`), 'function', `${key} 桥键应在模块相注册`);
      assert.equal(c.window[key], persistent[key], `${key} 的桥键必须指向同一实现`);
    }

    // 收尾：统计口径可核对（注册数 = 本批新增桥键；认领数 = 本批域数）
    const stats = JSON.parse(c.read('JSON.stringify(KernelState.stats())'));
    assert.ok(stats.registeredKeys > 0);
    assert.ok(stats.claimedKeys > 0);
  });
});

test('case 隔离：同名桥域在新 case 重新注册/认领，不撞重复注册', async () => {
  const first = inputCaseOptions();
  const firstStats = await withP2EsmCase(first.options, async (c) => {
    await c.load('public/src/modules/thread-store.js');
    await c.load(LEAF_QUEUE);
    await c.load(QUEUE_PROJECTION);
    return c.read('KernelState.stats().registeredKeys');
  });

  const second = inputCaseOptions();
  const secondStats = await withP2EsmCase(second.options, async (c) => {
    assert.equal(c.read('typeof applyQueuedInputsTexts'), 'undefined', '上一 case 的桥键不得残留');
    await c.load('public/src/modules/thread-store.js');
    await c.load(LEAF_QUEUE);
    await c.load(QUEUE_PROJECTION);
    return c.read('KernelState.stats().registeredKeys');
  });

  assert.equal(secondStats, firstStats, '同一 classic 注册面 + 同一 ESM 图 → 同一注册计数');
});

test('批次装载入口：整张输入面 ESM 图装载后桥域与命名导出齐备', async () => {
  const { options } = inputCaseOptions();
  await withP2EsmCase(options, async (c) => {
    await c.load('public/src/modules/thread-store.js');
    // 生产装载面 = p2-entry（状态 owner + 投影）+ p4-entry（输入面实现与桥键注册）。
    const entry = await c.load('public/src/modules/p2-w2-3a-input-bootstrap.js');
    await c.load(PERSISTENT_INPUT);
    assert.ok(entry, '入口模块应可装载（无重复注册 / 无循环依赖失败）');

    // 五个输入面域全部被认领：输入面状态键与 behavior 键都有 owner
    const stats = JSON.parse(c.read('JSON.stringify(KernelState.stats())'));
    assert.equal(stats.claimedKeys >= 5, true, `认领键数应覆盖本批五域：${stats.claimedKeys}`);

    // 生产入口一次装载后 classic 消费方要的桥键全部可达
    for (const key of ['updateQueueIndicator', '_syncPersistentInputUi',
      '_renderQueueBubbles', '_maybeFetchRecap', '_clearRecapForNewMessage', '_renderRecapHint']) {
      assert.equal(c.read(`typeof ${key}`), 'function', `${key} 应在入口装载后可达`);
    }
    assert.equal(c.read('typeof window.applyQueuedInputsTexts'), 'undefined',
      'applyQueuedInputsTexts 的桥键在入口装载后也不存在（消费已改 import）');

    // owner 活绑定在入口装载后仍是同一份状态（入口不建第二存储）
    const queueState = await c.load(LEAF_QUEUE);
    c.read('_pendingQueuedCount = 7');
    assert.equal(queueState.pendingQueuedCount, 7);
    queueState.setPendingQueuedCount(8);
    assert.equal(c.read('_pendingQueuedCount'), 8);
  });
});
