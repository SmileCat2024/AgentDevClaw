/**
 * P2 第二波 3b「APP 首页快记输入框」——整域 ESM 后的真实行为。
 *
 * 装载路线：test/helpers/p2-esm-case.js 的 `withP2EsmCase`（整图隔离真实
 * import + 真实 classic 沙箱）。classic 相跑真实生产前缀
 * （app-core → sidebar-render → session-view-state → input-composer），因此
 * ESM 侧的 `ClawToast` / `loadAgents` 走的是**真实 import 图与真实宿主工厂**，
 * 不是测试桩；快记条自身的 DOM/网络面由用例注入。voice-input 已迁 ESM
 * （P4 L3），需要语音链路记账的用例经 `stubVoiceInput` 在模块装载后覆盖桥值。
 *
 * 钉住六件事：
 *   1. 命名空间缝不变：`window.AppChatInput` 指向模块导出，内部函数不外泄；
 *   2. 草稿读写走 3a 的会话草稿 owner（同一活绑定，无双存储）；
 *   3. 发送编排（解析 → 建会话 → 投递）按原顺序与字段发请求，成功后清输入与草稿；
 *   4. 语音占用期的「录音中点发送 = 停录 + 标记待发」语义不变；
 *   5. 防重入与失败保留输入的语义不变；
 *   6. 分发器三个动作的真实行为，以及仍 classic 的能力缺失时的**原 typeof 守卫
 *      语义**（跳过、不抛错、不改判）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const MODULE = 'public/src/modules/app-chat-input.js';
const TOAST = 'public/src/modules/toast-notify.js';
const COMPOSER_STATE = 'public/src/modules/p2-w2-3a-composer-state.js';
const VOICE_STATE = 'public/src/modules/p2-w2-3a-voice-state.js';
const VOICE_INPUT = 'public/src/modules/voice-input.js';
const AGENT = { id: 'memo', name: 'Memo' };
const BLOCK = {
  type: 'app-chat-input',
  resolveEndpoint: '/api/app/memo/thread',
  ensureEndpoint: '/api/app/memo/thread/new',
  placeholder: { zh: '记一笔', en: 'Jot it down' },
};

function createElement(tag = '') {
  const classes = new Set();
  return {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    value: '',
    title: '',
    innerHTML: '',
    style: {},
    dataset: {},
    classList: {
      add(value) { classes.add(value); },
      remove(value) { classes.delete(value); },
      toggle(value, force) {
        const on = force === undefined ? !classes.has(value) : Boolean(force);
        if (on) classes.add(value); else classes.delete(value);
        return on;
      },
      contains(value) { return classes.has(value); },
    },
    parentNode: null,
    appendChild(child) { return child; },
    insertBefore(child) { return child; },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, bottom: 0 }; },
    // 自动高度（真实 input-actions.autoResize）按 scrollHeight 定高
    scrollHeight: 40,
  };
}

function createDocument() {
  const byId = new Map();
  const bySelector = new Map();
  return {
    byId,
    bySelector,
    // 与 frontend-vm 默认桩同语义：未知 id 也返回稳定元素（app-core / sidebar-render
    // 的加载期 DOM 引用因此不被 null 打断），用例只对自己登记的节点断言。
    getElementById(id) {
      if (!byId.has(id)) {
        const el = createElement('div');
        el.id = id;
        byId.set(id, el);
      }
      return byId.get(id);
    },
    querySelector(selector) { return bySelector.get(selector) || null; },
    querySelectorAll() { return []; },
    createElement: (tag) => createElement(tag),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {},
    removeEventListener() {},
    body: createElement('body'),
    documentElement: createElement('html'),
    activeElement: null,
    hidden: false,
    readyState: 'complete',
  };
}

/** 让已发出但未 await 的处理器续体跑完（微任务 + 挂载用的 0ms 定时器）。 */
function settle() {
  return new Promise((resolve) => { setTimeout(() => setImmediate(resolve), 0); });
}

/**
 * 用例地基：真实 classic 生产前缀 + 快记条需要的 DOM 与网络面。
 * `fetch` 由用例体按场景改写（classic 相安装的代理负责记账）。
 */
function createCaseOptions({ language = 'zh' } = {}) {
  const doc = createDocument();
  const textarea = createElement('textarea');
  textarea.id = 'app-chat-input-textarea-' + AGENT.id;
  textarea.dataset = { agentId: AGENT.id, sessionKey: 'app-chat-input:' + AGENT.id };
  doc.byId.set(textarea.id, textarea);
  const sendButton = createElement('button');
  sendButton.id = 'app-chat-input-send-' + AGENT.id;
  sendButton.dataset = { agentId: AGENT.id };
  doc.byId.set(sendButton.id, sendButton);
  // 快记条语音按钮：`queuePostMount` 用属性选择器取它，bySelector 必须真有节点，
  // 否则 `if (btn)` 永远不可达、守卫用例会假通过。
  const voiceButton = createElement('button');
  voiceButton.dataset = { target: textarea.id };
  doc.bySelector.set('.app-chat-voice-btn[data-target="' + textarea.id + '"]', voiceButton);

  const state = {
    doc,
    textarea,
    sendButton,
    voiceButton,
    calls: [],
    invokeCalls: [],
    logs: [],
    refreshRenders: [],
    toasts: [],

    voiceCalls: [],
    navigateCalls: [],
    // 按场景替换的网络桩（模块里的裸 `fetch` 走主 realm 注入面，因此代理必须
    // 在 classic 相就位——这里就是它被 sandbox 暴露的时刻）
    fetchHandler: () => jsonResponse({ ok: false }, false, 0),
    // 成功发送后的列表刷新：权威连接快照（MCP get_connected_agents 返回数组）
    connectedSnapshot: () => [{
      id: AGENT.id,
      name: AGENT.name,
      status: 'running',
      pid: 4242,
      connected: true,
      messageCount: 3,
      createdAt: '2026-11-17T00:00:00.000Z',
      workspace_sessions: { sessions: [] },
    }],
    // 同一刷新的 Viewer 存活面（GET /api/agents 的真实形状）
    viewerResponse: () => jsonResponse({
      agents: [{ id: AGENT.id, name: AGENT.name, type: 'prebuilt', connected: true, messageCount: 3 }],
    }),
  };

  const options = {
    classic: (sandbox) => {
      sandbox.localStorage.setItem('agentdev-language', language);
      // 真实先行脚本序（test/p2-classic-hosts.js）：app-core / sidebar-render /
      // session-view-state / app-main / app-ui 的宿主工厂都是生产实现，首屏 boot 与
      // 周期排程由基座关掉。基座之外按 index.html 顺序补输入面与分发器真实实现。
      prepareClassicSandbox(sandbox);
      sandbox.loadSource('public/src/modules/input-composer.js');
      sandbox.loadSource('public/src/modules/action-dispatcher.js');

      // runtime-status.js 的 classic 词法容器：本用例不加载该文件（它不在快记条
      // 的依赖路径上），只补 createAgentCallStatesHost 求值期要读的 Map 引用。
      sandbox._agentSuspended = new Map();
      // 语音链路（stopVoiceRecording / toggleVoiceRecording / _updateVoiceUI）已属
      // ESM 的 voice-input（P4 L3）：需要记账的用例经 stubVoiceInput 在装载后覆盖桥值。
      // autoResize 已是 ESM 具名导出（input-actions）：不再注入同名桩，自动高度按
      // 真实实现的 DOM 效果断言；input-actions 的静态依赖里 poll-coordinator-host
      // 需要 app-main 的轮询宿主工厂，本用例不驱动轮询，只要求装载期可解析。
      sandbox.runWorkspaceAction = (action) => { state.navigateCalls.push(action); };
      // 列表刷新的**绘制**面属 sidebar 域 classic 代码（app-main / app-ui 的
      // groupConnectedAgents / renderFeaturePanel 不在快记条依赖链上），本用例
      // 只把它们换成记账桩：刷新调度的数据面（权威快照 + Viewer + 状态映射）
      // 仍走真实实现，绘制桩只证明“刷新跑到了收尾”。
      sandbox.renderAgentList = () => { state.refreshRenders.push('list'); };
      sandbox.renderFeaturePanel = () => { state.refreshRenders.push('panel'); };
      sandbox.resolveFocusedAgentAfterRefresh = () => null;
      sandbox.isSseActive = () => false;
      // 真实 loadAgents 的权威快照入口（sidebar-render 的 host.connected 调它）
      sandbox.invoke = async (name, params) => {
        state.invokeCalls.push({ name, params });
        if (name === 'get_connected_agents') return state.connectedSnapshot();
        return null;
      };
      sandbox.fetch = async (url, init = {}) => {
        const call = { url: String(url), method: init.method || 'GET', body: init.body };
        state.calls.push(call);
        // Viewer 存活读取由刷新链路固定要走（与 App 业务端点分开记账）
        if (call.url === '/api/agents') return state.viewerResponse();
        return state.fetchHandler(call);
      };
    },
    globals: {
      document: doc,
      // markdown-utils（escapeHtml 的 ESM owner）与 app-core 求值期读取的经典库面
      renderer: { options: {} },
      escapeHtml: (text) => String(text ?? '').replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[m]),
      marked: { Renderer: class { constructor() {} }, setOptions() {}, parse: () => '' },
      hljs: { getLanguage: () => null, highlight: () => ({ value: '' }) },
      // agent-snapshot-loader 的 host.now() 读 performance（裸标识符 → 主 realm）
      performance: { now: () => 0 },
      // 刷新与发送链路的 warn/error 记账：断言“无预期外噪声”靠它，不靠 catch 吞错
      console: Object.assign(Object.create(console), {
        log: () => {},
        info: () => {},
        warn: (...args) => { state.logs.push(['warn', args.map((v) => String(v)).join(' ')]); },
        error: (...args) => { state.logs.push(['error', args.map((v) => String(v)).join(' ')]); },
      }),
    },
  };
  return { state, options };
}

function jsonResponse(payload, ok = true, status = 200) {
  return { ok, status, json: async () => payload };
}

/** 业务端点（排除刷新链路的 Viewer 存活读取）。 */
function businessCalls(state) {
  return state.calls.filter((call) => call.url !== '/api/agents');
}

/** 设定本轮网络桩（调用点由 classic 相安装的代理统一记账）。 */
function installFetch(state, handler) {
  state.fetchHandler = handler;
}

/**
 * 语音链路记账桩：voice-input 已迁 ESM（P4 L3）。模块装载后经桥访问器覆盖函数
 * 键（claim 的 set 写回桥值），app-chat-input 的 `window.X` 读到同一引用。
 */
async function stubVoiceInput(c, state) {
  await c.load(VOICE_INPUT);
  c.window.stopVoiceRecording = () => { state.voiceCalls.push(['stop']); };
  c.window._updateVoiceUI = () => { state.voiceCalls.push(['ui']); };
  c.window.toggleVoiceRecording = (el) => { state.voiceCalls.push(['toggle', el.id || el.dataset?.target]); };
  // 模块求值期的音频提示预取（/sounds/*.mp3，best-effort）不是业务调用，不进记账。
  state.calls.length = 0;
}

/** 真实 toast 模块是同一实例：直接替换导出对象上的方法做行为记账。 */
async function spyToasts(c, state) {
  const toast = await c.load(TOAST);
  toast.ClawToast.show = (value) => { state.toasts.push(value); };
  toast.ClawToast.update = (id, patch) => { state.toasts.push({ ...patch, id }); };
  return toast;
}

test('命名空间缝：window.AppChatInput 指向模块导出，内部函数不外泄', async () => {
  const { options } = createCaseOptions();
  await withP2EsmCase(options, async (c) => {
    assert.equal(typeof c.window.AppChatInput, 'undefined', '模块求值前不存在（classic 相位已退出）');
    const mod = await c.load(MODULE);

    assert.equal(c.window.AppChatInput, mod.AppChatInput, 'window 命名空间与模块导出同一对象');
    for (const name of ['render', 'submit', 'onInput', 'onKeydown', 'onSendClick', 'openConversation']) {
      assert.equal(typeof mod.AppChatInput[name], 'function', name);
    }
    assert.equal(c.read('typeof render'), 'undefined', 'render 不外泄成全局函数');
    // 桥形态：KernelState 访问器（不可枚举、可配置供终局撤除），不是散装赋值
    assert.equal(c.read('Object.prototype.propertyIsEnumerable.call(window, "AppChatInput")'), false);
    assert.equal(c.read('Object.getOwnPropertyDescriptor(window, "AppChatInput").configurable'), true);
    assert.equal(c.read('Object.getOwnPropertyDescriptor(window, "AppChatInput").get instanceof Function'), true,
      'window.AppChatInput 由访问器提供');

    // claim 吸收不重初始化：认领后仍是同一个对象、同一套 API（IIFE 未重跑）
    const original = c.window.AppChatInput;
    assert.equal(original, mod.AppChatInput, '认领吸收保持同一引用');
    assert.equal(typeof original.render, 'function');
    assert.equal(typeof mod.AppChatInput.submit, 'function');

    // 整值替换是迁移前的既有能力（`window.AppChatInput = (() => …)()` 是可写数据属性）：
    // classic 写方替换后，window 与模块导出必须读到**同一个**新引用。
    const replacement = { render: () => 'replaced', submit: () => {}, marker: 'replacement' };
    c.window.AppChatInput = replacement;
    assert.equal(c.window.AppChatInput, replacement, 'classic 整值替换可写');
    assert.equal(mod.AppChatInput, replacement, '导出活绑定同步到同一引用');
    assert.equal(c.read('window.AppChatInput.render()'), 'replaced', '消费方读到替换后的命名空间');

    // 恢复原对象后两侧仍然同源（替换语义对称，不是单向劫持）
    c.window.AppChatInput = original;
    assert.equal(c.window.AppChatInput, original);
    assert.equal(mod.AppChatInput, original);
    assert.equal(typeof mod.AppChatInput.render, 'function', '恢复后原始能力可用');

    // 未知键不静默吞：认领后补注册的键落在 api 上并可读回
    c.read(`window.KernelState.defineKey('app-chat-input', '__p2w3bProbe', 'probe-value')`);
    assert.equal(c.read('window.__p2w3bProbe'), 'probe-value', '未知键写入不被弃置');
    for (const action of ['appChatInput.input', 'appChatInput.send', 'appChatInput.voice']) {
      assert.equal(c.read(`window.ClawFW.actions.has('${action}')`), true, `${action} 在真实分发器上可查`);
    }
  });
});

test('render：配置不完整渲染空串；草稿取自 3a 会话草稿 owner', async () => {
  const { options } = createCaseOptions();
  await withP2EsmCase(options, async (c) => {
    const mod = await c.load(MODULE);
    const composerState = await c.load(COMPOSER_STATE);

    assert.equal(mod.AppChatInput.render(AGENT, { type: 'app-chat-input' }), '',
      '缺端点 = 能力不可用，渲染空串');
    assert.equal(mod.AppChatInput.render(null, BLOCK), '');

    composerState.sessionInputCache['app-chat-input:memo'] = '半句话';
    const html = mod.AppChatInput.render(AGENT, BLOCK);
    assert.match(html, /id="app-chat-input-textarea-memo"/);
    assert.match(html, /data-session-key="app-chat-input:memo"/);
    assert.match(html, /placeholder="记一笔"/, '占位文案经 localizeWorkspaceValue + escapeHtml');
    assert.match(html, />半句话<\/textarea>/, '重渲染内嵌还原草稿');
    assert.match(html, /data-action="appChatInput\.input" data-event="input keydown"/);
    assert.match(html, /data-action="appChatInput\.send"/);
    assert.match(html, /data-target="app-chat-input-textarea-memo"/);

    // classic 侧（voice-input 的草稿写回）看到的仍是同一份缓存
    assert.equal(c.read('_sessionInputCache["app-chat-input:memo"]'), '半句话');
  });
});

test('submit：解析活动对话 → 投递 → 清输入与草稿（不新建会话）', async () => {
  const { state, options } = createCaseOptions();
  await withP2EsmCase(options, async (c) => {
    const mod = await c.load(MODULE);
    await spyToasts(c, state);
    const composerState = await c.load(COMPOSER_STATE);
    mod.AppChatInput.render(AGENT, BLOCK);
    composerState.sessionInputCache['app-chat-input:memo'] = '买牛奶';
    state.textarea.value = '  买牛奶  ';

    installFetch(state, (call) => {
      if (call.url === BLOCK.resolveEndpoint) return Promise.resolve(jsonResponse({ ok: true, threadId: 'wt-7' }));
      if (call.url === '/protoclaw/threads/wt-7/input') return Promise.resolve(jsonResponse({ ok: true }));
      return Promise.resolve(jsonResponse({ ok: false }, false, 404));
    });

    await mod.AppChatInput.submit(AGENT.id);
    await settle();

    assert.deepEqual(businessCalls(state).map((call) => call.method + ' ' + call.url), [
      'GET ' + BLOCK.resolveEndpoint,
      'POST /protoclaw/threads/wt-7/input',
    ], '有活动对话时不创建新会话');

    // 成功后的列表刷新真正发生并跑完（权威快照 + Viewer 存活面都要有请求）
    assert.equal(state.invokeCalls.filter((call) => call.name === 'get_connected_agents').length, 1,
      '刷新读取权威连接快照');
    assert.ok(businessCalls(state).length === 2 && state.calls.some((call) => call.url === '/api/agents'),
      '刷新读取 Viewer 存活面');
    assert.deepEqual(state.refreshRenders, ['list', 'panel'],
      '刷新跑到了绘制收尾（列表重绘 + 无活动面板时的面板重绘）');
    assert.deepEqual(state.logs, [], '刷新链路无预期外 warn/error（performance/宿主面齐全）');
    assert.deepEqual(JSON.parse(state.calls[1].body), { text: '买牛奶', source: 'app-chat-input' });

    assert.equal(state.textarea.value, '', '成功后清空 live 输入框');
    assert.equal(composerState.sessionInputCache['app-chat-input:memo'], undefined, '并按草稿键清理缓存');
    assert.equal(state.sendButton.classList.contains('is-sending'), false, '发送态复位');
    assert.equal(state.toasts.length, 1);
    assert.equal(state.toasts[0].status, 'success');
    assert.equal(state.toasts[0].action.label, '查看回复');

    // 成功 toast 的「查看回复」复用 start_app_conversation 导航链（classic 面按桩记账）
    state.toasts[0].action.onClick();
    assert.deepEqual(state.navigateCalls, [
      { type: 'start_app_conversation', endpoint: BLOCK.ensureEndpoint },
    ]);
  });
});

test('submit：无活动对话时先建会话再投递（三个端点各自只调一次）', async () => {
  const { state, options } = createCaseOptions();
  await withP2EsmCase(options, async (c) => {
    const mod = await c.load(MODULE);
    await spyToasts(c, state);
    mod.AppChatInput.render(AGENT, BLOCK);
    state.textarea.value = '第一条';

    installFetch(state, (call) => {
      if (call.url === BLOCK.resolveEndpoint) {
        return Promise.resolve(jsonResponse({ ok: true, activeThread: null }));
      }
      if (call.url === BLOCK.ensureEndpoint) {
        return Promise.resolve(jsonResponse({ ok: true, threadId: 'wt-new' }));
      }
      if (call.url === '/protoclaw/threads/wt-new/input') return Promise.resolve(jsonResponse({ ok: true }));
      return Promise.resolve(jsonResponse({ ok: false }, false, 500));
    });

    await mod.AppChatInput.submit(AGENT.id);
    await settle();
    assert.deepEqual(businessCalls(state).map((call) => call.method + ' ' + call.url), [
      'GET ' + BLOCK.resolveEndpoint,
      'POST ' + BLOCK.ensureEndpoint,
      'POST /protoclaw/threads/wt-new/input',
    ]);
    assert.equal(state.toasts[0].status, 'success');
    assert.deepEqual(state.logs, [], '建会话路径的刷新同样无预期外 warn/error');
  });
});

test('submit：语音占用期语义（转写中不发送 / 录音中点发送 = 停录 + 标记待发）', async () => {
  const { state, options } = createCaseOptions();
  await withP2EsmCase(options, async (c) => {
    const mod = await c.load(MODULE);
    await spyToasts(c, state);
    await stubVoiceInput(c, state);
    const voiceState = await c.load(VOICE_STATE);
    mod.AppChatInput.render(AGENT, BLOCK);
    state.textarea.value = '语音内容';
    installFetch(state, () => Promise.resolve(jsonResponse({ ok: false }, false, 500)));

    voiceState.setVoiceTranscribing(true);
    await mod.AppChatInput.submit(AGENT.id);
    assert.equal(state.calls.length, 0, '转写中不可发送');

    voiceState.setVoiceTranscribing(false);
    voiceState.setVoiceRecording(true);
    await mod.AppChatInput.submit(AGENT.id);
    assert.equal(state.calls.length, 0, '录音中不直接投递');
    assert.equal(voiceState.voicePendingSend, true, '标记转写完成后自动发送');
    assert.deepEqual(state.voiceCalls, [['stop']], '只停止录音，由 onstop 收尾');

    // 录音已停、仍在转写：重复点发送只保留待发意图，不再重复停录
    voiceState.setVoiceRecording(false);
    voiceState.setVoiceStopping(false);
    await mod.AppChatInput.submit(AGENT.id);
    assert.deepEqual(state.voiceCalls, [['stop']]);
  });
});

test('submit：防重入与失败保留输入', async () => {
  const { state, options } = createCaseOptions();
  await withP2EsmCase(options, async (c) => {
    const mod = await c.load(MODULE);
    await spyToasts(c, state);
    const composerState = await c.load(COMPOSER_STATE);
    mod.AppChatInput.render(AGENT, BLOCK);
    composerState.sessionInputCache['app-chat-input:memo'] = '草稿保留';
    state.textarea.value = '草稿保留';

    let release;
    installFetch(state, () => new Promise((resolve) => { release = resolve; }));
    const first = mod.AppChatInput.submit(AGENT.id);
    assert.equal(state.sendButton.classList.contains('is-sending'), true, '发送中按钮进入 spinner 态');
    const second = mod.AppChatInput.submit(AGENT.id);
    assert.equal(state.calls.length, 1, '发送事务进行中不可重入');
    release(jsonResponse({ ok: false, code: 'nope' }, false, 503));
    await first;
    await second;

    assert.equal(state.textarea.value, '草稿保留', '失败保留输入供重试');
    assert.equal(composerState.sessionInputCache['app-chat-input:memo'], '草稿保留', '失败不清草稿');
    assert.equal(state.sendButton.classList.contains('is-sending'), false, '失败后发送态复位');
    assert.equal(state.toasts.at(-1).status, 'error');
    assert.match(state.toasts.at(-1).description, /nope/);
    // 故意 HTTP 失败的负例：只允许 App 自己的那条错误日志（不含刷新噪声）
    assert.deepEqual(state.logs.map((entry) => entry[0] + ':' + entry[1].split(' ')[0]),
      ['error:[app-chat-input]'], '失败日志精确白名单');

    // 失败后可以再次发送（inFlight 已释放）
    installFetch(state, () => Promise.resolve(jsonResponse({ ok: true, threadId: 'wt-9' })));
    await mod.AppChatInput.submit(AGENT.id);
    assert.equal(businessCalls(state).at(-1).url, '/protoclaw/threads/wt-9/input');
    assert.equal(state.toasts.at(-1).status, 'success');
  });
});

test('分发器动作真实行为：input 打字/回车、send 按钮、voice 按钮', async () => {
  const { state, options } = createCaseOptions();
  await withP2EsmCase(options, async (c) => {
    const mod = await c.load(MODULE);
    await spyToasts(c, state);
    await stubVoiceInput(c, state);
    mod.AppChatInput.render(AGENT, BLOCK);
    installFetch(state, (call) => {
      if (call.url === BLOCK.resolveEndpoint) return Promise.resolve(jsonResponse({ ok: true, threadId: 'wt-acts' }));
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    // ① 打字：自动高度 + 草稿落 owner（真实 _cacheSessionInput 路径）
    state.textarea.value = '打字内容';
    const invoked = c.read(`
      window.__ta = document.getElementById('app-chat-input-textarea-memo');
      window.ClawFW.actions.invoke('appChatInput.input', window.__ta, { type: 'input' })
    `);
    assert.equal(invoked, true, 'input 动作有处理器');
    assert.equal(state.textarea.style.height, '40px', '打字触发自动高度（真实 autoResize 按 scrollHeight 定高）');
    assert.equal(c.read('_sessionInputCache["app-chat-input:memo"]'), '打字内容', '打字即落会话草稿');

    // ② 回车：Enter 触发发送（Shift/Ctrl + Enter 与 IME 组字不触发）
    c.read(`
      window.ClawFW.actions.invoke('appChatInput.input', window.__ta, {
        type: 'keydown', key: 'Enter', shiftKey: true, ctrlKey: false, isComposing: false, preventDefault() {},
      });
      window.ClawFW.actions.invoke('appChatInput.input', window.__ta, {
        type: 'keydown', key: 'Enter', shiftKey: false, ctrlKey: false, isComposing: true, preventDefault() {},
      });
    `);
    await settle();
    assert.equal(businessCalls(state).length, 0, 'Shift+Enter / IME 组字不发送');

    c.read(`
      window.ClawFW.actions.invoke('appChatInput.input', window.__ta, {
        type: 'keydown', key: 'Enter', shiftKey: false, ctrlKey: false, isComposing: false,
        preventDefault() { window.__enterPrevented = (window.__enterPrevented || 0) + 1; },
      });
    `);
    await settle();
    assert.equal(businessCalls(state).length, 2, 'Enter 走发送编排（解析 + 投递）');
    assert.equal(c.read('window.__enterPrevented || 0'), 1, 'Enter 被 preventDefault（不插入换行）');
    assert.equal(state.toasts.at(-1)?.status, 'success');

    // ③ 发送按钮
    state.calls.length = 0;
    state.textarea.value = '按钮发送';
    c.read(`window.ClawFW.actions.invoke('appChatInput.send', document.getElementById('app-chat-input-send-memo'))`);
    await settle();
    assert.equal(businessCalls(state).length, 2, '按钮与回车共用同一发送编排');

    // ④ 语音按钮：交给 voice-input 的开关（本用例按行为记账）
    c.read(`window.ClawFW.actions.invoke('appChatInput.voice', { id: 'voice-btn', dataset: {} })`);
    assert.deepEqual(state.voiceCalls.at(-1), ['toggle', 'voice-btn']);
  });
});

test('守卫行为：仍 classic 的能力缺失时按原 typeof 语义跳过，不抛错也不改判', async () => {
  const { state, options } = createCaseOptions();
  await withP2EsmCase(options, async (c) => {
    const mod = await c.load(MODULE);
    await spyToasts(c, state);
    mod.AppChatInput.render(AGENT, BLOCK);
    // 首渲染的挂载修正先跑完（此时还没有录音目标，命中不到重绑分支），
    // 后面两次渲染的挂载修正才是本用例的观测对象。
    await settle();

    // 撤掉三个仍 classic 的能力（生产里它们由别的 classic 模块提供）；
    // autoResize 已迁 ESM（具名 import），不再具备“缺席”这个状态。
    c.read(`
      window.__ta = document.getElementById('app-chat-input-textarea-memo');
      delete window._cacheSessionInput;
      delete window._updateVoiceUI;
      delete window.runWorkspaceAction;
    `);

    // 打字：classic 守卫跳过、不抛错；已 import 的 autoResize 照常执行
    assert.doesNotThrow(() => {
      c.read(`window.ClawFW.actions.invoke('appChatInput.input', window.__ta, { type: 'input' })`);
    }, 'input 处理器的 _cacheSessionInput 守卫原样保留');
    assert.equal(state.textarea.style.height, '40px', 'autoResize 已是 ESM 具名导出，仍按真实实现生效');

    // 录音目标命中本 block 的 textarea → queuePostMount 会走到 `if (btn)` 分支
    const voiceState = await c.load(VOICE_STATE);
    voiceState.setVoiceTargetId('app-chat-input-textarea-memo');
    voiceState.setVoiceRecording(true);

    // ① 能力存在：真实按钮节点在 bySelector 里，调用必须真的发生
    c.read('window._updateVoiceUI = () => { window.__voiceUiCalls = (window.__voiceUiCalls || 0) + 1; };');
    mod.AppChatInput.render(AGENT, BLOCK);
    await settle();
    assert.equal(c.read('window.__voiceUiCalls || 0'), 1, '录音目标重绑时确实调用了 _updateVoiceUI');
    assert.equal(state.voiceButton.classList.contains('recording'), true, '按钮进入录音态');

    // ② 能力缺失：同一路径只跳过、不抛错（原 typeof 守卫语义）
    c.read('delete window._updateVoiceUI; delete window.__voiceUiCalls;');
    assert.doesNotThrow(() => mod.AppChatInput.render(AGENT, BLOCK), 'render 同步部分不依赖 _updateVoiceUI');
    await settle();
    assert.equal(c.read('window.__voiceUiCalls || 0'), 0, '缺失时不调用也不改判');

    // 录音态归零后走发送：「查看回复」导航在 runWorkspaceAction 缺失时静默跳过
    voiceState.setVoiceRecording(false);
    voiceState.setVoiceStopping(false);
    installFetch(state, (call) => {
      if (call.url === BLOCK.resolveEndpoint) return Promise.resolve(jsonResponse({ ok: true, threadId: 'wt-guard' }));
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    state.textarea.value = '守卫场景';
    await mod.AppChatInput.submit(AGENT.id);
    const success = state.toasts.at(-1);
    assert.equal(success.status, 'success');
    assert.doesNotThrow(() => success.action.onClick(), '导航能力缺失不改判为失败');
  });
});
