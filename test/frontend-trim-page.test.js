import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function makeElement() {
  const listeners = new Map();
  const classes = new Set();
  return {
    listeners,
    style: {},
    dataset: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
      contains: (name) => classes.has(name),
    },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    dispatch(type, event = {}) {
      for (const callback of listeners.get(type) || []) callback(event);
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    closest() { return null; },
    scrollIntoView() {},
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
  };
}

function createTrimPage(fetchImpl, coreOverrides = {}, extraGlobals = {}) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    },
  };
  const ctx = createFrontendSandbox({
    document,
    window: {
      document,
      localStorage: { getItem: () => null, setItem() {} },
      alert() {},
      TrimRatioCore: {
        safeCutCandidates: (messages) => messages.map((m, cutIndex) => ({ cutIndex, roundBoundary: m.role === 'user' })),
        ratioToCut: () => ({ cutIndex: 3, unmet: false }),
        cutToRatio: () => 0.3,
        computeReadout: () => ({ releasedPercent: 0.7, keptPercent: 0.3, keptCharCount: 30, totalCharCount: 100, keptMessageCount: 3 }),
        keepZoneHasDialogue: (messages, cutIndex) =>
          messages.slice(cutIndex).some((m) => m.role === 'user' || m.role === 'assistant'),
        ...coreOverrides,
      },
    },
    fetch: fetchImpl || (async () => ({
      ok: true,
      json: async () => ({
        preamblePercent: 0.1,
        preambleCharCount: 10,
        rounds: [
          { userPreview: 'first', assistantPreview: 'reply 1', charPercent: 0.25, cumulativePercent: 0.25, suggestedTrim: false, turnStart: 1, msgIndexStart: 0, msgIndexEnd: 2, toolCalls: [] },
          { userPreview: 'second', assistantPreview: 'reply 2', charPercent: 0.25, cumulativePercent: 0.5, suggestedTrim: false, turnStart: 2, msgIndexStart: 3, msgIndexEnd: 4, toolCalls: [] },
        ],
        messages: [
          { index: 0, role: 'user', roundIndex: 0, preview: 'first', charCount: 10, contentCharCount: 10 },
          { index: 1, role: 'assistant', roundIndex: 0, preview: '', charCount: 5, contentCharCount: 0, toolCalls: [{ id: 'a', name: 'read', summary: 'read(a)' }] },
          { index: 2, role: 'tool', roundIndex: 0, charCount: 20, contentCharCount: 0, toolCallId: 'a' },
          { index: 3, role: 'assistant', roundIndex: 0, preview: 'assistant anchor', charCount: 10, contentCharCount: 10 },
          { index: 4, role: 'user', roundIndex: 1, preview: 'second', charCount: 10, contentCharCount: 10 },
          { index: 5, role: 'assistant', roundIndex: 1, preview: 'reply 2', charCount: 10, contentCharCount: 10 },
        ],
      }),
    })),
    closeCompactMenu() {},
    currentLanguage: 'zh',
    fmtPct: (frac) => (frac * 100).toFixed(1) + '%', // app-core 全局的沙箱替身
    ...extraGlobals,
  });
  ctx.loadSource('public/src/modules/trim-page.js');
  return { ctx, elements };
}

const clickEvent = (selector, target) => ({ target: { closest: (query) => query === selector ? target : null } });

describe('trim page timeline interactions', () => {
  it('keeps the round action visible under the timeline node selector', async () => {
    const css = fs.readFileSync(new URL('../public/styles/components.css', import.meta.url), 'utf8');
    assert.match(css, /\.trim-tl-node\.manual \.trim-to-here-btn\s*\{[^}]*opacity:\s*1/s);
  });

  it('renders exactly one in-round cut marker immediately after a ratio slider update', async () => {
    const { ctx, elements } = createTrimPage();
    await ctx.window.openTrimPage('programming-helper', 'session-1');
    const mode = elements.get('trim-page-mode');
    const ratioButton = { dataset: { mode: 'ratio' } };
    mode.dispatch('click', clickEvent('.trim-page-mode-btn', ratioButton));
    const slider = elements.get('trim-page-ratio-slider');
    slider.value = '30';
    slider.dispatch('input');

    const html = elements.get('trim-page-list').innerHTML;
    assert.equal((html.match(/class="trim-tl-cut"/g) || []).length, 1, 'in-round cut marker must be present exactly once');
    assert.match(html, /assistant anchor/, 'cut context around the assistant message must be rendered');
    assert.match(html, /保留从这里开始/);
    assert.match(html, /第 1 轮 · 1 次调用/, 'collapsed round rows report a call count instead of tool names');
  });

  it('places the cut marker after the matching assistant anchor inside the round', async () => {
    const { ctx, elements } = createTrimPage();
    await ctx.window.openTrimPage('programming-helper', 'session-1');
    elements.get('trim-page-mode').dispatch('click', clickEvent('.trim-page-mode-btn', { dataset: { mode: 'ratio' } }));
    const slider = elements.get('trim-page-ratio-slider');
    slider.value = '30';
    slider.dispatch('input');

    const html = elements.get('trim-page-list').innerHTML;
    assert.equal((html.match(/class="trim-tl-cut"/g) || []).length, 1);
    assert.match(html, /class="trim-tl-chip"[^>]*>read · 20<\/button><div class="trim-tl-cut">[\s\S]*?<div class="trim-tl-dnode text">assistant anchor/);
  });

  it('adjusts the ratio with the mouse wheel over the slider', async () => {
    const { ctx, elements } = createTrimPage();
    await ctx.window.openTrimPage('programming-helper', 'session-1');
    elements.get('trim-page-mode').dispatch('click', clickEvent('.trim-page-mode-btn', { dataset: { mode: 'ratio' } }));
    const slider = elements.get('trim-page-ratio-slider');
    assert.equal(slider.value, '30');

    slider.dispatch('wheel', { deltaY: -100, preventDefault() {} });
    assert.equal(slider.value, '31', 'wheel up increments the ratio');

    slider.dispatch('wheel', { deltaY: 120, preventDefault() {} });
    assert.equal(slider.value, '30', 'wheel down decrements the ratio');
    assert.equal(elements.get('trim-page-ratio-input').value, '30', 'number input stays in sync');
  });

  it('keeps the viewport still on re-render while the cut stays inside the safe zone', async () => {
    const { ctx, elements } = createTrimPage();
    await ctx.window.openTrimPage('programming-helper', 'session-1');
    elements.get('trim-page-mode').dispatch('click', clickEvent('.trim-page-mode-btn', { dataset: { mode: 'ratio' } }));
    const list = elements.get('trim-page-list');
    const scrollBody = {
      scrollTop: 80,
      getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
    };
    list.closest = () => scrollBody;
    // 切点位于视口中部（安全区内）：重绘后视口纹丝不动
    list.querySelector = () => ({
      offsetTop: 40,
      getBoundingClientRect: () => ({ top: 250, bottom: 270 }),
      scrollIntoView() {},
    });

    const slider = elements.get('trim-page-ratio-slider');
    slider.value = '30';
    slider.dispatch('input');
    slider.dispatch('wheel', { deltaY: -100, preventDefault() {} });
    slider.dispatch('wheel', { deltaY: -100, preventDefault() {} });

    assert.equal(scrollBody.scrollTop, 80, 'algorithmic adjustments never pan the list while the cut is visible');
  });

  it('nudges the scroll minimally when the cut approaches the viewport edge', async () => {
    const { ctx, elements } = createTrimPage();
    await ctx.window.openTrimPage('programming-helper', 'session-1');
    elements.get('trim-page-mode').dispatch('click', clickEvent('.trim-page-mode-btn', { dataset: { mode: 'ratio' } }));
    const list = elements.get('trim-page-list');
    const scrollBody = {
      scrollTop: 80,
      getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
    };
    list.closest = () => scrollBody;
    // 第一次查询（重绘前 hadCut）也返回元素，模拟切点已存在；重绘后
    // 切点被内容顶到视口上方 100px → 以最小滚动量带回上缘安全区
    let queries = 0;
    list.querySelector = () => {
      queries += 1;
      return {
        offsetTop: 40,
        getBoundingClientRect: () => queries <= 1 ? { top: 300, bottom: 320 } : { top: -100, bottom: -80 },
        scrollIntoView() {},
      };
    };

    const slider = elements.get('trim-page-ratio-slider');
    slider.value = '30';
    slider.dispatch('input');

    // margin = 600 * 0.15 = 90；cut top -100 < 90 → scrollTop 80 + (-100-90) → 钳 0
    assert.equal(scrollBody.scrollTop, 0, 'cut above the viewport scrolls back just enough to reveal it');
  });

  it('keeps the viewport still when the user clicks a node to set the cut', async () => {
    const { ctx, elements } = createTrimPage();
    await ctx.window.openTrimPage('programming-helper', 'session-1');
    elements.get('trim-page-mode').dispatch('click', clickEvent('.trim-page-mode-btn', { dataset: { mode: 'ratio' } }));
    const list = elements.get('trim-page-list');
    const scrollBody = { scrollTop: 80 };
    list.closest = () => scrollBody;
    list.querySelector = () => ({ offsetTop: 40, scrollIntoView() {} });

    const target = { dataset: { setCut: '4' } };
    list.dispatch('click', clickEvent('[data-set-cut]', target));

    assert.equal(scrollBody.scrollTop, 80, 'clicking to set the cut must not pan the list');
    assert.equal(elements.get('trim-page-ratio-slider').value, String(Math.round(0.3 * 100)));
  });

  it('restores the round-level 精简到此处 operation', async () => {
    const { ctx, elements } = createTrimPage();
    await ctx.window.openTrimPage('programming-helper', 'session-1');
    const list = elements.get('trim-page-list');
    assert.match(list.innerHTML, /class="trim-to-here-btn"[^>]*data-trim-to="1"/);

    const target = { dataset: { trimTo: '1' } };
    list.dispatch('click', clickEvent('.trim-to-here-btn[data-trim-to]', target));
    assert.equal((list.innerHTML.match(/ checked/g) || []).length, 2, '精简到此处 marks this round and earlier rounds');
    assert.match(list.innerHTML, /精简到此处/);
  });

  it('derives the submit label from the current toggles, not the entry point', async () => {
    const { ctx, elements } = createTrimPage();
    const submit = elements.get('trim-page-submit');
    const summary = elements.get('trim-page-summary-toggle');
    const archive = elements.get('trim-page-archive-toggle');

    // 普通入口：默认两个勾选都空 → 基础文案
    await ctx.window.openTrimPage('programming-helper', 'session-1');
    assert.equal(submit.textContent, '确认精简');

    // 勾选摘要 → 文案跟随；再勾归档 → 组合文案
    summary.checked = true;
    summary.dispatch('change');
    assert.equal(submit.textContent, '精简并生成摘要');
    archive.checked = true;
    archive.dispatch('change');
    assert.equal(submit.textContent, '精简、生成摘要并归档');
    summary.checked = false;
    summary.dispatch('change');
    assert.equal(submit.textContent, '精简并归档');
    archive.checked = false;
    archive.dispatch('change');
    assert.equal(submit.textContent, '确认精简');

    // 归档入口：初始勾上归档（入口形态只决定初始勾选，不锁死按钮）
    await ctx.window.openTrimPage('programming-helper', 'session-1', true);
    assert.equal(submit.textContent, '精简并归档');
    assert.equal(archive.checked, true);
    archive.checked = false;
    archive.dispatch('change');
    assert.equal(submit.textContent, '确认精简');
  });
});

describe('trim page keep-zone dialogue guard', () => {
  // 打断/任务提醒注入形态：末轮工具结果之后跟一条 system 注入消息。
  // 其后的切点保留区不含任何对话消息——提交后末轮对话全部被折叠
  // （实测事故：handoff preservedMsgRanges=[[277,277]]）。
  const payloadWithMessages = (messages) => ({
    preamblePercent: 0.1,
    preambleCharCount: 10,
    rounds: [{ userPreview: 'task', assistantPreview: '', charPercent: 0.8, cumulativePercent: 0.8, suggestedTrim: false, turnStart: 1, msgIndexStart: 0, msgIndexEnd: messages.length - 1, toolCalls: [] }],
    messages,
  });
  const fetchWith = (payload) => async () => ({ ok: true, json: async () => payload });

  it('renders the tail tool chip as a plain span when the keep zone holds only the injected system message', async () => {
    const messages = [
      { index: 0, role: 'user', roundIndex: 0, preview: 'task', charCount: 10, contentCharCount: 10 },
      { index: 1, role: 'assistant', roundIndex: 0, preview: '', charCount: 5, contentCharCount: 0, toolCalls: [{ id: 'a', name: 'edit', summary: 'edit(a)' }] },
      { index: 2, role: 'tool', roundIndex: 0, charCount: 20, contentCharCount: 0, toolCallId: 'a' },
      { index: 3, role: 'assistant', roundIndex: 0, preview: '', charCount: 5, contentCharCount: 0, toolCalls: [{ id: 'b', name: 'write', summary: 'write(b)' }] },
      { index: 4, role: 'tool', roundIndex: 0, charCount: 20, contentCharCount: 0, toolCallId: 'b' },
      { index: 5, role: 'system', roundIndex: 0, charCount: 15, contentCharCount: 15 },
    ];
    const { ctx, elements } = createTrimPage(fetchWith(payloadWithMessages(messages)));
    await ctx.window.openTrimPage('programming-helper', 'session-1');
    elements.get('trim-page-mode').dispatch('click', clickEvent('.trim-page-mode-btn', { dataset: { mode: 'ratio' } }));
    // 切点 3 入轮内：detail 展开，唯一工具段 chip cutIndex=5——保留区 [5,6) 仅 system
    const html = elements.get('trim-page-list').innerHTML;
    assert.doesNotMatch(html, /data-set-cut="5"/, 'chip after the last dialogue message must not be clickable');
    assert.match(html, /<span class="trim-tl-chip">/, 'the guarded chip falls back to a plain span');
  });

  it('keeps the chip clickable when dialogue text follows in the keep zone', async () => {
    const messages = [
      { index: 0, role: 'user', roundIndex: 0, preview: 'task', charCount: 10, contentCharCount: 10 },
      { index: 1, role: 'assistant', roundIndex: 0, preview: '', charCount: 5, contentCharCount: 0, toolCalls: [{ id: 'a', name: 'edit', summary: 'edit(a)' }] },
      { index: 2, role: 'tool', roundIndex: 0, charCount: 20, contentCharCount: 0, toolCallId: 'a' },
      { index: 3, role: 'assistant', roundIndex: 0, preview: '', charCount: 5, contentCharCount: 0, toolCalls: [{ id: 'b', name: 'write', summary: 'write(b)' }] },
      { index: 4, role: 'tool', roundIndex: 0, charCount: 20, contentCharCount: 0, toolCallId: 'b' },
      { index: 5, role: 'assistant', roundIndex: 0, preview: 'done', charCount: 10, contentCharCount: 10 },
      { index: 6, role: 'system', roundIndex: 0, charCount: 15, contentCharCount: 15 },
    ];
    const { ctx, elements } = createTrimPage(fetchWith(payloadWithMessages(messages)));
    await ctx.window.openTrimPage('programming-helper', 'session-1');
    elements.get('trim-page-mode').dispatch('click', clickEvent('.trim-page-mode-btn', { dataset: { mode: 'ratio' } }));
    // 同一切点下工具段 chip cutIndex=5 保留区含 assistant[5] → 可点击
    assert.match(elements.get('trim-page-list').innerHTML, /data-set-cut="5"/);
  });

  it('blocks submission when the keep zone holds no dialogue message', async () => {
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      return { ok: true, json: async () => payloadWithMessages([
        { index: 0, role: 'user', roundIndex: 0, preview: 'task', charCount: 10, contentCharCount: 10 },
        { index: 1, role: 'assistant', roundIndex: 0, preview: 'reply', charCount: 10, contentCharCount: 10 },
        { index: 2, role: 'tool', roundIndex: 0, charCount: 20, contentCharCount: 0, toolCallId: 'a' },
        { index: 3, role: 'system', roundIndex: 0, charCount: 15, contentCharCount: 15 },
      ]) };
    };
    const { ctx, elements } = createTrimPage(fetchImpl, { ratioToCut: () => ({ cutIndex: 3, unmet: false }) });
    const alerts = [];
    ctx.window.alert = (message) => alerts.push(String(message));
    await ctx.window.openTrimPage('programming-helper', 'session-1');
    elements.get('trim-page-mode').dispatch('click', clickEvent('.trim-page-mode-btn', { dataset: { mode: 'ratio' } }));
    const callsAfterOpen = fetchCalls;
    await ctx.window.submitTrimPage();
    assert.ok(alerts.some((m) => m.includes('对话')), `expected a dialogue-guard alert, got: ${alerts.join(' | ')}`);
    assert.equal(fetchCalls, callsAfterOpen, 'submission must not fire any request past the guard');
  });
});

describe('trim page stale response guard', () => {
  const roundOf = (preview) => ({
    userPreview: preview, assistantPreview: '', charPercent: 0.2, cumulativePercent: 0.2,
    suggestedTrim: false, turnStart: 1, msgIndexStart: 0, msgIndexEnd: 0, toolCalls: [],
  });
  const payloadOf = (preview) => ({
    preamblePercent: 0.1, preambleCharCount: 10,
    rounds: [roundOf(preview)],
    messages: [{ index: 0, role: 'user', roundIndex: 0, preview, charCount: 10, contentCharCount: 10 }],
  });

  /** 可控 fetch：按 URL 分桶，响应经 deferred 手动放行（复刻 A 慢 B 快）。 */
  function deferredFetch() {
    const pending = [];
    return {
      pending,
      impl: (url) => {
        const forA = String(url).includes('session-A');
        let settle;
        const response = new Promise((resolve) => { settle = resolve; });
        pending.push({ forA, settle });
        return response;
      },
      respond: (forA, payload) => {
        const d = pending.find((item) => item.forA === forA);
        assert.ok(d, 'no pending fetch for this bucket');
        d.settle({ ok: true, json: async () => payload });
      },
    };
  }

  it('drops the slow session-A response after the page reopened for session B', async () => {
    const { impl, respond } = deferredFetch();
    const { ctx, elements } = createTrimPage(impl);
    const openA = ctx.window.openTrimPage('programming-helper', 'session-A');
    const openB = ctx.window.openTrimPage('programming-helper', 'session-B');
    respond(false, payloadOf('B-round'));
    await openB;
    respond(true, payloadOf('A-round')); // A 的慢响应最后落地
    await openA;

    const html = elements.get('trim-page-list').innerHTML;
    assert.match(html, /B-round/);
    assert.doesNotMatch(html, /A-round/, '过期会话的数据不允许覆盖当前页面');
  });

  it('drops the late response after the page is closed', async () => {
    const { impl, respond } = deferredFetch();
    const { ctx, elements } = createTrimPage(impl);
    const openA = ctx.window.openTrimPage('programming-helper', 'session-A');
    ctx.window.closeTrimPage();
    respond(true, payloadOf('A-round'));
    await openA;

    const html = elements.get('trim-page-list').innerHTML;
    assert.doesNotMatch(html, /A-round/, '关闭后迟到的响应不渲染');
    assert.doesNotMatch(html, /加载失败/, '过期响应的报错不落到页面上');
  });
});

describe('trim page submit: thread succession vs session navigation', () => {
  // ADR-0032：线程会话的手动精简是同一对话内的上下文接力——响应
  // threadSuccession.applied=true 时视图不导航，refreshThreads 事实对账经
  // thread-store 唯一重绑原地换头；非线程会话（存量未迁移）维持
  // requestSwitch 跳转（Session 语义，行为不变）。
  const submitDeps = (compactResult) => {
    const calls = { requestSwitch: 0, beginChatLoading: 0, refreshThreads: 0, clearSessionLoading: 0, settled: 0 };
    return { calls, overrides: {
      createCompactedResumeSession: async () => compactResult,
      markSessionLoading: () => {},
      clearSessionLoading: () => { calls.clearSessionLoading += 1; },
      bumpNavigationGuard: () => {},
      _navigationGuardEpoch: 1,
      beginSidebarOperation: () => ({ operationId: 'op-1', title: '' }),
      getSidebarOperation: () => ({ operationId: 'op-1', title: '' }),
      updateSidebarOperation: () => {},
      finishSidebarOperation: (_id, status) => { if (status === 'settled') calls.settled += 1; },
      setPreferredUnitMode: () => {},
      beginChatLoadingSession: () => { calls.beginChatLoading += 1; },
      requestSwitch: async () => { calls.requestSwitch += 1; },
      upsertConnectedAgent: (agent) => agent,
      getRuntimeId: (agent) => agent?.id || '',
      renderCurrentMainView: () => {},
      getCurrentAgentRecord: () => null,
      loadAgents: async () => {},
      allAgents: [],
      getWorkspaceSessionById: () => null,
      getPathLeaf: () => '',
      currentRuntimeAgentId: '',
    } };
  };

  const openAndSubmit = async (ctx) => {
    await ctx.window.openTrimPage('programming-helper', 'session-A');
    await ctx.window.submitTrimPage();
  };

  it('thread succession: stays on the view, reconciles via refreshThreads, never navigates', async () => {
    const { calls, overrides } = submitDeps({
      session: { id: 'session-B', title: 'Trimmed' },
      agent: { id: 'rt-B' },
      threadSuccession: { applied: true },
      revision: 3,
    });
    const { ctx } = createTrimPage(null, {}, overrides);
    ctx.window.refreshThreads = async () => { calls.refreshThreads += 1; return { ok: true }; };
    await openAndSubmit(ctx);

    assert.equal(calls.requestSwitch, 0, 'thread succession must not navigate');
    assert.equal(calls.beginChatLoading, 0, 'no chat-loading navigation shell');
    assert.ok(calls.refreshThreads >= 1, 'refreshThreads reconciliation must run');
    assert.ok(calls.clearSessionLoading >= 1, 'session loading flag must be cleared');
    assert.ok(calls.settled >= 1, 'sidebar operation settles');
  });

  it('non-thread session: keeps the requestSwitch navigation (unchanged legacy path)', async () => {
    const { calls, overrides } = submitDeps({
      session: { id: 'session-B', title: 'Trimmed' },
      agent: { id: 'rt-B' },
      threadSuccession: { applied: false, reason: 'no_thread_for_session' },
      revision: 3,
    });
    const { ctx } = createTrimPage(null, {}, overrides);
    ctx.window.refreshThreads = async () => { calls.refreshThreads += 1; return { ok: true }; };
    await openAndSubmit(ctx);

    assert.equal(calls.requestSwitch, 1, 'legacy sessions keep the navigation switch');
    assert.equal(calls.refreshThreads, 0, 'thread reconciliation must not run for plain sessions');
  });
});

describe('trim page archive option vs thread-carried sessions (ADR-0032)', () => {
  // 契约：线程会话的精简是同对话内上下文接力，「归档原会话」是 Session
  // 时代的列表语义（归档链中旧快照无可见效果）——选项不得出现，提交也
  // 不得携带归档；非线程/索引未就绪会话保持原行为。
  const archiveOptionDeps = (compactResult, captured) => ({
    createCompactedResumeSession: async (_agentId, _sessionId, _strategy, _a, _b, _policy, options) => {
      captured.options = options;
      return compactResult;
    },
    markSessionLoading: () => {},
    clearSessionLoading: () => {},
    bumpNavigationGuard: () => {},
    _navigationGuardEpoch: 1,
    beginSidebarOperation: () => ({ operationId: 'op-1', title: '' }),
    getSidebarOperation: () => ({ operationId: 'op-1', title: '' }),
    updateSidebarOperation: () => {},
    finishSidebarOperation: () => {},
    renderCurrentMainView: () => {},
    getCurrentAgentRecord: () => null,
    loadAgents: async () => {},
    allAgents: [],
    getWorkspaceSessionById: () => null,
    getPathLeaf: () => '',
    currentRuntimeAgentId: '',
  });

  it('thread session: hides the archive row and never submits archiveOriginal', async () => {
    const captured = {};
    const overrides = archiveOptionDeps({ session: { id: 'session-B' }, threadSuccession: { applied: true }, revision: 1 }, captured);
    const { ctx, elements } = createTrimPage(null, {}, overrides);
    // thread-store 挂载形态：window.isThreadHostAgentId（真实前端全局）
    ctx.window.isThreadHostAgentId = () => true;
    ctx.window.refreshThreads = async () => ({ ok: true });

    // 入口带归档意图（archiveAfter=true）也被钳制：初始不勾选
    await ctx.window.openTrimPage('programming-helper', 'session-A', true);
    assert.equal(elements.get('trim-page-archive-row').style.display, 'none', 'archive row must be hidden for thread sessions');
    assert.equal(elements.get('trim-page-archive-toggle').checked, false, 'archive toggle starts unchecked');

    // 线程索引在打开后才就绪的竞态：强行勾上，提交仍不得归档
    elements.get('trim-page-archive-toggle').checked = true;
    await ctx.window.submitTrimPage();
    assert.equal(captured.options?.archiveOriginal, false, 'submit clamps archiveOriginal for thread sessions');
  });

  it('non-thread session: keeps the archive row and entry-provided initial state', async () => {
    const overrides = archiveOptionDeps({ session: { id: 'session-B' }, revision: 1 }, {});
    const { ctx, elements } = createTrimPage(null, {}, overrides);
    ctx.window.isThreadHostAgentId = () => false;
    ctx.window.refreshThreads = async () => ({ ok: true });

    await ctx.window.openTrimPage('agent-studio', 'session-S');
    assert.notEqual(elements.get('trim-page-archive-row').style.display, 'none', 'archive row stays visible for plain sessions');

    await ctx.window.openTrimPage('agent-studio', 'session-S', true);
    assert.equal(elements.get('trim-page-archive-toggle').checked, true, 'entry archive intent is honored for plain sessions');
  });
});
