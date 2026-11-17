/**
 * slash 手动精简命令（/trim /summary）的线程域可见性谓词（真实 ESM 模块驱动）。
 *
 * ADR-0032 决策 2：手动接续 APP（编程小助手）的线程会话保留手动精简入口；
 * 自动接续 APP（coder / memo）的线程会话继续隐藏（ADR-0024 决策 4，行为不变）。
 * 产品面事实源复用 session-menu-decls 的 sessionOpsAllowed（ADR-0049：
 * sessionOps 由 APP 的 metadata 声明驱动），不新增平行清单。
 *
 * 装载路线（P2 测试改造）：slash-commands / session-menu-decls 已迁 ESM，
 * 经 withP2EsmCase 走真实 import（每 case 整图隔离）；classic 侧按真实加载序
 * 先载 action-dispatcher + app-core（真实 bootstrap：桥键初值、身份与语言解析
 * 都在原位注册），再由夹具注入宿主面（身份解析；线程事实 isThreadHostAgentId
 * 以 thread-store 真实语义桩——查 sessionIndex 成员关系）。
 *
 * 断言入口是 SLASH_COMMANDS 条目的 applies：该数组就是模块装载时交给
 * SlashMenu.registerCommands 的清单（registerCommands 只过滤无名条目，用例
 * 逐条核对 name），不调模块私有函数。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const SLASH_COMMANDS_PATH = 'public/src/modules/slash-commands.js';
const SESSION_MENU_DECLS = 'public/src/modules/session-menu-decls.js';
const SLASH_MENU = 'public/src/modules/slash-menu.js';

/**
 * 一个 case 的夹具：真实 classic bootstrap（action-dispatcher + app-core）
 * + 宿主注入（身份解析、线程事实、动作通道）。
 *
 * @param {object} params
 * @param {string} params.agentId 当前视图的 logical agent id
 * @param {string} params.sessionId 当前视图绑定会话
 * @param {string[]} params.threadSessions 已进入线程 sessionIndex 的 `${agentId}::${sessionId}` 键
 */
function makeCaseOptions({ agentId, sessionId, threadSessions = [] }) {
  const sessionIndex = Object.fromEntries(threadSessions.map((key) => [key, { threadId: 'th-x' }]));
  const agentRecord = { id: agentId, workspace_sessions: { activeSessionId: sessionId } };
  return {
    classic: (sandbox) => {
      // 真实 classic 相（index.html 的先行脚本序）：slash-menu 的静态依赖
      // input-actions 在装载期经 window.createXHost() 取 app-core / app-main /
      // session-view-state / sidebar-render 的宿主工厂，复制桩会与生产契约分叉。
      prepareClassicSandbox(sandbox);
      // 声明驱动事实源（ADR-0049）：夹具镜像两个 APP 的 metadata 声明；
      // coder / memo 不声明 sessionOps，走线程承接语义。
      sandbox.allAgents = [
        { id: 'programming-helper', sessionOps: true },
        { id: 'agent-studio', sessionOps: true },
      ];
      // 宿主注入（classic 侧身份解析与线程事实；生产定义在 app-core / thread-store）
      sandbox.getRuntimeId = () => '';
      sandbox.getCurrentRuntimeRecord = () => null;
      sandbox.getCurrentAgentRecord = () => agentRecord;
      sandbox.getLogicalAgentId = (record) => record.id;
      sandbox.getRuntimeWorkspaceSessionId = () => null;
      sandbox.getActiveWorkspaceSessionId = (record) => record.workspace_sessions.activeSessionId;
      sandbox.runWorkspaceAction = () => {};
      sandbox.isThreadHostAgentId = (id, sid) => !!sessionIndex[`${id}::${sid}`];
    },
  };
}

/**
 * 在独立 case 内装载真实 ESM 图，并在 case 存续期间把命令清单交给 `probe`
 * 求值（applies 谓词经 window 桥读宿主面，必须在 case 内调用）。
 *
 * 注册副作用经**真实 SlashMenu** 观察：先装载 slash-menu 模块，替换其导出对象
 * 上的 registerCommands 做一次性收集，再装载 slash-commands（装载时就地注册），
 * 随后恢复原方法——与 test/p2-w1-5-slash-commands.test.js 同一观察口径。
 */
async function withSlashCommands({ agentId, sessionId, threadSessions }, probe) {
  return withP2EsmCase(
    makeCaseOptions({ agentId, sessionId, threadSessions }),
    async (c) => {
      const menuDecls = await c.load(SESSION_MENU_DECLS);
      const menuModule = await c.load(SLASH_MENU);
      const registered = [];
      const realRegister = menuModule.SlashMenu.registerCommands;
      menuModule.SlashMenu.registerCommands = (list) => { registered.push(...(Array.isArray(list) ? list : [])); };
      let slash;
      try {
        slash = await c.load(SLASH_COMMANDS_PATH);
      } finally {
        menuModule.SlashMenu.registerCommands = realRegister;
      }
      // 消费方改直接 import 后桥已注销：事实解析只经命名导出，window 上不再有该键
      assert.equal(c.read('typeof sessionOpsAllowed'), 'undefined', '会话操作声明面的桥已注销');
      assert.equal(typeof menuDecls.sessionOpsAllowed, 'function');
      assert.equal(menuDecls.sessionOpsAllowed('programming-helper'), true);
      assert.equal(menuDecls.sessionOpsAllowed('coder'), false);
      const commands = slash.SLASH_COMMANDS;
      return probe({
        commands,
        byName: new Map(commands.map((cmd) => [cmd.name, cmd])),
        registered,
        menu: menuModule.SlashMenu,
        realRegister,
      });
    },
  );
}

describe('slash 手动精简命令：线程域可见性谓词', () => {
  it('命令注册：真实 SlashMenu 收到 trim / summary（applies 即谓词）', async () => {
    await withSlashCommands({ agentId: 'programming-helper', sessionId: 's1' }, ({ commands, registered, menu, realRegister }) => {
      // 装载侧副作用：slash-commands 装载时调用真实 SlashMenu.registerCommands
      assert.deepEqual(registered.map((cmd) => cmd.name), ['trim', 'summary'], '命令在装载时注册进真实 SlashMenu');
      for (const cmd of registered) {
        assert.equal(cmd.destination, 'host');
        assert.equal(typeof cmd.applies, 'function');
        assert.equal(typeof cmd.handler, 'function');
      }
      // 注册清单与命名导出同源（同一批命令条目）
      assert.deepEqual(registered, commands);
      const names = commands.map((cmd) => cmd.name).sort();
      assert.deepEqual(names, ['summary', 'trim']);
      for (const cmd of commands) assert.equal(typeof cmd.applies, 'function');
      // 注册观察窗已恢复：模块对象上的 registerCommands 是原方法（不留探针）
      assert.equal(menu.registerCommands, realRegister, '注册探针已恢复，未泄漏到后续用例');
    });
  });

  it('PH 线程会话：保留手动入口（ADR-0032 决策 2，applies 为真）', async () => {
    await withSlashCommands({
      agentId: 'programming-helper',
      sessionId: 's1',
      threadSessions: ['programming-helper::s1'],
    }, ({ byName }) => {
      assert.equal(byName.get('trim').applies(), true);
    });
  });

  it('coder 线程会话：隐藏手动入口（ADR-0024 决策 4，行为不变）', async () => {
    await withSlashCommands({
      agentId: 'coder',
      sessionId: 's2',
      threadSessions: ['coder::s2'],
    }, ({ byName }) => {
      assert.equal(byName.get('trim').applies(), false);
    });
  });

  it('memo 线程会话：隐藏手动入口（行为不变）', async () => {
    await withSlashCommands({
      agentId: 'memo',
      sessionId: 's3',
      threadSessions: ['memo::s3'],
    }, ({ byName }) => {
      assert.equal(byName.get('trim').applies(), false);
    });
  });

  it('PH 无线程会话（混合期存量）：显示手动入口（行为不变）', async () => {
    await withSlashCommands({ agentId: 'programming-helper', sessionId: 's4' }, ({ byName }) => {
      assert.equal(byName.get('trim').applies(), true);
    });
  });

  it('agent-studio 会话（产品面白名单内、非线程宿主）：显示手动入口（行为不变）', async () => {
    await withSlashCommands({ agentId: 'agent-studio', sessionId: 's5' }, ({ byName }) => {
      assert.equal(byName.get('trim').applies(), true);
    });
  });
});
