/**
 * P2 跨批测试地基验收：真实 classic bootstrap → ESM 适配图。
 *
 * 选取 P2 首屏边界的两条真实链路：
 *   - p2-bootstrap-dom：DOM 引用域（dom-refs）已迁模块相（P4 T1），原 classic
 *     顶层 `const container` 词法绑定不复存在；仍有 classic 消费方的两个键
 *     （container / currentAgentTitle）经桥键暴露。断言 ESM 导出与桥键读回的
 *     是同一元素引用，钉住「不复制元素引用」。
 *   - agent-loader-host：模块顶层读 classic 的 window.AgentLoaderHost，并向
 *     KernelState 注册/认领自己的桥域；其静态依赖（agent-store / orchestration /
 *     session-view-*）各自 claim，验证跨批典型的多域图。
 *
 * classic 侧按真实加载序跑 app-core + session-view-state（frontend-vm 的
 * loadSource 仍是 classic 专用），ESM 侧全部走 c.load 的真实 import。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const BOOTSTRAP_DOM = 'public/src/modules/p2-bootstrap-dom.js';
const AGENT_LOADER_HOST = 'public/src/modules/agent-loader-host.js';

function createFetchStub() {
  const calls = [];
  const stub = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({}) };
  };
  stub.calls = calls;
  return stub;
}

const bootstrapCaseOptions = () => {
  const fetchStub = createFetchStub();
  return {
    fetchStub,
    options: {
      classic: (sandbox) => {
        // 真实先行脚本序（test/p2-classic-hosts.js）：宿主工厂都是生产实现，
        // 首屏 boot 与周期排程由基座关掉。
        prepareClassicSandbox(sandbox);
      },
      globals: { fetch: fetchStub },
    },
  };
};

test('classic 词法经真实 host seam 进入 ESM；跨域桥与 classic 状态双向一致', async () => {
  const first = bootstrapCaseOptions();

  const evidence = await withP2EsmCase(first.options, async (c) => {
    // DOM 引用 owner 已迁模块相（P4 T1）：classic 侧不再有顶层 const 词法绑定，
    // 裸标识符改为解析到桥键访问器；两条路径读同一元素引用。
    assert.equal(c.read('typeof Object.getOwnPropertyDescriptor(window, "container").get'), 'function',
      'classic 侧拿到的是桥键访问器，不再是顶层 const');
    assert.equal(c.read('typeof container'), 'object', 'classic 裸标识符解析到桥键');

    const dom = await c.load(BOOTSTRAP_DOM);
    assert.equal(Object.isFrozen(dom.domRefs), true);
    assert.equal(dom.domRefs.container, c.read('window.container'), '桥键与命名导出是同一元素引用');
    assert.equal(dom.domRefs.currentAgentTitle, c.read('window.currentAgentTitle'));

    const host = await c.load(AGENT_LOADER_HOST);
    for (const name of ['loadFeatureTemplateMap', 'reloadFeatureTemplateMap', 'loadAgentDetail',
      'getAgentDetailPayload', 'extractSessionMetaFromDetail']) {
      assert.equal(typeof host[name], 'function', `${name} 应是命名导出`);
    }
    const stats = JSON.parse(c.read('JSON.stringify(KernelState.stats())'));
    assert.ok(stats.registeredKeys > 0, '宿主图应注册桥键');
    assert.ok(stats.claimedKeys > 0, '宿主图应完成认领');
    assert.equal(c.read('typeof loadAgentDetail'), 'function', '兼容桥键在本 case window 上可达');

    // classic 对象（window.AgentLoaderHost.loadedAgentDetailIds）被 ESM 直接使用
    assert.equal(c.read('AgentLoaderHost.loadedAgentDetailIds.size'), 0);
    await host.loadAgentDetail('agent-from-esm');
    assert.equal(c.read('AgentLoaderHost.loadedAgentDetailIds.size'), 1);
    assert.equal(c.read('AgentLoaderHost.loadedAgentDetailIds.has("agent-from-esm")'), true);
    assert.deepEqual(first.fetchStub.calls, ['/protoclaw/agent_detail?agentId=agent-from-esm']);
    return { dom, host, stats };
  });

  assert.equal(evidence.stats.registeredKeys > 0, true);

  // 第二个 case：重跑整条 classic → ESM 链路，不得残留桥键/集合/实例。
  const second = bootstrapCaseOptions();
  await withP2EsmCase(second.options, async (c) => {
    assert.equal(c.read('typeof loadAgentDetail'), 'undefined', '上一 case 的桥键不得出现在新 window');
    assert.equal(c.read('AgentLoaderHost.loadedAgentDetailIds.size'), 0);
    const dom = await c.load(BOOTSTRAP_DOM);
    const host = await c.load(AGENT_LOADER_HOST);
    assert.notEqual(dom, evidence.dom, 'bootstrap 适配模块是新一代实例');
    assert.notEqual(host, evidence.host);
    assert.equal(dom.domRefs.container, c.read('window.container'), '新 case 的桥键与导出仍是同一引用');
    assert.notEqual(dom.domRefs.container, evidence.dom.domRefs.container, '新 case 的 DOM 引用是新的沙箱对象');
    assert.deepEqual(
      JSON.parse(c.read('JSON.stringify(KernelState.stats())')),
      evidence.stats,
      '同名桥域在新 case 重新注册/认领，未撞重复注册',
    );
    assert.equal(c.read('AgentLoaderHost.loadedAgentDetailIds.size'), 0);
  });
});
