/**
 * PH 移动弹窗的归属兜底（ph-session-move.js）：
 *
 *  单条 ctx 入口从会话记录解析归属，切片缓存/项目实体缓存 miss 时弹
 *  「无法确定该会话的归属目录」，而会话在服务端索引里归属明确。修复：
 *  切片 miss 走列表接口 sessionId 精确过滤（索引读模型），消费与切片
 *  同管线的 wire 记录字段（projectId / openDirectory）。
 *
 *  （原「移动后侧栏乐观退场」用例已随服务端释放语义退役删除：移动不再
 *  释放存活实例，侧栏分组由每轮 loadAgents 从索引现读，无需退场注册。）
 *
 * 字段往返：本文件 fetch mock 的记录形态与服务端接线测试
 * test/ph-session-record-wire.test.js 同构（同一条 wire 投影管线产出）。
 *
 * DOM 编排边界：弹窗表单渲染/submit 全链依赖真实 innerHTML 解析，
 * frontend-vm 沙箱不承载；此处测承载契约的顶层函数，编排层由既有
 * 端到端链路覆盖。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/** 构造加载了真实 sidebar-operations + ph-session-move 的沙箱。 */
function makeCtx({ fetchImpl } = {}) {
  const calls = { renderAgentList: 0, fetches: [] };
  const ctx = createFrontendSandbox({
    URLSearchParams,
    currentLanguage: 'zh',
    getCurrentAgentRecord: () => ({ id: 'ph-agent', workspace_sessions: { sessions: [] } }),
    renderAgentList: () => { calls.renderAgentList += 1; },
    getWorkspaceSessions: () => [],
  });
  ctx.window.setInterval = () => 0;
  ctx.fetch = async (url, options) => {
    calls.fetches.push({ url: String(url), options });
    if (fetchImpl) return fetchImpl(String(url), options);
    return { ok: true, json: async () => ({}) };
  };
  ctx.loadSource('public/src/modules/sidebar-operations.js');
  ctx.loadSource('public/src/modules/ph-session-move.js');
  return { ctx, calls };
}

describe('归属解析的服务端权威兜底（sessionId 精确过滤消费）', () => {
  it('项目会话：wire 记录 projectId + openDirectory → project ownerKey', async () => {
    const { ctx, calls } = makeCtx({
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          sessions: [{
            id: 's-proj-head',
            title: '(精简)A',
            projectId: 'prj_move01',
            openDirectory: 'D:\\proj-a',
          }],
        }),
      }),
    });
    const ownership = await ctx._phResolveSessionOwnershipFromServer('s-proj-head');
    // 请求打到既有列表接口的 sessionId 过滤（非私搭端点）
    assert.ok(calls.fetches[0].url.includes('/protoclaw/prebuilt_sessions?'), '走既有列表接口');
    assert.ok(calls.fetches[0].url.includes('sessionId=s-proj-head'), 'sessionId 精确过滤参数');
    // 逐字段断言：沙箱对象与主 realm 原型不同，deepStrictEqual 会拒绝
    assert.equal(ownership.directory, 'D:\\proj-a');
    assert.equal(ownership.ownerKey, 'project:prj_move01');
  });

  it('目录会话：projectId 空 → directory ownerKey（与本地解析同构归一）', async () => {
    const { ctx } = makeCtx({
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          sessions: [{ id: 's-dir', title: '目录对话', openDirectory: 'D:\\proj-a' }],
        }),
      }),
    });
    const ownership = await ctx._phResolveSessionOwnershipFromServer('s-dir');
    assert.equal(ownership.directory, 'D:\\proj-a');
    assert.equal(ownership.ownerKey, 'directory:d:/proj-a');
  });

  it('服务端查无此会话：返回 null（调用方显式报错，不猜测）', async () => {
    const { ctx } = makeCtx({
      fetchImpl: async () => ({ ok: true, json: async () => ({ sessions: [] }) }),
    });
    assert.equal(await ctx._phResolveSessionOwnershipFromServer('s-none'), null);
  });
});
