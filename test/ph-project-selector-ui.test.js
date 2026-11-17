/**
 * Ticket 045+ — PH 顶部双选择器与对话 UI（真实前端源码驱动）。
 *
 * 覆盖：
 *  - 纯目录无回归（左目录选择器 + 右归属默认项 / 新对话 openDirectory / 无 projectId）
 *  - 同目录 D/A/B：左目录树二级项目、右归属只列同目录项目、切片隔离、动作显式 projectId
 *  - phSwitchProject 前端项目切换（同目录无 ph_project/switch）、未知项目拒绝
 *  - 跨目录项目（左树二级）：目录位置跟随（switch）+ 项目目标，一次切换两者
 *  - 项目绑定目录（含托管）：清单收录、纯视图导航（不写 workspace_state/不 switch）
 *  - 目录本体点击进默认集合（不恢复上次项目）
 *  - 新建项目对话框：默认当前目录 / 显式托管 / 浏览其他目录 / 无当前目录不无声指定
 *  - 名称相同 ID 独立
 *  - typed target 不被 workspace_state.openDirectory 漂移覆盖（轮询参数）
 *  - 搜索归属身份 + 快速切换 stale 拒绝
 *  - 恢复卡片按完整归属过滤（项目目标 / 目录目标）——source contract：
 *    卡片加载器产品现状整体停用且无生产可达 seam，运行时过滤/去重/挂载/派发
 *    覆盖已丢失；文件另有一条用公开入口实证「停用态零请求、不挂 DOM」的用例
 *
 * 装载路线（P2 测试改造）：session-list-render 已迁 ESM → withP2EsmCase 真实
 * import（每 case 一张图）；它装载期经 window 上的 classic 宿主工厂取适配面，
 * 因此 classic 侧按真实加载序跑整条壳层 bootstrap（action-dispatcher /
 * claw-host / right-panel-registry / markdown-bootstrap / app-core / i18n /
 * session-view-state / project-data / ph-project-actions / runtime-status /
 * sidebar-render / agent-data-loader / app-ui / app-main / ph-session-list）。
 * 渲染入口用真实命名导出 renderWorkspaceSessionList（内部按 agent 分派到 PH
 * 列表），不再直接调模块私有 `_renderProgrammingHelperSessionList`。
 */

import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { marked } from 'marked';
import { createPollMaintenance } from '../public/src/modules/poll-maintenance.js';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(setImmediate); };

const SESSION_LIST_RENDER = 'public/src/modules/session-list-render.js';

const sessionListRenderSource = fs.readFileSync(new URL('../public/src/modules/session-list-render.js', import.meta.url), 'utf8');
const sessionUiSource = fs.readFileSync(new URL('../public/src/modules/session-ui.js', import.meta.url), 'utf8');

/** PH 会话列表 UI 依赖的 classic 真实加载序（宿主工厂与全局渲染面来源）。 */
const CLASSIC_STACK = [
  'public/src/modules/action-dispatcher.js',
  'public/src/modules/claw-host.js',
  'public/src/modules/right-panel-registry.js',
  'public/src/modules/markdown-bootstrap.js',
  'public/src/app-core.js',
  'public/src/modules/session-view-state.js',
  'public/src/modules/remote-connections.js',
  'public/src/modules/runtime-status.js',
  'public/src/modules/sidebar-render.js',
  'public/src/app-ui.js',
  'public/src/app-main.js',
];

/** app-ui / app-main 布局监听与首屏入口依赖的浏览器全局（沙箱无此能力）。 */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** 新建项目对话框的智能元素：querySelector 按选择器映射到预置桩。 */
function createDialogDom(registerById = () => {}) {
  const nameInput = { value: '', focus() {} };
  const modeRadio = { value: '', checked: false };
  const browseRadio = { value: 'browse', checked: false };
  const browsePathEl = { textContent: '' };
  const errorEl = { hidden: true, textContent: '' };
  const submitBtn = { disabled: false };
  const form = { listeners: {}, addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); } };
  const browse = { listeners: {}, addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); } };
  const cancelBtn = { listeners: {}, addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); } };
  const refs = {
    '#ph-new-project-name': nameInput,
    'input[name="ph-new-project-dir-mode"]:checked': modeRadio,
    'input[name="ph-new-project-dir-mode"][value="browse"]': browseRadio,
    '.ph-new-project-browse-path': browsePathEl,
    '.ph-new-project-error': errorEl,
    'button[type="submit"]': submitBtn,
    'form': form,
    '.ph-new-project-browse': browse,
  };
  const created = [];
  const makeElement = () => {
    const el = {
      className: '', innerHTML: '', removed: false,
      appendChild() {}, remove() { el.removed = true; },
      addEventListener() {}, removeEventListener() {},
      querySelector: (sel) => {
        if (refs[sel]) return refs[sel];
        // 渲染后的内部节点存在性查询（宿主只做布尔判定）：按 innerHTML 里的
        // class 命中返回一个哑节点，模拟真实 DOM 里该类节点已存在。
        const cls = /^\.([\w-]+)$/.exec(sel);
        if (cls && String(el.innerHTML || '').includes('class="' + cls[1])) {
          return { classList: { contains: () => true }, querySelector: () => null };
        }
        return null;
      },
      querySelectorAll: (sel) => (sel === '.ph-new-project-cancel' ? [cancelBtn, cancelBtn] : []),
      classList: { add() {}, remove() {}, contains: () => false },
    };
    // 与真实 DOM 一致：元素一旦拿到 id 就能被 getElementById 查到
    let elementId = '';
    Object.defineProperty(el, 'id', {
      get() { return elementId; },
      set(value) { elementId = String(value || ''); if (elementId) registerById(elementId, el); },
    });
    created.push(el);
    return el;
  };
  return { refs, makeElement, created, nameInput, modeRadio, browseRadio, browsePathEl, errorEl, submitBtn, form, browse, cancelBtn };
}

/**
 * 渲染主夹具：真实 classic bootstrap + 真实 session-list-render ESM 图。
 * entities 预置进实体缓存（跳过网络往返）。`probe` 在 case 存续期间运行。
 */
async function withSetup({ entities = [], target = null, openDirectory = '', phProjects = [], sessionsMeta = null } = {}, probe) {
  const agent = {
    id: 'programming-helper',
    source: 'prebuilt',
    modelPresets: { default: { primary: 'm1' } },
    workspace_sessions: sessionsMeta,
    // project-data.js 自带 getAgentWorkspaceState(agent) 读 agent.workspace_state
    workspace_state: null,
  };
  const workspaceState = { openDirectory, phProjects };
  agent.workspace_state = workspaceState;
  const requests = [];
  const fetchLog = [];
  const alerts = [];
  const tabsRoot = {
    dataset: { searchAgentId: 'programming-helper', searchDirectory: '', searchProjectId: '', searchRemote: 'false', searchHostId: 'programming-helper' },
    classList: { add() {}, remove() {}, contains: () => false },
  };
  const searchPanel = { innerHTML: '' };
  const elementsById = new Map();
  const domState = { lenient: true };
  const dialog = createDialogDom((id, el) => elementsById.set(id, el));
  const openContainer = { innerHTML: '' };
  const invokeCalls = [];
  const invokeBox = { result: null };
  const seed = { projectsPending: true };

  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.ResizeObserver = ResizeObserverStub;
      sandbox.URLSearchParams = URLSearchParams;
      sandbox.marked = marked;
      sandbox.currentLanguage = 'zh';
      sandbox.phSearchQuery = '';
      sandbox._phSearchTimer = null;
      sandbox.savedPhTabState = {};
      // 真实 DOM 查询面：面板容器 / 搜索面 / 列表根元素 / 对话框元素
      const doc = sandbox.document;
      const realQuerySelector = doc.querySelector.bind(doc);
      const shellElement = () => ({
        style: {}, dataset: {}, innerHTML: '', textContent: '',
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
        insertBefore() {}, setAttribute() {}, removeAttribute() {},
        querySelector: () => null, querySelectorAll: () => [],
        scrollTop: 0, scrollHeight: 0, clientHeight: 0,
      });
      sandbox.agentList = {
        addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }, style: {},
      };
      // 真实 DOM 语义：装载期（classic + ESM 图）查询到的元素保持稳定；
      // 进入用例后只有真实建立过的元素（含对话框自建节点）可被查到，未知 id
      // 返回 null（对话框据此判断宿主不存在并自建）。
      doc.getElementById = (id) => {
        if (id === 'ph-open-sessions-container') return openContainer;
        if (id === 'agent-list') return sandbox.agentList;
        if (elementsById.has(id)) return elementsById.get(id);
        if (!domState.lenient) return null;
        const el = shellElement();
        elementsById.set(id, el);
        return el;
      };
      doc.querySelector = (s) => (s === '.ph-session-tabs'
        ? tabsRoot
        : (s === '.ph-search-panel' ? searchPanel : realQuerySelector(s)));
      doc.querySelectorAll = () => [];
      doc.createElement = () => dialog.makeElement();
      doc.activeElement = null;
      doc.addEventListener = () => {};
      doc.removeEventListener = () => {};
      doc.body = { appendChild() {} };
      doc.documentElement = { dataset: {}, style: {}, classList: { add() {}, remove() {} } };

      // app-main 首屏入口：本测试只驱动渲染/选择器逻辑，不等认证后的 boot 链
      sandbox.run(`
        window.__clawAuthReady = new Promise(() => {});
        applyLanguage = () => {};
        applyTheme = () => {};
      `);
      for (const file of CLASSIC_STACK) sandbox.loadSource(file);
      // 轮询协调器宿主（classic app-main 工厂）：ESM 图经 agent-data-loader →
      // input-actions 触达 poll-coordinator-host，后者在模块求值期取该工厂。
      sandbox.createPollCoordinatorHost = () => ({
        run: async () => {}, fastInterval: () => 1000, setTimeout: () => 0, clearTimeout: () => {},
      });
      // 桥键在 classic 装载期注册（app-core 的 defineKey 覆写同名属性），
      // 因此夹具状态必须在真实装载之后写入，才能被 ESM claim 吸收。
      sandbox.allAgents = [agent];
      // 宿主面：当前 agent 记录、主视图重绘、目录选择器通道与网络层。装载后
      // 再赋值——app-core 的同名 classic 实现（getCurrentAgentRecord /
      // invoke / fetch 的 base-path patch）在装载期占用这些 window 属性。
      sandbox.getCurrentAgentRecord = () => agent;
      sandbox.renderCurrentMainView = () => {};
      sandbox.alert = (m) => alerts.push(m);
      // 搜索防抖与恢复卡片调度都经 setTimeout：夹具同步执行（与改造前的
      // 沙箱注入同义），断言不依赖真实等待。
      sandbox.setTimeout = (fn) => { fn(); return 0; };
      sandbox.clearTimeout = () => {};
      sandbox.invoke = async (mode) => { invokeCalls.push(mode); return invokeBox.result; };
      sandbox.fetch = (url, opts) => {
        const target = String(url);
        fetchLog.push({ url: target, opts });
        // 首次清单请求服务夹具预置（真实 ensure 入口的一次性取用）；之后
        // 的清单/切片请求交给用例手动 resolve，断言请求序列与落地时机。
        if (seed.projectsPending && target.includes('/protoclaw/ph_project/projects')) {
          seed.projectsPending = false;
          return Promise.resolve({
            ok: true, status: 200,
            json: async () => ({ projects: entities }),
            text: async () => JSON.stringify({ projects: entities }),
          });
        }
        return new Promise((resolve) => requests.push({ url: target, opts, resolve }));
      };
    },
  }, async (c) => {
    // agent-data-loader / project-data 已迁 ESM：前者提供下游 loader host 模块
    // 求值期取用的工厂，后者经 KernelState 桥继续服务 classic 消费方
    // （ph-project-actions / runtime-status / sidebar-render）。顺序即依赖顺序。
    await c.load('public/src/modules/agent-data-loader.js');
    const projectData = await c.load('public/src/modules/project-data.js');
    const phSessionList = await c.load('public/src/modules/ph-session-list.js');
    const sessionUi = await c.load('public/src/modules/session-ui.js');
    const phActions = await c.load('public/src/modules/ph-project-actions.js');
    const sessionList = await c.load(SESSION_LIST_RENDER);
    const modelPresetCache = await c.load('public/src/modules/model-preset-cache.js');
    // 模型预设缓存的数据面：经 owner API 预置（物理状态是模块私有，
    // 不落在 window.ClawFW 袋上；与真实消费方 ph-project-actions 同一实例）
    modelPresetCache.setClawModelPresets([{ name: 'm1' }]);
    // ESM 图装载完毕：DOM 查询转入严格模式（未知 id → null）
    domState.lenient = false;
    const ctx = c.sandbox;
    // 实体缓存预置（真实 normalize 语义）：loaded=true 后 ensure 短路
    const store = ctx.window.ClawFW.phProjectEntities;
    // 实体缓存预置：走真实 ensure 入口（真实 normalize 语义），随后清空请求日志
    store.projects = [];
    store.loaded = false;
    await projectData.ensurePhProjectEntitiesLoaded(true);
    fetchLog.length = 0;
    if (target) {
      projectData.setPhBrowsingTarget('programming-helper', target);
    }
    ctx.__agent = agent;
    // updateAgentRecord（project-data 真实现）会替换 allAgents 里的条目，
    // 变更后的 agent 要从沙箱侧读；渲染也始终用最新条目
    const currentAgent = () => ctx.run('allAgents.find((a) => a.id === "programming-helper")') || agent;
    const render = () => {
      ctx.__agent = currentAgent();
      return sessionList.renderWorkspaceSessionList(currentAgent(), {});
    };
    return probe({
      ctx, agent, currentAgent, workspaceState, requests, fetchLog, alerts, tabsRoot, searchPanel, dialog, render,
      setInvokeResult: (result) => { invokeBox.result = result; },
      invokeCalls,
      sessionList,
      phActions,
      modelPresetCache,
      phSessionList,
      phSearch: phSessionList._phSearch,
      sessionUi,
      openContainer,
      caseHandle: c,
    });
  });
}

const resolve = async (entry, data, ok = true) => {
  entry.settled = true;
  entry.resolve({
    ok, status: ok ? 200 : 500,
    json: async () => data,
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
  });
  await flush();
};

describe('模型切换与配置入口', () => {
  it('独立配置入口定向打开模型配置，不改变现有切换动作', async () => {
    const snapshot = await withSetup({
      openDirectory: 'D:/alpha',
      phProjects: [{ openDirectory: 'D:/alpha' }],
      target: { type: 'dir', id: 'dir:d:/alpha' },
    }, async (s) => {
      // 计时器口径：本步只约束「打开模型配置不引入后台周期 / 500ms 级泄漏」。
      // 渲染路径自带一次性调度——每次会话列表渲染的 0ms 恢复卡片
      // （session-list-render）、设置页 enhanceAll 的 rAF（ph-settings）；
      // 它们不是周期，必须在步进内真实执行完（下面的结清断言）。这里按类别
      // 记账：interval = 后台周期，≥500ms = 防抖/延迟泄漏，rAF = 必要性帧回调。
      const timersAtStart = s.caseHandle.timerCount();
      // 注意：此刻 globalThis.setTimeout 可能已是 classic 夹具换上的同步实现，
      // 因此下面的结清等待走 node:timers/promises 的 delay（宿主真实计时器）；
      // 这里只保存原值用于 finally 还原。
      const realSetTimeout = globalThis.setTimeout;
      const realSetInterval = globalThis.setInterval;
      const realRequestAnimationFrame = globalThis.requestAnimationFrame;
      const scheduled = { intervals: [], longTimeouts: [], rafScheduled: 0, rafCompleted: 0 };
      const errors = [];
      const warns = [];
      const realError = console.error;
      const realWarn = console.warn;
      console.error = (...args) => { errors.push(args.map(String).join(' ')); };
      console.warn = (...args) => { warns.push(args.map(String).join(' ')); };
      globalThis.setInterval = (...args) => {
        scheduled.intervals.push({ delay: args[1] });
        return realSetInterval(...args);
      };
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (Number(delay) >= 500) scheduled.longTimeouts.push({ delay });
        return realSetTimeout(callback, delay, ...args);
      };
      globalThis.requestAnimationFrame = (callback) => {
        scheduled.rafScheduled += 1;
        return realRequestAnimationFrame((...args) => {
          scheduled.rafCompleted += 1;
          return callback(...args);
        });
      };
      try {
        const html = s.render();

        assert.match(html, /<button[^>]*class="ph-model-switch"[^>]*data-action="sessions\.toggleModelSlot"/);
        assert.match(html, /<button[^>]*class="ph-model-settings"[^>]*data-action="sessions\.openModelSettings"[^>]*aria-label="模型配置"/);
        assert.doesNotMatch(html, /ph-model-settings[^>]*data-action="sessions\.toggleModelSlot"/);

        // ── 真实 DOM 后果：无备选模型时 phToggleModelSlot 打开模型配置页 ──
        // phToggleModelSlot 调的是本模块的 phOpenSettings（ESM 局部绑定），后者在
        // 首个 await 之前就 renderPhSettingsOverlay，因此宿主节点与页签/内容同步就位。
        const hostBefore = s.dialog.created.filter((el) => el.id === 'ph-settings-host').length;
        assert.equal(hostBefore, 0, '前置：严格 getElementById 下没有预置的设置宿主');
        let toggle;
        {
          // 清缓存（owner API）：覆盖 model_config 补数据路径；coder 预设未缓存 → 覆盖第二个请求
          s.modelPresetCache.setClawModelPresets([]);
          delete s.ctx.window.ClawFW._coderModelPresets;
          toggle = s.phActions.phToggleModelSlot();
          await flush();

          const host = s.dialog.created.find((el) => el.id === 'ph-settings-host');
          assert.ok(host, '设置宿主经 createElement 建立（真实 DOM 后果）');
          // 首帧：模型页签 active + 模型配置页内容（主/备选槽位）
          assert.match(host.innerHTML, /class="ph-settings-tab active"[^>]*data-tab="model"/, '模型页签为当前页');
          assert.match(host.innerHTML, /class="ph-mc-list"/, '模型配置内容已渲染');
          assert.match(host.innerHTML, /class="ph-mc-slot-label">主模型</);
          assert.doesNotMatch(host.innerHTML, /value="m1"/, '预置未到达前不显示具体模型');

          // 结清首个补数据请求：/protoclaw/model_config
          const modelConfigReq = s.requests.find((r) => r.url === '/protoclaw/model_config');
          assert.ok(modelConfigReq, '无缓存时请求模型预置');
          await resolve(modelConfigReq, { presets: [{ name: 'm1', model: 'glm-5.2', contextLength: 200000 }] });
          assert.match(host.innerHTML, /<option value="m1" selected>m1<\/option>/, '预置到达后按真实重渲染写入模型选项');
          assert.match(host.innerHTML, /class="ph-mc-info">glm-5\.2/);

          // 结清 coder 预设请求：/protoclaw/agent_model_presets?agentId=coder
          const coderReq = s.requests.find((r) => r.url === '/protoclaw/agent_model_presets?agentId=coder');
          assert.ok(coderReq, 'coder 预设未缓存时单独请求');
          await resolve(coderReq, { modelPresets: { default: { primary: 'glm-coder' } } });
          assert.deepEqual(s.ctx.window.ClawFW._coderModelPresets, { default: { primary: 'glm-coder' } },
            'coder 预设缓存由真实请求结果写入');

          await toggle;
        }

        // 动作通道：session-list-render 的处理器直接调用 ESM 的 phOpenSettings，
        // 断言钉在真实后果上 —— 设置宿主的当前页签。
        const activeTab = () => {
          const host = s.dialog.created.filter((el) => el.id === 'ph-settings-host').at(-1);
          if (!host) return null;
          return /class="ph-settings-tab active"[^>]*data-tab="([a-z]+)"/.exec(String(host.innerHTML))?.[1] || null;
        };
        s.ctx.run(`window.ClawFW.actions.invoke('sessions.openModelSettings', { dataset: {} }, null, 0)`);
        await flush();
        assert.equal(activeTab(), 'model', '模型配置入口落在模型页');
        // 工作空间设置按钮每次强行落插件及配置页，不受一级页签记忆影响
        s.ctx.run(`window.ClawFW.actions.invoke('sessions.openSettings', { dataset: {} }, null, 0)`);
        await flush();
        assert.equal(activeTab(), 'feature', '设置入口落在功能/插件页');

        // ── 一次性调度结清：让本步排下的 0ms 恢复卡片与 rAF 真实执行完，
        // 再按类别量「后台周期 / 500ms 泄漏 / 残留计时器」──────────────
        // 等待必须走宿主真实计时器：classic 夹具把沙箱 setTimeout 换成了同步执行，
        // 用它等待只推进微任务、帧回调永远不落地。按残余帧回调收敛（每拍结清一批）。
        for (let i = 0; i < 10 && scheduled.rafCompleted < scheduled.rafScheduled; i++) {
          await delay(1);
        }
        assert.deepEqual(scheduled.intervals, [], '打开模型配置不得创建后台周期计时器');
        assert.deepEqual(scheduled.longTimeouts, [], '打开模型配置不得引入 500ms 级防抖/后台延迟');
        assert.ok(scheduled.rafScheduled >= 1, '设置页渲染确实经 rAF 增强（观察面覆盖到位）');
        assert.equal(scheduled.rafCompleted, scheduled.rafScheduled,
          '一次性 rAF 回调全部执行（不残留帧回调）');
        // 一次性调度结清后不得新增残留计时器（装载期的调度器计时器由 case
        // dispose 统一取消；后面的 dispose 后活动断言验证它不会再触发）
        assert.ok(s.caseHandle.timerCount() <= timersAtStart,
          `一次性回调结清后不新增残留计时器（起始 ${timersAtStart}，现有 ${s.caseHandle.timerCount()}）`);

        // 非预期日志：整个步进过程（含一次性回调）不得出现 error / warn
        assert.deepEqual(errors, [], '打开模型配置不得产生 console.error');
        assert.deepEqual(warns, [], '打开模型配置不得产生 console.warn');
        // 请求全部结清：不把 pending 留到 case 之外
        assert.deepEqual(s.requests.filter((r) => !r.settled), [], '本步启动的请求全部结清');
        assert.equal(s.agent.modelPresets.default.primary, 'm1', 'opening model settings does not change the primary model');
        // dispose 后活动断言素材：保留活动代理（array 引用在 case 结束后仍可读长度）
        return { created: s.dialog.created, fetched: s.fetchLog,
          createdLen: s.dialog.created.length, fetchedLen: s.fetchLog.length };
      } finally {
        globalThis.setTimeout = realSetTimeout;
        globalThis.setInterval = realSetInterval;
        globalThis.requestAnimationFrame = realRequestAnimationFrame;
        console.error = realError;
        console.warn = realWarn;
      }
    });
    // case 已 dispose（globals 撤走、计时器取消）：再等一拍确认没有迟到活动
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(snapshot.created.length, snapshot.createdLen, 'dispose 后不再创建 DOM 节点');
    assert.equal(snapshot.fetched.length, snapshot.fetchedLen, 'dispose 后不再发起请求');
  });
});

describe('双选择器 — 纯目录无回归', () => {
  it('单一目录：左目录项 + 右「默认项目」 active + 新建对话携带 openDirectory 而非 projectId', async () => {
    await withSetup({
      openDirectory: 'D:/alpha',
      phProjects: [{ openDirectory: 'D:/alpha' }],
      sessionsMeta: {
        sessions: [{ id: 's1', title: 'Dir chat', updatedAt: '2026-10-20T10:00:00Z', openDirectory: 'D:/alpha', messageCount: 2 }],
        sessionProjectId: '', sessionTotal: 1, mainTotal: 1, archivedTotal: 0,
      },
    }, async (s) => {
      const html = s.render();
      assert.match(html, /Dir chat/);
      // 双选择器：左目录 / 右归属
      assert.match(html, /ph-dir-selector/);
      assert.match(html, /ph-org-selector/);
      // 左：目录项（无项目目录同样有右侧面板，只含默认项目）；触发器为 button（键盘可达）
      assert.match(html, /ph-dir-item[^>]*data-dir-id="dir:d:\/alpha"/);
      assert.doesNotMatch(html, /ph-dir-expand/);
      assert.match(html, /<button[^>]*ph-project-dropdown-trigger[^>]*aria-expanded="false"/);
      assert.match(html, /ph-dir-subprojects[^>]*data-subprojects-for="dir:d:\/alpha"/, 'project-less dir still gets a submenu');
      // 左触发器：大字目录名（主形态）
      assert.match(html, /ph-project-header-name">alpha</);
      // 右胶囊：默认项目（无项目时）
      assert.match(html, /ph-org-pill-label">默认项目</);
      // 归属菜单顶部是添加/编辑动作；加号直接添加，不再展开快速菜单。
      const orgMenu = html.slice(html.indexOf('ph-org-menu'), html.indexOf('ph-quick-add'));
      assert.ok(orgMenu.includes('ph-org-menu-actions'));
      assert.ok(orgMenu.includes('ph-org-menu-options" role="group" tabindex="0"'));
      assert.ok(orgMenu.indexOf('ph-org-menu-actions') < orgMenu.indexOf('ph-org-menu-options'));
      assert.ok(orgMenu.indexOf('添加项目') < orgMenu.indexOf('编辑项目'));
      assert.ok(orgMenu.indexOf('编辑项目') < orgMenu.indexOf('ph-org-menu-options'));
      assert.ok(html.includes('class="ph-quick-add-btn" aria-label="添加项目"'));
      assert.ok(html.includes('data-action="sessions.newProjectDialog"'));
      assert.doesNotMatch(html, /ph-quick-menu|管理项目…/);
      assert.doesNotMatch(html, /目录设置/);
      assert.ok(html.includes('data-dir-config="D:/alpha"'), 'default-project row carries a settings gear');
      assert.ok(html.lastIndexOf('项目设置') < html.indexOf('ph-quick-add'), 'settings entry lives in org rows');
      // 左：打开目录…动作入口置顶（动作形态，非目录行结构）+ banner 文案；
      // 目录项包进独立滚动区（动作行固定不随列表滚动）
      assert.ok(html.indexOf('ph-open-dir-entry') < html.indexOf('ph-dir-menu-options'), 'open-directory action pinned above the directory options');
      assert.ok(html.indexOf(['ph-dir-menu-options" role="group" tabindex="0"'].join('')) < html.indexOf('ph-dir-item'), 'directory rows live inside the scrollable options region');
      assert.ok(html.indexOf('ph-dir-menu-options') < html.indexOf('ph-dir-subprojects'), 'hover submenus stay outside the options region');
      // 键盘可达：可选择菜单项带 role=menuitem + tabindex；key handler 仅在
      // 目标为自身时响应（不吞行内 button 的 Space 原生激活）
      assert.match(html, /role="menuitem" tabindex="0" data-key-activate data-event="click keydown"/);
      assert.match(html, /ph-dir-item[^>]*role="menuitem"/);
      assert.match(html, /ph-org-item[^>]*role="menuitem"/);
      assert.match(html, /ph-banner-btn[^>]*>打开目录</);
      // 右：默认项目 active
      assert.match(html, /ph-org-directory active/);
      // 新对话动作：目录身份（openDirectory 有值，无 projectId 键）
      const action = /data-workspace-action="([^"]+)"/.exec(html)[1];
      const parsed = JSON.parse(action.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      assert.equal(parsed.openDirectory, 'D:/alpha');
      assert.equal(parsed.projectId, undefined);
      // [static contract] 恢复卡片调度：真实派发表达式钉住完整归属（目录
      // openDirectory + 目标 id）。卡片加载器在产品现状下整体停用
      // （PH_OPEN_SESSIONS_CARD_DISABLED 恒 true + 模块私有常量，无生产可达
      // seam），运行时派发覆盖已丢失；此处只做静态契约核对，不代表运行时行为。
      assert.match(sessionListRenderSource,
        /phLoadOpenSessionsCard\(agent\.id, currentProject\.openDirectory, currentProject\.id\)/,
        '[static contract] 卡片派发表达式携带完整归属（目录 openDirectory + 目标 id）');
    });
  });
});

describe('双选择器 — 同目录 D/A/B', () => {
  const entities = [
    { id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared', createdAt: '2026-10-01', updatedAt: '2026-10-02' },
    { id: 'prj_B', name: 'Beta', workDirectory: 'D:/shared', createdAt: '2026-10-01', updatedAt: '2026-10-02' },
    { id: 'prj_C', name: 'Cross', workDirectory: 'D:/other', createdAt: '2026-10-01', updatedAt: '2026-10-02' },
  ];
  const base = {
    entities,
    openDirectory: 'D:/shared',
    phProjects: [{ openDirectory: 'D:/shared' }, { openDirectory: 'D:/other' }],
  };

  it('渲染 HTML 的 div 标签平衡：多余的 </div> 会让浏览器解析时吃掉菜单容器，布局整体塌掉', async () => {
    await withSetup({
      ...base,
      target: { type: 'project', id: 'prj_A' },
      sessionsMeta: {
        sessions: [{ id: 'sA', title: 'A chat', updatedAt: '2026-10-21T10:00:00Z', projectId: 'prj_A', messageCount: 1 }],
        sessionProjectId: 'prj_A', sessionTotal: 1, mainTotal: 1, archivedTotal: 0,
      },
    }, async (s) => {
      const html = s.render();
      const opened = (html.match(/<div\b/g) || []).length;
      const closed = (html.match(/<\/div>/g) || []).length;
      assert.equal(opened, closed, `div tags unbalanced: ${opened} opened vs ${closed} closed`);
    });
  });

  it('项目目标：左目录树含二级项目、右归属只列同目录项目（不跨目录）、active 归属、动作显式 projectId', async () => {
    await withSetup({
      ...base,
      target: { type: 'project', id: 'prj_A' },
      sessionsMeta: {
        sessions: [{ id: 'sA', title: 'A chat', updatedAt: '2026-10-21T10:00:00Z', projectId: 'prj_A', messageCount: 1 }],
        sessionProjectId: 'prj_A', sessionTotal: 1, mainTotal: 1, archivedTotal: 0,
      },
    }, async (s) => {
      const html = s.render();
      const dirSeg = html.slice(0, html.indexOf('ph-org-selector'));
      // orgSeg 止于 + 快速菜单（两者同在 ph-org-controls 内，先后渲染）
      const orgSeg = html.slice(html.indexOf('ph-org-selector'), html.indexOf('ph-quick-add'));
      // 左：目录树 —— shared 目录行 + 二级（默认项 + Alpha/Beta）；other 目录行 + Cross
      assert.match(dirSeg, /ph-dir-item[^>]*data-dir-id="dir:d:\/shared"/);
      assert.match(dirSeg, /ph-dir-item[^>]*data-dir-id="dir:d:\/other"/);
      const sharedSubStart = dirSeg.indexOf('data-subprojects-for="dir:d:/shared"');
      const otherSubStart = dirSeg.indexOf('data-subprojects-for="dir:d:/other"');
      // 目录顺序由稳定排序决定（不依赖插入顺序）：每块取自身到下一块
      const subBlockOf = (seg, start) => {
        if (start < 0) return '';
        const next = seg.indexOf('data-subprojects-for="', start + 1);
        return seg.slice(start, next < 0 ? undefined : next);
      };
      const sharedSub = subBlockOf(dirSeg, sharedSubStart);
      const otherSub = subBlockOf(dirSeg, otherSubStart);
      assert.ok(sharedSubStart >= 0, 'shared dir subprojects block exists');
      assert.ok(otherSubStart >= 0, 'other dir subprojects block exists');
      assert.match(sharedSub, /ph-dir-sub-default[^>]*data-dir-id="dir:d:\/shared"/, 'sub menu has the default directory entry');
      assert.match(sharedSub, /data-project-id="prj_A"/);
      assert.match(sharedSub, /data-project-id="prj_B"/);
      assert.doesNotMatch(sharedSub, /prj_C/);
      // 左：当前目录 active = 项目绑定目录（shared），右：项目 active
      assert.match(dirSeg, /ph-dir-item active" data-dir-id="dir:d:\/shared"/);
      // 右：项目下拉开头提供添加/编辑动作，之后是默认项目 + 同目录项目；Cross 不跨目录出现。
      assert.match(orgSeg, /添加项目[\s\S]*?编辑项目[\s\S]*?ph-org-directory/);
      assert.match(orgSeg, /ph-org-item active" data-project-id="prj_A"/);
      assert.match(orgSeg, /data-project-id="prj_B"/);
      assert.doesNotMatch(orgSeg, /prj_C/);
      const quickAdd = html.slice(html.indexOf('ph-quick-add'));
      assert.doesNotMatch(quickAdd, /ph-quick-menu|phOpenManageProjectsDialog/);
      // 加号是直接添加入口，不再充当下拉触发器；设置仍由归属行内齿轮负责。
      assert.match(html, /ph-org-pill-label">Alpha</);
      assert.match(html, /class="ph-quick-add-btn"[^>]*aria-label="添加项目"[^>]*data-action="sessions.newProjectDialog"/);
      assert.match(orgSeg, /data-project-config="prj_A"/, 'project row carries its own settings gear');
      assert.match(orgSeg, /data-project-config="prj_B"/);
      assert.match(orgSeg, /data-dir-config="D:\/shared"/, 'default-project row carries a dir-scope settings gear');
      // 切片只含项目会话（目录会话不在项目切片内）
      assert.match(html, /A chat/);
      // 新对话动作：显式 projectId，openDirectory 为空
      const action = /data-workspace-action="([^"]+)"/.exec(html)[1];
      const parsed = JSON.parse(action.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      assert.equal(parsed.projectId, 'prj_A');
      assert.equal(parsed.openDirectory, '');
      // [static contract] 同一派发表达式承载项目身份；卡片功能整体停用，
      // 运行时派发覆盖已丢失（见首例注释），此处只做静态契约核对。
      assert.match(sessionListRenderSource,
        /phLoadOpenSessionsCard\(agent\.id, currentProject\.openDirectory, currentProject\.id\)/,
        '[static contract] 卡片派发表达式携带完整归属（项目 openDirectory + 目标 id）');
      assert.match(html, /data-project-id="prj_A"/, 'project identity reaches the rendered list');
    });
  });

  it('目录目标（同目录）：左目录行 active、右默认项目 active、动作走 openDirectory、无 projectId', async () => {
    await withSetup({
      ...base,
      target: { type: 'dir', id: 'dir:d:/shared' },
      sessionsMeta: {
        sessions: [{ id: 'sD', title: 'Dir chat', updatedAt: '2026-10-21T11:00:00Z', openDirectory: 'D:/shared', messageCount: 3 }],
        sessionProjectId: '', sessionTotal: 1, mainTotal: 1, archivedTotal: 0,
      },
    }, async (s) => {
      const html = s.render();
      assert.match(html, /ph-dir-item active" data-dir-id="dir:d:\/shared"/);
      assert.match(html, /ph-org-directory active/);
      assert.doesNotMatch(html, /ph-org-item active" data-project-id=/);
      const action = /data-workspace-action="([^"]+)"/.exec(html)[1];
      const parsed = JSON.parse(action.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      assert.equal(parsed.openDirectory, 'D:/shared');
      assert.equal(parsed.projectId, undefined);
      assert.match(html, /Dir chat/);
    });
  });

  it('前端项目切换（同目录）：按 projectId 拉切片、不调用 ph_project/switch、目标持久化', async () => {
    await withSetup({ ...base, target: { type: 'project', id: 'prj_A' },
      sessionsMeta: { sessions: [], sessionProjectId: 'prj_A', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 } }, async (s) => {
      const switched = s.ctx.run('window.phSwitchProject("prj_B")');
      await flush();
      const req = s.fetchLog.find((f) => f.url.includes('/protoclaw/prebuilt_sessions'));
      assert.ok(req, 'project slice fetch should fire');
      assert.match(req.url, /projectId=prj_B/);
      assert.doesNotMatch(req.url, /projectDir=/);
      assert.ok(!s.fetchLog.some((f) => f.url.includes('/protoclaw/ph_project/switch')), 'same-dir project switch must stay frontend-only');
      await resolve(s.requests.at(-1), { sessions: [{ id: 'sB', title: 'B chat', updatedAt: '2026-10-22T09:00:00Z', projectId: 'prj_B', messageCount: 1 }], sessionProjectId: 'prj_B', sessionTotal: 1, mainTotal: 1, archivedTotal: 0 });
      await switched;
      assert.equal(s.currentAgent().workspace_sessions.sessionProjectId, 'prj_B');
      const stored = s.ctx.run(`localStorage.getItem('protoclaw:ph-browsing-target:programming-helper')`);
      assert.equal(JSON.parse(stored).id, 'prj_B');
    });
  });

  it('跨目录项目（左树二级）：目录位置跟随（switch）+ 项目目标，一次切换两者', async () => {
    await withSetup({ ...base, target: { type: 'project', id: 'prj_A' },
      sessionsMeta: { sessions: [], sessionProjectId: 'prj_A', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 } }, async (s) => {
      const switched = s.ctx.run('window.phSwitchProject("prj_C")');
      await flush();
      // 1) 目录位置切换：switch 调用（registry 目录 d:/other）
      const switchReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/switch'));
      assert.ok(switchReq, 'cross-dir project must switch the workspace directory');
      assert.deepEqual(JSON.parse(switchReq.opts.body), { agentId: 'programming-helper', projectId: 'dir:d:/other' });
      await resolve(s.requests[0], { state: { openDirectory: 'D:/other', phProjects: [{ openDirectory: 'D:/shared' }, { openDirectory: 'D:/other' }] } });
      // 2) 项目切片（projectId）
      const req = s.fetchLog.find((f) => f.url.includes('/protocloud') || f.url.includes('/protoclaw/prebuilt_sessions'));
      assert.match(req.url, /projectId=prj_C/);
      await resolve(s.requests.at(-1), { sessions: [], sessionProjectId: 'prj_C', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 });
      await switched;
      const stored = s.ctx.run(`localStorage.getItem('protoclaw:ph-browsing-target:programming-helper')`);
      assert.equal(JSON.parse(stored).id, 'prj_C');
      // 双选择器同步：左 = other 目录，右 = Cross 项目
      const html = s.render();
      assert.match(html, /ph-dir-item active" data-dir-id="dir:d:\/other"/);
      assert.match(html, /ph-org-item active" data-project-id="prj_C"/);
    });
  });

  it('目录本体点击进默认集合：不恢复上次项目', async () => {
    await withSetup({ ...base, target: { type: 'project', id: 'prj_A' },
      sessionsMeta: { sessions: [], sessionProjectId: 'prj_A', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 } }, async (s) => {
      const switched = s.ctx.run('window.phSwitchProject("dir:d:/shared")');
      await flush();
      assert.ok(s.fetchLog.some((f) => f.url.includes('/protoclaw/ph_project/switch')));
      await resolve(s.requests[0], { state: { openDirectory: 'D:/shared', phProjects: [{ openDirectory: 'D:/shared' }, { openDirectory: 'D:/other' }] } });
      await resolve(s.requests.at(-1), { sessions: [{ id: 'sD2', title: 'Back to dir', updatedAt: '2026-10-22T10:00:00Z', openDirectory: 'D:/shared', messageCount: 1 }], sessionProjectId: '', sessionTotal: 1, mainTotal: 1, archivedTotal: 0 });
      await switched;
      const stored = s.ctx.run(`localStorage.getItem('protoclaw:ph-browsing-target:programming-helper')`);
      assert.equal(JSON.parse(stored).id, 'dir:d:/shared', 'directory click resets to the default collection');
      const html = s.render();
      assert.match(html, /ph-org-directory active/);
      assert.doesNotMatch(html, /ph-org-item active" data-project-id=/);
    });
  });

  it('未知项目：显式失败（不退回另一个目标、不发切片请求）', async () => {
    await withSetup({ ...base, target: { type: 'project', id: 'prj_A' },
      sessionsMeta: { sessions: [], sessionProjectId: 'prj_A', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 } }, async (s) => {
      await s.ctx.run('window.phSwitchProject("prj_missing")');
      assert.ok(s.alerts.some((m) => String(m).includes('prj_missing')));
      assert.ok(!s.fetchLog.some((f) => f.url.includes('/protoclaw/prebuilt_sessions')));
      const stored = s.ctx.run(`localStorage.getItem('protoclaw:ph-browsing-target:programming-helper')`);
      assert.equal(JSON.parse(stored).id, 'prj_A', 'target unchanged on unknown project');
    });
  });
});

describe('双选择器 — 最近访问排序与远程目录退场', () => {
  it('目录按最近访问排序（当前目录置顶）、远程目录不出现、子菜单项目按最近访问排序', async () => {
    await withSetup({
      phProjects: [
        { openDirectory: 'D:/idle' },
        { openDirectory: 'D:/old' },
        { openDirectory: 'D:/recent' },
      ],
      // 当前目录 = idle（无任何会话活动）：置顶验证「正在访问 = 最近访问」
      target: { type: 'dir', id: 'dir:d:/idle', openDirectory: 'D:/idle' },
      openDirectory: 'D:/idle',
      sessionsMeta: {
        sessions: [
          { id: 'so', title: 'old chat', openDirectory: 'D:/old', updatedAt: '2026-10-01T10:00:00Z', messageCount: 1 },
          { id: 'sr', title: 'recent chat', openDirectory: 'D:/recent', updatedAt: '2026-10-21T10:00:00Z', messageCount: 1 },
        ],
        sessionTotal: 2, mainTotal: 2, archivedTotal: 0,
      },
      entities: [
        { id: 'prj_old', name: 'OldProj', workDirectory: 'D:/recent', createdAt: '2026-09-01', updatedAt: '2026-09-01', lastActivityAt: '2026-10-02T10:00:00Z' },
        { id: 'prj_new', name: 'NewProj', workDirectory: 'D:/recent', createdAt: '2026-09-01', updatedAt: '2026-09-02', lastActivityAt: '2026-10-22T10:00:00Z' },
      ],
    }, async (s) => {
      // 远程历史桶（E:/ghost 即使活动最新也不得进入目录菜单）
      s.ctx.window.getRemoteHistoryProjectBuckets = () => [
        { openDirectory: 'E:/ghost', sessions: [{ id: 'r1', title: 'r', updatedAt: '2026-10-23T00:00:00Z' }] },
      ];
      const html = s.render();
      const dirSeg = html.slice(0, html.indexOf('ph-org-selector'));
      assert.doesNotMatch(dirSeg, /dir:e:\/ghost/, 'remote-only dir stays out of the directory menu');
      const pos = (id) => dirSeg.indexOf('data-dir-id="dir:' + id + '"');
      assert.ok(pos('d:/idle') >= 0 && pos('d:/recent') >= 0 && pos('d:/old') >= 0, 'all local dirs present');
      assert.ok(pos('d:/idle') < pos('d:/recent'), 'current dir pinned first (being accessed now)');
      assert.ok(pos('d:/recent') < pos('d:/old'), 'recently used dir before older one');
      // recent 子菜单项目：lastActivityAt 新者优先（无当前项目）
      const subStart = dirSeg.indexOf('data-subprojects-for="dir:d:/recent"');
      const subNext = dirSeg.indexOf('data-subprojects-for="', subStart + 1);
      const sub = dirSeg.slice(subStart, subNext < 0 ? undefined : subNext);
      assert.ok(sub.indexOf('prj_new') >= 0 && sub.indexOf('prj_old') >= 0);
      assert.ok(sub.indexOf('prj_new') < sub.indexOf('prj_old'), 'recently accessed project first in submenu');
    });
  });

  it('同目录项目当前目标置顶（正在访问），其余按最近活动倒序', async () => {
    await withSetup({
      phProjects: [{ openDirectory: 'D:/w' }],
      target: { type: 'project', id: 'prj_mid' },
      openDirectory: 'D:/w',
      sessionsMeta: { sessions: [], sessionProjectId: 'prj_mid', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 },
      entities: [
        { id: 'prj_new', name: 'N', workDirectory: 'D:/w', createdAt: '2026-09-01', updatedAt: '2026-09-03', lastActivityAt: '2026-10-23T00:00:00Z' },
        { id: 'prj_mid', name: 'M', workDirectory: 'D:/w', createdAt: '2026-09-01', updatedAt: '2026-09-02', lastActivityAt: '2026-10-10T00:00:00Z' },
        { id: 'prj_old', name: 'O', workDirectory: 'D:/w', createdAt: '2026-09-01', updatedAt: '2026-09-01', lastActivityAt: '2026-10-01T00:00:00Z' },
      ],
    }, async (s) => {
      const html = s.render();
      // 归属胶囊菜单（getPhProjectsInDirectory 同一排序规则）
      const orgSeg = html.slice(html.indexOf('ph-org-selector'), html.indexOf('ph-quick-add'));
      const order = ['prj_mid', 'prj_new', 'prj_old'].map((id) => orgSeg.indexOf('data-project-id="' + id + '"'));
      assert.ok(order.every((p) => p >= 0), 'all three projects listed');
      assert.ok(order[0] < order[1] && order[1] < order[2], 'current project first, then by lastActivityAt desc');
    });
  });

  it('phActivity 目录信号驱动排序：归属切片后非当前目录桶内无会话，信号补位（键归一化含尾斜杠/反斜杠/大小写）', async () => {
    // 复刻轮询切片后的真实形态：sessions 只剩当前目录（归属替换），
    // 其他目录排序只能靠 phActivity.directories 全量聚合信号。
    await withSetup({
      phProjects: [
        { openDirectory: 'D:/cur' },
        { openDirectory: 'D:/a' },
        { openDirectory: 'D:/b' },
        { openDirectory: 'D:\\Mixed\\Case\\' },
      ],
      target: { type: 'dir', id: 'dir:d:/cur', openDirectory: 'D:/cur' },
      openDirectory: 'D:/cur',
      sessionsMeta: {
        sessions: [
          { id: 'sc', title: 'cur chat', openDirectory: 'D:/cur', updatedAt: '2026-10-20T10:00:00Z', messageCount: 1 },
        ],
        sessionTotal: 1, mainTotal: 1, archivedTotal: 0,
        phActivity: {
          // 键为服务端归一化形态（反斜杠→/、剪尾斜杠、小写）。
          // D:/a 无信号：验证无信号目录回退路径序垫底。
          directories: {
            'dir:d:/b': '2026-10-22T00:00:00Z',
            'dir:d:/mixed/case': '2026-10-23T00:00:00Z',
          },
          projects: {},
        },
      },
    }, async (s) => {
      const html = s.render();
      const dirSeg = html.slice(0, html.indexOf('ph-org-selector'));
      // phDirIdOf 不剪尾斜杠：DOM id 带尾斜杠，活动键不带——查表靠 _phActivityDirKey 归一化
      const pos = (id) => dirSeg.indexOf('data-dir-id="' + id + '"');
      assert.ok(pos('dir:d:/cur') >= 0 && pos('dir:d:/b') >= 0 && pos('dir:d:/a') >= 0, 'all dirs present');
      assert.ok(pos('dir:d:/cur') < pos('dir:d:/mixed/case/'), 'current dir pinned first');
      assert.ok(pos('dir:d:/mixed/case/') < pos('dir:d:/b'), 'signal-newest dir (normalized key hit) before older-signal dir');
      assert.ok(pos('dir:d:/b') < pos('dir:d:/a'), 'signal dir before no-signal dir (path fallback)');
    });
  });

  it('phActivity 项目信号纳入排序：实体缓存陈旧（ensure-loaded 一次性）时信号驱动，取最大值', async () => {
    await withSetup({
      phProjects: [{ openDirectory: 'D:/w' }],
      target: { type: 'dir', id: 'dir:d:/w', openDirectory: 'D:/w' },
      openDirectory: 'D:/w',
      sessionsMeta: {
        sessions: [], sessionTotal: 0, mainTotal: 0, archivedTotal: 0,
        phActivity: {
          directories: {},
          projects: { prj_live: '2026-10-24T00:00:00Z' },
        },
      },
      entities: [
        // prj_frozen 实体 lastActivityAt 是页面加载时算的旧值（缓存冻结）
        { id: 'prj_frozen', name: 'F', workDirectory: 'D:/w', createdAt: '2026-09-01', updatedAt: '2026-09-02', lastActivityAt: '2026-10-20T00:00:00Z' },
        // prj_live 实体值更旧，但轮询信号最新 → 应排最前
        { id: 'prj_live', name: 'L', workDirectory: 'D:/w', createdAt: '2026-09-01', updatedAt: '2026-09-01', lastActivityAt: '2026-10-01T00:00:00Z' },
        // prj_entity_only 无信号：实体字段独立参与取最大值
        { id: 'prj_entity_only', name: 'E', workDirectory: 'D:/w', createdAt: '2026-09-01', updatedAt: '2026-09-01', lastActivityAt: '2026-10-10T00:00:00Z' },
      ],
    }, async (s) => {
      const html = s.render();
      const orgSeg = html.slice(html.indexOf('ph-org-selector'), html.indexOf('ph-quick-add'));
      const order = ['prj_live', 'prj_frozen', 'prj_entity_only'].map((id) => orgSeg.indexOf('data-project-id="' + id + '"'));
      assert.ok(order.every((p) => p >= 0), 'all three projects listed');
      assert.ok(order[0] < order[1] && order[1] < order[2], 'signal beats stale entity cache; max(entity, signal) ordering');
    });
  });

  it('缺 phActivity 字段（旧服务端/降级载荷）：回退桶内推断，切片下无会话目录按路径稳定垫底', async () => {
    await withSetup({
      phProjects: [
        { openDirectory: 'D:/cur' },
        { openDirectory: 'D:/gamma' },
        { openDirectory: 'D:/alpha' },
        { openDirectory: 'D:/beta' },
      ],
      target: { type: 'dir', id: 'dir:d:/cur', openDirectory: 'D:/cur' },
      openDirectory: 'D:/cur',
      // 无 phActivity 字段：切片后非当前目录桶内恒空 → 路径字母序（现状回退基线）
      sessionsMeta: {
        sessions: [{ id: 'sc', title: 'cur chat', openDirectory: 'D:/cur', updatedAt: '2026-10-20T10:00:00Z', messageCount: 1 }],
        sessionTotal: 1, mainTotal: 1, archivedTotal: 0,
      },
    }, async (s) => {
      const html = s.render();
      const dirSeg = html.slice(0, html.indexOf('ph-org-selector'));
      const pos = (id) => dirSeg.indexOf('data-dir-id="' + id + '"');
      assert.ok(pos('dir:d:/cur') < pos('dir:d:/alpha'), 'current dir first');
      assert.ok(pos('dir:d:/alpha') < pos('dir:d:/beta') && pos('dir:d:/beta') < pos('dir:d:/gamma'), 'no-signal dirs fall back to stable path order');
    });
  });
});

describe('双选择器 — 项目绑定目录（含托管）', () => {
  const managedDir = 'D:/data/workspaces/ph-projects/prj_M';
  const entities = [
    { id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared', createdAt: '2026-10-01', updatedAt: '2026-10-02' },
    { id: 'prj_M', name: 'Managed One', workDirectory: managedDir, directorySource: 'managed', createdAt: '2026-10-01', updatedAt: '2026-10-02' },
  ];

  it('清单收录项目绑定目录（含托管），不写目录注册表、不混入目录会话桶', async () => {
    await withSetup({
      entities,
      openDirectory: 'D:/shared',
      phProjects: [{ openDirectory: 'D:/shared' }],
      sessionsMeta: { sessions: [], sessionProjectId: '', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 },
    }, async (s) => {
      const html = s.render();
      // 左清单含托管目录条目 + 其二级项目；托管目录不在 workspace phProjects 里
      assert.match(html, /ph-dir-item[^>]*data-dir-id="dir:d:\/data\/workspaces\/ph-projects\/prj_m"/);
      assert.match(html, /data-subprojects-for="dir:d:\/data\/workspaces\/ph-projects\/prj_m"/);
      assert.deepEqual(s.workspaceState.phProjects, [{ openDirectory: 'D:/shared' }], 'listing must not register the bound directory');
    });
  });

  it('选择项目绑定目录：纯视图导航（无 switch、切片按 projectDir、目标持久化、workspace_state 不写）', async () => {
    await withSetup({
      entities,
      openDirectory: 'D:/shared',
      phProjects: [{ openDirectory: 'D:/shared' }],
      sessionsMeta: { sessions: [], sessionProjectId: '', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 },
    }, async (s) => {
      const switched = s.ctx.run('window.phSwitchProject("dir:d:/data/workspaces/ph-projects/prj_m")');
      await flush();
      assert.ok(!s.fetchLog.some((f) => f.url.includes('/protoclaw/ph_project/switch')), 'project-bound dir must not call ph_project/switch');
      const req = s.fetchLog.find((f) => f.url.includes('/protoclaw/prebuilt_sessions'));
      assert.ok(req, 'slice fetch should fire');
      assert.match(decodeURIComponent(req.url), new RegExp('projectDir=' + managedDir.replace(/\//g, '\\/')));
      await resolve(s.requests.at(-1), { sessions: [{ id: 'sM', title: 'Managed dir chat', updatedAt: '2026-10-22T08:00:00Z', openDirectory: managedDir, messageCount: 1 }], sessionProjectId: '', sessionTotal: 1, mainTotal: 1, archivedTotal: 0 });
      await switched;
      // workspace_state 不被写（无 openDirectory 变更）
      assert.equal(s.workspaceState.openDirectory, 'D:/shared');
      const stored = s.ctx.run(`localStorage.getItem('protoclaw:ph-browsing-target:programming-helper')`);
      assert.equal(JSON.parse(stored).id, 'dir:d:/data/workspaces/ph-projects/prj_m');
      // 渲染：目录视图（左 active = 托管目录；右 = 默认项目 + 同目录项目 prj_M）
      const html = s.render();
      assert.match(html, /Managed dir chat/);
      assert.match(html, /ph-dir-item active" data-dir-id="dir:d:\/data\/workspaces\/ph-projects\/prj_m"/);
      assert.match(html, /ph-org-directory active/);
      const orgSeg = html.slice(html.indexOf('ph-org-selector'));
      assert.match(orgSeg, /data-project-id="prj_M"/);
      // 新对话：目录身份（托管目录 openDirectory）
      const action = /data-workspace-action="([^"]+)"/.exec(html)[1];
      const parsed = JSON.parse(action.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      assert.equal(parsed.openDirectory, managedDir);
      assert.equal(parsed.projectId, undefined);
    });
  });

  it('持久化目标指向项目绑定目录：重载不回退（stale 防污染）', async () => {
    await withSetup({
      entities,
      openDirectory: 'D:/shared',
      phProjects: [{ openDirectory: 'D:/shared' }],
      target: { type: 'dir', id: 'dir:d:/data/workspaces/ph-projects/prj_m' },
      sessionsMeta: { sessions: [{ id: 'sM', title: 'Managed dir chat', updatedAt: '2026-10-22T08:00:00Z', openDirectory: managedDir, messageCount: 1 }], sessionProjectId: '', sessionTotal: 1, mainTotal: 1, archivedTotal: 0 },
    }, async (s) => {
      const html = s.render();
      assert.match(html, /ph-dir-item active" data-dir-id="dir:d:\/data\/workspaces\/ph-projects\/prj_m"/, 'stored project-bound dir target survives reload');
    });
  });

  it('未知目录 id（既非注册桶也非项目绑定目录）：走旧 fall-through，服务端显式拒绝', async () => {
    await withSetup({
      entities,
      openDirectory: 'D:/shared',
      phProjects: [{ openDirectory: 'D:/shared' }],
      sessionsMeta: { sessions: [], sessionProjectId: '', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 },
    }, async (s) => {
      const switched = s.ctx.run('window.phSwitchProject("dir:/nowhere")');
      await flush();
      const switchReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/switch'));
      assert.ok(switchReq, 'unknown dir falls through to the switch endpoint');
      await resolve(s.requests[0], 'unknown directory', false);
      await switched;
      assert.ok(s.alerts.some((m) => String(m).includes('切换项目失败') || String(m).includes('Failed')), 'server rejection surfaces visibly');
    });
  });
});

describe('双选择器 — 新建项目对话框', () => {
  const entities = [{ id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared', createdAt: '2026-10-01', updatedAt: '2026-10-02' }];
  const base = { entities, phProjects: [{ openDirectory: 'D:/shared' }], openDirectory: 'D:/shared' };

  it('取消：对话框关闭、无网络副作用、无目标变更', async () => {
    await withSetup(base, async (s) => {
      await s.phActions.phOpenNewProjectDialog();
      // created[0]=host, created[1]=overlay；取消按钮 click 绑定 close()
      const overlay = s.dialog.created[1];
      (s.dialog.cancelBtn.listeners.click || []).forEach((fn) => fn());
      assert.equal(overlay.removed, true, 'overlay should close on cancel');
      assert.equal(s.fetchLog.length, 0);
      const stored = s.ctx.run(`localStorage.getItem('protoclaw:ph-browsing-target:programming-helper')`);
      assert.equal(stored, null);
    });
  });

  it('默认当前目录：radio 预选 current、提交携带当前目录路径', async () => {
    await withSetup(base, async (s) => {
      await s.phActions.phOpenNewProjectDialog();
      const overlayHtml = s.dialog.created[1].innerHTML;
      assert.match(overlayHtml, /value="current" checked/, 'current directory is the default selection');
      assert.match(overlayHtml, /D:\/shared/);
      s.dialog.nameInput.value = 'In Current';
      Object.assign(s.dialog.modeRadio, { value: 'current', checked: true });
      const job = s.dialog.form.listeners.submit[0]({ preventDefault() {} });
      const createReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/project_create'));
      assert.ok(createReq, 'create request fired');
      assert.equal(JSON.parse(createReq.opts.body).workDirectory, 'D:/shared');
      await resolve(s.requests.at(-1), { ok: false, error: 'stop here' });
      await job;
    });
  });

  it('托管显式选择：无 workDirectory 键、创建后进入空项目（不建会话）、双选择器同步', async () => {
    await withSetup(base, async (s) => {
      await s.phActions.phOpenNewProjectDialog();
      s.dialog.nameInput.value = 'Managed';
      Object.assign(s.dialog.modeRadio, { value: 'managed', checked: true });
      const submit = s.dialog.form.listeners.submit[0];
      const job = submit({ preventDefault() {} });
      const createReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/project_create'));
      assert.ok(createReq, 'create request fired');
      const body = JSON.parse(createReq.opts.body);
      assert.equal(body.name, 'Managed');
      assert.equal(body.workDirectory, undefined, 'managed creation omits workDirectory');
      await resolve(s.requests.at(-1), { ok: true, project: { id: 'prj_new', name: 'Managed', workDirectory: 'D:/managed/prj_new' } });
      // 实体刷新
      const listReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/projects'));
      assert.ok(listReq, 'entities refresh fired');
      await resolve(s.requests.at(-1), { ok: true, projects: [
        { id: 'prj_new', name: 'Managed', workDirectory: 'D:/managed/prj_new', directorySource: 'managed', createdAt: '2026-10-23', updatedAt: '2026-10-23' },
        ...entities,
      ] });
      // 空项目切片
      const sliceReq = s.fetchLog.filter((f) => f.url.includes('/protoclaw/prebuilt_sessions')).at(-1);
      assert.ok(sliceReq && sliceReq.url.includes('projectId=prj_new'));
      assert.ok(!s.fetchLog.some((f) => f.url.includes('create_session')), 'creation itself must not open a session');
      await resolve(s.requests.at(-1), { sessions: [], sessionProjectId: 'prj_new', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 });
      await job;
      const stored = s.ctx.run(`localStorage.getItem('protoclaw:ph-browsing-target:programming-helper')`);
      assert.equal(JSON.parse(stored).id, 'prj_new');
      // 空项目可见 + 双选择器同步（左=托管目录，右=Managed 项目 active）
      const html = s.render();
      assert.match(html, /还没有对话/);
      assert.match(html, /ph-dir-item active" data-dir-id="dir:d:\/managed\/prj_new"/);
      assert.match(html, /ph-org-item active" data-project-id="prj_new"/);
      const action = /data-workspace-action="([^"]+)"/.exec(html)[1];
      const parsed = JSON.parse(action.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      assert.equal(parsed.projectId, 'prj_new');
    });
  });

  it('其他目录（浏览）：选后 radio 联动、提交携带浏览路径', async () => {
    await withSetup(base, async (s) => {
      await s.phActions.phOpenNewProjectDialog();
      s.dialog.nameInput.value = 'External';
      s.setInvokeResult({ path: 'E:/ext' });
      await (s.dialog.browse.listeners.click[0])();
      assert.deepEqual(s.invokeCalls, ['select_directory']);
      assert.equal(s.dialog.browseRadio.checked, true, 'browse radio auto-selects after picking a directory');
      assert.equal(s.dialog.browsePathEl.textContent, 'E:/ext');
      Object.assign(s.dialog.modeRadio, { value: 'browse', checked: true });
      const job = s.dialog.form.listeners.submit[0]({ preventDefault() {} });
      const createReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/project_create'));
      assert.equal(JSON.parse(createReq.opts.body).workDirectory, 'E:/ext');
      await resolve(s.requests.at(-1), { ok: false, error: 'stop here' });
      await job;
    });
  });

  it('browse 模式未选路径：本地校验，不发请求', async () => {
    await withSetup(base, async (s) => {
      await s.phActions.phOpenNewProjectDialog();
      s.dialog.nameInput.value = 'X';
      Object.assign(s.dialog.modeRadio, { value: 'browse', checked: true });
      await s.dialog.form.listeners.submit[0]({ preventDefault() {} });
      assert.ok(!s.fetchLog.some((f) => f.url.includes('project_create')));
      assert.equal(s.dialog.errorEl.hidden, false);
    });
  });

  it('无当前目录：不预选任何路径、未显式选择时拒绝提交（不无声指定）', async () => {
    await withSetup({ entities: [], phProjects: [], openDirectory: '' }, async (s) => {
      await s.phActions.phOpenNewProjectDialog();
      const overlayHtml = s.dialog.created[1].innerHTML;
      assert.doesNotMatch(overlayHtml, /value="current"/, 'no current-directory option without a current directory');
      s.dialog.nameInput.value = 'Nowhere';
      Object.assign(s.dialog.modeRadio, { value: '', checked: false });
      await s.dialog.form.listeners.submit[0]({ preventDefault() {} });
      assert.ok(!s.fetchLog.some((f) => f.url.includes('project_create')), 'must not silently pick another path');
      assert.equal(s.dialog.errorEl.hidden, false);
    });
  });

  it('名称为空：本地校验，不发请求', async () => {
    await withSetup(base, async (s) => {
      await s.phActions.phOpenNewProjectDialog();
      s.dialog.nameInput.value = '  ';
      await s.dialog.form.listeners.submit[0]({ preventDefault() {} });
      assert.ok(!s.fetchLog.some((f) => f.url.includes('project_create')));
      assert.equal(s.dialog.errorEl.hidden, false);
    });
  });
});

describe('双选择器 — 名称相同 ID 独立', () => {
  it('两个同名项目（不同目录）：左树各挂各目录、右归属只列当前目录者、切换按 ID 拉切片、持久化 ID', async () => {
    const entities = [
      { id: 'prj_1', name: 'Same', workDirectory: 'D:/x', createdAt: '2026-10-01', updatedAt: '2026-10-01' },
      { id: 'prj_2', name: 'Same', workDirectory: 'D:/y', createdAt: '2026-10-01', updatedAt: '2026-10-01' },
    ];
    await withSetup({ entities, phProjects: [{ openDirectory: 'D:/x' }, { openDirectory: 'D:/y' }], openDirectory: 'D:/x' }, async (s) => {
      const html = s.render();
      // 左树：两个目录行，各带一个同名项目（子菜单块渲染在目录行之后，
      // 块终点取下一个子菜单块而非目录行；目录顺序由稳定排序决定）
      const dirSeg = html.slice(0, html.indexOf('ph-org-selector'));
      const xStart = dirSeg.indexOf('data-subprojects-for="dir:d:/x"');
      const xNext = dirSeg.indexOf('data-subprojects-for="', xStart + 1);
      const subX = dirSeg.slice(xStart, xNext < 0 ? undefined : xNext);
      assert.ok(xStart >= 0);
      assert.match(subX, /ph-dir-sub-default/);
      assert.match(subX, /data-project-id="prj_1"/);
      assert.doesNotMatch(subX, /prj_2/);
      // 右归属（当前目录 x）：只列 prj_1
      const orgSeg = html.slice(html.indexOf('ph-org-selector'));
      assert.match(orgSeg, /data-project-id="prj_1"/);
      assert.doesNotMatch(orgSeg, /prj_2/);
      const switched = s.ctx.run('window.phSwitchProject("prj_2")');
      await flush();
      // prj_2 跨目录（D:/y，registry）：先目录位置跟随，再项目切片
      const switchReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/switch'));
      assert.ok(switchReq, 'cross-dir project switches the workspace directory first');
      assert.deepEqual(JSON.parse(switchReq.opts.body), { agentId: 'programming-helper', projectId: 'dir:d:/y' });
      await resolve(s.requests[0], { state: { openDirectory: 'D:/y', phProjects: [{ openDirectory: 'D:/x' }, { openDirectory: 'D:/y' }] } });
      const req = s.fetchLog.filter((f) => f.url.includes('/protoclaw/prebuilt_sessions')).at(-1);
      assert.match(req.url, /projectId=prj_2/);
      await resolve(s.requests.at(-1), { sessions: [], sessionProjectId: 'prj_2', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 });
      await switched;
      const stored = s.ctx.run(`localStorage.getItem('protoclaw:ph-browsing-target:programming-helper')`);
      assert.equal(JSON.parse(stored).id, 'prj_2');
    });
  });
});

describe('045 — 轮询归属随 typed target（不被 workspace_state 漂移覆盖）', () => {
  /** 轮询取数夹具：真实 app-main 的 createPollMaintenanceHost + 真实 poll-maintenance。 */
  async function withPollSetup({ entities = [], target = null, openDirectory = '' } = {}, probe) {
    const agent = {
      id: 'programming-helper',
      source: 'prebuilt',
      workspace_sessions: { sessions: [{ id: 's1', updatedAt: '2026-10-20T00:00:00Z' }], sessionTotal: 1 },
      workspace_state: null,
    };
    const workspaceState = { openDirectory, phProjects: openDirectory ? [{ openDirectory }] : [] };
    agent.workspace_state = workspaceState;
    const fetchLog = [];
    return withP2EsmCase({
      classic: (sandbox) => {
        sandbox.ResizeObserver = ResizeObserverStub;
        sandbox.URLSearchParams = URLSearchParams;
        sandbox.marked = marked;
        sandbox.run(`
          window.__clawAuthReady = new Promise(() => {});
          applyLanguage = () => {};
          applyTheme = () => {};
        `);
        for (const file of CLASSIC_STACK) sandbox.loadSource(file);
        // 装载后再装宿主面（app-core 的 classic 实现装载期占用同名属性）
        sandbox.allAgents = [agent];
        sandbox.fetch = (url) => {
          const target2 = String(url);
          fetchLog.push(target2);
          if (target2.includes('/protoclaw/ph_project/projects')) {
            return Promise.resolve({
              ok: true, status: 200,
              json: async () => ({ projects: entities }),
              text: async () => JSON.stringify({ projects: entities }),
            });
          }
          return Promise.resolve({ ok: false });
        };
      },
    }, async (c) => {
      const ctx = c.sandbox;
      await c.load('public/src/modules/agent-data-loader.js');
      const projectData = await c.load('public/src/modules/project-data.js');
      const store = ctx.window.ClawFW.phProjectEntities;
      store.projects = [];
      store.loaded = false;
      await projectData.ensurePhProjectEntitiesLoaded(true);
      fetchLog.length = 0;
      if (target) projectData.setPhBrowsingTarget('programming-helper', target);
      Object.assign(ctx, createPollMaintenance(ctx.run('createPollMaintenanceHost()')));
      ctx.__agent = agent;
      return probe({ ctx, fetchLog, workspaceState });
    });
  }

  it('项目目标：projectId 参数；openDirectory 漂移不改变归属', async () => {
    await withPollSetup({
      entities: [{ id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared' }],
      target: { type: 'project', id: 'prj_A' },
      openDirectory: 'D:/shared',
    }, async (s) => {
      await s.ctx.run('fetchWorkspaceSessionsForPoll("programming-helper", __agent)');
      assert.match(s.fetchLog[0], /projectId=prj_A/);
      assert.doesNotMatch(s.fetchLog[0], /projectDir=/);
      // 模拟 workspace_state.openDirectory 被轮询刷成别的目录（目录漂移）
      s.fetchLog.length = 0;
      s.workspaceState.openDirectory = 'D:/drifted';
      s.workspaceState.phProjects = [{ openDirectory: 'D:/drifted' }];
      await s.ctx.run('fetchWorkspaceSessionsForPoll("programming-helper", __agent)');
      assert.match(s.fetchLog[0], /projectId=prj_A/, 'typed target wins over drifted openDirectory');
      assert.doesNotMatch(s.fetchLog[0], /projectDir=/);
    });
  });

  it('目录目标与无目标回退：projectDir 语义保持', async () => {
    await withPollSetup({ target: { type: 'dir', id: 'dir:d:/alpha' }, openDirectory: 'D:/alpha' }, async (s) => {
      await s.ctx.run('fetchWorkspaceSessionsForPoll("programming-helper", __agent)');
      assert.match(s.fetchLog[0], /projectDir=D%3A%2Falpha/);
    });
    await withPollSetup({ openDirectory: 'D:/beta' }, async (s2) => {
      await s2.ctx.run('fetchWorkspaceSessionsForPoll("programming-helper", __agent)');
      assert.match(s2.fetchLog[0], /projectDir=D%3A%2Fbeta/);
    });
  });
});

describe('045 — 搜索归属与快速切换 stale', () => {
  const entities = [
    { id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared' },
    { id: 'prj_B', name: 'Beta', workDirectory: 'D:/shared' },
  ];

  it('项目目标搜索：请求携带 projectId（互斥）；身份漂移后旧响应不落地', async () => {
    await withSetup({ entities, phProjects: [{ openDirectory: 'D:/shared' }], openDirectory: 'D:/shared' }, async (s) => {
      // 项目 A 搜索面（dataset 由渲染写入真实 DOM；沙箱内直接设置等价状态）
      Object.assign(s.tabsRoot.dataset, { searchProjectId: 'prj_A', searchDirectory: '' });
      s.phSessionList.phOnSearchInput('needle');
      const reqA = s.fetchLog.find((f) => f.url.includes('/protoclaw/search_sessions'));
      assert.ok(reqA, 'search fired');
      assert.match(reqA.url, /projectId=prj_A/);
      assert.doesNotMatch(reqA.url, /openDirectory=/);
      // 快速切换到项目 B（身份漂移）：B 搜索先发出，A 的旧响应后到 → 拒绝
      Object.assign(s.tabsRoot.dataset, { searchProjectId: 'prj_B' });
      s.phSessionList.phOnSearchInput('needle');
      const reqB = s.fetchLog.filter((f) => f.url.includes('/protoclaw/search_sessions')).at(-1);
      assert.match(reqB.url, /projectId=prj_B/);
      const results = s.requests.filter((r) => r.url.includes('/protoclaw/search_sessions'));
      await resolve(results[1], { results: [{ sessionId: 'rB', title: 'B hit', updatedAt: '2026-10-22', matchCount: 1, matches: [] }], total: 1 });
      await resolve(results[0], { results: [{ sessionId: 'rA', title: 'A hit', updatedAt: '2026-10-22', matchCount: 1, matches: [] }], total: 1 });
      const ids = s.phSearch.results.map((r) => r.sessionId);
      assert.deepEqual(ids, ['rB'], 'stale project-A response must not land');
    });
  });

  it('目录目标搜索：openDirectory 参数、无 projectId', async () => {
    await withSetup({ phProjects: [{ openDirectory: 'D:/alpha' }], openDirectory: 'D:/alpha' }, async (s) => {
      Object.assign(s.tabsRoot.dataset, { searchProjectId: '', searchDirectory: 'D:/alpha' });
      s.phSessionList.phOnSearchInput('needle');
      const req = s.fetchLog.find((f) => f.url.includes('/protoclaw/search_sessions'));
      assert.match(req.url, /openDirectory=D%3A%2Falpha/);
      assert.doesNotMatch(req.url, /projectId=/);
    });
  });
});

describe('045 — 恢复卡片按完整归属过滤（static/source contract）', () => {
  // 覆盖差异（如实记录）：卡片加载器在产品现状下整体停用
  // （session-ui 的 PH_OPEN_SESSIONS_CARD_DISABLED 恒 true），它是模块私有常量，
  // 生产上没有可注入的 seam（不得为测试加导出/关停用/源码 patch 伪造运行）。
  // 因此下面两个用例是**静态源码契约**：只钉住过滤表达式的真实边界（项目目标
  // 按稳定 projectId 精确匹配；目录目标按目录匹配并显式排除项目会话），
  // 运行时过滤 / 去重 / 挂载 / 派发行为覆盖已丢失，不等强、不冒充行为。
  it('项目目标：只显示本项目的未关闭会话（source contract — 运行时过滤覆盖已丢失）', () => {
    assert.match(sessionUiSource, /const projectId = String\(targetProjectId \|\| ''\);/);
    assert.match(sessionUiSource, /projectId\.startsWith\('prj_'\)/);
    assert.match(sessionUiSource, /allOpen\.filter\(\(s\) => String\(s\.projectId \|\| ''\) === projectId\)/,
      '[static contract] 项目目标按 projectId 精确匹配');
  });

  it('目录目标：只显示目录会话，项目会话（同 workDirectory）排除（source contract — 运行时过滤覆盖已丢失）', () => {
    assert.match(sessionUiSource, /if \(String\(s\.projectId \|\| ''\)\.startsWith\('prj_'\)\) return false;/,
      '[static contract] 目录目标排除项目会话（即使同目录）');
    assert.match(sessionUiSource, /const sDir = String\(s\.openDirectory \|\| ''\)\.replace\(\/\\\\\/g, '\/'\)\.toLowerCase\(\);/);
    assert.match(sessionUiSource, /return sDir === normDir;/);
  });

  it('当前停用态实证：公开 phLoadOpenSessionsCard 零请求、不挂 DOM', async () => {
    // 停用是可观测的产品现状：公开入口（真实命名导出）在停用位为真时立即返回，
    // 既不发 /protoclaw/open_sessions，也不创建/挂载任何卡片 DOM。这条用例证明
    // 「运行时行为不可测」不是夹具缺陷，而是产品开关本身。
    await withSetup({
      entities: [{ id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared', createdAt: '2026-10-01', updatedAt: '2026-10-02' }],
      openDirectory: 'D:/shared',
      phProjects: [{ openDirectory: 'D:/shared' }],
      sessionsMeta: { sessions: [], sessionProjectId: '', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 },
    }, async (s) => {
      assert.equal(typeof s.sessionUi.phLoadOpenSessionsCard, 'function', '公开入口存在');
      const fetchBefore = s.fetchLog.length;
      const createdBefore = s.dialog.created.length;
      await s.sessionUi.phLoadOpenSessionsCard('programming-helper', 'D:/shared', 'prj_A');
      assert.equal(s.fetchLog.length, fetchBefore, '停用态不发 open_sessions 请求');
      assert.deepEqual(s.fetchLog.filter((f) => f.url.includes('/protoclaw/open_sessions')), [], '无 open_sessions 请求');
      assert.equal(s.dialog.created.length, createdBefore, '停用态不创建卡片 DOM');
      assert.equal(s.openContainer.innerHTML, '', '恢复卡片容器保持空');
    });
  });
});
