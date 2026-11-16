import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** document 桩：`.ph-topic-panel` 查询返回当前挂载的面板集合（测试可增删模拟
 *  innerHTML 重建换面板）。 */
function makeDocumentStub(livePanels) {
  return {
    querySelectorAll(selector) {
      return selector === '.ph-topic-panel' ? livePanels.slice() : [];
    },
    querySelector() { return null; },
    getElementById() { return null; },
    addEventListener() {},
    removeEventListener() {},
    body: { addEventListener() {}, removeEventListener() {} },
    documentElement: {},
    readyState: 'complete',
  };
}

function setup(options = {}) {
  const livePanels = options.livePanels || [];
  const requests = [];
  const savedPhTabState = {};
  const ctx = createFrontendSandbox({
    currentLanguage: 'zh',
    savedPhTabState,
    document: makeDocumentStub(livePanels),
    escapeHtml: (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])),
    formatWorkspaceDate: (value) => String(value || ''),
    URLSearchParams,
    fetch(url) {
      return new Promise((resolve) => requests.push({ url, resolve }));
    },
  });
  ctx.loadSource('public/src/modules/action-dispatcher.js');
  ctx.loadSource('public/src/modules/ph-session-list.js');
  return { ctx, requests, savedPhTabState, livePanels };
}

function makeTopicPanel() {
  return {
    innerHTML: '',
    dataset: { topicAgentId: 'programming-helper', topicProjectId: '', topicDirectory: 'D:/project' },
  };
}

/** 最小 tab group stub：记录 active class 切换结果，panel 查询返回给定面板。 */
function makeTabGroup(panel) {
  const state = { activeTab: null, activePanel: null };
  const tabs = ['sessions', 'topics'].map((name) => ({
    dataset: { phTab: name },
    classList: { toggle(_cls, on) { if (on) state.activeTab = name; } },
  }));
  const panels = ['sessions', 'topics'].map((name) => ({
    dataset: { phPanel: name },
    classList: { toggle(_cls, on) { if (on) state.activePanel = name; } },
  }));
  return {
    dataset: { tabGroup: 'ph-main' },
    state,
    querySelectorAll(selector) {
      if (selector === '.ph-session-tab') return tabs;
      if (selector === '.ph-session-tab-panel') return panels;
      return [];
    },
    querySelector(selector) { return selector === '.ph-topic-panel' ? panel : null; },
  };
}

describe('programming-helper Topic board', () => {
  it('loads recent groups from topic_groups with title+summary as the card body, conversations folded', async () => {
    const panel = makeTopicPanel();
    const { ctx, requests } = setup({ livePanels: [panel] });
    const pending = ctx.window.ensurePhTopicGroups(panel);
    await new Promise(setImmediate);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/protoclaw\/topic_groups/);
    assert.doesNotMatch(requests[0].url, /group_chats/);
    requests[0].resolve({ ok: true, status: 200, json: async () => ({
      partial: false,
      groups: [
        { id: 'relation_recent', title: 'Topic 看板（自定义）', customTitle: true, summary: '一句话简介', updatedAt: '2026-11-15T14:32:00Z', memberCount: 2, threads: [
          { threadId: 'wt-new', title: '最近主题', updatedAt: '2026-11-15T14:32:00Z', sessionIds: ['s-new'] },
        ] },
        { id: 'relation-older', title: '较早主题', customTitle: false, summary: '', updatedAt: '2026-11-14T10:00:00Z', memberCount: 1, threads: [
          { threadId: 'wt-old', title: '较早主题', updatedAt: '2026-11-14T10:00:00Z', sessionIds: ['s-old'] },
        ] },
      ],
    }) });
    await pending;
    const html = panel.innerHTML;
    assert.ok(html.indexOf('Topic 看板（自定义）') < html.indexOf('较早主题'), 'keeps server order');
    assert.match(html, /data-topic-id="relation_recent"/);
    // 卡片主体：主题标题来自 group.title（服务端已合并标注/回退），简介是正文。
    assert.match(html, /class="ph-topic-summary">一句话简介</);
    // 无简介的主题显示弱化占位，不渲染空段落噪音。
    assert.match(html, /ph-topic-summary-empty">暂无简介</);
    // 对话明细折叠在 details 中：默认收起，标记主题的对话仍可打开。
    assert.match(html, /<details class="ph-topic-details">/);
    assert.match(html, /ph-topic-details-toggle">对话列表 \(1\)</);
    assert.match(html, /data-workspace-action="{&quot;type&quot;:&quot;open_session&quot;,&quot;sessionId&quot;:&quot;s-new&quot;}"/);
  });

  it('race: workspace innerHTML rebuild swaps the live panel mid-load; data lands in the live panel, no stranded placeholder', async () => {
    // 真实缺陷（正式服务复现）：切回工作空间 → 记忆回放触发加载；fetch 在途时
    // 会话数据到达触发工作区 innerHTML 重建，面板元素被替换。旧实现把完成渲染
    // 写进捕获的旧面板（已脱离 DOM），新面板的加载又被 loading 守卫吞掉——
    // 留在页面上的面板永远停在占位文案。
    const panelA = makeTopicPanel();
    const { ctx, requests, livePanels } = setup({ livePanels: [panelA] });
    const first = ctx.window.ensurePhTopicGroups(panelA);
    await new Promise(setImmediate);
    assert.equal(requests.length, 1);
    assert.match(panelA.innerHTML, /正在加载 Topic/);
    // 在途：工作区重建，面板元素 A 被替换为同身份键的 B（模板重渲染）
    const panelB = makeTopicPanel();
    livePanels.length = 0;
    livePanels.push(panelB);
    // 新面板的记忆回放再次触发加载 → 在途请求按身份键去重，不重复发
    ctx.window.ensurePhTopicGroups(panelB);
    await new Promise(setImmediate);
    assert.equal(requests.length, 1, 'in-flight load is deduped by identity key');
    // fetch 完成：数据必须渲染进当前挂载的 B
    requests[0].resolve({ ok: true, status: 200, json: async () => ({ groups: [
      { id: 'g-live', title: '存活面板应收到数据', updatedAt: '2026-11-16T02:00:00Z', memberCount: 1, threads: [] },
    ] }) });
    await first;
    await new Promise(setImmediate);
    assert.match(panelB.innerHTML, /data-topic-id="g-live"/, 'data renders into the live panel');
    assert.ok(!panelB.innerHTML.includes('切换到 Topics'), 'no stranded placeholder on the live panel');
    // 状态已就位：后续模板重建（轮询）直接呈现缓存卡片，不闪占位
    assert.match(ctx.window.phTopicPanelInnerHtml('programming-helper', '', 'D:/project'), /data-topic-id="g-live"/);
  });

  it('panel initial content follows state: placeholder before load, loading while in flight, empty-state only after a loaded-but-empty fetch', async () => {
    const { ctx, requests, livePanels } = setup({ livePanels: [] });
    const agentId = 'programming-helper';
    const dir = 'D:/state';
    // 未加载：占位提示（引导切到 Topics），不是「暂无主题」
    assert.match(ctx.window.phTopicPanelInnerHtml(agentId, '', dir), /切换到 Topics 后加载/);
    const panel = {
      innerHTML: '',
      dataset: { topicAgentId: agentId, topicProjectId: '', topicDirectory: dir },
    };
    livePanels.push(panel);
    const pending = ctx.window.ensurePhTopicGroups(panel);
    await new Promise(setImmediate);
    // 在途：加载中
    assert.match(ctx.window.phTopicPanelInnerHtml(agentId, '', dir), /正在加载 Topic/);
    requests[0].resolve({ ok: true, status: 200, json: async () => ({ groups: [] }) });
    await pending;
    // 已加载且为空：空态文案（不得回退成占位）
    assert.match(ctx.window.phTopicPanelInnerHtml(agentId, '', dir), /暂无关联主题/);
  });

  it('tab replay (restore path) presents topics as active and loads groups — not just class toggle', async () => {
    // 缺陷报告：从其他工作空间/页面切回时，记忆回放只切了 active class，
    // topics 面板停留在「切换到 Topics 后加载」占位。回放必须与点击等价地
    // 触发懒加载；同时回放自身不得写记忆（它是记忆的读取方）。
    const { ctx, requests, savedPhTabState } = setup({ livePanels: [makeTopicPanel()] });
    const panel = makeTopicPanel();
    const tg = makeTabGroup(panel);
    ctx.window.applyPhSessionTabDom(tg, 'topics');
    assert.equal(tg.state.activeTab, 'topics', 'tab button gets active class');
    assert.equal(tg.state.activePanel, 'topics', 'panel gets active class');
    assert.equal(requests.length, 1, 'topic groups fetch is issued during replay');
    assert.match(requests[0].url, /\/protoclaw\/topic_groups/);
    assert.deepEqual(Object.keys(savedPhTabState), [], 'replay must not write tab memory');
  });

  it('clicking the topics tab records memory and triggers the same load', async () => {
    const { ctx, requests, savedPhTabState } = setup({ livePanels: [makeTopicPanel()] });
    const panel = makeTopicPanel();
    const tg = makeTabGroup(panel);
    ctx.window.switchPhSessionTab({ dataset: { phTab: 'topics' }, closest: () => tg });
    assert.equal(savedPhTabState['ph-main'], 'topics', 'user choice is recorded for later restore');
    assert.equal(tg.state.activePanel, 'topics');
    assert.equal(requests.length, 1, 'click path issues the same topic groups load');
    assert.match(requests[0].url, /\/protoclaw\/topic_groups/);
  });

  it('workspace template sources the topic panel content from the state-aware helper', () => {
    // 模板（session-list-render.js）不得内联静态占位：工作区重建时已加载的数据
    // 会闪回占位文案。以源码断言锁住模板与状态助手的接线。
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'src', 'modules', 'session-list-render.js'), 'utf8');
    assert.ok(src.includes('window.phTopicPanelInnerHtml'), 'template must render topic panel via phTopicPanelInnerHtml');
  });
});
