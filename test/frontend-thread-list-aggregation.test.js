// PH 列表线程聚合（ticket 050）：徽标（历史 · N）与分区收敛谓词。
// 行 = 一段对话（ADR-0032）：head 行挂历史入口；历史代成员从两个分区
// （我的对话 / 已归档）同时过滤，只经入口可达。徽标契约：仅 head 且
// 存在历史代时渲染，点击经 phOpenThreadHistory 打开；归档徽标按
// phConversationArchived 口径（线程状态优先）；线程数据未加载保守
// 不渲染 / 不过滤（轮询到位自动收敛）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const source = fs.readFileSync(new URL('../public/src/modules/session-list-render.js', import.meta.url), 'utf8');

function loadModule({ sessionThread = null, language = 'zh' } = {}) {
  const ctx = createFrontendSandbox({
    currentLanguage: language,
    getWorkspaceSessions: () => [],
  });
  if (sessionThread !== null) {
    ctx.window.getThreadForSession = (_agentId, sessionId) => {
      if (!sessionThread) return null;
      // 真实接口形态：列表摘要只有 sessionIds（sessionChain 是详情端点字段）
      const inChain = (sessionThread.sessionIds || []).includes(sessionId);
      return inChain ? sessionThread : null;
    };
  }
  ctx.run(source);
  return ctx;
}

// 真实列表接口的 thread 摘要形态：无 sessionChain，成员只有 sessionIds
const HEAD_THREAD = {
  threadId: 'wt-1',
  headSessionId: 'sess-head',
  sessionIds: ['sess-old', 'sess-head'],
};

test('head 行（1 份存档）：渲染「历史 · 1」入口，点击指向 phOpenThreadHistory', () => {
  const ctx = loadModule({ sessionThread: HEAD_THREAD });
  const html = ctx.run(`window.renderSessionThreadBadge('programming-helper', { id: 'sess-head' })`);
  assert.ok(html.includes('历史 · 1'), `徽标文案含存档数：${html}`);
  assert.ok(html.includes("phOpenThreadHistory('programming-helper', 'wt-1')"), '点击经线程身份打开历史面板');
});

test('多代线程：存档数跟随链成员数（不含 head）', () => {
  const thread = {
    ...HEAD_THREAD,
    sessionIds: ['s1', 's2', 's3', 'sess-head'],
  };
  const ctx = loadModule({ sessionThread: thread });
  const html = ctx.run(`window.renderSessionThreadBadge('programming-helper', { id: 'sess-head' })`);
  assert.ok(html.includes('历史 · 3'), `三份存档：${html}`);
});

test('非 head 成员（归档区历史代）：无徽标', () => {
  const ctx = loadModule({ sessionThread: HEAD_THREAD });
  const html = ctx.run(`window.renderSessionThreadBadge('programming-helper', { id: 'sess-old' })`);
  assert.equal(html, '', '历史代成员不挂入口（行本身会被归档区收敛）');
});

test('单代线程 / 无线程会话 / 数据未加载：无徽标（混合期自然特例）', () => {
  const single = { threadId: 'wt-2', headSessionId: 'sess-x', sessionChain: [{ sessionId: 'sess-x', role: 'head' }] };
  assert.equal(loadModule({ sessionThread: single }).run(`window.renderSessionThreadBadge('programming-helper', { id: 'sess-x' })`), '', '单代：无历史可看');
  assert.equal(loadModule({ sessionThread: null }).run(`window.renderSessionThreadBadge('programming-helper', { id: 'sess-any' })`), '', '无线程：不渲染');
  const ctxNoStore = loadModule({});
  delete ctxNoStore.window.getThreadForSession;
  assert.equal(ctxNoStore.run(`window.renderSessionThreadBadge('programming-helper', { id: 'sess-any' })`), '', '线程索引缺席：保守不渲染');
});

test('英文语言：徽标文案切换', () => {
  const ctx = loadModule({ sessionThread: HEAD_THREAD, language: 'en' });
  const html = ctx.run(`window.renderSessionThreadBadge('programming-helper', { id: 'sess-head' })`);
  assert.ok(html.includes('History · 1'), `English label: ${html}`);
});

test('归档区收敛：历史代成员过滤、head 与无线程会话保留', () => {
  const ctx = loadModule({ sessionThread: HEAD_THREAD });
  const isMember = (id) => ctx.run(`window.phIsThreadArchivedMember('programming-helper', { id: '${id}' })`);
  assert.equal(isMember('sess-old'), true, '历史代成员：归档区过滤');
  assert.equal(isMember('sess-head'), false, 'head：保留为对话行');
  assert.equal(isMember('sess-plain'), false, '无线程会话：混合期自然特例，不受影响');
});

test('对话归档状态：线程 lifeState 优先于 head session.archived', () => {
  const archivedThread = { ...HEAD_THREAD, lifeState: 'archived' };
  const ctx = loadModule({ sessionThread: archivedThread });
  const isArchived = (session) => ctx.run(`window.phConversationArchived('programming-helper', ${JSON.stringify(session)})`);
  assert.equal(isArchived({ id: 'sess-head', archived: false }), true, '归档线程的 head 进入「已归档」');
  assert.equal(isArchived({ id: 'sess-old', archived: true }), true, '归档线程历史成员仍按线程归档状态');
});

test('对话归档状态：活跃线程覆盖遗留 session.archived=true', () => {
  const activeThread = { ...HEAD_THREAD, lifeState: 'active' };
  const ctx = loadModule({ sessionThread: activeThread });
  assert.equal(ctx.run(`window.phConversationArchived('programming-helper', { id: 'sess-head', archived: true })`), false, '线程归档状态是权威值');
});

test('对话归档状态：无线程 / 线程数据未就绪时回退 session.archived', () => {
  const ctx = loadModule({ sessionThread: null });
  assert.equal(ctx.run(`window.phConversationArchived('programming-helper', { id: 'sess-plain', archived: true })`), true, '无线程的存量会话沿用旧标志');
  const noStore = loadModule({});
  delete noStore.window.getThreadForSession;
  assert.equal(noStore.run(`window.phConversationArchived('programming-helper', { id: 'sess-plain', archived: true })`), true, '线程索引不可用时保守回退');
});

test('归档区收敛：线程数据未加载时不过滤（保守渲染）', () => {
  const ctx = loadModule({ });
  delete ctx.window.getThreadForSession;
  assert.equal(ctx.run(`window.phIsThreadArchivedMember('programming-helper', { id: 'sess-any' })`), false, '索引缺席：不过滤');
});

test('列表分区：五类会话形态各归其位，历史代成员不进入任何分区', () => {
  // 线程摘要：活跃线程（head + 一份历史代）与归档线程各一条
  const threads = {
    'wt-active': { threadId: 'wt-active', headSessionId: 's-active-head', sessionIds: ['s-active-old', 's-active-head'], lifeState: 'active' },
    'wt-archived': { threadId: 'wt-archived', headSessionId: 's-arch-head', sessionIds: ['s-arch-head'], lifeState: 'archived' },
  };
  const ctx = loadModule({});
  ctx.window.getThreadForSession = (_agentId, sessionId) => {
    for (const thread of Object.values(threads)) {
      if (thread.sessionIds.includes(sessionId)) return thread;
    }
    return null;
  };
  const input = [
    { id: 's-active-head', archived: false }, // 活跃线程 head → 我的对话
    { id: 's-active-old', archived: true },  // 活跃线程历史代（遗留标志）→ 无分区
    { id: 's-arch-head', archived: false },  // 归档线程 head（head 标志未置位）→ 已归档
    { id: 's-legacy-arch', archived: true }, // 无线程存量归档会话 → 已归档
    { id: 's-plain', archived: false },      // 无线程普通会话 → 我的对话
  ];
  const result = ctx.run(`window.phPartitionSessions('programming-helper', ${JSON.stringify(input)})`);
  // ctx.run 返回 VM 沙箱对象（原型链在 VM 内），deepStrictEqual 会因原型
  // 不同误报——先经 Array.from 转宿主数组再比较
  const ids = (list) => Array.from(list).map((s) => s.id);
  assert.deepEqual(ids(result.main), ['s-active-head', 's-plain'], '我的对话：活跃 head 与无线程未归档会话');
  assert.deepEqual(ids(result.archived), ['s-arch-head', 's-legacy-arch'], '已归档：归档线程 head 与无线程归档会话');
  const shown = [...ids(result.main), ...ids(result.archived)];
  assert.ok(!shown.includes('s-active-old'), '历史代成员（含遗留 archived=true）不占据任何分区');
});
