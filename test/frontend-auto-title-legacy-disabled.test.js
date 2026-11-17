/**
 * ADR-0041：壳层自动标题已硬屏蔽（P2 真实 ESM 图路线）。
 *
 * 这些用例保护的承诺是：**无论会话处于什么状态、应用有没有声明 titlePolicy，
 * Web 壳层都不再自动起名、也不发标题请求**。三个对话型应用（编程小助手 /
 * coder / memo）都装配了 AutoTitlePolicyFeature 自行决定触发时机，壳层若同时
 * 触发，同一会话会被两条链路各起一次名。
 *
 * 装载路线：classic 相跑真实生产源（分发器 / i18n / app-core / session-view-state
 * / markdown-bootstrap），它们提供 KernelState 桥键初值、call 活动容器与
 * sessionSwitch 宿主；auto-title.js 已迁 ESM，经 `withP2EsmCase` + `c.load` 真实
 * import，每个用例一张独立模块图（模块私有的 `_autoTitlePending` 不跨用例）。
 *
 * 断言口径（如实）：历史实现的内部容器（`_autoTitlePending`）与生成器
 * （`autoGenerateSessionTitle`）都不在公开面上，因此"没有登记候选""生成器被挡住"
 * 一律经**公开入口 + 可观测副作用**验证：公开入口逐个调用后，网络侧不得出现
 * 任何 /protoclaw/generate_session_title 请求，call 活动的"已触发"容器保持为空。
 *
 * 强度差异（不粉饰）：旧用例直接读 `_autoTitlePending` 判断"候选有没有登记"、
 * 直接调用私有 `autoGenerateSessionTitle` 验证第二道闸；这两个内部观测点已不可达，
 * 现改由「公开入口零副作用」推断——它覆盖"登记后会触发"的泄漏，但**不再直接观测
 * 候选登记的时相**（何时 add / 何时 delete）。为此补一层静态结构契约
 * （`source contract:` 前缀，只读分析不执行）：硬屏蔽开关恒为 true，且在四个入口
 * 里都出现在任何登记 / 请求副作用之前。结构契约钉住"闸在其前"，仍不等同于对
 * 内部 Set 的直接观测。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Renderer } from 'marked';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const AUTO_TITLE = 'public/src/modules/auto-title.js';
const AUTO_TITLE_SOURCE = readFileSync(new URL(`../${AUTO_TITLE}`, import.meta.url), 'utf8');
const CALL_ACTIVITY = 'public/src/modules/p2-bootstrap-call-activity.js';
const AGENT_STORE_STATE = 'public/src/modules/agent-store-state.js';
const ORCHESTRATION_STATE = 'public/src/modules/orchestration-state.js';
const SESSION_VIEW_STORAGE = 'public/src/modules/session-view-storage.js';

const TITLE_REQUEST = '/protoclaw/generate_session_title';

/** vendor 桩：markdown-bootstrap 只在装载期需要 Renderer 与 setOptions。 */
const markedStub = { Renderer, setOptions() {} };

/** classic 相：真实加载序（分发器 → i18n → app-core → session-view-state → markdown-bootstrap）。 */
function loadClassicBootstrap(sandbox) {
  sandbox.marked = markedStub;
  sandbox.window.marked = markedStub;
  // 真实先行脚本序（test/p2-classic-hosts.js）：宿主工厂（runtime-switch / poll /
  // workspace-surface / 侧栏 call 状态）都是生产实现，首屏 boot 与周期排程由基座
  // 关掉；markdown-bootstrap 是基座链之外的真实 classic 文件（index.html 顺序）。
  prepareClassicSandbox(sandbox);
  sandbox.loadSource('public/src/modules/markdown-bootstrap.js');
}

function createAgents(overrides = {}) {
  const host = {
    id: 'programming-helper',
    source: 'prebuilt',
    ...overrides,
    workspace_sessions: {
      activeSessionId: 'session-head',
      // 占位会话：按历史逻辑这正是"应该起名"的状态，用来证明屏蔽不依赖状态。
      sessions: [{ id: 'session-head', title: '新对话1', titleState: 'placeholder' }],
    },
  };
  const runtime = {
    id: 'runtime-head',
    source: 'child',
    parent_id: 'programming-helper',
    active_workspace_session_id: 'session-head',
    active_workspace_session_title: '',
    workspace_sessions: { sessions: [] },
  };
  return [host, runtime];
}

function createFetchStub(fetchCalls) {
  return async (url) => {
    fetchCalls.push(String(url));
    if (String(url) === TITLE_REQUEST) {
      return { ok: true, status: 200, json: async () => ({ ok: true, title: '修复线程标题生成' }) };
    }
    return { ok: true, status: 200, json: async () => ({ alerts: [] }) };
  };
}

/** 模块的"已触发"容器（classic app-core 按引用交出的真实容器）。 */
async function createHarness(c, { overrides = {} } = {}) {
  const agentStore = await c.load(AGENT_STORE_STATE);
  const orchestration = await c.load(ORCHESTRATION_STATE);
  const storage = await c.load(SESSION_VIEW_STORAGE);
  const { callActivity } = await c.load(CALL_ACTIVITY);
  const autoTitle = await c.load(AUTO_TITLE);

  orchestration.setCurrentRuntimeAgentId('runtime-head');
  agentStore.setFocusedAgentId('programming-helper');
  agentStore.setAllAgents(createAgents(overrides));
  storage.setCurrentMessages([]);
  return { autoTitle, agentStore, orchestration, storage, triggered: callActivity._autoTitleTriggered };
}

const FIRST_TURN = [
  { role: 'user', content: '请修复线程标题生成' },
  { role: 'assistant', content: '我来检查并修复。' },
];

const titleRequests = (fetchCalls) => fetchCalls.filter((url) => url === TITLE_REQUEST);

test('shell registers no title candidate for a placeholder session', async () => {
  const fetchCalls = [];
  await withP2EsmCase({ classic: loadClassicBootstrap, globals: { fetch: createFetchStub(fetchCalls) } }, async (c) => {
    const { autoTitle, triggered } = await createHarness(c);
    autoTitle.markAutoTitleCandidate([], FIRST_TURN);
    // 候选登记的唯一可观测后果是"后续轮询会去起名"，这里连续两轮都不得触发
    autoTitle.tryAutoTitleGeneration(FIRST_TURN);
    autoTitle.tryAutoTitleGeneration(FIRST_TURN);
    assert.deepEqual(titleRequests(fetchCalls), [],
      'a placeholder session must not become a shell candidate');
    assert.equal(triggered.size, 0);
  });
});

test('shell recheck registers no candidate either', async () => {
  const fetchCalls = [];
  await withP2EsmCase({ classic: loadClassicBootstrap, globals: { fetch: createFetchStub(fetchCalls) } }, async (c) => {
    const { autoTitle, storage, triggered } = await createHarness(c);
    storage.setCurrentMessages(FIRST_TURN);
    autoTitle.recheckAutoTitleCandidate();
    autoTitle.tryAutoTitleGeneration(FIRST_TURN);
    assert.deepEqual(titleRequests(fetchCalls), [],
      'the post-load recheck must not resurrect the shell trigger');
    assert.equal(triggered.size, 0);
  });
});

test('shell dispatches no title request on the poll path', async () => {
  const fetchCalls = [];
  await withP2EsmCase({ classic: loadClassicBootstrap, globals: { fetch: createFetchStub(fetchCalls) } }, async (c) => {
    const { autoTitle } = await createHarness(c);
    autoTitle.markAutoTitleCandidate([], FIRST_TURN);
    autoTitle.tryAutoTitleGeneration(FIRST_TURN);
    assert.deepEqual(titleRequests(fetchCalls), [],
      'the shell must not request title generation');
  });
});

test('no exported entry can reach the title generator', async () => {
  // 生成器 autoGenerateSessionTitle 是模块私有的第二道闸（硬屏蔽），公开面上
  // 不可达；这里逐个调用模块的**全部导出**，证明没有任何一条公开路径能产生
  // 标题请求或占用"已触发"容器。
  const fetchCalls = [];
  await withP2EsmCase({ classic: loadClassicBootstrap, globals: { fetch: createFetchStub(fetchCalls) } }, async (c) => {
    const { autoTitle, storage, triggered } = await createHarness(c);
    assert.equal('autoGenerateSessionTitle' in autoTitle, false,
      'the generator must not be exported (no test-only public API)');

    storage.setCurrentMessages(FIRST_TURN);
    for (const name of Object.keys(autoTitle)) {
      const entry = autoTitle[name];
      if (typeof entry !== 'function') continue;
      autoTitle.markAutoTitleCandidate([], FIRST_TURN);
      await entry(FIRST_TURN);
      await entry('programming-helper', 'session-head', true);
    }
    assert.deepEqual(titleRequests(fetchCalls), [],
      'the generator must return before issuing the request');
    assert.equal(triggered.size, 0);
  });
});

test('disablement does not depend on the application title policy declaration', async () => {
  // 已声明与未声明的应用都不得由壳层起名——屏蔽是全局的，不是"让位"。
  for (const overrides of [{}, { titlePolicy: 'app' }]) {
    const fetchCalls = [];
    await withP2EsmCase({ classic: loadClassicBootstrap, globals: { fetch: createFetchStub(fetchCalls) } }, async (c) => {
      const { autoTitle, triggered } = await createHarness(c, { overrides });
      autoTitle.markAutoTitleCandidate([], FIRST_TURN);
      autoTitle.tryAutoTitleGeneration(FIRST_TURN);
      assert.deepEqual(titleRequests(fetchCalls), [],
        `no request expected (titlePolicy=${String(overrides.titlePolicy)})`);
      assert.equal(triggered.size, 0,
        `no candidate expected (titlePolicy=${String(overrides.titlePolicy)})`);
    });
  }
});

// ── 结构契约层（静态只读分析，不执行源码）─────────────────────────────────

/** 去掉块注释与行注释：花括号配平只对代码成立，注释里的括号不参与语义。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * 静态取出 `function <name>(...)` 的文本块（花括号配平）。
 * 仅做字符串切分与位置比较：不 eval、不 vm 执行、不改写源码。
 */
function extractFunctionSource(source, name) {
  const code = stripComments(source);
  const startMatch = new RegExp(`function\\s+${name}\\s*\\(`).exec(code);
  assert.ok(startMatch, `function ${name} 应存在于 auto-title.js`);
  const bodyStart = code.indexOf('{', startMatch.index);
  let depth = 0;
  for (let i = bodyStart; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(startMatch.index, i + 1);
    }
  }
  throw new Error(`function ${name} 的花括号未配平`);
}

test('source contract: the shell title trigger switch is a constant true (static, not executed)', () => {
  const fn = extractFunctionSource(AUTO_TITLE_SOURCE, 'isShellTitleTriggerDisabled');
  // 恒真、无入参、无配置读取：恢复壳层触发必须是一次显式代码改动。
  assert.match(fn, /^function isShellTitleTriggerDisabled\(\s*\)/);
  assert.match(fn, /\{\s*return\s+true\s*;\s*\}/);
  assert.doesNotMatch(fn, /window\.|localStorage|process\.env|metadata|titlePolicy/);
});

test('source contract: the disable guard precedes every candidate registration and request side effect', () => {
  const guardIndex = (fn) => fn.indexOf('isShellTitleTriggerDisabled()');
  const assertGuardedBefore = (name, marker) => {
    const fn = extractFunctionSource(AUTO_TITLE_SOURCE, name);
    const guard = guardIndex(fn);
    const effect = fn.indexOf(marker);
    assert.ok(guard >= 0, `${name} 应调用硬屏蔽开关`);
    assert.ok(effect >= 0, `${name} 应仍含有 ${marker}（历史语义参照）`);
    assert.ok(guard < effect, `${name}: 硬屏蔽必须先于 ${marker}`);
    // 闸就是函数体的第一句：`if (isShellTitleTriggerDisabled()) return;`
    assert.match(fn, /^function [^(]+\([^)]*\)\s*\{\s*(?:\/\*[^*]*\*\/\s*)?if\s*\(\s*isShellTitleTriggerDisabled\(\)\s*\)\s*return\s*;/);
  };

  assertGuardedBefore('markAutoTitleCandidate', '_autoTitlePending.add(');
  assertGuardedBefore('recheckAutoTitleCandidate', '_autoTitlePending.add(');
  assertGuardedBefore('tryAutoTitleGeneration', '_autoTitlePending.has(');
  // 第二道闸：真正的副作用（网络请求）在生成器内部同样被挡住。
  assertGuardedBefore('autoGenerateSessionTitle', 'new AbortController(');
});
