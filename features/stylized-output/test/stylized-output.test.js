import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { Decision } from '@agentdevjs/core';
import { StylizedOutput } from '../dist/index.js';

const SIGNATURE = '我确认本回复已逐句遵循测试风格的全部要求。';

let workspaceDir;

function createFeature() {
  const feature = new StylizedOutput({ workspaceDir });
  feature.setActiveStyle('test-style');
  return feature;
}

/** 构造 StepFinish 门禁上下文 */
function createGateContext({ toolCallsCount = 0 } = {}) {
  const added = [];
  const ctx = {
    toolCallsCount,
    hasActiveSubAgents: false,
    hasPendingMessages: false,
    hasPendingWakeups: false,
    waitCalled: false,
    context: { add: (msg) => added.push(msg) },
  };
  return { ctx, added };
}

before(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'stylized-output-test-'));
  mkdirSync(join(workspaceDir, '.agentdev', 'output-style'), { recursive: true });
  writeFileSync(
    join(workspaceDir, '.agentdev', 'output-style', 'test-style.md'),
    [
      '---',
      'name: test-style',
      'description: 测试风格',
      `signature: ${SIGNATURE}`,
      '---',
      '',
      '正文规则。',
      '',
    ].join('\n'),
    'utf-8',
  );
});

after(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe('StylizedOutput 签名工具', () => {
  it('签名匹配 → 记录本轮已签名并返回 ok', async () => {
    const feature = createFeature();
    const payload = await feature.signTool.execute({ signature: SIGNATURE });

    assert.equal(payload.ok, true);
    assert.equal(payload.signed, true);
    assert.equal(payload.style, 'test-style');
    assert.equal(feature.signedForReply, true);
  });

  it('签名内部空白差异被规范化后匹配', async () => {
    const feature = createFeature();
    const payload = await feature.signTool.execute({ signature: `  ${SIGNATURE}  ` });

    assert.equal(payload.ok, true);
    assert.equal(feature.signedForReply, true);
  });

  it('签名不匹配 → 拒绝且不记录签名', async () => {
    const feature = createFeature();
    const payload = await feature.signTool.execute({ signature: '错误的签名' });

    assert.equal(payload.ok, false);
    assert.equal(feature.signedForReply, false);
  });

  it('signature 参数为空 → 拒绝', async () => {
    const feature = createFeature();
    const payload = await feature.signTool.execute({ signature: '   ' });

    assert.equal(payload.ok, false);
    assert.equal(feature.signedForReply, false);
  });

  it('未启用风格 → 明确拒绝，无需签名', async () => {
    const feature = new StylizedOutput({ workspaceDir });
    const payload = await feature.signTool.execute({ signature: SIGNATURE });

    assert.equal(payload.ok, false);
    assert.match(payload.error, /未启用任何输出风格/);
  });
});

describe('StylizedOutput 签名门禁（StepFinish guard）', () => {
  it('带工具调用的步不干预', async () => {
    const feature = createFeature();
    await feature.signTool.execute({ signature: SIGNATURE });
    const { ctx } = createGateContext({ toolCallsCount: 2 });

    const decision = await feature.decideSignatureGate(ctx);

    assert.equal(decision, Decision.Continue);
    assert.equal(feature.lastAction, 'signed');
  });

  it('已签名的自然结束步放行', async () => {
    const feature = createFeature();
    await feature.signTool.execute({ signature: SIGNATURE });
    const { ctx, added } = createGateContext({ toolCallsCount: 0 });

    const decision = await feature.decideSignatureGate(ctx);

    assert.equal(decision, Decision.Continue);
    assert.equal(added.length, 0);
  });

  it('未签名试图自然结束 → 拦截并注入补签要求', async () => {
    const feature = createFeature();
    const { ctx, added } = createGateContext({ toolCallsCount: 0 });

    const decision = await feature.decideSignatureGate(ctx);

    assert.equal(decision, Decision.Approve);
    assert.equal(feature.lastAction, 'blocked');
    assert.equal(feature.blockedCount, 1);
    assert.equal(added.length, 1);
    assert.match(added[0].content, /签名门禁/);
  });

  it('连续拦截达到上限后放行结束', async () => {
    const feature = createFeature();
    feature.setMaxSignatureBlocks(2);

    for (let i = 0; i < 2; i++) {
      const { ctx } = createGateContext({ toolCallsCount: 0 });
      const decision = await feature.decideSignatureGate(ctx);
      assert.equal(decision, Decision.Approve);
    }

    const { ctx } = createGateContext({ toolCallsCount: 0 });
    const decision = await feature.decideSignatureGate(ctx);
    assert.equal(decision, Decision.Continue);
    assert.equal(feature.lastAction, 'released');
  });

  it('CallStart 重置签名状态，上一轮签名对本轮无效', async () => {
    const feature = createFeature();
    await feature.signTool.execute({ signature: SIGNATURE });
    assert.equal(feature.signedForReply, true);

    await feature.syncStyleState({});

    assert.equal(feature.signedForReply, false);
    const { ctx } = createGateContext({ toolCallsCount: 0 });
    const decision = await feature.decideSignatureGate(ctx);
    assert.equal(decision, Decision.Approve);
  });
});

describe('StylizedOutput 内置风格与默认回填', () => {
  it('内嵌风格与工作区风格合并发现', async () => {
    const feature = new StylizedOutput({ workspaceDir });
    await feature.syncStyleState({});
    const names = feature.getStyles().map((style) => style.name);

    assert.ok(names.includes('test-style'), '工作区风格应被发现');
    assert.ok(names.includes('清晰表达'), 'feature 内嵌风格应被发现');
  });

  it('工作区与内嵌风格重名时工作区版本优先', async () => {
    const styleDir = join(workspaceDir, '.agentdev', 'output-style');
    writeFileSync(
      join(styleDir, 'override.md'),
      [
        '---',
        'name: 清晰表达',
        'description: 工作区覆盖版',
        'signature: 工作区覆盖版签名',
        '---',
        '',
      ].join('\n'),
      'utf-8',
    );
    try {
      const feature = new StylizedOutput({ workspaceDir, defaultStyle: '清晰表达' });
      await feature.syncStyleState({});

      assert.equal(feature.getActiveStyle().signature, '工作区覆盖版签名');
    } finally {
      rmSync(join(styleDir, 'override.md'), { force: true });
    }
  });

  it('defaultStyle：未选择时扫描后自动回填', async () => {
    const feature = new StylizedOutput({ workspaceDir, defaultStyle: 'test-style' });
    assert.equal(feature.getStatus().activeStyle, null);

    await feature.syncStyleState({});

    assert.equal(feature.getStatus().activeStyle, 'test-style');
  });

  it('defaultStyle 不在清单中 → 保持未选择', async () => {
    const feature = new StylizedOutput({ workspaceDir, defaultStyle: '不存在的风格' });
    await feature.syncStyleState({});

    assert.equal(feature.getStatus().activeStyle, null);
  });

  it('显式清除后默认风格不再回填', async () => {
    const feature = new StylizedOutput({ workspaceDir, defaultStyle: 'test-style' });
    await feature.syncStyleState({});
    assert.equal(feature.getStatus().activeStyle, 'test-style');

    feature.setActiveStyle(null);
    await feature.syncStyleState({});

    assert.equal(feature.getStatus().activeStyle, null);
  });

  it('显式选择其他风格后默认不干预', async () => {
    const feature = new StylizedOutput({ workspaceDir, defaultStyle: '清晰表达' });
    feature.setActiveStyle('test-style');

    await feature.syncStyleState({});

    assert.equal(feature.getStatus().activeStyle, 'test-style');
  });

  it('activeStyleCleared 随快照往返', async () => {
    const source = new StylizedOutput({ workspaceDir, defaultStyle: 'test-style' });
    await source.syncStyleState({});
    source.setActiveStyle(null);
    assert.equal(source.captureState().activeStyleCleared, true);

    const restored = new StylizedOutput({ workspaceDir, defaultStyle: 'test-style' });
    restored.restoreState(source.captureState());
    await restored.syncStyleState({});

    assert.equal(restored.getStatus().activeStyle, null, '恢复显式清除态后不应回填默认');
  });

  it('旧快照（无 activeStyleCleared 字段）恢复后默认回填生效', async () => {
    const legacySnapshot = { activeStyleName: null, signedForReply: false, blockedCount: 0, lastAction: 'idle' };
    const feature = new StylizedOutput({ workspaceDir, defaultStyle: 'test-style' });

    feature.restoreState(legacySnapshot);
    await feature.syncStyleState({});

    assert.equal(feature.getStatus().activeStyle, 'test-style');
  });

  it('onInitiate featureConfig.defaultStyle 声明默认风格', async () => {
    const feature = new StylizedOutput({ workspaceDir });
    await feature.onInitiate({ logger: undefined, featureConfig: { defaultStyle: 'test-style' }, config: {} });

    assert.equal(feature.getStatus().defaultStyle, 'test-style');
    assert.equal(feature.getStatus().activeStyle, 'test-style');
  });

  it('manifest：单一 section，defaultStyle 为下拉且选项来自内置风格', () => {
    const manifest = new StylizedOutput({ workspaceDir }).getFeatureManifest();
    const sections = manifest.settings.sections;
    const prop = manifest.settings.properties.defaultStyle;

    assert.equal(sections.length, 1);
    assert.deepEqual(sections[0].properties, ['defaultStyle', 'maxSignatureBlocks']);
    assert.equal(prop.type, 'select');
    const values = prop.options.map((option) => option.value);
    assert.ok(values.includes(''), '应含「不启用默认」空选项');
    assert.ok(values.includes('清晰表达'), '内置风格应出现在选项中');
  });
});
