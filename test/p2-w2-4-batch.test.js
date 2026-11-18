/**
 * P2 第二波批次 4「标题时间线与快照呈现」专属测试。
 *
 * 覆盖四类本批独有的承诺：
 *   1. 接口面：四个转换模块的具名导出（ESM 真实 import 路线）就是公开面——
 *      只保留有生产消费方的入口，内部 helper 与可变 cache 不出现在导出里；
 *   2. 兼容桥：仍有 classic 消费方的入口经 KernelState 桥键可达（访问器形态），
 *      收敛为模块私有的入口不在 window 上；claim 后 classic 侧的读写继续转发；
 *   3. 原行为：自动标题硬屏蔽、时间分隔线、模板解析/高亮截断与展开动作、
 *      overview/hook inspector 快照规范化与日志写回 classic owner；
 *   4. 异步过期：后台模板预热的代次/焦点校验仍然拒绝晚到结果，成功路径仍清空
 *      渲染去重签名并重绘。
 *
 * 装载路线：真实 import（esm-module-loader，installGlobals:false）。classic 侧用
 * frontend-vm 沙箱按真实加载序执行 i18n → app-core → session-view-state，然后把
 * 沙箱本身当作 window —— 与浏览器里 window === classic 全局对象同形，因此桥键
 * 访问器、host 适配器与晚绑定调用都走真实路径，不复制任何状态。
 *
 * todo-plan.js 不在本批转换范围（计划 rail 在首屏同步建立且可点击，render 回调
 * 于 deferred 模块前不可用），其行为由既有 classic 测试覆盖。
 *
 * 变异验证（接口删除 / claim.set 置空）为人工步骤，见批次报告；本文件不内建。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { loadModuleOnce } from './helpers/esm-module-loader.js';
import { loadThreadEngine } from './helpers/thread-engine.js';
import { loadEsmDomain, prepareClassicSandbox } from './p2-classic-hosts.js';

const MODULES = {
  templateEngine: 'public/src/modules/template-engine.js',
  overviewData: 'public/src/modules/overview-data.js',
  autoTitle: 'public/src/modules/auto-title.js',
  messageTimeline: 'public/src/modules/message-timeline.js',
};
const BATCH_ENTRY = 'public/src/modules/p2-w2-4-title-timeline-bootstrap.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** 真实加载序 + 真实桥：classic 沙箱即 window。 */
async function setupBatch() {
  const ctx = createFrontendSandbox();
  const fetchCalls = [];
  // app-core 会把 window.fetch 包一层（同源代理），桩必须在它之前装好。
  ctx.fetch = async (url) => {
    fetchCalls.push(String(url));
    return { ok: false, status: 0, json: async () => ({}) };
  };
  // 真实先行脚本序（test/p2-classic-hosts.js）：宿主工厂都是生产实现，首屏 boot 与
  // 周期排程由基座关掉。
  prepareClassicSandbox(ctx, { deferEsmDomain: false });

  const renders = [];
  ctx.renderCurrentMainView = () => { renders.push('render'); };
  // action-dispatcher 由 index.html 先于一切模块加载；这里只需要注册面。
  ctx.ClawFW = {
    actions: {
      handlers: {},
      registerMany(map) { Object.assign(this.handlers, map); },
    },
  };

  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevHljs = globalThis.hljs;
  globalThis.window = ctx;
  globalThis.document = ctx.document;
  // vendor 高亮库（index.html 的 hljs 脚本）最小等价桩：转义后回填，与真实 hljs 同形。
  globalThis.hljs = {
    highlight(line) {
      return {
        value: String(line).replace(/[&<>]/g, (ch) => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;',
        }[ch])),
      };
    },
  };
  const restoreGlobals = () => {
    if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
    if (prevDocument === undefined) delete globalThis.document; else globalThis.document = prevDocument;
    if (prevHljs === undefined) delete globalThis.hljs; else globalThis.hljs = prevHljs;
  };

  try {
    // 侧栏渲染 / 运行时状态 / call 状态引擎（P4 T2 收尾批次起的模块相）。classic
    // 链里的 host 工厂已就位，这里按真实加载序求值（classic 先、module 后）。
    const loadModule = async (rel) => import(new URL(`../${rel}`, import.meta.url).href);
    await loadEsmDomain(ctx, loadModule);
    // 刷新引擎（P4 T3 起是真实 ESM）：交互域在**装载期**取它的窄宿主
    // createThreadStoreHost，必须先于本批图求值（装载期计时器由 helper 记账丢弃）。
    await loadThreadEngine();
    // 整批图只装载一次：唯一 query 只加在入口模块上，本批模块之间的静态 import
    // 保持无 query 的同一实例（否则每个实例都会重复注册桥键）。
    await loadModuleOnce(BATCH_ENTRY, { installGlobals: false });
    const modules = {};
    for (const [name, rel] of Object.entries(MODULES)) {
      modules[name] = await import(new URL(`../${rel}`, import.meta.url).href);
    }
    return { ctx, modules, fetchCalls, renders, restoreGlobals };
  } catch (error) {
    restoreGlobals();
    throw error;
  }
}

let env;
before(async () => { env = await setupBatch(); });
after(() => { env?.restoreGlobals(); });

/** 每用例复位：清异步记录、会话视图状态与桥键上被用例改写过的值。 */
function resetCase() {
  env.renders.length = 0;
  env.fetchCalls.length = 0;
  window.currentRuntimeAgentId = null;
  window.currentMessages = [];
  window._lastRenderedChatSig = '';
  window.TOOL_NAMES = {};
  // classic 顶层 let：只能经沙箱全局词法环境读写（window 属性看不到它）。
  env.ctx.run('selectedFeatureName = null');
  env.ctx.run('templateWarmupToken = 0');
}

describe('P2-4 接口面：四个模块的公开导出', () => {
  it('每个模块只导出有生产消费方的跨文件键', () => {
    const { autoTitle, messageTimeline, templateEngine, overviewData } = env.modules;

    for (const name of ['markAutoTitleCandidate', 'recheckAutoTitleCandidate',
      'findFirstChangedMessageIndex', 'tryAutoTitleGeneration', 'checkGlobalChoiceAlerts']) {
      assert.equal(typeof autoTitle[name], 'function', `auto-title 缺少导出 ${name}`);
    }
    assert.deepEqual(Object.keys(autoTitle).sort(), [
      'checkGlobalChoiceAlerts', 'findFirstChangedMessageIndex', 'markAutoTitleCandidate',
      'recheckAutoTitleCandidate', 'tryAutoTitleGeneration',
    ]);

    for (const name of ['attachMessagesTimestamps', 'resolveEchoTimeSeparator',
      'formatChatTimestamp', 'renderTimeSeparatorHtml', 'prependTimeSeparatorHtml']) {
      assert.equal(typeof messageTimeline[name], 'function', `message-timeline 缺少导出 ${name}`);
    }
    assert.deepEqual(Object.keys(messageTimeline).sort(), [
      'attachMessagesTimestamps', 'formatChatTimestamp', 'prependTimeSeparatorHtml',
      'renderTimeSeparatorHtml', 'resolveEchoTimeSeparator',
    ]);

    for (const name of ['clearFeatureTemplateCache', 'clearTruncatedHighlightData',
      'renderJsonHighlight', 'applyTemplate', 'parseToolResult', 'getToolRenderTemplate',
      'getToolDisplayName', 'collectTemplateNames', 'warmTemplatesInBackground',
      'getAgentRuntimeId']) {
      assert.equal(typeof templateEngine[name], 'function', `template-engine 缺少导出 ${name}`);
    }
    assert.deepEqual(Object.keys(templateEngine).sort(), [
      'applyTemplate', 'clearFeatureTemplateCache', 'clearTruncatedHighlightData',
      'collectTemplateNames', 'getAgentRuntimeId', 'getToolDisplayName',
      'getToolRenderTemplate', 'parseToolResult', 'renderJsonHighlight',
      'warmTemplatesInBackground',
    ]);

    for (const name of ['shortenSourcePath', 'getHookInspectorSignature', 'getEmptyOverviewSnapshot',
      'extractMessagesProbe', 'normalizeOverviewSnapshot', 'getOverviewSignature',
      'normalizeHookInspector', 'setCurrentHookInspector', 'setCurrentOverviewSnapshot']) {
      assert.equal(typeof overviewData[name], 'function', `overview-data 缺少导出 ${name}`);
    }
    // setCurrentLogs 不在本模块：唯一实现是 classic app-core 的同名同步函数
    // （日志面板 onOpen 在首屏 classic 相就可点，写入口必须同步可用）。
    assert.equal(overviewData.setCurrentLogs, undefined, 'setCurrentLogs 不得在 overview-data 留第二份实现');
    assert.equal(Object.keys(overviewData).length, 9);
  });

  it('内部 helper 与可变 cache 不出现在导出面（不为测试造 API）', () => {
    const { autoTitle, messageTimeline, templateEngine } = env.modules;
    for (const name of ['titleCandidateState', '_messagesEqual', '_autoTitlePending',
      'autoGenerateSessionTitle', 'isShellTitleTriggerDisabled', 'newIdempotencyKey']) {
      assert.equal(autoTitle[name], undefined, `auto-title 不应导出 ${name}`);
    }
    assert.equal(messageTimeline.resolveUserTimeSeparator, undefined);
    for (const name of ['templateCache', 'loadTemplate', 'expandTruncatedResult',
      'formatError', 'interpolateTemplate', 'getTemplateFallback']) {
      assert.equal(templateEngine[name], undefined, `template-engine 不应导出 ${name}`);
    }
  });

  it('工具模板分发器动作仍在装载时注册', () => {
    assert.equal(typeof window.ClawFW.actions.handlers['templates.expandTruncated'], 'function');
  });
});

describe('P2-4 兼容桥：仍有 classic 消费方的入口', () => {
  it('桥键是成对访问器（configurable / 不可枚举），不是数据属性', () => {
    const bridged = [
      'markAutoTitleCandidate', 'findFirstChangedMessageIndex',
      'tryAutoTitleGeneration', 'checkGlobalChoiceAlerts',
      'attachMessagesTimestamps', 'resolveEchoTimeSeparator', 'formatChatTimestamp',
      'renderTimeSeparatorHtml', 'prependTimeSeparatorHtml',
      'clearTruncatedHighlightData', 'renderJsonHighlight',
      'applyTemplate', 'parseToolResult', 'getToolRenderTemplate', 'getToolDisplayName',
      'shortenSourcePath', 'getHookInspectorSignature', 'getEmptyOverviewSnapshot',
      'extractMessagesProbe', 'normalizeOverviewSnapshot', 'getOverviewSignature',
      'normalizeHookInspector', 'setCurrentHookInspector', 'setCurrentOverviewSnapshot',
    ];
    for (const key of bridged) {
      const descriptor = Object.getOwnPropertyDescriptor(window, key);
      assert.ok(descriptor, `${key} 应经桥键注册`);
      assert.equal(typeof descriptor.get, 'function', `${key} 缺 getter`);
      assert.equal(typeof descriptor.set, 'function', `${key} 缺 setter（strict 写需要）`);
      assert.equal(descriptor.configurable, true, `${key} 必须可撤桥`);
      assert.equal(descriptor.enumerable, false, `${key} 不应进入 for-in`);
      assert.equal(typeof window[key], 'function', `${key} 应解析到实现`);
    }
  });

  it('消费方改直接 import 后桥已注销', () => {
    // recheckAutoTitleCandidate / clearFeatureTemplateCache ← agent-data-loader 改 import；
    // collectTemplateNames / warmTemplatesInBackground ← agent-loader-host 改 import。
    for (const key of ['recheckAutoTitleCandidate', 'clearFeatureTemplateCache',
      'collectTemplateNames', 'warmTemplatesInBackground']) {
      assert.equal(window[key], undefined, `${key} 的桥已注销`);
    }
    assert.equal(typeof env.modules.autoTitle.recheckAutoTitleCandidate, 'function');
    assert.equal(typeof env.modules.templateEngine.clearFeatureTemplateCache, 'function');
    assert.equal(typeof env.modules.templateEngine.collectTemplateNames, 'function');
    assert.equal(typeof env.modules.templateEngine.warmTemplatesInBackground, 'function');
  });

  it('收敛为模块私有的入口不在 window 上', () => {
    for (const key of ['resolveUserTimeSeparator', 'templateCache', 'loadTemplate',
      'expandTruncatedResult', 'formatError', 'interpolateTemplate', 'getTemplateFallback',
      'titleCandidateState', '_messagesEqual', '_autoTitlePending', 'autoGenerateSessionTitle']) {
      assert.equal(window[key], undefined, `${key} 的消费面已归零，不应造桥`);
    }
    // getAgentRuntimeId 不造桥：window 上仍是 app-core 的同名 classic 声明。
    assert.equal(typeof window.getAgentRuntimeId, 'function');
    assert.equal(window.getAgentRuntimeId, env.ctx.run('getAgentRuntimeId'));
  });

  it('todo-plan 的桥键由自身 ESM 模块注册（P4 L1），本批环境未装载故无访问器', () => {
    // 本批（W2-4）不替 todo-plan 造桥；P4 L1 之后它自己的 ESM 模块在模块相注册
    // 六个经典消费方键。本批环境不装载 todo-plan，因此这里仍应看不到访问器——
    // 出现就说明有别人替它造了桥（本批禁止）。
    const keys = ['getEmptyTodoPlan', 'normalizeTodoPlan', 'setCurrentTodoPlan',
      'updatePlanBadge', 'renderPlanPanel', 'getTodoPlanSignature'];
    for (const key of keys) {
      assert.equal(Object.getOwnPropertyDescriptor(window, key)?.get, undefined,
        `${key} 不应由本批造桥（唯一注册者是 todo-plan.js 自身）`);
    }
    const source = readFileSync(new URL('../public/src/modules/todo-plan.js', import.meta.url), 'utf8');
    for (const key of keys) {
      assert.match(source, new RegExp(`defineKey\\('todo-plan', '${key}'`),
        `${key} 应由 todo-plan.js 注册（domain todo-plan）`);
    }
  });

  it('claim 后 classic 写方的赋值经 setter 继续生效', () => {
    resetCase();
    const marker = () => 'classic-written';
    window.markAutoTitleCandidate = marker;
    assert.equal(window.markAutoTitleCandidate, marker);
    window.markAutoTitleCandidate = env.modules.autoTitle.markAutoTitleCandidate;
    assert.equal(window.markAutoTitleCandidate, env.modules.autoTitle.markAutoTitleCandidate);
  });

  it('日志与 feature 选择仍写回 app-core 顶层声明（classic 写入口 / debugPanel 适配器，不持副本）', () => {
    resetCase();
    // 日志写入走 classic app-core 的唯一同步实现（早期 onOpen 入口要求它在
    // classic 相可用）；本用例经真实 classic 裸标识符调用，不再经 ESM 导出。
    env.ctx.run('setCurrentLogs([{ id: 3 }, { id: 7 }])');
    assert.deepEqual(Array.from(env.ctx.run('currentLogs'), (entry) => entry.id), [3, 7]);
    assert.equal(env.ctx.run('currentLogsSignature'), JSON.stringify({ count: 2, last: 7 }));
    // 它是 classic 顶层函数（window 值属性），不是 KernelState 桥访问器
    const descriptor = Object.getOwnPropertyDescriptor(window, 'setCurrentLogs');
    assert.equal(typeof descriptor.value, 'function');
    assert.equal(descriptor.get, undefined, 'setCurrentLogs 不得再经桥键注册');

    // feature 选择在提交的 inspector 里消失时才被清空（原语义）。
    env.ctx.run("selectedFeatureName = 'ghost'");
    env.modules.overviewData.setCurrentHookInspector({ features: [{ name: 'other', tools: [] }], hooks: [] });
    assert.equal(env.ctx.run('selectedFeatureName'), null);
    env.ctx.run("selectedFeatureName = 'other'");
    env.modules.overviewData.setCurrentHookInspector({ features: [{ name: 'other', tools: [] }], hooks: [] });
    assert.equal(env.ctx.run('selectedFeatureName'), 'other');
  });
});

describe('P2-4 原行为：自动标题硬屏蔽（ADR-0041）', () => {
  it('消息比较工具经公开入口保持既有语义', () => {
    const { findFirstChangedMessageIndex } = env.modules.autoTitle;
    const m1 = { role: 'user', content: 'a' };
    const m2 = { role: 'assistant', content: 'b' };
    assert.equal(findFirstChangedMessageIndex([m1, m2], [m1]), 1);
    assert.equal(findFirstChangedMessageIndex([m1], [m1]), -1);
    assert.equal(findFirstChangedMessageIndex([m1], [{ role: 'user', content: 'c' }]), 0);
    assert.equal(findFirstChangedMessageIndex(null, [m1]), 0);
  });

  it('三个入口都不发标题请求（占位会话也不登记候选）', async () => {
    resetCase();
    const { markAutoTitleCandidate, recheckAutoTitleCandidate, tryAutoTitleGeneration } = env.modules.autoTitle;
    env.ctx.allAgents = [
      { id: 'programming-helper', source: 'prebuilt', workspace_sessions: { sessions: [{ id: 'session-head', title: '新对话1', titleState: 'placeholder' }] } },
      { id: 'runtime-head', source: 'child', parent_id: 'programming-helper', active_workspace_session_id: 'session-head' },
    ];
    const turns = [{ role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }];
    window.currentMessages = turns;
    window.currentRuntimeAgentId = 'runtime-head';
    markAutoTitleCandidate([], turns);
    recheckAutoTitleCandidate();
    tryAutoTitleGeneration(turns);
    assert.deepEqual(env.fetchCalls, []);
  });

  it('选择告警轮询走 window.fetch（app-core 同源包装之后仍是同一出口）', async () => {
    resetCase();
    await env.modules.autoTitle.checkGlobalChoiceAlerts();
    assert.deepEqual(env.fetchCalls, ['/protoclaw/choice_alerts']);
  });
});

describe('P2-4 原行为：用户消息时间分隔线', () => {
  const SEPARATOR = '<div class="time-separator"><span>';

  it('时间平行表合并进消息副本，失配时原样返回', () => {
    const { attachMessagesTimestamps } = env.modules.messageTimeline;
    const messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
    const merged = attachMessagesTimestamps(messages, [111, null]);
    assert.equal(merged[0]._ts, 111);
    assert.equal('_ts' in merged[1], false);
    assert.equal(attachMessagesTimestamps(messages, [111]), messages);
    assert.equal(attachMessagesTimestamps(messages, undefined), messages);
  });

  it('首条用户消息出线；间隔不足或无锚不出线；非用户消息透传', () => {
    const { prependTimeSeparatorHtml } = env.modules.messageTimeline;
    const t0 = Date.now() - 60 * 60 * 1000;
    const fiveMin = 5 * 60 * 1000;
    assert.ok(prependTimeSeparatorHtml([{ role: 'user', _ts: t0 }], 0, 'ROW').startsWith(SEPARATOR));
    assert.equal(prependTimeSeparatorHtml(
      [{ role: 'user', _ts: t0 }, { role: 'user', _ts: t0 + fiveMin - 1 }], 1, 'ROW'), 'ROW');
    assert.equal(prependTimeSeparatorHtml(
      [{ role: 'user', _ts: t0 }, { role: 'user', _ts: t0 + fiveMin + 1 }], 1, 'ROW'),
      env.modules.messageTimeline.renderTimeSeparatorHtml(t0 + fiveMin + 1) + 'ROW');
    assert.equal(prependTimeSeparatorHtml([{ role: 'user' }, { role: 'user', _ts: t0 }], 1, 'ROW'), 'ROW');
    assert.equal(prependTimeSeparatorHtml([{ role: 'assistant', _ts: t0 }], 0, 'ROW'), 'ROW');
  });

  it('乐观回显预判用加过余量的阈值', () => {
    const { resolveEchoTimeSeparator } = env.modules.messageTimeline;
    const now = Date.now();
    assert.equal(resolveEchoTimeSeparator([{ role: 'user', _ts: now - 6 * 60 * 1000 }], now), now);
    assert.equal(resolveEchoTimeSeparator([{ role: 'user', _ts: now - 3 * 60 * 1000 }], now), null);
    assert.equal(resolveEchoTimeSeparator([], now), now);
    assert.equal(resolveEchoTimeSeparator([], NaN), null);
  });

  it('分隔线文本由 formatChatTimestamp 生成，行 html 原样拼接', () => {
    const { prependTimeSeparatorHtml, formatChatTimestamp } = env.modules.messageTimeline;
    const ts = Date.now();
    const text = formatChatTimestamp(ts);
    assert.ok(text.length > 0);
    assert.equal(prependTimeSeparatorHtml([{ role: 'user', _ts: ts }], 0, '<i>x</i>'),
      SEPARATOR + text + '</span></div><i>x</i>');
  });
});

describe('P2-4 原行为：工具模板解析、高亮截断与展开动作', () => {
  it('parseToolResult 解双层编码 JSON，display 并入且剔除 rewrittenCall', () => {
    const { parseToolResult } = env.modules.templateEngine;
    const inner = JSON.stringify(JSON.stringify({ a: 1 }));
    assert.deepEqual(parseToolResult('{"success":true,"result":' + inner + '}'), { success: true, data: { a: 1 } });

    const withDisplay = parseToolResult('not-json', { diff: 'x', rewrittenCall: { id: 'r' } });
    assert.equal(withDisplay.success, true);
    assert.deepEqual(withDisplay.data, { diff: 'x' });
  });

  it('applyTemplate 覆盖占位符替换与函数模板两条路径', () => {
    const { applyTemplate } = env.modules.templateEngine;
    assert.equal(applyTemplate('Hi {{name}} / {{missing}}', { name: 'x' }), 'Hi x / {{missing}}');
    assert.equal(applyTemplate({ result: (data) => '<b>' + data.v + '</b>' }, { v: 2 }), '<b>2</b>');
    assert.equal(applyTemplate((data, success) => (success ? 'ok' : 'bad'), null), 'ok');
  });

  it('getToolDisplayName 读会话工具名映射（ESM owner，桥键读取）', () => {
    resetCase();
    window.TOOL_NAMES = { bash: 'Bash' };
    assert.equal(env.modules.templateEngine.getToolDisplayName('bash'), 'Bash');
    assert.equal(env.modules.templateEngine.getToolDisplayName('unknown'), 'unknown');
    assert.equal(env.modules.templateEngine.getToolDisplayName(''), 'Tool');
  });

  it('超过 200 行的结果只渲染前 200 行并给出展开入口', () => {
    const { renderJsonHighlight } = env.modules.templateEngine;
    const big = Array.from({ length: 210 }, (_, i) => i);
    const html = renderJsonHighlight(big);
    assert.equal((html.match(/class="code-read-line"/g) || []).length, 200);
    assert.match(html, /data-action="templates\.expandTruncated"/);
    assert.match(html, /more lines \(click to expand\)/);
  });

  it('截断结果经分发器动作展开为全量行并释放缓存', () => {
    const { renderJsonHighlight } = env.modules.templateEngine;
    const big = Array.from({ length: 260 }, (_, i) => i);
    const html = renderJsonHighlight(big);
    const id = /data-expand-id="([^"]+)"/.exec(html)[1];
    const container = { innerHTML: '' };
    window.ClawFW.actions.handlers['templates.expandTruncated']({
      getAttribute: () => id,
      closest: () => container,
    });
    const expectedLines = JSON.stringify(big, null, 2).split('\n').length;
    assert.equal((container.innerHTML.match(/class="code-read-line"/g) || []).length, expectedLines);
    // 同一 id 只能展开一次：缓存已释放，二次调用不再重写内容。
    container.innerHTML = '';
    window.ClawFW.actions.handlers['templates.expandTruncated']({
      getAttribute: () => id,
      closest: () => container,
    });
    assert.equal(container.innerHTML, '');
  });

  it('collectTemplateNames 过滤 __inline__ 并去重', () => {
    const { collectTemplateNames } = env.modules.templateEngine;
    assert.deepEqual(collectTemplateNames([
      { render: 'math' },
      { render: { call: 'user-input', result: '__inline__' } },
      { render: { call: 'math' } },
      { render: null },
    ]), ['math', 'user-input']);
  });

  it('getAgentRuntimeId 用本文件（classic 装载序赢家）实现', () => {
    const { getAgentRuntimeId } = env.modules.templateEngine;
    assert.equal(getAgentRuntimeId({ id: 'child', source: 'child', runtime_session_id: 'rt-1' }), 'rt-1');
    assert.equal(getAgentRuntimeId({ id: 'host', source: 'prebuilt' }), '');
  });
});

describe('P2-4 异步过期：后台模板预热的代次与焦点校验', () => {
  const warmHarness = () => {
    resetCase();
    window.currentRuntimeAgentId = 'runtime-a';
    window.currentMessages = [{ role: 'tool', content: 'result' }];
    window._lastRenderedChatSig = 'rendered';
  };

  // 三个内置模板名各用一次：内置模板装载后即进缓存，重复使用会让 warmup 提前返回。
  it('同 runtime 且模板真实到位时清空渲染签名并重绘', async () => {
    warmHarness();
    env.modules.templateEngine.warmTemplatesInBackground(['math'], 'runtime-a');
    await tick();
    await tick();
    assert.deepEqual(env.renders, ['render']);
    assert.equal(window._lastRenderedChatSig, '');
  });

  it('预热代次被切换推进后，晚到的预热结果不重绘', async () => {
    warmHarness();
    env.modules.templateEngine.warmTemplatesInBackground(['user-input'], 'runtime-a');
    env.ctx.run('templateWarmupToken += 1');
    await tick();
    await tick();
    assert.deepEqual(env.renders, []);
    assert.equal(window._lastRenderedChatSig, 'rendered');
  });

  it('焦点 runtime 已切走时，晚到的预热结果不重绘', async () => {
    warmHarness();
    env.modules.templateEngine.warmTemplatesInBackground(['json'], 'runtime-a');
    window.currentRuntimeAgentId = 'runtime-b';
    await tick();
    await tick();
    assert.deepEqual(env.renders, []);
    assert.equal(window._lastRenderedChatSig, 'rendered');
  });
});

describe('P2-4 原行为：overview 与 hook inspector 快照', () => {
  it('extractMessagesProbe 拒绝畸形探测并补齐默认字段', () => {
    const { extractMessagesProbe } = env.modules.overviewData;
    assert.equal(extractMessagesProbe(null), null);
    assert.equal(extractMessagesProbe({ _messagesProbe: { count: -1 } }), null);
    assert.equal(extractMessagesProbe({ _messagesProbe: { count: 1, changeKind: 'bogus' } }), null);
    assert.deepEqual(extractMessagesProbe({ _messagesProbe: { count: 2, changeKind: 'append' } }), {
      seq: 0, count: 2, changeKind: 'append', sinceIndex: null, fakeFullBytes: 0,
    });
  });

  it('normalizeOverviewSnapshot 逐字段重建并丢弃未知键（含探测）', () => {
    const { normalizeOverviewSnapshot } = env.modules.overviewData;
    const snapshot = normalizeOverviewSnapshot({
      updatedAt: 5,
      _messagesProbe: { count: 9, changeKind: 'append' },
      context: { messageCount: 3 },
      usageStats: { totalUsage: { inputTokens: 7 }, calls: [{ id: 'c1' }] },
      runtime: { stage: 'calling', callActive: true },
      modelName: 'deepseek',
    });
    assert.equal(snapshot.updatedAt, 5);
    assert.equal(snapshot.context.messageCount, 3);
    assert.equal(snapshot.context.charCount, 0);
    assert.equal(snapshot.usageStats.totalUsage.inputTokens, 7);
    assert.equal(snapshot.usageStats.calls[0].cacheHitRequests, 0);
    assert.equal(snapshot.runtime.stage, 'calling');
    assert.equal(snapshot.modelName, 'deepseek');
    assert.equal('_messagesProbe' in snapshot, false);
  });

  it('normalizeHookInspector 补全生命周期顺序并过滤越界 skill 路径', () => {
    const { normalizeHookInspector } = env.modules.overviewData;
    const inspector = normalizeHookInspector({
      features: [{
        name: 'f',
        tools: [{ name: 't' }],
        skills: [
          { name: 'ok', path: 'skills/a.md', root: 0 },
          { name: 'abs', path: '/abs.md', root: 0 },
          { name: 'up', path: '../x.md', root: 0 },
          { name: 'noRoot', path: 'b.md', root: 1.5 },
        ],
      }],
      hooks: [{ lifecycle: 'ToolUse', kind: 'guard', entries: [{ id: 'h1' }] }],
    });
    assert.ok(inspector.lifecycleOrder.includes('ToolFinished'));
    assert.deepEqual(inspector.features[0].skills.map((skill) => skill.name), ['ok']);
    assert.equal(inspector.hooks.length, inspector.lifecycleOrder.length);
    assert.deepEqual(inspector.hooks.find((group) => group.lifecycle === 'ToolUse').entries, [{ id: 'h1' }]);
    assert.deepEqual(inspector.hooks.find((group) => group.lifecycle === 'CallStart').entries, []);
  });

  it('shortenSourcePath 优先裁剪 /src/ 再 /AgentDev/', () => {
    const { shortenSourcePath } = env.modules.overviewData;
    assert.equal(shortenSourcePath('D:\\code\\AgentDevClaw\\public\\src\\modules\\a.js'), 'src/modules/a.js');
    assert.equal(shortenSourcePath('/x/AgentDev/packages/core/lib/a.ts'), 'packages/core/lib/a.ts');
    assert.equal(shortenSourcePath(''), '');
  });
});
