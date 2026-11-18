/**
 * P2 批次 W2-7（菜单与会话列表）交付钉子。
 *
 * 钉什么：
 *   1. 批次 ESM 入口（p2-w2-7-menu-session-bootstrap.js）真实装载后，
 *      classic 消费方经 kernel-state 访问器桥取到同一实现，私有 helper 不上桥；
 *   2. 真实菜单条目与声明驱动：sessionOps 事实、APP 声明项（ADR-0049）、
 *      线程语义项、工作空间呈现策略族（ADR-0050）与语言切换；
 *   3. 动作分发的身份参数：summary / delete / move 的 agentId · sessionId
 *      寻址，以及声明能力过期（策略消失）后的拒绝——无请求、无副作用；
 *   4. 会话列表渲染：TODO 置顶与 updatedAt / createdAt 排序、线程分区、
 *      标题转义、条目操作身份（远程会话用宿主命名空间 id）；
 *   5. 桥语义：classic 裸标识符读写落到 ESM owner（线程优先归档谓词）。
 *
 * 装载路线（配方第三节）：真实 import 整图（withP2EsmCase 的 case 级图隔离），
 * classic 侧按真实加载序执行 action-dispatcher / i18n / app-core，其余 classic
 * owner（app-main / app-ui / sidebar-render / agent-data-loader）的 host 工厂与
 * 渲染函数用最小替身注入——本批只消费其调用契约，不重写其实现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const BOOTSTRAP = 'public/src/modules/p2-w2-7-menu-session-bootstrap.js';

const MENU_SPY_KEYS = ['runWorkspaceAction', 'phOpenSessionMoveDialog', 'closeCtxMenu', 'renderAgentList'];

function makePhAgent(overrides = {}) {
  return {
    id: 'programming-helper',
    name: 'PH',
    source: 'prebuilt',
    sessionOps: true,
    sidebarSessions: 'visible',
    ui: {
      sessionMenu: {
        items: [
          { id: 'ph.move', label: { zh: '移动到…', en: 'Move to…' }, action: 'claw:move-session' },
          { id: 'ph.gate', label: { zh: '仅未归档', en: 'Only active' }, action: 'claw:noop', when: ['not-archived'] },
        ],
      },
    },
    workspace_sessions: {
      activeSessionId: 'sess-active',
      sessions: [
        { id: 'sess-active', title: 'active', archived: false, todo: false, createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-17T03:00:00Z' },
        { id: 'sess-archived', title: 'archived', archived: true, todo: false, createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-16T03:00:00Z' },
        { id: 'sess-todo', title: 'todo <b>x</b>', archived: false, todo: true, createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-15T03:00:00Z' },
      ],
    },
    ...overrides,
  };
}

/** 渲染效果出口：数据流与宿主工厂保持真实，只记录生产渲染入口的调用点。 */
function installRenderOutlets(sandbox) {
  sandbox.renderAgentList = () => {};
  sandbox.renderCurrentMainView = () => {};
}

function createFetchStub() {
  const calls = [];
  const stub = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
  };
  stub.calls = calls;
  return stub;
}

function caseOptions(extraClassic) {
  const fetchStub = createFetchStub();
  return {
    fetchStub,
    options: {
      classic: (sandbox) => {
        // 真实先行脚本序（顺序同 index.html）：宿主工厂、桥注册与分发器都是
        // 生产实现；boot 体挂在永不 resolve 的 __clawAuthReady 之后，主题 /
        // 语言应用与周期排程一并中和（用例不驱动首屏 DOM）。
        prepareClassicSandbox(sandbox);
        installRenderOutlets(sandbox);
        if (typeof extraClassic === 'function') extraClassic(sandbox);
      },
      globals: { fetch: fetchStub },
    },
  };
}

/** 装载整图并取回本批模块的命名导出（同一 case 内同一实例）。 */
async function loadBatch(c) {
  // 刷新引擎（P4 T3 起是真实 ESM）：交互域在**装载期**取它的窄宿主
  // createThreadStoreHost，必须先于 thread-store-domain 进同一张图。
  await c.load('public/src/modules/thread-store.js');
  // 远程连接域已迁 ESM（P4 T3）：真实 import 代替原 classic 标签位
  // （ctx-menu-items / session-menu-decls / sidebar-render 的远程半边都读它）。
  await c.load('public/src/modules/remote-connections.js');
  await c.load(BOOTSTRAP);
  return {
    items: await c.load('public/src/modules/ctx-menu-items.js'),
    decls: await c.load('public/src/modules/session-menu-decls.js'),
    list: await c.load('public/src/modules/session-list-render.js'),
    store: await c.load('public/src/modules/agent-store-state.js'),
    orch: await c.load('public/src/modules/orchestration-state.js'),
    phSession: await c.load('public/src/modules/p2-bootstrap-ph-session.js'),
  };
}

const nonSeparator = (items) => items.filter((item) => item && item.type !== 'separator');
const labels = (items) => nonSeparator(items).map((item) => item.label);
const actions = (items) => nonSeparator(items).map((item) => item.action);

test('桥键与命名导出同源、私有 helper 不上桥；菜单条目、声明项、策略族与语言', async () => {
  const boot = caseOptions();
  await withP2EsmCase(boot.options, async (c) => {
    const mod = await loadBatch(c);

    // 1) 桥访问器：get/set 成对、不可枚举（与顶层 let 一致），且与命名导出同源
    //    （sessionOpsAllowed ← slash-commands、renderPhSessionItemHtml ← ph-session-list、
    //    ctxTodoSession ← sidebar-pin-color / ctxArchiveSession ← workspace-actions 均已改
    //    直接 import，桥已注销 → 见下方第 2 组）
    for (const key of [
      'getCtxMenuItems', 'dispatchCtxAction',
      'renderWorkspaceSessionList',
      'onPhSessionDragStart',
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(c.window, key);
      assert.equal(typeof descriptor?.get, 'function', `${key} 应是桥访问器`);
      assert.equal(typeof descriptor?.set, 'function', `${key} 应成对提供 setter`);
      assert.equal(descriptor.enumerable, false, `${key} 不应进入 for-in`);
    }
    assert.equal(c.read('getCtxMenuItems'), mod.items.getCtxMenuItems);
    assert.equal(c.read('dispatchCtxAction'), mod.items.dispatchCtxAction);
    assert.equal(c.read('typeof sessionOpsAllowed'), 'undefined');
    assert.equal(c.read('typeof ctxTodoSession'), 'undefined');
    assert.equal(c.read('typeof renderPhSessionItemHtml'), 'undefined');
    assert.equal(c.read('renderWorkspaceSessionList'), mod.list.renderWorkspaceSessionList);
    // ctxArchiveSession 的桥已注销：唯一消费方 workspace-actions 已验收为 ESM 并
    // 直接 import，归档入口只经命名导出可达（不恢复同名 window 桥）
    assert.equal(typeof mod.items.ctxArchiveSession, 'function');
    assert.equal(c.read('typeof ctxArchiveSession'), 'undefined');
    // phConversationArchived 的桥已注销：唯一消费方 workspace-actions 已验收为
    // ESM 并直接 import（P2 项目/装配批跟随），命名导出仍在
    assert.equal(typeof mod.list.phConversationArchived, 'function');
    assert.equal(c.read('typeof phConversationArchived'), 'undefined');

    // 导航代次为 live binding：classic bumpNavigationGuard 的写入落到 ESM owner，
    // ctx-menu 的「过期即放弃切换」读的正是这个绑定（见 ctxRestartAgent 的 _navGuard 比对）。
    const epochBefore = mod.orch._navigationGuardEpoch;
    c.read('bumpNavigationGuard()');
    assert.equal(mod.orch._navigationGuardEpoch, epochBefore + 1);

    // 2) 私有 helper / 零消费面导出不造桥
    // classic 相装载的是真实 boot 文件（app-ui / app-main）：它们自有的顶层函数
    // （newIdempotencyKey）本来就挂在 window 上，与桥债无关——对它的断言是
    // 「不是 KernelState 桥键」（无成对 get/set 访问器），其余名字则必须完全
    // 不出现在 window 上。
    const classicOwnedNames = new Set(['newIdempotencyKey']);
    for (const key of [
      'sessionOpsAllowed', 'renderPhSessionItemHtml', 'ctxTodoSession',
      // 归档会话入口：唯一消费方 workspace-actions 已改具名 import（桥注销）
      'ctxArchiveSession',
      'newIdempotencyKey', '_copyTextWithToast', 'ctxThreadRequest', 'afterThreadMutation',
      'resolveSidebarSessionsPolicy', 'getDeclaredSessionMenuItems',
      'viewCapabilityEnabled', 'projectViewIdentity', 'renderPhSessionsEmptyCard',
      '_renderProgrammingHelperSessionList', '_PH_EMPTY_CHAT_ICON',
      'phThreadArchiveCount', 'renderSessionThreadBadge', 'phPartitionSessions',
      'phIsThreadArchivedMember', '_sessionMenuAgentRecord', '_resolveSessionMenuLabel',
    ]) {
      if (classicOwnedNames.has(key)) {
        const descriptor = Object.getOwnPropertyDescriptor(c.window, key);
        assert.notEqual(typeof descriptor?.get, 'function', `${key} 不应成为 KernelState 桥键`);
        assert.notEqual(typeof descriptor?.set, 'function', `${key} 不应成为 KernelState 桥键`);
        continue;
      }
      assert.equal(Object.prototype.hasOwnProperty.call(c.window, key), false, `${key} 不应出现在 window 上`);
    }

    // 3) sessionOps 事实：本地读声明，远程走能力位门控；远程叶子无自定义项
    mod.store.setAllAgents([makePhAgent(), { id: 'memo', sessionOps: false }]);
    assert.equal(mod.decls.sessionOpsAllowed('programming-helper'), true);
    assert.equal(mod.decls.sessionOpsAllowed('memo'), false);
    c.window.isRemoteNamespaceAgentId = (ns) => ns.startsWith('remote:');
    c.window.RemoteConnections = { capabilityFor: (_ns, capability) => capability === 'sessionOps' };
    assert.equal(mod.decls.sessionOpsAllowed('remote:lab-b:programming-helper'), true);
    c.window.RemoteConnections = { capabilityFor: () => false };
    assert.equal(mod.decls.sessionOpsAllowed('remote:lab-b:programming-helper'), false);
    assert.deepEqual(mod.decls.getDeclaredSessionMenuItems('remote:lab-b:programming-helper', {}), []);
    delete c.window.isRemoteNamespaceAgentId;
    delete c.window.RemoteConnections;

    // 4) runtime 角色（会话操作族）：内建族 + 线程语义 + APP 声明项
    const runtimeItems = nonSeparator(mod.items.getCtxMenuItems('runtime', 'programming-helper', 'child', 'rt-1', 'sess-active'));
    assert.deepEqual(labels(runtimeItems), [
      '重命名', '设为待办', '复制 ID', '会话接续',
      '归档', '重启 Agent', '关闭 Agent', '删除对话',
      '移动到…', '仅未归档',
    ]);
    const rename = runtimeItems[0];
    assert.deepEqual(rename.submenu, [{ label: 'AI 生成标题', action: 'generate-title' }]);
    assert.deepEqual(actions(runtimeItems[3].submenu), ['summary', 'trim', 'branch']);
    assert.equal(runtimeItems[4].action, 'archive-and-stop');
    assert.equal(runtimeItems[7].danger, true);
    assert.equal(runtimeItems[8].action, 'claw:move-session');

    // 已归档会话：无 TODO 项，归档项变「取消归档」
    const archivedItems = nonSeparator(mod.items.getCtxMenuItems('runtime', 'programming-helper', 'child', 'rt-2', 'sess-archived'));
    assert.equal(labels(archivedItems).includes('设为待办'), false);
    assert.equal(archivedItems.find((item) => item.action === 'archive-and-stop').label, '取消归档');
    // 谓词过滤：not-archived 的声明项在归档行隐藏
    assert.equal(labels(archivedItems).includes('仅未归档'), false);

    // 线程语义：执行中线程出「停止」，归档走线程端点，历史入口按代数计数
    c.window.getThreadById = (threadId) => (threadId === 'wt-1'
      ? { threadId: 'wt-1', headSessionId: 'sess-active', lifeState: 'executing', sessionIds: ['sess-active', 'sess-old'] }
      : null);
    c.window.getThreadForSession = (ns, sessionId) => (ns === 'programming-helper' && sessionId === 'sess-active'
      ? { threadId: 'wt-1', headSessionId: 'sess-active', lifeState: 'executing', sessionIds: ['sess-active', 'sess-old'] }
      : null);
    const threadItems = nonSeparator(mod.items.getCtxMenuItems('runtime', 'programming-helper', 'child', 'rt-1', 'sess-active', 'wt-1'));
    assert.deepEqual(labels(threadItems).slice(0, 6), ['重命名', '设为待办', '复制 ID', '会话接续', '查看历史 (1)', '归档']);
    assert.equal(threadItems.find((item) => item.action === 'thread-archive').action, 'thread-archive');
    assert.equal(labels(threadItems).includes('停止'), true);
    delete c.window.getThreadById;
    delete c.window.getThreadForSession;

    // 5) 工作空间条目族（ADR-0050）：sidebarSessions 声明即能力，wire 合流值
    //    优先；设置直达族（编程小助手域三个 phTab 落点）在前，未声明呈现
    //    策略时独立成菜单
    assert.deepEqual(mod.items.getCtxMenuItems('workspace', 'programming-helper', 'prebuilt', 'programming-helper'), [
      { label: '模型设置', action: 'claw:open-settings:model' },
      { label: '插件及配置', action: 'claw:open-settings:feature' },
      { label: 'Coder设置', action: 'claw:open-settings:coder' },
      { type: 'separator' },
      { label: '隐藏对话条目', action: 'claw:toggle-sidebar-sessions' },
    ]);
    mod.store.setAllAgents([makePhAgent({ sidebarSessionsPolicy: 'hidden' })]);
    assert.deepEqual(labels(mod.items.getCtxMenuItems('workspace', 'programming-helper', 'prebuilt', 'programming-helper')),
      ['模型设置', '插件及配置', 'Coder设置', '显示对话条目']);
    mod.store.setAllAgents([makePhAgent({ sidebarSessions: undefined })]);
    assert.deepEqual(mod.items.getCtxMenuItems('workspace', 'programming-helper', 'prebuilt', 'programming-helper'), [
      { label: '模型设置', action: 'claw:open-settings:model' },
      { label: '插件及配置', action: 'claw:open-settings:feature' },
      { label: 'Coder设置', action: 'claw:open-settings:coder' },
    ]);

    // 6) 语言切换经 live 语言 owner（i18n-environment 桥）即时生效
    mod.store.setAllAgents([makePhAgent()]);
    c.read('currentLanguage = "en"');
    const enItems = nonSeparator(mod.items.getCtxMenuItems('runtime', 'programming-helper', 'child', 'rt-1', 'sess-active'));
    assert.equal(enItems[0].label, 'Rename');
    assert.equal(labels(mod.items.getCtxMenuItems('workspace', 'programming-helper', 'prebuilt', 'programming-helper'))[0], 'Model Settings');
    c.read('currentLanguage = "zh"');
  });
});

test('动作分发身份参数（agentId · sessionId）与声明能力过期拒绝', async () => {
  const boot = caseOptions();
  await withP2EsmCase(boot.options, async (c) => {
    const mod = await loadBatch(c);
    mod.store.setAllAgents([makePhAgent()]);

    const calls = [];
    for (const key of MENU_SPY_KEYS) {
      c.window[key] = (...args) => calls.push({ fn: key, args });
    }

    // summary：runWorkspaceAction 收到 JSON 串（agentId + sessionId 寻址）
    mod.items.dispatchCtxAction('summary', { ns: 'programming-helper', id: 'rt-1', sessionId: 'sess-active' });
    const summaryAction = JSON.parse(calls.at(-1).args[0]);
    assert.deepEqual(summaryAction, {
      type: 'compact_session_menu', agentId: 'programming-helper', sessionId: 'sess-active', compactType: 'summary',
    });

    // delete-session-runtime：runtime 角色的 id 是 runtimeId，必须用 sessionId 删除
    mod.items.dispatchCtxAction('delete-session-runtime', { ns: 'programming-helper', id: 'rt-1', sessionId: 'sess-2' });
    assert.deepEqual(JSON.parse(calls.at(-1).args[0]), { type: 'delete_session', sessionId: 'sess-2' });
    // session 角色无 sessionId 时回落到 id
    mod.items.dispatchCtxAction('delete-session', { ns: 'programming-helper', id: 'sess-3' });
    assert.deepEqual(JSON.parse(calls.at(-1).args[0]), { type: 'delete_session', sessionId: 'sess-3' });

    // APP 声明项（claw: 前缀剥离）→ 单条移动入口拿到被右键的会话 id：
    // 对话框入口是直接 import 的真实实现，用它的权威归属查询（wire 记录）
    // 观察到 id 透传，并确认归属不可解析时显式失败（不猜测）。
    const alerts = [];
    c.window.alert = (message) => alerts.push(String(message));
    c.window.isPhStyleWorkspaceAgent = () => true;
    c.window.getCurrentAgentRecord = () => makePhAgent();
    const beforeMove = boot.fetchStub.calls.length;
    mod.items.dispatchCtxAction('claw:move-session', { ns: 'programming-helper', id: 'rt-9', sessionId: 'sess-9' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const moveLookups = boot.fetchStub.calls.slice(beforeMove).map((call) => String(call.url || call));
    assert.ok(moveLookups.some((url) => url.includes('sessionId=sess-9')),
      `移动入口应携带被右键的会话 id 做归属解析：${moveLookups.join(', ')}`);
    assert.equal(alerts.filter((m) => m.includes('无法确定')).length, 1, '归属不可解析时显式失败一次');

    // 声明能力过期（呈现策略字段消失）：呈现策略族从菜单消失（设置直达族
    // 仍在），toggle 动作不发请求、无副作用
    mod.store.setAllAgents([makePhAgent({ sidebarSessions: undefined })]);
    assert.deepEqual(mod.items.getCtxMenuItems('workspace', 'programming-helper', 'prebuilt', 'programming-helper'), [
      { label: '模型设置', action: 'claw:open-settings:model' },
      { label: '插件及配置', action: 'claw:open-settings:feature' },
      { label: 'Coder设置', action: 'claw:open-settings:coder' },
    ]);
    const requestsBefore = boot.fetchStub.calls.length;
    const callsBefore = calls.length;
    mod.items.dispatchCtxAction('toggle-sidebar-sessions', { ns: 'programming-helper', id: 'programming-helper' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(boot.fetchStub.calls.length, requestsBefore, '策略消失后不应发出切换请求');
    // 只允许关闭菜单这一次 UI 收尾；不得触发工作空间动作 / 移动 / 侧栏重渲
    const newCalls = calls.slice(callsBefore).map((call) => call.fn);
    assert.deepEqual(newCalls, ['closeCtxMenu']);
  });
});

test('会话列表：TODO 置顶与排序模式、线程分区、转义与条目操作身份', async () => {
  const boot = caseOptions();
  await withP2EsmCase(boot.options, async (c) => {
    const mod = await loadBatch(c);
    const agent = makePhAgent();
    // 归属事实落在会话记录上（真实切片按 openDirectory 归桶）
    agent.workspace_sessions.sessions = agent.workspace_sessions.sessions
      .map((session) => ({ ...session, openDirectory: '/work/demo' }));
    agent.workspace_sessions.sessions.push(
      { id: 'sess-remote', title: 'remote', archived: false, createdAt: '2026-11-12T00:00:00Z', updatedAt: '2026-11-14T03:00:00Z', remoteHostNsId: 'remote:lab-b:programming-helper', openDirectory: '/work/demo' },
      { id: 'sess-member', title: 'member', archived: true, createdAt: '2026-11-08T00:00:00Z', updatedAt: '2026-11-13T03:00:00Z', openDirectory: '/work/demo' },
    );
    mod.store.setAllAgents([agent]);

    // classic owner 的视图查询（本批以 window 晚绑定消费）：目录目标视图
    const project = {
      id: 'dir:/work/demo',
      type: 'dir',
      openDirectory: '/work/demo',
      updatedAt: '2026-11-17T03:00:00Z',
      conversationCount: agent.workspace_sessions.sessions.length,
      sessions: agent.workspace_sessions.sessions,
    };
    // 项目/目录视图经真实 project-data 状态驱动（不再 stub window 桥键）：
    // workspace_state 给目录事实，项目实体缓存为空 → 目录桶模式。
    agent.workspace_state = {
      openDirectory: '/work/demo',
      phProjects: [{ openDirectory: '/work/demo', updatedAt: '2026-11-17T03:00:00Z' }],
      forms: {},
      updatedAt: null,
    };
    // classic 身份判定（生产由 app-core 提供）：PH 样式工作空间
    c.window.isPhStyleWorkspaceAgent = () => true;
    c.window.ClawFW.phProjectEntities.projects = [];
    c.window.ClawFW.phProjectEntities.loaded = true;
    mod.store.setAllAgents([agent]);
    // 线程事实：sess-active 是线程 head（1 份历史代），sess-member 是历史代成员
    c.window.getThreadForSession = (_ns, sessionId) => {
      if (sessionId === 'sess-active') {
        return { threadId: 'wt-1', headSessionId: 'sess-active', lifeState: 'active', sessionIds: ['sess-active', 'sess-member'] };
      }
      if (sessionId === 'sess-member') {
        return { threadId: 'wt-1', headSessionId: 'sess-active', lifeState: 'active', sessionIds: ['sess-active', 'sess-member'] };
      }
      return null;
    };

    const html = mod.list.renderWorkspaceSessionList(agent, { title: '记录' });
    assert.match(html, /ph-session-tabs/);
    // 标题转义（TODO 会话标题含 HTML）
    assert.match(html, /todo &lt;b&gt;x&lt;\/b&gt;/);
    assert.doesNotMatch(html, /todo <b>x<\/b>/);

    const mainPanel = html.split('data-ph-panel="main"')[1].split('data-ph-panel="archived"')[0];
    const archivedPanel = html.split('data-ph-panel="archived"')[1].split('data-ph-panel="topics"')[0];
    const idsIn = (panel) => [...panel.matchAll(/data-ctx-id="([^"]+)"/g)].map((match) => match[1]);
    // TODO 置顶，其余按 updatedAt 倒序；历史代成员不进入任何分区
    assert.deepEqual(idsIn(mainPanel), ['sess-todo', 'sess-active', 'sess-remote']);
    assert.deepEqual(idsIn(archivedPanel), ['sess-archived']);
    // 线程 head 行渲染「历史 · 1」入口（archiveCount = sessionIds - 1）
    assert.match(mainPanel, /历史 · 1/);
    // 远程会话条目：操作身份用宿主命名空间 id，且不可拖拽（引用寻址不到远程数据）
    const remoteTag = mainPanel.match(/<div class="feature-project-session-item[^>]*data-ctx-id="sess-remote"[^>]*>/)?.[0] || '';
    assert.match(remoteTag, /data-ctx-ns="remote:lab-b:programming-helper"/);
    assert.equal(remoteTag.includes('draggable="true"'), false);
    const localTag = mainPanel.match(/<div class="feature-project-session-item[^>]*data-ctx-id="sess-active"[^>]*>/)?.[0] || '';
    assert.match(localTag, /draggable="true"/);

    // 排序模式切到 createdAt：TODO 仍置顶，其余按创建时间倒序
    mod.phSession.phSessionUi.phSessionSortMode = 'createdAt';
    const createdAtHtml = mod.list.renderWorkspaceSessionList(agent, { title: '记录' });
    const createdAtMain = createdAtHtml.split('data-ph-panel="main"')[1].split('data-ph-panel="archived"')[0];
    assert.deepEqual(idsIn(createdAtMain), ['sess-todo', 'sess-remote', 'sess-active']);
    mod.phSession.phSessionUi.phSessionSortMode = 'updatedAt';

    // 归档口径（命名导出调用；桥已注销）：有线程时线程 lifeState 是归档权威值
    assert.equal(mod.list.phConversationArchived('programming-helper', { id: 'sess-archived', archived: true }), true);
    c.window.getThreadForSession = (_ns, sessionId) => (sessionId === 'sess-active'
      ? { threadId: 'wt-1', headSessionId: 'sess-active', lifeState: 'archived', sessionIds: ['sess-active'] }
      : null);
    assert.equal(mod.list.phConversationArchived('programming-helper', { id: 'sess-active', archived: false }), true);
    c.window.getThreadForSession = (_ns, sessionId) => (sessionId === 'sess-active'
      ? { threadId: 'wt-1', headSessionId: 'sess-active', lifeState: 'active', sessionIds: ['sess-active'] }
      : null);
    assert.equal(mod.list.phConversationArchived('programming-helper', { id: 'sess-active', archived: true }), false);
    c.window.__phAgent = agent;
    assert.match(c.read('renderWorkspaceSessionList(__phAgent, { title: "记录" })'), /ph-session-tabs/);
    assert.equal(typeof c.read('onPhSessionDragStart'), 'function');
    delete c.window.__phAgent;
  });
});
