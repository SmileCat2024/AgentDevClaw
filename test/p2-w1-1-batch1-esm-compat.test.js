/**
 * P2 第一波批次 1（独立弹层与导航）——ESM 化后的真实行为与兼容面。
 *
 * 覆盖 6 个原位 ESM 化的模块：
 *   claw-select / navigation-core / conversation-export-dialog /
 *   proxy-overlay / runtime-mode-menu / session-reference-picker
 *
 * 装载路线：test/helpers/esm-module-loader.js 的真实 import + window/document
 * 桩（批次默认路线）。模块的全局裸引用面是 window/document/Node/MutationObserver，
 * 全在桩面内；除 proxy-overlay 的桥键注册（defineKey 唯一注册制，只能装载一次）
 * 外，每个用例重新 import 拿全新模块实例。
 *
 * 兼容面断言固定“既有 window 命名空间协议不变 + 私有 helper 不上桥 + 状态
 * 收敛为模块私有”三件事，防止迁移把临时兼容面固化成新的全局债务。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

const MODULES = {
  clawSelect: 'public/src/modules/claw-select.js',
  navigationCore: 'public/src/modules/navigation-core.js',
  conversationExportDialog: 'public/src/modules/conversation-export-dialog.js',
  proxyOverlay: 'public/src/modules/proxy-overlay.js',
  runtimeModeMenu: 'public/src/modules/runtime-mode-menu.js',
  sessionReferencePicker: 'public/src/modules/session-reference-picker.js',
};

/** document.addEventListener 的注册顺序（模块顶层注册时相的可观察痕迹）。 */
let documentListeners = [];
let cleanupGlobals;
let proxyOverlayModule; // defineKey 唯一注册制：桥键模块全文件只装载一次

before(async () => {
  cleanupGlobals = installBrowserStubs({
    window: {
      // vendor 面：markdown-utils 在求值期 new Renderer() 并 setOptions，
      // escapeHtml 已是它自己的实现（原 classic bootstrap 并入）。
      marked: { parse: () => '', setOptions() {}, use() {}, Renderer: class {} },
      // action-dispatcher 的注册表（markdown-utils / proxy-overlay /
      // session-reference-picker 顶层 registerMany）
      ClawFW: { actions: { registerMany() {} } },
    },
    document: {
      addEventListener(type) { documentListeners.push(type); },
      removeEventListener() {},
      querySelectorAll() { return []; },
    },
  });
  await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
  // classic 相注册、ESM 相 claim 的两个状态域键（本批 import 链的真实依赖）
  window.KernelState.defineKey('orchestration', 'currentRuntimeAgentId', null);
  window.KernelState.defineKey('i18n-environment', 'currentLanguage', 'zh');
  window.KernelState.defineKey('i18n-environment', 'currentTheme', 'dark');
  proxyOverlayModule = (await loadModuleOnce(MODULES.proxyOverlay, { installGlobals: false })).module;
});

after(() => {
  cleanupGlobals();
});

/** 装载一个模块并返回 { module, listenerTypes }（本次装载新增的 document 监听）。 */
async function load(relativePath) {
  const start = documentListeners.length;
  const { module } = await loadModuleOnce(relativePath, { installGlobals: false });
  return { module, listenerTypes: documentListeners.slice(start) };
}

// ── claw-select ────────────────────────────────────────────────────

test('claw-select：命名导出与 window.ClawSelect 命名空间是同一组实现', async () => {
  const { module } = await load(MODULES.clawSelect);
  assert.equal(typeof module.enhance, 'function');
  assert.equal(typeof module.enhanceAll, 'function');
  assert.equal(typeof module.closeAll, 'function');
  assert.equal(window.ClawSelect.enhance, module.enhance);
  assert.equal(window.ClawSelect.enhanceAll, module.enhanceAll);
  assert.equal(window.ClawSelect.closeAll, module.closeAll);
  // 内部状态（_openCtx）与 escapeHtml 副本不上全局：私有 helper 不造桥
  assert.equal('_openCtx' in window, false);
});

test('claw-select：enhance 只接管原生 select 且幂等（既有增强语义不变）', async () => {
  const { module } = await load(MODULES.clawSelect);
  assert.equal(module.enhance(null), null);
  assert.equal(module.enhance({ tagName: 'DIV', dataset: {} }), null);

  const inserted = [];
  const select = {
    tagName: 'SELECT',
    dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    options: [],
    selectedIndex: -1,
    disabled: false,
    parentNode: { insertBefore(wrapper) { inserted.push(wrapper); } },
    getAttribute() { return null; },
    removeAttribute() {},
    addEventListener() {},
    dispatchEvent() {},
  };
  const wrapper = module.enhance(select);
  assert.equal(wrapper?.className, 'claw-select');
  assert.equal(select.dataset.clawEnhanced, 'true');
  assert.equal(inserted.length, 1, 'wrapper 必须插在原生 select 之前');
  // 二次增强是空操作（幂等）
  assert.equal(module.enhance(select), null);
});

// ── conversation-export-dialog ─────────────────────────────────────

test('conversation-export-dialog：window 属性协议指向命名导出，缺参数时不开弹层', async () => {
  const { module } = await load(MODULES.conversationExportDialog);
  assert.equal(typeof module.openConversationExportDialog, 'function');
  assert.equal(window.openConversationExportDialog, module.openConversationExportDialog);

  // 原守卫：agentId / sessionId 任一为空直接返回（DOM 不动）
  assert.equal(module.openConversationExportDialog({ agentId: 'a' }), undefined);
  assert.equal(module.openConversationExportDialog({ sessionId: 's' }), undefined);
  assert.equal(module.openConversationExportDialog(), undefined);
  // 模块私有状态与 helper 不上全局
  assert.equal('_overlay' in window, false);
  assert.equal('_runExport' in window, false);
});

// ── proxy-overlay ──────────────────────────────────────────────────

test('proxy-overlay：openProxySettings 走桥键（classic 裸调用可用）且状态收敛为模块私有', () => {
  assert.equal(typeof window.openProxySettings, 'function');
  assert.equal(window.openProxySettings, proxyOverlayModule.openProxySettings);
  // classic 消费方 app-ui.js 的设置菜单按钮以裸标识符调用 → 桥键必须可写回
  const replacement = function replacementProbe() {};
  const original = window.openProxySettings;
  try {
    window.openProxySettings = replacement;
    assert.equal(window.openProxySettings, replacement, 'claim 后 classic 写方必须经 impl.set 转发');
  } finally {
    window.openProxySettings = original;
  }
  // 私有 helper 与面板数据不造桥
  assert.equal('closeProxySettings' in window, false);
  assert.equal('renderProxyOverlay' in window, false);
  assert.equal('_proxyData' in window, false);
});

// ── runtime-mode-menu ──────────────────────────────────────────────

test('runtime-mode-menu：顶层委托监听在模块执行时注册（无全局暴露）', async () => {
  const { module, listenerTypes } = await load(MODULES.runtimeModeMenu);
  assert.deepEqual(Object.keys(module), [], '本模块无跨文件键，不应新增导出面');
  for (const type of ['pointerover', 'pointerout', 'pointerdown']) {
    assert.ok(listenerTypes.includes(type), `document 上必须注册 ${type} 委托`);
  }
  // 原文件本来就是 IIFE 私有实现（台账无该文件），迁移不改暴露面
  assert.equal('OPEN_DELAY_MS' in window, false);
});

// ── session-reference-picker ───────────────────────────────────────

test('session-reference-picker：命名导出与 window.SessionReference 成员一一对应，状态不上全局', async () => {
  const { module, listenerTypes } = await load(MODULES.sessionReferencePicker);
  const api = window.SessionReference;
  assert.equal(api.add, module.addSessionReference);
  assert.equal(api.addToTarget, module.addSessionReferenceToTarget);
  assert.equal(api.remove, module.removeSessionReference);
  assert.equal(api.clear, module.clearSessionReferences);
  assert.equal(api.consume, module.consumeSessionReferences);
  assert.equal(api.restore, module.restoreSessionReferences);
  assert.equal(api.peek, module.peekSessionReferences);
  assert.equal(api.chipsHtml, module.sessionReferenceChipsHtml);
  assert.equal(api.openPicker, module.openSessionReferencePicker);
  assert.equal(api.buildTurnMetadata, module.buildTurnMetadata);
  assert.equal(api.setDragSource, module.setDragSource);
  assert.equal(api.activeKey, module.activeKey);
  assert.equal(api.notify, module.notify);
  assert.equal(api.MIME, module.SESSION_REF_MIME);

  // 引用桶 / 拖拽源 / 弹窗句柄全部收敛为模块私有：零桥键
  for (const key of ['_sessionReferences', '_lastKnownRefKey', '_pickerEl',
    '_dragSourceEntry', 'SESSION_REF_MIME', 'addSessionReference']) {
    assert.equal(key in window, false, `${key} 不应再是全局键`);
  }
  // 拖拽投放的四类 document 委托在模块执行时注册
  for (const type of ['dragover', 'dragleave', 'dragend', 'drop']) {
    assert.ok(listenerTypes.includes(type), `document 上必须注册 ${type} 委托`);
  }
});

test('session-reference-picker：引用按 (runtimeId, sessionId) 分桶，consume / restore 语义不变', async () => {
  const { module } = await load(MODULES.sessionReferencePicker);
  window.getRuntimeWorkspaceSessionId = (runtimeId) => `${runtimeId}-session`;
  try {
    window.currentRuntimeAgentId = 'rt-alpha'; // 经 orchestration 桥键 → 域模块状态
    assert.equal(module.addSessionReference({ agentId: 'programming-helper', sessionId: 's-1', title: '甲' }), true);
    // 重复挂同一会话：返回值仍是 true（原语义），但桶内不重复
    assert.equal(module.addSessionReference({ agentId: 'programming-helper', sessionId: 's-1' }), true);
    assert.deepEqual(module.peekSessionReferences().map((r) => r.sessionId), ['s-1']);

    // 切到另一个 runtime：桶隔离（会话 A 的引用不被会话 B 看到）
    window.currentRuntimeAgentId = 'rt-beta';
    assert.deepEqual(module.peekSessionReferences(), []);

    // 切回：pill 状态恢复，consume 取走并清空
    window.currentRuntimeAgentId = 'rt-alpha';
    const consumed = module.consumeSessionReferences();
    assert.equal(consumed.length, 1);
    assert.deepEqual(module.peekSessionReferences(), []);
    // 发送失败归还
    module.restoreSessionReferences(consumed);
    assert.deepEqual(module.peekSessionReferences().map((r) => r.sessionId), ['s-1']);
    // user-turn metadata 片段来自同一桶
    assert.deepEqual(module.buildTurnMetadata(), {
      'session-reference': [{ agentId: 'programming-helper', sessionId: 's-1', sessionType: 'main', title: '甲' }],
    });
    module.clearSessionReferences();
    assert.deepEqual(module.peekSessionReferences(), []);
  } finally {
    delete window.getRuntimeWorkspaceSessionId;
    window.currentRuntimeAgentId = null;
  }
});

test('session-reference-picker：当前会话不能引用自身（身份判定经 classic 解析函数）', async () => {
  const { module } = await load(MODULES.sessionReferencePicker);
  window.getRuntimeWorkspaceSessionId = (runtimeId) => `${runtimeId}-session`;
  window.getCurrentHostAgentRecord = () => ({ id: 'programming-helper' });
  // toast 是同一对象（toast-notify 的 window.ClawToast 就是模块导出），
  // 这里只拦渲染，保留「自身引用给 warning 提示」的调用契约。
  const toastCalls = [];
  const originalShow = window.ClawToast.show;
  window.ClawToast.show = (opts) => { toastCalls.push(opts); };
  try {
    window.currentRuntimeAgentId = 'rt-self';
    assert.equal(
      module.addSessionReference({ agentId: 'programming-helper', sessionId: 'rt-self-session' }),
      false,
      '自身引用必须被拦截',
    );
    assert.deepEqual(module.peekSessionReferences(), []);
    assert.equal(toastCalls.length, 1, '自身引用要给一次 warning 提示');
    assert.equal(toastCalls[0].id, 'session-ref-self');
    assert.equal(toastCalls[0].status, 'warning');
    // 其他会话可正常引用
    assert.equal(
      module.addSessionReference({ agentId: 'programming-helper', sessionId: 'other-session' }),
      true,
    );
    // pill HTML 只要非空即可（escapeHtml 经 markdown-utils 的真实导出）
    assert.match(module.sessionReferenceChipsHtml(), /session-ref-chip/);
    module.clearSessionReferences();
  } finally {
    window.ClawToast.show = originalShow;
    delete window.getRuntimeWorkspaceSessionId;
    delete window.getCurrentHostAgentRecord;
    window.currentRuntimeAgentId = null;
  }
});
