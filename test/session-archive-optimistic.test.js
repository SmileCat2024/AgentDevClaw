/**
 * 归档乐观更新（session-mutation / sidebar-operations）——P2 装载路线。
 *
 * sidebar-operations / session-mutation / ctx-menu-items 已是 ESM：经
 * withP2EsmCase 的 `c.load` 真实 import（每 case 整图隔离）；classic 首屏
 * bootstrap（action-dispatcher / i18n / app-core / project-data /
 * sidebar-render / session-view-state / agent-data-loader）先跑，提供 kernel
 * 访问器桥（allAgents / lastRenderedWorkspaceHtml …）与宿主工厂。
 * app-main / app-ui 的宿主函数（渲染与记录更新）以最小替身注入。
 *
 * 真实边界重钉：模块私有 helper 不上桥（`archiveSessionAfterMutation` /
 * `beginSessionReplacementMutation` 是命名导出、零 classic 消费面），用例直接
 * 调用这两个真实导出，不再经 window 全局；撤桥后的 `finishSidebarOperation` /
 * `markSessionArchivedForMutation` / `reconcileArchivedSourceRuntime` 同理只经
 * 命名导出可达（classic 侧零消费面，不恢复同名 window 桥）。仍有 classic 消费面
 * 的桥键（getSessionReplacementMutation / listSidebarOperations）仍按裸标识符走
 * 真实访问器。
 */

import { describe, it as nodeIt } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { installForegroundSyncOwner } from './p2-classic-hosts.js';

const OPS = 'public/src/modules/sidebar-operations.js';
const MUTATION = 'public/src/modules/session-mutation.js';
const CTX_MENU = 'public/src/modules/ctx-menu-items.js';

/** classic 真源优先：只补齐 bootstrap 尚未声明的宿主全局。 */
function fillMissingGlobals(sandbox, stubs) {
  for (const [name, value] of Object.entries(stubs)) {
    if (sandbox.run(`typeof ${name} !== 'undefined'`)) continue;
    sandbox[name] = value;
  }
}

function bootstrapClassic(sandbox) {
  sandbox.currentLanguage = 'zh';
  sandbox.setInterval = () => 0;
  sandbox.loadSource('public/src/modules/action-dispatcher.js');
  // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
  sandbox.loadSource('public/src/app-core.js');
  sandbox.loadSource('public/src/modules/sidebar-render.js');
  sandbox.loadSource('public/src/modules/session-view-state.js');
  // resetRuntimeStatusForSwitch / patchRuntimeStatusForSwitch 的真实 owner：
  // loadAgentData 的切换链会经 window.* 调它，装载真源而不是补空替身。
  sandbox.loadSource('public/src/modules/runtime-status.js');
  // app-main 的 classic 同步引擎在装载期组合 createAgentCallStatesHost，并注册
  // sidebar-render 轮询/裁剪路径消费的两个桥键；引擎本身用真实实现。
  installForegroundSyncOwner(sandbox);
  sandbox.AgentLoaderHost = { loadedAgentDetailIds: new Set() };
  // 数据加载图的静态依赖（agent-data-loader → input-actions）在装载期取 app-main
  // 的轮询宿主工厂；本文件不驱动轮询，只要求装载期可解析。
  sandbox.createPollCoordinatorHost = () => ({});

  // 壳层桥接入口（app-main / input-helpers / runtime-status 的 window.* 桥）：
  // 真实 loadAgentData → 正文/输入/运行时状态三条刷新链都会在成功路径上调用
  // 它们，缺键会变成 TypeError（不是被测契约）。身份类按同一份经典状态投影，
  // 呈现类给空实现——本文件的断言不落在这些渲染上。
  const bridgeHostRecord = () => {
    const hostId = sandbox.normalizeAgentIdentity(sandbox.focusedAgentId);
    if (!hostId) return null;
    return (sandbox.allAgents || []).find(
      (agent) => sandbox.normalizeAgentIdentity(agent?.id) === hostId,
    ) || null;
  };
  if (typeof sandbox.getCurrentAgentRecord !== 'function') {
    sandbox.getCurrentAgentRecord = bridgeHostRecord;
  }
  if (typeof sandbox.getCurrentRuntimeRecord !== 'function') {
    sandbox.getCurrentRuntimeRecord = () => (sandbox.currentRuntimeAgentId
      && typeof sandbox.getRuntimeRecord === 'function'
      ? sandbox.getRuntimeRecord(sandbox.currentRuntimeAgentId) : null) || bridgeHostRecord();
  }
  if (typeof sandbox.updateRollbackActionVisibility !== 'function') {
    sandbox.updateRollbackActionVisibility = () => {};
  }
  if (typeof sandbox.renderRollbackActions !== 'function') {
    sandbox.renderRollbackActions = () => {};
  }
  // 常驻输入的动作按钮同步（owner: classic persistent-input 的
  // _syncPersistentActionButton）：运行时状态刷新链会裸调用它，缺键即
  // ReferenceError。本文件不断言该按钮，作为壳层缝给空实现。
  if (typeof sandbox._syncPersistentActionButton !== 'function') {
    sandbox._syncPersistentActionButton = () => {};
  }
  // 调用状态宿主由 app-main 的 classic 同步引擎在装载期组合真实
  // createAgentCallStatesHost（容器 = app-core / runtime-status 的 Map/Set），
  // 这里不再合成第二份宿主实现；下游渲染入口在下面按壳层缝覆盖。
  // 面板渲染入口（classic app-ui 的 renderFeaturePanel）不在本链：作为宿主
  // 缝显式提供空实现，避免真实快照 loader 的 renderPanel 抛 ReferenceError。
  sandbox.renderFeaturePanel = () => {};
  sandbox.createRuntimeSwitchHost = () => ({ state: {} });
  sandbox.createWorkspaceSurfaceHost = () => ({});
  sandbox.createCompactResumeHost = () => ({ state: {}, now: () => Date.now() });
  sandbox.performance = { now: () => 0 };
  fillMissingGlobals(sandbox, {
    CSS: { escape: (value) => String(value) },
    isRemoteNamespaceAgentId: (id) => typeof id === 'string' && id.startsWith('remote:'),
    setPreferredUnitMode: () => {},
    resolveFocusedAgentAfterRefresh: () => null,
    handlePrebuiltAgentClick: () => {},
    loadAgentDetail: async () => ({}),
    closeCompactMenu: () => {},
    alert: () => {},
    invoke: async () => ({}),
  });
  // 记录宿主调用
  sandbox.renderCount = 0;
  sandbox.updateAgentRecord = (agentId, updates = {}) => {
    let matched = null;
    sandbox.allAgents = sandbox.allAgents.map((agent) => {
      if (agent.id !== agentId) return agent;
      matched = { ...agent, ...updates };
      return matched;
    });
    return matched;
  };
  sandbox.renderCurrentMainView = () => { sandbox.renderCount += 1; };
  sandbox.renderAgentList = () => {};
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
let activeCase = null;

function it(name, fn) {
  nodeIt(name, async () => {
    const guard = createConsoleGuard();
    const fetchStub = async () => ({
      ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '',
    });
    await withP2EsmCase({
      classic: bootstrapClassic,
      globals: {
        fetch: fetchStub,
        CSS: { escape: (value) => String(value) },
        navigator: undefined,
        console: guard.recorder,
      },
    }, async (c) => {
      await c.load('public/src/modules/agent-data-loader.js');
      await c.load('public/src/modules/project-data.js');
      const ops = await c.load(OPS);
      const mutation = await c.load(MUTATION);
      await c.load(CTX_MENU);
      activeCase = { ctx: c.sandbox, mutation, ops };
      try {
        const result = await fn();
        guard.assertClean();
        return result;
      } finally {
        activeCase = null;
      }
    });
  });
}

/** 取当前用例的沙箱（装载已完成）。`fetch` 覆盖会同时落到 classic 与 ESM 侧。 */
function loadArchiveSandbox(overrides = {}) {
  if (!activeCase) throw new Error('loadArchiveSandbox 必须在用例体内调用');
  const ctx = activeCase.ctx;
  for (const [key, value] of Object.entries(overrides)) {
    ctx[key] = value;
    if (key === 'fetch') globalThis.fetch = value;
  }
  return ctx;
}

describe('session archive optimistic helper', () => {
  it('marks a session archived immediately and clears todo', () => {
    const ctx = loadArchiveSandbox();
    ctx.run(`
      allAgents = [{
        id: 'programming-helper',
        active_workspace_session_id: 'session-1',
        workspace_sessions: {
          activeSessionId: 'session-1',
          sessions: [
            { id: 'session-1', title: 'Old', archived: false, todo: true },
            { id: 'session-2', title: 'Other', archived: false }
          ]
        }
      }];
      lastRenderedWorkspaceHtml = 'cached';
    `);
    // 桥已注销（classic 零消费面）：只经真实命名导出调用，不恢复 window 同名桥
    activeCase.mutation.markSessionArchivedForMutation('programming-helper', 'session-1');

    const session = ctx.run(`allAgents[0].workspace_sessions.sessions.find((s) => s.id === 'session-1')`);
    assert.equal(session.archived, true);
    assert.equal(session.todo, false);
    assert.equal(ctx.run('allAgents[0].workspace_sessions.activeSessionId'), 'session-1');
    assert.equal(ctx.run('lastRenderedWorkspaceHtml'), '');
    assert.equal(ctx.renderCount, 1);
    assert.equal(ctx.run(`getSessionReplacementMutation('programming-helper', 'session-1').kind`), 'summary');
  });

  it('returns a rollback that restores the previous archive and todo state', () => {
    const ctx = loadArchiveSandbox();
    ctx.run(`
      allAgents = [{
        id: 'programming-helper',
        active_workspace_session_id: 'session-1',
        workspace_sessions: {
          activeSessionId: 'session-1',
          sessions: [
            { id: 'session-1', title: 'Old', archived: false, todo: true }
          ]
        }
      }];
    `);
    // 真实命名导出（桥已注销）：乐观归档返回的回滚函数仍是直接调用面
    const rollback = activeCase.mutation.markSessionArchivedForMutation('programming-helper', 'session-1');
    rollback();

    const session = ctx.run(`allAgents[0].workspace_sessions.sessions[0]`);
    assert.equal(session.archived, false);
    assert.equal(session.todo, true);
    assert.equal(ctx.renderCount, 2);
  });

  it('uses the rollback when final archive confirmation fails', async () => {
    const ctx = loadArchiveSandbox({
      fetch: async () => ({ ok: false, text: async () => 'archive failed' }),
    });
    ctx.invoke = async () => {
      throw new Error('runtime stop should not run');
    };

    ctx.run(`
      allAgents = [{
        id: 'programming-helper',
        active_workspace_session_id: 'session-1',
        workspace_sessions: {
          activeSessionId: 'session-1',
          sessions: [
            { id: 'session-1', title: 'Old', archived: false, todo: true }
          ]
        }
      }];
    `);
    // 桥已注销（classic 侧零消费面）：只经真实命名导出取回乐观归档的回滚函数
    const rollback = activeCase.mutation.markSessionArchivedForMutation('programming-helper', 'session-1');
    // 真实导出（模块私有 helper 不上桥）
    const ok = await activeCase.mutation.archiveSessionAfterMutation(
      'programming-helper', 'session-1', 'runtime-1', { skipOptimisticArchive: true, rollback },
    );

    assert.equal(ok, false);
    const session = ctx.run(`allAgents[0].workspace_sessions.sessions[0]`);
    assert.equal(session.archived, false);
    assert.equal(session.todo, true);
    assert.equal(ctx.run(`getSessionReplacementMutation('programming-helper', 'session-1')`), null);
  });

  it('separates archived source cleanup from the committed replacement operation', async () => {
    const ctx = loadArchiveSandbox();
    let stopCalls = 0;
    ctx.invoke = async (command, payload) => {
      // 真实 refresh 会补一轮连接快照读；只统计 stop 请求（断言「不再补发 stop」）
      if (command !== 'stop_agent') return [];
      stopCalls += 1;
      assert.equal(payload.agentId, 'programming-helper');
      assert.equal(payload.sessionId, 'session-1');
      return {};
    };
    ctx.run(`
      allAgents = [{
        id: 'programming-helper',
        workspace_sessions: { activeSessionId: 'session-1', sessions: [{ id: 'session-1' }] }
      }];
    `);
    const operation = activeCase.mutation.beginSessionReplacementMutation('programming-helper', 'session-1', 'summary');
    // 撤桥后只经命名导出结算（classic 消费面已归零，不恢复 window 同名桥）
    activeCase.ops.finishSidebarOperation(operation.operationId, 'settled');
    activeCase.mutation.reconcileArchivedSourceRuntime('programming-helper', 'session-1', 'runtime-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(stopCalls, 0);
    // 提交边界已结算的 replacement 记录不再参与呈现；源 runtime 清理不复活它
    assert.equal(ctx.run(`getSessionReplacementMutation('programming-helper', 'session-1')`), null);
    assert.equal(
      ctx.run(`listSidebarOperations((op) => op.type === 'replacement' && op.agentId === 'programming-helper').length`),
      0,
    );
  });
});
