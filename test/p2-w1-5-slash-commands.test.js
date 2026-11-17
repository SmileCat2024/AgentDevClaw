/**
 * slash-commands（/trim、/summary 静态命令清单）真实行为测试 —— P2 第 1 波批次 5。
 *
 * slash-commands 在 ESM 化后显式 import SlashMenu（装载顺序由 import 图确定，
 * 不再依赖 index.html 的 script 先后）。本文件验证：
 *   1. 装载即注册到真实 SlashMenu（命令名与应用谓词面）；
 *   2. 线程承接会话 / 手动接续 APP 的可见性谓词（ADR-0032 / ADR-0024 / ADR-0049）；
 *   3. /trim 的预览统计 → 确认 → trim_all 动作；/summary 直接走 summary 分支；
 *   4. ESM 兼容面：命令清单是命名导出，window 面没有新增散装全局。
 *
 * 依赖面：ClawToast 是 toast-notify 的具名导出（用例把真实模块对象的 show 换
 * 成记录器）；slash-menu 的静态依赖把它带进 input-actions，后者在装载期经
 * `window.createXHost()` 取 classic 相宿主——本用例不触达那些能力，用惰性空
 * 实现占位。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

const MODULE_PATH = 'public/src/modules/slash-commands.js';

let orchestration;
let i18n;
let store;
let slashMenu;
let toast;
let baseKernel;
let baseCleanup;

/** input-actions / 相关宿主的装载期 seam（生产由 classic 相提供；本用例不触达）。 */
const CLASSIC_HOST_STUBS = {
  createSessionViewCommitHost: () => ({}),
  createPollCoordinatorHost: () => ({}),
  createP2BootstrapDomHost: () => ({}),
  createCallInterruptHost: () => ({}),
  createP2BootstrapCallActivityHost: () => ({ _seenChoiceAlertIds: new Set() }),
  createP2BootstrapSidebarRenderHost: () => ({}),
};
const pendingCleanups = [];

function escapeHtml(text) {
  const str = String(text);
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, (m) => map[m]);
}

before(async () => {
  baseCleanup = installBrowserStubs({
    window: { ClawFW: { actions: { registerMany() {} } }, ...CLASSIC_HOST_STUBS },
  });
  await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
  baseKernel = globalThis.window.KernelState;
  globalThis.window.KernelState.defineKey('markdown-utils', 'escapeHtml', escapeHtml);
  globalThis.window.KernelState.defineKey('markdown-utils', 'renderer', null);
  orchestration = await import('../public/src/modules/orchestration-state.js');
  i18n = await import('../public/src/modules/i18n-environment-state.js');
  // 同一批状态域（slash-commands 经 import 传递装载）：在 KernelState 就位时完成
  // 首次求值，生产同序（kernel-state 是 classic 标签，先于一切域模块）。
  store = await import('../public/src/modules/agent-store-state.js');
  await import('../public/src/modules/markdown-utils.js');
  toast = await import('../public/src/modules/toast-notify.js');
  // slash-commands 的 import 目标：进程级单例（与生产一致）
  slashMenu = await import('../public/src/modules/slash-menu.js');
});

after(() => {
  while (pendingCleanups.length > 0) pendingCleanups.pop()();
  baseCleanup();
});

/**
 * 装本用例的 window 桩并装载 slash-commands（每次全新实例 → 重新注册命令）。
 * @param {{ window?: object, fetch?: Function, sessionOps?: boolean }} [options]
 * @returns {Promise<{ module: object, registered: object[], actions: object[], toasts: object[], previews: string[] }>}
 */
async function loadCommands({ window: windowOverrides = {}, fetch: fetchOverride, agents = [] } = {}) {
  const actions = [];
  const toasts = [];
  const previews = [];
  const cleanupStubs = installBrowserStubs({
    window: {
      KernelState: baseKernel,
      ClawFW: { actions: { registerMany() {} } },
      ...CLASSIC_HOST_STUBS,
      getRuntimeId: () => '',
      getLogicalAgentId: (record) => (record ? record.id : ''),
      getRuntimeWorkspaceSessionId: () => null,
      getActiveWorkspaceSessionId: (record) => (record?.workspace_sessions?.activeSessionId ?? null),
      getCurrentRuntimeRecord: () => null,
      getCurrentAgentRecord: () => null,
      runWorkspaceAction: (action) => { actions.push(action); },
      confirm: () => true,
      ...windowOverrides,
    },
  });
  const realToastShow = toast.ClawToast.show;
  toast.ClawToast.show = (spec) => { toasts.push(spec); };
  const hadFetch = Object.hasOwn(globalThis, 'fetch');
  const prevFetch = globalThis.fetch;
  globalThis.fetch = fetchOverride || (async (url) => {
    previews.push(String(url));
    return { ok: false, status: 0, json: async () => ({}) };
  });
  pendingCleanups.push(() => {
    if (hadFetch) globalThis.fetch = prevFetch; else delete globalThis.fetch;
    toast.ClawToast.show = realToastShow;
    cleanupStubs();
  });

  i18n.setCurrentLanguage('zh');
  // sessionOps 是 agent 记录的声明事实（session-menu-decls 的真实数据源）；
  // slash-commands 已直接 import 该事实解析，不再经 window 替身。
  store.setAllAgents(agents.map((record) => ({ ...record })));

  // 注册面探针：slash-commands 装载时就地调用 SlashMenu.registerCommands
  const registered = [];
  const original = slashMenu.SlashMenu.registerCommands;
  slashMenu.SlashMenu.registerCommands = (list) => { registered.push(...list); };
  try {
    const { module } = await loadModuleOnce(MODULE_PATH, { installGlobals: false });
    return { module, registered, actions, toasts, previews };
  } finally {
    slashMenu.SlashMenu.registerCommands = original;
  }
}

/** 命令条目的可见性真实入口：注册进 SlashMenu 的 applies 谓词。 */
function commandApplies(module, name) {
  const command = module.SLASH_COMMANDS.find((cmd) => cmd.name === name);
  assert.ok(command, `${name} 已注册`);
  return command.applies();
}

/** 本地会话夹具：焦点 agent record + viewer 绑定为空（本地路径）。 */
function localSessionWindow({ agentId = 'programming-helper', sessionId = 's1' } = {}) {
  const record = { id: agentId, workspace_sessions: { activeSessionId: sessionId } };
  return {
    getCurrentRuntimeRecord: () => null,
    getCurrentAgentRecord: () => record,
    getActiveWorkspaceSessionId: () => sessionId,
  };
}

function threadHostWindow({ threadKeys = [] } = {}) {
  const index = new Set(threadKeys);
  return {
    isThreadHostAgentId: (agentId, sessionId) => index.has(`${agentId}::${sessionId}`),
  };
}

describe('slash-commands：注册与可见性谓词', () => {
  it('registers trim / summary into the imported SlashMenu at load time', async () => {
    const { module, registered } = await loadCommands();
    assert.deepEqual(registered.map((cmd) => cmd.name), ['trim', 'summary']);
    for (const cmd of registered) {
      assert.equal(cmd.destination, 'host');
      assert.equal(typeof cmd.applies, 'function');
      assert.equal(typeof cmd.handler, 'function');
    }
    assert.deepEqual(module.SLASH_COMMANDS.map((cmd) => cmd.name), ['trim', 'summary']);
    assert.match(module.SLASH_COMMANDS[0].description, /全量精简/);
  });

  it('keeps the manual entry for the manual-rotation app (PH) thread session', async () => {
    const { module } = await loadCommands({
      window: {
        ...localSessionWindow(),
        ...threadHostWindow({ threadKeys: ['programming-helper::s1'] }),
      },
      agents: [{ id: 'programming-helper', sessionOps: true }],
    });
    orchestration.setCurrentRuntimeAgentId('');
    assert.equal(commandApplies(module, 'trim'), true);
    assert.equal(commandApplies(module, 'summary'), true);
  });

  it('hides the manual entry for thread-carried apps (coder / memo) without sessionOps', async () => {
    const { module } = await loadCommands({
      window: {
        ...localSessionWindow({ agentId: 'coder', sessionId: 's2' }),
        ...threadHostWindow({ threadKeys: ['coder::s2'] }),
      },
      agents: [{ id: 'coder' }],
    });
    orchestration.setCurrentRuntimeAgentId('');
    assert.equal(commandApplies(module, 'trim'), false);
    assert.equal(commandApplies(module, 'summary'), false);
  });

  it('shows the manual entry for a non-thread session', async () => {
    const { module } = await loadCommands({
      window: { ...localSessionWindow({ sessionId: 's4' }), ...threadHostWindow() },
    });
    orchestration.setCurrentRuntimeAgentId('');
    assert.equal(commandApplies(module, 'trim'), true);
  });
});

describe('slash-commands：执行动作', () => {
  it('trim: previews round stats, asks for confirmation and posts trim_all with the round count', async () => {
    const { module, actions, previews } = await loadCommands({
      window: localSessionWindow(),
      fetch: async (url) => {
        previews.push(String(url));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            rounds: [{ charPercent: 0.25 }, { charPercent: 0.25 }],
          }),
        };
      },
    });
    orchestration.setCurrentRuntimeAgentId('');

    const trim = module.SLASH_COMMANDS.find((cmd) => cmd.name === 'trim');
    await trim.handler();

    assert.equal(previews.length, 1);
    assert.match(previews[0], /^\/protoclaw\/session_trim_preview\?agentId=programming-helper&sessionId=s1$/);
    assert.deepEqual(actions, [{
      type: 'compact_session_menu',
      compactType: 'trim_all',
      agentId: 'programming-helper',
      sessionId: 's1',
      trimCutRounds: 2,
    }]);
  });

  it('trim: aborts without posting when the confirmation is declined', async () => {
    const { module, actions } = await loadCommands({
      window: { ...localSessionWindow(), confirm: () => false },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, rounds: [] }) }),
    });
    orchestration.setCurrentRuntimeAgentId('');

    await module.SLASH_COMMANDS.find((cmd) => cmd.name === 'trim').handler();
    assert.deepEqual(actions, []);
  });

  it('summary: posts the summary branch directly', async () => {
    const { module, actions } = await loadCommands({ window: localSessionWindow() });
    orchestration.setCurrentRuntimeAgentId('');

    await module.SLASH_COMMANDS.find((cmd) => cmd.name === 'summary').handler();
    assert.deepEqual(actions, [{
      type: 'compact_session_menu',
      compactType: 'summary',
      agentId: 'programming-helper',
      sessionId: 's1',
    }]);
  });

  it('rejects execution on a thread-carried session with an info toast', async () => {
    const { module, actions, toasts } = await loadCommands({
      window: {
        ...localSessionWindow({ agentId: 'coder', sessionId: 's2' }),
        ...threadHostWindow({ threadKeys: ['coder::s2'] }),
      },
      agents: [{ id: 'coder' }],
    });
    orchestration.setCurrentRuntimeAgentId('');

    await module.SLASH_COMMANDS.find((cmd) => cmd.name === 'summary').handler();
    assert.deepEqual(actions, [], '执行侧守卫兜底：不投递动作');
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].id, 'slash-session-ops-unavailable');
  });

  it('reports a missing session instead of guessing a host', async () => {
    const { module, actions, toasts } = await loadCommands();
    orchestration.setCurrentRuntimeAgentId('');

    await module.SLASH_COMMANDS.find((cmd) => cmd.name === 'summary').handler();
    assert.deepEqual(actions, []);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].id, 'slash-no-session');
    assert.match(toasts[0].title, /没有可操作的会话/);
  });
});

describe('slash-commands：ESM 兼容面', () => {
  it('exposes only the command list; the applies helper stays module-private', async () => {
    const { module, registered } = await loadCommands();
    assert.ok(Array.isArray(module.SLASH_COMMANDS));
    // 私有 helper 不导出：可见性只经注册条目的 applies 进入消费面
    assert.equal(module._manualSessionOpsApplicable, undefined);
    for (const command of registered) {
      assert.equal(typeof command.applies, 'function');
      assert.equal(command.applies, module.SLASH_COMMANDS.find((cmd) => cmd.name === command.name).applies);
    }
    // 没有新增散装全局：清单与谓词不经 window 暴露
    assert.equal(globalThis.window.SLASH_COMMANDS, undefined);
    assert.equal(globalThis.window._manualSessionOpsApplicable, undefined);
  });
});
