import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function setup() {
  const requests = [];
  const savedPhTabState = {};
  const ctx = createFrontendSandbox({
    currentLanguage: 'zh',
    savedPhTabState,
    escapeHtml: (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])),
    formatWorkspaceDate: (value) => String(value || ''),
    URLSearchParams,
    fetch(url) {
      return new Promise((resolve) => requests.push({ url, resolve }));
    },
  });
  ctx.loadSource('public/src/modules/action-dispatcher.js');
  ctx.loadSource('public/src/modules/ph-session-list.js');
  return { ctx, requests, savedPhTabState };
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
    const { ctx, requests } = setup();
    const panel = {
      innerHTML: '',
      dataset: {
        topicAgentId: 'programming-helper',
        topicDirectory: 'D:/project',
        topicProjectId: '',
      },
    };
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

  it('tab replay (restore path) presents topics as active and loads groups — not just class toggle', async () => {
    // 缺陷报告：从其他工作空间/页面切回时，记忆回放只切了 active class，
    // topics 面板停留在「切换到 Topics 后加载」占位。回放必须与点击等价地
    // 触发懒加载；同时回放自身不得写记忆（它是记忆的读取方）。
    const { ctx, requests, savedPhTabState } = setup();
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
    const { ctx, requests, savedPhTabState } = setup();
    const panel = makeTopicPanel();
    const tg = makeTabGroup(panel);
    ctx.window.switchPhSessionTab({ dataset: { phTab: 'topics' }, closest: () => tg });
    assert.equal(savedPhTabState['ph-main'], 'topics', 'user choice is recorded for later restore');
    assert.equal(tg.state.activePanel, 'topics');
    assert.equal(requests.length, 1, 'click path issues the same topic groups load');
    assert.match(requests[0].url, /\/protoclaw\/topic_groups/);
  });
});
