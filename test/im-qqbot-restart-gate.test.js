/**
 * qqbot 门户 runtime 的启动/重启闸（ADR-0042 回归）。
 *
 * 背景：切片 B 把门户渠道从 selectedChannel 并入线路模型（口径 = 接线员线路
 * 的 carrier），start_agent、restart_agent、dispatch-engine 三处各抄了一份判断。
 * 切换时漏改 restart_agent——它仍读 selectedChannel，而该字段归一后恒不存在，
 * 于是「重启 Agent」对 qqbot 恒定只停不起。
 *
 * 修复方式不是在那处再抄一遍，而是把判定收敛为 im-config 的单一函数
 * blocksPortalRuntimeStart，三处消费方同源。本文件验证该函数本身，并验证
 * 路由层确实消费它（断言落在「是否拦下」这一可观察结果上）。
 *
 * 隔离：AGENTDEV_DATA_DIR 在 constants 模块求值时就固定了 USER_DATA_ROOT，
 * 因此必须在任何 server 模块加载前设置（下方顶层的 import 顺序即契约）。
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claw-im-start-gate-'));
process.env.AGENTDEV_DATA_DIR = DATA_DIR;

const { blocksPortalRuntimeStart, operatorCarrierOf, normalizeIMWorkspaceConfig } =
  await import('../server/routes/im-config.js');
const { APP_IM_WORKSPACE_CONFIG_PATH } = await import('../server/shared/constants.js');
const { createAgentLifecycleModule } = await import('../server/routes/agent-lifecycle.js');
const { closeAllSessionDbs } = await import('../server/shared/session-access.js');

after(() => {
  closeAllSessionDbs();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

function configWithOperatorLine(carrier) {
  return normalizeIMWorkspaceConfig({
    operatorThreadId: 'wt-operator',
    lines: [{
      id: 'line1',
      carrier,
      boundTarget: { agentId: 'qqbot', threadId: 'wt-operator' },
    }],
  });
}

describe('blocksPortalRuntimeStart — 门户闸的唯一判定口径', () => {
  it('接线员线路已接渠道 → 不拦', () => {
    assert.equal(blocksPortalRuntimeStart('qqbot', configWithOperatorLine('qq')), false);
  });

  it('有线但一条都没接渠道 → 拦下', () => {
    assert.equal(blocksPortalRuntimeStart('qqbot', configWithOperatorLine('')), true);
  });

  it('完全没有接线员线程引用 → 拦下', () => {
    // operatorThreadId 缺失时线路无法被识别为接线员线路，等价于未接线
    const config = normalizeIMWorkspaceConfig({
      lines: [{ id: 'line1', carrier: 'qq' }],
    });
    assert.equal(blocksPortalRuntimeStart('qqbot', config), true);
  });

  it('只对 qqbot 生效，其他工作空间一律不拦', () => {
    assert.equal(blocksPortalRuntimeStart('programming-helper', configWithOperatorLine('')), false);
    assert.equal(blocksPortalRuntimeStart('coder', configWithOperatorLine('')), false);
  });

  it('判定与 operatorCarrierOf 同一事实源（不再读 selectedChannel）', () => {
    // 旧实现读 selectedChannel：该字段存在也不得影响判定
    const legacyShaped = { ...configWithOperatorLine(''), selectedChannel: 'feishu' };
    assert.equal(operatorCarrierOf(legacyShaped), '');
    assert.equal(blocksPortalRuntimeStart('qqbot', legacyShaped), true,
      'selectedChannel 存在不代表接线员线路已接渠道');
  });
});

describe('start_agent / restart_agent 路由消费同一判定', () => {
  function writeIMConfig(carrier) {
    writeFileSync(APP_IM_WORKSPACE_CONFIG_PATH, JSON.stringify({
      operatorThreadId: 'wt-operator',
      channels: {},
      lines: [{
        id: 'line1',
        label: '通道 1',
        carrier: carrier || '',
        boundTarget: { agentId: 'qqbot', threadId: 'wt-operator' },
      }],
    }, null, 2), 'utf8');
  }

  /** 捕获指定路由 handler（createAgentLifecycleModule 用 app.post 注册）。 */
  function capture(routePath) {
    let handler = null;
    createAgentLifecycleModule({
      sessionApi: {},
      getAgents: async () => [],
      getAgentsLight: async () => [],
      enrichAgent: async (agent) => agent,
      requireAgentLight: async (id) => ({ id, relativeDir: 'test', name: id }),
      resolveRuntimeDisplayName: async (agent) => agent?.name || 'test-agent',
      readActiveWorkspaceSessionMeta: async () => ({ workspaceSessions: [], sessionMeta: {} }),
      readWorkspaceSessionMeta: async () => ({}),
      readViewerJson: async () => ({ agents: [], currentAgentId: null }),
      getPendingInputCount: async () => 0,
      resolveAgentModelPresets: async () => null,
    }).setupRoutes(
      {
        get: () => {},
        post: (p, ...rest) => { if (p === routePath) handler = rest[rest.length - 1]; },
        put: () => {},
        delete: () => {},
      },
      { json: () => (req, res, next) => next() },
    );
    assert.ok(handler, `${routePath} should be registered`);
    return handler;
  }

  function makeRes() {
    return {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(data) { this.payload = data; return this; },
      end() {},
    };
  }

  beforeEach(() => writeIMConfig(''));

  for (const routePath of ['/protoclaw/start_agent', '/protoclaw/restart_agent']) {
    it(`${routePath}：无接线员线路 → 拦下并给出 warning`, async () => {
      const res = makeRes();
      let thrown = null;
      await capture(routePath)(
        { body: { agentId: 'qqbot', sessionId: null } },
        res,
        (error) => { thrown = error; },
      );
      assert.equal(thrown, null, '闸分支不得把错误抛给 next');
      assert.match(String(res.payload?.warning || ''), /无接线员线路/);
    });
  }

  it('/protoclaw/start_agent：非 qqbot 不被门户闸拦下', async () => {
    // 指向不存在的会话，让启动链在读取会话记录时即刻失败——本断言只关心
    // 「有没有被门户闸拦下」，不需要真的拉起 runtime 子进程。
    const res = makeRes();
    let thrown = null;
    await capture('/protoclaw/start_agent')(
      { body: { agentId: 'programming-helper', sessionId: 'no-such-session' } },
      res,
      (error) => { thrown = error; },
    );
    assert.equal(res.payload?.warning, undefined, '非 qqbot 不应拿到门户闸的 warning');
    assert.ok(thrown, '应前进到启动链（由会话不存在收敛），而不是停在闸分支');
  });

  it('/protoclaw/restart_agent：接线员线路已接渠道时不拦（本次修复的核心）', async () => {
    writeIMConfig('qq');
    const res = makeRes();
    let thrown = null;
    await capture('/protoclaw/restart_agent')(
      { body: { agentId: 'qqbot', sessionId: 'no-such-session' } },
      res,
      (error) => { thrown = error; },
    );
    assert.equal(res.payload?.warning, undefined,
      '已接渠道却仍拦下 = 回到「重启只停不起」的旧缺陷');
    assert.ok(thrown, '应前进到启动链（由会话不存在收敛）');
  });
});
