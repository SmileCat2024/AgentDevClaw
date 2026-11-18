/**
 * P2 批次 W2-6（侧栏操作与会话状态）交付钉子。
 *
 * 钉什么：
 *   1. 批次 ESM 入口（p2-w2-6-sidebar-session-bootstrap.js）真实装载后，
 *      classic 消费方经 kernel-state 访问器桥取到同一实现、同一状态引用；
 *   2. classic 写方 ↔ ESM owner 双向转发（待停止 runtime 抑制、操作记录）；
 *   3. 原业务语义：会话快照合并（归属身份 / 追加段 / 尾部保护 / revision 倒退）、
 *      applySessionMutationDelta 的旧 revision 拒绝与增量应用、会话替换 mutation 的
 *      乐观归档与回滚、导航代次过期放弃、外部 runtime 关闭通道解析与本地化错误；
 *   4. session-ui 渲染助手与排序偏好经 phSessionUi 适配面读取（classic 晚绑定
 *      getCurrentAgentRecord 同样覆盖）；
 *   5. 模块私有 helper 不造桥：桥键集合与各文件声明的兼容面一致。
 *
 * 装载路线（配方第三节「真实 import」）：classic 相按真实顺序执行**仍 classic**
 * 的唯一实现（action-dispatcher / app-core / sidebar-render / session-view-state）；
 * 本批 ESM 入口与项目数据域（project-data，classic 消费方经 window 晚绑定的
 * updateAgentRecord / getPathLeaf 由此上桥）经 `withP2EsmCase` + `c.load` 真实
 * import，**每个用例一份独立模块图**（桥键注册、操作记录与状态代次不跨用例）。
 *
 * 未装载的 classic owner 用同形宿主桩：createRuntimeSwitchHost（app-main 的切换
 * 事务）、createAgentCallStatesHost（app-main 侧 call 状态宿主面）、
 * createWorkspaceSurfaceHost（app-ui 的导航宿主面），本批只消费其调用契约；
 * renderAgentList / renderCurrentMainView 包一层调用计数以钉住「提交后失效」的
 * 渲染时点。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const ENTRY = 'public/src/modules/p2-w2-6-sidebar-session-bootstrap.js';
const MODULES = {
  store: 'public/src/modules/agent-store-state.js',
  renderEntry: 'public/src/modules/render-entry-state.js',
  orchestration: 'public/src/modules/orchestration-state.js',
  ops: 'public/src/modules/sidebar-operations.js',
  sessionUi: 'public/src/modules/session-ui.js',
  mutation: 'public/src/modules/session-mutation.js',
  external: 'public/src/modules/external-runtime.js',
  pin: 'public/src/modules/sidebar-pin-color.js',
  projectData: 'public/src/modules/project-data.js',
};

/** 包裹 kernel-state 的注册/认领，记录本用例入口装载期的 (domain, key)。 */
function recordKernelRegistrations(kernel) {
  const keys = [];
  const claims = [];
  const originalDefineKey = kernel.defineKey;
  const originalClaim = kernel.claim;
  kernel.defineKey = (domain, key, initialValue) => {
    keys.push(`${domain}:${key}`);
    return originalDefineKey.call(kernel, domain, key, initialValue);
  };
  kernel.claim = (domain, impl) => {
    claims.push(domain);
    return originalClaim.call(kernel, domain, impl);
  };
  return {
    recorded: { keys, claims },
    restore() {
      kernel.defineKey = originalDefineKey;
      kernel.claim = originalClaim;
    },
  };
}

/**
 * 一个用例 = 一份 classic 沙箱 + 一份真实 ESM 图；`fn` 拿到 c 与本批模块命名空间。
 * `options.globals` 追加到沙箱与主 realm（如 fetch 桩）。
 */
async function withSidebarCase(options, fn) {
  const { globals = {}, record = false } = options || {};
  const consoleErrors = [];
  return withP2EsmCase({
    globals: {
      // markdown-utils 等真实 ESM 依赖在装载期注册 data-action 处理器
      ClawFW: { actions: { handlers: {}, registerMany(map) { Object.assign(this.handlers, map); } } },
      console: { ...console, error: (...args) => consoleErrors.push(args) },
      // 侧栏诊断队列在无 navigator 时不排程 flush（模块内的原判定），避免测试残留定时器
      navigator: undefined,
      ...globals,
    },
    classic: (sandbox) => {
      // 桥面记录必须在 classic 相就装上：侧栏域（runtime-status / sidebar-render）
      // 自 P4 T2 起在模块相求值，且 sidebar-render 静态依赖 project-data → session-ui
      // → sidebar-operations，这些域的桥键会在 pending prep 阶段先注册（早于用例体）。
      if (record) sandbox.__kernelRecorder = recordKernelRegistrations(sandbox.KernelState);
      // 真实装载链（顺序同 index.html）：宿主工厂 createRuntimeSwitchHost /
      // createCompactResumeHost / createAgentCallStatesHost ← app-main，
      // createWorkspaceSurfaceHost ← app-ui，全部是生产实现（boot 体不驱动）。
      prepareClassicSandbox(sandbox);
      sandbox.renderListCalls = 0;
      sandbox.renderMainCalls = 0;
      // 侧栏重绘的观测点：sidebar-render 迁 ESM 后 `renderAgentList` 不再是可替换的
      // classic 全局，改用真实渲染入口每次都会调用的顶栏 chrome（不改变断言强度：
      // 仍以「重绘被触发」为事实）。
      sandbox.updateCurrentAgentChrome = () => { sandbox.renderListCalls += 1; };
      sandbox.renderCurrentMainView = () => { sandbox.renderMainCalls += 1; };
    },
  }, async (c) => {
    const kernelRecorder = record ? c.window.__kernelRecorder : null;
    try {
      await c.load(ENTRY);
    } finally {
      kernelRecorder?.restore();
    }
    // 项目数据域：sidebar-operations / session-mutation 经 window 晚绑定
    // updateAgentRecord / getPathLeaf；生产里同一批模块图一并装载。
    await c.load(MODULES.projectData);
    const modules = {};
    for (const [name, path] of Object.entries(MODULES)) {
      if (name === 'projectData') continue;
      modules[name] = await c.load(path);
    }
    const result = await fn({ c, ...modules, recorded: kernelRecorder?.recorded });
    assert.equal(c.timerCount(), 0, '用例结束不应残留计时器');
    assert.deepEqual(consoleErrors, [], '用例内不应出现非预期 console 异常');
    return result;
  });
}

test('批次入口装载后 classic 消费方经访问器桥取到同一实现与同一状态引用', async () => {
  await withSidebarCase({}, async ({ c, pin, sessionUi }) => {
    const adapter = c.window.createP2BootstrapSidebarRenderHost();

    // 访问器形态：get/set 成对、不进入 for-in（与顶层 let 一致）
    const descriptor = Object.getOwnPropertyDescriptor(c.window, 'getWorkspaceSessions');
    assert.equal(typeof descriptor.get, 'function');
    assert.equal(typeof descriptor.set, 'function');
    assert.equal(descriptor.enumerable, false);

    // classic 裸标识符调用（解析到 window 属性）→ ESM 实现
    const sessions = c.read('getWorkspaceSessions({ workspace_sessions: { sessions: [{ id: "s1" }, { id: "s2" }] } })');
    // 沙箱返回的是 vm realm 的数组，先落到主 realm 再比较
    assert.deepEqual([...sessions].map((session) => session.id), ['s1', 's2']);

    // 状态键按引用交出：classic 读到的就是 ESM 侧同一 Set
    const colors = c.read('SIDEBAR_TODO_COLORS');
    assert.equal(colors.has('red'), true);
    assert.equal(colors.has('purple'), false);

    // 色板原形态是**可写** window 属性：认领后 classic 整值替换必须真转发进模块绑定，
    // 不能只落在桥槽（模块内 applyTodoColor 的色值门禁读的是同一个 let 绑定）。
    const originalColors = pin.SIDEBAR_TODO_COLORS;
    assert.equal(originalColors, colors);
    const replacedColors = new Set(['white']);
    c.window.SIDEBAR_TODO_COLORS = replacedColors;             // classic 写方（访问器 setter）
    assert.equal(pin.SIDEBAR_TODO_COLORS, replacedColors);      // 模块绑定 = 新实例（同一引用）
    assert.equal(c.read('SIDEBAR_TODO_COLORS'), replacedColors);
    assert.equal(c.read('SIDEBAR_TODO_COLORS.has("red")'), false);
    c.window.SIDEBAR_TODO_COLORS = originalColors;              // 还原
    assert.equal(pin.SIDEBAR_TODO_COLORS, originalColors);

    // 跨模块 UI 状态：消费方（ESM session-list-render）已改直引 → 不再上桥，
    // 只保留 live binding + 整值写入口；两侧 import 读同一实例。
    const cache = sessionUi._phOpenSessionsCache;
    assert.equal(Object.prototype.hasOwnProperty.call(c.window, '_phOpenSessionsCache'), false);
    cache.html = '<div class="ph-open-sessions-card"></div>';
    assert.equal(sessionUi._phOpenSessionsCache.html, '<div class="ph-open-sessions-card"></div>');
    cache.html = '';
    cache.sig = null;

    // 整值写入口：下一批 import 侧替换 → 模块自身读到同一新实例
    const originalCache = sessionUi._phOpenSessionsCache;
    sessionUi.setPhOpenSessionsCache({ sig: 'import', html: '<i>y</i>' });
    assert.equal(sessionUi._phOpenSessionsCache.html, '<i>y</i>');
    sessionUi.setPhOpenSessionsCache(originalCache);
    assert.equal(sessionUi._phOpenSessionsCache, originalCache);

    // 渲染签名适配面：ESM 写 → classic sidebar-render 自己的词法状态
    adapter.lastAgentListRenderSignature = 'sig-a';
    assert.equal(adapter.lastAgentListRenderSignature, 'sig-a');
  });
});

test('待停止 runtime 抑制语义不变：退役键只经命名导出可达，桥已注销', async () => {
  await withSidebarCase({}, async ({ c, ops }) => {
    // 消费方（runtime-status）只看抑制状态；写入 / 释放的 classic 消费面已归零，
    // 两个键随即注销——不再有同名 window 桥，用例直调真实命名导出。
    for (const key of ['markPendingRuntimeStop', 'releasePendingRuntimeStop']) {
      const descriptor = Object.getOwnPropertyDescriptor(c.window, key);
      assert.equal(descriptor, undefined, `${key} 不应在 window 上留桥`);
      assert.equal(typeof ops[key], 'function', `${key} 必须仍是命名导出`);
    }
    ops.markPendingRuntimeStop('a1', 's1', 'r1');
    assert.equal(ops.isRuntimeStopPending('a1', 's1', 'r1'), true);
    // runtimeId 优先：同一 Session 的新实例不因旧实例的停止意图被隐藏
    assert.equal(ops.isRuntimeStopPending('a1', 's1', 'r2'), false);
    // 权威快照仍含该实例 → 保持抑制（不按时长猜测停止成败）
    ops.reconcilePendingRuntimeStops([{ runtime_session_id: 'r1' }]);
    assert.equal(ops.isRuntimeStopPending('a1', 's1', 'r1'), true);
    // 权威快照已不含 → 解除
    ops.reconcilePendingRuntimeStops([]);
    assert.equal(ops.isRuntimeStopPending('a1', 's1', 'r1'), false);

    // 反方向：ESM 写 → classic 读（isRuntimeStopPending 仍有 classic 消费方，
    // 桥保留，两侧读同一份模块状态）；释放走命名导出。
    ops.markPendingRuntimeStop('a2', 's2', 'r2');
    assert.equal(c.read('isRuntimeStopPending("a2", "s2", "r2")'), true);
    ops.releasePendingRuntimeStop('r2');
    assert.equal(ops.isRuntimeStopPending('a2', 's2', 'r2'), false);
  });
});

test('会话快照合并保留归属身份、追加段、尾部保护与 revision 倒退拒绝', async () => {
  await withSidebarCase({}, async ({ ops }) => {
    const merge = ops.mergeWorkspaceSessionSnapshots;

    // 归属不同 → 整体替换（不能把项目切片 patch 到目录切片上）
    const replaced = merge(
      { revision: 3, sessionProjectId: 'prj_1', sessions: [{ id: 'p1', title: 'old' }] },
      { revision: 4, sessionProjectDir: '/work/d', sessions: [{ id: 'd1' }] },
      'a1',
    );
    assert.deepEqual(replaced.sessions.map((session) => session.id), ['d1']);
    assert.equal(replaced.revision, 4);

    // fresh 无归属（全量降级载荷）→ 保留上一个有归属快照
    const kept = merge(
      { revision: 3, sessionProjectId: 'prj_1', sessions: [{ id: 'p1' }] },
      { revision: 9, sessions: [{ id: 'x' }] },
      'a1',
    );
    assert.deepEqual(kept.sessions.map((session) => session.id), ['p1']);

    // 追加段：重复 id 取 fresh 字段 patch，新条目按 id 去重后拼接
    const appended = merge(
      { revision: 2, sessions: [{ id: 's1', title: 'a' }, { id: 's2', title: 'b' }] },
      { revision: 3, sessionOffset: 2, sessionTotal: 5, sessions: [{ id: 's2', title: 'b2' }, { id: 's3', title: 'c' }] },
      'a1',
    );
    assert.deepEqual(appended.sessions.map((session) => session.id), ['s1', 's2', 's3']);
    assert.equal(appended.sessions[1].title, 'b2');

    // 首屏切片（offset=0 且带 sessionTotal）不截断已加载的深层段
    const tail = merge(
      { revision: 4, sessions: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] },
      { revision: 5, sessionOffset: 0, sessionTotal: 3, sessions: [{ id: 's1' }] },
      'a1',
    );
    assert.deepEqual(tail.sessions.map((session) => session.id), ['s1', 's2', 's3']);

    // revision 倒退 → 原样返回旧快照
    const stale = merge({ revision: 7, sessions: [{ id: 's1' }] }, { revision: 6, sessions: [] }, 'a1');
    assert.equal(stale.revision, 7);
    assert.deepEqual(stale.sessions.map((session) => session.id), ['s1']);
  });
});

test('applySessionMutationDelta 拒绝旧 revision 并应用权威增量（classic 更新链路）', async () => {
  await withSidebarCase({}, async ({ c, ops, store, renderEntry }) => {
    store.setAllAgents([{
      id: 'a1',
      workspace_sessions: {
        revision: 5,
        activeSessionId: 's1',
        sessions: [{ id: 's1', title: 'one' }, { id: 's2', title: 'two' }],
        sessionTotal: 2,
        mainTotal: 2,
        archivedTotal: 0,
      },
    }]);

    // 旧 revision：拒绝且零 UI 副作用
    const listCallsBefore = c.window.renderListCalls;
    const mainCallsBefore = c.window.renderMainCalls;
    assert.equal(ops.applySessionMutationDelta('a1', { sessionDelta: { revision: 4, remove: ['s1'] } }), false);
    assert.deepEqual(
      store.allAgents[0].workspace_sessions.sessions.map((session) => session.id),
      ['s1', 's2'],
    );
    assert.equal(c.window.renderListCalls, listCallsBefore);
    assert.equal(c.window.renderMainCalls, mainCallsBefore);

    // 新 revision：remove + upsert + 分页计数同步（classic updateAgentRecord 链路）
    assert.equal(ops.applySessionMutationDelta('a1', {
      sessionDelta: { revision: 6, remove: ['s2'], upsert: [{ id: 's3', title: 'three' }], activeSessionId: 's3' },
    }), true);
    const workspace = store.allAgents[0].workspace_sessions;
    assert.deepEqual(workspace.sessions.map((session) => session.id), ['s3', 's1']);
    assert.equal(workspace.revision, 6);
    assert.equal(workspace.activeSessionId, 's3');
    assert.equal(workspace.sessionTotal, 2);
    assert.equal(workspace.mainTotal, 2);
    assert.equal(store.allAgents[0].active_workspace_session_id, 's3');

    // 提交后失效：渲染缓存清空并触发列表 / 主视图重渲
    assert.equal(renderEntry.lastRenderedWorkspaceHtml, '');
    assert.equal(c.window.renderListCalls > listCallsBefore, true);
    assert.equal(c.window.renderMainCalls > mainCallsBefore, true);
  });
});

test('session-ui 渲染助手与排序偏好经 phSessionUi 适配面读取（含 classic 晚绑定）', async () => {
  await withSidebarCase({}, async ({ c, sessionUi: ui }) => {
    // 默认 agent 走 classic 晚绑定的 getCurrentAgentRecord
    c.window.getCurrentAgentRecord = () => ({ workspace_sessions: { sessions: [{ id: 's1' }, { id: 's2' }] } });
    assert.deepEqual(ui.getWorkspaceSessions().map((session) => session.id), ['s1', 's2']);
    assert.equal(ui.getWorkspaceSessionById(undefined, 's2').id, 's2');
    delete c.window.getCurrentAgentRecord;
    assert.deepEqual(ui.getWorkspaceSessions({ workspace_sessions: { sessions: [{ id: 'x' }] } }).map((s) => s.id), ['x']);
    assert.equal(ui.getWorkspaceSessionById({ workspace_sessions: { sessions: [] } }, 'missing'), null);

    // 徽标按实时语言渲染（语言经 i18n-environment 桥读取）
    assert.equal(ui.renderSessionArchivedBadge({ archived: true }), '<span class="workspace-history-archived">已归档</span>');
    assert.equal(ui.renderSessionArchivedBadge({ archived: false }), '');
    assert.equal(ui.renderSessionTodoBadge({ todo: true }), '<span class="workspace-history-todo">待办</span>');
    c.read('currentLanguage = "en"');
    assert.equal(ui.renderSessionArchivedBadge({ archived: true }), '<span class="workspace-history-archived">Archived</span>');
    c.read('currentLanguage = "zh"');

    // 排序偏好：默认 updatedAt；切到 createdAt 后次序变化；TODO 始终置顶
    const sessions = [
      { id: 'a', createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'b', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
    ];
    assert.deepEqual(ui.sortPhSessionsByMode(sessions).map((session) => session.id), ['b', 'a']);
    const phHost = c.window.createP2BootstrapPhSessionHost();
    phHost.phSessionSortMode = 'createdAt';
    assert.deepEqual(ui.sortPhSessionsByMode(sessions).map((session) => session.id), ['a', 'b']);
    assert.equal(ui.sortPhSessionsByMode([
      ...sessions,
      { id: 'c', todo: true, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' },
    ])[0].id, 'c');
    phHost.phSessionSortMode = 'updatedAt';

    // token bar：显式 contextLength 优先，tone 按压缩阈值分档
    const bar = ui.renderSessionTokenBar(
      { tokenUsage: { lastRequestUsage: { inputTokens: 50000 } } },
      { workspace_sessions: { contextLength: 200000, compressRatio: 80 } },
    );
    assert.match(bar, /session-token-inline tone-low/);
    assert.match(bar, /25%/);
    assert.equal(ui.renderSessionTokenBar({}, {}), '');
  });
});

test('会话替换 mutation：乐观归档、操作取代与回滚恢复原标记', async () => {
  await withSidebarCase({}, async ({ c, mutation, ops, store, renderEntry }) => {
    store.setAllAgents([{
      id: 'a1',
      workspace_sessions: {
        activeSessionId: 's1',
        sessions: [{ id: 's1', title: 'one', archived: false, todo: true }, { id: 's2', title: 'two' }],
      },
    }]);

    const mainCallsBefore = c.window.renderMainCalls;
    const rollback = mutation.markSessionArchivedForMutation('a1', 's1');
    const sessions = store.allAgents[0].workspace_sessions.sessions;
    assert.equal(sessions[0].archived, true);
    assert.equal(sessions[0].todo, false);
    assert.equal(sessions[1].archived, undefined);
    assert.equal(renderEntry.lastRenderedWorkspaceHtml, '');
    assert.equal(c.window.renderMainCalls, mainCallsBefore + 1);

    const operation = mutation.getSessionReplacementMutation('a1', 's1');
    assert.equal(operation.kind, 'summary');
    assert.equal(operation.operationId, rollback.operationId);
    assert.equal(operation.phase, 'generating');

    // 同一源会话再次 begin → 旧操作被 superseded，只留一条 replacement 记录
    mutation.beginSessionReplacementMutation('a1', 's1', 'branch');
    const replacements = ops.listSidebarOperations((item) => (
      item.type === 'replacement' && item.agentId === 'a1'
    ));
    assert.equal(replacements.length, 1);
    assert.equal(replacements[0].kind, 'branch');

    // 回滚恢复原始 archived/todo 标记并结束操作
    rollback();
    const reverted = store.allAgents[0].workspace_sessions.sessions[0];
    assert.equal(reverted.archived, false);
    assert.equal(reverted.todo, true);
    assert.equal(mutation.getSessionReplacementMutation('a1', 's1'), null);
  });
});

test('navigateToSessionMutationTarget 在运行时身份或导航代次变化后放弃切换', async () => {
  await withSidebarCase({}, async ({ c, mutation, orchestration }) => {
    orchestration.setCurrentRuntimeAgentId('r1');
    orchestration.setNavigationGuardEpoch(10);
    c.window.waitForTargetRuntimeSession = () => { throw new Error('等待助手不应被调用'); };
    // 源运行时已不是当前视图 → 立即放弃
    assert.equal(await mutation.navigateToSessionMutationTarget('a1', { targetSessionId: 's2' }, 'r-other'), false);

    // 等待期间导航代次推进（用户切走）→ 晚到目标被拒绝
    let waited = 0;
    c.window.waitForTargetRuntimeSession = async () => {
      waited += 1;
      orchestration.setNavigationGuardEpoch(orchestration._navigationGuardEpoch + 1);
      return { id: 'rt', runtime_session_id: 'rt' };
    };
    assert.equal(await mutation.navigateToSessionMutationTarget('a1', { targetSessionId: 's2' }, 'r1'), false);
    assert.equal(waited, 1);

    // 无目标会话 id → 不进入等待
    assert.equal(await mutation.navigateToSessionMutationTarget('a1', {}, 'r1'), false);
  });
});

test('外部 runtime 关闭通道解析与本地化错误文案', async () => {
  const requests = [];
  const fetchStub = async (url, init = {}) => {
    requests.push({
      url: String(url),
      method: init.method || 'GET',
      body: init.body ? JSON.parse(init.body) : null,
    });
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
  };
  await withSidebarCase({ globals: { fetch: fetchStub } }, async ({ external, store }) => {
    store.setAllAgents([{
      id: 'x1',
      source: 'external',
      name: 'demo',
      parent_id: 'flow-workspace',
      active_workspace_session_form_id: 'assembly-form',
      active_workspace_session_id: 'sess-1',
    }]);
    assert.equal(external.getExternalRuntimeAgent('x1').id, 'x1');
    assert.equal(external.getExternalRuntimeAgent('missing'), null);
    assert.equal(external.isAssemblyExternalRuntime(store.allAgents[0]), true);
    assert.equal(external.isAssemblyExternalRuntime({ source: 'external' }), false);

    // 显式 assembly 目标：直接停该会话的宿主 runtime
    await external.closeSidebarExternalRuntime(store.allAgents[0]);
    assert.equal(requests[0].url, '/protoclaw/assembly_runtime/stop');
    assert.equal(requests[0].method, 'POST');
    assert.deepEqual(requests[0].body, { sessionId: 'sess-1' });

    // 平台注册的外部 runtime（ADR-0037）：经 server 下发停止指令
    requests.length = 0;
    await external.closeSidebarExternalRuntime({
      source: 'external', id: 'x2', external_registered: true, runtime_session_id: 'rt2',
    });
    assert.equal(requests[0].url, '/protoclaw/external_runtime/stop');
    assert.deepEqual(requests[0].body, { runtimeId: 'rt2' });

    // 无可用通道：本地化错误，且不发出请求
    requests.length = 0;
    await assert.rejects(
      () => external.closeSidebarExternalRuntime({ source: 'external', id: 'x3' }),
      /还没有可用的关闭通道/,
    );
    assert.equal(requests.length, 0);
    await assert.rejects(
      () => external.restartSidebarExternalRuntime({ source: 'external', id: 'x4' }),
      /还没有可用的重启通道/,
    );
  });
});

test('桥面穷举：注册全集与声明清单等值，私有 helper 不造桥', async () => {
  await withSidebarCase({ record: true }, async ({ c, ops, sessionUi, mutation, pin, recorded }) => {
    // 本批桥面声明清单（穷举）。多注册 / 少注册 / 重复注册都会让本用例变红——
    // 抽样断言漏掉的正是"多注册一个无消费键"这种形态。
    const expectedByDomain = {
      // 操作生命周期 / 增量应用 API 的消费方已改具名 import，8 个键随即注销
      // （逐键归零证据见下方第 4 组「已注销桥」清单）。
      'sidebar-operations': [
        'beginSidebarOperationMainThreadObservation',
        'captureSidebarSnapshotToken', 'createSidebarOperationId', 'findSidebarOperation',
        'getSidebarOperationVersion',
        'isRuntimeStopPending', 'isSidebarSnapshotTokenCurrent',
        'listSidebarOperations', 'mergeWorkspaceSessionSnapshots',
        'queueSidebarDiagnosticEvent', 'reconcilePendingRuntimeStops',
        'recordSidebarOperationCheckpoint', 'sidebarDiagnosticNow',
      ],
      // 右键菜单两处入口（ctx-menu-handlers / ctx-menu-items）已改直接 import，
      // 三个键随即注销；只剩 classic thread-store 仍消费的刷新入口。
      'external-runtime': [
        'refreshSidebarRuntimeAfterMutation',
      ],
      // 消费方（ESM session-list-render / trim-page / session-dialogs / ctx-menu-items /
      // workspace-actions / fw-config-panel / assembly-actions）已改直引的 10 键已注销，
      // 只剩仍有 classic 裸全局消费面的 1 键。
      'session-ui': [
        'getWorkspaceSessions',
      ],
      'sidebar-pin-color': ['SIDEBAR_TODO_COLORS', 'onSidebarPinPointerDown'],
      // 会话替换状态机的三个入口同样只经具名导出可达：仅 classic runtime-status
      // 仍裸读 getSessionReplacementMutation。
      'session-mutation': [
        'getSessionReplacementMutation',
      ],
    };
    const domains = Object.keys(expectedByDomain);
    const expectedAll = domains.flatMap((domain) => expectedByDomain[domain].map((key) => `${domain}:${key}`));

    // 1) 注册全集等值（本批域名过滤；依赖模块的注册不在其中）
    const recordedKeys = recorded.keys.filter((entry) => domains.includes(entry.split(':')[0]));
    assert.deepEqual([...recordedKeys].sort(), [...expectedAll].sort());
    assert.equal(recordedKeys.length, new Set(recordedKeys).size, '同一桥键不得注册两次');
    // 2) 认领：每域恰好一次
    const claims = recorded.claims.filter((domain) => domains.includes(domain));
    assert.deepEqual([...claims].sort(), [...domains].sort());
    // 3) 每个注册键都是成对 get/set、非枚举的访问器（与顶层 let 语义一致）
    for (const entry of expectedAll) {
      const key = entry.slice(entry.indexOf(':') + 1);
      const descriptor = Object.getOwnPropertyDescriptor(c.window, key);
      assert.equal(typeof descriptor?.get, 'function', `${key} 应有桥 getter`);
      assert.equal(typeof descriptor?.set, 'function', `${key} 应成对提供 setter`);
      assert.equal(descriptor?.enumerable, false, `${key} 不应进入枚举`);
    }

    // 4) 零消费 / 模块私有 helper 一律不造桥
    const privateHelpers = [
      'applyTodoColor', 'openTodoColorPicker', 'closeTodoColorPicker', 'getPicker',
      'normalizeSidebarOperation', 'pendingRuntimeStopKey',
      'markPendingSessionUpsert', 'retainPendingSessionUpserts', 'flushSidebarDiagnosticEvents',
      '_pendingRuntimeStops', '_pendingSessionUpserts', '_sidebarDiagnosticEventQueue',
      '_modelInfoCache', 'PH_OPEN_SESSIONS_CARD_DISABLED', 'newIdempotencyKey',
      'archiveSessionAfterMutation', 'beginSessionReplacementMutation',
      'closeExternalRuntime', 'resolveSidebarAssemblyRuntimeTarget',
      // 已注销的桥（消费方改直引后即时撤除，只保留命名导出）
      'closeSidebarExternalRuntime',           // ← ESM ctx-menu-handlers / ctx-menu-items
      'restartSidebarExternalRuntime',         // ← 同上
      'getExternalRuntimeAgent',               // ← 同上
      'waitForSidebarTargetRuntime',           // ← ESM session-dialogs
      'invalidateSidebarProjection',           // ← ESM ctx-menu-items
      'handleSessionTitleDoubleClick',         // ← ESM session-list-render
      'sortPhSessionsByMode',                  // ← ESM session-list-render
      'renderSessionResumeBadge',
      'renderSessionArchivedBadge',
      'renderSessionTodoBadge',
      'renderSessionTitleAiButton',
      'renderSessionTokenBar',
      'phLoadOpenSessionsCard',
      '_phOpenSessionsCache',
    ];
    // classic 相装载的是真实 boot 文件（app-ui / app-main），它们自有的顶层函数
    // （newIdempotencyKey / renderSession*Badge / phLoadOpenSessionsCard）本来就
    // 挂在 window 上，与桥债无关；本项断言的是这些名字都**不是** KernelState
    // 桥键（成对 get/set 访问器），即本批 ESM 模块没有为此造桥。
    for (const key of privateHelpers) {
      const descriptor = Object.getOwnPropertyDescriptor(c.window, key);
      assert.notEqual(typeof descriptor?.get, 'function', `${key} 不应成为 KernelState 桥键`);
      assert.notEqual(typeof descriptor?.set, 'function', `${key} 不应成为 KernelState 桥键`);
    }

    // 4b) 已注销桥（消费方全部改具名 import 后即时撤除）：逐键证明 window 上
    //     既无访问器也无同名数据属性，且命名导出仍在——不恢复退役桥。
    for (const key of [
      'applySessionMutationDelta', 'applySidebarMutationDeltaWithDiagnostics',
      'beginSidebarOperation', 'finishSidebarOperation', 'getSidebarOperation',
      'markPendingRuntimeStop', 'releasePendingRuntimeStop', 'updateSidebarOperation',
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(c.window, key);
      assert.equal(descriptor, undefined, `${key} 的桥已注销，不得留在 window 上`);
      assert.equal(c.read(`typeof ${key}`), 'undefined', `${key} 不应可被 classic 裸标识符解析`);
      assert.equal(typeof ops[key], 'function', `${key} 必须仍是命名导出`);
    }

    // 4c) 会话域撤桥（消费方全部改具名 import 后即时撤除）：classic 侧零消费面的
    //     四个入口不再留桥，命名导出仍是唯一可达面。
    for (const [key, owner] of [
      ['markSessionArchivedForMutation', mutation],
      ['navigateToSessionMutationTarget', mutation],
      ['reconcileArchivedSourceRuntime', mutation],
      ['getWorkspaceSessionById', sessionUi],
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(c.window, key);
      assert.equal(descriptor, undefined, `${key} 的桥已注销，不得留在 window 上`);
      assert.equal(c.read(`typeof ${key}`), 'undefined', `${key} 不应可被 classic 裸标识符解析`);
      assert.equal(typeof owner[key], 'function', `${key} 必须仍是命名导出`);
    }

    // 5) 桥键与命名导出同源（身份锚点；全集由上面的注册清单覆盖）
    assert.equal(c.read('getWorkspaceSessions'), sessionUi.getWorkspaceSessions);
    assert.equal(c.read('onSidebarPinPointerDown'), pin.onSidebarPinPointerDown);
    assert.equal(c.read('SIDEBAR_TODO_COLORS'), pin.SIDEBAR_TODO_COLORS);
  });
});
