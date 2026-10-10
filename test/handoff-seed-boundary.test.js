/**
 * handoff 包 seedBoundary 透传落盘（ADR-0024 PR-3 marker 双落盘之协议层）
 *
 *   1. writeTrimWithSummaryHandoffPackage：变换产物（SuccessorSeed）顶层
 *      声明形状规整后透传；旧框架产物（无 seedBoundary）不写该字段，
 *      schemaVersion 不动（旧包兼容）；
 *   2. exportHistoryOnlyHandoffPackage：Claw 本地构建产物自带账目自洽的
 *      声明（总量 = seedMessages.length，trim 注解为尾部唯一注入项）；
 *   3. readHandoffPackage：无 seedBoundary 的旧包读取不是错误；
 *   4. normalizeSeedBoundary：形状不合法按缺失处理（不捏造）。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

import {
  exportHistoryOnlyHandoffPackage,
  writeTrimWithSummaryHandoffPackage,
  readHandoffPackage,
  normalizeSeedBoundary,
} from '../server/context-continuity/handoff-package.js';

let base = null;
before(async () => { base = mkdtempSync(path.join(os.tmpdir(), 'claw-handoff-sb-')); });
after(async () => { if (base) await fsp.rm(base, { recursive: true, force: true }); });

function conversationMessages(count) {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    list.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message-${i}`,
      turn: Math.floor(i / 2),
    });
  }
  return list;
}

async function writeSessionFile(name, messages) {
  const filePath = path.join(base, `${name}.json`);
  await fsp.writeFile(filePath, JSON.stringify({
    version: 1,
    sessionId: name,
    savedAt: new Date().toISOString(),
    agentType: 'programming-helper',
    runtime: {
      initialized: true,
      callIndex: 10,
      context: { messages, enrichedMessages: [] },
      featureStates: [],
    },
    rollbackHistory: [],
  }), 'utf8');
  return filePath;
}

describe('writeTrimWithSummaryHandoffPackage seedBoundary passthrough', () => {
  test('persists the transform-declared boundary into the handoff package', async () => {
    const sessionPath = await writeSessionFile('sess-a', conversationMessages(20));
    const seedMessages = conversationMessages(8).map((m, i) => ({ ...m, id: `sm-${i}`, sequence: i }));
    const { handoff } = await writeTrimWithSummaryHandoffPackage({
      userDataRoot: base,
      agentId: 'programming-helper',
      sessionId: 'sess-a',
      sessionPath,
      sessionSnapshot: { runtime: { context: { messages: [] }, featureStates: [] } },
      seed: {
        seedMessages,
        meta: {
          compilerVersion: 'trim-transcript-with-summary-v1',
          seedKind: 'message-replay',
          mode: 'trim-transcript-with-summary',
          trimPolicy: {},
          trimStats: {},
        },
        seedBoundary: {
          seedMessageCount: 8,
          appendedInjection: [{ kind: 'summary', messageIndex: 7 }],
        },
      },
    });
    assert.deepEqual(handoff.seedBoundary, {
      seedMessageCount: 8,
      appendedInjection: [{ kind: 'summary', messageIndex: 7 }],
    });
  });

  test('omits the field for legacy transform products (no fabricated boundary)', async () => {
    const sessionPath = await writeSessionFile('sess-b', conversationMessages(20));
    const { handoff } = await writeTrimWithSummaryHandoffPackage({
      userDataRoot: base,
      agentId: 'programming-helper',
      sessionId: 'sess-b',
      sessionPath,
      sessionSnapshot: { runtime: { context: { messages: [] }, featureStates: [] } },
      seed: {
        seedMessages: conversationMessages(6),
        meta: { mode: 'trim-transcript-with-summary' },
        // 无 seedBoundary（marker 双落盘之前的框架产物形态）
      },
    });
    assert.equal('seedBoundary' in handoff, false);
    assert.equal(handoff.schemaVersion, 1);
  });
});

describe('exportHistoryOnlyHandoffPackage self-consistent declaration', () => {
  test('declares total count and the trailing trim-notice injection', async () => {
    const sessionPath = await writeSessionFile('sess-c', conversationMessages(40));
    const { handoff } = await exportHistoryOnlyHandoffPackage({
      userDataRoot: base,
      agentId: 'programming-helper',
      sessionId: 'sess-c',
      sessionPath,
    });
    assert.ok(handoff.seedMessages.length > 0, 'trim policy should retain messages');
    assert.deepEqual(handoff.seedBoundary, {
      seedMessageCount: handoff.seedMessages.length,
      appendedInjection: [{ kind: 'trim-notice', messageIndex: handoff.seedMessages.length - 1 }],
    });
    // 尾部注入项确实是注解消息（system）
    const [injection] = handoff.seedBoundary.appendedInjection;
    assert.equal(handoff.seedMessages[injection.messageIndex].role, 'system');
  });
});

describe('legacy package compatibility & shape normalization', () => {
  test('readHandoffPackage accepts packages without seedBoundary', async () => {
    const handoffId = 'handoff-legacy-no-sb';
    const dir = path.join(base, 'context-handoffs', 'programming-helper');
    await fsp.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${handoffId}.json`);
    await fsp.writeFile(filePath, JSON.stringify({
      schemaVersion: 1,
      handoffId,
      mode: 'trim-transcript',
      seedMessages: [{ role: 'user', content: 'x' }],
      // 无 seedBoundary：旧产物不是错误
    }), 'utf8');

    const { handoff } = await readHandoffPackage({ userDataRoot: base, agentId: 'programming-helper', handoffId });
    assert.equal(handoff.handoffId, handoffId);
    assert.equal('seedBoundary' in handoff, false);
  });

  test('normalizeSeedBoundary rejects malformed shapes as missing', () => {
    assert.equal(normalizeSeedBoundary(null), null);
    assert.equal(normalizeSeedBoundary('nope'), null);
    assert.equal(normalizeSeedBoundary({ seedMessageCount: -1, appendedInjection: [] }), null);
    assert.equal(normalizeSeedBoundary({ seedMessageCount: 1.5, appendedInjection: [] }), null);
    assert.equal(normalizeSeedBoundary({
      seedMessageCount: 3,
      appendedInjection: [{ kind: 'summary', messageIndex: -1 }],
    }), null);
    assert.equal(normalizeSeedBoundary({
      seedMessageCount: 3,
      appendedInjection: [{ messageIndex: 1 }],
    }), null);
    // 合法形状原样规整（kind 保留、下标规整为数字）
    assert.deepEqual(normalizeSeedBoundary({
      seedMessageCount: 3,
      appendedInjection: [{ kind: 'summary', messageIndex: 2 }],
    }), { seedMessageCount: 3, appendedInjection: [{ kind: 'summary', messageIndex: 2 }] });
    // appendedInjection 缺失按空注入处理（纯 trim 产物形态）
    assert.deepEqual(normalizeSeedBoundary({ seedMessageCount: 3 }),
      { seedMessageCount: 3, appendedInjection: [] });
  });
});
