/**
 * 三个对话型应用的标题策略装配契约（ADR-0041）
 *
 * 这里验证的是「装配是否真的接通」：Agent 的 setTurnEventBus 必须把宿主
 * 总线转交到实际装配的 AutoTitlePolicyFeature 实例上。只检查源码里出现
 * 了 `new AutoTitlePolicyFeature` 不能证明运行时能收到轮次事实——装配了
 * 却没收总线时，标题永远不会生成，而静态检查会照样通过。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTurnEventBus } from '../server/shared/turn-event-bus.js';
import { AutoTitlePolicyFeature } from '../local-features/dist/auto-title-policy/src/index.js';

const APP_IDS = ['programming-helper', 'coder', 'memo'];

function readMetadata(agentId) {
  return JSON.parse(
    fs.readFileSync(new URL(`../prebuilt-agents/official/${agentId}/metadata.json`, import.meta.url), 'utf8'),
  );
}

describe('application title policy assembly', () => {
  it('every conversation-producing application declares app-owned title policy', () => {
    for (const agentId of APP_IDS) {
      assert.equal(readMetadata(agentId).titlePolicy, 'app', `${agentId} must declare titlePolicy`);
    }
  });

  it('forwards the host turn event bus to the mounted title policy feature', async () => {
    for (const agentId of APP_IDS) {
      const module = await import(`../prebuilt-agents/official/${agentId}/agent.js`);
      const forward = module.default.prototype.setTurnEventBus;
      assert.equal(typeof forward, 'function', `${agentId} must expose setTurnEventBus`);

      // 装配阶段与宿主一致：Feature 先进 features Map，再收到总线。
      const feature = new AutoTitlePolicyFeature({
        agentId,
        serverOrigin: 'http://127.0.0.1:1',
        fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      });
      const calls = [];
      const originalSubscribe = feature.setTurnEventBus.bind(feature);
      feature.setTurnEventBus = (bus) => { calls.push(bus); originalSubscribe(bus); };

      const agent = { features: new Map([[feature.name, feature]]) };
      const bus = createTurnEventBus();
      forward.call(agent, bus);

      assert.equal(calls.length, 1, `${agentId} must forward the bus exactly once`);
      assert.equal(calls[0], bus, `${agentId} must forward the host bus itself`);
    }
  });

  it('feature actually reacts to a turn fact delivered through that bus', async () => {
    // 端到端最小闭环：宿主总线 → Agent 转交 → Feature 判定 → 发出生成请求。
    // 观察点是真实 HTTP 请求体，不是内部字段。
    const module = await import('../prebuilt-agents/official/coder/agent.js');
    const requests = [];
    const feature = new AutoTitlePolicyFeature({
      agentId: 'coder',
      serverOrigin: 'http://127.0.0.1:1',
      fetchImpl: async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        return { ok: true, json: async () => ({ ok: true, title: 't' }) };
      },
    });
    await feature.onInitiate({ logger: { info() {}, warn() {}, error() {}, debug() {}, trace() {}, child() { return this; } } });

    const bus = createTurnEventBus();
    module.default.prototype.setTurnEventBus.call({ features: new Map([[feature.name, feature]]) }, bus);

    bus.emit({ type: 'turn.completed', sessionId: 's-1', agentId: 'coder' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(requests.length, 1, 'a delivered turn must reach title generation');
    assert.equal(requests[0].body.agentId, 'coder');
    assert.equal(requests[0].body.sessionId, 's-1');
    // 规则必须由应用提供（非空字符串），否则会退回 OS 的统一风格。
    // 这里不锁定具体文案：改文案是应用的自由，改到不传规则才是缺陷。
    assert.equal(typeof requests[0].body.params.instructions, 'string');
    assert.ok(requests[0].body.params.instructions.trim().length > 0);
  });
});
