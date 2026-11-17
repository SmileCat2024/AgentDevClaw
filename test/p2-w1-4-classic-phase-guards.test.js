/**
 * P2 W1-4 首屏（classic 相）调用守卫证据。
 *
 * 迁移前两个首屏触点都来自 classic 顶层同步渲染链：
 *   - app-main 顶层 `applyLanguage()` → `renderCurrentMainView()` → 欢迎态
 *     → app-core `getEmptyStateHtml()` 读 `window.ClawFW.workspaceAgents`；
 *   - `renderCurrentMainView()` 第一条语句即以 `typeof` 守卫调用
 *     `window.updateReadOnlySessionIndicator`（app-ui.js:1293-1296）。
 *
 * 本文件用 withP2EsmCase 复刻「先跑 classic 链、再真实 import ESM 模块」的
 * 时相：断言 classic 相里 namespace / 函数确实不存在且首屏输出为通用标题，
 * 而不是先装模块再拿空状态反推时序。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const metadata = {
  id: 'programming-helper',
  name: '工作空间',
  defaultAgentId: 'main',
  agents: [
    { id: 'main', displayName: '编程小助手' },
    { id: 'reviewer', displayName: { zh: '审查助手', en: 'Reviewer' } },
  ],
  workspace_sessions: { sessions: [{ id: 's2', workspaceAgentId: 'reviewer' }] },
};

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[m]));

/** classic 宿主适配面（装载期由 ESM 宿主经 window.createXHost() 取用）。 */
function hostGlobals() {
  return {
    escapeHtml,
    addEventListener() {},
    removeEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
    ClawFW: { actions: { registerMany() {} } },
    AgentLoaderHost: { loadedAgentDetailIds: new Set() },
    createSessionViewCommitHost: () => ({
      identity: () => null, read: () => ({}), apply() {}, normalizeModel: (value) => value || {},
    }),
    createRuntimeViewCacheHost: () => ({
      cache: new Map(), capacity: 20, contextKey: (runtimeId) => `ctx:${runtimeId}`,
      readView: () => ({}), signatures: () => ({}), todoSignature: (plan) => JSON.stringify(plan || {}),
      emptyTodo: () => ({}), followLatest: () => false, captureAnchor: () => null, scrollTop: () => 0,
      activeCollapseContext: () => '', forgetContext() {}, activateCollapse() {},
      normalizeIdentity: (identity) => identity, patch() {}, setRestoredScrollTop() {},
      restoreAnchor() {}, updatePlanBadge() {},
    }),
  };
}

test('首屏欢迎名：classic 相 namespace 尚不存在，首屏文案是通用标题', async () => {
  await withP2EsmCase({
    label: 'welcome-name-classic-phase',
    classic: (sandbox) => {
      // 真实先行脚本序（test/p2-classic-hosts.js）：宿主工厂都是生产实现，
      // 首屏 boot 与周期排程由基座关掉。
      prepareClassicSandbox(sandbox);
    },
    globals: hostGlobals(),
  }, async (c) => {
    // ── classic 相（ESM 未执行）──
    assert.equal(c.read('typeof window.ClawFW.workspaceAgents'), 'undefined', 'namespace 在 classic 相不存在');
    c.read(`allAgents = ${JSON.stringify([metadata])};
      focusedAgentId = 'programming-helper';
      applySessionViewPatch({ identity: { agentId: 'programming-helper', sessionId: 's2' } });`);
    const classicTitle = c.read('getEmptyStateHtml()');
    assert.doesNotMatch(classicTitle, /欢迎使用/, 'classic 相首屏没有 Agent 名（标题目录为空且详情桥未装载）');
    assert.match(classicTitle, /新对话/);

    // ── 模块执行后（同一 classic 函数、同一 state，经桥吸收 classic 相写入）──
    await c.load('public/src/modules/agent-store-state.js');
    await c.load('public/src/modules/workspace-agents.js');
    assert.equal(c.read('typeof window.ClawFW.workspaceAgents.getWelcomeName'), 'function');
    assert.match(c.read('getEmptyStateHtml()'), /欢迎使用 审查助手/, '模块就绪后首屏读到绑定 Agent');
  });
});

test('只读指示器：classic 相守卫跳过，模块就绪后同一定义存在且无目标时仍为 no-op', async () => {
  const insertions = [];
  const lookups = [];
  const anchor = { parentElement: { insertBefore(el) { insertions.push(el); } } };
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id, style: {}, dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
        querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
        setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
        insertBefore() {}, innerHTML: '', textContent: '', value: '',
        checked: false, disabled: false, scrollTop: 0, scrollHeight: 0, offsetHeight: 0,
        focus() {}, blur() {}, remove() {}, parentNode: null,
      });
    }
    return elements.get(id);
  };
  const documentStub = {
    getElementById(id) {
      lookups.push(id);
      return id === 'chat-context-bar' ? anchor : element(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement: () => element(`created-${elements.size}`),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {},
    removeEventListener() {},
    body: element('body'),
    head: element('head'),
    documentElement: element('documentElement'),
    readyState: 'complete',
    activeElement: null,
    hidden: false,
  };

  await withP2EsmCase({
    label: 'readonly-indicator-classic-phase',
    classic: (sandbox) => {
      // 真实先行脚本序（test/p2-classic-hosts.js）：宿主工厂都是生产实现，
      // 首屏 boot 与周期排程由基座关掉。
      prepareClassicSandbox(sandbox);
    },
    globals: { ...hostGlobals(), document: documentStub },
  }, async (c) => {
    // ── classic 相：真实调用点（app-ui renderCurrentMainView 的第一条语句）──
    assert.equal(c.read('typeof window.updateReadOnlySessionIndicator'), 'undefined');
    const guard = "typeof window.updateReadOnlySessionIndicator === 'function'"
      + " ? window.updateReadOnlySessionIndicator() : 'skipped'";
    assert.equal(c.read(guard), 'skipped', 'classic 相守卫落到跳过分支');
    assert.equal(insertions.length, 0, 'classic 相不产生指示器节点');

    // ── 模块执行后：同一定义存在；无冻结目标时仍是 no-op ──
    await c.load('public/src/modules/session-readonly-view.js');
    assert.equal(c.read('typeof window.updateReadOnlySessionIndicator'), 'function');
    assert.notEqual(c.read(guard), 'skipped', '模块就绪后守卫调用真实实现');
    assert.equal(insertions.length, 0, '没有冻结目标时两种时相都不插入指示器');
    assert.equal(lookups.filter((id) => id === 'chat-context-bar').length, 1, '仅锚点查询，无插入');
  });
});
