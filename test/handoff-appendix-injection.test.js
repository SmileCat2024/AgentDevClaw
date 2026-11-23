/**
 * 纯摘要接续包 → runtime 注入的端到端接线（不启 runtime 进程）。
 *
 * 覆盖两段 Claw 侧接线：摘要包落盘时写入 appendix（`writeSummarizedHandoffPackage`），
 * runtime 启动时经 `parseHandoffContent` 解析、按 `run-prebuilt-agent` 的构造方式
 * 交给框架 `HandoffSeedFeature`。断言注入结果：摘要 seed 一条 + 用户最近输入
 * 提醒块一条（system / reminder），且提醒块不计入 seed 注入账目。
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { HandoffSeedFeature } from '@agentdevjs/core';
import { writeSummarizedHandoffPackage, buildRecentUserInputReminder } from '../server/context-continuity/summarized-handoff.js';
import { buildHandoffSeedConfig, parseHandoffContent } from '../server/shared/handoff-payload.js';

function createContextRecorder() {
  const messages = [];
  const enrichedMessages = [];
  let sequence = 0;
  const push = (message) => {
    messages.push(message);
    enrichedMessages.push({ ...message, sequence: sequence++ });
  };
  return {
    messages,
    enrichedMessages,
    context: {
      getAll: () => messages,
      getAllEnriched: () => enrichedMessages,
      add: (message) => push({ role: message.role, content: message.content, turn: message.turn }),
      addSystemMessage: (content, turn, source, tag) => push({ role: 'system', content, turn, source, tag }),
      addUserMessage: (content, turn, images, timestamp, source, tag) => push({ role: 'user', content, turn, timestamp, source, tag }),
      addAssistantMessage: (response, turn, timestamp) => push({
        role: 'assistant', content: response?.content ?? '', toolCalls: response?.toolCalls, turn, timestamp,
      }),
      addSerializedToolMessage: (toolCallId, content, turn) => push({ role: 'tool', content, turn, toolCallId }),
    },
  };
}

const tempRoots = [];

async function writeSamplePackage({ includeRecentUserInput }) {
  const root = await mkdtemp(path.join(tmpdir(), 'claw-appendix-inject-'));
  tempRoots.push(root);
  const messages = [
    { role: 'user', content: '先把登录超时修掉' },
    { role: 'assistant', content: '开始排查' },
    { role: 'user', content: '别动配置层，只改 server/auth.js' },
  ];
  const appendixContent = includeRecentUserInput ? buildRecentUserInputReminder(messages) : '';
  const { handoffPath } = await writeSummarizedHandoffPackage({
    userDataRoot: root,
    agentId: 'coder',
    sessionId: 'session-1',
    summaryText: '登录超时根因是连接池未释放，已定位到 server/auth.js。',
    appendixContent,
  });
  return handoffPath;
}

after(async () => {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true });
});

async function bootSeedFeature(handoffPath) {
  const { readFileSync } = await import('node:fs');
  const handoff = parseHandoffContent(readFileSync(handoffPath, 'utf8'), handoffPath);
  // 与 scripts/run-prebuilt-agent.js 同一个装配函数（runtime 侧唯一构造点）
  return new HandoffSeedFeature(buildHandoffSeedConfig(handoff));
}

async function inject(feature) {
  const recorder = createContextRecorder();
  await feature.injectHandoffSummary({
    input: '继续',
    isFirstCall: true,
    context: recorder.context,
    agent: { _callIndex: 0, getFeature: () => undefined, projectRoot: tmpdir() },
  });
  return recorder;
}

describe('摘要包 appendix 的 runtime 接线', () => {
  it('把用户最近输入作为提醒块注入，摘要 seed 与账目不变', async () => {
    const handoffPath = await writeSamplePackage({ includeRecentUserInput: true });
    const feature = await bootSeedFeature(handoffPath);
    const recorder = await inject(feature);

    const summarySeed = recorder.messages.find((m) => m.role === 'system' && String(m.content).includes('登录超时根因'));
    assert.ok(summarySeed, '摘要 seed 已注入');
    const reminderRow = recorder.enrichedMessages[recorder.enrichedMessages.length - 1];
    assert.equal(reminderRow.role, 'system');
    assert.equal(reminderRow.tag, 'reminder');
    assert.ok(reminderRow.content.includes('别动配置层，只改 server/auth.js'), '用户原话进入提醒块');

    // 账目：appendix 不计入 seed 段（seedCount 仍是 1 条摘要）
    assert.equal(feature.captureState().seedCount, 1);
  });

  it('未启用时注入结果与旧行为一致（只有摘要 seed）', async () => {
    const handoffPath = await writeSamplePackage({ includeRecentUserInput: false });
    const feature = await bootSeedFeature(handoffPath);
    const recorder = await inject(feature);

    assert.equal(recorder.messages.length, 1);
    assert.equal(recorder.messages[0].role, 'system');
    assert.ok(!recorder.messages.some((m) => m.tag === 'reminder'));
    assert.equal(feature.captureState().seedCount, 1);
  });
});
