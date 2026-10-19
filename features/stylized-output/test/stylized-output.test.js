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
