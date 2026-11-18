/**
 * Tests for the archived source runtime optimistic retirement in the sidebar.
 *
 * 覆盖（精简/摘要/分支/归档共用链路）：
 *   - markPendingRuntimeStop 后侧栏投影立即隐藏源 runtime 条目（child 与宿主
 *     合成条目），兄弟条目与 operation 占位不受影响
 *   - reconcilePendingRuntimeStops：权威快照不再包含该实例时解除抑制；
 *     时间流逝不代表失败，同 Session 新实例不受旧关闭意图影响
 *   - reconcileArchivedSourceRuntime：确认退役后协调呈现，不再补发 stop；
 *     读取失败不能撤销已确认的关闭
 *
 * 装载路线（P2 ESM 配方第三节）：sidebar-operations / session-mutation 已是 ESM，
 * 经 withP2EsmCase 的 `c.load` 真实 import；`collectRuntimeEntriesForPrebuilt`
 * 的实现方 runtime-status 仍是 classic，按真实顺序在首屏 bootstrap 后
 * loadSource。classic 侧只加载真实 owner（action-dispatcher / i18n / app-core /
 * project-data / sidebar-render / session-view-state）；**宿主工厂优先用真实
 * 实现**：`createAgentSnapshotLoaderHost` 与侧栏渲染宿主都取自 sidebar-render
 * 自己的工厂（agent-snapshot-loader / agent-call-states 在模块求值期 spread 它），
 * 只有 owner 不在本链（app-main 的切换事务与调用状态词法集合、app-ui 的表面宿主、
 * 布局宿主）才按声明契约补齐键。
 *
 * 失败语义（S1）：`reconcileArchivedSourceRuntime` 的刷新链是真实
 * external-runtime → agent-snapshot-loader；失败用例由真实读数失败
 * （invoke / viewer 请求抛错）驱动，断言实际发出的请求、pending 保留、条目隐藏
 * 与「不重发 stop」，并区分「真实网络读数失败」与「宿主面缺键 TypeError」。
 * 成功路径额外断言 console 无未预期的 error / warn（不静默异常）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { APP_CORE_DOMAIN, installForegroundSyncOwner, prepareEsmModules, prepareSidebarDomain, SESSION_VIEW_DOMAIN } from './p2-classic-hosts.js';

const OPS = 'public/src/modules/sidebar-operations.js';
const MUTATION = 'public/src/modules/session-mutation.js';
const RUNTIME_STATUS = 'public/src/modules/runtime-status.js';

// 真 Date 先落成词法引用：globals 会把主 realm 的 Date 换成 FakeDate，
// 类体里的裸 `Date` 否则会解析到 FakeDate 自身（递归）。
const RealDate = Date;
class FakeDate extends RealDate {}
let clockOffsetMs = 0;
FakeDate.now = () => RealDate.now() + clockOffsetMs;

const settle = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * console 记录器：直通宿主 console（不吞任何输出），同时按等级收集，
 * 供用例断言「成功路径没有未预期错误」。
 */
function createConsoleRecorder() {
  // 词法捕获宿主 console：用例期间 globalThis.console 会换成 recorder，
  // 直通必须走宿主引用，否则递归。
  const host = globalThis.console;
  const entries = { error: [], warn: [], log: [] };
  const format = (args) => args
    .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
    .join(' ');
  const recorder = {
    ...host,
    error: (...args) => { entries.error.push(format(args)); host.error(...args); },
    warn: (...args) => { entries.warn.push(format(args)); host.warn(...args); },
    log: (...args) => { entries.log.push(format(args)); host.log(...args); },
    info: (...args) => { entries.log.push(format(args)); host.info(...args); },
  };
  return { recorder, entries };
}

/** classic 首屏 bootstrap + 仅 owner 不在链上的宿主替身。 */
function bootstrap(sandbox) {
  sandbox.t = (key) => key;
  sandbox.currentLanguage = 'zh';
  sandbox.currentMessages = [];
  sandbox.normalizeAgentIdentity = (x) => String(x || '').trim();
  sandbox.getPathLeaf = (value) => String(value || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
  sandbox.toEpochMs = (value) => Date.parse(value || '') || 0;
  sandbox.performance = { now: () => 0 };
  sandbox.renderCount = 0;
  sandbox.setInterval = () => 0;
  sandbox.loadSource('public/src/modules/action-dispatcher.js');
  // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
  prepareEsmModules(sandbox, APP_CORE_DOMAIN);
  prepareSidebarDomain(sandbox);
  prepareEsmModules(sandbox, SESSION_VIEW_DOMAIN);

  // 宿主替身（owner 不在本链）：切换事务（app-main）、表面选择（app-ui）、
  // 详情加载器、布局宿主、面板渲染入口。调用状态宿主按真实工厂的键集合补齐。
  // 这些键都是真实工厂里 `typeof x === 'function' ? x() : …` 的调用目标，
  // 缺键会让成功路径变成 ReferenceError，因此显式提供而非依赖吞错。
  sandbox.createRuntimeSwitchHost = () => ({ state: {} });
  // 常驻输入按钮同步（owner: persistent-input-api 桥键；本链不装输入面）：
  // runtime-status 的收尾/复位路径会调用它。
  sandbox._syncPersistentActionButton = () => {};
  sandbox._syncPersistentInputUi = () => {};
  sandbox._syncQueueFromBackend = () => {};
  sandbox.runWithSuppressedChatViewportObservers = (fn) => fn?.();
  sandbox.createWorkspaceSurfaceHost = () => {};
  sandbox.AgentLoaderHost = { loadedAgentDetailIds: new Set() };
  // 数据加载图静态依赖（agent-data-loader → input-actions）在装载期取 app-main
  // 的轮询宿主工厂；本文件不驱动轮询。
  sandbox.createPollCoordinatorHost = () => ({});
  sandbox.window.ClawSidebarLayout = {
    isInteracting: () => false,
    signature: () => 'fixture-layout',
    load: async () => {},
    render: () => {},
    toggle: () => {},
  };
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
  sandbox.renderAgentList = () => { sandbox.renderCount += 1; };
  sandbox.renderFeaturePanel = () => {};
  sandbox.loadAgentDetail = async () => ({});
  sandbox.selectWorkspaceSurface = () => {};
  sandbox.setPreferredUnitMode = () => {};
  sandbox.resolveFocusedAgentAfterRefresh = () => null;
  sandbox.handlePrebuiltAgentClick = () => {};
  sandbox.isRemoteNamespaceAgentId = (id) => typeof id === 'string' && id.startsWith('remote:');
  sandbox.getVisibleRemoteEntries = () => [];
  // 连接快照的 wire 形状是数组；默认给空快照（有读请求时用例自行覆盖）
  sandbox.invoke = async () => [];
  // app-main 的 classic 同步引擎（唯一 owner）：runtime-status 就位后再装，
  // 引擎装载期组合真实 createAgentCallStatesHost 并登记 sidebar-render 轮询/裁剪
  // 路径消费的两个桥键。
  installForegroundSyncOwner(sandbox);
}

/**
 * 每个用例一份 window + 一张 ESM 图。`expectConsole` 声明该用例**预期**出现的
 * console 行（正则）；其余任何 error / warn 都会让用例失败——成功路径的
 * TypeError / ReferenceError 不会被吞掉。
 */
async function withStopCase(options, fn) {
  const { classic, globals = {}, expectConsole = [] } = options || {};
  const { recorder, entries } = createConsoleRecorder();
  return withP2EsmCase({
    classic: (sandbox) => {
      bootstrap(sandbox);
      if (typeof classic === 'function') classic(sandbox);
    },
    globals: { navigator: undefined, Date: FakeDate, console: recorder, ...globals },
  }, async (c) => {
    await c.load('public/src/modules/agent-data-loader.js');
    // project-data 已迁 ESM（宿主工厂在调用时点经它的桥键读取归属参数）
    await c.load('public/src/modules/project-data.js');
    const ops = await c.load(OPS);
    // sidebar-operations 已把入口从 KernelState 桥注销（消费方一律具名 import）：
    // classic 侧脚本按**模块命名空间**调用同一批 ESM 导出（不逐函数恢复顶层名字）。
    c.expose('SidebarOps', ops);
    c.expose('Mutation', await c.load(MUTATION));
    const result = await fn(c, entries);
    const unexpected = [...entries.error, ...entries.warn]
      .filter((line) => !expectConsole.some((pattern) => pattern.test(line)));
    assert.deepEqual(unexpected, [], '成功路径不应产生未预期的 console.error / console.warn');
    return result;
  });
}

const HOST = `{
  id: 'programming-helper', source: 'prebuilt',
  workspace_sessions: { sessions: [] }
}`;

const SOURCE_CHILD = `{
  id: 'runtime-1', source: 'child', parent_id: 'programming-helper',
  sessionType: 'main', sidebar_entry_id: 'programming-helper',
  runtime_session_id: 'runtime-1', active_workspace_session_id: 'session-1',
  created_at: '2026-01-01T00:00:01.000Z', connected: true
}`;

const SIBLING_CHILD = `{
  id: 'runtime-2', source: 'child', parent_id: 'programming-helper',
  sessionType: 'main', sidebar_entry_id: 'programming-helper',
  runtime_session_id: 'runtime-2', active_workspace_session_id: 'session-2',
  created_at: '2026-01-01T00:00:02.000Z', connected: true
}`;

/** 权威连接快照（wire 形状）：仍包含 runtime-1 的宿主条目。 */
const connectedWire = () => [{
  id: 'programming-helper',
  name: 'PH',
  source: 'prebuilt',
  runtime_session_id: 'runtime-1',
  active_workspace_session_id: 'session-1',
  connected: true,
  workspace_sessions: {
    revision: 1,
    activeSessionId: 'session-1',
    sessions: [{ id: 'session-1', title: 'T' }],
  },
}];

describe('sidebar: archived source runtime optimistic retirement', () => {
  it('hides the pending-stop child entry from the projection while siblings stay visible', async () => {
    await withStopCase({}, (c) => {
      const before = c.read(`collectRuntimeEntriesForPrebuilt(${HOST}, [${SOURCE_CHILD}, ${SIBLING_CHILD}])`);
      assert.equal(before.map((e) => e.runtimeId).sort().join(','), 'runtime-1,runtime-2');

      c.read(`SidebarOps.markPendingRuntimeStop('programming-helper', 'session-1', 'runtime-1')`);
      const after = c.read(`collectRuntimeEntriesForPrebuilt(${HOST}, [${SOURCE_CHILD}, ${SIBLING_CHILD}])`);
      assert.equal(after.map((e) => e.runtimeId).join(','), 'runtime-2');
    });
  });

  it('hides the host synthetic entry when the host primary runtime is pending stop', async () => {
    await withStopCase({}, (c) => {
      c.read(`SidebarOps.markPendingRuntimeStop('programming-helper', 'session-1', 'runtime-1')`);
      const entries = c.read(`collectRuntimeEntriesForPrebuilt({
        id: 'programming-helper', source: 'prebuilt', runtime_session_id: 'runtime-1',
        active_workspace_session_id: 'session-1', active_workspace_display_name: 'Host Primary',
        workspace_sessions: { sessions: [] }
      }, [${SIBLING_CHILD}])`);
      assert.equal(entries.map((e) => e.runtimeId).join(','), 'runtime-2');
    });
  });

  it('keeps operation placeholder entries visible while their source runtime is hidden', async () => {
    await withStopCase({}, (c) => {
      c.read(`
        SidebarOps.markPendingRuntimeStop('programming-helper', 'session-1', 'runtime-1');
        SidebarOps.beginSidebarOperation({
          operationId: 'trim:retirement', type: 'create', kind: 'trim', phase: 'generating',
          agentId: 'programming-helper', sourceSessionId: 'session-1',
          targetSessionId: 'session-new',
          projectDir: 'D:\\\\code\\\\project-a', projectName: 'project-a'
        });
      `);
      const entries = c.read(`collectRuntimeEntriesForPrebuilt(${HOST}, [${SOURCE_CHILD}])`);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].source, 'operation-pending');
      assert.equal(entries[0].name, '正在生成精简会话…');
    });
  });

  it('releases the suppression once the polling snapshot no longer contains the runtime', async () => {
    await withStopCase({}, (c) => {
      c.read(`SidebarOps.markPendingRuntimeStop('programming-helper', 'session-1', 'runtime-1')`);
      c.read(`reconcilePendingRuntimeStops([{ id: 'runtime-2', source: 'child', parent_id: 'programming-helper', runtime_session_id: 'runtime-2', active_workspace_session_id: 'session-2' }])`);
      assert.equal(c.read(`isRuntimeStopPending('programming-helper', 'session-1', 'runtime-1')`), false);
      const entries = c.read(`collectRuntimeEntriesForPrebuilt(${HOST}, [${SOURCE_CHILD}])`);
      assert.equal(entries.map((e) => e.runtimeId).join(','), 'runtime-1');
    });
  });

  it('closing one instance does not hide a newly started instance of the same session', async () => {
    await withStopCase({}, (c) => {
      c.read(`SidebarOps.markPendingRuntimeStop('programming-helper', 'session-1', 'runtime-1')`);
      assert.equal(c.read(`isRuntimeStopPending('programming-helper', 'session-1', 'runtime-new')`), false);
      c.read(`reconcilePendingRuntimeStops([{ id: 'runtime-new', source: 'child', parent_id: 'programming-helper', active_workspace_session_id: 'session-1' }])`);
      assert.equal(c.read(`isRuntimeStopPending('programming-helper', 'session-1', 'runtime-1')`), false);
    });
  });

  it('keeps the suppression while the snapshot still contains the runtime', async () => {
    await withStopCase({}, (c) => {
      c.read(`SidebarOps.markPendingRuntimeStop('programming-helper', 'session-1', 'runtime-1')`);
      c.read(`reconcilePendingRuntimeStops([{ id: 'runtime-1', source: 'child', parent_id: 'programming-helper', runtime_session_id: 'runtime-1', active_workspace_session_id: 'session-1' }])`);
      assert.equal(c.read(`isRuntimeStopPending('programming-helper', 'session-1', 'runtime-1')`), true);
      const entries = c.read(`collectRuntimeEntriesForPrebuilt(${HOST}, [${SOURCE_CHILD}])`);
      assert.equal(entries.length, 0);
    });
  });

  it('keeps a pending close hidden until a receipt or authoritative snapshot, never a timer', async () => {
    // Date 经 globals 同时注入沙箱与主 realm（ESM 侧读写同一时钟），
    // 使「31 秒流逝」真实作用于被测实现。
    await withStopCase({}, (c) => {
      c.read(`SidebarOps.markPendingRuntimeStop('programming-helper', 'session-1', 'runtime-1')`);
      assert.equal(c.read(`isRuntimeStopPending('programming-helper', 'session-1', 'runtime-1')`), true);
      clockOffsetMs = 31000;
      try {
        assert.equal(c.read(`isRuntimeStopPending('programming-helper', 'session-1', 'runtime-1')`), true);
        c.read(`reconcilePendingRuntimeStops([{ id: 'runtime-1', source: 'child', parent_id: 'programming-helper', runtime_session_id: 'runtime-1', active_workspace_session_id: 'session-1' }])`);
        assert.equal(c.read(`collectRuntimeEntriesForPrebuilt(${HOST}, [${SOURCE_CHILD}])`).length, 0);
        c.read(`SidebarOps.releasePendingRuntimeStop('runtime-1', 'programming-helper', 'session-1')`);
        assert.equal(c.read(`collectRuntimeEntriesForPrebuilt(${HOST}, [${SOURCE_CHILD}])`).length, 1);
      } finally {
        clockOffsetMs = 0;
      }
    });
  });

  it('reconcileArchivedSourceRuntime hides retired entries without another stop request', async () => {
    const requests = { invokes: [], stops: [], fetches: [] };
    await withStopCase({
      classic: (sandbox) => {
        // 真实读链（external-runtime → agent-snapshot-loader）的 wire：
        // 连接快照仍包含该 runtime（抑制由后续权威快照解除，不由本次读解除）。
        sandbox.invoke = async (command, payload) => {
          requests.invokes.push(command);
          if (command === 'stop_agent') {
            requests.stops.push(payload);
            return {};
          }
          if (command === 'get_connected_agents') return connectedWire();
          return {};
        };
        sandbox.fetch = async (url) => {
          requests.fetches.push(String(url));
          if (String(url).startsWith('/protoclaw/ph_project/projects')) return { ok: true, json: async () => ({ projects: [] }) };
          return { ok: true, json: async () => ({ agents: [] }) };
        };
      },
    }, async (c) => {
      c.read(`Mutation.reconcileArchivedSourceRuntime('programming-helper', 'session-1', 'runtime-1')`);
      assert.equal(c.read(`isRuntimeStopPending('programming-helper', 'session-1', 'runtime-1')`), true);
      assert.equal(c.read(`collectRuntimeEntriesForPrebuilt(${HOST}, [${SOURCE_CHILD}])`).length, 0);
      await settle(5);
      // 刷新链真的发了权威读（不是空跑），且没有再补发 stop
      assert.ok(requests.invokes.includes('get_connected_agents'), '刷新读取连接快照');
      assert.ok(requests.fetches.includes('/api/agents'), '刷新读取 viewer 存活');
      assert.deepEqual(requests.stops, [], '确认退役后不得补发 stop');
      // stop 成功返回后抑制保留，由轮询快照（reconcile）解除。
      assert.equal(c.read(`isRuntimeStopPending('programming-helper', 'session-1', 'runtime-1')`), true);
      assert.equal(c.read(`collectRuntimeEntriesForPrebuilt(${HOST}, [${SOURCE_CHILD}])`).length, 0);
    });
  });

  it('a failed projection refresh cannot undo confirmed archive retirement', async () => {
    const requests = { invokes: [], fetches: [], stops: [] };
    await withStopCase({
      classic: (sandbox) => {
        // 真实失败读数：连接快照请求抛错、viewer 请求失败。
        sandbox.invoke = async (command, payload) => {
          requests.invokes.push(command);
          if (command === 'stop_agent') { requests.stops.push(payload); return {}; }
          throw new Error('connected read failed');
        };
        sandbox.fetch = async (url) => {
          requests.fetches.push(String(url));
          throw new Error('viewer read failed');
        };
      },
      // 预期日志：一次真实读数失败（loader）+ 一次刷新在飞读被拒（归档链）
      expectConsole: [/Failed to load agents/, /Failed to refresh archived session projection/],
    }, async (c, consoleEntries) => {
      // 阶段一：真实读数失败 → 刷新不成立，但已确认的关闭不被撤销
      c.read(`Mutation.reconcileArchivedSourceRuntime('programming-helper', 'session-1', 'runtime-1')`);
      await settle(5);
      assert.ok(requests.invokes.includes('get_connected_agents'), '刷新真的发起了连接快照读');
      assert.ok(requests.fetches.includes('/api/agents'), '刷新真的发起了 viewer 读');
      assert.ok(consoleEntries.error.some((line) => /Failed to load agents/.test(line)));
      assert.ok(
        consoleEntries.error.some((line) => /connected read failed|viewer read failed/.test(line)),
        '失败原因是真实读数，而不是宿主缺键',
      );
      assert.equal(c.read(`isRuntimeStopPending('programming-helper', 'session-1', 'runtime-1')`), true);
      assert.equal(c.read(`collectRuntimeEntriesForPrebuilt(${HOST}, [${SOURCE_CHILD}])`).length, 0);

      // 阶段二：刷新在等待在飞权威读时被拒绝 → 归档链自身的失败分支
      const inFlight = Promise.withResolvers();
      c.window.loadAgentsInFlight = inFlight.promise;
      c.read(`Mutation.reconcileArchivedSourceRuntime('programming-helper', 'session-1', 'runtime-1')`);
      await settle(2);
      inFlight.reject(new Error('authoritative read rejected'));
      await settle(5);
      assert.ok(consoleEntries.warn.some((line) => /Failed to refresh archived session projection/.test(line)));
      assert.ok(
        consoleEntries.warn.some((line) => /authoritative read rejected/.test(line)),
        '告警携带真实拒绝原因',
      );

      // 两条失败路径都不得撤销已确认的关闭，也不得补发 stop
      assert.equal(
        [...consoleEntries.error, ...consoleEntries.warn].some((line) => /TypeError|ReferenceError|is not a function/.test(line)),
        false,
        '成功装配的宿主面不应出现缺键异常',
      );
      assert.deepEqual(requests.stops, [], '失败刷新不得补发 stop');
      assert.equal(c.read(`isRuntimeStopPending('programming-helper', 'session-1', 'runtime-1')`), true);
      assert.equal(c.read(`collectRuntimeEntriesForPrebuilt(${HOST}, [${SOURCE_CHILD}])`).length, 0);
    });
  });
});
