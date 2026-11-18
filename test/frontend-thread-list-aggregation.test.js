// PH 列表线程聚合（ticket 050）：徽标（历史 · N）与分区收敛谓词。
// 行 = 一段对话（ADR-0032）：head 行挂历史入口；历史代成员从两个分区
// （我的对话 / 已归档）同时过滤，只经入口可达。徽标契约：仅 head 且
// 存在历史代时渲染，点击经 phOpenThreadHistory 打开；归档徽标按
// phConversationArchived 口径（线程状态优先）；线程数据未加载保守
// 不渲染 / 不过滤（轮询到位自动收敛）。
//
// 装载路线（P2 真实 import）：session-list-render 已迁 ESM → withP2EsmCase
// 每 case 一张真实模块图；classic 侧只跑真实壳层 bootstrap（桥初值、宿主
// 工厂、首屏同步面）。线程事实经生产通道 window.getThreadForSession（classic
// thread-store 提供）注入，语言经 i18n ESM owner 切换。
import assert from 'node:assert/strict';
import test from 'node:test';
import { marked } from 'marked';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareSidebarDomain } from './p2-classic-hosts.js';

/** 真实壳层 bootstrap（桥初值、宿主工厂与首屏同步面来源）。 */
const CLASSIC_STACK = [
  'public/src/modules/action-dispatcher.js',
  'public/src/modules/claw-host.js',
  'public/src/modules/right-panel-registry.js',
  'public/src/app-core.js',
  'public/src/modules/session-view-state.js',
  'public/src/app-ui.js',
  'public/src/app-main.js',
];

function makeAgent() {
  return {
    id: 'programming-helper',
    workspace_sessions: { activeSessionId: 'sess-head', sessions: [] },
    workspace_state: { openDirectory: '', phProjects: [] },
  };
}

/**
 * 一个用例 = 一份真实模块图。
 * @param {{ sessionThread?: object|null, language?: string, threadLookup?: Function }} options
 */
async function withThreadCase({ sessionThread = null, language = 'zh', threadLookup } = {}, fn) {
  const agent = makeAgent();
  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      sandbox.marked = marked;
      sandbox.currentLanguage = 'zh';
      sandbox.phSearchQuery = '';
      sandbox.savedPhTabState = {};
      sandbox.run(`
        window.__clawAuthReady = new Promise(() => {});
        applyLanguage = () => {};
        applyTheme = () => {};
      `);
      for (const file of CLASSIC_STACK) sandbox.loadSource(file);
      prepareSidebarDomain(sandbox);
      sandbox.allAgents = [agent];
      sandbox.getCurrentAgentRecord = () => agent;
      sandbox.renderCurrentMainView = () => {};
      sandbox.alert = () => {};
      sandbox.setTimeout = () => 0;
      sandbox.clearTimeout = () => {};
      sandbox.fetch = async () => ({ ok: false, status: 0, json: async () => ({}) });
      sandbox.window.ClawFW = sandbox.window.ClawFW || {};
      sandbox.window.ClawFW._modelPresets = [];
      if (threadLookup) {
        sandbox.window.getThreadForSession = threadLookup;
      } else if (sessionThread !== null) {
        sandbox.window.getThreadForSession = (_agentId, sessionId) => {
          if (!sessionThread) return null;
          // 真实接口形态：列表摘要只有 sessionIds（sessionChain 是详情端点字段）
          const inChain = (sessionThread.sessionIds || []).includes(sessionId);
          return inChain ? sessionThread : null;
        };
      }
    },
  }, async (c) => {
    // 远程连接域已迁 ESM（P4 T3）：真实 import 代替原 classic 标签位（生产顺序
    // 在 runtime-status 之前、sidebar-render 之前）。
    await c.load('public/src/modules/remote-connections.js');
    const i18n = await c.load('public/src/modules/i18n-environment-state.js');
    const list = await c.load('public/src/modules/session-list-render.js');
    i18n.setCurrentLanguage(language);
    return fn({ list, i18n, sandbox: c.sandbox });
  });
}

// 真实列表接口的 thread 摘要形态：无 sessionChain，成员只有 sessionIds
const HEAD_THREAD = {
  threadId: 'wt-1',
  headSessionId: 'sess-head',
  sessionIds: ['sess-old', 'sess-head'],
};

test('head 行（1 份存档）：渲染「历史 · 1」入口，点击指向 phOpenThreadHistory', async () => {
  await withThreadCase({ sessionThread: HEAD_THREAD }, ({ list }) => {
    const html = list.renderSessionThreadBadge('programming-helper', { id: 'sess-head' });
    assert.ok(html.includes('历史 · 1'), `徽标文案含存档数：${html}`);
    assert.ok(html.includes('data-action="sessions.threadHistory" data-agent-id="programming-helper" data-thread-id="wt-1"'), '点击经线程身份打开历史面板');
  });
});

test('多代线程：存档数跟随链成员数（不含 head）', async () => {
  const thread = { ...HEAD_THREAD, sessionIds: ['s1', 's2', 's3', 'sess-head'] };
  await withThreadCase({ sessionThread: thread }, ({ list }) => {
    const html = list.renderSessionThreadBadge('programming-helper', { id: 'sess-head' });
    assert.ok(html.includes('历史 · 3'), `三份存档：${html}`);
  });
});

test('非 head 成员（归档区历史代）：无徽标', async () => {
  await withThreadCase({ sessionThread: HEAD_THREAD }, ({ list }) => {
    const html = list.renderSessionThreadBadge('programming-helper', { id: 'sess-old' });
    assert.equal(html, '', '历史代成员不挂入口（行本身会被归档区收敛）');
  });
});

test('单代线程 / 无线程会话 / 数据未加载：无徽标（混合期自然特例）', async () => {
  const single = { threadId: 'wt-2', headSessionId: 'sess-x', sessionIds: ['sess-x'] };
  await withThreadCase({ sessionThread: single }, ({ list }) => {
    assert.equal(list.renderSessionThreadBadge('programming-helper', { id: 'sess-x' }), '', '单代：无历史可看');
  });
  await withThreadCase({ sessionThread: null }, ({ list }) => {
    assert.equal(list.renderSessionThreadBadge('programming-helper', { id: 'sess-any' }), '', '无线程：不渲染');
  });
  await withThreadCase({}, ({ list, sandbox }) => {
    delete sandbox.window.getThreadForSession;
    assert.equal(list.renderSessionThreadBadge('programming-helper', { id: 'sess-any' }), '', '线程索引缺席：保守不渲染');
  });
});

test('英文语言：徽标文案切换', async () => {
  await withThreadCase({ sessionThread: HEAD_THREAD, language: 'en' }, ({ list }) => {
    const html = list.renderSessionThreadBadge('programming-helper', { id: 'sess-head' });
    assert.ok(html.includes('History · 1'), `English label: ${html}`);
  });
});

test('归档区收敛：历史代成员过滤、head 与无线程会话保留', async () => {
  await withThreadCase({ sessionThread: HEAD_THREAD }, ({ list }) => {
    const isMember = (id) => list.phIsThreadArchivedMember('programming-helper', { id });
    assert.equal(isMember('sess-old'), true, '历史代成员：归档区过滤');
    assert.equal(isMember('sess-head'), false, 'head：保留为对话行');
    assert.equal(isMember('sess-plain'), false, '无线程会话：混合期自然特例，不受影响');
  });
});

test('对话归档状态：线程 lifeState 优先于 head session.archived', async () => {
  const archivedThread = { ...HEAD_THREAD, lifeState: 'archived' };
  await withThreadCase({ sessionThread: archivedThread }, ({ list }) => {
    const isArchived = (session) => list.phConversationArchived('programming-helper', session);
    assert.equal(isArchived({ id: 'sess-head', archived: false }), true, '归档线程的 head 进入「已归档」');
    assert.equal(isArchived({ id: 'sess-old', archived: true }), true, '归档线程历史成员仍按线程归档状态');
  });
});

test('对话归档状态：活跃线程覆盖遗留 session.archived=true', async () => {
  const activeThread = { ...HEAD_THREAD, lifeState: 'active' };
  await withThreadCase({ sessionThread: activeThread }, ({ list }) => {
    assert.equal(list.phConversationArchived('programming-helper', { id: 'sess-head', archived: true }), false, '线程归档状态是权威值');
  });
});

test('对话归档状态：无线程 / 线程数据未就绪时回退 session.archived', async () => {
  await withThreadCase({ sessionThread: null }, ({ list }) => {
    assert.equal(list.phConversationArchived('programming-helper', { id: 'sess-plain', archived: true }), true, '无线程的存量会话沿用旧标志');
  });
  await withThreadCase({}, ({ list, sandbox }) => {
    delete sandbox.window.getThreadForSession;
    assert.equal(list.phConversationArchived('programming-helper', { id: 'sess-plain', archived: true }), true, '线程索引不可用时保守回退');
  });
});

test('归档区收敛：线程数据未加载时不过滤（保守渲染）', async () => {
  await withThreadCase({}, ({ list, sandbox }) => {
    delete sandbox.window.getThreadForSession;
    assert.equal(list.phIsThreadArchivedMember('programming-helper', { id: 'sess-any' }), false, '索引缺席：不过滤');
  });
});

test('列表分区：五类会话形态各归其位，历史代成员不进入任何分区', async () => {
  // 线程摘要：活跃线程（head + 一份历史代）与归档线程各一条
  const threads = {
    'wt-active': { threadId: 'wt-active', headSessionId: 's-active-head', sessionIds: ['s-active-old', 's-active-head'], lifeState: 'active' },
    'wt-archived': { threadId: 'wt-archived', headSessionId: 's-arch-head', sessionIds: ['s-arch-head'], lifeState: 'archived' },
  };
  const threadLookup = (_agentId, sessionId) => {
    for (const thread of Object.values(threads)) {
      if (thread.sessionIds.includes(sessionId)) return thread;
    }
    return null;
  };
  await withThreadCase({ threadLookup }, ({ list }) => {
    const input = [
      { id: 's-active-head', archived: false }, // 活跃线程 head → 我的对话
      { id: 's-active-old', archived: true },  // 活跃线程历史代（遗留标志）→ 无分区
      { id: 's-arch-head', archived: false },  // 归档线程 head（head 标志未置位）→ 已归档
      { id: 's-legacy-arch', archived: true }, // 无线程存量归档会话 → 已归档
      { id: 's-plain', archived: false },      // 无线程普通会话 → 我的对话
    ];
    const result = list.phPartitionSessions('programming-helper', input);
    const ids = (entries) => Array.from(entries).map((s) => s.id);
    assert.deepEqual(ids(result.main), ['s-active-head', 's-plain'], '我的对话：活跃 head 与无线程未归档会话');
    assert.deepEqual(ids(result.archived), ['s-arch-head', 's-legacy-arch'], '已归档：归档线程 head 与无线程归档会话');
    const shown = [...ids(result.main), ...ids(result.archived)];
    assert.ok(!shown.includes('s-active-old'), '历史代成员（含遗留 archived=true）不进入任何分区');
  });
});
