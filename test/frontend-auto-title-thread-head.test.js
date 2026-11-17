/**
 * 线程 head 会话的标题候选语义（ADR-0041 第 1 步）——公开硬屏蔽行为 + 结构契约。
 *
 * 历史背景：`titleCandidateState` 曾区分「占位待起名（candidate）」「已有标题或
 * 来源未知（settled）」「快照暂缺记录（unknown，必须延后判定而不是判否）」三种
 * 情况。该判定与壳层触发一起被硬屏蔽后，它是 auto-title.js 的模块私有函数，
 * 公开面上不可达（没有导出、也没有桥键），所以**运行时不再有三态覆盖**。
 *
 * 本文件因此由两层组成，语义强度必须分开读：
 *   1. 公开行为层（runScenario* 系列）：对四种会话状态驱动真实公开入口，断言
 *      壳层不登记候选、不发标题请求、不改写标题——这是真实可观测承诺。
 *   2. 结构契约层（`source contract:` 前缀的用例）：对 auto-title.js 做**静态**
 *      分析（花括号配平切片 + 正则，不执行、不改写、不抽取执行），钉住三态
 *      函数的参数与三条返回分支、以及「判定只看 titleState 不看标题文案」。
 *      它守住的是词汇与分支结构（未来若重新引入候选逻辑可直接复用），
 *      **不是**运行时三态覆盖，也不能替代原来的返回值断言。
 *
 * 三态词汇的运行时覆盖已随硬屏蔽消失：原用例断言 `titleCandidateState(...)`
 * 的三个返回值，现在无法经任何真实边界取得（生产侧不为测试扩大导出）。
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

function loadClassicBootstrap(sandbox) {
  sandbox.marked = markedStub;
  sandbox.window.marked = markedStub;
  // 真实先行脚本序（test/p2-classic-hosts.js）：宿主工厂（runtime-switch / poll /
  // workspace-surface / 侧栏 call 状态）都是生产实现，首屏 boot 与周期排程由基座
  // 关掉；markdown-bootstrap 是基座链之外的真实 classic 文件（index.html 顺序）。
  prepareClassicSandbox(sandbox);
  sandbox.loadSource('public/src/modules/markdown-bootstrap.js');
}

const FIRST_TURN = [
  { role: 'user', content: '请修复线程标题生成' },
  { role: 'assistant', content: '我来检查并修复。' },
];

function createAgents({ titleState, sessionKnown, title = '新对话1' }) {
  const host = {
    id: 'programming-helper',
    source: 'prebuilt',
    workspace_sessions: {
      activeSessionId: 'session-head',
      sessions: sessionKnown
        ? [{ id: 'session-head', title, ...(titleState === undefined ? {} : { titleState }) }]
        : [],
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

/**
 * 一个状态场景 = 一张独立模块图：装载真实 classic 引导 + 真实 ESM 图，按场景
 * 写入会话索引投影，然后依次驱动三个公开触发入口（消息到达 / 装载后复检 /
 * 轮询触发，轮询连跑两轮覆盖「延后判定」的下一轮）。
 */
async function runScenario(scenario, inspect) {
  const fetchCalls = [];
  await withP2EsmCase({
    classic: loadClassicBootstrap,
    globals: {
      fetch: async (url) => {
        fetchCalls.push(String(url));
        return { ok: true, status: 200, json: async () => ({ ok: true, title: '修复线程标题生成' }) };
      },
    },
  }, async (c) => {
    const agentStore = await c.load(AGENT_STORE_STATE);
    const orchestration = await c.load(ORCHESTRATION_STATE);
    const storage = await c.load(SESSION_VIEW_STORAGE);
    const { callActivity } = await c.load(CALL_ACTIVITY);
    const autoTitle = await c.load(AUTO_TITLE);

    orchestration.setCurrentRuntimeAgentId('runtime-head');
    agentStore.setFocusedAgentId('programming-helper');
    agentStore.setAllAgents(createAgents(scenario));
    storage.setCurrentMessages([]);

    autoTitle.markAutoTitleCandidate([], FIRST_TURN);
    storage.setCurrentMessages(FIRST_TURN);
    autoTitle.recheckAutoTitleCandidate();
    autoTitle.tryAutoTitleGeneration(FIRST_TURN);
    autoTitle.tryAutoTitleGeneration(FIRST_TURN);

    inspect({ fetchCalls, agentStore, triggered: callActivity._autoTitleTriggered, autoTitle, storage });
  });
}

test('placeholder sessions are not shell title candidates', async () => {
  await runScenario({ titleState: 'placeholder', sessionKnown: true }, ({ fetchCalls, agentStore, triggered }) => {
    assert.equal(fetchCalls.includes(TITLE_REQUEST), false, 'a placeholder session must not request a title');
    assert.equal(triggered.size, 0, 'a placeholder session must not become a shell candidate');
    const session = agentStore.allAgents[0].workspace_sessions.sessions[0];
    assert.equal(session.title, '新对话1', 'the shell must not rewrite the display title');
    assert.equal(session.titleState, 'placeholder', 'titleState is owned by the app policy, not the shell');
    assert.equal(agentStore.allAgents[0].active_workspace_session_title, undefined,
      'no shell-side active title projection is written');
  });
});

test('sessions that already have a title are left alone', async () => {
  // auto = 系统生成过，user = 用户改过名：两种都不该再自动起名。
  for (const titleState of ['auto', 'user']) {
    await runScenario({ titleState, sessionKnown: true, title: '既有标题' }, ({ fetchCalls, agentStore, triggered }) => {
      assert.equal(fetchCalls.includes(TITLE_REQUEST), false, `${titleState}: no title request`);
      assert.equal(triggered.size, 0, `${titleState}: must not be marked triggered`);
      assert.equal(agentStore.allAgents[0].workspace_sessions.sessions[0].title, '既有标题',
        `${titleState}: existing title untouched`);
    });
  }
});

test('a record with an unknown titleState is not a candidate', async () => {
  // 改造前的历史记录没有 titleState。来源无法判定时不猜文案，直接不起名。
  for (const titleState of ['', undefined]) {
    await runScenario({ titleState, sessionKnown: true }, ({ fetchCalls, triggered }) => {
      assert.equal(fetchCalls.includes(TITLE_REQUEST), false, `unknown titleState (${String(titleState)}): no request`);
      assert.equal(triggered.size, 0, `unknown titleState (${String(titleState)}): not a candidate`);
    });
  }
});

test('a missing session record never wakes the shell trigger (three-state vocabulary is a source contract, not runtime coverage)', async () => {
  // 快照暂缺索引投影是观测时机问题，不代表会话没有状态：历史判定在此刻保留
  // 候选、等下一轮再定。屏蔽后下一轮同样不得放行——即便记录随后以 placeholder
  // 到达，也不得产生候选或请求。
  await runScenario({ sessionKnown: false }, ({ fetchCalls, triggered, autoTitle, storage, agentStore }) => {
    assert.equal(fetchCalls.includes(TITLE_REQUEST), false, 'missing record: no request');
    assert.equal(triggered.size, 0, 'missing record: not marked triggered');

    // 下一轮：索引投影到达（placeholder），再走一遍同样的公开入口
    agentStore.setAllAgents(createAgents({ titleState: 'placeholder', sessionKnown: true }));
    storage.setCurrentMessages(FIRST_TURN);
    autoTitle.markAutoTitleCandidate([], FIRST_TURN);
    autoTitle.recheckAutoTitleCandidate();
    autoTitle.tryAutoTitleGeneration(FIRST_TURN);

    assert.equal(fetchCalls.includes(TITLE_REQUEST), false,
      'the deferred state must not become a shell title request once the record arrives');
    assert.equal(triggered.size, 0);
  });
});

// ── 结构契约层（静态只读分析，不执行源码）─────────────────────────────────

/** 去掉块注释与行注释：花括号配平只对代码成立，注释里的括号不参与语义。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * 静态取出 `function <name>(...)` 的文本块（花括号配平）。
 * 仅做字符串切分与正则断言：不 eval、不 vm 执行、不改写源码。
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

test('source contract: titleCandidateState keeps the three-state vocabulary (static, not executed)', () => {
  const fn = extractFunctionSource(AUTO_TITLE_SOURCE, 'titleCandidateState');

  // 签名：两个入参就是「记录是否可见」与「结构化标题状态」。
  assert.match(fn, /^function titleCandidateState\(sessionKnown, titleState\)/);
  // 三条返回分支，且顺序承担语义：记录未知先短路，再由占位判定分流。
  assert.match(fn, /if\s*\(\s*!sessionKnown\s*\)\s*return\s+'unknown'\s*;/);
  assert.match(fn, /return\s+isPlaceholderTitleState\(titleState\)\s*\?\s*'candidate'\s*:\s*'settled'\s*;/);
  const returns = [...fn.matchAll(/'(unknown|candidate|settled)'/g)].map((m) => m[1]);
  assert.deepEqual(returns, ['unknown', 'candidate', 'settled'],
    '三态词汇与短路顺序是结构契约');
  // 判定只看 titleState：不出现裸 title（标题文案是展示值，不是状态）。
  assert.doesNotMatch(fn, /\btitle\b(?!State)/);
});

test('source contract: placeholder is the only candidate source (static, not executed)', () => {
  const fn = extractFunctionSource(AUTO_TITLE_SOURCE, 'isPlaceholderTitleState');
  assert.match(fn, /===\s*'placeholder'/, "占位态由结构化 titleState 的 'placeholder' 唯一确定");
});

test('source contract: the three-state judge is not part of the public surface', async () => {
  // 结构事实（同时解释为什么本文件不能有运行时三态覆盖）：没有导出、没有桥键。
  assert.doesNotMatch(AUTO_TITLE_SOURCE, /export\s+(?:function|const|let)\s+titleCandidateState/);
  await withP2EsmCase({ classic: loadClassicBootstrap }, async (c) => {
    const autoTitle = await c.load(AUTO_TITLE);
    assert.equal('titleCandidateState' in autoTitle, false);
    assert.equal('isPlaceholderTitleState' in autoTitle, false);
  });
});
