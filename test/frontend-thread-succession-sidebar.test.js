/**
 * 接续窗口的侧栏单条目不变量（P2：真实 ESM import + classic 渲染宿主）
 *
 * 事故机制：successor runtime 上线早于 commit（框架 advanceHead 才把
 * successor session 写进 sessionChain），窗口内 collectRuntimeEntriesForPrebuilt
 * 的线程锚定 get(newHead) 未命中 → successor 作为普通新条目渲染，与旧
 * 占位条目平行——用户看到「一个会话变成两个」。
 *
 * 修复语义：锚定未命中时，只关联 source_session_id 指向当前 head 且存在
 * fresh 接续挡板的线程；无关新对话不受影响——非 head 成员不渲染叶子，由
 * 占位条目兜底；commit 后 sessionChain 补上成员，锚定自然收敛。
 * 不变量：接续全程（挡板立起 → successor 上线 → head 推进）同一线程在
 * 侧栏只有一个条目。
 *
 * 装载路线：sidebar-operations 已是 ESM（操作记录 owner），经 withP2EsmCase 的
 * `c.load` 真实 import；`runtime-status.js`（`collectRuntimeEntriesForPrebuilt`
 * 的实现方）仍是 classic，由真实先行脚本序装载——它经 kernel 访问器桥读操作
 * 记录，两侧共享同一状态。操作登记走 ESM 命名导出（beginSidebarOperation 的
 * classic 消费面已归零、桥已注销，用例直接调用真实导出，不恢复同名 window 桥）。
 * 宿主工厂（桥注册、渲染去重、运行时状态 loader）全部来自真实 classic 脚本，
 * 只有渲染入口按「效果出口」记录为哑件。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const OPS = 'public/src/modules/sidebar-operations.js';

/** 真实 classic 先行脚本序 + runtime-status；渲染入口记录为哑件。 */
function bootstrap(sandbox) {
  // 真实先行脚本序（顺序同 index.html）：宿主工厂、桥注册与 runtime-status
  // （collectRuntimeEntriesForPrebuilt 的实现方）都是生产实现；boot 体挂在永不
  // resolve 的 __clawAuthReady 之后，主题 / 语言应用与周期排程一并中和。
  prepareClassicSandbox(sandbox);
  // index.html 里仍是 classic 的生产脚本（先行序不含它们）：sidebar-operations →
  // project-data 的静态图与 thread-store-domain 在装载期取它们的宿主面。
  // 渲染效果出口：本文件只驱动线程承接的侧栏投影（断言落在 collect 结果上），
  // 渲染入口记录为哑件。
  sandbox.renderAgentList = () => {};
  sandbox.renderCurrentMainView = () => {};
}


/**
 * 成功路径的缺键异常守卫：用例期间的 console 交给记录器（直通宿主，不静音），
 * 用例结束（成功路径）时只对 TypeError / ReferenceError / is not a function
 * 断言——装配缺键会以这类错误出现在真实调用链里，不能静默通过。
 */
function createConsoleGuard() {
  const host = globalThis.console; // 词法捕获：用例期间 globalThis.console 已是记录器
  const lines = [];
  const format = (args) => args
    .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
    .join(' ');
  const recorder = {
    ...host,
    error: (...args) => { lines.push(format(args)); host.error(...args); },
    warn: (...args) => { lines.push(format(args)); host.warn(...args); },
  };
  return {
    recorder,
    lines,
    assertClean: () => {
      const offenders = lines.filter((line) => /TypeError|ReferenceError|is not a function/.test(line));
      assert.deepEqual(offenders, [], '成功路径不应出现缺键 / 引用异常');
    },
  };
}
/** 每个用例一份 window + 一张 ESM 图；`fn(c)` 拿到真实的 classic / ESM 组合面。 */
async function withSidebarCase(globals, fn) {
  const guard = createConsoleGuard();
  return withP2EsmCase({
    classic: bootstrap,
    globals: { navigator: undefined, console: guard.recorder, ...globals },
  }, async (c) => {
    // 刷新引擎（P4 T3 起是真实 ESM）：交互域在**装载期**取它的窄宿主 createThreadStoreHost，
// 必须先于 thread-store-domain 进入同一张图。
    await c.load('public/src/modules/thread-store.js');
    const ops = await c.load(OPS);
    // 远程连接域（已迁 ESM，P4 T3）：真实 import。侧栏投影的远程半边
    // （getVisibleRemoteEntries / getRemoteSidebarProjectionVersion）由它提供，
    // 缺省时 sidebar-render 的 typeof 守卫会静默跳过——本文件按生产形态装载。
    await c.load('public/src/modules/remote-connections.js');
    const result = await fn(c, ops);
    guard.assertClean();
    return result;
  });
}

const HOST = {
  id: 'coder', agentId: 'coder', source: 'prebuilt', workspace_sessions: { sessions: [] },
};

function child(sessionId, runtimeId, name) {
  return {
    id: runtimeId, source: 'child', parent_id: 'coder',
    sidebar_entry_id: 'coder',
    runtime_session_id: runtimeId, active_workspace_session_id: sessionId,
    active_workspace_display_name: name, connected: true,
    source_session_id: sessionId === 'new-head' ? 'old-head' : '',
    created_at: '2026-10-10T09:05:00.000Z',
  };
}

const CHILD_OLD = child('old-head', 'old-runtime', '旧会话标题');
const CHILD_NEW = child('new-head', 'new-runtime', '新会话标题');

function runCollect(c, agentsLiteral, host = HOST) {
  return c.read(`(() => {
    const host = ${JSON.stringify({ ...host, sidebar_threads: c.window.ClawThreads?.threads || [] })};
    const agents = ${agentsLiteral};
    return collectRuntimeEntriesForPrebuilt(host, agents);
  })()`);
}

describe('runtime-status: single sidebar entry across the succession window', () => {
  it('successor online before commit does not render as a parallel plain entry', async () => {
    await withSidebarCase({}, (c) => {
      c.window.ClawThreads = {
        threads: [{
          threadId: 'wt-relay', agentId: 'coder',
          headSessionTitle: '工作对话', headSessionId: 'old-head', sessionIds: ['old-head'],
          status: 'rotating', lifeState: 'executing', handoffStartedAt: Date.now(),
        }],
        sessionIndex: {},
      };
      c.window.ClawThreads.sessionIndex['coder::old-head'] = c.window.ClawThreads.threads[0];

      // 先在稳态下渲染一次，建立线程条目缓存（占位渲染的锚）
      const steady = runCollect(c, JSON.stringify([CHILD_OLD]));
      const steadyThreadEntries = steady.filter((e) => e.threadId === 'wt-relay');
      assert.equal(steadyThreadEntries.length, 1, '稳态下单条目');

      // 换代窗口：旧 runtime 退役（不在 agents），successor 已上线未 commit
      const gap = runCollect(c, JSON.stringify([CHILD_NEW]));
      // 核心断言：窗口内 successor 不得以普通新条目出现（无双条目平行）
      const parallelNew = gap.filter((e) => e.runtimeId === 'new-runtime');
      assert.equal(parallelNew.length, 0, 'successor 在 commit 前不得渲染为平行普通条目');
      // 旧条目以占位形式存续（单条目连续性）
      const placeholders = gap.filter((e) => e.transitionPending === true);
      assert.equal(placeholders.length, 1, '换代窗口由占位条目兜底');
      assert.equal(placeholders[0].threadId, 'wt-relay');
      assert.equal(placeholders[0].name, '工作对话', '接续过程不把线程条目名称替换为过程状态标签');
    });
  });

  it('after commit the successor renders as the anchored thread entry (converged single entry)', async () => {
    await withSidebarCase({}, (c) => {
      const thread = {
        threadId: 'wt-relay', agentId: 'coder',
        headSessionTitle: '工作对话', headSessionId: 'old-head', sessionIds: ['old-head'],
        status: 'rotating', lifeState: 'executing', handoffStartedAt: Date.now(),
      };
      c.window.ClawThreads = { threads: [thread], sessionIndex: { 'coder::old-head': thread } };

      runCollect(c, JSON.stringify([CHILD_OLD]));

      // commit：head 推进、sessionChain 补上 successor、挡板清除
      thread.headSessionId = 'new-head';
      thread.sessionIds = ['old-head', 'new-head'];
      thread.handoffStartedAt = 0;
      c.window.ClawThreads.sessionIndex['coder::new-head'] = thread;

      const entries = runCollect(c, JSON.stringify([CHILD_NEW]));
      const threadEntries = entries.filter((e) => e.threadId === 'wt-relay');
      assert.equal(threadEntries.length, 1, 'commit 后收敛为单条目');
      assert.equal(threadEntries[0].runtimeId, 'new-runtime');
      assert.notEqual(threadEntries[0].transitionPending, true, '收敛后条目为实态');
    });
  });

  it('ordinary trim operation without a matching thread still renders its pending row', async () => {
    await withSidebarCase({}, (c, ops) => {
      const thread = {
        threadId: 'wt-other', agentId: 'programming-helper',
        title: '其他对话', headSessionId: 'other-head', sessionIds: ['other-head'],
        status: 'open', lifeState: 'idle', handoffStartedAt: 0,
      };
      c.window.ClawThreads = {
        threads: [thread],
        sessionIndex: { 'programming-helper::other-head': thread },
      };
      ops.beginSidebarOperation({
        operationId: 'trim-ordinary', type: 'create', kind: 'trim', phase: 'generating',
        agentId: 'programming-helper', sourceSessionId: 'ordinary-session',
        projectDir: 'D:/project', projectName: 'project',
      });

      const host = { id: 'programming-helper', agentId: 'programming-helper', source: 'prebuilt', workspace_sessions: { sessions: [] } };
      const entries = runCollect(c, '[]', host);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].source, 'operation-pending');
    });
  });

  it('thread trim/summary operations do not create a second pending sidebar row', async () => {
    await withSidebarCase({}, (c, ops) => {
      const thread = {
        threadId: 'wt-relay', agentId: 'programming-helper',
        headSessionTitle: '工作对话', headSessionId: 'old-head', sessionIds: ['old-head'],
        status: 'rotating', lifeState: 'executing', handoffStartedAt: Date.now(),
      };
      c.window.ClawThreads = {
        threads: [thread],
        sessionIndex: { 'programming-helper::old-head': thread },
      };
      ops.beginSidebarOperation({
        operationId: 'trim-1', type: 'create', kind: 'trim', phase: 'generating',
        agentId: 'programming-helper', sourceSessionId: 'old-head',
        projectDir: 'D:/project', projectName: 'project',
      });
      ops.beginSidebarOperation({
        operationId: 'summary-1', type: 'create', kind: 'summary', phase: 'generating',
        agentId: 'programming-helper', sourceSessionId: 'old-head',
        projectDir: 'D:/project', projectName: 'project',
      });

      const host = { id: 'programming-helper', agentId: 'programming-helper', source: 'prebuilt', workspace_sessions: { sessions: [] } };
      const entries = runCollect(c, JSON.stringify([
        { ...child('old-head', 'old-runtime', '工作对话'), parent_id: 'programming-helper', sidebar_entry_id: 'programming-helper' },
      ]), host);
      assert.equal(entries.length, 1, '线程接续期间只保留原线程条目');
      assert.equal(entries[0].threadId, 'wt-relay');
      assert.notEqual(entries[0].source, 'operation-pending');
    });
  });

  it('degraded thread succession remains visible as an actionable failure', async () => {
    await withSidebarCase({}, (c, ops) => {
      const thread = {
        threadId: 'wt-relay', agentId: 'programming-helper',
        headSessionTitle: '工作对话', headSessionId: 'old-head', sessionIds: ['old-head'],
        status: 'rotating', lifeState: 'executing', handoffStartedAt: Date.now(),
      };
      c.window.ClawThreads = {
        threads: [thread],
        sessionIndex: { 'programming-helper::old-head': thread },
      };
      ops.beginSidebarOperation({
        operationId: 'trim-1', type: 'create', kind: 'trim', phase: 'degraded',
        agentId: 'programming-helper', sourceSessionId: 'old-head',
        projectDir: 'D:/project', projectName: 'project',
      });

      const host = { id: 'programming-helper', agentId: 'programming-helper', source: 'prebuilt', workspace_sessions: { sessions: [] } };
      const entries = runCollect(c, JSON.stringify([
        { ...child('old-head', 'old-runtime', '工作对话'), parent_id: 'programming-helper', sidebar_entry_id: 'programming-helper' },
      ]), host);
      assert.ok(entries.some((entry) => entry.source === 'operation-degraded'),
        '失败态需保留以便用户发现并处理');
    });
  });

  it('coder trim operation keeps coder behavior unchanged', async () => {
    await withSidebarCase({}, (c, ops) => {
      const thread = {
        threadId: 'wt-coder', agentId: 'coder',
        title: 'Coder 工作', headSessionId: 'coder-head', sessionIds: ['coder-head'],
        status: 'rotating', lifeState: 'executing', handoffStartedAt: Date.now(),
      };
      c.window.ClawThreads = {
        threads: [thread],
        sessionIndex: { 'coder::coder-head': thread },
      };
      ops.beginSidebarOperation({
        operationId: 'coder-trim', type: 'create', kind: 'trim', phase: 'generating',
        agentId: 'coder', sourceSessionId: 'coder-head',
        projectDir: 'D:/project', projectName: 'project',
      });

      const entries = runCollect(c, JSON.stringify([CHILD_OLD]));
      assert.ok(entries.some((entry) => entry.source === 'operation-pending'));
    });
  });

  it('an unrelated new conversation remains visible while another thread is rotating', async () => {
    await withSidebarCase({}, (c) => {
      c.window.ClawThreads = { threads: [{
        threadId: 'wt-relay', agentId: 'coder', title: '接续中的对话',
        headSessionId: 'old-head', sessionIds: ['old-head'], status: 'open',
        handoffStartedAt: Date.now(),
      }] };
      const unrelated = { ...child('unrelated', 'unrelated-runtime', '新建对话'), source_session_id: '' };
      const entries = runCollect(c, JSON.stringify([unrelated]));
      assert.ok(entries.some(e => e.runtimeId === 'unrelated-runtime' && !e.threadId),
        '不能仅因同工作空间有其他线程接续就吞掉新建对话');
    });
  });

  it('non-thread coder session without an active barrier still renders as its own entry', async () => {
    await withSidebarCase({}, (c) => {
      // 无挡板：普通新 coder 会话（用户/调度新建）必须照常渲染为独立条目
      c.window.ClawThreads = {
        threads: [{
          threadId: 'wt-idle', agentId: 'coder',
          title: '另一线程', headSessionId: 'idle-head', sessionIds: ['idle-head'],
          status: 'open', lifeState: 'idle', handoffStartedAt: 0,
        }],
        sessionIndex: {},
      };
      c.window.ClawThreads.sessionIndex['coder::idle-head'] = c.window.ClawThreads.threads[0];

      const entries = runCollect(c, JSON.stringify([CHILD_NEW]));
      assert.ok(entries.some((e) => e.runtimeId === 'new-runtime' && !e.threadId),
        '无挡板时未命中会话仍渲染为普通条目');
    });
  });
});
