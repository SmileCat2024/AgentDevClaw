import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { exportHistoryOnlyHandoffPackage } from '../server/context-continuity/handoff-package.js';

/**
 * history-only 精简（不带摘要）的落盘行为：
 * 裁剪语义由框架 buildTrimmedSeedMessages 提供，Claw 只在 seed 末尾
 * 追加一条精简注解 system 消息（会话 id 变更 + 状态审视提醒）。
 */

function buildSnapshot() {
  return {
    runtime: {
      context: {
        messages: [
          { role: 'system', content: '你是 coder' },
          { role: 'user', content: '帮我看看 server.js', turn: 0 },
          {
            role: 'assistant', content: '好的', turn: 0,
            toolCalls: [{ name: 'read', arguments: '{"filePath":"server.js"}' }],
          },
          { role: 'tool', toolCallId: 'tc1', content: '{"ok":true}', turn: 0 },
          { role: 'user', content: '继续', turn: 1 },
          { role: 'assistant', content: '完成', turn: 1 },
        ],
      },
      featureStates: [],
    },
  };
}

describe('exportHistoryOnlyHandoffPackage trim notice', () => {
  let tmpRoot;
  let sessionPath;

  before(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-history-only-'));
    sessionPath = path.join(tmpRoot, 'sess-1.json');
    await fs.writeFile(sessionPath, JSON.stringify(buildSnapshot()), 'utf8');
  });

  after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('appends a trim notice system message as the last seed message', async () => {
    const { handoff } = await exportHistoryOnlyHandoffPackage({
      userDataRoot: tmpRoot,
      agentId: 'agent a/1',
      sessionId: 'session-abc123',
      sessionPath,
      sourceRecord: { title: 'T' },
      policy: {},
    });

    const last = handoff.seedMessages[handoff.seedMessages.length - 1];
    assert.equal(last.role, 'system');
    assert.ok(last.content.includes('上一段会话 id：session-abc123'));
    assert.ok(last.content.includes('精简发生时间：'));
    // 注解提醒语义存在（状态审视 / 文件重读）
    assert.ok(last.content.includes('重新阅读'));
  });

  it('keeps trim semantics intact: no bare tool messages, stats exclude the notice', async () => {
    const { handoff } = await exportHistoryOnlyHandoffPackage({
      userDataRoot: tmpRoot,
      agentId: 'agent a/1',
      sessionId: 'session-abc123',
      sessionPath,
      sourceRecord: {},
      policy: {},
    });

    assert.ok(handoff.seedMessages.every((m) => m.role !== 'tool'));
    // 注解消息不参与裁剪统计（折叠 note 有独立计数，不计入 keptSeedMessageCount）
    assert.equal(
      handoff.stats.keptSeedMessageCount + handoff.stats.foldedToolNoteCount,
      handoff.seedMessages.length - 1,
    );
  });
});
