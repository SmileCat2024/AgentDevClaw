import test from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

// 一次用例 = 一份真实沙箱 window + 一张真实 ESM 图（含 agent-loader-host ↔ template-engine
// 静态环）：环两侧共享同一代实例，classic 相与 ESM 侧读写同一个全局对象。
test('loader host preserves early template resets, const Set identity and real session commits', async () => {
  const requests = [];
  await withP2EsmCase({
    globals: {
      // vendor（index.html 的 marked / hljs）最小等价面：markdown-utils 在求值期取
      // Renderer 与 setOptions，本用例不渲染 markdown。
      marked: { Renderer: class {}, setOptions() {}, parse: (md) => String(md ?? '') },
      fetch: async (url) => {
        requests.push(String(url));
        return { ok: true, json: async () => String(url).startsWith('/api/templates/')
          ? { tool: '/template.js' }
          : { workspace_sessions: { sessions: [{ id: 'selected', openDirectory: '/selected' }] } } };
      },
    },
    classic: (ctx) => {
      // 真实先行脚本序（test/p2-classic-hosts.js）：i18n → action-dispatcher →
      // claw-host → right-panel-registry → app-core → runtime-status →
      // session-view-state → sidebar-render → app-ui → app-main；首屏 boot 与周期
      // 排程由该基座关掉，宿主工厂因此就是生产实现（不再有本地 seam）。
      prepareClassicSandbox(ctx);
      // 详情提交后的主视图渲染（app-ui renderCurrentMainView）需要视口与输入面渲染的
      // classic 实现（index.html 后续脚本，基座链未含）：补真实文件，不写桩。
      // 窄行为观察面：详情提交后 agent-loader 经 window.renderCurrentMainView 落到
      // 主视图渲染。本用例验收面是模板映射 / const Set 引用身份 / 详情提交语义，
      // 不验收主视图 DOM（真实渲染在本沙箱内需要整条 index.html 后续脚本：
      // chat-viewport → input-render → app-chat-input 槽位，实测失败链见
      // 交付报告）。这里只把渲染入口记成观察面。
      ctx.renderCurrentMainView = () => {};

      // 分发器是 classic 相里 ESM 域注册 data-action 处理器的宿主面
      // （window.ClawFW.actions），按 index.html 的先行脚本序先装它。
      ctx.loadSource('public/src/modules/action-dispatcher.js');
      ctx.run(`
        FEATURE_TEMPLATE_MAP = { early: '/early.js' };
        currentRuntimeAgentId = 'runtime';
        allAgents = [{ id: 'host' }];
      `);
    },
  }, async (c) => {
    const ctx = c.window;
    const earlyMap = ctx.FEATURE_TEMPLATE_MAP;

    const detailIds = ctx.run('loadedAgentDetailIds');
    // 会话视图 patch 是桥键（模块相才有）：classic 回调里调不到，初值在用例体设置。
    ctx.run("applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'selected' } })");
    const module = await c.load('public/src/modules/agent-loader-host.js');
    assert.strictEqual(module.FEATURE_TEMPLATE_MAP, earlyMap);
    assert.strictEqual(ctx.AgentLoaderHost.loadedAgentDetailIds, detailIds);
    assert.throws(() => ctx.run('loadedAgentDetailIds = new Set()'), { name: 'TypeError' });
    assert.strictEqual(ctx.loadAgentDetail, module.loadAgentDetail);
    assert.strictEqual(ctx.loadFeatureTemplateMap, module.loadFeatureTemplateMap);
    assert.equal(await module.loadFeatureTemplateMap(), true);
    assert.deepEqual(module.FEATURE_TEMPLATE_MAP, { tool: '/template.js' });
    const reset = {};
    ctx.FEATURE_TEMPLATE_MAP = reset;
    assert.strictEqual(module.FEATURE_TEMPLATE_MAP, reset);
    await ctx.loadAgentDetail('host');
    assert.equal(ctx.run('readCurrentSessionViewState().sessionMeta.openDirectory'), '/selected');
    assert.equal(detailIds.has('host'), true);
    assert.equal(requests.length, 2);
    assert.ok(requests[0].includes('agentId=runtime'));
    assert.equal(module.getAgentDetailPayload('host').workspace_sessions.sessions[0].id, 'selected');
  });
});
