/**
 * sidebar-operations.js —— 操作状态机、诊断队列与会话快照合并。
 *
 * 装载路线（P2 ESM 配方第三节）：sidebar-operations 已是 ESM（唯一 owner），
 * 经 withP2EsmCase 的 `c.load` 真实 import（每 case 整图隔离）；classic 只保留
 * 首屏 bootstrap（action-dispatcher / i18n / app-core / sidebar-render）——
 * app-core 注册 agent-store / render-entry 域的 kernel 访问器桥，sidebar-render
 * 提供 `createP2BootstrapSidebarRenderHost` 渲染去重适配面，两者都是模块顶层
 * 依赖，不能由测试自造。渲染回调（renderAgentList / renderCurrentMainView /
 * updateAgentRecord）仍走 classic 宿主契约，以最小替身注入。
 *
 * classic 消费方（case 内 `allAgents = …` 之类的裸标识符读写）与模块内实现共享
 * 同一桥：读写都落到 ESM owner 的状态上，断言不需要任何状态副本。
 *
 * 私有 helper 无导出面时的重钉：`buildSidebarDiagnosticPhaseEvent` 与
 * `flushSidebarDiagnosticEvents` 是模块私有（不导出、不上桥），分别经真实公开
 * 入口 `recordSidebarOperationCheckpoint`（返回同一事件对象）与模块自身的排程
 * flush（测试把 sandbox 的 250ms 排程改为微任务）触达，断言强度不变。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { createOperationTrace, normalizeOperationId } from '../server/shared/operation-trace.js';
import { sessionIndexContentSignature } from '../server/shared/session-access.js';

const OPS = 'public/src/modules/sidebar-operations.js';

/**
 * classic 首屏 bootstrap + 宿主替身。app-core 的 defineKey 建立桥槽，
 * sidebar-render 交出自己的渲染去重状态；两个工厂都是 ESM 模块顶层读取的面。
 */
function bootstrapClassic(sandbox) {
  sandbox.loadSource('public/src/modules/action-dispatcher.js');
  sandbox.loadSource('public/src/i18n.js');
  sandbox.loadSource('public/src/app-core.js');
  // 生产加载序：runtime-status 提供 sidebar-render 调用状态宿主读的容器，
  // session-view-state 提供会话快照提交宿主；通知时钟周期不属于本文件验收面。
  sandbox.setInterval = () => 0;
  sandbox.loadSource('public/src/modules/runtime-status.js');
  sandbox.loadSource('public/src/modules/session-view-state.js');
  sandbox.loadSource('public/src/modules/sidebar-render.js');
  sandbox.renderAgentList = () => {};
  sandbox.renderCurrentMainView = () => {};
  // updateAgentRecord 已改具名 import（project-data 的真实 owner，写 agent-store
  // 的 allAgents）；本文件经 KernelState 访问器读同一个 allAgents，不再注入替身。
  //
  // project-data 静态图带来的其余 classic 宿主工厂（生产由 app-ui / app-main
  // 提供）：本文件不驱动渲染 / 轮询 / 运行时切换 / 装配面板，只要求装载期可解析。
  sandbox.createWorkspaceSurfaceHost = () => ({});
  sandbox.createPollCoordinatorHost = () => ({});
  sandbox.createRuntimeSwitchHost = () => ({ state: {} });
  sandbox.createCompactResumeHost = () => ({});
  sandbox.createP2BootstrapAssemblyHost = () => ({});
  sandbox.createP2BootstrapContextMenuHost = () => ({});
  sandbox.createP2BootstrapDebugPanelHost = () => ({});
  sandbox.createP2BootstrapPhSessionHost = () => ({});
}

/**
 * 建一个用例：装入 classic bootstrap 与真实 ESM 模块，再执行 `fn(c, ops)`。
 * `navigator: undefined` 沿用模块原有判定：无 navigator 时诊断队列不排程
 * flush，用例不会残留定时器（需要队列的用例显式传 navigator）。
 */

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
async function withOpsCase(options, fn) {
  const { classic, globals = {} } = options || {};
  const guard = createConsoleGuard();
  return withP2EsmCase({
    classic: (sandbox) => {
      bootstrapClassic(sandbox);
      if (typeof classic === 'function') classic(sandbox);
    },
    globals: { navigator: undefined, console: guard.recorder, ...globals },
  }, async (c) => {
    const ops = await c.load(OPS);
    // sidebar-operations 已把入口从 KernelState 桥注销（消费方一律具名 import）：
    // classic 侧脚本按**模块命名空间**调用同一批 ESM 导出（不逐函数恢复顶层名字）。
    c.expose('SidebarOps', ops);
    const result = await fn(c, ops);
    guard.assertClean();
    return result;
  });
}

describe('sidebar operation state machine', () => {
  it('moves through deterministic phases and removes only the completed operation', async () => {
    await withOpsCase({}, (c) => {
      const result = c.read(`(() => {
        const first = SidebarOps.beginSidebarOperation({
          operationId: 'summary:one', type: 'replacement', kind: 'summary',
          agentId: 'programming-helper', sourceSessionId: 'source-1', phase: 'generating'
        });
        const second = SidebarOps.beginSidebarOperation({
          operationId: 'create:two', type: 'create', kind: 'create',
          agentId: 'programming-helper', phase: 'committing'
        });
        SidebarOps.updateSidebarOperation(first.operationId, {
          phase: 'target-ready', targetSessionId: 'target-1', targetRuntimeId: 'runtime-1', serverRevision: 4
        });
        const completed = SidebarOps.finishSidebarOperation(first.operationId, 'settled');
        return {
          completed,
          remaining: SidebarOps.listSidebarOperations(),
          version: getSidebarOperationVersion()
        };
      })()`);

      assert.equal(result.completed.phase, 'settled');
      assert.equal(result.completed.targetSessionId, 'target-1');
      assert.equal(result.completed.serverRevision, 4);
      assert.equal(result.remaining.length, 1);
      assert.equal(result.remaining[0].operationId, 'create:two');
      assert.equal(result.version, 4);
    });
  });

  it('builds a content-free client diagnostic phase record', async () => {
    await withOpsCase({}, (c) => {
      // 私有 helper 经真实公开入口（checkpoint 返回其构建的事件）触达
      const event = c.read(`(() => {
        SidebarOps.beginSidebarOperation({
          operationId: 'summary:client', kind: 'summary', type: 'replacement', phase: 'generating',
          agentId: 'programming-helper', sourceSessionId: 'source-1', targetSessionId: 'target-1',
          projectDir: 'D:\\\\private', projectName: 'private', title: 'private title',
          startedAt: Date.now() - 50, serverRevision: 8
        });
        return recordSidebarOperationCheckpoint('summary:client', 'target-ready', { phaseDurationMs: 12 });
      })()`);
      assert.equal(event.operationId, 'summary:client');
      assert.equal(event.phase, 'target-ready');
      assert.equal(event.revision, 8);
      assert.equal(event.phaseDurationMs, 12);
      assert.equal(Object.hasOwn(event, 'projectDir'), false);
      assert.equal(Object.hasOwn(event, 'projectName'), false);
      assert.equal(Object.hasOwn(event, 'title'), false);
    });
  });

  it('records response checkpoints and aggregates scoped Long Tasks', async () => {
    class FakePerformanceObserver {
      constructor(callback) { this.callback = callback; }
      observe() {}
      takeRecords() { return [{ duration: 75 }, { duration: 20 }, { duration: 125 }]; }
      disconnect() {}
    }
    await withOpsCase({ globals: { PerformanceObserver: FakePerformanceObserver } }, (c) => {
      const result = c.read(`(() => {
        SidebarOps.beginSidebarOperation({
          operationId: 'trim:timing', kind: 'trim', type: 'replacement',
          phase: 'generating', agentId: 'programming-helper', sourceSessionId: 'source-1'
        });
        const checkpoint = recordSidebarOperationCheckpoint('trim:timing', 'response_headers_received', {
          requestWaitMs: 6400, responseBytes: 512
        });
        const stop = beginSidebarOperationMainThreadObservation('trim:timing');
        const observation = stop();
        return { checkpoint, observation };
      })()`);
      assert.equal(result.checkpoint.requestWaitMs, 6400);
      assert.equal(result.checkpoint.responseBytes, 512);
      assert.equal(result.observation.longTaskCount, 2);
      assert.equal(result.observation.longTaskTotalMs, 200);
      assert.equal(result.observation.longTaskMaxMs, 125);
    });
  });

  it('measures the synchronous delta application without changing its result', async () => {
    let now = 0;
    await withOpsCase({ globals: { performance: { now: () => (now += 4) } } }, (c) => {
      c.read(`allAgents = [{
        id: 'programming-helper',
        workspace_sessions: { revision: 1, activeSessionId: 'old', sessions: [{ id: 'old' }] }
      }]; SidebarOps.beginSidebarOperation({
        operationId: 'summary:apply', kind: 'summary', type: 'replacement',
        phase: 'generating', agentId: 'programming-helper', sourceSessionId: 'old'
      });`);
      const applied = c.read(`SidebarOps.applySidebarMutationDeltaWithDiagnostics('summary:apply', 'programming-helper', {
        revision: 2,
        sessionDelta: { revision: 2, activeSessionId: 'new', upsert: [{ id: 'new' }], remove: ['old'] }
      })`);
      assert.equal(applied, true);
      assert.deepEqual(Array.from(c.read('allAgents[0].workspace_sessions.sessions'), (item) => item.id), ['new']);
    });
  });

  it('flushes a bounded client diagnostic batch without operation content', async () => {
    const requests = [];
    const fetchStub = async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    // 排程 flush（模块内 250ms 定时器）改为微任务：不真实等待，仍走模块自身的
    // 排程 → 取批 → POST 链路。
    const immediateTimer = (callback) => { queueMicrotask(callback); return 0; };
    await withOpsCase({
      classic: (sandbox) => { sandbox.setTimeout = immediateTimer; },
      globals: { navigator: {}, fetch: fetchStub },
    }, async (c) => {
      c.read(`SidebarOps.beginSidebarOperation({
        operationId: 'summary:flush', kind: 'summary', type: 'replacement',
        phase: 'generating', agentId: 'programming-helper', sourceSessionId: 'source-1',
        projectDir: 'D:\\\\private', title: 'private title'
      })`);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, '/protoclaw/sidebar_diagnostics/events');
      const body = JSON.parse(requests[0].options.body);
      assert.equal(body.events.length, 1);
      assert.equal(body.events[0].operationId, 'summary:flush');
      assert.equal(JSON.stringify(body).includes('private title'), false);
      assert.equal(JSON.stringify(body).includes('D:\\\\private'), false);
    });
  });

  it('applies a revisioned delta and rejects an older delta', async () => {
    await withOpsCase({}, (c) => {
      c.read(`allAgents = [{
        id: 'programming-helper',
        active_workspace_session_id: 'old',
        workspace_sessions: {
          revision: 2,
          activeSessionId: 'old',
          sessions: [{ id: 'old', title: 'Old' }]
        }
      }]`);

      assert.equal(c.read(`SidebarOps.applySessionMutationDelta('programming-helper', {
        revision: 3,
        sessionDelta: {
          revision: 3, activeSessionId: 'new',
          upsert: [{ id: 'new', title: 'New' }], remove: ['old']
        }
      })`), true);
      assert.equal(c.read(`allAgents[0].workspace_sessions.revision`), 3);
      assert.deepEqual(
        Array.from(c.read(`allAgents[0].workspace_sessions.sessions.map((s) => s.id)`)),
        ['new'],
      );

      assert.equal(c.read(`SidebarOps.applySessionMutationDelta('programming-helper', {
        revision: 2,
        sessionDelta: {
          revision: 2, activeSessionId: 'old',
          upsert: [{ id: 'old', title: 'Stale' }], remove: ['new']
        }
      })`), false);
      assert.deepEqual(
        Array.from(c.read(`allAgents[0].workspace_sessions.sessions.map((s) => s.id)`)),
        ['new'],
      );

      assert.equal(c.read(`SidebarOps.applySessionMutationDelta('programming-helper', {
        revision: 0,
        sessionDelta: {
          revision: 0, activeSessionId: 'legacy',
          upsert: [{ id: 'legacy', title: 'Zero revision' }], remove: ['new']
        }
      })`), false);
      assert.deepEqual(
        Array.from(c.read(`allAgents[0].workspace_sessions.sessions.map((s) => s.id)`)),
        ['new'],
      );
    });
  });

  it('keeps an optimistic deletion removed when a newer full snapshot still contains it', async () => {
    await withOpsCase({}, (c) => {
      const merged = c.read(`(() => {
        SidebarOps.beginSidebarOperation({
          operationId: 'delete:one', type: 'delete', kind: 'delete', phase: 'committing',
          agentId: 'programming-helper', sourceSessionId: 'deleted'
        });
        return mergeWorkspaceSessionSnapshots(
          { revision: 5, activeSessionId: 'kept', sessions: [{ id: 'kept' }] },
          { revision: 6, activeSessionId: 'kept', sessions: [{ id: 'deleted' }, { id: 'kept' }] },
          'programming-helper'
        );
      })()`);
      assert.equal(merged.revision, 6);
      assert.deepEqual(Array.from(merged.sessions, (session) => session.id), ['kept']);
    });
  });

  it('does not allow a lower-revision snapshot to overwrite local state', async () => {
    await withOpsCase({}, (c) => {
      const merged = c.read(`mergeWorkspaceSessionSnapshots(
        { revision: 9, activeSessionId: 'new', sessions: [{ id: 'new' }] },
        { revision: 8, activeSessionId: 'old', sessions: [{ id: 'old' }] },
        'programming-helper'
      )`);
      assert.equal(merged.revision, 9);
      assert.deepEqual(Array.from(merged.sessions, (session) => session.id), ['new']);
    });
  });

  // 归属识别（045 读侧：选项目后轮询不被目录切片覆盖）：项目切片与目录切片是不同的集合。
  // 合并函数把目录切片当「更新的一版」patch 到项目列表上，项目会话会
  // 整体消失、徽标却仍是目录口径——表现为「项目的对话加载不出来」。
  it('replaces instead of patching when the projected ownership differs', async () => {
    await withOpsCase({}, (c) => {
      const merged = c.read(`mergeWorkspaceSessionSnapshots(
        { revision: 7, sessionProjectId: 'prj_aaaa', sessions: [{ id: 'a1', projectId: 'prj_aaaa' }] },
        { revision: 7, sessionProjectDir: 'D:/code/shared', sessions: [{ id: 'd1' }, { id: 'd2' }] },
        'programming-helper'
      )`);
      assert.deepEqual(Array.from(merged.sessions, (session) => session.id), ['d1', 'd2']);
      assert.equal(merged.sessionProjectDir, 'D:/code/shared');
      assert.equal(merged.sessionProjectId, undefined);
    });
  });

  it('merges snapshots that describe the same ownership', async () => {
    await withOpsCase({}, (c) => {
      const merged = c.read(`mergeWorkspaceSessionSnapshots(
        { revision: 7, sessionProjectId: 'prj_aaaa', sessions: [{ id: 'a1', title: 'old' }] },
        { revision: 8, sessionProjectId: 'prj_aaaa', sessions: [{ id: 'a1', title: 'new' }, { id: 'a2' }] },
        'programming-helper'
      )`);
      assert.deepEqual(Array.from(merged.sessions, (session) => session.id), ['a1', 'a2']);
      assert.equal(merged.sessions[0].title, 'new');
      assert.equal(merged.revision, 8);
    });
  });

  it('keeps legacy merge semantics when either snapshot declares no ownership', async () => {
    await withOpsCase({}, (c) => {
      // 未声明归属（全量 / 富回退 / 非 PH agent）：沿用既有合并行为
      const merged = c.read(`mergeWorkspaceSessionSnapshots(
        { revision: 3, sessions: [{ id: 'x', title: 'old' }] },
        { revision: 4, sessionProjectId: 'prj_aaaa', sessions: [{ id: 'x', title: 'new' }, { id: 'y' }] },
        'programming-helper'
      )`);
      assert.deepEqual(Array.from(merged.sessions, (session) => session.id), ['x', 'y']);
      assert.equal(merged.sessions[0].title, 'new');
    });
  });

  // 服务端读不到 workspace_state 时会降级成未声明归属的全量列表；它是全部
  // 归属的并集，不能拿来当当前视图的 membership 权威（否则视图里混入其他
  // 归属的会话）。
  it('does not let an ownership-less degraded snapshot replace an owned view', async () => {
    await withOpsCase({}, (c) => {
      const merged = c.read(`mergeWorkspaceSessionSnapshots(
        { revision: 9, sessionProjectId: 'prj_aaaa', sessions: [{ id: 'a1', projectId: 'prj_aaaa' }] },
        { revision: 10, sessions: [{ id: 'a1' }, { id: 'd1' }, { id: 'b1' }] },
        'programming-helper'
      )`);
      assert.deepEqual(Array.from(merged.sessions, (session) => session.id), ['a1']);
      assert.equal(merged.sessionProjectId, 'prj_aaaa');
    });
  });

  it('treats the same project directory name compared case-insensitively as one ownership', async () => {
    await withOpsCase({}, (c) => {
      const merged = c.read(`mergeWorkspaceSessionSnapshots(
        { revision: 3, sessionProjectDir: 'D:\\\\Code\\\\Proj', sessions: [{ id: 'x', title: 'old' }] },
        { revision: 4, sessionProjectDir: 'd:/code/proj/', sessions: [{ id: 'x', title: 'new' }] },
        'programming-helper'
      )`);
      assert.equal(merged.sessions[0].title, 'new');
    });
  });

  it('retains a committed upsert across lagging snapshots until the server echoes it', async () => {
    await withOpsCase({}, (c) => {
      c.read(`allAgents = [{
        id: 'programming-helper',
        workspace_sessions: { revision: 4, activeSessionId: 'old', sessions: [{ id: 'old' }] }
      }];
      SidebarOps.applySessionMutationDelta('programming-helper', {
        revision: 5,
        sessionDelta: { revision: 5, activeSessionId: 'new', upsert: [{ id: 'new', title: 'New' }] }
      })`);

      // Light snapshot / agent_detail that still lacks the committed session must
      // not drop it from the merged list (placeholder vanishing then reappearing).
      const lagging = c.read(`mergeWorkspaceSessionSnapshots(
        allAgents[0].workspace_sessions,
        { revision: 5, activeSessionId: 'old', sessions: [{ id: 'old' }] },
        'programming-helper'
      )`);
      assert.deepEqual(Array.from(lagging.sessions, (session) => session.id), ['new', 'old']);

      // Once the server echoes the id, fresh fields win and the entry leaves the
      // pending registry (no duplicate retention on later merges).
      const echoed = c.read(`mergeWorkspaceSessionSnapshots(
        allAgents[0].workspace_sessions,
        { revision: 5, activeSessionId: 'new', sessions: [{ id: 'old' }, { id: 'new', title: 'New (server)' }] },
        'programming-helper'
      )`);
      assert.deepEqual(Array.from(echoed.sessions, (session) => session.id), ['old', 'new']);
      assert.equal(echoed.sessions.find((session) => session.id === 'new').title, 'New (server)');

      const settled = c.read(`mergeWorkspaceSessionSnapshots(
        allAgents[0].workspace_sessions,
        { revision: 6, activeSessionId: 'new', sessions: [{ id: 'old' }, { id: 'new', title: 'New (server)' }] },
        'programming-helper'
      )`);
      assert.deepEqual(Array.from(settled.sessions, (session) => session.id), ['old', 'new']);
    });
  });

  it('appends a deeper page slice without dropping already-loaded entries', async () => {
    await withOpsCase({}, (c) => {
      const merged = c.read(`mergeWorkspaceSessionSnapshots(
        {
          revision: 5,
          sessionTotal: 4,
          sessionOffset: 0,
          sessionProjectDir: 'D:/code/Alpha',
          sessions: [{ id: 'a' }, { id: 'b' }]
        },
        {
          revision: 5,
          sessionTotal: 4,
          sessionOffset: 2,
          sessionProjectDir: 'D:/code/Alpha',
          sessions: [{ id: 'a', title: 'patched' }, { id: 'c' }, { id: 'd' }]
        },
        'programming-helper'
      )`);
      // 追加段不是 membership 权威：已加载 a/b 保留，重复 id 丢弃新段副本
      assert.deepEqual(Array.from(merged.sessions, (session) => session.id), ['a', 'b', 'c', 'd']);
      assert.equal(merged.sessionOffset, 2);
      assert.equal(merged.sessionTotal, 4);
      // 同 id 条目仍取 fresh 字段（服务端数据较新）
      assert.equal(merged.sessions.find((session) => session.id === 'a').title, 'patched');
    });
  });

  it('keeps the deeper loaded tail when a first-page refresh races a reload', async () => {
    await withOpsCase({}, (c) => {
      const merged = c.read(`mergeWorkspaceSessionSnapshots(
        {
          revision: 7,
          sessionTotal: 4,
          sessionOffset: 0,
          sessions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
        },
        {
          revision: 7,
          sessionTotal: 4,
          sessionOffset: 0,
          sessions: [{ id: 'a' }, { id: 'b' }]
        },
        'programming-helper'
      )`);
      // revision 未变：首屏切片（agent_detail 重聚焦）不应截断已加载的深层段
      assert.deepEqual(Array.from(merged.sessions, (session) => session.id), ['a', 'b', 'c', 'd']);
    });
  });

  it('keeps the deeper loaded tail when a first-page slice arrives with a bumped revision', async () => {
    await withOpsCase({}, (c) => {
      // revision 由一切会话变更推进（含每轮对话的 meta 同步），首屏切片携带更新的
      // revision 落地是常态而非竞态——尾部保护不能依赖 revision 相等，否则深层段
      // 被 60 条首屏截断后范围 poll 无法自愈（loadedCount 已随截断缩回）。
      const merged = c.read(`mergeWorkspaceSessionSnapshots(
        {
          revision: 7,
          sessionTotal: 4,
          sessionOffset: 0,
          sessions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
        },
        {
          revision: 8,
          sessionTotal: 4,
          sessionOffset: 0,
          sessions: [{ id: 'a' }, { id: 'b' }]
        },
        'programming-helper'
      )`);
      assert.equal(merged.revision, 8);
      assert.deepEqual(Array.from(merged.sessions, (session) => session.id), ['a', 'b', 'c', 'd']);
    });
  });

  it('adjusts pagination totals optimistically when a delta adds or removes sessions', async () => {
    await withOpsCase({}, (c) => {
      c.read(`allAgents = [{
        id: 'programming-helper',
        workspace_sessions: {
          revision: 4,
          activeSessionId: null,
          sessionTotal: 10,
          mainTotal: 8,
          archivedTotal: 2,
          sessions: [{ id: 'x', archived: true }, { id: 'y' }]
        }
      }];`);
      c.read(`SidebarOps.applySessionMutationDelta('programming-helper', {
        revision: 5,
        sessionDelta: { revision: 5, upsert: [{ id: 'new', title: 'New' }] }
      })`);
      let ws = c.read(`allAgents[0].workspace_sessions`);
      assert.deepEqual([ws.sessionTotal, ws.mainTotal, ws.archivedTotal], [11, 9, 2]);

      c.read(`SidebarOps.applySessionMutationDelta('programming-helper', {
        revision: 6,
        sessionDelta: { revision: 6, remove: ['x'] }
      })`);
      ws = c.read(`allAgents[0].workspace_sessions`);
      // 移除已归档会话：total 与 archived 同步递减
      assert.deepEqual([ws.sessionTotal, ws.mainTotal, ws.archivedTotal], [10, 9, 1]);
    });
  });

  it('keeps source-runtime observation out of session operation settlement', async () => {
    await withOpsCase({}, (c, ops) => {
      // 私有 helper 的缺席必须钉在模块导出面上：`typeof window.x` 对未定义键
      // 恒为 'undefined'，不能证明 helper 没有泄漏出去。先确认取到的是真实
      // 命名空间（有公开导出），缺席断言才不空洞。
      assert.equal(typeof ops.beginSidebarOperation, 'function', '命名空间是真实模块导出面');
      assert.ok(Object.keys(ops).length > 5, '导出面非空');
      assert.equal(Object.hasOwn(ops, 'settleSidebarSourceOperation'), false, 'helper 不在命名导出里');
      assert.equal(ops.settleSidebarSourceOperation, undefined);
      assert.equal(
        Object.prototype.hasOwnProperty.call(c.window, 'settleSidebarSourceOperation'),
        false,
        'helper 也不上桥（window 上没有该键）',
      );
    });
  });
});

describe('sidebar operation trace', () => {
  it('sanitizes operation ids and returns correlated phase timings', () => {
    const persisted = [];
    assert.equal(normalizeOperationId('  delete:abc / unsafe  '), 'delete:abcunsafe');
    const trace = createOperationTrace({
      operationId: 'create:trace',
      operation: 'create_session',
      agentId: 'programming-helper',
      sessionId: 'source-1',
      diagnosticWriter: (event) => persisted.push(event),
    });
    const phase = trace.mark('index_committed', {
      revision: 7,
      operationId: 'forged',
      phase: 'forged',
      elapsedMs: 999999,
    });
    assert.equal(phase.operationId, 'create:trace');
    assert.equal(phase.phase, 'index_committed');
    assert.equal(phase.revision, 7);
    assert.ok(phase.elapsedMs >= 0);
    assert.ok(phase.phaseDurationMs >= 0);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].kind, 'operation_phase');
    assert.equal(persisted[0].operationId, 'create:trace');
  });
});

describe('session index revision signature', () => {
  it('compares logical index content independently of property order and revision', () => {
    const first = sessionIndexContentSignature({
      revision: 4,
      activeSessionId: 'session-1',
      sessions: [{ id: 'session-1' }],
    });
    const second = sessionIndexContentSignature({
      sessions: [{ id: 'session-1' }],
      activeSessionId: 'session-1',
      revision: 99,
    });
    assert.equal(first, second);
  });
});
