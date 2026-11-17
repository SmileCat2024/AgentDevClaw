/**
 * P2 第二波 2 —— 保留 classic 的两个模块的「经典相同轮次」证据。
 *
 * 本批把 desktop-notify / generative-ui-panel 保留为唯一 classic 实现（不计入
 * 迁移完成面），理由是 ESM 模块执行相晚于全部 classic 脚本：
 *   - desktop-notify：桌面壳 WebView2 `window.eval` 的原生 toast 激活入口
 *     （desktop/src/main.rs on_activated）必须在经典相同轮次可投递，否则
 *     「旧 toast 未过期 + 页面 reload 未完成」的竞态窗口会比经典形态更宽；
 *   - generative-ui-panel：rail 面板注册必须先于 app-main 顶层
 *     applyLanguage → renderCurrentMainView 的首次 syncRailButtons。
 *
 * 本文件用 classic 沙箱（frontend-vm）钉住这些模块**在装载的同一同步轮次内**
 * 完成注册/可投递：测试体内不出现 await、不排空微任务，因此断言成立即证明
 * 入口不依赖任何延迟相位。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { createDomHarness } from './helpers/dom-harness.js';

function createDocumentStub() {
  const element = () => ({
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {}, removeChild() {}, insertAdjacentHTML() {},
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, removeAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    innerHTML: '', textContent: '',
  });
  return {
    hidden: true,
    hasFocus: () => false,
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return element(); },
    createTextNode(text) { return { textContent: text }; },
    addEventListener() {},
    removeEventListener() {},
    body: element(),
    head: element(),
    documentElement: element(),
    readyState: 'complete',
  };
}

test('desktop-notify：经典装载同一轮次内壳入口就已可投递（无更宽竞态窗口）', () => {
  const record = { openTargets: [], switches: [], notifications: [], focus: 0 };
  const ctx = createFrontendSandbox({
    document: createDocumentStub(),
    Notification: Object.assign(
      function NotificationStub(title, options) {
        record.notifications.push({ title, options });
        return { close() {} };
      },
      { permission: 'granted', requestPermission: async () => 'granted' },
    ),
    // 前台心跳 Worker 的最小可构造形态（心跳只刷前台时钟）
    Worker: class WorkerStub { constructor() { this.onmessage = null; } },
    Blob: class BlobStub {},
    URL: { createObjectURL: () => 'blob:heartbeat', revokeObjectURL() {} },
    normalizeAgentIdentity: (value) => String(value || '').trim(),
    // 运行时条目（生产由 /api/agents 快照提供）：runtimeId → 会话导航目标
    allAgents: [{ id: 'memo', name: 'Memo', runtime_session_id: 'rt-a' }],
    currentRuntimeAgentId: 'rt-a',
    currentLanguage: 'zh',
    openConversationTarget: (target) => { record.openTargets.push(target); },
    switchAgent: (agentId) => { record.switches.push(agentId); },
    handlePrebuiltAgentClick: () => {},
    focus: () => { record.focus += 1; },
  });

  ctx.loadSource('public/src/modules/desktop-notify.js');

  // ── 以下全部在 loadSource 的同一同步轮次内完成：无 await、无 pending 模块 ──
  assert.equal(ctx.run('typeof window.__clawConsumeNotificationActivation'), 'function',
    '壳 eval 的激活入口在经典装载返回时即已注册');
  for (const name of ['_presentAppNotification', '_syncForegroundState',
    '_markAgentCallStartedForNotify', '_requestNotifyPermission']) {
    assert.equal(ctx.run(`typeof window.${name}`), 'function',
      `${name} 是经典顶层函数（ESM 消费方的既有 window 函数协议）`);
  }

  // 同一轮次投递：带 navPayload 的激活立即按语义导航（threadId 优先 / runtimeId 回退）
  ctx.run(`window.__clawConsumeNotificationActivation(JSON.stringify({ agentId: 'memo', threadId: 'th-1' }))`);
  // 注意：导航对象由沙箱 realm 创建，逐字段比较（跨 realm 的 deepEqual 会比原型）
  assert.equal(record.openTargets.length, 1, 'threadId 优先走会话导航');
  assert.equal(record.openTargets[0].threadId, 'th-1');
  assert.equal(record.openTargets[0].agentId, 'memo');
  assert.deepEqual(record.switches, [], 'threadId 命中时不按 runtime 切会话');

  ctx.run(`window.__clawConsumeNotificationActivation(JSON.stringify({ runtimeId: 'rt-a' }))`);
  assert.deepEqual(record.switches, ['rt-a'], '无 threadId 时按 runtimeId 切会话');
  assert.equal(record.focus, 2, '两次激活都把窗口拉到前台');

  // 呈现链同样同轮可用：reminder 帧直接产出系统通知（不经任何延迟相位）
  ctx.run(`window._presentAppNotification({ type: 'reminder', agentId: 'memo', title: 'T', body: 'B' })`);
  assert.equal(record.notifications.length, 1, '经典呈现链在装载同轮可投递');
});

test('generative-ui-panel：经典装载同一轮次内完成 rail 面板注册（首屏时点）', () => {
  const dom = createDomHarness();
  dom.createMount('gen-ui-mount');
  const ctx = createFrontendSandbox({
    document: dom.document,
    setInterval: () => 0,
    clearInterval() {},
    createGenUIViewState: () => ({}),
    renderGenUISpec: () => dom.document.createElement('div'),
    currentLanguage: 'zh',
    currentRuntimeAgentId: null,
  });

  // 生产顺序：claw-host（注册表宿主）先于面板实现
  ctx.loadSource('public/src/modules/claw-host.js');
  ctx.loadSource('public/src/modules/generative-ui-panel.js');

  // ── 同一同步轮次内即可见：注册已完成，后续 classic 顶层渲染直接能取到 ──
  assert.equal(ctx.run(`window.ClawHost.panels.has('genui')`), true,
    'genui 面板在经典装载返回时已进注册表（早于 app-main 顶层 syncRailButtons）');
  assert.equal(ctx.run(`window.ClawHost.panels.getAvailable({ surface: 'chat' }).length`), 1,
    '聊天表面立即可见该面板');
  assert.equal(ctx.run('typeof window.GenUIPanel.forceRefresh'), 'function',
    '既有 window.GenUIPanel 命名空间协议不变');
  // 注册元数据未变（rail 金样本同口径的最小复核）
  const meta = ctx.run(`window.ClawHost.panels.getAvailable({ surface: 'chat' })[0]`);
  assert.equal(meta.preserveOnReRender, true);
  assert.equal(meta.order, 50);
  assert.equal(meta.badge, true);
});
