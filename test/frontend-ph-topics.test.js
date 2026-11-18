/**
 * programming-helper Topic 看板行为。
 *
 * 装载路线（P2 W2-8 测试改造）：ph-session-list 已迁 ESM → withP2EsmCase
 * 真实 import（每 case 一张图，模块状态不跨用例）。classic 侧仍真实
 * loadSource 跑 action-dispatcher（动作注册）与 app-core（p2-bootstrap 工厂
 * 与 i18n 桥初值）；断言改为调用命名导出（模块真实调用路径），面板内容仍
 * 以可观察 DOM（innerHTML）与请求形状断言。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PH_SESSION_LIST = 'public/src/modules/ph-session-list.js';

/** 最小元素桩：app-core 装载期按 id 取到的引用必须稳定（元素从不替换）。 */
function makeElement(id = '') {
  return {
    id,
    innerHTML: '',
    textContent: '',
    style: {},
    dataset: {},
    hidden: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    insertBefore() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };
}

/** document 桩：`.ph-topic-panel` 查询返回当前挂载的面板集合（测试可增删模拟
 *  innerHTML 重建换面板）；其余 id 查询返回稳定元素。 */
function makeDocumentStub(livePanels) {
  const byId = new Map();
  return {
    querySelectorAll(selector) {
      return selector === '.ph-topic-panel' ? livePanels.slice() : [];
    },
    querySelector() { return null; },
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeElement(id));
      return byId.get(id);
    },
    createElement() { return makeElement(); },
    createTextNode(text) { return { textContent: text }; },
    addEventListener() {},
    removeEventListener() {},
    body: makeElement('body'),
    head: makeElement('head'),
    documentElement: makeElement('html'),
    readyState: 'complete',
    activeElement: null,
  };
}

async function setup({ livePanels = [] } = {}, probe) {
  const requests = [];
  const document = makeDocumentStub(livePanels);
  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      // app-core 提供 createP2BootstrapPhSessionHost / createP2BootstrapDomHost
      // 工厂与 i18n-environment 桥键初值；ESM 图上层的 classic 宿主函数用最小
      // 替身（本用例只消费会话列表与话题面板）。
      sandbox.loadSource('public/src/app-core.js');
      // ESM 图在模块求值期读取的 loader host 工厂：本用例只消费会话列表 /
      // 话题面板，其余宿主面按最小契约注入（不重写其实现）。
      sandbox.run(`
        renderCurrentMainView = function () {};
        getCurrentAgentRecord = function () { return null; };
        createAgentSnapshotLoaderHost = () => ({ state: {} });
        createRuntimeSwitchHost = () => ({ state: {} });
        createWorkspaceSurfaceHost = () => ({ state: {} });
        createCompactResumeHost = () => ({ state: {}, now: () => Date.now() });
        createAgentCallStatesHost = () => ({ state: {} });
        createSessionViewCommitHost = () => ({ state: {} });
        createP2BootstrapSidebarRenderHost = () => ({ lastAgentListRenderSignature: '' });
        // 轮询协调器宿主（classic app-main 工厂）：ESM 图经 agent-data-loader →
        // input-actions 触达 poll-coordinator-host，后者在模块求值期取该工厂。
        createPollCoordinatorHost = () => ({
          run: async () => {}, fastInterval: () => 1000, setTimeout: () => 0, clearTimeout: () => {},
        });
      `);
    },
    globals: {
      document,
      URLSearchParams,
      fetch(url) {
        return new Promise((resolve) => requests.push({ url: String(url), resolve }));
      },
    },
  }, async (c) => {
    const list = await c.load(PH_SESSION_LIST);
    return probe({
      c,
      list,
      requests,
      livePanels,
      // classic 顶层 let：经沙箱求值读真实绑定（不是副本）
      savedPhTabState: c.read('savedPhTabState'),
    });
  });
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
    await setup({ livePanels: [panel] }, async ({ list, requests }) => {
      const pending = list.ensurePhTopicGroups(panel);
      await new Promise(setImmediate);
      assert.equal(requests.length, 1);
      assert.match(requests[0].url, /\/protoclaw\/topic_groups/);
      assert.doesNotMatch(requests[0].url, /group_chats/);
      requests[0].resolve({ ok: true, status: 200, json: async () => ({
        partial: false,
        groups: [
          { id: 'relation_recent', title: 'Topic 看板（自定义）', customTitle: true, summary: '一句话简介', updatedAt: '2026-11-15T14:32:00Z', memberCount: 2,
            docs: ['docs/adr/0047-lease.md — 租约决策', 'https://example.com/topic-plan'], commits: ['55f981a6 主题标注风格落成技能'],
            threads: [
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
      // 锚点条带：docs / commits 条目跟在简介后；URL 条目渲染为外链，
      // 其余为纯文本；无条目的卡片不渲染条带（不占位）。
      const recentCard = html.slice(html.indexOf('data-topic-id="relation_recent"'), html.indexOf('data-topic-id="relation-older"'));
      assert.match(recentCard, /ph-topic-field-label">参考文档</);
      assert.match(recentCard, /<span class="ph-topic-anchor-item" title="docs\/adr\/0047-lease\.md — 租约决策">/);
      assert.match(recentCard, /<a class="ph-topic-anchor-item" href="https:\/\/example\.com\/topic-plan" target="_blank" rel="noopener noreferrer"/);
      assert.match(recentCard, /ph-topic-field-label">相关提交</);
      assert.match(recentCard, /55f981a6 主题标注风格落成技能/);
      const olderCard = html.slice(html.indexOf('data-topic-id="relation-older"'));
      assert.ok(!olderCard.includes('ph-topic-field'), 'cards without anchor entries render no anchor block');
      // 对话明细折叠在 details 中：默认收起，标记主题的对话仍可打开。
      assert.match(html, /<details class="ph-topic-details">/);
      assert.match(html, /ph-topic-details-toggle">对话列表 \(1\)</);
      assert.match(html, /data-workspace-action="\{&quot;type&quot;:&quot;open_session&quot;,&quot;sessionId&quot;:&quot;s-new&quot;\}"/);
    });
  });

  it('race: workspace innerHTML rebuild swaps the live panel mid-load; data lands in the live panel, no stranded placeholder', async () => {
    // 真实缺陷（正式服务复现）：切回工作空间 → 记忆回放触发加载；fetch 在途时
    // 会话数据到达触发工作区 innerHTML 重建，面板元素被替换。旧实现把完成渲染
    // 写进捕获的旧面板（已脱离 DOM），新面板的加载又被 loading 守卫吞掉——
    // 留在页面上的面板永远停在占位文案。
    const panelA = makeTopicPanel();
    await setup({ livePanels: [panelA] }, async ({ list, requests, livePanels }) => {
      const first = list.ensurePhTopicGroups(panelA);
      await new Promise(setImmediate);
      assert.equal(requests.length, 1);
      assert.match(panelA.innerHTML, /正在加载 Topic/);
      // 在途：工作区重建，面板元素 A 被替换为同身份键的 B（模板重渲染）
      const panelB = makeTopicPanel();
      livePanels.length = 0;
      livePanels.push(panelB);
      // 新面板的记忆回放再次触发加载 → 在途请求按身份键去重，不重复发
      list.ensurePhTopicGroups(panelB);
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
      assert.match(list.phTopicPanelInnerHtml('programming-helper', '', 'D:/project'), /data-topic-id="g-live"/);
    });
  });

  it('panel initial content follows state: placeholder before load, loading while in flight, empty-state only after a loaded-but-empty fetch', async () => {
    const livePanels = [];
    await setup({ livePanels }, async ({ list, requests }) => {
      const agentId = 'programming-helper';
      const dir = 'D:/state';
      // 未加载：占位提示（引导切到 Topics），不是「暂无主题」
      assert.match(list.phTopicPanelInnerHtml(agentId, '', dir), /切换到 Topics 后加载/);
      const panel = {
        innerHTML: '',
        dataset: { topicAgentId: agentId, topicProjectId: '', topicDirectory: dir },
      };
      livePanels.push(panel);
      const pending = list.ensurePhTopicGroups(panel);
      await new Promise(setImmediate);
      // 在途：加载中
      assert.match(list.phTopicPanelInnerHtml(agentId, '', dir), /正在加载 Topic/);
      requests[0].resolve({ ok: true, status: 200, json: async () => ({ groups: [] }) });
      await pending;
      // 已加载且为空：空态文案（不得回退成占位）
      assert.match(list.phTopicPanelInnerHtml(agentId, '', dir), /暂无关联主题/);
    });
  });

  it('tab replay (restore path) presents topics as active and loads groups — not just class toggle', async () => {
    // 缺陷报告：从其他工作空间/页面切回时，记忆回放只切了 active class，
    // topics 面板停留在「切换到 Topics 后加载」占位。回放必须与点击等价地
    // 触发懒加载；同时回放自身不得写记忆（它是记忆的读取方）。
    await setup({ livePanels: [makeTopicPanel()] }, async ({ list, requests, savedPhTabState }) => {
      const panel = makeTopicPanel();
      const tg = makeTabGroup(panel);
      list.applyPhSessionTabDom(tg, 'topics');
      assert.equal(tg.state.activeTab, 'topics', 'tab button gets active class');
      assert.equal(tg.state.activePanel, 'topics', 'panel gets active class');
      assert.equal(requests.length, 1, 'topic groups fetch is issued during replay');
      assert.match(requests[0].url, /\/protoclaw\/topic_groups/);
      assert.deepEqual(Object.keys(savedPhTabState), [], 'replay must not write tab memory');
    });
  });

  it('clicking the topics tab records memory and triggers the same load', async () => {
    await setup({ livePanels: [makeTopicPanel()] }, async ({ list, requests, c }) => {
      const panel = makeTopicPanel();
      const tg = makeTabGroup(panel);
      list.switchPhSessionTab({ dataset: { phTab: 'topics' }, closest: () => tg });
      // classic 顶层 let savedPhTabState（phSessionUi 的只读引用）就地写入
      assert.equal(c.read("savedPhTabState['ph-main']"), 'topics', 'user choice is recorded for later restore');
      assert.equal(tg.state.activePanel, 'topics');
      assert.equal(requests.length, 1, 'click path issues the same topic groups load');
      assert.match(requests[0].url, /\/protoclaw\/topic_groups/);
    });
  });

  it('workspace template sources the topic panel content from the state-aware helper', () => {
    // 模板（session-list-render.js）不得内联静态占位：工作区重建时已加载的数据
    // 会闪回占位文案。以源码断言锁住模板与状态助手的接线。
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'src', 'modules', 'session-list-render.js'), 'utf8');
    // P2 兼容债收敛后 session-list-render 直接 import 状态助手（不再经 window 桥）；
    // 模板必须调用同一实现，不得内联静态占位。
    assert.match(src, /import \{[^}]*phTopicPanelInnerHtml[^}]*\} from '\.\/ph-session-list\.js'/, 'template must import phTopicPanelInnerHtml');
    assert.match(src, /const topicPanelInner = phTopicPanelInnerHtml\(/, 'template must render topic panel via phTopicPanelInnerHtml');
    assert.ok(!src.includes('window.phTopicPanelInnerHtml'), 'bridge call must be gone');
  });
});
