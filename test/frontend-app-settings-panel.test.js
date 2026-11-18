// APP 设置面板就绪等待（workspace-actions 的 open_app_settings 分支）契约：
//   1. 注册表已就绪（首页 hero 路径，插件 mount 早于用户点击）：立即打开，
//      不订阅装载落定、不发任何网络请求；
//   2. 注册表未就绪（跨工作空间入口：侧栏右键先 switchAgent 再调用，插件
//      装载是渲染路径的异步幂等操作）：等待插件装载落定通知后查表打开——
//      等待期间不误开、落定订阅用毕即撤（不留悬挂回调）。
//
// 链路真实性：workspace-actions 为真实源码（runWorkspaceAction →
// openAppSettingsPanelWhenReady 的等待 / 查表 / 打开全链真实执行）。
// 两条宿主缝用替身注入：appSettingsPanels 注册表（生产由 APP 插件 mount
// 写入，如 memo 插件 settings.js）与 ClawHost 装载落定通知（生产是
// claw-host 的 ensurePlugin 链，mount 先于落定通知执行——替身保持同一
// 顺序语义：先注册、后通知）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareThreadClassicSandbox, withThreadCaseEnv } from './p2-thread-case.js';

const WORKSPACE_ACTIONS = 'public/src/modules/workspace-actions.js';

async function withSettingsCase(fn) {
  const requests = [];
  const opens = [];
  const registry = { appSettingsPanels: {} };
  const settle = {
    listeners: [],
    fire(pluginId) { for (const cb of [...this.listeners]) cb(pluginId); },
  };
  const fetchStub = async (url, init) => {
    requests.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
  };
  const host = { id: 'memo', source: 'prebuilt', kind: 'workspace' };
  const registerMemoPanel = () => {
    registry.appSettingsPanels.memo = { open: () => opens.push('memo') };
  };

  return withThreadCaseEnv({
    label: 'frontend-app-settings-panel',
    fetch: fetchStub,
    classic: (sandbox) => {
      prepareThreadClassicSandbox(sandbox, {
        getCurrentAgentRecord: () => host,
        getCurrentHostAgentRecord: () => host,
        getRuntimeWorkspaceSessionId: () => '',
        setViewerSessionBinding: () => {},
        renderAgentList: () => {},
        renderCurrentMainView: () => {},
        updateQueueIndicator: () => {},
        updateThreadHeaderIndicator: () => {},
        focusedAgentId: 'memo',
        currentRuntimeAgentId: '',
        allAgents: [host],
      });
      // 附加式注入（不得整体覆写 ClawFW：classic 阶段已装好 actions 注册表
      // 等宿主面，markdown-utils 求值期就依赖它）
      sandbox.window.ClawFW = sandbox.window.ClawFW || {};
      sandbox.window.ClawFW.appSettingsPanels = registry.appSettingsPanels;
      sandbox.window.ClawHost = {
        onPluginLoadSettled: (cb) => {
          settle.listeners.push(cb);
          return () => {
            const index = settle.listeners.indexOf(cb);
            if (index >= 0) settle.listeners.splice(index, 1);
          };
        },
      };
    },
    globals: {
      t: (key) => key,
      escapeHtml: (value) => String(value ?? ''),
      getCurrentAgentRecord: () => host,
    },
  }, async ({ c }) => {
    await c.load(WORKSPACE_ACTIONS);
    return fn({ c, requests, opens, settle, registerMemoPanel });
  });
}

test('open_app_settings：注册表已就绪时立即打开，不订阅装载落定', async () => {
  await withSettingsCase(async ({ c, requests, opens, settle, registerMemoPanel }) => {
    registerMemoPanel();
    await c.sandbox.run(`window.runWorkspaceAction(${JSON.stringify({ type: 'open_app_settings', settings: 'memo' })}, null)`);
    assert.deepEqual(opens, ['memo'], 'hero 路径零等待直通');
    assert.equal(settle.listeners.length, 0, '已就绪路径不得订阅装载落定（零成本）');
    assert.deepEqual(requests, [], '打开设置面板不发任何网络请求');
  });
});

test('open_app_settings：注册表未就绪时等装载落定后打开，订阅用毕即撤', async () => {
  await withSettingsCase(async ({ c, opens, settle, registerMemoPanel }) => {
    const started = c.sandbox.run(`window.runWorkspaceAction(${JSON.stringify({ type: 'open_app_settings', settings: 'memo' })}, null)`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(opens, [], '插件装载落定前不得误开');
    assert.equal(settle.listeners.length, 1, '等待路径订阅装载落定通知');
    // 生产顺序语义：mount（注册面板）先于落定通知
    registerMemoPanel();
    settle.fire('memo');
    await started;
    assert.deepEqual(opens, ['memo'], '落定且注册在案后恰好打开一次');
    assert.equal(settle.listeners.length, 0, '打开后撤销落定订阅（不留悬挂回调）');
  });
});
