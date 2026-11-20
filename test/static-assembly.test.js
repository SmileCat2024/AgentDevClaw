import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataRoot = mkdtempSync(join(tmpdir(), 'claw-static-assembly-'));
process.env.AGENTDEV_DATA_DIR = dataRoot;

after(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

const { mountStaticFeatureManifest } = await import('../server/shared/static-assembly.js');
const mainModule = await import('../prebuilt-agents/official/programming-helper/agent.js');
const coderModule = await import('../prebuilt-agents/official/coder/agent.js');

function agentOf(AgentClass) {
  return new AgentClass({ llm: { modelName: 'static-assembly-test' }, runtime: {} });
}

/**
 * 真实装配守护（ADR-0054）：构造真实 Agent，验证两层契约——
 * 1. features Map 键序与 staticFeatureManifest 一致（构造走清单，锁住
 *    挂载序语义与端到端可构造性：空配置层下每个工厂都能产出实例）；
 * 2. 文档化的装配取舍不被误改：coder 不挂 claw-dispatch / claw-coder-dispatch
 *    （不自派工单，防递归调度）、不挂 user-input / generative-ui-surface
 *    （无人值守场景交互 feature 永久 pending 会卡住线程）、两身份都保有
 *    opencode-basic（基础读写）。清单条目的增删是产品决策，本测试不钉
 *    全量快照（避免第二份需要同步的清单），只钉会被静默破坏的边界。
 */
describe('静态装配清单：真实装配与清单一致', () => {
  it('编程小助手 features Map 键序 === staticFeatureManifest', () => {
    const agent = agentOf(mainModule.default);
    assert.deepEqual(
      [...agent.features.keys()],
      mainModule.staticFeatureManifest.map((entry) => entry.name),
    );
    // 宿主挂载钩子依赖的装配事实通道保持存在
    assert.ok(agent.pendingFeatureMounts instanceof Map);
  });

  it('coder features Map 键序 === staticFeatureManifest', () => {
    const agent = agentOf(coderModule.default);
    assert.deepEqual(
      [...agent.features.keys()],
      coderModule.staticFeatureManifest.map((entry) => entry.name),
    );
    assert.ok(agent.pendingFeatureMounts instanceof Map);
  });

  it('装配取舍：coder 不挂调度桥与交互 feature，两身份保有基础读写', () => {
    const mainNames = new Set(mainModule.staticFeatureManifest.map((entry) => entry.name));
    const coderNames = new Set(coderModule.staticFeatureManifest.map((entry) => entry.name));

    assert.ok(mainNames.has('claw-coder-dispatch'), 'main 应挂 coder 领域 shell（调度入口）');
    assert.ok(!coderNames.has('claw-dispatch'), 'coder 不得挂调度桥（不自派工单）');
    assert.ok(!coderNames.has('claw-coder-dispatch'), 'coder 不得挂 coder 领域 shell（防递归调度）');
    assert.ok(!coderNames.has('user-input'), 'coder 不得挂 user-input（无人值守永久 pending）');
    assert.ok(!coderNames.has('generative-ui-surface'), 'coder 不得挂 generative-ui-surface');
    assert.ok(mainNames.has('opencode-basic') && coderNames.has('opencode-basic'), '两身份都应保有基础读写');
  });
});

describe('mountStaticFeatureManifest fail-fast', () => {
  const stubAgent = () => ({
    features: new Map(),
    use(feature) {
      this.features.set(feature.name, feature);
      return this;
    },
  });
  const ctx = { workspaceDir: '.', runtimeIdentity: {}, merged: {}, config: {} };

  it('清单条目重名抛错（取代 use() 静默覆盖）', () => {
    const manifest = [
      { name: 'a', create: () => ({ name: 'a' }) },
      { name: 'a', create: () => ({ name: 'a' }) },
    ];
    assert.throws(() => mountStaticFeatureManifest(stubAgent(), manifest, ctx), /重名/);
  });

  it('工厂产出 name 与条目键不一致抛错', () => {
    const manifest = [{ name: 'a', create: () => ({ name: 'b' }) }];
    assert.throws(() => mountStaticFeatureManifest(stubAgent(), manifest, ctx), /不一致/);
  });

  it('条目缺 create 工厂抛错', () => {
    assert.throws(() => mountStaticFeatureManifest(stubAgent(), [{ name: 'a' }], ctx), /create/);
  });

  it('正常清单按数组序挂载', () => {
    const manifest = [
      { name: 'a', create: () => ({ name: 'a' }) },
      { name: 'b', create: () => ({ name: 'b' }) },
    ];
    const agent = stubAgent();
    mountStaticFeatureManifest(agent, manifest, ctx);
    assert.deepEqual([...agent.features.keys()], ['a', 'b']);
  });
});
