/**
 * Studio 新建对话的目录选择（workspace-actions 域，P2 ESM 化后重钉）。
 *
 * 契约不变：agent-studio 在没有显式 openDirectory 时，创建会话前先开目录
 * 选择器；取消即不建无目录会话；已有目录（含「继续」动作）不再询问；对话
 * 结束后新对话重新询问，不复用上一次的工作区目录。
 *
 * 驱动方式（配方第三节「真实模块图 + 公开行为」）：resolveStudioSessionDirectory
 * 是模块私有实现，不为测试导出、也不上桥——用例经公开入口 runWorkspaceAction
 * 发起 create_session，观察点放在两个真实 IO 边界上：
 *   - 目录选择器：app-core 的 `invoke('select_directory')`（宿主命令面）；
 *   - 会话创建宿主：`ClawFW.workspaceAgents.selectForNewSession(agent, action)`
 *     （生产由 workspace-agents 提供，是动作的下一手消费者）。
 * 断言的是「选择器是否被调用」与「创建动作实际携带的目录」，与迁移前对
 * resolveStudioSessionDirectory 返回值的断言等价。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const WORKSPACE_ACTIONS = 'public/src/modules/workspace-actions.js';

const STUDIO_AGENT = {
  id: 'agent-studio',
  source: 'prebuilt',
  workspace_state: { openDirectory: '', forms: {}, updatedAt: null },
  workspace_sessions: { revision: 1, activeSessionId: null, sessions: [] },
};

async function withStudioCreateAction({ picker, agent = STUDIO_AGENT }, fn) {
  const events = { picker: [], create: [], alerts: [] };
  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
      sandbox.loadSource('public/src/app-core.js');
      // 真实模块图求值相需要 classic 的宿主工厂 owner。其中 app-core 与
      // session-view-state 提供真实现；其余宿主（app-main / app-ui /
      // sidebar-render 的 createXHost）装载会连带首屏与面板注册链，与本用例
      // 无关，按宿主缝给最小面——本用例在到达会话创建宿主时就返回，这些宿主
      // 的方法不会被调用。
      sandbox.loadSource('public/src/modules/session-view-state.js');

      sandbox.window.createCompactResumeHost = () => ({});
      sandbox.window.createRuntimeSwitchHost = () => ({ state: {} });
      sandbox.window.createWorkspaceEntryHost = () => ({});
      sandbox.window.createWorkspaceSurfaceHost = () => ({});
      sandbox.window.createAgentSnapshotLoaderHost = () => ({ state: {} });
      sandbox.window.createPollCoordinatorHost = () => ({
        run: () => {},
        fastInterval: () => 0,
        setTimeout: (callback, delay) => sandbox.window.setTimeout(callback, delay),
        clearTimeout: (id) => sandbox.window.clearTimeout(id),
      });
      sandbox.window.createAgentCallStatesHost = () => ({});
      sandbox.window.createP2BootstrapSidebarRenderHost = () => {
        let signature = '';
        return Object.freeze({
          get lastAgentListRenderSignature() { return signature; },
          set lastAgentListRenderSignature(value) { signature = value; },
        });
      };
      // 目录选择器：真实 invoke（app-core 的宿主命令面）以记录替身回答。
      sandbox.window.invoke = async (command) => {
        events.picker.push(String(command));
        return picker;
      };
      sandbox.window.getCurrentAgentRecord = () => agent;
      sandbox.window.alert = (message) => { events.alerts.push(String(message)); };
      sandbox.window.ClawFW = {
        ...(sandbox.window.ClawFW || {}),
        workspaceAgents: {
          selectForNewSession: async (_agent, action) => {
            events.create.push(action);
            return null; // 观察点落在 action 上：返回 null 即止于创建宿主。
          },
        },
      };
    },
    globals: {
      navigator: undefined,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
    },
  }, async (c) => {
    // 刷新引擎（P4 T3 起是真实 ESM）：交互域在装载期取它的窄宿主，必须先入图。
    await c.load('public/src/modules/thread-store.js');
    const module = await c.load(WORKSPACE_ACTIONS);
    // 导出面即动作入口（桥键之外，未来消费方改 import 的路径）：入口必须
    // 同时以命名导出与 kernel 桥键两个身份存在。
    assert.equal(typeof module.runWorkspaceAction, 'function', '动作入口保持命名导出');
    return fn(c, events, module);
  });
}

const runCreateSession = (c, action) => c.window.runWorkspaceAction(action, null);

describe('Studio new conversation directory selection', () => {
  it('opens the existing directory picker before the first conversation', async () => {
    await withStudioCreateAction({ picker: { path: 'D:\\projects\\feature-a' } }, async (c, events) => {
      await runCreateSession(c, { type: 'create_session' });
      assert.deepEqual(events.picker, ['select_directory'], '目录选择器恰好被打开一次');
      assert.equal(events.create.length, 1, '创建动作到达会话创建宿主');
      assert.equal(events.create[0].openDirectory, 'D:\\projects\\feature-a');
    });
  });

  it('cancelling the picker does not create a directory-less session', async () => {
    await withStudioCreateAction({ picker: { path: '', cancelled: true } }, async (c, events) => {
      await runCreateSession(c, { type: 'create_session' });
      assert.deepEqual(events.picker, ['select_directory']);
      assert.equal(events.create.length, 0, '取消后不得发起无目录创建');
    });
  });

  it('reuses a selected project, including the Continue action, without opening the picker', async () => {
    await withStudioCreateAction({ picker: { path: '' } }, async (c, events) => {
      await runCreateSession(c, { type: 'create_session', openDirectory: '/projects/existing' });
      assert.deepEqual(events.picker, [], '已有目录不再询问');
      assert.equal(events.create.length, 1);
      assert.equal(events.create[0].openDirectory, '/projects/existing');
    });
  });

  it('asks again for a new conversation instead of reusing the last workspace directory', async () => {
    const agent = {
      ...STUDIO_AGENT,
      workspace_state: { openDirectory: '/projects/last', forms: {}, updatedAt: null },
    };
    await withStudioCreateAction({ picker: { path: '/projects/another' }, agent }, async (c, events) => {
      await runCreateSession(c, { type: 'create_session' });
      assert.deepEqual(events.picker, ['select_directory'], '上次的工作区目录不作为本次目标');
      assert.equal(events.create[0].openDirectory, '/projects/another');
    });
  });
});
