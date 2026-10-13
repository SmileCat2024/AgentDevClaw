import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { StylizedOutput } from '../dist/index.js';

const SIGNATURE = '我确认本回复已逐句遵循测试风格的全部要求。';

let workspaceDir;
let feature;

function createFeature() {
  return new StylizedOutput({ workspaceDir });
}

/** 构造 ToolUse 钩子上下文：context 尾部 assistant 消息即本步正文 */
function createToolUseContext({ assistantContent = '', toolName = 'sign_output_style' } = {}) {
  return {
    call: { name: toolName, arguments: {} },
    context: {
      getAll: () => [
        { role: 'user', content: '问题' },
        { role: 'assistant', content: '我先看看。' },
        { role: 'tool', toolCallId: 't1', content: '{}' },
        { role: 'assistant', content: assistantContent },
      ],
    },
  };
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

describe('StylizedOutput interrupt 空正文降级', () => {
  it('captures the assistant step content for sign calls via the ToolUse hook', async () => {
    feature = createFeature();
    feature.setActiveStyle('test-style');
    await feature.captureSignStepContent(createToolUseContext({ assistantContent: '最终回复正文。' }));
    assert.equal(feature.signStepContent, '最终回复正文。');
    await feature.captureSignStepContent(createToolUseContext({ assistantContent: '   ' }));
    assert.equal(feature.signStepContent, '   ');
  });

  it('ignores non-sign tool calls in the ToolUse hook', async () => {
    feature = createFeature();
    feature.setActiveStyle('test-style');
    await feature.captureSignStepContent(createToolUseContext({ assistantContent: '正文', toolName: 'list_output_styles' }));
    assert.equal(feature.signStepContent, null);
  });

  it('treats a missing trailing assistant message as blank content', async () => {
    feature = createFeature();
    feature.setActiveStyle('test-style');
    await feature.captureSignStepContent({
      call: { name: 'sign_output_style', arguments: {} },
      context: { getAll: () => [{ role: 'user', content: '问题' }] },
    });
    assert.equal(feature.signStepContent, '');
  });

  it('demotes interrupt=true to false and rewrites the call when the step has no content', async () => {
    feature = createFeature();
    feature.setActiveStyle('test-style');
    await feature.captureSignStepContent(createToolUseContext({ assistantContent: '' }));

    const result = await feature.signTool.execute(
      { signature: SIGNATURE, interrupt: true },
      { callId: 'call-1' },
    );

    // withRewrite 形态：调用历史改写为显式 interrupt=false
    assert.equal(result.__withRewrite, true);
    assert.equal(result.effectiveCall.id, 'call-1');
    assert.equal(result.effectiveCall.arguments.interrupt, false);

    const payload = JSON.parse(result.text);
    assert.equal(payload.ok, true);
    assert.equal(payload.interrupt, false);
    assert.match(payload.note, /强制按 false 处理/);
    assert.match(payload.note, /下一步直接输出完整的回复正文/);

    // 签名本身有效（本轮已签名），但打断请求未置位
    assert.equal(feature.signedForReply, true);
    assert.equal(feature.interruptRequested, false);
  });

  it('lets interrupt=true take effect when the step carries non-blank content', async () => {
    feature = createFeature();
    feature.setActiveStyle('test-style');
    await feature.captureSignStepContent(createToolUseContext({ assistantContent: '这是最终回复。' }));

    const payload = await feature.signTool.execute(
      { signature: SIGNATURE, interrupt: true },
      { callId: 'call-2' },
    );

    assert.equal(payload.__withRewrite, undefined);
    assert.equal(payload.ok, true);
    assert.equal(payload.interrupt, true);
    assert.match(payload.note, /interrupt=true 已生效/);
    assert.equal(feature.signedForReply, true);
    assert.equal(feature.interruptRequested, true);
  });

  it('keeps legacy behavior when the step content was never captured (no ToolUse hook run)', async () => {
    feature = createFeature();
    feature.setActiveStyle('test-style');
    // 不调用 captureSignStepContent，signStepContent 保持 null（非标准执行链直调）

    const payload = await feature.signTool.execute(
      { signature: SIGNATURE, interrupt: true },
      { callId: 'call-3' },
    );

    assert.equal(payload.ok, true);
    assert.equal(payload.interrupt, true);
    assert.equal(feature.interruptRequested, true);
  });

  it('urges the model to produce the final reply immediately when interrupt=false', async () => {
    feature = createFeature();
    feature.setActiveStyle('test-style');
    await feature.captureSignStepContent(createToolUseContext({ assistantContent: '' }));

    const payload = await feature.signTool.execute(
      { signature: SIGNATURE, interrupt: false },
      { callId: 'call-4' },
    );

    assert.equal(payload.ok, true);
    assert.equal(payload.interrupt, false);
    assert.match(payload.note, /请立即产出最终回复正文/);
    assert.equal(feature.signedForReply, true);
    assert.equal(feature.interruptRequested, false);
  });

  it('still rejects a mismatched signature regardless of interrupt', async () => {
    feature = createFeature();
    feature.setActiveStyle('test-style');
    await feature.captureSignStepContent(createToolUseContext({ assistantContent: '正文' }));

    const payload = await feature.signTool.execute(
      { signature: '错误的签名', interrupt: true },
      { callId: 'call-5' },
    );

    assert.equal(payload.ok, false);
    assert.equal(feature.signedForReply, false);
    assert.equal(feature.interruptRequested, false);
  });
});
